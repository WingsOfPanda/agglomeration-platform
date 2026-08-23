# Verdict honesty (PR B)

Date: 2026-08-23. Sources: `/ap:review` forensics clusters F2 (5 runs, both boxes) and F3 (4 runs).

## Problem

**The `PARTIAL` hole (F3).** `composeRound1Prompt` (`src/core/implementTurn.ts:105`) and
`composeFixPrompt` (`:165`) both require the worker's report to start with
`VERDICT: PASS|PARTIAL|FAIL`. `grep -rn PARTIAL commands/` returns **nothing**: Stage 2 Step B
(`commands/implement.md:375-383`) branches on `VERDICT: PASS` or `VERDICT: FAIL` only. An honest
worker PARTIAL therefore reaches a hub with no branch for it and is consumed as not-FAIL — i.e. as
PASS. That is exactly the observed failure: a D5 staged-count pin went red on the box (531->542)
while the worker's default leg was green because the pin only runs with `IRIS_DEV_FULL` set, and
the hub's own first verify skipped it too. A layer inferred another layer's verdict.

The environment asymmetry that produces skipped legs is the reverse of the obvious guess and is
worth stating once, correctly: the worker's pane is `bash -ic 'exec <binary>'`
(`src/core/tmux.ts:167`), so `~/.bashrc` IS sourced and only `~/.profile` is not; the HUB's re-run is
`bash -c` (`src/core/implementVerifyTests.ts:87-93`) and sources NOTHING. A var exported at login or
set non-exported in `.bashrc` is present for the worker and absent for the hub. On top of that a
fresh `.ap/worktrees/<topic>` carries no build products at all.

**Hand-edited evidence records (F2).** Five runs in the window shipped a gate or record that a green
suite could not see through: a union guard that stayed green when reverted; a false disclosure
flagged by the worker and shipped anyway (it read a byte-identity guard on PRE-EXISTING evidence as
binding a record it had just generated itself); a gate that mirrored its builder, with two conjuncts
conditionally vacuous on a catalog-less box; 285 green tests hiding a routing hole; and — the sharp
one — a round-2 fix that HAND-EDITED a committed GPU measurement record because the hub's fix prompt
said "do NOT re-run". `grep` over `commands/*.md` and both turn composers finds no
regenerate-vs-edit rule anywhere, so these came from its ABSENCE, not from prose failing. The
identical-shape precedent already exists at `commands/implement.md:108` ("never edit
`$ART/provider.txt` by hand").

## Goal

A worker cannot report green for a suite it did not fully run, a hub cannot promote an honest
PARTIAL to PASS without doing the missing work itself, no fix bullet can tell a worker to edit a
generated record, and a gate the run adds is evidence only once someone has watched it go red.

## Architecture

**B1 — close the PARTIAL hole.** Both composers gain, directly under the existing verdict-line
requirement:

- line 2 of the report MUST be
  `ENV: shell=<as observed>; suite=<cmd>; legs=<ran … / skipped … + why>; build=<generated or native artifacts present, or rebuilt by you>`;
- if ANY leg was skipped for an environment reason, the verdict is **PARTIAL** — a green default leg
  is not PASS.

`commands/implement.md` Stage 2 Step B gains a `VERDICT: PARTIAL` branch: the hub copies the
worker's `ENV:` line and skipped-leg names verbatim into `cross-verify-<ROUND>.md`, and may reach
PASS only by running those legs ITSELF and recording that IT ran them; otherwise it takes the
operator gate (AskUserQuestion attached / PARK detached, per the Run-path table). One sentence names
the shell asymmetry above, so the existing judgment call at `:338-340` has the fact in front of it.
`commands/quick.md` Stage 2's `VERIFY` value gains the `PARTIAL (<cmd>) — legs skipped: <names>`
form; `verify-result.txt` is free-form and only interpolated into a PR body
(`src/commands/quick.ts:344-349`, `src/commands/bridge.ts:234-238`), so this is safe.

**MIRRORED-GATE GUARD (mandatory).** The contract test may export a `WORKER_VERDICTS` const, but the
composers must NOT build their verdict line from it. If the composer emits
`VERDICT: ${WORKER_VERDICTS.join("|")}`, deleting `PARTIAL` from the const mutates both sides at
once and the assertion stays green — the exact failure class this PR exists to close. The composers
keep their literal string; the test asserts the literal.

**B2 — regenerate, never edit.** `commands/implement.md` Stage 3 (the fix-bundle template) and
`commands/quick.md` Stage 2 step 3 state: a bullet about a generated record names the PRODUCER
COMMAND and says regenerate — never "edit"/"update" it, and never "do NOT re-run"; if re-running
genuinely must be skipped, the bullet says so AND downgrades the round's claim rather than
authorizing a touch of the record; and a byte-identical/unchanged-record guard may only cite
evidence that existed before `branch-base.sha`. The third rule is plain prose (its compliance is not
observable by a test, so it is not paid for with one).

The same rule goes into `composeFixPrompt`'s ROUTING block
(`src/core/implementTurn.ts:143-155`) so it reaches the worker even when the hub's bullet is
careless: "Never hand-edit a committed evidence/measurement record to satisfy an issue; re-run its
producer and commit the regenerated record, or halt with a question event."

**B3 — mutation evidence, and the mirrored half.** Both composers: "For every test or gate you ADD,
write `MUTATION: <file:line> <the change you made to break it> -> <observed failure>`. A gate you
never watched fail is not evidence. A gate must assert a SPEC-derived expectation — a literal, or an
independently recomputed value — never the implementation's own output read back at itself."

The second sentence is not redundant with the first: a mirrored gate survives a mutation check
trivially, because mutating the implementation moves the assertion with it. That is how the
`build-selections` run shipped two conditionally-vacuous conjuncts through a green suite.

`commands/implement.md` Stage 2 Step B — which already reads `git diff --stat` and takes up to 3
spot-checks — checks new test/gate hunks against the report's `MUTATION:` lines, writes a `[bug]`
for any gate without one instead of counting it as evidence, and records `NEW_GATES=<n>
MUTATION_LINES=<n>` in `cross-verify-<ROUND>.md` so `/ap:review` can trend the ratio across the next
window rather than re-deriving it by reading reports.

## Rejected (do not re-raise)

- Classifying rc 126/127 as `unverifiable` in `classifyTestRun`: mechanically clean and conservative,
  but **unobserved** in this window — the F3 failures were rc-0 skipped legs and a pytest
  `ModuleNotFoundError`, not `command not found`. Two lines if it ever appears in a forensics record.
- Changing the hub's verify shell to `bash -lc`/`-ic` to match the worker: it changes every hub
  re-run on every box, its correctness depends on operator rc files no unit test can hold, and `-i`
  without a tty adds job-control noise into the captured log. The `ENV:` line surfaces the same
  asymmetry without taking the risk.
- A parser for `verify-report-<ROUND>.md` that checks compliance with B1/B2/B3 mechanically: nothing
  parses that file today (it is handed to the worker as a path and read by the hub as prose), so this
  is a new parser plus a new verdict surface — its own spec, and only if prose is observed to fail.

## Components

- `src/core/implementTurn.ts` — `composeRound1Prompt` PHASE 3 and `composeFixPrompt`: the `ENV:`
  line, the skipped-leg⇒PARTIAL rule, the `MUTATION:` requirement + the spec-derived-expectation
  sentence; `composeFixPrompt` ROUTING: the regenerate-never-edit clause.
- `commands/implement.md` — Stage 2 Step B: the PARTIAL branch, the shell-asymmetry sentence, the
  MUTATION cross-check and the `NEW_GATES=`/`MUTATION_LINES=` record; Stage 3: the
  regenerate-never-edit rules.
- `commands/quick.md` — Stage 2: the `PARTIAL (…)` VERIFY form; step 3: the regenerate rule.
- `tests/implement-turn.test.ts` — composer assertions; a directive-contract test in the style of
  `tests/implement-verify-tests.test.ts:263-270` (which already reads `commands/implement.md`).
- `dist/ap.cjs` — rebuilt and committed.

## Testing

- `tests/implement-turn.test.ts` — `composeRound1Prompt` and `composeFixPrompt` each contain the
  `ENV:` requirement, the skipped-leg⇒PARTIAL sentence, and the `MUTATION:` requirement. Mutation:
  delete any one line from either composer -> red.
- `tests/implement-turn.test.ts` — `composeFixPrompt` contains the regenerate-never-edit clause.
  Mutation: delete it from the ROUTING array -> red.
- `tests/implement-turn.test.ts` — MIRRORED-GATE GUARD: the composers' verdict line is the literal
  `VERDICT: PASS|PARTIAL|FAIL`, asserted as a literal string, and `grep` proves no composer
  interpolates `WORKER_VERDICTS` into it. Mutation: rewrite the composer to build the line from the
  const, then delete `PARTIAL` from the const -> this test must go RED (if it stays green the guard
  is not doing its job).
- `tests/implement-turn.test.ts` (directive contract) — `commands/implement.md` Stage 2 Step B
  contains a `VERDICT: PARTIAL` branch and the string `MUTATION:`; Stage 3 contains the regenerate
  rule. Mutations: delete each sentence from the markdown -> red.
- Non-regression: `TEST_VERDICTS` and every existing Stage 2 branch string are untouched, so
  `tests/implement-verify-tests.test.ts` stays green unchanged.

## Success Criteria

- A worker that skips an env-gated leg reports PARTIAL, and the hub cannot record PASS without
  either running that leg itself (and saying so) or taking the operator gate.
- No fix bundle in a subsequent run tells a worker to edit or not re-run a generated record.
- `cross-verify-<ROUND>.md` carries `NEW_GATES=`/`MUTATION_LINES=`, making the next `/ap:review`
  able to score compliance instead of re-reading reports.
- `npm run typecheck && npm test && npm run lint && npm run build` green; `dist/ap.cjs` committed.
