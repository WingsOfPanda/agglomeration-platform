# Autoresearch validity shell — one IO home for the verify/inspect verbs — design

**Date:** 2026-08-14 · **Origin:** the four-walk architecture review (walk 2, candidate 2), Wave A
PR-4 of the deepening program agreed by grilling. · **Scope:** one PR (0.5.21), two commits,
byte-identical throughout — every file write (verification.tsv / inspection.tsv / the
per-experiment verification.txt / inspection.txt sidecars), stdout line (`VERDICT=…`,
inspect-plan's run-card block), rc, and usage error is unchanged. No behavior changes.

## Problem

The research-validity adjudication layer is split so the cheap part is deep and the expensive part
is not a module at all. `checkVerify` / `classifyInspect` are ~10 pure lines each in core; the
~215-line shell around them lives in the 2,137-line command file:

- Four Deps interfaces with near-identical member lists — `VerifyPlanDeps` (autoresearch.ts:350),
  `VerifyCheckDeps` (:384), `InspectPlanDeps` (:429 region), `InspectCheckDeps` (:472 region) —
  plus four live-deps constants (:2066-2106) that mostly alias each other
  (`readResult: liveVerifyPlanDeps.readResult` three times; a hoisted shared `readMetricMd`).
- `appendVerificationRow` (:2059) and `appendInspectionRow` (:2084) are the same seven lines with
  verification/inspection swapped: read-or-header, atomicWrite(tsv + renderRow), atomicWrite of a
  per-experiment sidecar whose KV line differs in one field name (`recomputed=` vs
  `reimpl_metric=`). Zero tests reach them — every verb test injects a push-to-array `writeRow`.
- The metric.md default-derivation policy lives three hops from its parser:
  `(md ? parseMetricMd(md).verifyEpsilon : undefined) ?? 0.01` (:414),
  `t?.c1Epsilon ?? (2 * (t?.verifyEpsilon ?? 0.01))` (:505), `parseMetricMd(md).c1Budget ?? 2`
  (:458 region) — the chain is restated where consumed, not owned where parsed.
- `verifyCheckWith` and `inspectCheckWith` share the same arg loop, arity check, `reported`
  extraction, `recomputedFromOutput` call, writeRow, and `VERDICT=` line — only the classifier,
  epsilon default, and row type differ.

**Deliberately NOT merged:** `checkVerify` vs `classifyInspect` — the two-way vs three-way verdict
asymmetry is documented as intentional (autoresearchInspect.ts:9-11). Only the SHELL is shared.

## Goal

One core module owns the shell IO — the two appenders behind one private generic, the shared
result read — with the epsilon/budget policy moving beside its parser; the four Deps shapes
collapse to injectable overrides of core defaults; the verbs shrink to arg parsing plus one call.

## Architecture

### Commit 1 — the core homes

- **`src/core/autoresearchValidity.ts`** (new):
  - private `appendRow(art, agent, expId, cfg, row)` parameterized by
    `{ tsvPath, header, renderRow, sidecarName, sidecarLine(row) }` — AMENDED from `tsvName`: the
    cfg takes the codecs' exported `verificationTsvPath`/`inspectionTsvPath` rather than a bare
    filename, so the TSV's location stays owned by the codec module that owns its format;
  - exported `appendVerificationRow` / `appendInspectionRow` — byte-identical file contents to the
    command-file originals (read-or-header + atomicWrite ordering preserved);
  - exported `readExperimentResult(art, agent, expId)` — the shared
    `readJsonOr(join(experimentDir(...), "result.json"), null)`;
  - exported `inspectionCount(art)` — the non-header line count (moved verbatim).
- **`resolveValidityThresholds(mdText: string | null): { verifyEpsilon: number; c1Epsilon:
  number; c1Budget: number }`** in `src/core/autoresearchMetric.ts` beside `parseMetricMd` — the
  three `??` chains stated once, including c1Epsilon's derivation from verifyEpsilon when unset.
  The verbs consume the resolved values; their computed numbers must be identical for every
  metric.md shape (absent file, present-without-fields, explicit values).

### Commit 2 — the verbs consume the homes

- The four live-deps constants shrink to the injectable overrides each verb genuinely needs
  beyond the core defaults; the four Deps interfaces collapse toward one shared shape where
  members coincide (readResult/readMetricMd/readStdout/readJson/writeRow/now/stdout/opts), with
  verify-plan's readManifest/readInput and inspect-plan's inspectionCount/workerProvider as the
  per-verb extras. Existing verb tests may update ONLY their deps-factory wiring (the injected
  fakes keep working — writeRow overrides stay possible); assertions unchanged.
- verifyCheckWith/inspectCheckWith keep their separate bodies (the classifier asymmetry) but read
  epsilon via resolveValidityThresholds; inspect-plan reads c1Budget the same way.
- NEW tests: the real append path — both appenders against a temp art dir (header-created,
  appended-not-clobbered, sidecar KV line exact), and resolveValidityThresholds' default table
  (absent/partial/explicit metric.md) — the two things currently exercised by nothing.

## Components

- `src/core/autoresearchValidity.ts` (new) · `src/core/autoresearchMetric.ts` (resolver) ·
  `src/commands/autoresearch.ts` (verbs + live deps shrink; appenders deleted there).
- `tests/` — new appender + resolver suites; existing verb tests wiring-only updates.
- Version 0.5.20 → 0.5.21 (three manifests) + rebuilt committed dist.

## Testing

- All existing suites pass; permitted edits: deps-factory wiring only, zero assertion changes.
- Appender round-trip: fresh dir → header + one row; second append → two rows, header once;
  sidecar file exact (`<verdict> reason=<r> recomputed=<v> at <ts>` / `reimpl_metric=` variant).
- Resolver table pins the three chains, including c1Epsilon = 2×verifyEpsilon when unset and the
  0.01 / 2 defaults.
- Mutation (Q10): re-inlining an epsilon chain in a verb must fail the resolver-consumption pin;
  breaking the appender's read-or-header must fail the round-trip. AMENDED: a byte-exact re-inline
  is behaviorally indistinguishable from the resolver, so no test can catch it — the pins are
  verb-level default pins that catch a re-inline that DRIFTS. Verified: dropping inspect-check's
  2x derivation, defaulting inspect-plan's budget to 3, and seeding the appender's header
  unconditionally each fail exactly the intended pin.
- Full gate green; dist rebuilt and committed.

## Success Criteria

- `grep -n "?? 0.01\|?? 2\b" src/commands/autoresearch.ts` finds no epsilon/budget chain; the
  policy lives beside parseMetricMd.
- One appender implementation; the real append path and the default chains are test-covered for
  the first time.
- Gate green; dist rebuilt+committed; 0.5.21; on-disk formats byte-identical.
