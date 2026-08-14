// tests/implement-init.test.ts — B2a: implement init verb (initWith core path).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { implementArtDir } from "../src/core/implement.js";
import { initWith, run as implementRun, type ImplementInitDeps } from "../src/commands/implement.js";

// A minimal design doc that satisfies auditDoc (title + the four required sections).
const PASSING_DOC =
  "# Add OAuth Login\n\n" +
  "## Goal\nShip OAuth.\n\n" +
  "## Architecture\nA token exchange.\n\n" +
  "## Testing\nUnit + integration.\n\n" +
  "## Success Criteria\nLogin works.\n";

// Same body but missing ## Goal → audit FAIL with no_goal_section.
const NO_GOAL_DOC =
  "# Add OAuth Login\n\n" +
  "## Architecture\nA token exchange.\n\n" +
  "## Testing\nUnit + integration.\n\n" +
  "## Success Criteria\nLogin works.\n";

function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any, ..._rest: any[]) => { buf += String(chunk); return true; };
  return { text: () => buf, restore: () => { (process.stderr as any).write = orig; } };
}

describe("implement init", () => {
  let h: { home: string; cleanup: () => void };
  let tmpRepo: string;
  let outSpy: ReturnType<typeof captureStdout>;
  let errSpy: ReturnType<typeof captureStderr>;
  let deps: ImplementInitDeps;

  beforeEach(() => {
    h = freshHome();
    // A real on-disk "repo" dir that detectProvider sees as a non-plugin repo → codex.
    tmpRepo = join(h.home, "repo");
    mkdirSync(tmpRepo, { recursive: true });
    deps = { repoRoot: () => tmpRepo };
    outSpy = captureStdout();
    errSpy = captureStderr();
  });
  afterEach(() => { outSpy.restore(); errSpy.restore(); h.cleanup(); });

  // Helper: write a design doc to a real path on disk and return it.
  function docFile(name: string, body: string): string {
    const p = join(h.home, name);
    writeFileSync(p, body);
    return p;
  }

  it("happy single-repo → rc 0, scaffolds _implement with all artifacts (no trailing \\n in topic.txt)", async () => {
    const p = docFile("2026-05-30-add-oauth-design.md", PASSING_DOC);
    const rc = await initWith([p], deps);
    expect(rc).toBe(0);
    const art = implementArtDir("add-oauth");
    expect(existsSync(art)).toBe(true);
    expect(readFileSync(join(art, "topic.txt"), "utf8")).toBe("add-oauth"); // NO trailing newline
    expect(readFileSync(join(art, "target_cwd.txt"), "utf8")).toBe(tmpRepo + "\n");
    expect(readFileSync(join(art, "provider.txt"), "utf8")).toBe("codex\n");
    expect(readFileSync(join(art, "design.md"), "utf8")).toBe(PASSING_DOC);
    const out = outSpy.text();
    expect(out).toContain(`ART=${art}`);
    expect(out).toContain("TOPIC=add-oauth");
    expect(out).toContain("PROVIDER=codex");
    expect(out).toContain(`TARGET_CWD=${tmpRepo}`);
  });

  it("audit FAIL (missing ## Goal) → rc 1, ISSUE on stderr, NO _implement dir", async () => {
    const p = docFile("2026-05-30-add-oauth-design.md", NO_GOAL_DOC);
    const rc = await initWith([p], deps);
    expect(rc).toBe(1);
    expect(errSpy.text()).toContain("ISSUE=no_goal_section");
    expect(existsSync(implementArtDir("add-oauth"))).toBe(false);
  });

  it("in-flight (art dir pre-exists) → rc 2", async () => {
    mkdirSync(implementArtDir("add-oauth"), { recursive: true });
    const p = docFile("2026-05-30-add-oauth-design.md", PASSING_DOC);
    expect(await initWith([p], deps)).toBe(2);
  });

  it("--max-rounds 3 → rc 2 (ImplementArgError bubbles via e.code)", async () => {
    const p = docFile("2026-05-30-add-oauth-design.md", PASSING_DOC);
    expect(await initWith(["--max-rounds", "3", p], deps)).toBe(2);
  });

  it("two positionals → rc 2", async () => {
    const a = docFile("a-design.md", PASSING_DOC);
    const b = docFile("b-design.md", PASSING_DOC);
    expect(await initWith([a, b], deps)).toBe(2);
  });

  it("zero positionals → rc 2", async () => {
    expect(await initWith([], deps)).toBe(2);
  });

  it("unreadable design path → rc 1", async () => {
    expect(await initWith([join(h.home, "nope-design.md")], deps)).toBe(1);
  });

  it("--topic custom overrides the derived topic", async () => {
    const p = docFile("2026-05-30-add-oauth-design.md", PASSING_DOC);
    const rc = await initWith(["--topic", "custom", p], deps);
    expect(rc).toBe(0);
    expect(existsSync(implementArtDir("custom"))).toBe(true);
    expect(readFileSync(join(implementArtDir("custom"), "topic.txt"), "utf8")).toBe("custom");
    expect(outSpy.text()).toContain("TOPIC=custom");
  });

  it("over-length --topic → rc 2 and scaffolds nothing", async () => {
    const p = docFile("2026-05-30-add-oauth-design.md", PASSING_DOC);
    const badTopic = "demo-repo-simplify-sweep-2-tiers-bce"; // 36 chars
    const rc = await initWith(["--topic", badTopic, p], deps);
    expect(rc).toBe(2);
    expect(existsSync(implementArtDir(badTopic))).toBe(false);
    expect(errSpy.text()).toContain("--topic");
  });

  // ---- audit verb (standalone "Proceed anyway" precheck — deploy parity) ----
  it("audit verb: passing doc → rc 0", async () => {
    const p = docFile("good-design.md", PASSING_DOC);
    expect(await implementRun(["audit", p])).toBe(0);
  });

  it("audit verb: failing doc (missing ## Goal) → rc 1, ISSUE on stderr", async () => {
    const p = docFile("bad-design.md", NO_GOAL_DOC);
    expect(await implementRun(["audit", p])).toBe(1);
    expect(errSpy.text()).toContain("ISSUE=no_goal_section");
  });

  it("audit verb: nonexistent path → rc 2 (unreadable)", async () => {
    expect(await implementRun(["audit", join(h.home, "nope-design.md")])).toBe(2);
  });

  it("audit verb: missing arg → rc 2", async () => {
    expect(await implementRun(["audit"])).toBe(2);
  });

  // ---- warn-only Components path lint (2026-08-14-components-path-lint-design.md) ----
  // Resolved against repoRoot(), which under vitest is this repository: `src/core/implementScope.ts`
  // exists, `src/core/phantom-xyz.ts` does not. The rc is the audit's alone in every case.
  const LINT = /implement audit: Components path not found in this checkout/g;

  it("audit verb: a phantom Components path warns once and the doc STILL passes (rc 0)", async () => {
    const p = docFile("phantom-design.md", PASSING_DOC + "\n## Components\n\n- `src/core/phantom-xyz.ts` — new helper\n");
    expect(await implementRun(["audit", p])).toBe(0);
    expect(errSpy.text().match(LINT) ?? []).toHaveLength(1);
    expect(errSpy.text()).toContain("src/core/phantom-xyz.ts");
    expect(errSpy.text()).toContain("mark it [on-box] if it is deliberately box-local");
  });

  it("audit verb: an audit-FAIL doc still returns rc 1, with both the ISSUE and the phantom warn", async () => {
    const p = docFile("phantom-bad-design.md", NO_GOAL_DOC + "\n## Components\n\n- `src/core/phantom-xyz.ts` — new helper\n");
    expect(await implementRun(["audit", p])).toBe(1);
    expect(errSpy.text()).toContain("ISSUE=no_goal_section");
    expect(errSpy.text().match(LINT) ?? []).toHaveLength(1);
  });

  it("audit verb: existing paths and [on-box]-tagged paths produce no warn", async () => {
    const p = docFile("clean-design.md", PASSING_DOC +
      "\n## Components\n\n- `src/core/implementScope.ts` — edit\n- `~/.ap/contracts.yaml` [on-box] — read at spawn time\n");
    expect(await implementRun(["audit", p])).toBe(0);
    expect(errSpy.text().match(LINT) ?? []).toHaveLength(0);
  });

  // ---- init --force (bypass an audit FAIL — deploy "Proceed anyway") ----
  it("init WITHOUT --force on a failing doc → rc 1 (audit FAIL not bypassed)", async () => {
    const p = docFile("2026-05-30-add-oauth-design.md", NO_GOAL_DOC);
    expect(await initWith([p], deps)).toBe(1);
    expect(existsSync(implementArtDir("add-oauth"))).toBe(false);
  });

  it("init WITH --force on a failing doc → rc 0, scaffolds, writes auto_provider.txt", async () => {
    const p = docFile("2026-05-30-add-oauth-design.md", NO_GOAL_DOC);
    const rc = await initWith(["--force", p], deps);
    expect(rc).toBe(0);
    const art = implementArtDir("add-oauth");
    expect(existsSync(art)).toBe(true);
    expect(readFileSync(join(art, "auto_provider.txt"), "utf8")).toMatch(/codex|claude/);
  });

  it("init WITH --force on a PASSING doc → rc 0, still writes auto_provider.txt", async () => {
    const p = docFile("2026-05-30-add-oauth-design.md", PASSING_DOC);
    const rc = await initWith(["--force", p], deps);
    expect(rc).toBe(0);
    const art = implementArtDir("add-oauth");
    expect(readFileSync(join(art, "auto_provider.txt"), "utf8")).toBe("codex\n");
  });
});
