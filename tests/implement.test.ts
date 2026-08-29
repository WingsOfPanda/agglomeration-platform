// tests/implement.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  implementArtDir, deriveTopicFromPath, parseImplementArgs, ImplementArgError,
  detectProvider, targetCwd, assertImplementTopic,
} from "../src/core/implement.js";
import { topicDir } from "../src/core/paths.js";

function freshHome(): string { return mkdtempSync(join(tmpdir(), "perf-home-")); }

describe("implementArtDir", () => {
  it("art dir is <topicDir>/_implement", () => {
    const home = freshHome();
    expect(implementArtDir("foo", { home })).toBe(join(topicDir("foo", { home }), "_implement"));
  });
});

describe("deriveTopicFromPath", () => {
  it("strips YYYY-MM-DD- prefix and -design.md suffix", () => {
    expect(deriveTopicFromPath("docs/2026-05-09-deploy-multi-repo-dag-design.md")).toBe("deploy-multi-repo-dag");
  });
  it("strips .md when -design.md not present", () => {
    expect(deriveTopicFromPath("/a/b/2026-01-02-foo.md")).toBe("foo");
  });
  it("basename only (no leading date) -> strip suffix", () => {
    expect(deriveTopicFromPath("plain-design.md")).toBe("plain");
  });
  it("empty path -> empty string", () => { expect(deriveTopicFromPath("")).toBe(""); });
  it("no date, no .md -> basename unchanged", () => { expect(deriveTopicFromPath("/x/y/topicname")).toBe("topicname"); });
});

describe("parseImplementArgs", () => {
  it("default branch mode is branch-on; positional collected into rest", () => {
    const r = parseImplementArgs(["path/to/spec.md"]);
    expect(r.branchMode).toBe("branch");
    expect(r.rest).toBe("path/to/spec.md");
    expect(r.branchName).toBeUndefined();
    expect(r.topic).toBeUndefined();
  });
  it("--no-branch opts out", () => { expect(parseImplementArgs(["spec.md", "--no-branch"]).branchMode).toBe("no-branch"); });
  it("--branch <n> (space form) and --topic <slug>", () => {
    const r = parseImplementArgs(["spec.md", "--branch", "feat/x", "--topic", "mytopic"]);
    expect(r.branchName).toBe("feat/x"); expect(r.topic).toBe("mytopic"); expect(r.rest).toBe("spec.md");
  });
  it("--branch=<n> and --topic=<slug> (equals form)", () => {
    const r = parseImplementArgs(["spec.md", "--branch=feat/y", "--topic=tt"]);
    expect(r.branchName).toBe("feat/y"); expect(r.topic).toBe("tt");
  });
  it("--max-rounds (space form) is REJECTED at init (directive must strip it first)", () => {
    expect(() => parseImplementArgs(["spec.md", "--max-rounds", "3"])).toThrow(ImplementArgError);
  });
  it("--max-rounds=N (equals form) is also REJECTED", () => {
    expect(() => parseImplementArgs(["spec.md", "--max-rounds=5"])).toThrow(ImplementArgError);
  });
});

describe("detectProvider", () => {
  it("plugin repo (.claude-plugin/plugin.json) -> claude", () => {
    const root = mkdtempSync(join(tmpdir(), "dp-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), "{}");
    expect(detectProvider(root)).toBe("claude");
  });
  it("non-plugin repo -> codex (cheap default)", () => {
    expect(detectProvider(mkdtempSync(join(tmpdir(), "dp-")))).toBe("codex");
  });
});

describe("targetCwd", () => {
  it("reads target_cwd.txt, trailing newline stripped", () => {
    const home = freshHome();
    const art = implementArtDir("topic", { home }); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/root\n");
    expect(targetCwd("topic", { home })).toBe("/repo/root");
  });
  it("no file -> \"\"", () => { expect(targetCwd("topic", { home: freshHome() })).toBe(""); });
});

describe("assertImplementTopic", () => {
  it("accepts valid slugs up to 32 chars", () => {
    expect(assertImplementTopic("demo-repo-simplify")).toBe(true);
    expect(assertImplementTopic("a".repeat(32))).toBe(true);
    expect(assertImplementTopic("x1")).toBe(true);
  });
  it("rejects over-length, malformed, and empty slugs", () => {
    expect(assertImplementTopic("demo-repo-simplify-sweep-2-tiers-bce")).toBe(false); // 36 chars
    expect(assertImplementTopic("a".repeat(33))).toBe(false);
    expect(assertImplementTopic("")).toBe(false);
    expect(assertImplementTopic("-leading")).toBe(false);
    expect(assertImplementTopic("Bad_Topic")).toBe(false);
  });
});
