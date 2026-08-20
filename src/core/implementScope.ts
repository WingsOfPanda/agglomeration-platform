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
// deploy_extract_components_paths -> extractComponentsPaths,
// deploy_match_diff_against_components -> matchDiffAgainstComponents. The Bash helpers read files via
// awk; the TS ports take the already-read strings (file IO is the caller's concern). Table-row
// first-cell extraction, section bounds, separator/header skip, the path heuristic, and the exact /
// dir-prefix match rules are preserved; the prose/bullet token scan, the Testing-section scope rule,
// and the bare-name/sibling rules are the documented divergences. All new rules STRICTLY WIDEN
// in-scope — they can only suppress an OOS warning, never invent one, so they cannot turn a passing
// scope-check into a failing one.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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

/** Extract every path-like token from a free-form bullet line: strip backticks, split on
 *  whitespace, trim surrounding punctuation (leading ([{"' ; trailing )]}"',.;:!? — a trailing
 *  "/" is deliberately KEPT so a directory component retains its dir-prefix match semantics), and
 *  keep tokens that look like a path (contain "/" OR end with ".ext"). Unlike the table branch
 *  (first cell only), bullets are unstructured prose, so all tokens are scanned. */
function pathTokensFrom(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/`/g, "").split(/\s+/)) {
    const tok = raw.replace(/^[(\[{"']+/, "").replace(/[)\]}"',.;:!?]+$/, "");
    if (tok === "") continue;
    if (HAS_SLASH.test(tok) || ENDS_WITH_EXT.test(tok)) out.push(tok);
  }
  return out;
}

/** Walk one H2 section: every source line that yields path-like tokens, paired with the tokens it
 *  yielded, in document order. */
function sectionPathsByLine(docText: string, header: RegExp, prefix: RegExp): { line: string; paths: string[] }[] {
  const out: { line: string; paths: string[] }[] = [];
  let inSection = false;
  for (const record of docText.split("\n")) {
    if (header.test(record)) { inSection = true; continue; }
    if (OTHER_H2.test(record) && !prefix.test(record)) { inSection = false; continue; }
    if (!inSection) continue;
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
