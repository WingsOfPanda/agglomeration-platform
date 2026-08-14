# Autoresearch validity-artifact codecs + memory scope resolver — design

**Date:** 2026-08-14 · **Origin:** the four-walk architecture review (walk 2, candidates 1 and 4),
Wave A PR-3 of the deepening program agreed by grilling. · **Scope:** one PR (0.5.20), two
commits, byte-identical throughout — every file on disk, log line, stdout line, and rc is
unchanged. No behavior changes.

## Problem

**Half-modules.** Each research-validity artifact (sanity/coverage/lineage/verification/
inspection `.tsv`) has only its WRITE half in core: a row type, a `*_TSV_HEADER` constant, and a
row renderer (e.g. autoresearchLineage.ts:16-19). The read half exists nowhere, so consumers
independently know the filename, the header token, and the column order:

- statusBrief rebuilds CoverageRow by position (`cells[0]`,`parseInt(cells[1]…)`,`cells[2]`,
  `cells[3]`, autoresearch.ts:~1110) and tests `cells[4] === "improve-multi"` on lineage
  (~1120) — magic index 4.
- finalize's `foldWarnings` re-tests `c[2]`/`c[3]`/`c[4]` on sanity/lineage/inspection with the
  schema restated as a trailing comment at each site (autoresearch.ts:~1270-1285) — a second,
  independent magic index 4 on lineage.
- corpus-digest parses verification.tsv a third way, bypassing the existing parser:
  `.split("\n").filter((l) => l && !l.startsWith("exp_id\t") && l.split("\t")[2] === "verified")`
  (autoresearch.ts:~2037).
- Only verification/inspection have any parser at all (`parseVerdicts` in
  autoresearchInfeasible.ts, `parseInspections` wrapping it), covering columns 0-2 only.
- The generic splitter `readTsvRows(path, headerToken)` is PRIVATE to the command file
  (autoresearch.ts:1035-1044), so core readers cannot reuse it.

Adding a column to lineage.tsv means editing one renderer and three unrelated readers no type
connects.

**Scope preamble ×2 (the rider).** Memory↔MemoryStore is a REAL seam (autoresearchMemory.ts is
495 pure lines, zero fs; the store owns the JSONL) — keep it. But the store's scope resolution is
duplicated verbatim in both callers: `parseMetricMd` → `metricFamilyOf` → null-guard →
`policyFromMetric` → `storeRoot: deps.memoryStoreRoot ?? join(globalRoot(),
"autoresearch-memory")` → `repoHash: deps.repoHash ?? repoHash()` (autoresearchFinalize.ts:
221+276-283 vs autoresearch.ts memory-retrieve ~1957-1971). And two test files hand-reimplement
`liveMemoryIo` — including their own copy of the tmp-then-rename atomic write — so those tests
would keep passing if atomic.ts changed.

## Goal

One artifact = one module owning its full on-disk contract (path + header + render + parse),
with the parsers PURE (text in, typed rows out — matching these modules' deliberate no-FS
discipline); the four hand-indexing readers converted; the store owning "which scope am I".
Files on disk byte-identical; all output byte-identical.

## Architecture

### Commit 1 — the codecs

- **Shared pure splitter**: `splitTsvRows(text: string, headerToken: string): string[][]` in a
  new tiny `src/core/tsv.ts` — blank-line skip + `startsWith(headerToken)` skip + tab split,
  the exact semantics of the command-private `readTsvRows` minus the file read.
- **Per-artifact parsers**, one in each existing module, pure:
  `parseSanityRows(text): SanityRow[]`, `parseCoverageRows(text): CoverageRow[]`,
  `parseLineageRows(text): LineageRow[]`, `parseVerificationRows(text): VerificationRow[]`,
  `parseInspectionRows(text): InspectionRow[]`, each returning the artifact's FULL row (the row
  types are already complete; it is the parsing that is partial — verification/inspection carry
  reason/recomputed/reimpl_metric fields that today nothing reads back). Numeric fields (e.g.
  CoverageRow.count) parsed exactly as the current
  reader does (`parseInt(cells[1] ?? "0", 10) || 0`). The parser owns ONLY split + header-skip +
  field naming; every caller-side FILTER predicate (`if (cells[0] …)`) stays at the caller,
  re-expressed over named fields — byte-identical selectivity.
- **Per-artifact path helpers**: `sanityTsvPath(art)` etc., pure joins beside each header
  constant — the filename stated once.
- **Reader conversions** (behavior pinned by existing tests — but see Amendments: the statusBrief
  sanity/lineage joins turned out NOT to be pinned):
  - statusBrief's coverage + lineage blocks → `readIfExistsOrNull(path)` then parse (the
    absent→undefined distinction the current code gets from readTsvRows is preserved via the
    null check — the inspection.tsv line directly above already uses this exact pattern).
  - finalize's three foldWarnings lambdas → typed rows; the emitted warning lines byte-identical.
  - corpus-digest's inline split → `parseVerificationRows(...).filter(r => r.verdict ===
    "verified").length`.
  - `readTsvRows` in the command file: delete it if (and only if) these conversions leave it
    unused — check remaining callers (the suspects/sanity block ~1105 also uses it; convert that
    site too with the same rules).
- **Untouched**: `parseVerdicts`/`parseInspections` keep their names, module homes, and keyed
  `Record<agent/exp, verdict>` shape (computeScore's interface; the frozen consult surface). If
  the implementer can trivially re-express `parseVerdicts` over `parseVerificationRows` with
  byte-identical semantics, fine; otherwise leave it — no forcing.

### Commit 2 — the memory scope rider

- **`resolveMemoryScope(metricMdText: string | null, o: { storeRoot?: string; repoHash?:
  string }): null | { storeRoot: string; repoHash: string; family: string; direction:
  "maximize" | "minimize"; policy: <existing policy type>; thresholds: <parseMetricMd's
  return> }`** in `src/core/autoresearchMemoryStore.ts`. Null on missing text or
  out-of-taxonomy family — exactly the two callers' current guards. Takes TEXT, not a path: the
  store's documented FS surface stays MemoryIo-only; callers keep their one-line read (finalize:
  `readOr`; memory-retrieve: its existsSync + readFileSync shape unchanged, including the
  distinct early-return rc paths).
- Both callers (writeFinalizeLessons, memoryRetrieveWith) shrink to read + resolve + their own
  drafts/objective. The `deps.memoryIo ?? liveMemoryIo` injection stays exactly as-is.
- corpus-digest's two `metricFamilyOf(parseMetricMd(mm).primaryMetric)` one-liners are OUT of
  scope — they need only the family for archived campaign dirs, not a store scope; folding them
  in would relocate, not concentrate.
- **Test scaffolds**: the two hand-rolled `realIo` constants (tests/autoresearch-memory-store
  .test.ts:17-26, tests/autoresearch-memory-retrieve.test.ts:18-27) are replaced by
  `liveMemoryIo` + a temp storeRoot (restoring coverage of the real atomicWrite). The throwing-
  MemoryIo fault-injection test (tests/autoresearch-finalize.test.ts:~407) is KEPT — it is the
  one legitimate fake, proving a memory-write failure cannot change finalize's rc or artifacts.

## Components

- `src/core/tsv.ts` (new) — splitTsvRows.
- `src/core/autoresearch{Sanity,Coverage,Lineage,Verify,Inspect}.ts` — parsers + path helpers
  (renderers/headers untouched).
- `src/commands/autoresearch.ts` — statusBrief/foldWarnings/corpus-digest/suspects conversions;
  readTsvRows deleted when unused.
- `src/core/autoresearchMemoryStore.ts` — resolveMemoryScope.
- `src/core/autoresearchFinalize.ts` + `src/commands/autoresearch.ts` — preamble replaced.
- `tests/` — see Testing. Version 0.5.19 → 0.5.20 (three manifests) + rebuilt committed dist.

## Testing

- ALL existing suites pass with ZERO assertion edits except the two sanctioned realIo-scaffold
  replacements (whose assertions must not weaken — same expectations through liveMemoryIo).
- New codec tests: per artifact, a render→parse round-trip over a representative row set
  (including empty-field rows and rows with tabs-in-detail if the current renderer can produce
  them) + header-skip + blank-skip + absent-vs-empty semantics.
- resolveMemoryScope: null on missing text; null on out-of-taxonomy; defaults applied; explicit
  overrides win — pinned once here instead of twice through the verbs.
- Mutation checks (grilling Q10): swapping two columns in one parser must fail its round-trip;
  re-inlining a magic index at a converted reader must fail at least one test.
- Full gate green; dist rebuilt and committed.

## Success Criteria

- `grep -n 'cells\[4\]\|split("\\\\t")\[2\]' src/commands/autoresearch.ts` returns nothing; no
  reader outside the artifact modules names a column by number.
- Column order for each artifact is stated in exactly one file.
- The two callers of the memory store contain no parseMetricMd→policy preamble.
- Gate green; dist rebuilt+committed; 0.5.20; files on disk byte-identical (proven by the
  existing artifact-content pins).

## Amendments (made while implementing; the code is the source of truth)

1. **"Behavior pinned by existing tests" was wrong for statusBrief.** The leader-row `[suspect:]`
   and `[multi-change]` tags were pinned only at `buildStatusBrief` with hand-built maps — nothing
   covered `statusBriefWith`'s sanity.tsv/lineage.tsv READ. The grilling-Q10 mutation check caught
   it (a converted reader picking the wrong named field passed the whole suite), so this PR adds
   one `statusBriefWith` test joining both files end-to-end; the mutation now fails.
2. **Row types were already full**; only the parsing was partial. Reworded above.
3. **The path helpers are applied at every site naming one of the five filenames**, not only at the
   converted readers — otherwise "the filename stated once" would be false and the helper would be
   a second source of truth. That extends to the score-time writers, `appendVerificationRow` /
   `appendInspectionRow`, `autoresearchFinalize.ts`, and `autoresearchScore.ts:65-66` (a pure
   `join(art, "x.tsv")` -> `xTsvPath(art)` substitution in each case).
4. **`inspectionCount` (autoresearch.ts, liveInspectPlanDeps) was a fourth hand-parse** the problem
   statement missed — it restated the `exp_id\t` header token to count rows. Converted to
   `parseInspectionRows(...).length`, byte-identical including the absent-file 0.
5. **`parseInspections` is re-expressed over `parseInspectionRows`, not `parseVerdicts`.** Both
   re-expressions are trivially byte-identical (same guard, same key, same last-write-wins), and
   routing inspection.tsv through the VERIFICATION parser would have left inspection's column
   order stated in another artifact's module — failing this spec's own success criterion.
6. **`results.tsv` is deliberately NOT in scope.** Its `exp_id\t` header token is still restated at
   `autoresearch.ts:830` (ledger tail) and `autoresearchScore.ts:29`. It is a sixth artifact with
   its own module (`autoresearchResult.ts`) and its own row type; folding it in is a separate
   change, not this one.
