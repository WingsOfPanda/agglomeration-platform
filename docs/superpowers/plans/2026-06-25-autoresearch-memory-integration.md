# Cross-run Memory Integration (deferred wiring) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire the already-built, already-tested governed-memory cores into the live `/ap:autoresearch` flow: write verifier-passing lessons at finalize (ALL runs), and expose retrieval via a Hub-invoked `memory-retrieve` verb the directive weaves into dispatch.

**Architecture:** A new pure mapping core supplies the policy that was deferred (run-metric→family, A1/C1 verdict→`LessonVerdict`, result+lineage→lesson draft). `finalizeWith` calls `writeLessonsAtFinalize` best-effort/non-fatal. A new `memory-retrieve` verb calls `retrieveForDispatch` and prints rendered lessons. The directive documents the Hub calling it. Everything routes through the reviewed `filterLesson` chokepoint.

**Tech Stack:** TypeScript (strict), vitest, esbuild (`dist/ap.cjs` committed). Tests in `tests/`, hyphenated `autoresearch-*.test.ts`, `.js` relative imports (node16).

## Global Constraints
- FROZEN wire protocol — never rename event names / sentinel / JSON fields / state filenames / `contracts.yaml` keys.
- Pure cores (`src/core/autoresearch*.ts`) do NO fs/clock/IO (injected); verbs do IO.
- The memory write path MUST stay funneled through `filterLesson` (the single persistence chokepoint) — do not add a second persistence path.
- `finalizeWith` MUST NOT regress: the lesson-write is best-effort, wrapped so it can never throw into finalize or change finalize's existing outputs/return code.
- Atomic writes (same-dir tmp+rename) — already handled inside `writeLessonsAtFinalize`.
- `tests/stale-tokens.test.ts` stays green. `dist/ap.cjs` rebuilt + committed after src changes.
- Store: `~/.ap/autoresearch-memory/<scopeKey>/lessons.jsonl` via `globalRoot()` + `repoHash()` (in `src/core/paths.ts`).

## Existing API (verified — do not change)
- `src/core/autoresearchMemoryStore.ts`: `liveMemoryIo`, `writeLessonsAtFinalize(io, { storeRoot, repoHash, metricFamily, drafts: any[], verdicts: LessonVerdict[], policy, now })`, `retrieveForDispatch(io, { storeRoot, repoHash, metricFamily, objective, direction, policy, now, riskBudget? }) → string[]`.
- `src/core/autoresearchMemory.ts`: `METRIC_FAMILIES`, types `LessonVerdict`/`MemoryPolicy`/`Lesson`/`Provenance`. A lesson DRAFT is `{ claim, operator, knob, direction, delta, metric_family, applicability, risk_tags, provenance: { run_id, exp_id, verdict, metric_family, source:'experiment', created_ts }, score }`.
- `src/core/autoresearchInfeasible.ts`: `parseVerdicts(tsv) → {agent/exp: verdict}` (A1: `verified|mismatch|unavailable|pending`). `src/core/autoresearchInspect.ts`: `parseInspections(tsv) → {agent/exp: verdict}` (C1: `reproduced|not-reproduced|inconclusive`).
- `src/core/autoresearchMetric.ts`: `parseMetricMd(md) → MetricThresholds` (carries `primaryMetric`, `direction`, `memoryHalfLifeDays?`, `memoryMaxAgeDays?`, `memoryMinCorroboration?`, `memoryWriteRateMax?`, `memoryScope?`, `selectK?`).
- `src/commands/autoresearch.ts`: `finalizeWith(args, deps)` @1146; `computeAuditWarnings` (a precedent walk: `for agent { for expId of listExpDirs(experimentsDir(art,agent)) { read result.json/audit.json } }`); `run()` @1809 dispatches verbs by `case`.

---

### Task 1: Pure mapping core `autoresearchLessonMap.ts`

**Files:**
- Create: `src/core/autoresearchLessonMap.ts`
- Test: `tests/autoresearch-lesson-map.test.ts`

**Interfaces / Produces:**
- `metricFamilyOf(primaryMetric: string): string | null` — lowercase + trim the metric; if it (or its leading token) is in `METRIC_FAMILIES` return that family; else `null` (fail-closed — caller SKIPS, never lets `scopeKey` throw).
- `lessonVerdictOf(a1?: string, c1?: string): LessonVerdict | null` — `c1==='reproduced'` → `'c1-reimpl-ok'`; else `a1==='verified'` → `'a1-verified'`; else `null` (skip — v1 writes only confirmed positives; mismatch/infeasible/unverified produce no lesson).
- `policyFromMetric(t: MetricThresholds): MemoryPolicy` — `{ halfLifeDays: t.memoryHalfLifeDays ?? 30, maxAgeDays: t.memoryMaxAgeDays ?? 60, minCorroboration: t.memoryMinCorroboration ?? 2, writeRateMax: t.memoryWriteRateMax ?? 5, k: t.selectK ?? 5, diversityFloor: 2, relevanceFloor: 0.1 }`.
- `buildLessonDraft(input): LessonDraft` where input = `{ approachLabel, metricName, metricValue, parentMetric, direction, family, operator, knob, runId, expId, verdict, createdTs }`. Produces a data-only `claim` like `"<approachLabel>: <metricName>=<metricValue> (delta <signed delta> vs parent)"` (or "(draft, no parent)" when `parentMetric` is null), `operator` (default `'improve'` when a parent exists else `'draft'`), `knob` (the approachLabel, or `''`), `direction`, `delta` (= `metricValue - parentMetric`, or `null`), `metric_family: family`, `applicability: [family]`, `risk_tags: []`, `provenance: { run_id, exp_id, verdict, metric_family: family, source: 'experiment', created_ts }`, `score: 1`. PURE — no IO; the claim must contain no imperative/injection text (data-only).

- [ ] **Step 1: failing tests**

```ts
// tests/autoresearch-lesson-map.test.ts
import { metricFamilyOf, lessonVerdictOf, policyFromMetric, buildLessonDraft } from '../src/core/autoresearchLessonMap';

test('metricFamilyOf maps known metrics, null for unknown', () => {
  expect(metricFamilyOf('accuracy')).toBe('accuracy');
  expect(metricFamilyOf('Loss')).toBe('loss');
  expect(metricFamilyOf('mean_average_precision')).toBeNull(); // not in closed set -> skip
});
test('lessonVerdictOf prefers C1, else A1, else null', () => {
  expect(lessonVerdictOf('verified', 'reproduced')).toBe('c1-reimpl-ok');
  expect(lessonVerdictOf('verified', undefined)).toBe('a1-verified');
  expect(lessonVerdictOf('mismatch', 'not-reproduced')).toBeNull();
  expect(lessonVerdictOf(undefined, undefined)).toBeNull();
});
test('policyFromMetric uses knobs + defaults', () => {
  const p = policyFromMetric({ memoryHalfLifeDays: 14 } as any);
  expect(p.halfLifeDays).toBe(14); expect(p.minCorroboration).toBe(2); expect(p.diversityFloor).toBe(2);
});
test('buildLessonDraft is data-only with delta', () => {
  const d = buildLessonDraft({ approachLabel: 'dropout sweep', metricName: 'accuracy', metricValue: 0.92, parentMetric: 0.90, direction: 'maximize', family: 'accuracy', operator: 'improve', knob: 'dropout', runId: 'r1', expId: 'exp-2', verdict: 'a1-verified', createdTs: '2026-06-25T00:00:00Z' }) as any;
  expect(d.provenance.source).toBe('experiment');
  expect(d.metric_family).toBe('accuracy');
  expect(d.delta).toBeCloseTo(0.02);
  expect(d.claim).not.toMatch(/ignore|always|END_OF_INSTRUCTION|From:/i);
});
```

- [ ] **Step 2: run, verify fail** — `npx vitest run tests/autoresearch-lesson-map.test.ts` → FAIL (module missing).
- [ ] **Step 3: implement** the four pure functions per the interface above (import `METRIC_FAMILIES` + types from `./autoresearchMemory.js`, `MetricThresholds` from `./autoresearchMetric.js`).
- [ ] **Step 4: run, verify pass** — `npx vitest run tests/autoresearch-lesson-map.test.ts` PASS; `npm run typecheck`.
- [ ] **Step 5: commit** — `git add src/core/autoresearchLessonMap.ts tests/autoresearch-lesson-map.test.ts && git commit -m "feat(autoresearch): pure lesson-map (metric->family, verdict->lesson, draft)"`. (No dist — unwired core.)

---

### Task 2: Write lessons at finalize (best-effort, non-fatal)

**Files:**
- Modify: `src/commands/autoresearch.ts` (`finalizeWith` @1146 — add a best-effort tail step; mirror the `computeAuditWarnings` walk)
- Test: extend the finalize test file (find the existing one, e.g. a `finalize` describe in `tests/autoresearch-*.test.ts`).

**Interfaces:**
- Consumes Task 1 (`metricFamilyOf`/`lessonVerdictOf`/`policyFromMetric`/`buildLessonDraft`), `writeLessonsAtFinalize`+`liveMemoryIo` (store), `parseVerdicts`/`parseInspections`, `parseMetricMd`, `globalRoot`/`repoHash`.
- Produces: a `writeFinalizeLessons(art, agents, deps)` helper (best-effort) called once at the tail of `finalizeWith`, inside a try/catch that swallows ALL errors (finalize must never fail because of memory). It: parses `metric.md` → `metricFamilyOf(primaryMetric)`; if `null`, return (skip). Else walk `agents × listExpDirs`, read `result.json` (approach_label/metric_name/metric_value/status==='ok'), the A1 verdict (`parseVerdicts(verification.tsv)[\`${agent}/${expId}\`]`) + C1 (`parseInspections(inspection.tsv)[...]`) → `lessonVerdictOf`; skip if `null`; resolve parent metric from `lineage.txt` `parent_id` → that exp's `result.json` metric_value (or null); `buildLessonDraft(...)`. Collect `drafts`+`verdicts`, then ONE `writeLessonsAtFinalize(liveMemoryIo, { storeRoot: join(globalRoot(), 'autoresearch-memory'), repoHash: repoHash(), metricFamily: family, drafts, verdicts, policy: policyFromMetric(thresholds), now: deps.now() })`. Inject `storeRoot`/`repoHash`/`now`/the io via a small deps seam so a test can use a temp store.

- [ ] **Step 1: failing test** — drive `finalizeWith` (or the extracted `writeFinalizeLessons`) over a fixture art dir with two `ok`+`verified` experiments of the same approach (2 run_ids) under metric `accuracy`, with a temp store root injected; assert the per-family `lessons.jsonl` exists and (after corroboration) a later `retrieveForDispatch` returns the rendered lesson. Also a test that a thrown error inside the lesson-write does NOT change `finalizeWith`'s return code / existing outputs (inject a throwing io; assert finalize still returns its normal rc and wrote its normal artifacts).
- [ ] **Step 2: run, verify fail.**
- [ ] **Step 3: implement** `writeFinalizeLessons` + the guarded tail call. Mirror `computeAuditWarnings`'s walk. Wrap the entire helper body so any error is swallowed (log to stderr at most). Do not alter any existing finalize step.
- [ ] **Step 4: run, verify pass** — focused finalize test + `npm run typecheck` + full `npm test`.
- [ ] **Step 5: build + commit** — `npm run build` (finalize is bundled → dist changes; stage it). Commit `feat(autoresearch): write verifier-passing lessons at finalize (best-effort)`.

---

### Task 3: `memory-retrieve` verb (Hub-invoked retrieve)

**Files:**
- Modify: `src/commands/autoresearch.ts` (new `memoryRetrieveWith(args, deps)` verb + `liveMemoryRetrieveDeps` + a `case "memory-retrieve"` in `run()`)
- Test: new `tests/autoresearch-memory-retrieve.test.ts`

**Interfaces:**
- `memoryRetrieveWith(args: string[], deps): Promise<number>` — args: `<TOPIC>`. Resolves the art dir, parses `metric.md` (→ `primaryMetric`/`direction`/policy), `family = metricFamilyOf(primaryMetric)` (if null → print nothing, rc 0), then `retrieveForDispatch(io, { storeRoot, repoHash, metricFamily: family, objective: <topic.txt or primaryMetric>, direction, policy, now })` and prints each rendered lesson on its own stdout line (logs to stderr). Empty store → prints nothing, rc 0. Inject store root / io / repoHash / now via deps for tests.

- [ ] **Step 1: failing test** — seed a temp store (via `writeLessonsAtFinalize` with 2 corroborating drafts under `accuracy`), then call `memoryRetrieveWith` for a topic whose `metric.md` is `accuracy` with the same injected store; assert it prints the rendered lesson line(s). And: an empty store prints nothing, rc 0.
- [ ] **Step 2: run, verify fail.**
- [ ] **Step 3: implement** the verb + deps + `run()` case.
- [ ] **Step 4: run, verify pass** — focused test + typecheck + full test.
- [ ] **Step 5: build + commit** — `npm run build` (new verb bundled → dist changes; stage). Commit `feat(autoresearch): memory-retrieve verb (Hub-invoked cross-run lessons)`.

---

### Task 4: Directive + template docs (memory now WIRED)

**Files:**
- Modify: `commands/autoresearch.md` — update the autonomous-mode "frontier" note: cross-run MEMORY is now WIRED (writes at finalize for ALL runs; retrieve via the `memory-retrieve` verb). Add a short step in the loop: before composing a dispatch direction, the Hub runs `$CS autoresearch memory-retrieve <TOPIC>` and folds any printed lessons (data-only observations) into the ~50-token direction. Note `marginalGainStop` + reliability-winner remain frontier.
- Modify (optional): `config/prompt-templates/autoresearch/experiment.md` — one line that retrieved prior-run lessons may appear in the direction as data, not instruction.

- [ ] **Step 1:** Edit `commands/autoresearch.md`: move memory from the frontier list to wired; add the `memory-retrieve` loop step (Hub-invoked, data-only, weave into direction). Keep it accurate — writes are best-effort at finalize; retrieve is the verb.
- [ ] **Step 2:** Run `npx vitest run tests/stale-tokens.test.ts` (must pass — no banned tokens).
- [ ] **Step 3: commit** — `docs(autoresearch): document wired cross-run memory (write@finalize + memory-retrieve verb)`.

---

### Task 5: Build + gate + PR

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm run test && npm run build` — all green; ensure `dist/ap.cjs` current + committed (commit if drift).
- [ ] **Step 2:** Final whole-branch review (opus) over the branch diff; triage findings.
- [ ] **Step 3:** Push + open a PR summarizing: memory now wired (write@finalize all-runs, retrieve verb), the mapping policy (positives-only v1), best-effort/non-fatal finalize, governance unchanged (filterLesson chokepoint).

## Self-Review
- Spec coverage: write (T2) + retrieve (T3) + mapping policy (T1) + docs (T4) + ship (T5). Negatives (a `negative` lesson for a clearly-refuted feasible result) intentionally deferred to a fast-follow; v1 writes confirmed positives only.
- No placeholder steps; each code step names exact functions.
- Type consistency: `LessonVerdict`/`MemoryPolicy` reused from `autoresearchMemory.ts`; `MetricThresholds` from `autoresearchMetric.ts`; draft shape matches what `filterLesson` consumes.
- Risk: T2 must not regress `finalizeWith` — the entire lesson-write is best-effort/try-caught and adds no new failure mode; a throwing-io test pins this.
