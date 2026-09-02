// src/core/gitwork.ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface RunResult { code: number; stdout: string; }
export interface Runner { run(cmd: string, args: string[]): RunResult; }

/** A cwd-bound synchronous command runner. execFileSync — never shell. The explicit maxBuffer is
 *  the same value implementVerifyTests.ts uses: Node's 1 MiB default turns a large stdout into an
 *  ENOBUFS throw with `status` null and a truncated buffer, which this wrapper would hand back as
 *  `{code: 1, stdout: <partial>}` — a silent partial rather than a failure. */
export function runnerAt(cwd: string): Runner {
  return {
    run(cmd, args) {
      try {
        const stdout = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
        return { code: 0, stdout };
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: Buffer | string };
        return { code: typeof err.status === "number" ? err.status : 1, stdout: err.stdout != null ? String(err.stdout) : "" };
      }
    },
  };
}

/** Why `p` is unusable as a `--target` checkout, or "" when it is fine. One reader for both commands
 *  so `implement init --target` and `quick init/branch --target` cannot drift apart on what they
 *  accept. Absolute is required because the value is RECORDED (target_cwd.txt) and later read by a
 *  different process with a different cwd — the same reason `job start` resolves its args file. */
export function targetProblem(p: string): string {
  if (!isAbsolute(p)) return `--target must be an absolute path; got: '${p}'`;
  if (!existsSync(p)) return `--target does not exist: ${p}`;
  if (runnerAt(p).run("git", ["rev-parse", "--is-inside-work-tree"]).code !== 0) return `--target is not inside a git work tree: ${p}`;
  return "";
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
 *  which is why this returns the empty string rather than picking one.
 *  The FULL ref is read and its one `refs/heads/` prefix stripped here rather than asking for
 *  `--short`: when a TAG shares the branch's name, `--short` disambiguates by printing
 *  `heads/<name>`, and every caller stores that name or hands it back to git as
 *  `refs/heads/<name>` — which then resolves to nothing. A branch literally named `heads/x` still
 *  reads as `heads/x`. */
export function currentBranch(r: Runner): string {
  const head = r.run("git", ["symbolic-ref", "HEAD"]);
  return head.code === 0 ? head.stdout.trim().replace(/^refs\/heads\//, "") : "";
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
  // The sha of any entry ALREADY under this name, taken before the push so a leftover from an
  // aborted run — same name, someone else's work — can never be mistaken for the one it created.
  const before = stashEntry(r, message)?.sha ?? "";
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

/** What `createOrResumeBranch` did. `stale` is the only one where NO checkout was attempted. */
export type BranchOutcome = "created" | "resumed" | "stale" | "failed";

/** Check out `name` — created from current HEAD, or resumed if the ref already exists. All three
 *  callers (quick, implement, bridge) pass their own `branchNameFor` name, which is derived from the
 *  topic, so a second run on the same topic asks for the same branch.
 *
 *  An existing ref is resumed only when it is a genuine continuation of where the checkout stands
 *  now: `git merge-base --is-ancestor HEAD refs/heads/<name>` (rc 0 = the branch tip is HEAD or a
 *  descendant of it). When HEAD is NOT an ancestor of the branch the checkout has moved on past the
 *  branch's fork point — exactly what a SQUASH merge of that branch leaves behind, since the squash
 *  commit carries the content but not the commits. Resuming there silently inherits already-merged
 *  work and re-proposes it as a PR, so it is `stale` and nothing is checked out. The branch is the
 *  operator's: ap never deletes, renames, or force-updates it — callers report and refuse.
 *
 *  A false positive is accepted: a genuine WIP branch whose start branch has since moved also reads
 *  `stale`. Resuming that is already the wrong default (it forks from an old point) and the callers'
 *  message names the ways forward. The false NEGATIVE — inheriting merged work — cannot happen. */
export function createOrResumeBranch(r: Runner, name: string): BranchOutcome {
  if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).code === 0) {
    if (r.run("git", ["merge-base", "--is-ancestor", "HEAD", `refs/heads/${name}`]).code !== 0) return "stale";
    return r.run("git", ["checkout", "-q", name]).code === 0 ? "resumed" : "failed";
  }
  return r.run("git", ["checkout", "-q", "-b", name]).code === 0 ? "created" : "failed";
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
  // The base checkout was refused, so NOTHING was merged, deleted, or pulled: the work is still on
  // `branch` and HEAD is still there. Written by the four load-bearing checkouts (see `onBase`).
  | "base-checkout-failed"
  | "kept"
  // `keep`, minus the start-branch restore: the target IS the run's own worktree and a job may still
  // be executing out of it, so the checkout is left where the run put it (FinishWorkOpts.keepOnBranch).
  | "kept-on-branch"
  | "merged" | "merge-conflict-left" | "discarded"
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
  /** Branding for the default PR title/body. Closed: a finisher brands its PRs as one of the three
   *  commands that own one, and a typo would ship as the PR's title. */
  titlePrefix: "quick" | "implement" | "bridge";
  /** Leave the checkout ON the feature branch instead of restoring `base` — set only when the caller
   *  has PROVEN this target is the run's dedicated worktree (`keepOnBranch`, src/core/job.ts). Read
   *  by the `keep` arm alone: keep is the only ending a detached run has, and the other arms merge,
   *  push or delete, which need the base checkout to mean anything. */
  keepOnBranch?: boolean;
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

/** Check out the base for a step that DECIDES an outcome AFTER it — a merge, a `branch -D`, a gh
 *  merge + pull. A refusal there (e.g. a dirty tracked file, the base held by another worktree, the
 *  base ref gone) is not cosmetic: what follows runs on the feature branch and is recorded as
 *  success — `git merge` merges the branch into ITSELF and reads as "merged". So those four sites
 *  return `base-checkout-failed` and issue nothing. The five restore-only checkouts stay unchecked
 *  by design: their outcome is already decided and a failure leaves only HEAD wrong.
 *  Whether the switch HAPPENED is read back rather than inferred from the exit code: a post-checkout
 *  hook (git-lfs whose binary is missing, husky/lefthook) exits non-zero AFTER git has already
 *  switched, and reading that as a refusal would strand a perfectly healthy finish — in the foreign
 *  repos bridge runs in, that hook is common. The read-back costs a call only on the non-zero path. */
function onBase(r: Runner, o: FinishWorkOpts): boolean {
  return r.run("git", ["checkout", "-q", o.base]).code === 0 || currentBranch(r) === o.base;
}

/** The one finisher: guard the branch, act, restore the base checkout. Every arm is best-effort —
 *  a finish that cannot do its job records what happened instead of failing the run.
 *  `auto` resolves to `pr` when a remote exists and `keep` when none does (quick's semantics). */
export function finishWork(r: Runner, o: FinishWorkOpts): FinishWorkResult {
  if (!hasDistinctBranch(r, o.branch, o.base)) return { action: "none", outcome: "no-branch" };
  let action = o.action;
  if (action === "auto") action = finishAutoAction(r.run("git", ["remote"]).stdout);
  switch (action) {
    case "merge":
      if (!onBase(r, o)) return { action: "merge", outcome: "base-checkout-failed" };
      if (r.run("git", ["merge", "--no-edit", "-q", o.branch]).code === 0) { r.run("git", ["branch", "-q", "-D", o.branch]); return { action: "merge", outcome: "merged" }; }
      r.run("git", ["merge", "--abort"]); return { action: "merge", outcome: "merge-conflict-left" };
    case "keep":
      // The restore hands the OPERATOR's checkout back; a dedicated run worktree has none to hand
      // back and may still have a live job running out of it, so there it is skipped (issue #165).
      if (o.keepOnBranch) return { action: "keep", outcome: "kept-on-branch" };
      r.run("git", ["checkout", "-q", o.base]); return { action: "keep", outcome: "kept" };
    case "discard":
      if (!onBase(r, o)) return { action: "discard", outcome: "base-checkout-failed" };
      r.run("git", ["branch", "-q", "-D", o.branch]); return { action: "discard", outcome: "discarded" };
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
    if (!onBase(r, o)) return { action: "local-merge", outcome: "base-checkout-failed" };
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
  // Leave the feature branch BEFORE the merge deletes it — refused, the PR stays open and unmerged
  // rather than merging with a base this checkout could not reach for the follow-up pull.
  if (!onBase(r, o)) return { action: "pr-merge", outcome: "base-checkout-failed" };
  if (r.run("gh", ["pr", "merge", o.branch, "--merge", "--delete-branch"]).code !== 0) {
    return { action: "pr-merge", outcome: "pr-open-merge-blocked" };
  }
  // The merge happened ONCE (on the remote); local base catches up by fast-forward only.
  if (r.run("git", ["pull", "--ff-only", "origin", o.base]).code !== 0) {
    return { action: "pr-merge", outcome: "pr-merged-pull-failed" };
  }
  return { action: "pr-merge", outcome: "pr-merged-pulled" };
}
