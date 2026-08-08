# quick branch --stash-wip — design

**Date:** 2026-08-08 · **Origin:** /ap:review forensics cluster — FOUR consecutive xjp quick runs
(2026-08-06/07: `implement-the-verifi`, `execute-the-6-item-m`, `land-the-two-clock-r`,
`land-the-draw-proven`) each swept ~75 unrelated dirty files into the branch-base snapshot; three
hub reflections independently name `--stash-wip` as the durable fix. · **Scope:** one PR.

## Problem

`quick branch` runs `preSnapshot` (`src/core/gitwork.ts:32`): a dirty tree is committed wholesale
(`git add -A` + WIP commit) on the start branch before the quick branch forks. In a working tree
carrying unrelated WIP, that publishes stale local edits into the PR base; every affected run
needed a manual hub `rebase --onto` at finish plus a tree restore. Recurred 4-for-4 on real runs.

## Goal

An opt-in `quick branch --stash-wip <topic>` that parks pre-existing WIP in a git stash before the
snapshot, so the quick branch forks from clean HEAD and the PR carries only the worker's commits —
and restores the WIP automatically at finish. Default behavior (no flag) is byte-identical to
today; enforcement degrades toward keeping work (a failed restore leaves the stash intact and says
so, never drops changes).

## Architecture

The governing rule everywhere below: **a layer records its own verdict; it never infers another
layer's.** `git stash push`'s exit code is not a verdict about the tree, and a `git stash list` that
failed to run is not a verdict that the entry is gone.

**Flag persistence.** `parseQuickArgs` returns `stashWip: boolean`. `quick init` writes
`execute/stash-wip-requested.txt` (`yes`/`no`) and echoes `STASH_WIP=<yes|no>` in its stdout KV
block; the directive passes the flag to the branch step mechanically from that value, never by
re-reading `$ARGUMENTS` (where a long topic text made it easy to drop). `quick branch` accepts the
flag on either side of the topic (`parseBranchArgs`).

**Branch side.** `branchWith` gains a `stashWip` option and `mkdirSync(exec, {recursive:true})` at
the top (`atomicWrite` does not create parents; a bare `quick branch --stash-wip` without an init
otherwise threw AFTER the tree was already emptied). When set, the dirty gate is
`git status --porcelain --untracked-files=all` — a repo configured `status.showUntrackedFiles no`
makes a bare `--porcelain` report a clean tree git will still refuse to leave behind. If dirty:
`git stash push --include-untracked -m "ap-quick-<topic>-wip"` BEFORE `preSnapshot`, then
**prove the park**. `stashPush` returns one of five outcomes, derived from the entry list plus a
re-probe of the tree, never from the exit code:

| outcome | evidence | `branchWith` does |
|---|---|---|
| `parked` | a NEW entry exists, tree now clean | ok log, then write the marker |
| `partial` | a NEW entry exists, tree STILL dirty (paths git could not stash — a nested repo, submodule content) | warn that the residual paths stay in the tree for the snapshot path, then write the marker |
| `none` | rc 0 and no entry this push created — either no entry at all, or the only match is byte-identical (same sha) to the pre-push one (`No local changes to save`; submodule-content-only) | nothing — no marker, no success log, quiet fall-through |
| `failed-with-entry` | rc != 0 but a new entry exists (cleanup failed on a write-protected dir), or its sha will not resolve | warn that the tree may still hold the same changes and the snapshot path will commit them, then write the marker anyway — finish must restore it |
| `failed` | rc != 0 and no entry this push created (same pre/post sha comparison as `none`) | today's warn + fall-through to the snapshot path |

Entry existence is a `git stash list --format=%gd%x09%gs` scan for our message, **not**
`rev-parse refs/stash` (which resolves to whatever is on top — possibly a foreign stash). The scan
alone is not enough either: an aborted earlier run leaves an entry under the SAME name, so
`stashPush` resolves that name's sha BEFORE pushing and compares. A match whose sha is unchanged was
not created by this push and is never adopted — otherwise a submodule-content-only tree would record
the leftover's sha and finish would pop a stash this run never made. Identity is the located entry's
`git rev-parse <ref>` sha, recorded with the message in `execute/stash-wip.txt` as
`<sha>\t<message>`. Every outcome **logs before it writes the marker**: if the marker write fails,
the log line is the user's only pointer to a stash that now exists.

**Finish side.** `restoreStashWip` runs on BOTH `finishWith` paths (finish and `--no-finish`), after
the start-branch checkout, and takes `startBranch`:

1. **HEAD gate.** `git symbolic-ref --short HEAD` must equal `startBranch`. The checkout above can
   fail SILENTLY (a worker that left the tree dirty blocks it), and popping onto `feat/quick-<topic>`
   consumes the stash on the wrong branch — the one outcome nothing can undo. rc != 0 (detached) or
   a different branch → skip the pop entirely, KEEP stash + marker, warn naming the actual branch,
   return `stash-wip-kept`.
2. **Locate + identity.** `stashPopByMessage(r, message, expectSha)` scans the list
   (index-shift-proof). A **failing** `git stash list` is `list-failed` — an unreadable list is not
   an absence, so the marker stays. A located entry whose `rev-parse` sha differs from the recorded
   one, or an empty recorded sha, is `identity-mismatch`: another run's same-named stash is never
   popped. Both keep stash + marker → `stash-wip-kept`.
3. **Pop.** Only `popped` removes the marker. `conflict-kept` keeps both and warns with recovery
   that fits `--include-untracked` reality: a conflicted pop may have ALREADY extracted some
   untracked files, so if the pop says `<file> already exists`, remove those files first (or
   `git checkout <ref> -- .`), then pop again.
4. **Verified absence.** List rc 0 with no entry carrying our message (the user popped it by hand)
   is the ONE case that removes the marker without popping: nothing is left to keep, and a marker
   pointing at nothing would make every later finish warn about a stash that is gone.

Every `stash-wip-kept` outcome also records a hub flag (`runFlag`, the same helper the `flag` verb
uses): `stash-wip-kept: WIP still stashed as '<message>' in <target>; restore: git checkout
<start-branch> then git stash pop`. `finish-result.txt`'s second line is unchanged, but the flag
outlives teardown and surfaces in `/ap:review`.

**Crash recovery** is prose + `RESUME.md`. The stash outlives any hub/worker crash by construction
(it is a git ref), but an aborted run also leaves HEAD on `feat/quick-<topic>`, so the recovery is
**branch-first**: `git -C <TARGET> checkout <start-branch>` (from `execute/start-branch.txt`) THEN
`git stash pop <ref>`. `renderResume` takes an optional stash note and renders a `## Parked WIP`
pointer carrying exactly that; `summaryRun` passes it when `execute/stash-wip.txt` exists.
`commands/quick.md` says the same in the Stage-1 abort path and the Notes.

No new subprocess surface: all git calls go through the existing `Runner`.

## Components

- `src/core/gitwork.ts` — `stashPush(r, message)` returning `{outcome, sha}` over the five-outcome
  `StashPushOutcome`; `stashPopByMessage(r, message, expectSha)` returning
  `popped | conflict-kept | not-found | list-failed | identity-mismatch`; `findStashRef` unchanged;
  no change to `preSnapshot`.
- `src/commands/quick.ts` — `parseBranchArgs` (flag either side of the topic); `initWith` persists +
  echoes the flag; `branchWith` creates the state dir, gates on `--untracked-files=all`, and maps
  the five outcomes to marker/log; `restoreStashWip(topic, exec, r, startBranch)` gains the HEAD
  gate, the identity check, the hub flag, and the not-found decision; `summaryRun` feeds the stash
  note to RESUME.
- `src/core/quick.ts` — `QuickArgs.stashWip`; `ResumeFacts.stashNote` + the `## Parked WIP` section.
- `commands/quick.md` — `STASH_WIP` in the init capture block; Stage 1 passes the flag from it;
  Stage 2 documents every `stash-wip-kept` case; Stage-1 aborts and the Notes carry the
  branch-first recovery.
- `tests/` — see Testing.
- `package.json` + `dist/ap.cjs` — bump (0.5.10 → 0.5.11 assuming the spawn-seed PR lands first);
  rebuild + commit dist.

## Testing

All with a fake `Runner` (recorded arg arrays — the repo's standard for git/tmux):

- No flag → byte-identical git call sequence to current `branchWith` (regression pin, unchanged:
  the `--untracked-files=all` probe only runs on the flag path).
- Dirty + flag → full-sequence `toEqual` pin: dirty gate, push, list, `rev-parse <ref>`, re-probe,
  then preSnapshot on a clean tree; marker records `<sha>\t<message>`; base is the clean HEAD.
- `stashPush` outcome matrix, one test each: parked / partial / none / failed-with-entry (rc 1 with
  an entry, and rc 0 with an unresolvable sha) / failed — plus the `branchWith` consequence
  (marker written or not, snapshot path taken or not). The fake Runner is STATEFUL (a pre-push and a
  post-push stash state) so a push that created nothing is distinguishable from one that did.
- Leftover same-named entry + a push that creates nothing (list identical before/after) → `none`,
  rc 1 variant → `failed`, and `branchWith` writes NO marker. Leftover + a push that DOES create an
  entry (new one at `stash@{0}`, old at `stash@{1}`) → `parked` with the NEW sha in the marker.
- Clean tree + flag → no stash call, no marker. No state dir + flag → dir created, rc 0.
- `parseBranchArgs`: `--stash-wip auth` and `auth --stash-wip` both → topic `auth`, flag on; flags
  alone → usage rc 2. `initWith` writes `stash-wip-requested.txt` and echoes `STASH_WIP=`.
- Finish, marker present, HEAD on the start branch, sha matches → pop with the resolved ref after
  the checkout, marker removed; both the finish and `--no-finish` paths.
- Finish keeps stash + marker + writes `stash-wip-kept` AND a hub flag for: HEAD on
  `feat/quick-<topic>`, detached HEAD, sha mismatch, `git stash list` rc != 0, pop conflict.
- Verified absence → marker removed, no flag, rc 0. No marker → no stash calls at all.
- Aborted `quick summary` with a marker → `RESUME.md` carries `## Parked WIP` with the
  checkout-then-pop recovery.

## Success Criteria

- A dirty-tree quick run with `--stash-wip` produces a PR whose base carries NO WIP snapshot
  commit, and ends with the WIP back in the working tree on the start branch.
- The stash is popped ONLY onto the start branch, and ONLY when the entry's sha is the one this run
  parked; every other path keeps the stash, keeps the marker, says where the work is, and records a
  hub flag. Zero silent drops, zero hard blocks, no success logged for a park that did not happen.
- Default (flag absent) call sequences are provably unchanged (test pin).
- Full gate green; dist rebuilt + committed.
