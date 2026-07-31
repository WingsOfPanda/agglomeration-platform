# Phase-table refactor — explore/design send/wait/gate skeleton extraction

**Date:** 2026-07-31 · **Type:** zero-behavior-change refactor (no new features, no wire changes)
· **Origin:** 2026-07-31 whole-repo /simplify sweep — all four reviewers (reuse, simplification,
efficiency, altitude) independently converged on this as the repo's largest structural debt.

## Problem

`/ap:explore` grew its seven worker phases (research, openq, crossverify, adversary, rebuttal,
gap, signoff) by copying one send/wait skeleton seven times (design.ts carries two more copies).
A phase is data — a handful of slot values — but it is encoded as ~50 lines of code per phase:

- Nine `*WaitWith` bodies are byte-identical except five slots (state-file prefix, gate key,
  `consultTimeout` key, artifact path, `researchState` vs `verifyState`).
- The 6-line send-dispatch tail (`OFFSET=` capture → `atomicWrite` → `d.send` → rc-check with the
  "state file kept, rm to redo" contract) appears nine times.
- The dispatch-safety guard chain is hand-inlined six times, in TWO deliberately-preserved
  encodings (ternary "any prior phase unsafe" at openq/crossverify/adversary; walk "latest
  non-skipped phase unsafe" at rebuttal/gap/signoff). The 0.5.5 VS-gap bug was a missed slot in
  one hand-written copy.
- The phase list itself is restated in ~7 places (usage string, dispatch switch, `KEYS` map, two
  error strings, the `"FS"|"VS"|...` type union written twice in designTurn.ts, contracts.ts).
- `wait-gate` verb bodies are duplicated whole between explore.ts and design.ts.
- 18 three-positional arg-parse wrappers differ only in the verb name.

Every wait-protocol change (e.g. the 0.5.5 liveness extension) must be applied up to nine times.

## Goal

One phase = one table row. The skeletons live once in core; each verb becomes a thin wrapper.
Behavior is byte-for-byte identical: same files written, same log lines, same rc values, same
guard semantics per site (the two guard encodings are preserved as two named predicates — their
unification would be a behavior change and is explicitly out of scope, needing its own spec).
Frozen wire surface untouched.

## Architecture

New `src/core/phaseTable.ts` (name avoids all banned tokens):

- `PhaseKey` — the `"FS"|"QS"|"VS"|"AS"|"RS"|"GS"|"SS"` union declared ONCE; designTurn.ts's two
  signatures import it.
- `PHASES` — ordered rows `{ phase, key, statePrefix, timeoutKind, artifactFor(art, agent,
  provider, topic), stateFn, skippable, guard }` with slot values derived from the CURRENT
  source (notably: crossverify's `timeoutKind` is `"verify"`, not `"crossverify"`; research uses
  `researchState`, all later phases `verifyState`; the two research waits have NO
  `<KEY>=skipped` fast-path — `skippable` is a real slot; design's artifact paths need
  provider+topic for `workerDir`).
- Guard predicates: `anyPriorUnsafe(art, agent, keys)` (ternary encoding, exact current
  semantics) and `latestNonSkippedUnsafe(art, agent, keys)` (walk encoding). Each phase row
  names its predicate + chain + warn-noun (source has three nouns: "research" / "previous
  phase" / "latest phase"). Chains are stored EXPLICITLY per row — implementation found they
  are NOT derivable from table order: crossverify checks earliest-first (FS, QS) while
  adversary checks latest-first (VS, QS, FS), and order is load-bearing for which `KEY=value`
  the skip warning names. The table-driven test asserts SET-completeness (every earlier
  phase's key present), not ordering. One knowing divergence, adversarially verified
  pipeline-unreachable: `anyPriorUnsafe` short-circuits its state-file reads where the old
  ternaries read every chain file eagerly — identical for all readable files, but an UNREADABLE
  state file (EISDIR/EACCES; never produced by ap, which writes only regular files) crashed the
  old code where the extraction now skips gracefully. Strictly more forgiving; accepted.
- `dispatchPrompt(d, opts)` — the shared 9-site send tail.
- `phaseWait(row, topic, agent, provider, d)` — the shared 9-site wait body (skipped fast-path,
  `parseLatestOffset`, `scaledTimeout`, `d.wait`, state classify, `recordWaitOutcome`, `.done`
  marker, `log.ok`).
- `waitGateVerb(label, art, phase→key map)` — shared by explore's and design's `wait-gate`.
- Shared `SendDeps`/`WaitDeps` types + live implementations exported once (currently duplicated
  object literals in explore.ts and design.ts).
- `triad(usageLabel, fn, deps)` — the 18-site three-positional arg-parse wrapper.

explore.ts and design.ts keep their public verb surface and per-phase prompt composers
(composers stay where they are — each sits with its parser by design). Riders in the same PR,
each pure motion: `core/design.ts` roster split (`ListRow`/`formatListFile`/`parseListFile`/
`parsePanesFile`/`spawnAllBatch`/`lastTag`/`verifyScopeFiles` → `core/roster.ts`, import-path
change only, `core/design.ts` re-exports removed after imports are updated); autoresearch
finalize mechanism (~230 lines of helpers + the `finalizeWith` orchestrator split) moves from
`commands/autoresearch.ts` into `core/autoresearchFinalize.ts` (the DI seam already exists);
explore's four stranded pure helpers (`finalLandscapePath`, `sectionText`,
`missingListArtifacts`, `soloTokensFromAnnotations`) move to `core/explore*.ts` per explore.ts's
own header convention.

## Components

- `src/core/phaseTable.ts` — NEW: PhaseKey, PHASES, guard predicates, dispatchPrompt, phaseWait,
  waitGateVerb, triad, shared deps types + live impls.
- `src/commands/explore.ts` — verbs become table-driven wrappers; ~350 lines removed.
- `src/commands/design.ts` — research/verify send+wait + wait-gate ride the same helpers.
- `src/core/designTurn.ts` — imports PhaseKey; gate signatures unchanged otherwise.
- `src/core/roster.ts` — NEW (pure motion from core/design.ts).
- `src/core/autoresearchFinalize.ts` — receives the finalize mechanism (pure motion + split).
- `src/commands/autoresearch.ts` — finalize orchestration slims to calls into core.
- `tests/helpers/phaseDeps.ts` — NEW: sendDeps/waitDeps override factories (pattern from
  implement-turn-cmd.test.ts) replacing ~88 inline stub literals.
- `tests/explore-cmd.test.ts` — after extraction: one table-driven skeleton suite + thin
  per-phase config assertions + one chain-completeness invariant test (for every phase, its
  guard chain contains every earlier phase's key, latest first).

## Testing

- The full existing suite must pass UNCHANGED before any test restructuring lands (extraction
  first, collapse second — the 42 skeleton tests are the only pin on the seven copies during
  the move).
- New: chain SET-completeness invariant (not order — see Architecture); PHASES-table shape
  assertions (timeoutKind spot checks incl. crossverify→"verify"; skippable=false for both
  research rows); guard-predicate unit tests pinning BOTH encodings' semantics, including the
  pipeline-unreachable input (`VS=ok, QS=timeout`) where they deliberately differ.
- Gate: typecheck, lint, full vitest, fresh dist build committed.

## Success Criteria

- `npm test` green with zero changes to any non-explore/design/autoresearch test expectations.
- explore.ts shrinks by ≥300 lines; no `*WaitWith` body remains duplicated; the guard chain is
  written in exactly one place per encoding.
- Adding a hypothetical phase #8 = one PHASES row + one composer + one dispatch case (asserted
  by the table-driven tests exercising the row generically).
- Frozen tokens untouched (stale-tokens gate + grep audit of the frozen list).
- Adversarial diff review finds no behavioral divergence.
