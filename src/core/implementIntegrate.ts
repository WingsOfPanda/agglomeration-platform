// src/core/implementIntegrate.ts — fan-IN: N slice branches merged into the run's branch
// (2026-09-04-parallel-slices-design.md, G). Every git call goes through an injected `Runner` bound
// to the run worktree, so the whole loop is testable without a repository.
//
// The verb RECORDS conflicts, it never resolves them: resolution is model judgment and belongs in
// the absorb turn. Merges (never rebases) so no worker commit is ever rewritten.
import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./atomic.js";
import { branchNameFor, sliceBranchFor } from "./branchRecord.js";
import { currentBranch, dirtyPaths, type Runner } from "./gitwork.js";
import type { IntegrateRow, SliceRow } from "./implementSlices.js";
import { splitNonCommentLines } from "./text.js";

export type IntegrateOutcome =
  /** A precondition refused the whole run: `KEY=value` lines for the directive, nothing merged. */
  | { ok: false; refusals: string[] }
  | { ok: true; rc: 0 | 1; rows: IntegrateRow[] };

/** The tracked-dirty probe both preconditions share. `--untracked-files=no` because a suite's
 *  untracked byproducts never block a merge; `-z` because that is the only listing whose paths are
 *  not C-escaped (see `dirtyPaths`). */
function trackedDirty(r: Runner): string[] {
  return dirtyPaths(r.run("git", ["status", "--porcelain", "-z", "--untracked-files=no"]).stdout);
}

/** Merge every slice branch that has commits into `feat/implement-<topic>`, in roster order.
 *
 *  Two preconditions come first because both are silent corruptions otherwise: a tree parked on
 *  `base/<topic>` would integrate the slices into the wrong branch, and a dirty tree turns any
 *  conflict into an abort that cannot restore it.
 *
 *  A conflict aborts, is recorded, and the loop continues — UNLESS the abort left the tree dirty, in
 *  which case the remaining rows record `skipped:tree-dirty` and the verb refuses: a tree the abort
 *  could not restore must never reach Stage 2's suite run or Stage 4's `postSweep`, which commits
 *  whatever it finds. */
export function integrateSlices(topic: string, slices: SliceRow[], r: Runner): IntegrateOutcome {
  const branch = branchNameFor("implement", topic);
  const cur = currentBranch(r);
  if (cur !== branch) return { ok: false, refusals: [`BRANCH=${cur || "(detached)"}`, `EXPECTED=${branch}`] };
  const dirty = trackedDirty(r);
  if (dirty.length) return { ok: false, refusals: dirty.map((p) => `DIRTY=${p}`) };

  const rows: IntegrateRow[] = [];
  let rc: 0 | 1 = 0;
  let stopped = false;
  for (const s of slices) {
    if (stopped) { rows.push({ agent: s.agent, label: s.label, status: "skipped:tree-dirty" }); continue; }
    const b = sliceBranchFor(topic, s.agent);
    if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${b}`]).code !== 0) {
      rows.push({ agent: s.agent, label: s.label, status: "skipped:no-branch" });
      continue;
    }
    // `git merge` of an already-reachable branch exits 0 with "Already up to date", which no rc can
    // tell from a real merge — and the run branch has MOVED after the first merge, so no recorded
    // fork sha would answer it either. Count the commits instead.
    if (r.run("git", ["rev-list", "--count", `HEAD..${b}`]).stdout.trim() === "0") {
      rows.push({ agent: s.agent, label: s.label, status: "empty" });
      continue;
    }
    const m = r.run("git", ["merge", "--no-ff", "--no-edit", "-m", `merge: slice ${s.label} (${s.agent})`, b]);
    if (m.code === 0) { rows.push({ agent: s.agent, label: s.label, status: "merged" }); continue; }
    r.run("git", ["merge", "--abort"]);
    rows.push({ agent: s.agent, label: s.label, status: "conflict" });
    if (trackedDirty(r).length) { stopped = true; rc = 1; }
  }
  return { ok: true, rc, rows };
}

/** `integrate-<round>.tsv` — the record Stage 2's cross-verify pastes and the absorb turn reads. */
export function writeIntegrate(path: string, rows: IntegrateRow[]): void {
  const body = rows.map((r) => [r.agent, r.label, r.status].join("\t")).join("\n");
  atomicWrite(path, rows.length ? `${body}\n` : "");
}
export function readIntegrate(path: string): IntegrateRow[] {
  if (!existsSync(path)) return [];
  return splitNonCommentLines(readFileSync(path, "utf8"))
    .map((l) => { const [agent, label, status] = l.split("\t"); return { agent, label, status }; })
    .filter((r) => r.agent && r.status);
}
