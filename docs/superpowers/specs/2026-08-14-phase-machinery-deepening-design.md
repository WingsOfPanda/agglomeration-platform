# Phase machinery deepening — surveyPhaseArtifacts + phaseSend + rowFor — design

**Date:** 2026-08-14 · **Origin:** the four-walk architecture review (walk 1, candidates 1/2/3),
Wave A PR-2 of the deepening program agreed by grilling. · **Scope:** one PR (0.5.19),
byte-identical throughout — no behavior changes, no on-disk format changes, no log-line changes,
no rc changes. This finishes what the PHASES table started: the wait half and the send TAIL
landed earlier; the send HEAD, the backstop CONSUMPTION, and the phase→key MAP restatements are
still hand-copied.

## Problem

Three families of restatement in `src/commands/explore.ts` / `src/commands/design.ts`, all of
data `src/core/phaseTable.ts` rows already own:

1. **Backstop consumption ×9.** `artifactBackstop` (artifact.ts:234) is deep, but nine validator
   sites (explore openq-collate :203, diff :272, rebuttal-send :347, survivors :486,
   synth-preliminary :533, synth-final :690, verdict-tally :730; design diff :230, adjudicate
   :307) each hand-derive the state-file path and artifact path the row already carries
   (`PhaseRow.phase` → `<phase>-<agent>.txt`, `PhaseRow.artifactFor`), assemble the same 8-field
   opts object, and re-fan the three verdicts. The three-verdict rule is pinned once per verb in
   tests/artifact-completeness.test.ts:342-812 with a private fixture each.
2. **Send head ×9.** Every send verb opens with art dir → stateFile literal → existsSync →
   log.error → return 1 (two wording families: "exists; rm to retry" ×7, the one-turn-cap
   wordings on rebuttal/signoff — note the exact cap wording DIFFERS between those two, so it is
   a per-row string, not a boolean), six repeat the byte-identical `guardSkipped(ROW, …,
   guardLive(topic, provider, d))` line, and all nine close with `${agent}_<phase>_prompt.md` +
   atomicWrite + dispatchPrompt. guardLive's own docstring records the smell: "every send site
   built the same literal by hand".
3. **Map restatements ×4 + shallow wrappers ×9.** explore.ts:662-664 KEYS literal restates the
   phase/key pairs of PHASES byte-for-byte; design.ts:378-379 and :445 restate DESIGN_PHASES'
   pairs as validation strings + a ternary; nine exported `*WaitWith` wrappers have the sole body
   `return phaseWait(ROW, …)` plus a switch case each. Adding an explore phase today touches six
   places; only the row is type-checked.

## Goal

The row becomes the only statement of the phase map. One collector owns backstop consumption,
one `phaseSend` owns the send skeleton, one `rowFor` lookup feeds the wait-gate/offset-reset
verbs and drives the `-wait` dispatch off the tables. Every log line, state-file byte, rc,
usage string, stdout line, and guard/probe ORDER is byte-identical — proven by the existing test
suites passing unedited plus mutation checks.

## Architecture

### Part 1 — `surveyPhaseArtifacts` (backstop consumption, phaseTable.ts)

One row-driven collector beside the skeletons (phaseTable already imports artifact.ts — no
cycle):

```ts
surveyPhaseArtifacts(row: PhaseRow, agents: string[], ctx: {
  topic: string; art: string; label: string;
  emptyIsComplete: boolean;   // openq-collate / verdict-tally / design adjudicate short-circuit
                              // `text.trim() ? backstop : "complete"`; diff / design diff do not
  skipTag?: boolean;          // rebuttal-send: lastTag(stateText, row.key) === "skipped" → omit
}) → Array<{ agent: string; text: string; verdict: "complete" | "drop" | "still-writing" }>
```

It owns: the state-file path (`<row.phase>-<agent>.txt`), the artifact path
(`row.artifactFor`), the 8-field backstop opts, and the two slot behaviors. Callers keep ONLY
their fan-out, which genuinely differs per site (openq-collate: `parseOpenQuestions(drop ? "" :
text)` + rc-1 on still-writing; diff: bucket drop as ""; rebuttal: push only `complete`
critiques; survivors/synth/verdict-tally/design sites per their current shapes). The still-
writing refusal decision (return 1 from the verb) stays at the caller — the collector reports,
the verb refuses — matching "a layer records its own verdict".

IMPLEMENTER: before editing, enumerate all nine sites and derive each one's slot values FROM THE
CURRENT CODE (the list above is the review's map, the code is the truth); any site that does not
fit the two slots exactly is a STOP-and-report, not a third slot invented silently. Rebuttal's
empty-text `continue` (explore.ts:345) happens BEFORE the backstop today — preserve that exact
order (it is `emptyIsComplete`-adjacent but distinct: empty critiques are omitted entirely, not
marked complete).

### Part 2 — `phaseSend` (the send head, phaseTable.ts)

```ts
phaseSend(row: PhaseRow, ctx: { topic: string; agent: string; provider: string }, d: SendDeps,
  hooks: {
    preGuard?(io): Promise<{ skip: string } | null>;   // gap-send ONLY: trigger check precedes guard
    prepare(io): Promise<{ prompt: string } | { skip: string } | { fail: number }>;
  }) → Promise<number>
```

where `io = { art, stateFile, artifact, promptFile }` (all row-derived). phaseSend owns, in
today's exact order: art dir; stateFile; the exists-precondition with the row's `retryNote`
wording (new PhaseRow slot: the exact tail after `${stateFile} ` — "exists; rm to retry" for
seven rows, the two distinct one-turn-cap sentences for rebuttal/signoff); `preGuard` when
supplied; `guardSkipped(row, …, guardLive(...))` for rows WITH a guard (row.guard presence
already decides — no new flag); `prepare` (each verb's real preconditions, side-effect writes
like crossverify's claims file, and its composer — fail rc and skip reasons byte-identical);
promptFile write; `dispatchPrompt` tail. `skip` routes through `skipDispatch` exactly as today.

gap-send is the ONE phase whose trigger check precedes its guard (explore.ts:378-383) — that
order is load-bearing (both paths write `GS=skipped` but log different text, and the guard's
evidence probe must not fire for an untriggered round); `preGuard` preserves it explicitly.

The nine `*SendWith` exports remain as thin bindings (each = its hooks + one phaseSend call) so
the run() switch and tests keep their names; their bodies shrink to the genuinely per-verb part.

### Part 3 — `rowFor` + table-driven wait dispatch

- `rowFor(cmd: "explore" | "design", stem: string): PhaseRow | null` in phaseTable.ts.
- `waitGateVerb` takes the ROW instead of separate `phase`+`key` (phaseTable.ts:432 currently
  un-pairs what the row pairs); both wait-gate verbs and design's offset-reset resolve through
  `rowFor`, deleting explore's KEYS literal (explore.ts:662-664) and design's two validation
  pairs (design.ts:378-379, :445). Unknown-stem error wording byte-identical.
- The nine `*WaitWith` wrappers are deleted; the `-wait` half of both run() switches iterates
  PHASES/DESIGN_PHASES (`triad(`${row.cmd} ${row.phase}-wait`, bound phaseWait, liveWaitDeps)`),
  generating the same usage strings. The `-send` half stays explicit (bodies are per-verb).
  Tests that imported `*WaitWith` names switch to `phaseWait` + the row.

## Components

- `src/core/phaseTable.ts` — surveyPhaseArtifacts, phaseSend, rowFor, retryNote row slot,
  waitGateVerb row signature.
- `src/commands/explore.ts` — nine send verbs via phaseSend; seven backstop sites via the
  collector; wait wrappers deleted; switch -wait half table-driven; KEYS literal deleted.
- `src/commands/design.ts` — two send verbs, two backstop sites, wait-gate + offset-reset via
  rowFor, wait wrappers deleted.
- `tests/` — see Testing. Version 0.5.18 → 0.5.19 (three manifests) + rebuilt committed dist.

## Testing

- ALL existing suites pass; the ONLY permitted edits are import-path/name updates for the
  deleted wait wrappers — zero assertion edits anywhere (state files, logs, rc, stdout are the
  pins; tests/explore-cmd.test.ts, tests/liveness-guards.test.ts, tests/artifact-completeness.
  test.ts pin the current behavior).
- New table-driven collector suite: rows × {no-AC / expired / quiescent / empty×slot / skipTag}
  once, replacing per-verb duplication ONLY where the old blocks assert the collapsed rule; each
  verb keeps a thin test of its own fan-out.
- New phaseSend suite: exists-refusal wording per row (pin both cap wordings), guard-called-
  for-guarded-rows (mutation: dropping the guard call must fail), preGuard-before-guard for gap
  (mutation: reordering must fail), prompt-file naming, dispatch tail.
- Structural pin: every `-send`/`-wait` verb in both switches resolves to a table row and vice
  versa (a new PHASES row without a switch entry, or the reverse, fails).
- Mutation rule (grilling Q10): per call site, re-inlining the old head/consumption must fail at
  least one test.
- Full gate green; dist rebuilt and committed.

## Success Criteria

- Adding a hypothetical explore phase = one PHASES row + one -send body (demonstrated in a test
  via a synthetic row, not shipped).
- Nine send heads, nine backstop stacks, one KEYS literal, two validation pairs, nine wrappers:
  all gone; `grep -n 'research-\${' src/commands` style hand-derivations of phase paths return
  nothing the row does not own.
- Gate green; dist rebuilt+committed; 0.5.19; all pre-existing assertions untouched.
