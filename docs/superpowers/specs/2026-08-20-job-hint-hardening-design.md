# Drift-hint hardening + detached budget discipline — design

**Date:** 2026-08-20
**Status:** approved (hub-authored; from the 2026-08-20 forensics review, clusters 2+3)

## Problem

Three verified-open code defects from the drift-branch run's cross-verify notes, plus one directive
gap from the xjp budget incident:

1. `src/core/gitwork.ts:47` `currentBranch` runs `git symbolic-ref --short HEAD`. When a TAG with
   the same name as the branch exists, `--short` disambiguates by printing `heads/<name>`; `job
   start` records that as `start_branch`, and `finishHint`'s
   `rev-list --count <base>..refs/heads/heads/<name>` then fails, degrading the drift hint to `?/?`.
2. `src/commands/job.ts:289` gates `START_BRANCH=` on `driftKnown`, hiding a recorded branch name
   whenever only the drift COUNT fails — but `commands/job.md` documents the two degrading
   independently.
3. `src/commands/job.ts:285-290` prints `DRIFT=` from `driftCount` (a trimmed stdout string) with no
   numeric validation, while `COMMITS` at :280-281 has the `Number.isFinite` guard.
4. On xjp, a job hub read the budget inside a compound command that ALSO dispatched the next round —
   the dispatch escaped before the budget verdict could halt it. Separately, the same hub
   paraphrased a budget number into five artifacts without ever pasting the verb's raw output
   (the `BUDGET_H=8760` misreport, adjudicated in the 2026-08-20 review).

## Goal

The finish hint never lies or hides what it knows: a recorded start branch prints even when the
count fails; a tag can no longer poison the recorded name; a non-numeric count prints `?`. Detached
hubs mechanically cannot race a dispatch past a budget verdict, and budget/park texts carry the
verb's raw lines, not paraphrases.

## Architecture

- **A1** (`src/core/gitwork.ts` `currentBranch`): derive from the FULL ref — `git symbolic-ref
  HEAD` — and strip one leading `refs/heads/`. Detached HEAD / error stays `""` (rc non-zero, same
  as today). This fixes the tag-shadow class for every caller (all callers want the branch name;
  none wants `--short`'s disambiguation prefix). A branch literally named `heads/x` now records
  correctly as `heads/x`.
- **A2** (`src/commands/job.ts` `finishHint`): print `START_BRANCH=${rec.start_branch || "?"}`
  independently of the drift computation. Compute `DRIFT=` as: `drift?.code === 0` AND the trimmed
  stdout parses `Number.isFinite` → the number; else `?`. (Matches the `COMMITS` discipline and
  `commands/job.md`'s documented independent degradation.)
- **A3** (directive prose, detached sections that instruct the budget loop — locate them in
  `commands/implement.md` and `commands/quick.md`, plus the budget-check row in `commands/job.md`
  if it names hub behavior): two rules, stated once per file where the budget loop lives:
  (a) `job budget-check` runs as its OWN command and its rc is branched on BEFORE any
  turn-send/send verb — never inside a compound command that also dispatches;
  (b) any flag, park message, or RESUME.md line that cites budget numbers pastes the verb's raw
  stdout lines (`BUDGET=`/`ELAPSED_H=`/`BUDGET_H=`) verbatim — a hub's paraphrase of a verb is not
  evidence.
- **A4** version 0.5.42 across the three manifests; `dist/ap.cjs` rebuilt and committed.

## Components

- `src/core/gitwork.ts` — `currentBranch` full-ref derivation.
- `src/commands/job.ts` — `finishHint` independent `START_BRANCH`/validated `DRIFT`.
- `commands/implement.md`, `commands/quick.md`, `commands/job.md` — the A3 rules at the budget-loop
  sites (surgical: only where budget-check is instructed/documented).
- `tests/gitwork.test.ts` (or wherever currentBranch is covered; extend, don't fork) — injected-
  runner cases: `refs/heads/x` → `x`; `refs/heads/heads/x` → `heads/x`; rc 1 → `""`.
- `tests/job-worktree.test.ts` — finishHint cases: recorded branch + failing drift command →
  `START_BRANCH=<name>`/`DRIFT=?`; no recorded branch → `?`/`?`; non-numeric drift stdout → `?`;
  existing live-git `START_BRANCH=trunk` case still green.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — 0.5.42.
- `dist/ap.cjs` — rebuilt.

## Testing

Extend the named files with the cases above (fresh AP_HOME where state is touched; injected Runner,
never live tmux). Full gate: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`.

## Success Criteria

- A repo with a tag named like the current branch records `start_branch=<name>` (no `heads/`
  prefix) and the hint counts drift correctly (live-git test).
- A recorded branch always prints in `START_BRANCH=` even when the drift command fails; `DRIFT=`
  prints `?` for non-zero rc OR non-numeric stdout.
- The three directive files instruct budget-check-as-own-command and raw-line quoting at every
  budget-loop site; no other prose changed.
- 0.5.42 across the manifests; dist rebuilt; full suite green with the new coverage.
