# Design/implement state-machine fixes — design

**Date:** 2026-08-14 · **Origin:** first ≥0.5.12 dogfood cycle's /ap:review (both boxes): the
walk-state false-approval fired 3× across 2 topics/2 boxes; `offset-reset` wedged a busy worker's
phase; `implement finish` silently no-op'd after a hub pre-checkout. · **Scope:** one PR (0.5.14),
four defects, one governing rule: *a layer records its own verdict; consumers read recorded
verdicts, never infer them.*

## Problem

1. **walk-state infers approval from file existence.** `walkSectionState`
   (`src/core/designWalk.ts:22-34`) reports a section `approved` iff `.draft/<section>.md` exists
   with any non-`_(skipped)_` body — and the walk's Approve step writes NOTHING. `synthesize`
   atomicWrites all six seeds, so a fresh topic reads "all approved" before any walk happened
   (field: hub skipped the user-gated walk once, hand-drafted around it twice). The Stage-10
   resume check in `commands/design.md` is vacuous by construction.
2. **synthesize's `problem` seed swallows the corpus.** The seed matcher for `problem` is
   `/^- \[/` (`src/core/designDoc.ts:26`), which matches EVERY adjudicated claim bullet
   (adjudicate renders claims as `- [<cite>] …`). Field: a 65KB problem.md beside 120-byte stubs.
   Steer-tag lines also land twice (their own section AND problem).
3. **`design offset-reset` deletes the phase state file outright** (`src/commands/design.ts:425-427`),
   destroying the `OFFSET=` line a re-armed `<phase>-wait` needs (it dies "state file missing") — so
   a `--keep-findings` reset on a BUSY worker (re-send impossible: `research-send` refuses while the
   state file exists… after deletion, sends clobber the live turn) wedges the phase until manual
   state-file surgery.
4. **`implement finish` degrades to a silent "no-branch" no-op when the hub pre-checked-out the
   feat branch.** Pre-snapshot records HEAD as the baseline (`implement.ts:251-252`); `branch`
   resumes the existing feat branch and records the same name; `finishBranchAction` then hits
   `branch === startBranch` (`src/core/gitwork.ts:194-195`) → "no-branch" for every action, and
   the hub pushes/PRs by hand. A deliberate `--no-branch` run is byte-indistinguishable on disk
   from this accident — no branch-mode record exists.

## Goal

The walk records its own per-section verdicts and walk-state only reads them; synthesize seeds
route each adjudicated line to at most one home and `problem` gets prose, not the corpus; a reset
preserves the one line recovery depends on; the branch/finish pair prevents the baseline accident,
records intent, and fails loud instead of no-op'ing.

## Architecture

**1. Explicit walk verdicts.** New verb `design walk-approve <topic> <section> <approved|skipped>`
(section validated against the six names): atomicWrites `design-doc/.walk/<section>.state`
containing the verdict word. `walkSectionState` reworks to read ONLY `.walk/*.state` markers —
a drafted-but-unmarked section is `pending` (new state, simply absent from walk-state's output,
matching the existing "only settled sections print" contract). The `_(skipped)_` body convention
stays honored at ASSEMBLE time (unchanged) but no longer implies walk state. `commands/design.md`
Stage 10: after each Approve → `$CS design walk-approve <TOPIC> <section> approved`; Skip →
`… skipped` (the Skip branch still Writes the `_(skipped)_` body as today). Stage-10's resume
check now genuinely resumes. Fast-path (Stage 2) does NOT run the walk and does not need markers
— assemble never reads them. Because the markers OUTLIVE the seeds, `synthesize` skips (and logs)
every section that already carries one: a re-entry that re-seeded an approved section would
overwrite the very draft the marker says is settled, and resume would restore nothing.

**2. Seed routing.** `synthesizeSeeds`: each adjudicated line is claimed by the FIRST matching
steer-tag section (goal/architecture/components/testing/success-criteria); `problem` receives ONLY
lines matching a real `- [Problem` steer tag — plus, when NO line carries any steer tag at all (the
common untagged corpus), problem falls back to the placeholder like every other section instead of
swallowing everything. A tag is the section word plus a TERMINATOR — `/^- \[Goal[\]:\s]/i`, and
`/^- \[Success( Criteria)?[\]:\s]/i` for the two-word one — because the bare-prefix matchers claim
ordinary citations (`- [problem.md:3]`, `- [components/Button.tsx:10]`; every adjudicated line opens
with `[`). Deliberate tolerance change: a pluralized `- [Goals]` no longer routes; `- [Goal]`,
`- [Goal:`, `- [Goal something]` still do. The `testing` "any bullet containing 'test'" heuristic
only applies to lines not already claimed by a tag. Result: no seed exceeds its tagged lines; the
65KB dump shape is impossible. (Hub guidance in design.md Stage 9 already documents steer tags; add
`[Problem]` to the documented tag list.)

**3. `offset-reset` preserves OFFSET — under `--keep-findings` only.** In that mode, instead of
`rmSync` on `<phase>-<agent>.txt`: read it, extract the LAST `OFFSET=` line (`parseLatestOffset`),
atomicWrite the file back to exactly that one line. Post-reset a re-armed wait resumes from the
original offset and re-judges the artifact that is still on disk; a re-SEND still requires removing
the state file first (unchanged, documented). The DEFAULT (full-cascade) path keeps deleting the
file: that path has just destroyed the findings and buckets a re-wait would judge, so a kept offset
would only re-derive a terminal miss (`AC=expired`/`FS=missing`) while blocking the re-send that is
the actual recovery — turning a loud recoverable state into a silent worker-drop. If the file had
no OFFSET= (never sent), delete in both modes. `.done`, `question-<agent>.txt`, strikes, and the
cascade behave exactly as today; the `[ OK ]` line names which branch ran.

**4. Branch-mode record + prevention + loud finish.**
- `implement branch` (both modes): FIRST, when not `--no-branch`, refuse **rc 1** with nothing
  written on either unrecoverable baseline pre-snapshot recorded — the feat branch it would
  create/resume ("HEAD was already <feat> at pre-snapshot; checkout the intended base branch,
  re-run pre-snapshot, then branch, or pass --no-branch if implementing on the current branch is
  intended"), or the `(detached)` sentinel ("pre-snapshot recorded a detached HEAD, which has no
  restorable start branch; checkout a branch, re-run pre-snapshot, then branch") — a detached
  baseline passes `branch !== startBranch`, so finish would report a merge into whatever HEAD was.
  Otherwise proceed and atomicWrite `$ART/branch-mode.txt`: `branch` or `no-branch`.
- `implement finish`: read `branch-mode.txt` FIRST and let it decide both directions. `no-branch`
  recorded → outcome `no-branch` before any branch is resolved (now provably deliberate, and a
  drifted `feat/` ref this run never created is never merged or deleted). Otherwise (mode `branch`,
  or file absent — pre-0.5.14 state dirs) a `(detached)` baseline, `branch === startBranch`, or a
  missing ref → outcome **`same-branch`** (new additive outcome string) with a loud warn naming the
  recovery (push/PR by hand or re-run branch from the right base); still no destructive action, and
  the run is `flag`ged into forensics so the defect class reaches `/ap:review`. `finish-results.tsv`
  gains the new outcome value; `commands/implement.md` documents the branch-time refusals (as an
  AskUserQuestion recovery) and the `same-branch` outcome, including that on a state dir with no
  `branch-mode.txt` it may be a legacy deliberate `--no-branch` run.

## Components

- `src/core/designWalk.ts` — marker-based `walkSectionState`; `.walk/` dir constant; verdict
  parse/validate.
- `src/core/design.ts` — `designWalkDir(topic)`, beside the existing `designDraftDir`.
- `src/commands/design.ts` — `walk-approve` verb (usage, rc 2 on bad args); `synthesize` skips
  marked sections; `offset-reset` OFFSET-preserving rewrite under `--keep-findings`.
- `src/core/designDoc.ts` — `synthesizeSeeds` first-match routing + `[Problem` tag + terminated tag
  matchers + untagged fallback.
- `src/commands/implement.ts` + `src/core/gitwork.ts` — branch refusals + `branch-mode.txt`;
  `same-branch` is decided in `applyFinish` (it needs `branch-mode.txt`, which core git code has no
  business reading), so `finishBranchAction`'s outcomes stay byte-stable; gitwork exports
  `hasDistinctBranch` — the short-circuit `finishBranchAction` already ran, now shared rather than
  restated at the new call site.
- `commands/design.md` (Stage 9 tag list, Stage 10 walk-approve calls + real resume, offset-reset
  note) and `commands/implement.md` (refusal + same-branch recovery).
- `tests/` — see Testing. Version bump 0.5.13 → 0.5.14 (three manifests) + rebuilt committed dist.

## Testing

- walk-state: fresh synthesize → all sections ABSENT from walk-state output (not approved);
  walk-approve approved/skipped → exactly those states; invalid section/verdict rc 2; the
  `_(skipped)_` body alone no longer reports skipped; a marked section survives a re-run of
  `synthesize` (draft byte-unchanged, marker intact) while unmarked ones are re-seeded.
- Seeds: adjudicated corpus with zero steer tags → problem.md gets the placeholder (regression pin
  on the 65KB shape); each of the six tags lands its line in exactly one section; the
  goal-tag-in-problem double-landing is gone; 'test'-heuristic only claims untagged lines; citation
  shapes (`- [problem.md:3]`, `- [components/Button.tsx:10]`) seed nothing.
- offset-reset: `--keep-findings` on a state file with OFFSET+tags+AC lines → file contains exactly
  the last OFFSET= line after reset, and a subsequent phaseWait re-arms from it (fake deps); the
  DEFAULT path deletes the state file; `.done`/question/strikes cleared; no-OFFSET file deleted in
  both modes; cascade pins unchanged.
- branch/finish: baseline==feat → branch rc 1, nothing written; a `(detached)` baseline → rc 1 too;
  `--no-branch` refuses neither; branch-mode.txt recorded both modes; finish matrix — no-branch
  recorded → `no-branch` with no git action even when a stale branch exists; mode branch +
  same-branch state → `same-branch` + warn; mode file absent (legacy) + same-branch →
  `same-branch`; detached baseline → `same-branch`; normal path byte-identical (full-sequence pins
  where they exist today).
- Full suite green; no assertion weakened; frozen wire protocol untouched (state filenames new
  additions only: `.walk/<section>.state`, `branch-mode.txt` — both NEW names, not renames).

## Success Criteria

- A fresh design topic's walk-state shows nothing settled until the walk actually runs; resume
  after interruption skips exactly the approved/skipped sections, with their drafts intact.
- An untagged adjudication produces six balanced seeds; no corpus dump.
- A `--keep-findings` reset mid-busy-worker leaves a re-armable wait; a full-cascade reset leaves
  the phase re-sendable.
- The pre-checkout and detached-HEAD accidents are refused at branch time; if legacy state reaches
  finish anyway it fails loud as `same-branch` (and is flagged for review), while a deliberate
  `--no-branch` run stays clean and touches no branch it did not create.
- Gate green, dist rebuilt+committed, E2E walk/reset/finish exercised through the real CLI before
  merge.
