import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { topicDir } from "../src/core/paths.js";
import { soloArtDir, soloExecDir, deriveSlug, parseSoloArgs, detectTestCommand } from "../src/core/solo.js";

afterEach(() => { delete process.env.CONSORT_HOME; });

describe("solo paths", () => {
  it("soloArtDir/soloExecDir nest under the topic dir", () => {
    process.env.CONSORT_HOME = "/R";
    expect(soloArtDir("auth")).toBe(join(topicDir("auth"), "_solo"));
    expect(soloExecDir("auth")).toBe(join(topicDir("auth"), "_solo", "execute"));
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

describe("parseSoloArgs", () => {
  it("pulls --provider (space + = forms) and --finish out of the topic text", () => {
    expect(parseSoloArgs(["add", "oauth", "login"]))
      .toEqual({ topicText: "add oauth login", provider: undefined, finish: false });
    expect(parseSoloArgs(["fix", "bug", "--provider", "agy"]))
      .toEqual({ topicText: "fix bug", provider: "agy", finish: false });
    expect(parseSoloArgs(["--provider=opencode", "tidy", "imports", "--finish"]))
      .toEqual({ topicText: "tidy imports", provider: "opencode", finish: true });
  });
});

describe("detectTestCommand (precedence)", () => {
  function fresh(): string { return mkdtempSync(join(tmpdir(), "solo-dt-")); }

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
  it("empty string when nothing detected", () => {
    expect(detectTestCommand(fresh())).toBe("");
  });
});
