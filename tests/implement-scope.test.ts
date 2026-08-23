// tests/implement-scope.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractComponentsPaths, extractTestingPaths, lintComponentsPaths, matchDiffAgainstComponents, pathsInvisibleInTarget } from "../src/core/implementScope.js";

function doc(...lines: string[]): string { return lines.join("\n") + "\n"; }

describe("extractComponentsPaths", () => {
  it("extracts first-cell paths from the Components table, stripping backticks", () => {
    const d = doc("# Title", "## Goal", "do a thing", "## Components",
      "| File | Change |", "| ---- | ------ |", "| `src/core/foo.ts` | new |", "| `src/core/bar.ts` | edit |",
      "## Testing", "| `tests/should-not-appear.ts` | n/a |");
    expect(extractComponentsPaths(d)).toEqual(["src/core/foo.ts", "src/core/bar.ts"]);
  });
  it("returns [] when there is no Components section", () => {
    expect(extractComponentsPaths(doc("# T", "## Goal", "g", "## Testing", "t"))).toEqual([]);
  });
  it("returns [] when Components has no table", () => {
    expect(extractComponentsPaths(doc("## Components", "prose only, no table", "more prose"))).toEqual([]);
  });
  it("skips the separator row (only |, -, :, spaces)", () => {
    expect(extractComponentsPaths(doc("## Components", "| File |", "| :--- |", "| src/a.ts |"))).toEqual(["src/a.ts"]);
  });
  it("skips header-cell rows: File / Path / Name / Files edited|moved|touched", () => {
    const d = doc("## Components", "| File |", "| Path |", "| Name |", "| Files edited |", "| File moved |", "| Files touched |", "| src/keep.ts |");
    expect(extractComponentsPaths(d)).toEqual(["src/keep.ts"]);
  });
  it("path heuristic: keeps cells with a slash OR a .ext; drops bare words", () => {
    const d = doc("## Components", "| plainword | x |", "| README.md | x |", "| some/dir/ | x |", "| Makefile | x |");
    expect(extractComponentsPaths(d)).toEqual(["README.md", "some/dir/"]);
  });
  it("section ends at the next H2 heading (## something-else)", () => {
    expect(extractComponentsPaths(doc("## Components", "| src/in.ts | x |", "## Architecture", "| src/out.ts | x |"))).toEqual(["src/in.ts"]);
  });
  it("tolerates leading whitespace and a trailing pipe; trims the cell", () => {
    expect(extractComponentsPaths(doc("## Components", "   |  src/spaced.ts  |  notes  |"))).toEqual(["src/spaced.ts"]);
  });
  it("a Components heading with trailing whitespace still opens the section", () => {
    expect(extractComponentsPaths(doc("## Components   ", "| src/a.ts | x |"))).toEqual(["src/a.ts"]);
  });
  it("a non-exact Components heading (## Components (extra)) does NOT open the section", () => {
    expect(extractComponentsPaths(doc("## Components (extra)", "| src/a.ts | x |"))).toEqual([]);
  });
  it("bullet: extracts a backticked path", () => {
    expect(extractComponentsPaths(doc("## Components", "- `src/core/foo.ts` — add helper"))).toEqual(["src/core/foo.ts"]);
  });
  it("bullet: extracts a bare path with a trailing colon label", () => {
    expect(extractComponentsPaths(doc("## Components", "- src/core/bar.ts: edit"))).toEqual(["src/core/bar.ts"]);
  });
  it("bullet: extracts a path that appears mid-line", () => {
    expect(extractComponentsPaths(doc("## Components", "- add a helper to src/core/baz.ts"))).toEqual(["src/core/baz.ts"]);
  });
  it("bullet: extracts ALL path-like tokens from one bullet", () => {
    expect(extractComponentsPaths(doc("## Components", "- src/a.ts and src/b.ts"))).toEqual(["src/a.ts", "src/b.ts"]);
  });
  it("bullet: recognizes * and + markers", () => {
    expect(extractComponentsPaths(doc("## Components", "* src/star.ts", "+ src/plus.ts"))).toEqual(["src/star.ts", "src/plus.ts"]);
  });
  it("bullet: recognizes a nested/indented bullet", () => {
    expect(extractComponentsPaths(doc("## Components", "    - src/deep.ts"))).toEqual(["src/deep.ts"]);
  });
  it("bullet: trims surrounding punctuation but keeps a trailing slash", () => {
    expect(extractComponentsPaths(doc("## Components", "- `src/x.ts`,", "- (src/y.ts).", "- src/core/"))).toEqual(["src/x.ts", "src/y.ts", "src/core/"]);
  });
  it("bullet: drops bare words with no slash and no .ext", () => {
    expect(extractComponentsPaths(doc("## Components", "- just prose here", "- Makefile"))).toEqual([]);
  });
  it("bullet + table mixed in one section, document order", () => {
    const d = doc("## Components", "- src/bullet.ts", "| File | x |", "| `src/table.ts` | y |");
    expect(extractComponentsPaths(d)).toEqual(["src/bullet.ts", "src/table.ts"]);
  });
  it("bullet: a horizontal rule (---) is not a bullet and yields nothing", () => {
    expect(extractComponentsPaths(doc("## Components", "---"))).toEqual([]);
  });
  it("bullet: section still ends at the next H2 (bullet after ## Architecture not harvested)", () => {
    expect(extractComponentsPaths(doc("## Components", "- src/in.ts", "## Architecture", "- src/out.ts"))).toEqual(["src/in.ts"]);
  });
  it("over-match (accepted): a referenced path in a bullet IS pulled into scope", () => {
    expect(extractComponentsPaths(doc("## Components", "- see docs/DESIGN.md for context"))).toEqual(["docs/DESIGN.md"]);
  });
  it("prose: extracts backticked paths from a free prose line (no bullet, no table)", () => {
    expect(extractComponentsPaths(doc("## Components", "We touch `src/a.ts` and `src/b.ts`."))).toEqual(["src/a.ts", "src/b.ts"]);
  });
  it("prose: extracts a bare path mid-sentence", () => {
    expect(extractComponentsPaths(doc("## Components", "add a guard to src/core/foo.ts later"))).toEqual(["src/core/foo.ts"]);
  });
  it("prose: extracts a bare filename (basename only) mentioned in prose", () => {
    expect(extractComponentsPaths(doc("## Components", "the new oracle-guard.ts module"))).toEqual(["oracle-guard.ts"]);
  });
  it("prose-only section with a path-like token is no longer empty (the regression this fixes)", () => {
    expect(extractComponentsPaths(doc("## Components", "everything lives under src/core/scope.ts"))).toEqual(["src/core/scope.ts"]);
  });
  it("prose without any path-like token still yields []", () => {
    expect(extractComponentsPaths(doc("## Components", "this section is just descriptive prose"))).toEqual([]);
  });
  it("seed comment and the no-match placeholder contribute nothing", () => {
    const d = doc("## Components",
      "<!-- seed: claims tagged [Components] -->",
      "_(no seed content matched; Hub drafts from scratch in the design walk)_");
    expect(extractComponentsPaths(d)).toEqual([]);
  });
  it("table + bullet + prose mixed in one section, document order", () => {
    const d = doc("## Components", "intro prose names src/prose.ts here", "- src/bullet.ts", "| File | x |", "| `src/table.ts` | y |");
    expect(extractComponentsPaths(d)).toEqual(["src/prose.ts", "src/bullet.ts", "src/table.ts"]);
  });
  it("prose: section still ends at the next H2 (a path after ## Testing is NOT harvested)", () => {
    expect(extractComponentsPaths(doc("## Components", "names src/in.ts", "## Testing", "names src/out.ts"))).toEqual(["src/in.ts"]);
  });
});

describe("extractTestingPaths", () => {
  it("extracts Testing bullets, including directory form", () => {
    const d = doc("## Testing", "- `tests/unit/a.test.ts` — run", "- `tests/rehearsal/` — run all");
    expect(extractTestingPaths(d)).toEqual(["tests/unit/a.test.ts", "tests/rehearsal/"]);
  });
  it("extracts backticked and bare paths from Testing prose in document order", () => {
    const d = doc("## Testing", "Run `tests/a.test.ts` before tests/b.test.ts.");
    expect(extractTestingPaths(d)).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  });
  it("extracts only the first cell of Testing table rows", () => {
    const d = doc("## Testing", "| File | Note |", "| --- | --- |", "| `tests/a.test.ts` | not docs/ignored.md |");
    expect(extractTestingPaths(d)).toEqual(["tests/a.test.ts"]);
  });
  it("accepts trailing heading whitespace and stops at the next H2", () => {
    const d = doc("## Testing   ", "- tests/in.test.ts", "## Success Criteria", "- tests/out.test.ts");
    expect(extractTestingPaths(d)).toEqual(["tests/in.test.ts"]);
  });
  it("returns [] when there is no Testing section", () => {
    expect(extractTestingPaths(doc("## Components", "- src/a.ts"))).toEqual([]);
  });
  it("keeps Components extraction unchanged in a mixed document", () => {
    const d = doc("## Components", "- src/a.ts", "## Testing", "- tests/a.test.ts");
    expect(extractComponentsPaths(d)).toEqual(["src/a.ts"]);
    expect(extractTestingPaths(d)).toEqual(["tests/a.test.ts"]);
  });
});

describe("matchDiffAgainstComponents", () => {
  it("empty output when every diff path matches a comp path exactly", () => {
    expect(matchDiffAgainstComponents(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"])).toEqual([]);
  });
  it("flags diff paths not covered by any comp path", () => {
    // rogue is in a DIFFERENT directory so it stays out of scope under the same-dir-sibling rule.
    expect(matchDiffAgainstComponents(["src/a.ts", "other/rogue.ts"], ["src/a.ts"])).toEqual(["other/rogue.ts"]);
  });
  it("explicit dir comp (trailing slash) covers anything beneath it", () => {
    expect(matchDiffAgainstComponents(["src/core/deep/x.ts"], ["src/core/"])).toEqual([]);
  });
  it("implicit dir comp (no trailing slash) covers descendants via comp + '/'", () => {
    expect(matchDiffAgainstComponents(["src/core/x.ts"], ["src/core"])).toEqual([]);
  });
  it("implicit dir comp does NOT cover a sibling sharing the prefix without a slash boundary", () => {
    expect(matchDiffAgainstComponents(["src/coreutils.ts"], ["src/core"])).toEqual(["src/coreutils.ts"]);
  });
  it("trims whitespace and drops empty lines in both inputs", () => {
    expect(matchDiffAgainstComponents(["  src/a.ts  ", "", "   "], ["  src/a.ts  ", ""])).toEqual([]);
  });
  it("explicit dir prefix only matches when diff starts with the full trailing-slash path", () => {
    expect(matchDiffAgainstComponents(["src/coreother/x.ts"], ["src/core/"])).toEqual(["src/coreother/x.ts"]);
  });
  it("returns the out-of-scope paths in diff order", () => {
    expect(matchDiffAgainstComponents(["src/a.ts", "x/z.ts", "src/b.ts", "y/w.ts"], ["src/a.ts", "src/b.ts"])).toEqual(["x/z.ts", "y/w.ts"]);
  });
  it("(4) bare filename comp matches a fuller diff path by basename", () => {
    expect(matchDiffAgainstComponents(["src/x/oracle-guard.ts"], ["oracle-guard.ts"])).toEqual([]);
  });
  it("(4) bare filename comp matches only on EXACT basename (not a near-name)", () => {
    expect(matchDiffAgainstComponents(["src/x/oracle-guards.ts"], ["oracle-guard.ts"])).toEqual(["src/x/oracle-guards.ts"]);
  });
  it("(5) full file comp admits a sibling directly in the same directory", () => {
    expect(matchDiffAgainstComponents(["src/x/oracle-guard.ts"], ["src/x/verifier-receipt.ts"])).toEqual([]);
  });
  it("(5) full file comp does NOT admit a deeper file (sibling is one level only)", () => {
    expect(matchDiffAgainstComponents(["src/x/sub/c.ts"], ["src/x/a.ts"])).toEqual(["src/x/sub/c.ts"]);
  });
  it("(5) full file comp does NOT admit a file in a different directory", () => {
    expect(matchDiffAgainstComponents(["src/y/a.ts"], ["src/x/a.ts"])).toEqual(["src/y/a.ts"]);
  });
  it("extension-less comp stays an implicit DIRECTORY, so a clean sibling FILE is still out of scope", () => {
    // 'src/core' has no extension -> rules 4/5 are gated off; rule 3 (implicit dir) governs.
    expect(matchDiffAgainstComponents(["src/other.ts"], ["src/core"])).toEqual(["src/other.ts"]);
  });
  it("Testing dir plus named files covers the xjp nine-path diff shape", () => {
    const declared = extractTestingPaths(doc("## Testing",
      "- `tests/rehearsal/`",
      "- `tests/rehearsal-cmd.test.ts` and `tests/rehearsal-core.test.ts`",
      "- `tests/rehearsal-result.test.ts` and `tests/rehearsal-inspector.test.ts`",
      "- `tests/rehearsal-metric.test.ts` and `tests/rehearsal-template.test.ts`"));
    const diff = [
      "tests/rehearsal/a.test.ts", "tests/rehearsal/b.test.ts", "tests/rehearsal/deep/c.test.ts",
      "tests/rehearsal-cmd.test.ts", "tests/rehearsal-core.test.ts", "tests/rehearsal-result.test.ts",
      "tests/rehearsal-inspector.test.ts", "tests/rehearsal-metric.test.ts", "tests/rehearsal-template.test.ts",
    ];
    expect(matchDiffAgainstComponents(diff, declared)).toEqual([]);
  });
});

// ---- lintComponentsPaths (2026-08-14-components-path-lint-design.md) ----
// Warn-only authoring check: which declared Components paths are absent from the checkout. It must
// never influence extraction or the scope verdict — it only names paths for a log.warn.
describe("lintComponentsPaths", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ap-lint-"));
    mkdirSync(join(root, "src", "core"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "core", "real.ts"), "");
    writeFileSync(join(root, "README.md"), "");
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it("reports a missing relative path and stays silent on an existing one", () => {
    const d = doc("## Components", "- `src/core/real.ts` — edit", "- `src/core/phantom.ts` — new");
    expect(lintComponentsPaths(d, root)).toEqual(["src/core/phantom.ts"]);
  });
  it("reports a missing ABSOLUTE path as-is (never re-joined to root)", () => {
    const abs = join(root, "src", "core", "gone.ts");
    expect(lintComponentsPaths(doc("## Components", `- ${abs} — new`), root)).toEqual([abs]);
  });
  it("an existing ABSOLUTE path is silent", () => {
    expect(lintComponentsPaths(doc("## Components", `- ${join(root, "README.md")} — edit`), root)).toEqual([]);
  });
  it("table rows are linted like bullets (first cell)", () => {
    const d = doc("## Components", "| File | Change |", "| ---- | ------ |",
      "| `src/core/real.ts` | edit |", "| `src/core/phantom.ts` | new |");
    expect(lintComponentsPaths(d, root)).toEqual(["src/core/phantom.ts"]);
  });
  it("[on-box] exempts EVERY path on its line, bullet or table row", () => {
    const d = doc("## Components",
      "- `~/.ap/contracts.yaml` and `~/.ap/agents.yaml` [on-box] — read at spawn time",
      "| `etc/box-local.conf` [on-box] | box config |",
      "- `src/core/phantom.ts` — new");
    expect(lintComponentsPaths(d, root)).toEqual(["src/core/phantom.ts"]);
  });
  it("[on-box] on one line does not exempt the next line", () => {
    const d = doc("## Components", "- `a/box.conf` [on-box] — box config", "- `a/other.conf` — repo config");
    expect(lintComponentsPaths(d, root)).toEqual(["a/other.conf"]);
  });
  it("trailing-slash dirs resolve as directories: existing dir silent, missing dir reported", () => {
    const d = doc("## Components", "- `src/core/` — the module", "- `src/gone/` — new module");
    expect(lintComponentsPaths(d, root)).toEqual(["src/gone/"]);
  });
  it("a prose line's tokens are linted too (same extraction as the guard)", () => {
    expect(lintComponentsPaths(doc("## Components", "we also touch `src/core/phantom.ts` here"), root)).toEqual(["src/core/phantom.ts"]);
  });
  it("no Components section → no warnings", () => {
    expect(lintComponentsPaths(doc("# T", "## Goal", "g", "## Testing", "- `src/core/phantom.ts`"), root)).toEqual([]);
  });
  it("reports missing paths in document order, and only from inside the section", () => {
    const d = doc("## Components", "- `x/one.ts`", "- `x/two.ts`", "## Testing", "- `x/three.ts`");
    expect(lintComponentsPaths(d, root)).toEqual(["x/one.ts", "x/two.ts"]);
  });
  it("does not disturb extraction: the same doc extracts every path, [on-box] included", () => {
    const d = doc("## Components", "- `src/core/real.ts` — edit", "- `etc/box.conf` [on-box] — box config");
    expect(extractComponentsPaths(d)).toEqual(["src/core/real.ts", "etc/box.conf"]);
  });
});

// ---- pathsInvisibleInTarget (2026-08-23-worktree-truth-telling-design.md) ----
// The differential a worktree run needs: which cited paths exist where the OPERATOR stands and not
// where the WORKER will stand. The exists-in-main conjunct is the whole point — without it the
// report fires on every file a design intends to CREATE, which is most of them.
describe("pathsInvisibleInTarget", () => {
  let main: string;
  let target: string;
  beforeAll(() => {
    main = mkdtempSync(join(tmpdir(), "ap-inv-main-"));
    target = mkdtempSync(join(tmpdir(), "ap-inv-tgt-"));
    for (const r of [main, target]) writeFileSync(join(r, "keep.ts"), "");
    writeFileSync(join(main, "spec.md"), "");              // uncommitted: in the checkout, not the fork
    mkdirSync(join(main, "etc"), { recursive: true });
    writeFileSync(join(main, "etc", "box.conf"), "");
    mkdirSync(join(main, "tests"), { recursive: true });
    writeFileSync(join(main, "tests", "only-here.test.ts"), "");
  });
  afterAll(() => { for (const r of [main, target]) rmSync(r, { recursive: true, force: true }); });

  it("returns ONLY the path present in main and missing in the target", () => {
    const d = doc("## Components", "- `keep.ts` — edit", "- `new.ts` — the file this design creates", "- `spec.md` — the design itself");
    expect(pathsInvisibleInTarget(d, main, target)).toEqual(["spec.md"]);
  });
  it("an [on-box] line is exempt, however invisible its paths are", () => {
    const d = doc("## Components", "- `etc/box.conf` [on-box] — read at spawn time");
    expect(pathsInvisibleInTarget(d, main, target)).toEqual([]);
  });
  it("a ## Testing path present only in main is reported too", () => {
    const d = doc("## Components", "- `keep.ts` — edit", "## Testing", "- `tests/only-here.test.ts` — the new case");
    expect(pathsInvisibleInTarget(d, main, target)).toEqual(["tests/only-here.test.ts"]);
  });
  it("says nothing when the two roots are the same directory", () => {
    const d = doc("## Components", "- `keep.ts`", "- `spec.md`", "## Testing", "- `tests/only-here.test.ts`");
    expect(pathsInvisibleInTarget(d, main, main)).toEqual([]);
  });
});
