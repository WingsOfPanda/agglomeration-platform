# Brief path correctness (PR C)

Date: 2026-08-23. Sources: `/ap:review` forensics clusters F1 (5 runs) and F5 (verified against the
field design doc).

## Problem

**F1 — hub briefs are written from memory.** Across five runs in one review window, every brief
defect was a path never stat'd or a number never measured: a "new tool" named without a stat (the
worker replaced the script that is the cited producer of committed evidence); `_quick/topic-text.txt`
cited RELATIVE into a worktree-targeted run, where the worker's cwd makes it unresolvable; a
protected record named at a path that does not exist, in TWO CONSECUTIVE briefs; a predicted delta
`158->154` that measured `158->159`; and an acceptance pair ("pytest green" + "record byte-identical")
that was unsatisfiable. Nine of nine worker question events in the window trace to brief defects or
genuine operator gates — none to worker confusion.

**F5 — Testing-section paths.** The first 0.5.44 field run reported `OOS_COUNT=2`
(`tests/spec/test_tasks.py`, `tests/training/test_d12_losses.py`) against `TESTING_DECLARED=10`.
Reading the actual doc settles the cause: those two files are **never named anywhere** in the
design. Their bullets read "MAP TaskSpec construction rules (channels>=1; … paired rejection tests)"
and "loss-contract gate enrollment" — prose with no path token at all, while the ten that DID parse
were written `` (`tests/model/test_d19_temporal_graph.py`) ``. So the parser was right and the
authoring was incomplete. `pathTokensFrom` (`src/core/implementScope.ts:53-61`) already strips
backticks and trims a leading `(` and a trailing `):`, which is why the parenthesized ones parsed —
the earlier "prose-with-backticks" hypothesis is refuted.

## Goal

A brief or design doc cannot quietly cite a path that is not there: paths are stat'd before they are
cited and written absolute, numbers arrive with the command that produced them, files to be created
are labelled as such — and where prose alone has already failed, a verb warn-lints and records its
own verdict.

## Architecture

**C1 — citation rule (F1), directive prose.** `commands/quick.md` Stage 0 step 3 (the brief Write,
`:118-132`) and `commands/implement.md` Stage 3 (the fix bundle, `:385-397`) gain the same rule:
every path named must have been stat'd this session and written ABSOLUTE — state-dir paths
especially, because the state dir is keyed to the repo ROOT and never travels with `--target`;
every number must be pasted with the command that produced it, or expressed as a command for the
worker to run, never as a prediction; anything the run is meant to CREATE is labelled
`(new — does not exist yet)`. The existing `## Touch-point hints` heading becomes
`## Touch-points`, one entry per line as `<abs path> (exists|new)`.

Prose is the right instrument for C1 and it has not been tried: `grep` over both directives finds no
citation discipline at all today. C2 makes compliance measurable so the next review can score it.

**C2 — `quick branch` brief lint (F1), code.** `branchWith` (`src/commands/quick.ts:161-190`), AFTER
the `target_cwd.txt` write at `:173` so a `not-git` abort records nothing, reads
`<art>/task-brief.md` and warns on two classes:

1. **invisible** — a cited path that exists in the origin checkout and is missing in the target,
   reusing `pathsInvisibleInTarget` from PR A rather than growing a second variant. The differential
   is what keeps the warn channel worth reading (a plain missing-path lint fires on every file the
   brief intends to create).
2. **state-relative** — a RELATIVE path pointing into the state namespace (`_quick/`, `_implement/`,
   `.ap/`). Unconditional: it is never correct, it is exactly the `_quick/topic-text.txt` failure,
   and it fires one forensics flag via `runFlag` (`src/core/forensics.ts:256`) so `/ap:review` can
   trend it.

Both classes are written to `<exec>/brief-lint.txt` — the layer records its own verdict. **rc is
unchanged** (rc 1 stays reserved for not-a-git-repo, `quick.ts:177`); the brief is never rewritten.
`pathTokensFrom` is **exported from `src/core/implementScope.ts`** and imported — no new module is
minted to relocate one private function.

**C3 — Testing bullets lead with the path (F5).** `commands/design.md:92` gives `.draft/testing.md`
the same path-lead rule `.draft/components.md` already carries at `:86-91`: lead each bullet with
the file path so `implement`'s scope-check can read it, and a bullet naming only a behavior with no
path contributes nothing to scope. Paired with a measurement: `implement audit`
(`src/commands/implement.ts:91-105`) warns `<n> of <m> Testing bullets declare no path` when the
count is non-zero, so the gap is visible at audit time — BEFORE the worker runs — rather than as an
OOS surprise at Stage 4.

A per-bullet count is the right signal, not a zero-section warn: the field doc parsed 10 paths, so a
"section parsed zero" check would not have fired.

**The bullet must name a FILE-SHAPED token** (an extension, or an explicit trailing-`/` directory),
not merely a slash-bearing one. This was corrected during implementation after measuring the counter
against the VERBATIM field section rather than a reconstruction: with a plain path-token test the
section scores 6 with / 1 without, and the very bullet that omitted `tests/spec/test_tasks.py`
scores as HAVING a path — because `Spec/metrics`, `value_range/aux_shape` and `elif/raise` are
slash-bearing PROSE. A counter blind to the case it was built for is decoration. Requiring a
file-shaped token scores the same section 3 with / 4 without, which is the honest reading, and the
verbatim bullets are pinned as a test so the vacuous version cannot come back.

**Deferred, needs its own spec.** The same measurement exposed that `extractTestingPaths` — which
feeds the SCOPE VERDICT, not just this counter — also admits those prose fragments: the field run's
`TESTING_DECLARED=10` included `Spec/metrics`, `value_range/aux_shape`, `elif/raise`, `loss/grad`
and `D15/D16/D17`. It is harmless to the verdict (a fragment matches no diff path, and every Testing
rule STRICTLY WIDENS in-scope) but it makes `TESTING_DECLARED=` useless as evidence. Narrowing the
verdict's own heuristic would turn passing scope-checks into failing ones, so it is deliberately NOT
done here. `TESTING_DECLARED=` at scope-check
(`src/commands/implement.ts:386`) already reports the total, but only after the run.

**C4 — decoration (independent).** `pathTokensFrom` also strips paired `**`/`*`/`_` emphasis
wrappers and `[label](target)` links before the path heuristic, so `` **`tests/a.test.ts`** ``
yields `tests/a.test.ts` instead of the unmatchable `**tests/a.test.ts**`. This is a real gap
(neither trim regex touches `*` or `_`) but it is **not** F5's cause and is not credited with
closing it; it is widening-only, so no scope-check that passes today can start failing.

## Rejected (do not re-raise)

- Relaxing `^## Testing$` to a prefix match: ap's assembler always emits the exact heading
  (`src/core/designDoc.ts:35-37`) and every shipped spec uses it verbatim; the field failure was
  inside a correctly-headed section.
- Existence-linting `## Testing` paths the way Components are linted: a Testing section legitimately
  names files the run is about to create, so it would be mostly false positives and would train the
  hub to ignore the warn channel C2 depends on.
- A code check for the from-memory NUMBERS class: ap cannot verify a claimed measurement without
  re-running the operator's command. The durable fix is the evidence lane (PR B).
- Making any of these change an rc: `implement audit` rc 1 already means audit-FAIL and drives an
  AskUserQuestion; `quick branch` rc 1 means not-a-git-repo. All lints here are warn + record.

## Components

- `src/core/implementScope.ts` — export `pathTokensFrom`; strip emphasis/link decoration in it; new
  `testingBulletsWithoutPaths(docText): {withPath: number; withoutPath: number}`.
- `src/commands/quick.ts` — `branchWith`: the two-class brief lint, `<exec>/brief-lint.txt`, and one
  `runFlag` for the state-relative class only.
- `src/commands/implement.ts` — `auditRun`: the Testing-bullet count warn.
- `commands/quick.md` — Stage 0 step 3: the citation rule; `## Touch-points <abs> (exists|new)`.
- `commands/implement.md` — Stage 3: the citation rule for fix bundles.
- `commands/design.md` — `:92`: the Testing path-lead rule.
- `tests/implement-scope.test.ts`, `tests/quick-cmd.test.ts`, `tests/implement-init.test.ts`.
- `dist/ap.cjs` — rebuilt and committed.

## Testing

- `tests/implement-scope.test.ts` — `extractTestingPaths` on `` - Extend **`tests/a.test.ts`** ``
  returns `tests/a.test.ts`; same for `- see [tests/a.test.ts](tests/a.test.ts)` and
  `- _tests/a.test.ts_`. NON-REGRESSION: `_quick/topic-text.txt` (leading underscore, unpaired) is
  still returned intact, and a bare `snake_case_name.py` is unchanged. Mutation: drop the emphasis
  strip -> the bold case goes red; make the strip unpaired -> the `_quick/` case goes red.
- `tests/implement-scope.test.ts` — `testingBulletsWithoutPaths` on the reconstructed field section
  (10 bullets with paths, 2 prose-only) returns `{withPath:10, withoutPath:2}`. Mutation: count
  bullets instead of path-bearing lines -> red.
- `tests/quick-cmd.test.ts` (freshHome + a temp git repo as target) — a brief citing
  `_quick/topic-text.txt` and a main-only path: `branchWith` returns 0, stderr carries both warns,
  `<exec>/brief-lint.txt` lists both, and EXACTLY ONE forensics flag was written (the state-relative
  one). Mutations: drop the lint call -> warns and file absent -> red; flag both classes -> the
  exactly-one assertion goes red; run the lint before the `target_cwd.txt` write -> the not-git
  abort case records a file -> red.
- `tests/implement-init.test.ts` — `audit` of a doc whose Testing section has 2 path-bearing and 1
  prose-only bullet warns `1 of 3`; a doc where every bullet carries a path emits no such warn; rc
  is 0 in both. Mutation: warn unconditionally -> the all-paths case goes red.

## Success Criteria

- A design doc whose Testing bullets are prose is flagged at `implement audit`, before a worker is
  spawned, instead of surfacing as `OOS_COUNT` at Stage 4.
- A brief citing a relative state-dir path warns, records, and files exactly one forensics flag.
- `npm run typecheck && npm test && npm run lint && npm run build` green; `dist/ap.cjs` committed.
- No scope-check that passes today changes verdict (C4 is widening-only) — assert on an existing
  fixture doc.
