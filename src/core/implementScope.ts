// src/core/implementScope.ts
//
// SCOPE-CONFORMANCE guard for `implement` Phase A. Port of the prior bash plugin's scope-conformance
// helpers (deploy-scope), EXTENDED in ap (deliberate divergence) three times:
//   - docs/superpowers/specs/2026-06-10-perform-scope-bullets-design.md — extractComponentsPaths also
//     reads bullet-list Components, not only markdown table rows.
//   - docs/superpowers/specs/2026-06-19-implement-scope-prose-and-sibling-design.md — extraction also
//     reads PROSE lines in the section (every path-like token, not just bullets), and
//     matchDiffAgainstComponents tolerates a declared bare filename (basename match) and a
//     same-directory sibling of a declared file (one directory level), so a worker that renames or
//     splits a module in place is not flagged out-of-scope.
//   - docs/superpowers/specs/2026-08-20-scope-testing-paths-design.md — scope checks treat paths
//     named in `## Testing` as declared scope with the same matching semantics as Components.
// A separate addition (2026-08-14-components-path-lint-design.md) sits beside the guard rather than in
// it: lintComponentsPaths, the warn-only authoring-time check that every declared path exists in the
// checkout unless its line is tagged [on-box]. It never feeds the scope verdict.
// So does pathsInvisibleInTarget (2026-08-23-worktree-truth-telling-design.md): the declared paths
// that exist in the MAIN checkout and are missing in a worktree run's target. Also warn-only, and
// also never part of the scope verdict.
// And so does testingBulletsWithoutPaths (2026-08-23-brief-path-correctness-design.md): how many
// `## Testing` bullets name no path at all, measured at `implement audit` so incomplete authoring is
// visible BEFORE a worker runs rather than as an OOS surprise at Stage 4. That same doc adds the
// decoration strip inside pathTokensFrom (paired emphasis + markdown links), which is widening-only.
// And so does unresolvedDeclaredPaths (2026-08-23-declared-path-precision-design.md): which declared
// tokens name neither a file nor an explicit directory. REPORT ONLY — it is computed ALONGSIDE the
// declared set that reaches matchDiffAgainstComponents and is never subtracted from it, because
// removing a declaration can only move a diff path from in-scope to OUT-of-scope (a passing check
// turned failing). That same doc drops a bare `/` token at extraction.
// deploy_extract_components_paths -> extractComponentsPaths,
// deploy_match_diff_against_components -> matchDiffAgainstComponents. The Bash helpers read files via
// awk; the TS ports take the already-read strings (file IO is the caller's concern). Table-row
// first-cell extraction, section bounds, separator/header skip, the path heuristic, and the exact /
// dir-prefix match rules are preserved; the prose/bullet token scan, the Testing-section scope rule,
// and the bare-name/sibling rules are the documented divergences. All new rules STRICTLY WIDEN
// in-scope — they can only suppress an OOS warning, never invent one, so they cannot turn a passing
// scope-check into a failing one.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const COMPONENTS_HEADER = /^## Components[ \t]*$/;
const TESTING_HEADER = /^## Testing[ \t]*$/;
const OTHER_H2 = /^## [^ ]/;
const ANY_COMPONENTS_PREFIX = /^## Components/;
const ANY_TESTING_PREFIX = /^## Testing/;
const TABLE_ROW = /^[ \t]*\|/;
const SEPARATOR_ROW = /^[ \t]*\|([ \t]*[:-]+[ \t]*\|)+[ \t]*$/;
const BULLET_MARKER = /^[ \t]*[-*+][ \t]+/;
const HEADER_CELL = /^(File|Path|Name|Files?[ \t]+(edited|moved|touched))$/;
const HAS_SLASH = /\//;
const ENDS_WITH_EXT = /\.[a-zA-Z]+$/;
/** Line-level opt-out of the path lint: the line's paths live on another box, not in this checkout. */
const ON_BOX_TAG = "[on-box]";

/** The directory portion of a path (everything before the last "/"), "" when there is no "/". */
function parentOf(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
/** The final path segment (everything after the last "/"), the whole string when there is no "/". */
function baseOf(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }

/** Markdown inline link, collapsed to its TARGET before the split: the target is where a path lives
 *  in `[label](src/a.ts)`, and a label with spaces would otherwise be torn into separate tokens by
 *  the whitespace split, leaving the unmatchable tail `label](src/a.ts`. Applied to the whole line
 *  (not per token) for exactly that reason. */
const MD_LINK = /\[[^\]\n]*\]\(([^)\s]*)\)/g;
/** Single-character emphasis markers, peeled one PAIRED layer at a time (so `**x**` takes two
 *  passes, `_x_` one). `__` needs no entry of its own for the same reason. */
const EMPHASIS = ["*", "_"];

/** Strip PAIRED markdown emphasis wrappers from one token. STRICTLY paired at both ends and never
 *  one-sided: `_quick/topic-text.txt` opens with `_` and does not close with one, so it survives
 *  intact — that exact string is the state-relative citation `quick branch`'s brief lint exists to
 *  catch, and a one-sided strip would eat the evidence. A bare `snake_case_name.py` is untouched for
 *  the same reason (no leading marker at all). */
function stripEmphasis(tok: string): string {
  let s = tok;
  for (;;) {
    let next = s;
    for (const m of EMPHASIS) {
      if (s.length > 2 && s.startsWith(m) && s.endsWith(m)) { next = s.slice(1, -1); break; }
    }
    if (next === s) return s;
    s = next;
  }
}

/** Extract every path-like token from a free-form bullet line: strip backticks, collapse markdown
 *  links to their target, split on whitespace, trim surrounding punctuation (leading ([{"' ;
 *  trailing )]}"',.;:!? — a trailing "/" is deliberately KEPT so a directory component retains its
 *  dir-prefix match semantics), peel paired emphasis wrappers, and keep tokens that look like a path
 *  (contain "/" OR end with ".ext"). Unlike the table branch (first cell only), bullets are
 *  unstructured prose, so all tokens are scanned.
 *
 *  The decoration strip (2026-08-23-brief-path-correctness-design.md, C4) is WIDENING-ONLY: the
 *  tokens it changes — `**tests/a.test.ts**`, `label](tests/a.test.ts` — are strings no diff path can
 *  ever equal, so no scope-check that passes today can start failing. Exported because `quick
 *  branch`'s brief lint scans a free-form brief that has no `## Components`/`## Testing` section to
 *  walk; it needs the token heuristic, not the section walk. */
export function pathTokensFrom(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/`/g, "").replace(MD_LINK, "$1").split(/\s+/)) {
    const trimmed = raw.replace(/^[(\[{"']+/, "").replace(/[)\]}"',.;:!?]+$/, "");
    const tok = stripEmphasis(trimmed);
    if (tok === "") continue;
    // A bare "/" is never a meaningful declaration, and under the explicit-directory match rule it
    // would put EVERY absolute diff path in scope — a scope gate that silently opens. Inert today
    // only because `git diff --name-only` emits repo-relative paths (62 such tokens sit in this
    // repo's own specs, declaring nothing), so dropping it removes zero in-scope paths; dropping a
    // declaration is also the safe direction, since it can only ADD out-of-scope paths, never hide
    // one (2026-08-23-declared-path-precision-design.md).
    if (tok === "/") continue;
    if (HAS_SLASH.test(tok) || ENDS_WITH_EXT.test(tok)) out.push(tok);
  }
  return out;
}

/** Walk one H2 section: its source lines, in document order, heading excluded. Shared by the path
 *  walk below and the Testing-bullet count, so the section bounds have one implementation. */
function sectionLines(docText: string, header: RegExp, prefix: RegExp): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const record of docText.split("\n")) {
    if (header.test(record)) { inSection = true; continue; }
    if (OTHER_H2.test(record) && !prefix.test(record)) { inSection = false; continue; }
    if (inSection) out.push(record);
  }
  return out;
}

/** Walk one H2 section: every source line that yields path-like tokens, paired with the tokens it
 *  yielded, in document order. */
function sectionPathsByLine(docText: string, header: RegExp, prefix: RegExp): { line: string; paths: string[] }[] {
  const out: { line: string; paths: string[] }[] = [];
  for (const record of sectionLines(docText, header, prefix)) {
    if (TABLE_ROW.test(record)) {
      if (SEPARATOR_ROW.test(record)) continue;
      let line = record;
      line = line.replace(/^[ \t]*\|[ \t]*/, "");
      line = line.replace(/[ \t]*\|.*$/, "");
      line = line.replace(/`/g, "");
      line = line.replace(/^[ \t]+/, "");
      line = line.replace(/[ \t]+$/, "");
      if (HEADER_CELL.test(line)) continue;
      if (HAS_SLASH.test(line) || ENDS_WITH_EXT.test(line)) out.push({ line: record, paths: [line] });
    } else {
      // Any non-table line in the section — a bullet OR free prose. Strip an optional leading bullet
      // marker, then harvest every path-like token. A prose sentence that names a path ("we touch
      // `src/a.ts`") is now in-scope, where before it extracted nothing and flagged the whole diff.
      const paths = pathTokensFrom(record.replace(BULLET_MARKER, ""));
      if (paths.length > 0) out.push({ line: record, paths });
    }
  }
  return out;
}

/** The Components walk shared by extraction and the path lint. The lint needs the source line too
 *  because the `[on-box]` tag is line-level. */
function componentsPathsByLine(docText: string): { line: string; paths: string[] }[] {
  return sectionPathsByLine(docText, COMPONENTS_HEADER, ANY_COMPONENTS_PREFIX);
}

/** Port of deploy_extract_components_paths (deploy-scope:26-55), extended (2026-06-10, 2026-06-19).
 *  Locates the `## Components` section and extracts: the first cell of every markdown table row, AND
 *  every path-like token of every NON-table line within it (bullets AND prose) — backticks stripped,
 *  trimmed, keeping tokens that contain `/` OR end with `.ext`. Skips the separator row, table header
 *  rows. Returns [] when no section / no path-like token. The table branch stays first-cell-only
 *  (structured columns); bullets and prose are unstructured, so every token is scanned. */
export function extractComponentsPaths(docText: string): string[] {
  const out: string[] = [];
  for (const rec of componentsPathsByLine(docText)) out.push(...rec.paths);
  return out;
}

/** Extract path-like tokens from the design's `## Testing` section with Components semantics. */
export function extractTestingPaths(docText: string): string[] {
  const out: string[] = [];
  for (const rec of sectionPathsByLine(docText, TESTING_HEADER, ANY_TESTING_PREFIX)) out.push(...rec.paths);
  return out;
}

/** A declared token that names a FILE (carries an extension) or an explicit directory (trailing
 *  `/`) — as opposed to a slash-bearing prose fragment like `Spec/metrics` or `D15/D16/D17`. */
export function fileShaped(tok: string): boolean {
  return ENDS_WITH_EXT.test(tok) || tok.endsWith("/");
}

/** Split the `## Testing` section's BULLETS by whether the bullet names a TEST FILE
 *  (2026-08-23-brief-path-correctness-design.md, C3). The first 0.5.44 field run reported
 *  `OOS_COUNT=2` against `TESTING_DECLARED=10` because two bullets were pure behavior prose
 *  ("loss-contract gate enrollment") naming no file, while the ten that parsed spelled the path out.
 *  The parser was right and the authoring was incomplete, so the measurement is PER BULLET: a
 *  section-level "parsed zero paths" check would not have fired on that doc at all.
 *
 *  FILE-SHAPED, not merely path-shaped, and that distinction is the whole signal. Measured against
 *  the verbatim field section, `pathTokensFrom` alone scores the very bullet that omitted
 *  `tests/spec/test_tasks.py` as having a path, because `Spec/metrics`, `value_range/aux_shape` and
 *  `elif/raise` are slash-bearing PROSE. A counter that cannot see the case it was built for is
 *  decoration, so a bullet counts as declaring only when some token carries a file extension or is
 *  an explicit trailing-`/` directory. On that same section the count goes 6/1 -> 3/4, which is the
 *  honest reading: four of seven bullets name no test file.
 *
 *  Note this is the COUNTER's rule only. `extractTestingPaths` (the scope verdict's input) still
 *  admits those prose fragments as declared paths — harmless in itself, since a fragment matches no
 *  diff path and every Testing rule STRICTLY WIDENS in-scope, but it does inflate
 *  `TESTING_DECLARED=`. Narrowing the verdict's own heuristic would turn passing scope-checks into
 *  failing ones, so it needs its own spec and dogfood; it is deliberately not done here.
 *
 *  Non-bullet prose and blank lines are not counted — the authoring rule is about bullets. Counts
 *  only; the caller warns and nothing here feeds a verdict or an rc. */
export function testingBulletsWithoutPaths(docText: string): { withPath: number; withoutPath: number } {
  let withPath = 0;
  let withoutPath = 0;
  for (const record of sectionLines(docText, TESTING_HEADER, ANY_TESTING_PREFIX)) {
    if (!BULLET_MARKER.test(record)) continue;
    if (pathTokensFrom(record.replace(BULLET_MARKER, "")).some(fileShaped)) withPath++;
    else withoutPath++;
  }
  return { withPath, withoutPath };
}

/** The declared tokens that resolve to NOTHING the matcher can key on: neither a file (a `.ext`) nor
 *  an explicit directory (a trailing `/`). Reuses `fileShaped`, so the C3 bullet counter and this
 *  report share ONE definition of "names a file". Order and duplicates are the caller's — the tokens
 *  come back in declaration order, filtered only.
 *
 *  REPORT, NEVER FILTER (2026-08-23-declared-path-precision-design.md). The tempting use of this
 *  function — narrowing the set handed to matchDiffAgainstComponents — is the one that must never
 *  happen: the matcher is a pure elementwise existential OR, so dropping a declaration can only move
 *  a diff path from in-scope to OUT-of-scope, i.e. turn a passing scope-check into a failing one (a
 *  200,000-trial fuzz: removal increased OOS 12,439 times and decreased it 0 times). The fragments
 *  it names are inert as declarations anyway — across all 206 tracked `.md` files, 0 of the dir-form
 *  tokens equal or dir-prefix any tracked file — so narrowing would buy nothing and risk that.
 *
 *  It reports a KNOWN false positive and that is deliberate: a bare `src/core` is a LEGAL implicit-
 *  directory declaration under match rule 3 and is shape-identical to the prose fragment
 *  `Spec/metrics`, so it is listed as unresolved. An existence check would "fix" that at the cost of
 *  making the verdict irreproducible from design.md + the diff alone; a report that quietly
 *  disagrees with the matcher is worse than one that over-reports. Warn/report only: nothing here
 *  feeds a verdict or an rc. */
export function unresolvedDeclaredPaths(declared: string[]): string[] {
  return declared.filter((tok) => !fileShaped(tok));
}

/** Warn-only Components path lint (2026-08-14-components-path-lint-design.md). Returns the declared
 *  Components paths that do NOT exist under `root` — absolute paths as-is, relative ones joined to
 *  `root`, trailing-`/` dirs checked as directories. A source line carrying the literal `[on-box]`
 *  tag is deliberately box-local: ALL of its paths are exempt. Callers warn; nothing here fails. */
export function lintComponentsPaths(docText: string, root: string): string[] {
  const out: string[] = [];
  for (const rec of componentsPathsByLine(docText)) {
    if (rec.line.includes(ON_BOX_TAG)) continue;
    for (const p of rec.paths) if (!existsSync(isAbsolute(p) ? p : join(root, p))) out.push(p);
  }
  return out;
}

/** The declared paths that EXIST in the main checkout but are MISSING in the run's target — the
 *  files a worktree run cannot see. Walks the Components section AND `## Testing` (the same two
 *  sections the scope guard already treats as declared scope), skipping `[on-box]` lines exactly as
 *  the lint does.
 *
 *  The exists-in-main AND missing-in-target conjunction is the whole point, not an optimisation. A
 *  plain missing-in-target check fires on every file the design intends to CREATE, which in this
 *  repo's docs is most of them, and a warning that fires every run is a warning nobody reads. Only
 *  the differential isolates "this path exists where you are standing and not where the run will
 *  stand" — which is exactly and only the uncommitted-file failure a worktree fork produces.
 *
 *  `resolve` rather than `join` so an ABSOLUTE declared path resolves to itself under both roots:
 *  the conjunction then reads `exists(p) && !exists(p)` and can never fire, which is right — an
 *  absolute path is the same file from either checkout. Warn-only; nothing here fails a run. */
export function pathsInvisibleInTarget(docText: string, mainRoot: string, targetCwd: string): string[] {
  const candidates: string[] = [];
  const lines = [...componentsPathsByLine(docText), ...sectionPathsByLine(docText, TESTING_HEADER, ANY_TESTING_PREFIX)];
  for (const rec of lines) {
    if (rec.line.includes(ON_BOX_TAG)) continue;
    candidates.push(...rec.paths);
  }
  return invisibleInTarget(candidates, mainRoot, targetCwd);
}

/** The exists-in-origin AND missing-in-target differential itself, over an already-collected path
 *  list, de-duplicated in first-seen order. Extracted so `quick branch`'s brief lint reuses this
 *  predicate instead of growing a second variant of it: a brief is free prose with no
 *  `## Components`/`## Testing` section, so it supplies its own candidates (via `pathTokensFrom`)
 *  and the conjunction — the part that must not drift — stays in one place. See
 *  `pathsInvisibleInTarget` above for why the conjunction, and not a plain missing-path check, is
 *  the whole point. */
export function invisibleInTarget(paths: string[], mainRoot: string, targetCwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (existsSync(resolve(mainRoot, p)) && !existsSync(resolve(targetCwd, p))) out.push(p);
  }
  return out;
}

/** Port of deploy_match_diff_against_components (deploy-scope:75-110), extended (2026-06-19). Returns
 *  the subset of `diffPaths` that are OUT of scope per `compPaths`. In-scope iff some comp path:
 *  (1) equals the diff path; (2) ends with "/" and the diff path starts with it; (3) does NOT end with
 *  "/" and the diff path starts with comp + "/". And, for a FILE-form comp (looks like a file —
 *  `ENDS_WITH_EXT`, so an extension-less "src/core" stays an implicit directory under rule 3):
 *  (4) comp is a bare filename (no "/") and the diff path's basename equals it; (5) comp is a full
 *  file path and the diff path is a sibling DIRECTLY in the same directory (one level, not a subtree).
 *  Rules 4-5 only widen scope. Both inputs are trimmed and empties dropped. */
export function matchDiffAgainstComponents(diffPaths: string[], compPaths: string[]): string[] {
  const comp: string[] = [];
  for (const raw of compPaths) {
    const line = raw.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (line === "") continue;
    comp.push(line);
  }
  const out: string[] = [];
  for (const raw of diffPaths) {
    const path = raw.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (path === "") continue;
    let inScope = false;
    for (const c of comp) {
      if (path === c) { inScope = true; break; }
      if (c.charAt(c.length - 1) === "/" && path.indexOf(c) === 0) { inScope = true; break; }
      if (c.charAt(c.length - 1) !== "/" && path.indexOf(c + "/") === 0) { inScope = true; break; }
      if (ENDS_WITH_EXT.test(c)) {
        // (4) bare filename declared -> any same-named file anywhere in the diff (exact basename).
        if (c.indexOf("/") < 0 && baseOf(path) === c) { inScope = true; break; }
        // (5) full file path declared -> a sibling DIRECTLY in the same directory (one level only).
        if (c.indexOf("/") >= 0 && parentOf(path) === parentOf(c)) { inScope = true; break; }
      }
    }
    if (!inScope) out.push(path);
  }
  return out;
}
