import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { topicDir } from "../src/core/paths.js";
import { quickArtDir, quickExecDir, deriveSlug, parseQuickArgs, detectTestCommand, renderSummary, renderResume } from "../src/core/quick.js";

afterEach(() => { delete process.env.AP_HOME; });

describe("quick paths", () => {
  it("quickArtDir/quickExecDir nest under the topic dir", () => {
    process.env.AP_HOME = "/R";
    expect(quickArtDir("auth")).toBe(join(topicDir("auth"), "_quick"));
    expect(quickExecDir("auth")).toBe(join(topicDir("auth"), "_quick", "execute"));
  });
});

describe("deriveSlug", () => {
  it("lowercases, replaces non [a-z0-9-], collapses dashes, caps at 20, trims dashes", () => {
    expect(deriveSlug("Add OAuth login!")).toBe("add-oauth-login");
    expect(deriveSlug("  spaces   and---dashes  ")).toBe("spaces-and-dashes");
    expect(deriveSlug("A".repeat(40))).toBe("a".repeat(20));
    expect(deriveSlug("trailing dash exactly 20x-")).toBe("trailing-dash-exactl");
    expect(deriveSlug("!!!")).toBe("");
  });
});

describe("parseQuickArgs", () => {
  it("pulls --provider (space + = forms) out of the topic text", () => {
    expect(parseQuickArgs(["--provider=opencode", "tidy", "imports"]))
      .toEqual({ topicText: "tidy imports", provider: "opencode", finish: true });
    expect(parseQuickArgs(["fix", "--provider", "--no-finish", "bug"]))
      .toEqual({ topicText: "fix bug", provider: undefined, finish: false });
  });

  it("finish defaults to true; --no-finish opts out; legacy --finish still parses", () => {
    expect(parseQuickArgs(["add", "oauth", "login"]))
      .toEqual({ topicText: "add oauth login", provider: undefined, finish: true });
    expect(parseQuickArgs(["fix", "bug", "--no-finish"]))
      .toEqual({ topicText: "fix bug", provider: undefined, finish: false });
    expect(parseQuickArgs(["tidy", "imports", "--finish"]))
      .toEqual({ topicText: "tidy imports", provider: undefined, finish: true });
    expect(parseQuickArgs(["fix", "bug", "--provider", "agy"]))
      .toEqual({ topicText: "fix bug", provider: "agy", finish: true });
  });
});

describe("detectTestCommand (precedence)", () => {
  function fresh(): string { return mkdtempSync(join(tmpdir(), "quick-dt-")); }

  it("prefers tests/run.sh", () => {
    const r = fresh(); mkdirSync(join(r, "tests")); writeFileSync(join(r, "tests/run.sh"), "");
    writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    expect(detectTestCommand(r)).toBe("bash tests/run.sh");
  });
  it("then package.json test script", () => {
    const r = fresh(); writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(detectTestCommand(r)).toBe("npm test");
  });
  it("then Makefile test target", () => {
    const r = fresh(); writeFileSync(join(r, "Makefile"), "build:\n\tcc\ntest:\n\t./t\n");
    expect(detectTestCommand(r)).toBe("make test");
  });
  it("then pytest when pyproject + tests/ exist", () => {
    const r = fresh(); writeFileSync(join(r, "pyproject.toml"), ""); mkdirSync(join(r, "tests"));
    expect(detectTestCommand(r)).toBe("pytest");
  });
  it("then cargo test when Cargo.toml exists", () => {
    const r = fresh(); writeFileSync(join(r, "Cargo.toml"), "[package]\nname = \"x\"\n");
    expect(detectTestCommand(r)).toBe("cargo test");
  });
  it("then go test when go.mod exists", () => {
    const r = fresh(); writeFileSync(join(r, "go.mod"), "module example.com/x\n");
    expect(detectTestCommand(r)).toBe("go test ./...");
  });
  it("npm test still wins over a co-present Cargo.toml (precedence unchanged)", () => {
    const r = fresh();
    writeFileSync(join(r, "Cargo.toml"), "[package]\n");
    writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    expect(detectTestCommand(r)).toBe("npm test");
  });
  it("empty string when nothing detected", () => {
    expect(detectTestCommand(fresh())).toBe("");
  });
});

const okFacts = {
  topic: "auth", status: "ok" as const, started: "2026-05-29T06:00:00Z",
  ended: "2026-05-29T06:05:00Z", duration: 300, provider: "codex", agent: "bravo",
  branch: "feat/quick-auth", verify: "PASS (npm test)", diffStats: " 2 files changed, 9 insertions(+)",
  archived: "/arch/bravo-codex-...", targetCwd: "/proj", branchBase: "abc123",
};

describe("renderSummary", () => {
  it("ok summary has frontmatter + Result/Where-to-look sections", () => {
    const md = renderSummary(okFacts);
    expect(md).toMatch(/^---\ncommand: quick\ntopic: auth\nstatus: ok\n/);
    expect(md).toContain("duration_seconds: 300");
    expect(md).toContain("- Provider: codex");
    expect(md).toContain("- Branch: feat/quick-auth");
    expect(md).toContain("- Verify: PASS (npm test)");
    expect(md).toContain("git -C /proj checkout feat/quick-auth");
  });
  it("aborted summary carries the abort fields + RESUME pointer", () => {
    const md = renderSummary({ ...okFacts, status: "aborted", ended: undefined, duration: undefined,
      abortedPhase: "build", abortedGate: "worker-turn-failed", abortedReason: "turn failed twice (TS=failed)" });
    expect(md).toContain("status: aborted");
    expect(md).toContain("aborted_phase: build");
    expect(md).toContain("aborted_reason: turn failed twice (TS=failed)");
    expect(md).toContain("RESUME.md");
    expect(md).not.toContain("duration_seconds");
    expect(md).not.toContain("ended:");
  });
});

describe("renderResume", () => {
  it("points at the state dir + manual resume", () => {
    const md = renderResume({ topic: "auth", branch: "feat/quick-auth", artDir: "/s/_quick", phase: "build", gate: "worker-turn-failed" });
    expect(md).toContain("# RESUME — auth");
    expect(md).toContain("State dir: /s/_quick");
    expect(md).toContain("re-run /ap:quick");
  });
});
