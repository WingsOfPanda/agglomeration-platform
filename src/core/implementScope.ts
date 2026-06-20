// src/core/implementScope.ts
//
// SCOPE-CONFORMANCE guard for `implement` Phase A. Port of the prior bash plugin's scope-conformance
// helpers (deploy-scope), EXTENDED in ap (deliberate divergence) twice:
//   - docs/superpowers/specs/2026-06-10-perform-scope-bullets-design.md — extractComponentsPaths also
//     reads bullet-list Components, not only markdown table rows.
//   - docs/superpowers/specs/2026-06-19-implement-scope-prose-and-sibling-design.md — extraction also
//     reads PROSE lines in the section (every path-like token, not just bullets), and
//     matchDiffAgainstComponents tolerates a declared bare filename (basename match) and a
//     same-directory sibling of a declared file (one directory level), so a worker that renames or
//     splits a module in place is not flagged out-of-scope.
// deploy_extract_components_paths -> extractComponentsPaths,
// deploy_match_diff_against_components -> matchDiffAgainstComponents. The Bash helpers read files via
// awk; the TS ports take the already-read strings (file IO is the caller's concern). Table-row
// first-cell extraction, section bounds, separator/header skip, the path heuristic, and the exact /
// dir-prefix match rules are preserved; the prose/bullet token scan and the bare-name/sibling rules
// are the documented divergences. All new rules STRICTLY WIDEN in-scope — they can only suppress an
// OOS warning, never invent one, so they cannot turn a passing scope-check into a failing one.

const COMPONENTS_HEADER = /^## Components[ \t]*$/;
const OTHER_H2 = /^## [^ ]/;
const ANY_COMPONENTS_PREFIX = /^## Components/;
const TABLE_ROW = /^[ \t]*\|/;
const SEPARATOR_ROW = /^[ \t]*\|([ \t]*[:-]+[ \t]*\|)+[ \t]*$/;
const BULLET_MARKER = /^[ \t]*[-*+][ \t]+/;
const HEADER_CELL = /^(File|Path|Name|Files?[ \t]+(edited|moved|touched))$/;
const HAS_SLASH = /\//;
const ENDS_WITH_EXT = /\.[a-zA-Z]+$/;

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

/** Port of deploy_extract_components_paths (deploy-scope:26-55), extended (2026-06-10, 2026-06-19).
 *  Locates the `## Components` section and extracts: the first cell of every markdown table row, AND
 *  every path-like token of every NON-table line within it (bullets AND prose) — backticks stripped,
 *  trimmed, keeping tokens that contain `/` OR end with `.ext`. Skips the separator row, table header
 *  rows. Returns [] when no section / no path-like token. The table branch stays first-cell-only
 *  (structured columns); bullets and prose are unstructured, so every token is scanned. */
export function extractComponentsPaths(docText: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const record of docText.split("\n")) {
    if (COMPONENTS_HEADER.test(record)) { inSection = true; continue; }
    if (OTHER_H2.test(record) && !ANY_COMPONENTS_PREFIX.test(record)) { inSection = false; continue; }
    if (inSection && TABLE_ROW.test(record)) {
      if (SEPARATOR_ROW.test(record)) continue;
      let line = record;
      line = line.replace(/^[ \t]*\|[ \t]*/, "");
      line = line.replace(/[ \t]*\|.*$/, "");
      line = line.replace(/`/g, "");
      line = line.replace(/^[ \t]+/, "");
      line = line.replace(/[ \t]+$/, "");
      if (HEADER_CELL.test(line)) continue;
      if (HAS_SLASH.test(line) || ENDS_WITH_EXT.test(line)) out.push(line);
    } else if (inSection) {
      // Any non-table line in the section — a bullet OR free prose. Strip an optional leading bullet
      // marker, then harvest every path-like token. A prose sentence that names a path ("we touch
      // `src/a.ts`") is now in-scope, where before it extracted nothing and flagged the whole diff.
      out.push(...pathTokensFrom(record.replace(BULLET_MARKER, "")));
    }
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
