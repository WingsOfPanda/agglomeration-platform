// tests/implement-scope-check.test.ts — scope-check (single-repo only).
// Single-repo cases lock the byte-identical legacy path (target_cwd.txt + branch-base.sha).
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { implementArtDir } from "../src/core/implement.js";
import { scopeCheckWith } from "../src/commands/implement.js";
import type { Runner, RunResult } from "../src/core/gitwork.js";

async function capture(fn: () => Promise<number>): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

describe("implement scope-check (single-repo path locked)", () => {
  it("single-repo: one out-of-scope path → scope-out-of-scope.txt + OOS_COUNT=1, rc 0", async () => {
    const h = freshHome();
    const art = implementArtDir("scope-s");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "branch-base.sha"), "BASE\n");
    writeFileSync(join(art, "design.md"),
      "# d\n\n## Components\n\n| File | Note |\n| --- | --- |\n| `src/a.ts` | x |\n");
    const deps = {
      runnerFor: (_cwd: string): Runner => ({
        run: (_c: string, _a: string[]): RunResult => ({ code: 0, stdout: "src/a.ts\nelsewhere/rogue.ts\n" }),
      }),
    };
    const { rc, out } = await capture(() => scopeCheckWith("scope-s", deps));
    expect(rc).toBe(0);
    expect(out).toContain("SCOPE_DECLARED=1\nTESTING_DECLARED=0\nOOS_COUNT=1\n");
    expect(readFileSync(join(art, "diff-paths.txt"), "utf8")).toBe("src/a.ts\nelsewhere/rogue.ts\n");
    expect(readFileSync(join(art, "testing-paths.txt"), "utf8")).toBe("");
    expect(readFileSync(join(art, "scope-out-of-scope.txt"), "utf8")).toBe("elsewhere/rogue.ts\n");
    h.cleanup();
  });

  it("single-repo: missing target_cwd.txt/branch-base.sha → rc 1", async () => {
    const h = freshHome();
    const art = implementArtDir("scope-s2");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "design.md"), "# d\n\n## Components\n");
    const deps = { runnerFor: (_cwd: string): Runner => ({ run: (): RunResult => ({ code: 0, stdout: "" }) }) };
    expect(await scopeCheckWith("scope-s2", deps)).toBe(1);
    h.cleanup();
  });

  it("unions Components and Testing paths, dedupes the count, and writes separate artifacts", async () => {
    const h = freshHome();
    const art = implementArtDir("scope-decl");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "branch-base.sha"), "BASE\n");
    writeFileSync(join(art, "design.md"),
      "# d\n\n## Components\n\n- `src/a.ts` — edit\n\n## Testing\n\n- `src/a.ts` — shared\n- `tests/a.test.ts` — add\n");
    const deps = { runnerFor: (_cwd: string): Runner => ({ run: (): RunResult => ({ code: 0, stdout: "tests/a.test.ts\n" }) }) };
    const { rc, out, err } = await capture(() => scopeCheckWith("scope-decl", deps));
    expect(rc).toBe(0);
    expect(out).toContain("SCOPE_DECLARED=2\nTESTING_DECLARED=2\n");
    expect(out).toContain("OOS_COUNT=0\n");
    expect(readFileSync(join(art, "components-paths.txt"), "utf8")).toBe("src/a.ts\n");
    expect(readFileSync(join(art, "testing-paths.txt"), "utf8")).toBe("src/a.ts\ntests/a.test.ts\n");
    expect(readFileSync(join(art, "scope-out-of-scope.txt"), "utf8")).toBe("");
    // The path lint lives at assemble/audit time only: scope-check never lints, even though this
    // design's `src/a.ts` does not exist in the checkout.
    expect(err).not.toContain("not found in this checkout");
    h.cleanup();
  });

  it("Testing-only scope suppresses the zero-path warning and keeps the diff in scope", async () => {
    const h = freshHome();
    const art = implementArtDir("scope-testing-only");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "branch-base.sha"), "BASE\n");
    writeFileSync(join(art, "design.md"),
      "# d\n\n## Components\n\n## Testing\n\n- `tests/a.test.ts` — add\n");
    const deps = { runnerFor: (_cwd: string): Runner => ({ run: (): RunResult => ({ code: 0, stdout: "tests/a.test.ts\n" }) }) };
    const { rc, out, err } = await capture(() => scopeCheckWith("scope-testing-only", deps));
    expect(rc).toBe(0);
    expect(out).toContain("SCOPE_DECLARED=1\nTESTING_DECLARED=1\nOOS_COUNT=0\n");
    expect(readFileSync(join(art, "diff-paths.txt"), "utf8")).toBe("tests/a.test.ts\n");
    expect(readFileSync(join(art, "components-paths.txt"), "utf8")).toBe("");
    expect(readFileSync(join(art, "testing-paths.txt"), "utf8")).toBe("tests/a.test.ts\n");
    expect(readFileSync(join(art, "scope-out-of-scope.txt"), "utf8")).toBe("");
    expect(err).toBe("");
    h.cleanup();
  });

  it("empty-scope: SCOPE_DECLARED=0 on stdout + a WARN, OOS still computed", async () => {
    const h = freshHome();
    const art = implementArtDir("scope-empty");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "branch-base.sha"), "BASE\n");
    writeFileSync(join(art, "design.md"), "# d\n\n## Components\n\nprose only, no paths\n");
    const deps = { runnerFor: (_cwd: string): Runner => ({ run: (): RunResult => ({ code: 0, stdout: "src/a.ts\n" }) }) };
    const { rc, out, err } = await capture(() => scopeCheckWith("scope-empty", deps));
    expect(rc).toBe(0);
    expect(out).toContain("SCOPE_DECLARED=0\n");
    expect(out).toContain("TESTING_DECLARED=0\n");
    expect(out).toContain("OOS_COUNT=1\n");
    expect(readFileSync(join(art, "testing-paths.txt"), "utf8")).toBe("");
    expect(err).toContain("0 parseable scope paths");
    h.cleanup();
  });

  it("prose Components that names paths -> SCOPE_DECLARED>0, OOS is only the genuinely-unlisted file", async () => {
    const h = freshHome();
    const art = implementArtDir("scope-prose");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "branch-base.sha"), "BASE\n");
    writeFileSync(join(art, "design.md"),
      "# d\n\n## Components\n\nWe touch `src/a.ts` and `src/b.ts` to add the guard.\n");
    const deps = { runnerFor: (_cwd: string): Runner => ({ run: (): RunResult => ({ code: 0, stdout: "src/a.ts\nsrc/b.ts\nelsewhere/c.ts\n" }) }) };
    const { rc, out } = await capture(() => scopeCheckWith("scope-prose", deps));
    expect(rc).toBe(0);
    expect(out).toContain("SCOPE_DECLARED=2\n");
    expect(out).toContain("OOS_COUNT=1\n");
    expect(readFileSync(join(art, "scope-out-of-scope.txt"), "utf8")).toBe("elsewhere/c.ts\n");
    h.cleanup();
  });

  // ---- Declared-path precision (2026-08-23-declared-path-precision-design.md) ----
  // The report is computed ALONGSIDE the declared set, never subtracted from it. The fixture
  // declares a BARE `src/core` on purpose: it is a legal implicit-directory declaration (match rule
  // 3) and is shape-identical to the prose fragment `Spec/metrics`, so it is the standing guard
  // against a future contributor "fixing" the count by filtering the matcher's input — do that and
  // `src/core/x.ts` goes out of scope and OOS_COUNT flips 0 -> 1.
  it("unresolved counts report the prose fragments without moving the verdict", async () => {
    const h = freshHome();
    const art = implementArtDir("scope-unresolved");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "branch-base.sha"), "BASE\n");
    writeFileSync(join(art, "design.md"),
      "# d\n\n## Components\n\n- `src/core` — the guard module\n\n## Testing\n\n"
      + "- `tests/model/test_d19_temporal_graph.py` — MAP head shapes\n"
      + "- Spec/metrics gates: MAP TaskSpec construction rules; the converted elif/raise proven by a raise test.\n");
    const deps = { runnerFor: (_cwd: string): Runner => ({ run: (): RunResult => ({ code: 0, stdout: "src/core/x.ts\ntests/model/test_d19_temporal_graph.py\n" }) }) };
    const { rc, out } = await capture(() => scopeCheckWith("scope-unresolved", deps));
    expect(rc).toBe(0);
    // (a) the verdict is untouched: both diff paths are in scope, `src/core/x.ts` via the implicit
    // directory rule that a filtered matcher input would destroy.
    expect(out).toContain("OOS_COUNT=0\n");
    expect(readFileSync(join(art, "scope-out-of-scope.txt"), "utf8")).toBe("");
    // (b) the declared counts are exactly what they were before the report existed.
    expect(out).toContain("SCOPE_DECLARED=4\nTESTING_DECLARED=3\n");
    // (c) the report itself: 2 of the 3 Testing tokens and 1 of the 1 Components token are prose.
    expect(out).toContain("SCOPE_UNRESOLVED=1\nTESTING_UNRESOLVED=2\n");
    // (d) the artifact records the layer's own verdict — the deduped union in declaration order,
    // INCLUDING the known false positive `src/core`. A report that quietly disagreed with the
    // matcher would be worse than one that over-reports.
    expect(readFileSync(join(art, "scope-unresolved.txt"), "utf8")).toBe("src/core\nSpec/metrics\nelif/raise\n");
    h.cleanup();
  });

  it("a fully file-shaped design reports zero unresolved and an empty artifact", async () => {
    const h = freshHome();
    const art = implementArtDir("scope-unresolved-none");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "branch-base.sha"), "BASE\n");
    writeFileSync(join(art, "design.md"),
      "# d\n\n## Components\n\n- `src/a.ts` — edit\n\n## Testing\n\n- `tests/a.test.ts` — add\n");
    const deps = { runnerFor: (_cwd: string): Runner => ({ run: (): RunResult => ({ code: 0, stdout: "src/a.ts\n" }) }) };
    const { rc, out } = await capture(() => scopeCheckWith("scope-unresolved-none", deps));
    expect(rc).toBe(0);
    expect(out).toContain("SCOPE_UNRESOLVED=0\nTESTING_UNRESOLVED=0\n");
    expect(readFileSync(join(art, "scope-unresolved.txt"), "utf8")).toBe("");
    h.cleanup();
  });

  it("same-dir siblings of an exact-file Components entry are in scope (OOS_COUNT=0)", async () => {
    const h = freshHome();
    const art = implementArtDir("scope-sibling");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "branch-base.sha"), "BASE\n");
    writeFileSync(join(art, "design.md"),
      "# d\n\n## Components\n\n- `src/core/verifier-receipt.ts` — the receipt module\n");
    const deps = { runnerFor: (_cwd: string): Runner => ({ run: (): RunResult => ({ code: 0, stdout: "src/core/oracle-guard.ts\nsrc/core/repro-receipt.ts\n" }) }) };
    const { rc, out } = await capture(() => scopeCheckWith("scope-sibling", deps));
    expect(rc).toBe(0);
    expect(out).toContain("OOS_COUNT=0\n");
    h.cleanup();
  });
});
