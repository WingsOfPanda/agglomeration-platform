// tests/state-agreement.test.ts — the hub proves it resolved the tree the worker was given.
//
// PR G re-roots every verb family so one run touches one state tree. That rule now lives at nine
// dispatchers, and a rule at nine call sites is exactly the shape that rots when a tenth is added:
// #150 applied it to the `job` verbs and left the other eight, and the gap cost a field incident.
// This file is the mutation-locked invariant for it. The failure it pins is SILENT — send's
// inboxWrite and its nudge both derive from the same cwd, so they agree with EACH OTHER while both
// miss the worker, and only the worker's own refusal (the far side, after the write) ever objected.
//
// The oracle is the pane: the one reference hub and worker share that does not itself derive from
// the hub's cwd. spawn stamps the worker's own state dir there as @ap_state, beside @ap_nonce; send
// reads it back before it writes anything. Three-valued, and ABSENT is the row that matters —
// a pane from a pre-@ap_state release has nothing to compare, and refusing on that would strand
// every in-flight worker across the upgrade.
//
// Nothing here reaches tmux: the pane touches are injected, exactly as the ownership tests do it.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { run as send, type SendCmdDeps } from "../src/commands/send.js";
import { paneStateStamp, prepareWorkerState } from "../src/commands/spawn.js";
import { paneStateSetArgs, setOptionArgs } from "../src/core/tmux.js";
import { workerDir, sameStateDir } from "../src/core/paths.js";

const AGENT = "bravo";
const MODEL = "codex";
const TOPIC = "demo";
const PANE = "%1";

const cleanups: Array<() => void> = [];
const ORIG_HOME = process.env.AP_HOME;
const ORIG_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
const PLUGIN_ROOT = process.cwd();   // captured before any chdir: identityWrite reads its template from here
beforeEach(() => { process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT; });
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (ORIG_HOME === undefined) delete process.env.AP_HOME; else process.env.AP_HOME = ORIG_HOME;
  if (ORIG_PLUGIN_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = ORIG_PLUGIN_ROOT;
});

/** A worker whose state dir and pane.json exist, in the AP_HOME the caller has already set. */
function seedWorker(): string {
  const d = workerDir(AGENT, MODEL, TOPIC);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "pane.json"), JSON.stringify({ pane_id: PANE, pane_nonce: "n1", agent: AGENT, model: MODEL, spawned_at: "t" }));
  writeFileSync(join(d, "outbox.jsonl"), "");
  return d;
}

/** send's three tmux touches, all faked. `stamped` is what the pane answers for @ap_state; passing
 *  undefined omits the reader entirely (the shape every pre-existing send test has). */
function deps(stamped?: string): { sent: string[]; d: SendCmdDeps } {
  const sent: string[] = [];
  const d: SendCmdDeps = {
    paneOwned: async () => true,
    paneSend: async (p: string) => { sent.push(p); },
    ...(stamped === undefined ? {} : { paneState: async () => stamped }),
  };
  return { sent, d };
}

async function captureErr(fn: () => Promise<number>): Promise<{ rc: number; err: string }> {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => { lines.push(String(s)); return true; }) as typeof process.stderr.write;
  try { return { rc: await fn(), err: lines.join("") }; }
  finally { process.stderr.write = orig; }
}

describe("state-tree agreement guard (send)", () => {
  it("pane stamped with a DIFFERENT tree -> rc 2, both paths named, and NO inbox in either tree", async () => {
    const h = freshHome(); cleanups.push(h.cleanup);
    const resolved = seedWorker();

    // A second, real tree — the shape the incident had: the hub standing in the run's own worktree
    // hashed a different repo root, so `resolved` and the worker's own dir were siblings under two
    // different .ap roots.
    const other = mkdtempSync(join(tmpdir(), "ap-other-"));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    const otherDir = join(other, "state", "deadbeef", TOPIC, `${AGENT}-${MODEL}`);
    mkdirSync(otherDir, { recursive: true });

    const { sent, d } = deps(otherDir);
    const { rc, err } = await captureErr(() => send([AGENT, TOPIC, "hello"], d));

    expect(rc).toBe(2);
    expect(err).toContain("state-tree disagreement");
    expect(err).toContain(otherDir);                       // the worker's tree
    expect(err).toContain(resolved);                       // the tree this hub resolved
    // The refusal must PRECEDE the write. Move the comparison after inboxWrite and this pair is the
    // assertion that goes red: the task is already sitting in the tree nobody reads.
    expect(existsSync(join(resolved, "inbox.md"))).toBe(false);
    expect(existsSync(join(otherDir, "inbox.md"))).toBe(false);
    expect(sent).toEqual([]);                              // nothing typed into the pane either
  });

  it("pane stamped with the SAME tree -> byte-identical to today (inbox written, pane nudged, rc 0)", async () => {
    const h = freshHome(); cleanups.push(h.cleanup);
    const resolved = seedWorker();
    const { sent, d } = deps(resolved);

    expect(await send([AGENT, TOPIC, "hello"], d)).toBe(0);
    expect(readFileSync(join(resolved, "inbox.md"), "utf8")).toContain("hello");
    expect(sent).toEqual([PANE]);
  });

  it("pane with NO @ap_state (a worker spawned by a pre-upgrade release) -> proceeds, rc 0", async () => {
    // The upgrade-safety row. Absence is UNVERIFIED, never mismatched: refuse here and every worker
    // already running when ap is updated stops receiving tasks.
    const h = freshHome(); cleanups.push(h.cleanup);
    const resolved = seedWorker();
    const { sent, d } = deps("");

    expect(await send([AGENT, TOPIC, "hello"], d)).toBe(0);
    expect(existsSync(join(resolved, "inbox.md"))).toBe(true);
    expect(sent).toEqual([PANE]);
  });

  it("a SYMLINKED state tree resolving to the stamped target compares EQUAL -> rc 0", async () => {
    // The field run's own workaround was a symlinked state dir. A raw string compare would refuse it
    // even though both names reach the same inode, which is a guard that fires on a healthy run.
    const real = realpathSync(mkdtempSync(join(tmpdir(), "ap-real-")));
    const link = `${real}-link`;
    symlinkSync(real, link);
    cleanups.push(() => { rmSync(link, { force: true }); rmSync(real, { recursive: true, force: true }); });
    process.env.AP_HOME = link;

    const viaLink = seedWorker();                      // .../ap-real-XXX-link/state/<hash>/demo/bravo-codex
    const viaReal = realpathSync(viaLink);             // .../ap-real-XXX/state/<hash>/demo/bravo-codex
    expect(viaReal).not.toBe(viaLink);                 // the two names really do differ

    const { sent, d } = deps(viaReal);                 // the pane carries the resolved name
    expect(await send([AGENT, TOPIC, "hello"], d)).toBe(0);
    expect(existsSync(join(viaLink, "inbox.md"))).toBe(true);
    expect(sent).toEqual([PANE]);
  });

  it("sameStateDir: symlink-equal and trailing-slash-equal, genuinely different dirs are not", () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "ap-same-")));
    const link = `${real}-link`;
    symlinkSync(real, link);
    cleanups.push(() => { rmSync(link, { force: true }); rmSync(real, { recursive: true, force: true }); });

    expect(sameStateDir(real, link)).toBe(true);
    expect(sameStateDir(`${real}/`, real)).toBe(true);
    expect(sameStateDir("/no/such/tree/a", "/no/such/tree/a/")).toBe(true);   // unresolvable, still comparable
    expect(sameStateDir("/no/such/tree/a", "/no/such/tree/b")).toBe(false);
  });
});

describe("state-tree agreement guard (spawn stamps what identity.md says)", () => {
  it("@ap_state is the SAME dir identityWrite embedded in the worker's identity.md", async () => {
    const h = freshHome(); cleanups.push(h.cleanup);
    prepareWorkerState(AGENT, MODEL, TOPIC, "worker");

    // Take the worker's own answer out of identity.md rather than recomputing it: the identity's
    // first-action line names the absolute outbox the worker will append to, so its parent IS the
    // tree the worker believes it lives in.
    const identity = readFileSync(join(workerDir(AGENT, MODEL, TOPIC), "identity.md"), "utf8");
    const m = /Append exactly ONE JSONL line to (\S+)/.exec(identity);
    expect(m).not.toBeNull();
    const workerBelieves = dirname(m![1]);

    expect(paneStateStamp(AGENT, MODEL, TOPIC)).toBe(workerBelieves);
  });

  it("paneStateSetArgs stamps @ap_state on the pane (a per-pane set-option, like @ap_nonce)", () => {
    expect(paneStateSetArgs(PANE, "/abs/.ap/state/h/demo/bravo-codex")).toEqual(
      ["set-option", "-p", "-t", PANE, "@ap_state", "/abs/.ap/state/h/demo/bravo-codex"],
    );
    expect(paneStateSetArgs(PANE, "/x")).toEqual(setOptionArgs(PANE, "@ap_state", "/x"));
  });
});
