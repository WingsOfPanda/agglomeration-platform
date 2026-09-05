// src/core/implementSpawnSlices.ts — fan-OUT: one worktree, one branch and one pane per slice
// (2026-09-04-parallel-slices-design.md, C / D, and its 2026-09-05 amendment). Every slice pane
// lands in the hub's OWN window — the hub on the left, the lead and the slices stacked on the right
// under `main-vertical` — never a second window. Sequential by design (D12): many codex workers
// bootstrapping at once on a loaded box never emit `ready` in time, and six 170 s bootstraps is 17
// minutes against a multi-hour run.
//
// Every side effect is an injected dep or a path under the art dir, so the whole loop — including
// the rc-3 retry and the codex->claude fallback — runs in a test with no git, no tmux and no pane.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import { atomicWrite } from "./atomic.js";
import { readField } from "./fsread.js";
import { sliceBranchFor } from "./branchRecord.js";
import { sliceWorktreePathFor } from "./job.js";
import { resolveModel } from "./ipc.js";
import { spawnTally } from "./roster.js";
import type { Runner } from "./gitwork.js";
import { dirtyPaths } from "./gitwork.js";
import { readSlices, writeSlices } from "./implementSlices.js";

/** rc 3 is `spawn`'s cold-start failure (pane_dead / timeout) — the one failure a second attempt,
 *  and then another provider, is worth paying for. */
const SPAWN_COLD_START_RC = 3;

/** The fewest rows a codex TUI stays readable in: its composer, its status line and a few lines of
 *  output. Below that a slice pane is there but unusable. */
export const MIN_PANE_ROWS = 8;

export interface SpawnSlicesDeps {
  /** The MAIN checkout: `git worktree add` and `provisionWorktree` are both provenance-gated on it. */
  root: string;
  /** Bound to `root`. The two trees share one ref store, so either cwd would do the `add`; the root
   *  is chosen because the provisioning helper is gated on it. */
  rootRunner: Runner;
  /** Bound to `target_cwd.txt` — the run worktree, whose HEAD every slice branch forks. */
  runRunner: Runner;
  /** Rows of the hub's window (0 when tmux cannot say). */
  windowRows(): Promise<number>;
  /** Re-lay the hub's window main-vertical after a slice pane lands; never throws. */
  layout(): Promise<void>;
  /** `spawn` as an argv, so the verb can branch on its RETURN CODE. */
  spawn(argv: string[]): Promise<number>;
  /** `stop <agent> <topic>`: a `failed-spawn` row can have left a worker dir that `agentInUse`
   *  would refuse the re-spawn over. */
  stop(agent: string): Promise<number>;
  provision(worktree: string): void;
  flag(note: string): void;
}

export type SpawnSlicesOutcome =
  /** Refused before anything was spawned: `KEY=value` lines the directive greps. */
  | { ok: false; refusals: string[] }
  | { ok: true; rc: 0 | 1 | 2; spawned: string[]; fallback: string[]; failed: string[] };

/** Spawn every `planned` row (plus `failed-spawn` rows under `--retry`), ONE AT A TIME.
 *
 *  Fail-closed before the loop, never half-way through it: a `planned` row whose worktree or branch
 *  already exists, or a reused row whose branch has moved off the recorded fork sha, refuses the
 *  WHOLE verb with nothing spawned — the posture `startWorktree` takes for `base/<topic>`. */
export async function spawnSlices(
  topic: string, art: string, retry: boolean, d: SpawnSlicesDeps,
): Promise<SpawnSlicesOutcome> {
  const rosterPath = join(art, "slices.tsv");
  const rows = readSlices(rosterPath);

  // The fork point must be committed: `git worktree add <path> <sha>` cannot carry a dirty index,
  // and a prelude that left tracked edits behind would silently not reach any slice.
  const dirty = dirtyPaths(d.runRunner.run("git", ["status", "--porcelain", "-z", "--untracked-files=no"]).stdout);
  if (dirty.length) return { ok: false, refusals: dirty.map((p) => `DIRTY=${p}`) };
  const head = d.runRunner.run("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!head) return { ok: false, refusals: ["HEAD_UNREADABLE=1"] };

  const targets = rows.filter((r) => r.status === "planned" || (retry && r.status === "failed-spawn"));
  // One fork sha for the whole run: every slice branches from the same HEAD, and a retry must reuse
  // the tree the first pass made rather than fork a moved branch under a half-built worktree.
  const forkPath = join(art, "slice-fork.txt");
  const forkSha = readField(forkPath) || head;

  const refusals: string[] = [];
  // Every slice pane splits the hub's own window, so the window has to hold the lead plus each slice
  // at MIN_PANE_ROWS, one border row apiece. `rows === 0` is tmux refusing to say, which is NOT
  // evidence of a small window: the pass proceeds and a split that then fails is reported by the
  // existing rc path.
  const winRows = await d.windowRows();
  const need = (targets.length + 1) * MIN_PANE_ROWS + targets.length;
  if (targets.length && winRows > 0 && winRows < need) refusals.push(`WINDOW_TOO_SMALL=rows=${winRows},need=${need}`);
  for (const r of targets) {
    const branch = sliceBranchFor(topic, r.agent);
    const tree = sliceWorktreePathFor(d.root, topic, r.agent);
    const branchAt = d.rootRunner.run("git", ["rev-parse", "--verify", `refs/heads/${branch}`]).stdout.trim();
    if (r.status === "planned") {
      if (existsSync(tree)) refusals.push(`SLICE_TREE_EXISTS=${r.agent}`);
      if (branchAt) refusals.push(`SLICE_BRANCH_EXISTS=${r.agent}`);
    } else {
      // A reused row's tree and branch must BOTH be as this run's first pass left them (C): a branch
      // that moved carries commits no one has accounted for, a branch without its tree makes the
      // `worktree add -b` below fail fatally, and a tree without its branch has nothing to commit
      // onto. Neither present is the pass whose `worktree add` never ran — that one forks afresh.
      const treeThere = existsSync(tree);
      if (branchAt ? branchAt !== forkSha || !treeThere : treeThere) refusals.push(`SLICE_TREE_MOVED=${r.agent}`);
    }
  }
  if (refusals.length) return { ok: false, refusals };
  if (targets.length && !readField(forkPath)) atomicWrite(forkPath, forkSha + "\n");

  const spawned: string[] = [], fallback: string[] = [], failed: string[] = [];
  const rcs: number[] = [];
  for (const row of targets) {
    const branch = sliceBranchFor(topic, row.agent);
    const tree = sliceWorktreePathFor(d.root, topic, row.agent);
    /** `spawn` once, and once more on a cold start: rc 3 is the failure a retry actually fixes. No
     *  `--session`: this runs inside the hub's session, so spawn's attached path splits below
     *  `.last_pane` — the lead's pane, then the previous slice's. The pane that lands is re-laid
     *  main-vertical so the right-hand column stays even. */
    const attempt = async (model: string): Promise<number> => {
      const argv = [row.agent, model, topic, "--role", "slice", "--cwd", tree];
      let rc = await d.spawn(argv);
      if (rc === SPAWN_COLD_START_RC) rc = await d.spawn(argv);
      if (rc === 0) await d.layout();
      return rc;
    };
    let rc = 1;
    try {
      // Only the bootstrap arm of `spawn` FAILED-archives a worker dir; the stamp arm returns
      // before that, and `agentInUse` would then refuse the re-spawn.
      if (resolveModel(row.agent, topic) !== null) await d.stop(row.agent);
      if (existsSync(tree)) {
        rc = await attempt(row.model);
      } else if (d.rootRunner.run("git", ["worktree", "add", "-b", branch, tree, forkSha]).code !== 0) {
        log.error(`implement spawn-slices: could not create ${tree} on ${branch} at ${forkSha} — clear whichever half exists (git -C ${d.root} worktree remove --force ${tree}; git -C ${d.root} branch -D ${branch}) before 'implement spawn-slices ${topic} --retry'`);
      } else {
        d.provision(tree);
        rc = await attempt(row.model);
      }
      if (rc === SPAWN_COLD_START_RC && row.model === "codex") {
        // The platform's own provider doctrine, per worker: a codex that dies at spawn twice is
        // replaced by claude. `resolveModel` finds each slice's model from its dir, so a mixed
        // roster costs the turn verbs nothing.
        // The model rewrite and the flag are filed EAGERLY (a later `--retry` must use claude, and
        // the switch happened whatever comes of it); `FALLBACK=` is the directive's report of what
        // came UP, so it waits for the attempt it describes.
        row.model = "claude";
        d.flag(`slice-provider-fallback: ${row.agent} codex->claude`);
        rc = await attempt("claude");
        if (rc === 0) fallback.push(row.agent);
      }
    } catch (e) {
      log.error(`implement spawn-slices: ${row.agent} threw during spawn (${String((e as Error)?.message ?? e)}); recorded failed-spawn`);
      rc = 1;
    }
    row.status = rc === 0 ? "spawned" : "failed-spawn";
    (rc === 0 ? spawned : failed).push(row.agent);
    rcs.push(rc);
    writeSlices(rosterPath, rows);   // after EVERY row: a crash mid-loop must leave a truthful roster
  }
  // rc 2 is the directive's cue to take the serial path (D3), so a pass that attempted NOTHING
  // answers from the roster rather than from an empty tally: a second bare run after a wave that
  // all failed must still read "none up", while a re-run over a good fan-out must not.
  const rc = targets.length ? spawnTally(rcs) : rows.some((r) => r.status === "spawned") ? 0 : 2;
  return { ok: true, rc, spawned, fallback, failed };
}
