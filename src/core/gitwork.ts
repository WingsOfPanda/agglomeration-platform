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
export interface StashPushResult { outcome: StashPushOutcome; sha: string; }

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
  if (!entry) return { outcome: rc === 0 ? "none" : "failed", sha: "" };
  const sha = entry.sha;
  // The match is the entry we already had: this push created nothing (git stashes nothing with rc 0
  // when only submodule content changed). Adopting it would hand finish a stash from another run.
  if (sha && sha === before) return { outcome: rc === 0 ? "none" : "failed", sha: "" };
  if (rc !== 0 || !sha) return { outcome: "failed-with-entry", sha };
  const stillDirty = classifyDirty(r.run("git", ["status", "--porcelain", "--untracked-files=all"]).stdout);
  return { outcome: stillDirty ? "partial" : "parked", sha };
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

export interface FinishOpts {
  branch: string;
  startBranch: string;
  hasGh: boolean;
  originUrl?: string;
  title?: string;
  body?: string;
}
export interface FinishResult { action: "pr" | "keep"; outcome: string; }

/** Auto finish: remote → push + gh PR; none → keep. Always restores the start-branch checkout. Best-effort. */
export function finishBranch(r: Runner, o: FinishOpts): FinishResult {
  const action = finishAutoAction(r.run("git", ["remote"]).stdout);
  if (action === "keep") {
    r.run("git", ["checkout", "-q", o.startBranch]);
    return { action, outcome: "kept" };
  }
  let outcome: string;
  if (r.run("git", ["push", "-q", "-u", "origin", o.branch]).code === 0) {
    const url = o.originUrl ?? r.run("git", ["remote", "get-url", "origin"]).stdout.trim();
    const title = o.title ?? `quick: ${o.branch}`;
    const body = o.body ?? `Automated quick branch. Review and merge into ${o.startBranch}.`;
    if (o.hasGh && r.run("gh", ["pr", "create", "--repo", url, "--base", o.startBranch, "--head", o.branch, "--title", title, "--body", body]).code === 0) {
      outcome = "pr-opened";
    } else {
      outcome = "pr-pushed-no-gh";
    }
  } else {
    outcome = "pr-failed-kept";
  }
  r.run("git", ["checkout", "-q", o.startBranch]);
  return { action, outcome };
}

export interface FinishActionOpts {
  branch: string; startBranch: string; action: "merge" | "pr" | "keep" | "discard";
  hasGh: boolean; originUrl?: string; title?: string; body?: string;
}
/** Whether there is a real branch, distinct from the start branch, for a finish to act on. The
 *  finishers short-circuit to a no-op without one; implement's finish also asks BEFORE calling, to
 *  tell a deliberate `--no-branch` run from the accident of having started on the feat branch. */
export function hasDistinctBranch(r: Runner, branch: string, startBranch: string): boolean {
  return Boolean(branch) && branch !== startBranch &&
    r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

/** Action-driven finisher (port of deploy_finish_branch @ deploy.sh:651). Restores startBranch
 *  (best-effort). New additive export; the auto finishBranch (used by quick) is unchanged. */
export function finishBranchAction(r: Runner, o: FinishActionOpts): string {
  if (!hasDistinctBranch(r, o.branch, o.startBranch)) return "no-branch";
  switch (o.action) {
    case "merge":
      r.run("git", ["checkout", "-q", o.startBranch]);
      if (r.run("git", ["merge", "--no-edit", "-q", o.branch]).code === 0) { r.run("git", ["branch", "-q", "-D", o.branch]); return "merged"; }
      r.run("git", ["merge", "--abort"]); return "merge-conflict-left";
    case "keep":    r.run("git", ["checkout", "-q", o.startBranch]); return "kept";
    case "discard": r.run("git", ["checkout", "-q", o.startBranch]); r.run("git", ["branch", "-q", "-D", o.branch]); return "discarded";
    case "pr": {
      let outcome: string;
      if (r.run("git", ["push", "-q", "-u", "origin", o.branch]).code === 0) {
        const url = o.originUrl ?? r.run("git", ["remote", "get-url", "origin"]).stdout.trim();
        if (o.hasGh && r.run("gh", ["pr", "create", "--repo", url, "--base", o.startBranch, "--head", o.branch,
          "--title", o.title ?? `implement: ${o.branch}`,
          "--body", o.body ?? `Automated implement branch. Review and merge into ${o.startBranch}.`]).code === 0) outcome = "pr-opened";
        else outcome = "pr-pushed-no-gh";
      } else outcome = "pr-failed-kept";
      r.run("git", ["checkout", "-q", o.startBranch]); return outcome;
    }
    default: return "no-branch";
  }
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

/** bridge's finisher: open a PR, merge it (a merge commit), and fast-forward local base — a SINGLE
 *  integration point, so local base never diverges from the remote. Graceful fallbacks for
 *  no-remote / no-gh / merge-blocked / ff-fail. Ends checked out on `base` (best-effort). */
export function finishBranchPrMerge(r: Runner, o: PrMergeOpts): PrMergeResult {
  if (!o.branch || o.branch === o.base ||
      r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${o.branch}`]).code !== 0) {
    return { action: "none", outcome: "no-branch" };
  }
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
  const title = o.title ?? `bridge: ${o.branch}`;
  const body = o.body ?? `Automated bridge branch. Merged into ${o.base}.`;
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
