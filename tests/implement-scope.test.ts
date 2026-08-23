// tests/implement-scope.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractComponentsPaths, extractTestingPaths, fileShaped, lintComponentsPaths, matchDiffAgainstComponents, pathsInvisibleInTarget, testingBulletsWithoutPaths, unresolvedDeclaredPaths } from "../src/core/implementScope.js";

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

// ---- C4 decoration strip (2026-08-23-brief-path-correctness-design.md) ----
// pathTokensFrom strips PAIRED markdown emphasis and collapses `[label](target)` links before the
// path heuristic, so a decorated citation yields the path instead of an unmatchable token. Widening
// only: the tokens it changes are strings no diff path can ever equal.
describe("pathTokensFrom decoration strip", () => {
  it("bold: ** ** wrappers are peeled (two single-marker passes)", () => {
    expect(extractTestingPaths(doc("## Testing", "- Extend **`tests/a.test.ts`**"))).toEqual(["tests/a.test.ts"]);
  });
  it("markdown link: collapsed to its target, spaced label and all", () => {
    expect(extractTestingPaths(doc("## Testing", "- see [tests/a.test.ts](tests/a.test.ts)"))).toEqual(["tests/a.test.ts"]);
    expect(extractTestingPaths(doc("## Testing", "- see [the new case](tests/a.test.ts)"))).toEqual(["tests/a.test.ts"]);
  });
  it("italic: a paired _ wrapper is peeled", () => {
    expect(extractTestingPaths(doc("## Testing", "- _tests/a.test.ts_"))).toEqual(["tests/a.test.ts"]);
  });

  // NON-REGRESSION. The strip is strictly PAIRED at token boundaries. `_quick/topic-text.txt` opens
  // with `_` and does not close with one; it is the exact citation quick's brief lint exists to
  // catch, so eating its leading underscore would defeat the feature that motivated this change.
  it("NON-REGRESSION: a leading-underscore state path survives intact", () => {
    expect(extractTestingPaths(doc("## Testing", "- the brief cites `_quick/topic-text.txt`"))).toEqual(["_quick/topic-text.txt"]);
    expect(extractTestingPaths(doc("## Testing", "- `_implement/execute/`"))).toEqual(["_implement/execute/"]);
  });
  it("NON-REGRESSION: a bare snake_case filename is unchanged", () => {
    expect(extractTestingPaths(doc("## Testing", "- run snake_case_name.py"))).toEqual(["snake_case_name.py"]);
    expect(extractTestingPaths(doc("## Testing", "- tests/model/test_d19_temporal_graph.py"))).toEqual(["tests/model/test_d19_temporal_graph.py"]);
  });
  it("NON-REGRESSION: the parenthesized field form still parses, as before", () => {
    expect(extractTestingPaths(doc("## Testing", "- MAP rules (`tests/model/test_d19_temporal_graph.py`):"))).toEqual(["tests/model/test_d19_temporal_graph.py"]);
  });

  // Success Criterion 4: no scope-check that passes today changes verdict. Asserted against a
  // SHIPPED design doc in this repo (not a synthetic string): the values below were captured from
  // the pre-C4 extractor, so a strip that narrowed anything would move them.
  it("an existing shipped design doc extracts exactly what it did before C4", () => {
    const shipped = readFileSync(join(process.cwd(), "docs", "superpowers", "specs", "2026-08-23-worktree-truth-telling-design.md"), "utf8");
    expect(extractComponentsPaths(shipped)).toEqual([
      "src/core/job.ts", "src/commands/job.ts", "WORKTREE=/START_BRANCH=/DRIFT=",
      "src/core/implementScope.ts", "src/commands/implement.ts", "INVISIBLE_IN_TARGET=/INVISIBLE_PATH=",
      "<art>/path-lint.txt", "commands/implement.md", "commands/job.md", "tests/job-worktree.test.ts",
      "tests/job.test.ts", "tests/implement-scope.test.ts", "tests/implement-init.test.ts", "dist/ap.cjs",
    ]);
    expect(extractTestingPaths(shipped)).toEqual([
      "tests/job-worktree.test.ts", "process.chdir(<root>/.ap/worktrees/demo", "tests/job-worktree.test.ts",
      ".ap/worktrees/", "tests/job-worktree.test.ts", "docs/spec.md", "tests/job-worktree.test.ts",
      "tests/implement-scope.test.ts", "keep.ts", "new.ts", "spec.md", "spec.md", "new.ts",
      "tests/implement-init.test.ts", "<art>/path-lint.txt", "tests/job.test.ts",
    ]);
    // …and the verdict those paths produce is unchanged: one rogue path, out of scope.
    expect(matchDiffAgainstComponents(
      ["src/core/job.ts", "tests/job.test.ts", "commands/quick.md", "src/core/nowhere/rogue.ts"],
      [...extractComponentsPaths(shipped), ...extractTestingPaths(shipped)],
    )).toEqual(["src/core/nowhere/rogue.ts"]);
  });
});

// ---- C3 testingBulletsWithoutPaths (2026-08-23-brief-path-correctness-design.md) ----
// The 0.5.44 field failure, reconstructed: ten Testing bullets spelled the path out, two were pure
// behavior prose. The parser was right; the authoring was incomplete. Counted PER BULLET, because a
// section-level "parsed zero paths" check would not have fired on that doc at all.
describe("testingBulletsWithoutPaths", () => {
  const FIELD = doc(
    "# D19", "## Testing",
    "- `tests/model/test_d19_temporal_graph.py` — MAP head shapes",
    "- `tests/model/test_d19_heads.py` — head registry",
    "- `tests/model/test_d19_encoder.py` — encoder contract",
    "- `tests/training/test_d19_loop.py` — loop wiring",
    "- `tests/training/test_d19_sched.py` — scheduler",
    "- `tests/data/test_d19_windows.py` — window builder",
    "- `tests/data/test_d19_norm.py` — normalisation",
    "- `tests/spec/test_d19_registry.py` — registry round-trip",
    "- `tests/eval/test_d19_metrics.py` — metric parity",
    "- `tests/eval/test_d19_report.py` — report rendering",
    "- MAP TaskSpec construction rules (channels>=1; paired rejection tests)",
    "- loss-contract gate enrollment",
    "## Success Criteria", "- `tests/out-of-section.py` — not counted",
  );
  it("counts the field section as 10 with a path, 2 without", () => {
    expect(testingBulletsWithoutPaths(FIELD)).toEqual({ withPath: 10, withoutPath: 2 });
  });
  it("a fully-pathed section reports zero without", () => {
    const d = doc("## Testing", "- `tests/a.test.ts` — x", "- `tests/b.test.ts` — y");
    expect(testingBulletsWithoutPaths(d)).toEqual({ withPath: 2, withoutPath: 0 });
  });
  it("non-bullet prose and blank lines are not counted at all", () => {
    const d = doc("## Testing", "", "Run the suite before and after.", "", "- `tests/a.test.ts` — x", "");
    expect(testingBulletsWithoutPaths(d)).toEqual({ withPath: 1, withoutPath: 0 });
  });
  it("no Testing section → zero of both", () => {
    expect(testingBulletsWithoutPaths(doc("## Components", "- src/a.ts"))).toEqual({ withPath: 0, withoutPath: 0 });
  });
  it("a decorated bullet counts as path-bearing (C4 feeds this count)", () => {
    expect(testingBulletsWithoutPaths(doc("## Testing", "- **`tests/a.test.ts`** — x"))).toEqual({ withPath: 1, withoutPath: 0 });
  });

  // The fixture above is a RECONSTRUCTION whose prose bullets happen to carry no slash, so it
  // passes whether the count requires a file-shaped token or merely a path-shaped one. These are
  // the VERBATIM bullets from the 0.5.44 field doc, and they are the ones that discriminate: the
  // bullet that omitted `tests/spec/test_tasks.py` reads "Spec/metrics gates: ..." and is full of
  // slash-bearing PROSE. Counting any slash-bearing token as a path scores it 6/1 — the counter
  // blind to the exact case it exists for. Requiring a file extension (or a trailing-/ dir) scores
  // it 3/4, which is the honest reading.
  it("VERBATIM field bullets: slash-bearing prose is NOT a declared test file", () => {
    const VERBATIM = doc(
      "## Testing",
      "- All new gates CPU-capable in the default leg except the capacity tool and driver (GPU, explicit).",
      "- D19 (`tests/model/test_d19_temporal_graph.py`): every positive conjunct ships its executable mutant.",
      "- Loader gates (`tests/data_seam/test_frames.py`): the measured frame-0 (1,1,1) sentinel case.",
      "- Spec/metrics gates: MAP TaskSpec construction rules (channels>=1; value_range/aux_shape forbidden — paired rejection tests); measure_task MAP branch + the converted `elif`/raise proven by an unknown-Kind raise test; loss-contract gate enrollment.",
      "- Capacity record (`tests/model/temporal_capacity.json` + validation): sweep complete.",
      "- pmg overfit record validation: exact key-set, per-Kind loss/grad scale block present.",
      "- Existing suites stay green untouched: D15/D16/D17 pins, the trunk digest recomputation.",
      "## Success Criteria", "- s",
    );
    expect(testingBulletsWithoutPaths(VERBATIM)).toEqual({ withPath: 3, withoutPath: 4 });
  });

  it("an explicit trailing-slash directory counts as declared", () => {
    expect(testingBulletsWithoutPaths(doc("## Testing", "- everything under `tests/data_seam/` is re-run"))).toEqual({ withPath: 1, withoutPath: 0 });
  });
});

// ---- Declared-path precision (2026-08-23-declared-path-precision-design.md) ----
// A bare "/" is dropped at extraction, and the unresolved REPORT names the declared tokens the
// matcher cannot key on. Neither narrows what reaches matchDiffAgainstComponents.
describe("bare / is not a declaration", () => {
  it("a bare `/` token is dropped; a real trailing-slash directory still declares", () => {
    expect(extractComponentsPaths(doc("## Components", "- everything under / is in play"))).toEqual([]);
    expect(extractComponentsPaths(doc("## Components", "- `src/` and / together"))).toEqual(["src/"]);
    expect(extractTestingPaths(doc("## Testing", "- run / then `tests/`"))).toEqual(["tests/"]);
  });

  // WHY it matters, executed rather than asserted: under match rule 2 a declared "/" prefixes every
  // absolute path, so an absolute-path diff would land entirely in scope. Repo-relative diffs (what
  // `git diff --name-only` emits) are unaffected either way — dropping it removes nothing today.
  it("a declared `/` would have put an absolute diff path in scope", () => {
    expect(matchDiffAgainstComponents(["/etc/passwd"], ["/"])).toEqual([]);
    expect(matchDiffAgainstComponents(["/etc/passwd"], extractComponentsPaths(doc("## Components", "- /")))).toEqual(["/etc/passwd"]);
  });
});

describe("unresolvedDeclaredPaths", () => {
  it("keeps the slash-bearing prose fragments and drops file-shaped tokens", () => {
    expect(unresolvedDeclaredPaths([
      "tests/model/test_d19_temporal_graph.py", "Spec/metrics", "value_range/aux_shape",
      "elif/raise", "loss/grad", "D15/D16/D17", "tests/data_seam/",
    ])).toEqual(["Spec/metrics", "value_range/aux_shape", "elif/raise", "loss/grad", "D15/D16/D17"]);
  });
  it("an explicit trailing-slash directory is resolved; a bare implicit one is NOT (known false positive)", () => {
    expect(unresolvedDeclaredPaths(["src/core/", "src/core"])).toEqual(["src/core"]);
  });
  it("shares ONE definition of file-shaped with the C3 bullet counter", () => {
    expect(fileShaped("src/a.ts")).toBe(true);
    expect(fileShaped("tests/data_seam/")).toBe(true);
    expect(fileShaped("Spec/metrics")).toBe(false);
  });
  it("reports in declaration order, and reports nothing for a fully file-shaped set", () => {
    expect(unresolvedDeclaredPaths(["b/x", "src/a.ts", "a/y"])).toEqual(["b/x", "a/y"]);
    expect(unresolvedDeclaredPaths(["src/a.ts", "tests/", "name.py"])).toEqual([]);
    expect(unresolvedDeclaredPaths([])).toEqual([]);
  });
});
