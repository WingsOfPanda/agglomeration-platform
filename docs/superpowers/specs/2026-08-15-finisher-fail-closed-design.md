# Finisher fails closed on a blocked base checkout — design

**Date:** 2026-08-15 · **Origin:** codex review finding f2, verified REAL (medium) by execution
against real repos. The finish-side twin of the known memory item "branch verbs return rc 0 on
failed checkout". · **Scope:** one PR (0.5.28).

## Problem

`finishWork`/`finishBranchPrMerge` (src/core/gitwork.ts) run `git checkout <base>` and proceed
WITHOUT checking its rc at four LOAD-BEARING sites (an outcome is decided after them):
gitwork.ts:250 (merge arm), :254 (discard arm), :267 (prMerge no-remote arm), :297 (prMerge
"leave the feature branch before the merge deletes it"). Reproduced with a worker-left dirty tracked
file (or the base held by another worktree — the parallel-session discipline this project mandates):

- **merge arm**: checkout fails rc 1 → `git merge feat/x` merges the branch into ITSELF ("Already up
  to date") → `git branch -D feat/x` fails (branch in use) → records `{action:"merge",
  outcome:"merged"}`. The feature commit never reached base; "merged" is indistinguishable from
  success.
- **discard arm**: records `discarded` while `branch -D` silently failed — and `createOrResumeBranch`
  will later RESUME the branch the user was told was deleted.
- **pr-merge, remote+gh**: checkout fails but `gh pr merge --delete-branch` still runs and
  `git pull --ff-only origin <base>` fast-forwards the FEATURE branch, not base → records
  `pr-merged-pulled` (full success) with a silently stale local base.

The FIVE best-effort restore checkouts (gitwork.ts:236, :253, :277, :281, :293 — outcome already
decided, failure only leaves HEAD wrong) are correct as-is and must NOT be touched: that split is
the whole point.

## Goal

Fail closed at exactly the four load-bearing checkouts: when `git checkout <base>` is refused,
return a truthful outcome and issue NO merge/delete/pull. rc stays 0 (finishers are best-effort by
design); the RECORD becomes honest and the refusal reaches /ap:review.

## Architecture

One new outcome string `base-checkout-failed` in the `FinishOutcome` union (gitwork.ts — not a
frozen wire name). A helper `onBase(r, o)` and at each of the four sites, on failure return the arm's
action with `outcome: "base-checkout-failed"` BEFORE any merge/branch-D/gh-merge/pull.

**Amended in implementation (adversarial review, BLOCKER):** `onBase` must not equate a non-zero
`git checkout` rc with "the switch did not happen". A post-checkout hook — git-lfs whose binary is
missing, husky/lefthook — exits non-zero AFTER git has already switched, which the rc-only form reads
as a refusal, stranding a healthy finish and breaking this PR's own "every currently-passing path is
byte-identical" criterion; bridge runs in arbitrary foreign repos where that hook is common. So
position is READ BACK, the same discipline as `stashPopOnBranch` and PR #126:
`r.run("git",["checkout","-q",o.base]).code === 0 || currentBranch(r) === o.base`. Zero extra calls
on the healthy path — the read-back only runs when the rc is non-zero.

- merge arm → `{action:"merge", outcome:"base-checkout-failed"}` (nothing merged, branch untouched)
- discard arm → `{action:"discard", …}` (never reach `branch -D` off-base)
- prMerge no-remote → `{action:"local-merge", …}`
- prMerge remote → `{action:"pr-merge", …}` — refuse BEFORE `gh pr merge`, leaving the PR OPEN and
  unmerged (recoverable by hand). Do NOT reuse `pr-open-merge-blocked` (asserts a different cause).

Meaning of the string: "the base checkout was refused, so NOTHING was merged/deleted/pulled — the
work is still on `<branch>` and HEAD is still there."

Callers/directives learn it:
- `src/commands/implement.ts` finishWith — count `base-checkout-failed` so `runFlag` reaches
  /ap:review. **Amended in implementation:** its own counter and its own flag, NOT the existing
  `stranded` one. That flag's body asserts "the work was left on the baseline branch (no distinct
  branch to act on)", which is false here — the branch exists and holds the work — and one counter
  cannot word two causes. `stranded` and its flag stay byte-identical; the new flag names the refused
  checkout and its own recovery. `commands/implement.md` finish-menu paragraph gains one sentence +
  recovery (clean/commit the tree or free the base branch, then re-run `implement finish`).
- `src/commands/bridge.ts` finishWith — extend the `res.outcome === "no-branch"` flag condition to
  this outcome (same runFlag + `currentBranch(r)` read-back it already does). **Amended in
  implementation:** the flag BODY is per-cause, and its consequence clause is keyed on `res.action`.
  The no-branch body is byte-identical (the prefix is now `finish-${res.outcome}`). TWO arms reach
  the new outcome: `pr-merge` refuses after the push with a PR possibly open, `local-merge` (no
  remote) pushed nothing — so a single body claiming a PR either way would be the same false record
  this PR exists to remove. `commands/bridge.md` Stage 3 fallback list gains a row (the PR is left
  open and unmerged when there was a remote; base NOT updated).
- `quick` — no change (auto never selects merge/discard/pr-merge arms).

## Components

- `src/core/gitwork.ts` — `onBase` guard at the four sites + the FinishOutcome member.
- `src/commands/implement.ts` + `commands/implement.md` — stranded count + directive sentence.
- `src/commands/bridge.ts` + `commands/bridge.md` — flag condition + directive row.
- `tests/` — see Testing. Version 0.5.27 → 0.5.28 (three manifests) + rebuilt committed dist.

## Testing

- Red-green in tests/gitwork-finishwork.test.ts (merge, discard) and tests/gitwork-prmerge.test.ts
  (no-remote arm; remote arm asserting ZERO `gh pr merge` / `git pull` calls) with a fakeRunner that
  returns `{code:1}` for `git checkout -q <base>`: the outcome becomes `base-checkout-failed` and the
  merge/delete/pull calls are NOT issued. Must fail against unmodified code. Plus two guards on the
  other side of the split under the same blocked checkout — `keep` still records `kept` and the `pr`
  arm still records `pr-opened` — so the best-effort restores cannot be tightened by accident. And
  the read-back's own red-green: `git checkout` rc 1 with `symbolic-ref` reporting the base (the
  post-checkout-hook shape) still merges, while the healthy rc-0 path never probes HEAD.
- Existing finisher tables pass unchanged (their fakeRunner defaults every unlisted call to rc 0, so
  the checkout succeeds and every current outcome is byte-identical).
- implement/bridge: the new outcome is counted/flagged (a stranded run reaches runFlag; assert the
  flag body).
- Full gate green; dist rebuilt+committed; E2E through the built dist replaying a blocked checkout
  (a real dirty tree) for the merge arm — records `base-checkout-failed`, base branch has no
  merge commit.

## Success Criteria

- A blocked base checkout can no longer produce a false `merged`/`discarded`/`pr-merged-pulled`
  record or a silently stale local base; the refusal is visible in /ap:review.
- Every currently-passing finisher path is byte-identical (the checkout succeeds in those).
- Gate green; 0.5.28.
