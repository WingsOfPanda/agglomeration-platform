// tests/design-assemble.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { designArtDir, designDraftDir, designDocPath } from "../src/core/design.js";
import { run as design } from "../src/commands/design.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

function scaffold(topic: string, sections: Record<string, string>) {
  const dd = designDraftDir(topic); mkdirSync(dd, { recursive: true });
  writeFileSync(join(designArtDir(topic), "topic.txt"), "My Topic Title");
  for (const [k, v] of Object.entries(sections)) writeFileSync(join(dd, `${k}.md`), v);
}

const FULL = {
  problem: "## Problem\n\np", goal: "## Goal\n\ng", architecture: "## Architecture\n\na",
  components: "## Components\n\nc", testing: "## Testing\n\nt", "success-criteria": "## Success Criteria\n\ns",
};

describe("design assemble", () => {
  it("audit PASS: writes the doc + audit.log, prints the doc path, rc 0", async () => {
    scaffold("ok-topic", FULL);
    const c = captureStdout();
    const rc = await design(["assemble", "ok-topic"]);
    c.restore();
    expect(rc).toBe(0);
    const date = new Date().toISOString().slice(0, 10);
    const docPath = designDocPath("ok-topic", date);
    expect(existsSync(docPath)).toBe(true);
    expect(readFileSync(docPath, "utf8")).toMatch(/^# My Topic Title\n/);
    expect(existsSync(join(designArtDir("ok-topic"), "design-doc", "audit.log"))).toBe(true);
    expect(c.text()).toContain(docPath);
  });
  it("audit FAIL (Goal draft lacks its heading): rc 1, emits ISSUE= lines", async () => {
    // A drafted goal.md whose body has no `## Goal` heading trips no_goal_section.
    // (A *missing* draft would emit assembleDoc's `## Goal\n\n_(missing draft)_`
    //  placeholder heading, which clone-wars' byte-identical audit accepts — so the
    //  failing case the directive's audit-retry handles is a mis-drafted heading.)
    const partial = { ...FULL, goal: "g (no heading here)" };
    scaffold("bad-topic", partial);
    const errs: string[] = [];
    const s = vi.spyOn(process.stderr, "write").mockImplementation(((x: unknown) => { errs.push(String(x)); return true; }) as never);
    const rc = await design(["assemble", "bad-topic"]);
    s.mockRestore();
    expect(rc).toBe(1);
    expect(errs.join("")).toContain("ISSUE=no_goal_section");
    expect(errs.join("")).toContain("SECTION=goal"); // mapped target for the directive's re-walk
  });
});

// ---- warn-only Components path lint (2026-08-14-components-path-lint-design.md) ----
// The lint resolves against repoRoot() — under vitest that is this repository, so `src/core/
// implementScope.ts` exists and `src/core/phantom-xyz.ts` does not. Every pin here doubles as a
// pin that the audit verdict/rc is untouched by the lint.
describe("design assemble: Components path lint", () => {
  const LINT = /Components path not found in this checkout/g;
  function withStderr(fn: () => Promise<number>): Promise<{ rc: number; err: string }> {
    const errs: string[] = [];
    const s = vi.spyOn(process.stderr, "write").mockImplementation(((x: unknown) => { errs.push(String(x)); return true; }) as never);
    return fn().then((rc) => { s.mockRestore(); return { rc, err: errs.join("") }; });
  }

  it("a phantom path warns once, names the path and the fix, and the audit STILL passes (rc 0)", async () => {
    scaffold("lint-phantom", { ...FULL, components: "## Components\n\n- `src/core/phantom-xyz.ts` — new helper" });
    const c = captureStdout();
    const { rc, err } = await withStderr(() => design(["assemble", "lint-phantom"]));
    c.restore();
    expect(rc).toBe(0);
    expect(err.match(LINT) ?? []).toHaveLength(1);
    expect(err).toContain("src/core/phantom-xyz.ts");
    expect(err).toContain("mark it [on-box] if it is deliberately box-local");
    // rc 0 means the doc still assembled and printed: the lint is advisory only.
    expect(readFileSync(join(designArtDir("lint-phantom"), "design-doc", "audit.log"), "utf8")).toBe("VERDICT=PASS\n");
  });

  it("an audit-FAIL doc still exits 1 with the ISSUE lines AND the phantom warn", async () => {
    scaffold("lint-fail", {
      ...FULL, goal: "g (no heading here)",
      components: "## Components\n\n- `src/core/phantom-xyz.ts` — new helper",
    });
    const { rc, err } = await withStderr(() => design(["assemble", "lint-fail"]));
    expect(rc).toBe(1);
    expect(err).toContain("ISSUE=no_goal_section");
    expect(err.match(LINT) ?? []).toHaveLength(1);
  });

  // Directive contract: the lint only pays off if both drafting paths teach the convention it
  // enforces. Pins are whitespace-collapsed so re-wrapping the prose does not break them.
  it("the [on-box] convention is documented in design.md's fast path AND walk, and in implement.md", () => {
    const flat = (p: string) => readFileSync(join(process.cwd(), "commands", p), "utf8").replace(/\s+/g, " ");
    const design = flat("design.md");
    const fastPath = design.slice(design.indexOf(".draft/components.md"), design.indexOf(".draft/testing.md"));
    expect(fastPath).toContain("must exist in the target checkout");
    expect(fastPath).toContain("[on-box]");
    const walkStep = design.slice(design.indexOf("**components**, additionally"), design.indexOf("## Stage 11"));
    expect(walkStep).toContain("must exist in the target checkout");
    expect(walkStep).toContain("[on-box]");
    const implement = flat("implement.md");
    expect(implement).toContain("Components path not found in this checkout");
    expect(implement).toContain("[on-box]");
  });

  it("paths that exist, and [on-box]-tagged paths, produce no warn at all", async () => {
    scaffold("lint-clean", {
      ...FULL,
      components: "## Components\n\n- `src/core/implementScope.ts` — edit\n- `~/.ap/contracts.yaml` [on-box] — read at spawn time",
    });
    const c = captureStdout();
    const { rc, err } = await withStderr(() => design(["assemble", "lint-clean"]));
    c.restore();
    expect(rc).toBe(0);
    expect(err.match(LINT) ?? []).toHaveLength(0);
  });
});
