# implement scope-check: read prose Components + tolerate bare-name / same-dir-sibling paths — design

**Status:** draft (forensics 2026-06-19, `/ap:review`)
**Scope:** `src/core/implementScope.ts` (`extractComponentsPaths`, `matchDiffAgainstComponents`),
`tests/implement-scope.test.ts`, `tests/implement-scope-check.test.ts`, `commands/design.md`
(Components draft clause — complementary), version bump.
**Type:** deliberate divergence from the byte-faithful clone-wars bash port
(`deploy_extract_components_paths` / `deploy_match_diff_against_components`) — hence this spec, per the
CLAUDE.md phase guard. Direct follow-on to
`docs/superpowers/specs/2026-06-10-perform-scope-bullets-design.md` (which added bullet-list support;
"perform" is the historical name for `implement`).

## Problem

`/ap:implement`'s Phase-A scope-conformance guard (`scopeCheckWith`, `src/commands/implement.ts`)
extracts the in-scope path set from the design doc's `## Components` section via
`extractComponentsPaths`, then flags any changed file not matching it via
`matchDiffAgainstComponents`. The 2026-06-10 extension taught the extractor to read **table rows and
bullet rows**. Three real-world `design→implement` runs (aeris-code, 2026-06-16…19) still hit
**100% false-OOS** — the Hub flagged it each time as "every design→implement will trip this":

- `2026-06-17/08-39-52-implement` — **12** legitimate, design-named files flagged OOS; the Components
  section was **prose-with-backticks**, not a parseable list.
- `2026-06-18/03-38-49-implement` — **20** files OOS (Hub: "repeat from the A-layer run"); per-file
  detail lived in Architecture prose + a **mixed bare/full-path** Components list.
- `2026-06-19/05-47-21-implement` — **13** files OOS; the worker created the better-named
  `oracle-guard.ts` / `repro-receipt.ts` in the **same directory** the design's placeholder
  `verifier-receipt.ts` named.

These decompose into three independent matching gaps, none covered by the bullets extension:

1. **Prose Components (extraction gap).** `extractComponentsPaths` only scans a line when it matches
   `TABLE_ROW` (`/^[ \t]*\|/`) or `BULLET_ROW` (`/^[ \t]*[-*+][ \t]+/`). A prose paragraph inside
   `## Components` — `We touch \`src/a.ts\` and \`src/b.ts\`.` — is **neither**, so it contributes
   zero paths. When the whole section is prose, `compPaths` is `[]` and (per the 2026-06-10
   `SCOPE_DECLARED=0` signal) the entire diff is flagged. This is the dominant failure (2 of 3 runs).

2. **Bare filename declared, full path in diff (match gap).** A Components entry of just
   `oracle-guard.ts` (no directory) extracts cleanly (it ends with `.ts`), but the diff path is
   `src/x/oracle-guard.ts`. `matchDiffAgainstComponents` tests exact-equal, `comp`-ends-`/` subtree,
   and `comp + "/"` prefix — none match a bare name against a fuller path, so the file is OOS.

3. **Same-directory sibling (match gap).** The design names `src/x/verifier-receipt.ts` exactly; the
   worker ships `src/x/oracle-guard.ts`. Exact fails; `comp` is not a directory (no trailing `/`);
   `src/x/verifier-receipt.ts/` is not a prefix of the sibling — OOS, though the file is plainly in
   the intended work area.

In every case the changes were correct and design-named; the guard produced a wall of noise the Hub
had to hand-dismiss, eroding the signal it exists to provide. See memory
`implement-scope-check-false-oos-prose-components`.

## Goals

- Extract in-scope paths from a **prose** `## Components` section (path-like tokens on any
  non-table line), additively — without changing table-row or existing bullet behavior.
- Tolerate the two natural ways a design under-specifies a real component path — a **bare filename**
  and a **same-directory sibling** — with bounded, documented match rules.
- Keep the guard advisory and the over-match posture explicit, consistent with 2026-06-10.

## Non-goals

- Changing table-row first-cell extraction, the `## Components` section bounds, the path heuristic
  (`HAS_SLASH` / `ENDS_WITH_EXT`), the `SCOPE_DECLARED=`/`OOS_COUNT=`/`OOS_PATH=` stdout contract, or
  any frozen wire token / state filename / `contracts.yaml` key.
- Deduplicating extracted paths (set-membership downstream makes duplicates harmless).
- Recursive same-subtree tolerance for a file-form component (rejected below as too loose).
- Introducing a `node:path` dependency into `implementScope.ts` (it is pure string-ops today; keep it
  so — define local `parentOf` / `baseOf` helpers).

## Design

### 1. Prose extraction in `extractComponentsPaths` (defect 1)

The per-line loop and the `## Components` section bounds are unchanged. Generalize the **non-table**
branch from "bullet rows only" to **"any line in the section"**:

- In-section, `TABLE_ROW` line → **unchanged** (separator skip, first-cell parse, header-cell skip,
  path heuristic).
- In-section, **any other** non-blank line → strip an **optional** leading bullet marker
  (`/^[ \t]*[-*+][ \t]+/`, replace-if-present), then run the existing `pathTokensFrom(text)` helper
  (strip backticks → split on whitespace → trim surrounding punctuation, preserving a trailing `/` →
  keep tokens matching `HAS_SLASH` or `ENDS_WITH_EXT`).

This **subsumes** the 2026-06-10 bullet branch: a bullet line has its marker stripped then is scanned
as prose; a prose line has no marker and is scanned directly. The `BULLET_ROW` constant is no longer
needed for branching — keep only the marker-strip regex; remove `BULLET_ROW` if it becomes dead (do
not leave an unused export).

Lines that contribute nothing remain harmless: the seed comment `<!-- seed: ... [Components] -->`,
the `_(no seed content matched...)_` placeholder, and blank lines yield no path-like token. The
section still ends at the next `## ` H2, so Architecture/Testing prose is never harvested.

### 2. Two bounded match rules in `matchDiffAgainstComponents` (defects 2 & 3)

Add two new in-scope rules, evaluated **only after** the three existing rules miss, and **only for a
file-form** component `c` (one that does **not** end with `/` — directory components already get
subtree semantics). Using pure helpers `parentOf(p)` (everything before the last `/`, `""` if none)
and `baseOf(p)` (everything after the last `/`):

- **(4) Bare-filename match** — `c` contains no `/` (a bare filename like `oracle-guard.ts`) AND
  `baseOf(path) === c` → in-scope. Admits `**/<name>`; bounded by exact basename equality.
- **(5) Same-directory sibling** — `c` contains a `/` (a full file path) AND
  `parentOf(path) === parentOf(c)` → in-scope. Admits **direct** siblings of the declared file (one
  directory level only — a deeper `src/x/sub/c.ts` does **not** match `src/x/a.ts`).

Recursive tolerance (`path` under `parentOf(c)` at any depth) was considered and **rejected**:
declaring one file would silently admit an entire subtree, which is the failure mode the *directory*
declaration form (`src/x/`) already exists to express explicitly. Same-directory-direct keeps the fix
to exactly the observed reorganization pattern.

### 3. The over-match tradeoff (extended, accepted)

The 2026-06-10 spec accepted that scanning all bullet tokens makes a *referenced* path in-scope (a
false negative for an unrelated edit to it), because the guard is advisory + Hub-reviewed and missing
a real component (total failure) is worse. This spec **extends the same tradeoff** on three axes:

- prose lines are now scanned (a path mentioned in a Components sentence becomes in-scope);
- a bare filename admits same-named files in any directory;
- a declared file admits its direct same-directory siblings.

Each is bounded (path heuristic / exact basename / one directory level) and **strictly widens
in-scope** — it can only *suppress* an OOS warning, never invent one, so it cannot break a passing
run. Documented in the `extractComponentsPaths` / `matchDiffAgainstComponents` headers so a future
reader does not "tighten" it without re-reading this decision.

### 4. Complementary directive nudge — `commands/design.md` (optional, belt-and-suspenders)

The design directive (`commands/design.md`) currently asks for `## Components` as "bullets of
files/functions/classes touched" — wording that invites prose. Add one clause: **each Components
bullet should lead with the file path** (`- \`src/x/oracle-guard.ts\` — <what changes>`), so even a
prose description carries a leading path token. This is secondary: §1 already recovers prose, but a
cleaner upstream list reduces over-match. No behavior depends on it; do not gate the code fix on it.

## Faithfulness / divergence

Further divergence from `deploy_extract_components_paths` and `deploy_match_diff_against_components`.
Update the `implementScope.ts` header to note the prose extraction + the bare-name/same-dir match
rules (pointer here, alongside the existing 2026-06-10 pointer). The frozen-token gate
(`tests/stale-tokens.test.ts`) is unaffected — no banned brand/metaphor token is involved. No
wire-protocol token, state filename, or `contracts.yaml` key changes. `dist/ap.cjs` is rebuilt and
committed; bump the version across the three manifests (`package.json`,
`.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`) so `tests/manifest.test.ts` stays in
sync.

## Testing

All existing `tests/implement-scope.test.ts` table + bullet + match cases pass **unchanged**.

New `extractComponentsPaths` prose cases:
- prose-with-backticks: `We touch \`src/a.ts\` and \`src/b.ts\`.` → `["src/a.ts", "src/b.ts"]`
- prose, bare-path mid-sentence: `add a guard to src/core/foo.ts later` → `["src/core/foo.ts"]`
- bare filename in prose: `the new oracle-guard.ts module` → `["oracle-guard.ts"]`
- mixed table + bullets + prose in one section → all harvested, document order
- prose-only section (no table, no bullets) → non-empty when a path-like token is present (the exact
  regression: this returned `[]` before)
- seed comment / placeholder / blank lines → contribute nothing
- section still ends at the next H2 (a path in a sentence after `## Testing` is NOT harvested)

New `matchDiffAgainstComponents` cases:
- bare-name match: comp `oracle-guard.ts`, diff `src/x/oracle-guard.ts` → in-scope
- bare-name miss: comp `oracle-guard.ts`, diff `src/x/oracle-guards.ts` → OOS (exact basename only)
- same-dir sibling: comp `src/x/verifier-receipt.ts`, diff `src/x/oracle-guard.ts` → in-scope
- deeper non-sibling: comp `src/x/a.ts`, diff `src/x/sub/c.ts` → OOS (one level only)
- different dir: comp `src/x/a.ts`, diff `src/y/a.ts` → OOS
- directory component unchanged: comp `src/x/`, diff `src/x/sub/c.ts` → in-scope (existing subtree rule)

New `tests/implement-scope-check.test.ts` (command-level) coverage:
- a design whose Components is **prose** but names real paths → `SCOPE_DECLARED>0`, OOS drops to the
  genuinely-unlisted set (no longer the whole diff), rc 0
- a worker diff of same-dir siblings against an exact-file Components list → `OOS_COUNT=0`

## Acceptance

1. A prose `## Components` section that names paths yields the same in-scope set a table/bullet list
   would, for backticked, bare-path, and bare-filename forms.
2. A bare filename and a same-directory-direct sibling of a declared file are in-scope; a deeper or
   different-directory file is not.
3. All pre-existing `implement-scope` extraction and match tests pass unchanged; the change can only
   suppress OOS warnings, never add them.
4. The three forensic cases (prose-12, mixed-20, sibling-13) would each report 0 false-OOS against
   their real diffs.
5. The `implementScope.ts` headers document the divergence and point here; version + `dist/ap.cjs`
   bumped and committed; `tests/manifest.test.ts` green.
