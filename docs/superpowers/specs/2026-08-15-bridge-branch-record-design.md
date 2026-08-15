# Bridge's branch record tells the truth — design

**Date:** 2026-08-15 · **Origin:** the declared follow-up from PR #125's adversarial review, which
reproduced the defect on the shipped dist and deferred it as outside the deepening program's
two-change perimeter. The operator has now ordered it: this is the THIRD sanctioned behavior
change, user-directed. · **Scope:** one small PR (0.5.26).

## Problem

`bridge branch` has exactly the defect `quick branch` lost in #125: it writes `execute/branch.txt`
with the INTENDED name unconditionally (src/commands/bridge.ts branchWith:
`atomicWrite(join(exec, "branch.txt"), branch + "\n")`; a failed `createOrResumeBranch` only
warns). The consequences are worse here because bridge's finish is the PR-**MERGE** flow:

- **The stale-ref shape** (#125's reviewer reproduced it end-to-end on the shipped dist): a
  leftover `feat/bridge-<topic>` from an earlier run plus a failed checkout for THIS run — the
  work lands on the start branch, yet finish reads the stale name, `finishBranchPrMerge`'s guard
  passes (the ref exists and is distinct), and the run pushes, opens a PR for, and **MERGES** a
  branch containing none of this run's commits — recorded as `pr-merge\tpr-merged-pulled`.
- The round-1 brief (`composeBridgeBrief(task, repo, branch)`) tells the worker it is on a branch
  it is not on, under BRANCH_DISCIPLINE ("you are already on the correct branch — do NOT
  checkout").
- RESUME.md's restore line ("the worker's work is on `<branch>`") and SUMMARY.md's `- Branch:`
  line name a branch that does not hold the work.

## Goal

`bridge branch` records the branch the run ACTUALLY ended on, exactly as quick (#125) and
implement (its `recorded` value) already do. A failed checkout then flows into
`finishBranchPrMerge`'s EXISTING guard (`branch === base` → `{action: "none", outcome:
"no-branch"}`) — no new guard needed — and the refusal is surfaced to /ap:review with a flag,
mirroring quick's. Everything downstream (brief, RESUME, SUMMARY) becomes honest automatically
because it reads the same record.

## Architecture

1. **The behavior change** — one expression in `branchWith` (src/commands/bridge.ts):
   `atomicWrite(join(exec, "branch.txt"), (onBranch ? branch : snap.branch) + "\n")`.
   The warn line stays byte-identical. The trailing `log.ok` keeps naming the INTENDED branch —
   the same deliberate decision #125 made for quick (not an extra user-visible change); pin it.
   A failed checkout from a detached HEAD records `(detached)` (what `preSnapshot` returns) — and
   so does `start-branch.txt`, so the guard refuses it on the `branch === base` arm, both sides
   being the literal string; the ref probe never runs. The single-occupancy check is untouched
   (it reads `snap`, not the record).

2. **Surface the refusal** — in `finishWith` (branch mode), after the finisher returns: when
   `res.outcome === "no-branch"`, `runFlag("bridge", topic, "finish-no-branch: ...")` with
   quick's wording shape — the recorded branch, the start branch, "nothing was pushed, no PR
   opened", and the location derived from `currentBranch(r)` read AFTER the finisher (whose
   no-branch arm performs no checkout), with the `(detached)` fallback. The
   `finish-result.txt` record (`none\tno-branch`) needs no change — the finisher already
   produces it; only the /ap:review visibility is added. The in-place path is untouched.

3. **Nothing else changes.** No new files, no gitwork edits, no reader changes —
   `readBranchRecord` already reads whatever `branch.txt` holds.

## Components

- `src/commands/bridge.ts` — the record expression in branchWith; the flag in finishWith.
- `commands/bridge.md` — one line: `branch.txt` records the branch the run is actually on, so a
  failed checkout ends in finish's `no-branch` refusal (flagged for /ap:review) rather than a
  merged PR containing none of the run's work.
- `tests/` — see Testing. Version 0.5.25 → 0.5.26 (three manifests) + rebuilt committed dist.

## Testing

- **Red-green (must fail against unmodified code):** (a) checkout failed → `branch.txt` holds the
  START branch and the warn still names both; (b) failed checkout from detached HEAD → records
  `(detached)`; (c) **the stale-ref shape end-to-end**: a pre-existing `feat/bridge-<topic>` +
  a failed checkout for THIS run → finish records `none\tno-branch`, issues ZERO push/gh calls,
  and writes the `finish-no-branch` flag — where today it pr-merges the stale ref.
- **Over-refusal guard:** a stale ref whose checkout SUCCEEDS (a legitimate resume) still records
  the branch name and still merges — byte-identical to today (pin it; #125's reviewer verified
  the analogous quick case).
- RESUME facts after a failed checkout name the REAL branch; the healthy path's RESUME/SUMMARY
  byte-identical.
- The `log.ok` intended-name decision pinned (a change there must fail a test — the gap #125's
  reviewer flagged for quick).
- The flag: fires only on `no-branch` (mutation: firing it on every finish must fail; not firing
  it must fail); wording pinned including the head read-back.
- All existing bridge suites: assertions may change ONLY where they pin the old
  intended-name-on-failure behavior — list every such edit in the report.
- Full gate green; dist rebuilt+committed; E2E through the built dist replaying the stale-ref
  shape against a real bare origin (zero refs pushed).

## Adjudicated decisions (review of the shipped PR)

- **The flag keeps quick's or-ed wording and its single `finish-no-branch:` cluster key.** It names
  the three refusal shapes as one ("is missing or is the start branch"), so it also fires on the
  allowed same-branch-resume shape — a run that STARTED on `feat/bridge-<topic>`. That is accurate
  (nothing was pushed, nothing was integrated) and consistent with quick's reviewed decision, and
  one key keeps /ap:review's clustering intact. Splitting the causes into distinct keys is a future
  option for BOTH commands together, not a bridge-only divergence.
- **No `finish-head.txt` / summary-line parity with quick.** #125's follow-up (cdd9b3d) persists
  finish's read-back HEAD for quick's summary; bridge's summary renders `finish-result.txt` raw and
  gets no equivalent here. Deliberately scoped out — it is a summary-rendering change, not part of
  the record, and belongs to its own spec if wanted.

## Success Criteria

- A bridge run whose checkout failed can no longer merge a PR containing none of its work; the
  refusal is visible in /ap:review.
- Exactly one behavior change (the record + its flag); bridge's healthy paths byte-identical,
  proven by differential.
- Gate green; 0.5.26.
