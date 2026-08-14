// src/core/gitwork.ts
import { execFileSync } from "node:child_process";

export interface RunResult { code: number; stdout: string; }
export interface Runner { run(cmd: string, args: string[]): RunResult; }

/** A cwd-bound synchronous command runner. execFileSync — never shell. */
export function runnerAt(cwd: string): Runner {
  return {
    run(cmd, args) {
      try {
        const stdout = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return { code: 0, stdout };
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: Buffer | string };
        return { code: typeof err.status === "number" ? err.status : 1, stdout: err.stdout != null ? String(err.stdout) : "" };
      }
    },
  };
}

export function classifyDirty(porcelain: string): boolean { return porcelain.trim().length > 0; }
export function finishAutoAction(remotes: string): "pr" | "keep" { return remotes.trim().length > 0 ? "pr" : "keep"; }

export interface SnapshotResult {
  branch: string;
  baseSha: string;
  state: "clean" | "wip-committed" | "hook-blocked" | "not-git";
}

/** The checked-out branch, "" when there is none to name — a detached HEAD (symbolic-ref exits
 *  non-zero) reads the same as an unreadable repo. Each caller supplies its own wording for "",
 *  which is why this returns the empty string rather than picking one. */
export function currentBranch(r: Runner): string {
  const head = r.run("git", ["symbolic-ref", "--short", "HEAD"]);
  return head.code === 0 ? head.stdout.trim() : "";
}

/** Capture branch + base SHA; if the tree is dirty, commit a WIP snapshot on the current branch. */
export function preSnapshot(r: Runner, command: string, topic: string): SnapshotResult {
  if (r.run("git", ["rev-parse", "--git-dir"]).code !== 0) return { branch: "", baseSha: "", state: "not-git" };
  const branch = currentBranch(r) || "(detached)";
  const preSha = r.run("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!classifyDirty(r.run("git", ["status", "--porcelain"]).stdout)) {
    return { branch, baseSha: preSha, state: "clean" };
  }
  r.run("git", ["add", "-A"]);
  if (r.run("git", ["commit", "-q", "-m", `chore: WIP before ${command} ${topic}`]).code !== 0) {
    return { branch, baseSha: preSha, state: "hook-blocked" };
  }
  return { branch, baseSha: r.run("git", ["rev-parse", "HEAD"]).stdout.trim(), state: "wip-committed" };
}

export type StashPushOutcome = "parked" | "partial" | "none" | "failed-with-entry" | "failed";
export interface StashPushResult {
  outcome: StashPushOutcome;
  sha: string;
  /** Whether this push left an entry for finish to restore — the proof-of-park rule, kept beside the
   *  five-way decision it derives from so a sixth outcome cannot be misclassified by a caller. */
  entryExists: boolean;
}

/** The one place `entryExists` is decided: `parked`/`partial`/`failed-with-entry` left work in the
 *  stash (a `failed-with-entry` sha can be empty and still be a park), `none`/`failed` did not. */
function parkResult(outcome: StashPushOutcome, sha: string): StashPushResult {
  return { outcome, sha, entryExists: outcome !== "none" && outcome !== "failed" };
}

/** Park the whole tree (tracked + untracked) in a stash named `message`, then PROVE the park — an
 *  rc-0 `git stash push` is not evidence the work is parked. git exits 0 having stashed NOTHING
 *  ("No local changes to save", e.g. only submodule content changed); it exits 0 having stashed
 *  only PART of the tree (paths it reports as `Ignoring path ...`, e.g. a nested repo); and it
 *  exits non-zero AFTER creating the entry (cleanup failing on a write-protected directory). So
 *  the outcome comes from the entry list plus a re-probe of the tree, never from the exit code:
 *    parked             new entry, tree now clean      — the whole tree is in the stash
 *    partial            new entry, tree still dirty    — residual paths stayed in the tree
 *    none               rc 0, no entry THIS push made  — nothing was stashed
 *    failed-with-entry  rc != 0 but a new entry exists (or its sha is unreadable) — work IS parked
 *    failed             rc != 0, no entry this push made — nothing was stashed
 *  Entry existence is the message scan, not `rev-parse refs/stash`: refs/stash resolves to whatever
 *  is on top, which may be someone else's stash. And the scan alone is not enough either — an
 *  aborted earlier run leaves an entry under the SAME name, so the entry's sha is compared against
 *  the pre-push sha of that name: only a sha that changed was created by this push. Caller must
 *  have established the tree is dirty. */
export function stashPush(r: Runner, message: string): StashPushResult {
  const before = stashShaFor(r, message);
  const rc = r.run("git", ["stash", "push", "--include-untracked", "-m", message]).code;
  const entry = stashEntry(r, message);
  if (!entry) return parkResult(rc === 0 ? "none" : "failed", "");
  const sha = entry.sha;
  // The match is the entry we already had: this push created nothing (git stashes nothing with rc 0
  // when only submodule content changed). Adopting it would hand finish a stash from another run.
  if (sha && sha === before) return parkResult(rc === 0 ? "none" : "failed", "");
  if (rc !== 0 || !sha) return parkResult("failed-with-entry", sha);
  const stillDirty = classifyDirty(r.run("git", ["status", "--porcelain", "--untracked-files=all"]).stdout);
  return parkResult(stillDirty ? "partial" : "parked", sha);
}

/** The stash ref whose reflog subject carries `message`; "" when no entry matches. Lines are
 *  `<ref>\t<subject>` (`--format=%gd%x09%gs`); `git stash push -m X` records the subject as
 *  "On <branch>: X", so the tail is what matches, not the whole subject. */
export function findStashRef(list: string, message: string): string {
  for (const line of list.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const subject = line.slice(tab + 1).trim();
    if (subject === message || subject.endsWith(`: ${message}`)) return line.slice(0, tab).trim();
  }
  return "";
}

/** The stash list, in the `<ref>\t<subject>` form `findStashRef` parses — the one place that
 *  format string is spelled. Callers that need the exit code read `.code` (an unreadable list is
 *  never an absence). */
function stashList(r: Runner): RunResult {
  return r.run("git", ["stash", "list", "--format=%gd%x09%gs"]);
}

/** The stash entry named `message` right now: its ref and its commit sha, or null when no entry
 *  matches. A ref whose rev-parse fails carries sha "" — that entry EXISTS, it just would not
 *  resolve, and `stashPush` reports it as `failed-with-entry` rather than pretending nothing was
 *  parked. */
function stashEntry(r: Runner, message: string): { ref: string; sha: string } | null {
  const ref = findStashRef(stashList(r).stdout, message);
  return ref ? { ref, sha: r.run("git", ["rev-parse", ref]).stdout.trim() } : null;
}

/** The commit sha of the stash entry named `message` right now; "" when there is none (or it will
 *  not resolve). `stashPush` takes this before pushing so a leftover entry from an aborted run —
 *  same name, someone else's work — can never be mistaken for the one it just created. */
function stashShaFor(r: Runner, message: string): string {
  return stashEntry(r, message)?.sha ?? "";
}

export type StashPopOutcome = "popped" | "conflict-kept" | "not-found" | "list-failed" | "identity-mismatch";

/** Pop the stash entry named `message`, but only when it is provably the one we pushed. The entry
 *  is located by scanning the list (an index shift from another stash cannot pop the wrong entry)
 *  and its commit sha must equal `expectSha`, the sha recorded at push time — a same-named entry
 *  from another run, or an unrecorded/empty `expectSha`, is `identity-mismatch` and is left alone.
 *  A failing `git stash list` is `list-failed`, NOT an absence: the entry may well exist, and
 *  treating an unreadable list as "gone" is how a caller drops a marker over a live stash. A failed
 *  pop leaves the entry in place. */
export function stashPopByMessage(r: Runner, message: string, expectSha: string): StashPopOutcome {
  const list = stashList(r);
  if (list.code !== 0) return "list-failed";
  const ref = findStashRef(list.stdout, message);
  if (!ref) return "not-found";
  if (!expectSha || r.run("git", ["rev-parse", ref]).stdout.trim() !== expectSha) return "identity-mismatch";
  return r.run("git", ["stash", "pop", ref]).code === 0 ? "popped" : "conflict-kept";
}

export interface StashPopOnBranchResult { outcome: StashPopOutcome | "wrong-head"; head: string; }

/** `stashPopByMessage` under its HEAD precondition — the one mistake nothing can undo. A pop lands
 *  on whatever HEAD is, so a caller that restores a park after a checkout it did not verify can
 *  consume the stash on the wrong branch. HEAD is probed first and a mismatch is `wrong-head`, with
 *  the stash untouched; the reported `head` is "" for a detached HEAD (symbolic-ref fails), which is
 *  likewise not the required branch. Callers word their own warning from `head`. */
export function stashPopOnBranch(r: Runner, message: string, expectSha: string, requiredBranch: string): StashPopOnBranchResult {
  const head = currentBranch(r);
  if (head !== requiredBranch) return { outcome: "wrong-head", head };
  return { outcome: stashPopByMessage(r, message, expectSha), head };
}

/** Create feat/quick-<topic> from current HEAD, or resume it if it already exists. */
export function createOrResumeBranch(r: Runner, name: string): boolean {
  if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).code === 0) {
    return r.run("git", ["checkout", "-q", name]).code === 0;
  }
  return r.run("git", ["checkout", "-q", "-b", name]).code === 0;
}

export function shortstat(r: Runner, base: string): string {
  return r.run("git", ["diff", "--shortstat", `${base}..HEAD`]).stdout.trim();
}

/** Whether there is a real branch, distinct from the start branch, for a finish to act on. Every
 *  finisher arm short-circuits to a no-op without one; implement's finish and quick's finish also
 *  ask BEFORE calling, to tell a deliberate `--no-branch` run (or a checkout that never landed)
 *  from the accident of having started on the feat branch, in their own command wording. */
export function hasDistinctBranch(r: Runner, branch: string, startBranch: string): boolean {
  return Boolean(branch) && branch !== startBranch &&
    r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

/** Every outcome a finisher returns. The commands write record-only strings of their own alongside
 *  these — `same-branch` (implement's pre-classification), `branch-only (kept <branch>)` and
 *  `stash-wip-kept` (quick's finish record), `in-place (commits on the current branch)` (bridge's
 *  no-branch mode) — which never come from here; their meaning lives in the directives that write
 *  them (commands/quick.md, implement.md, bridge.md). */
export type FinishOutcome =
  | "no-branch"
  | "kept" | "merged" | "merge-conflict-left" | "discarded"
  | "pr-opened" | "pr-pushed-no-gh" | "pr-failed-kept"
  | "local-merged-no-remote" | "local-merge-conflict-left"
  | "push-failed" | "pushed-no-gh"
  | "pr-create-failed" | "pr-open-merge-blocked" | "pr-merged-pull-failed" | "pr-merged-pulled";

export interface FinishWorkOpts {
  branch: string;
  /** The branch to merge/PR into and to return to — the run's start branch. */
  base: string;
  action: "auto" | "merge" | "pr" | "keep" | "discard" | "pr-merge";
  hasGh: boolean;
  originUrl?: string;
  title?: string;
  body?: string;
  /** Branding for the default PR title/body: `quick` | `implement` | `bridge`. */
  titlePrefix: string;
}
export interface FinishWorkResult {
  action: "pr" | "keep" | "merge" | "discard" | "pr-merge" | "local-merge" | "push-only" | "none";
  outcome: FinishOutcome;
}

/** push → PR → restore, the step quick's auto finish and implement's `pr` action share. The
 *  pr-merge flow does NOT come through here: its push-failure/no-gh/existing-PR outcomes are a
 *  different vocabulary with a different meaning (it goes on to merge), so it spells its own. */
function pushAndPr(r: Runner, o: FinishWorkOpts): FinishOutcome {
  let outcome: FinishOutcome;
  if (r.run("git", ["push", "-q", "-u", "origin", o.branch]).code === 0) {
    const url = o.originUrl ?? r.run("git", ["remote", "get-url", "origin"]).stdout.trim();
    const title = o.title ?? `${o.titlePrefix}: ${o.branch}`;
    const body = o.body ?? `Automated ${o.titlePrefix} branch. Review and merge into ${o.base}.`;
    if (o.hasGh && r.run("gh", ["pr", "create", "--repo", url, "--base", o.base, "--head", o.branch, "--title", title, "--body", body]).code === 0) {
      outcome = "pr-opened";
    } else {
      outcome = "pr-pushed-no-gh";
    }
  } else {
    outcome = "pr-failed-kept";
  }
  r.run("git", ["checkout", "-q", o.base]);
  return outcome;
}

/** The one finisher: guard the branch, act, restore the base checkout. Every arm is best-effort —
 *  a finish that cannot do its job records what happened instead of failing the run. The three
 *  exported finishers below are wrappers over this; each keeps its own return shape.
 *  `auto` resolves to `pr` when a remote exists and `keep` when none does (quick's semantics). */
export function finishWork(r: Runner, o: FinishWorkOpts): FinishWorkResult {
  if (!hasDistinctBranch(r, o.branch, o.base)) return { action: "none", outcome: "no-branch" };
  let action = o.action;
  if (action === "auto") action = finishAutoAction(r.run("git", ["remote"]).stdout);
  switch (action) {
    case "merge":
      r.run("git", ["checkout", "-q", o.base]);
      if (r.run("git", ["merge", "--no-edit", "-q", o.branch]).code === 0) { r.run("git", ["branch", "-q", "-D", o.branch]); return { action: "merge", outcome: "merged" }; }
      r.run("git", ["merge", "--abort"]); return { action: "merge", outcome: "merge-conflict-left" };
    case "keep":    r.run("git", ["checkout", "-q", o.base]); return { action: "keep", outcome: "kept" };
    case "discard": r.run("git", ["checkout", "-q", o.base]); r.run("git", ["branch", "-q", "-D", o.branch]); return { action: "discard", outcome: "discarded" };
    case "pr":      return { action: "pr", outcome: pushAndPr(r, o) };
    case "pr-merge": return prMerge(r, o);
    default: return { action: "none", outcome: "no-branch" };
  }
}

/** bridge's arm: open a PR, merge it (a merge commit), and fast-forward local base — a SINGLE
 *  integration point, so local base never diverges from the remote. Graceful fallbacks for
 *  no-remote / no-gh / merge-blocked / ff-fail. Ends checked out on `base` (best-effort). */
function prMerge(r: Runner, o: FinishWorkOpts): FinishWorkResult {
  // No remote → integrate locally (the PR path is impossible). Single merge into base.
  if (finishAutoAction(r.run("git", ["remote"]).stdout) === "keep") {
    r.run("git", ["checkout", "-q", o.base]);
    if (r.run("git", ["merge", "--no-edit", "-q", o.branch]).code === 0) {
      r.run("git", ["branch", "-q", "-D", o.branch]);
      return { action: "local-merge", outcome: "local-merged-no-remote" };
    }
    r.run("git", ["merge", "--abort"]);
    return { action: "local-merge", outcome: "local-merge-conflict-left" };
  }
  // Remote present → push the feature branch.
  if (r.run("git", ["push", "-q", "-u", "origin", o.branch]).code !== 0) {
    r.run("git", ["checkout", "-q", o.base]);
    return { action: "push-only", outcome: "push-failed" };
  }
  if (!o.hasGh) {
    r.run("git", ["checkout", "-q", o.base]);
    return { action: "push-only", outcome: "pushed-no-gh" };
  }
  const url = o.originUrl ?? r.run("git", ["remote", "get-url", "origin"]).stdout.trim();
  const title = o.title ?? `${o.titlePrefix}: ${o.branch}`;
  const body = o.body ?? `Automated ${o.titlePrefix} branch. Merged into ${o.base}.`;
  // gh pr create fails if a PR for this branch already exists — common in bridge, where the worker
  // often opens the PR itself. That is not a failure: only a create-failure with NO existing PR is
  // pr-create-failed; otherwise fall through and merge the open PR (the merge + ff-pull below is the
  // same recovery a stale local base needs).
  if (r.run("gh", ["pr", "create", "--repo", url, "--base", o.base, "--head", o.branch, "--title", title, "--body", body]).code !== 0 &&
      r.run("gh", ["pr", "view", o.branch, "--repo", url, "--json", "number"]).code !== 0) {
    r.run("git", ["checkout", "-q", o.base]);
    return { action: "pr-merge", outcome: "pr-create-failed" };
  }
  // Leave the feature branch BEFORE the merge deletes it.
  r.run("git", ["checkout", "-q", o.base]);
  if (r.run("gh", ["pr", "merge", o.branch, "--merge", "--delete-branch"]).code !== 0) {
    return { action: "pr-merge", outcome: "pr-open-merge-blocked" };
  }
  // The merge happened ONCE (on the remote); local base catches up by fast-forward only.
  if (r.run("git", ["pull", "--ff-only", "origin", o.base]).code !== 0) {
    return { action: "pr-merge", outcome: "pr-merged-pull-failed" };
  }
  return { action: "pr-merge", outcome: "pr-merged-pulled" };
}

export interface FinishOpts {
  branch: string;
  startBranch: string;
  hasGh: boolean;
  originUrl?: string;
  title?: string;
  body?: string;
}
export interface FinishResult { action: "pr" | "keep" | "none"; outcome: string; }

/** Auto finish: remote → push + gh PR; none → keep. Always restores the start-branch checkout. Best-effort. */
export function finishBranch(r: Runner, o: FinishOpts): FinishResult {
  const res = finishWork(r, { ...o, base: o.startBranch, action: "auto", titlePrefix: "quick" });
  return { action: res.action === "pr" || res.action === "keep" ? res.action : "none", outcome: res.outcome };
}

export interface FinishActionOpts {
  branch: string; startBranch: string; action: "merge" | "pr" | "keep" | "discard";
  hasGh: boolean; originUrl?: string; title?: string; body?: string;
}

/** Action-driven finisher (port of deploy_finish_branch @ deploy.sh:651). Restores startBranch
 *  (best-effort). New additive export; the auto finishBranch (used by quick) is unchanged. */
export function finishBranchAction(r: Runner, o: FinishActionOpts): string {
  return finishWork(r, { ...o, base: o.startBranch, titlePrefix: "implement" }).outcome;
}

export interface PrMergeOpts {
  branch: string;
  base: string;
  hasGh: boolean;
  originUrl?: string;
  title?: string;
  body?: string;
}
export interface PrMergeResult { action: "pr-merge" | "local-merge" | "push-only" | "none"; outcome: string; }

/** bridge's finisher: the pr-merge arm, in bridge's own return shape. */
export function finishBranchPrMerge(r: Runner, o: PrMergeOpts): PrMergeResult {
  const res = finishWork(r, { ...o, action: "pr-merge", titlePrefix: "bridge" });
  // Narrowing only: the pr-merge arm returns exactly these four actions.
  return { action: res.action as PrMergeResult["action"], outcome: res.outcome };
}
