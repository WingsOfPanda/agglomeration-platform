import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { realpathSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import * as P from "../src/core/paths.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); delete process.env.AP_HOME; });
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h.home; }

describe("paths", () => {
  it("stateRoot: default vs env-verbatim", () => {
    delete process.env.AP_HOME;
    expect(P.stateRoot({ cwd: "/proj" })).toBe("/proj/.ap");
    process.env.AP_HOME = "/tmp/xx/cs-test";
    expect(P.stateRoot()).toBe("/tmp/xx/cs-test"); // verbatim, no /.ap suffix
  });
  it("repoHash: 64 lowercase hex, matches node crypto, deterministic", () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-"));
    const expected = createHash("sha256").update(realpathSync(dir), "utf8").digest("hex");
    expect(P.repoHash(dir)).toBe(expected);
    expect(P.repoHash(dir)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("path composition", () => {
    process.env.AP_HOME = "/R";
    const h = P.repoHash(process.cwd());
    expect(P.repoStateDir()).toBe(`/R/state/${h}`);
    expect(P.topicDir("foo")).toBe(`/R/state/${h}/foo`);
    expect(P.workerDir("bravo", "codex", "foo")).toBe(`/R/state/${h}/foo/bravo-codex`);
  });
  it("isArtifactDir", () => {
    expect(P.isArtifactDir("/a/b/_consult")).toBe(true);
    expect(P.isArtifactDir("/a/b/bravo-codex")).toBe(false);
  });
  it("runArgsFile: unique empty file under _args, state root gitignored", () => {
    const h = home();
    const a = P.runArgsFile("design");
    const b = P.runArgsFile("design");
    expect(a).not.toBe(b);
    expect(a).toContain("/_args/");
    expect(readFileSync(a, "utf8")).toBe("");
    expect(readFileSync(join(h, ".gitignore"), "utf8")).toBe("*\n");
  });
  it("activeProvidersPath: prefers active when present, else available", () => {
    const h = home();
    // no curated active file yet → resolver returns the medic-detected available path
    expect(P.activeProvidersPath()).toBe(join(h, "providers-available.txt"));
    // once the user-curated active file exists → resolver prefers it
    writeFileSync(join(h, "providers-active.txt"), "codex\n");
    expect(P.activeProvidersPath()).toBe(join(h, "providers-active.txt"));
  });
});
