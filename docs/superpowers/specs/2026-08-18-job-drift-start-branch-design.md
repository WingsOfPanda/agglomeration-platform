# `job stop`'s drift count follows the recorded start branch — design

**Date:** 2026-08-18
**Status:** approved (hub-authored; the worktree-path dogfood)

## Problem

`job stop`'s finish hint counts main-drift literally as `base_sha..main` (`finishHint` in
`src/commands/job.ts`): a repo whose base branch is not named `main` prints `MAIN_DRIFT=?`, and the
hint's own argument — "main moved while the run worked, so integrate via a PR that re-tests against
it" — carries no number exactly where it matters. Flagged in PR #137's risk report at ship time.

## Goal

The drift number works on any start branch, and the hint names the branch it counted. An old
`job.json` (no recorded branch) degrades to `DRIFT=?` rather than misreporting.

## Architecture

Record, don't guess: `job start` reads the branch HEAD sits on at fork time
(`git symbolic-ref --short HEAD`; empty on a detached HEAD) and stores it in `job.json` as
`start_branch` — the same soft-both-ways codec treatment `worktree`/`base_sha` received (absent in
old records, tolerated; empty when unresolvable). `finishHint` then counts
`base_sha..<start_branch>` when the record names a resolvable branch, and prints two renamed keys:
`START_BRANCH=<name>` and `DRIFT=<n>` (replacing `MAIN_DRIFT=`, which shipped only this morning and
has no consumers). Unrecorded or unresolvable → `START_BRANCH=?` and `DRIFT=?`. The brief and every
other verb are untouched.

## Components

- `src/core/job.ts` — `JobRecord.start_branch?: string`; `parseJob` tolerates absent/empty exactly
  as it does `worktree`/`base_sha`.
- `src/commands/job.ts` — `startRun` records the branch at fork time; `finishHint` counts against
  the recorded branch and emits `START_BRANCH=`/`DRIFT=` in place of `MAIN_DRIFT=`.
- `tests/job.test.ts` — codec round-trip including the absent-field case.
- `tests/job-worktree.test.ts` — live-git hint coverage: a temp repo whose base branch is named
  `trunk`, commits on the feat branch → the hint prints `START_BRANCH=trunk` and the right `DRIFT`
  count; a record with no `start_branch` → `DRIFT=?`.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — 0.5.38 (all
  three; the manifest-sync test enforces it).
- `dist/ap.cjs` — rebuilt and committed.

## Testing

Extend the two named test files (fresh `AP_HOME` per test; the live-git tests follow the existing
temp-`git init` pattern already in `tests/job-worktree.test.ts`). Full gate: `npm run typecheck`,
`npm run lint`, `npm run test`, `npm run build`.

## Success Criteria

- On a repo whose base branch is `trunk`, the finish hint prints `START_BRANCH=trunk` and a correct
  numeric `DRIFT=`; on a pre-0.5.38 record it prints `START_BRANCH=?`/`DRIFT=?`.
- `MAIN_DRIFT=` no longer appears anywhere in `src/` or the directives.
- Version 0.5.38 across the three manifests; `dist/ap.cjs` rebuilt; the full suite passes with the
  new coverage included.
