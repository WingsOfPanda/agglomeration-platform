# keep-on-branch: never restore the start branch under a live job's own worktree

Date: 2026-08-29. Source: issue #165 (xjp field, two occurrences on consecutive days) plus its
post-adversarial-review amendment, which is binding here. Code cited at main 0.5.56/0.5.57.

## Problem

`finish` for a detached run restores the START branch **inside the run's own worktree**, while a
multi-hour job launched from `feat/<cmd>-<topic>` may still be executing out of that same tree.

Both field occurrences were `/ap:quick` detached runs on xjp:

- `fix-what-you-need-an` (2026-08-28, forensics `14-16-01`): finish checked out
  `base/fix-what-you-need-an` under a live 4.6h overfit run; on-disk `tools/run_reg_overfit.py` lost
  the fix the run was stamped with. Harmless only because the imports were already cached; the hub
  re-checked the feat branch out by hand so disk matched the run's recorded `code_sha`.
- `re-run-the-five-phas` (2026-08-29, forensics `02-57-37`): the same swap under a live DDP run from
  `f35edeb`; measured harmless (no lazy imports in that driver chain), re-checked out by hand.

**The dangerous variant is silent.** A driver with any lazy import, any `ROOT`-relative re-read, or
any restart then executes the WRONG tree while the evidence record still carries the feat branch's
`code_sha` — nothing fails, and the numbers are attributed to code that was never run.

The restore itself is not wrong in general: it exists so the **operator's** checkout comes back
after a run borrowed it. A dedicated run worktree has no operator checkout to give back, so there
the restore is pure hazard.

### Two code paths, not one

The amendment's first finding: the observed field path is **not** `finishWork`'s keep arm.

1. **quick's branch-only arm (the OBSERVED path).** With a detached job record present,
   `src/commands/quick.ts` `finishWith` forces `doFinish=false` (the publication gate) and takes the
   branch-only arm, which runs `r.run("git", ["checkout", "-q", startBranch])` **directly** and never
   calls `finishWork`. That direct checkout is what swapped the tree in both field runs. Patching
   `finishWork` alone would have fixed nothing observed.
2. **implement's detached finish (the SIBLING).** A detached implement is forced to `keep`
   (`src/commands/implement.ts`, the detached-job gate) and DOES route `applyFinish` →
   `finishBranchAction` → `finishWork`, whose keep arm was
   `case "keep": r.run("git", ["checkout", "-q", o.base]); return { action: "keep", outcome: "kept" };`
   — unconditional. Same checkout-under-a-live-process hazard, one command over.

### Why "a job record exists" is the wrong guard

The amendment's third finding, and the reason this spec exists rather than a one-line patch.
`ap job start --no-worktree` also leaves a live job record, but records `worktree: ""` and the run
works in the **operator's own checkout**. Skipping the restore there strands the operator on the
feature branch, and with `--stash-wip` leaves their WIP parked behind `stashPopOnBranch`'s
wrong-HEAD protection — a regression handed to exactly the runs the fix is not about. Records
written before 0.5.36 carry no `worktree` field at all and read the same way.

## Goal

A finish leaves the checkout on the run's branch **iff** the target it ran in is provably the run's
own dedicated worktree; in every other shape its behavior is byte-identical to before.

## Architecture

One shared predicate, wired into both paths, and nothing else changes.

**`keepOnBranch(topic, targetCwd): boolean`** (`src/core/job.ts`, beside `worktreeProvenanced` /
`mainCheckoutRoot` / `worktreeTopic`). True only when ALL FOUR hold:

1. a job record for the topic exists AND parses (`jobPath` + `parseJob` — a torn or hand-edited
   record reads as "no job here", the discipline `parseJob` already owns);
2. `rec.worktree` is non-empty — this is what excludes `--no-worktree` runs and pre-0.5.36 records;
3. the path is **ap-provenanced**: `mainCheckoutRoot(wt) !== wt`, which is exactly
   `worktreeProvenanced(wt, dirname³(wt))` — the `<root>/.ap/worktrees/<topic>` shape ap creates by
   construction (`worktreePathFor`) and the same provenance `job stop` refuses to remove a foreign
   path with;
4. `realpathSync(rec.worktree) === realpathSync(targetCwd)` — canonical-path equality with the
   target this finish actually ran in, so a symlinked or `..`-laden target still matches and a
   record naming some other tree never does. Any throw (either path gone) → false.

Any condition false → false, and every caller behaves exactly as today. Liveness is deliberately
NOT probed: on a dedicated run worktree there is no operator checkout to restore either way, so the
conservative answer costs nothing, and inferring another layer's verdict from a pane probe is the
inference this codebase does not do.

**Path (a) — quick's branch-only arm** (`src/commands/quick.ts` `finishWith`): the guard decides
between the direct checkout and skipping it. Guarded, it logs the reason (`kept-on-branch — a live
detached job runs from this worktree (<target>); NOT restoring '<startBranch>'`) and writes
`none\tkept-on-branch (kept <branch>)` as the first line of `finish-result.txt` instead of
`none\tbranch-only (kept <branch>)`. `restoreStashWip` still runs in BOTH cases: its wrong-HEAD
protection is precisely right under a skipped restore — the park stays stashed, the marker stays,
and the kept flag reaches `/ap:review`. quick's auto `finishBranch` path is untouched: it cannot
coexist with a job record (the record forces `doFinish=false`).

**Path (b) — the shared finisher** (`src/core/gitwork.ts`): `FinishWorkOpts` gains
`keepOnBranch?: boolean` and `FinishOutcome` gains `"kept-on-branch"`; the `keep` arm returns it
without a checkout when the flag is set. Read by the `keep` arm ALONE — merge/pr/discard need the
base checkout to mean anything, and they are refused for detached runs regardless.
`FinishActionOpts` passes the flag through, and `src/commands/implement.ts` `applyFinish` computes
`keepOnBranch(topic, t.cwd)` per target so the outcome lands in `finish-results.tsv`.

## Non-goals (deliberate, do not "fix")

- **No directive changes.** `commands/quick.md` / `commands/implement.md` are untouched; the new
  outcome string is documented here.
- **No liveness probe, no `job stop` interaction.** Teardown still owns the worktree's fate.
- **merge / pr / discard / pr-merge keep their semantics**, in both commands.
- **quick's auto-finish path stays as it is** — unreachable with a job record present.
- The summary hint is unchanged by construction: `renderSummary` matches the outcome field WHOLE
  against `no-branch`, so `kept-on-branch (kept feat/quick-<topic>)` keeps the
  `git -C <target> checkout <branch>` pointer, which is still the right pointer.

## Components

- `src/core/job.ts:98-120` — new exported `keepOnBranch(topic, targetCwd)`; imports `realpathSync`
  and `readIfExists`. No change to `worktreeProvenanced` / `mainCheckoutRoot` / `parseJob`.
- `src/core/gitwork.ts:228-236` — `FinishOutcome` gains `"kept-on-branch"`.
- `src/core/gitwork.ts:243-256` — `FinishWorkOpts.keepOnBranch?: boolean` (documented as
  caller-proven).
- `src/core/gitwork.ts:310-314` — `finishWork`'s `keep` arm honors it.
- `src/core/gitwork.ts:392-397` — `FinishActionOpts.keepOnBranch?: boolean`, passed through by
  `finishBranchAction`.
- `src/commands/quick.ts:401-424` — the branch-only arm: guard, log line, `kept-on-branch` record,
  `restoreStashWip` unchanged.
- `src/commands/implement.ts:571,595-600,620` — `applyFinish` takes `topic` and passes
  `keepOnBranch(topic, t.cwd)`; its one call site updated.
- `tests/finish-keep-on-branch.test.ts` (new), `tests/gitwork-finishwork.test.ts`,
  `tests/implement-cmd.test.ts` — below.
- `package.json` / `.claude-plugin/{plugin,marketplace}.json` — 0.5.58; `dist/ap.cjs` rebuilt and
  committed.

## Testing

Fresh `AP_HOME` per test; real temp directories wherever provenance or `realpath` is asserted (the
guard is a filesystem predicate and a fake path would make it vacuous).

- `tests/finish-keep-on-branch.test.ts` — the guard itself: a provenanced worktree equal to the
  target → true; `worktree: ""` → false; a pre-0.5.36 record (field absent) → false; a record naming
  a different worktree → false; a real but non-provenanced path → false; no record and a torn record
  → false; an empty target → false; a worktree removed from disk → false; a SYMLINKED target →
  still true (canonical equality is load-bearing).
- `tests/finish-keep-on-branch.test.ts` — quick's branch-only arm: guard true → the runner receives
  NO `checkout` call at all, `finish-result.txt` is exactly
  `none\tkept-on-branch (kept feat/quick-auth)\n`, rc 0, and the stderr line names the reason;
  `worktree: ""` / no record / path mismatch / non-provenanced target → the start-branch checkout
  happens and the record reads `none\tbranch-only (kept feat/quick-auth)\n`, exactly as before.
- `tests/finish-keep-on-branch.test.ts` — stash-wip regression: marker present and the guard fires →
  the stash is NOT popped, the marker survives byte-for-byte, `stash-wip-kept` is appended to the
  record, the wrong-HEAD warning is emitted verbatim, and the hub flag reaches the forensics feed.
- `tests/gitwork-finishwork.test.ts` — `keep` + `keepOnBranch: true` → `kept-on-branch` with no
  checkout; `auto` resolving to keep with no remote, same; merge/discard/pr with the flag set still
  check the base out (the flag is read by the keep arm alone); `keep` without the flag unchanged
  (`kept`).
- `tests/implement-cmd.test.ts` — `finish keep` with a record whose provenanced worktree IS the
  target → `main\tkeep\tkept-on-branch\n` in `finish-results.tsv` and no checkout; the same shape
  with `worktree: ""` → `main\tkeep\tkept\n` and the base restored.

**Mutation evidence (run for real, all three RED):**

- m1 — weaken `keepOnBranch` to bare `existsSync(jobPath(topic))`: the `worktree: ""` and legacy
  cases go red (11 tests across the guard, quick, and implement).
- m2 — revert quick's branch-only arm to the unconditional checkout: the no-checkout assertion goes
  red.
- m3 — drop the `keepOnBranch` opt from `finishWork`'s keep arm: the gitwork keep cases and the
  implement `kept-on-branch` case go red.

**Live bundle proof** (built `dist/ap.cjs`, throwaway repo, fresh `AP_HOME`): a manufactured quick
exec state (`finish.txt=no`, branch record, `target_cwd.txt` = a real provenanced
`.ap/worktrees/<topic>` worktree) plus a job record naming that worktree → after
`node dist/ap.cjs quick finish <topic>` the worktree's HEAD is STILL the feature branch and
`finish-result.txt` reads `kept-on-branch`; the same state with `worktree: ""` → the start branch is
restored and the record reads `branch-only`.

## Success Criteria

- A detached quick or implement finish whose target is the run's own provenanced worktree leaves
  that worktree on `feat/<cmd>-<topic>` and records `kept-on-branch`.
- `--no-worktree` runs, legacy records, non-provenanced targets, mismatched paths, and every
  attached (non-detached) finish are byte-identical to 0.5.56 behavior — asserted, not assumed.
- The `--stash-wip` park is never popped on the wrong HEAD and never dropped; the kept flag reaches
  `/ap:review`.
- `npm run typecheck && npm test && npm run lint && npm run build` green; `dist/ap.cjs` committed.
