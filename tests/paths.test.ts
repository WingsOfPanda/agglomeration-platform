import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { realpathSync, existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, utimesSync } from "node:fs";
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
  it("runDir: unique, .gitignore, .last, sweep", () => {
    const h = home();
    const a = P.runDir("design");
    const b = P.runDir("design");
    expect(a).not.toBe(b);
    expect(readFileSync(join(h, "_run", ".gitignore"), "utf8")).toBe("*\n");
    expect(P.runDirLast()).toBe(b); // no trailing newline
    // stale sweep
    const stale = join(h, "_run", "design.STALE");
    mkdirSync(stale);
    const old = (Date.now() - 100000_000) / 1000;
    utimesSync(stale, old, old);
    P.runDir("design");
    expect(existsSync(stale)).toBe(false);
  });
  it("runArgsFile records path with no newline", () => {
    home();
    const f = P.runArgsFile("design");
    expect(f).toContain("/_args/");
    const recorded = readFileSync(join(P.runDirLast(), "args-path.txt"), "utf8");
    expect(recorded).toBe(f); // exact, no newline
  });
  it("runDirLast throws when absent", () => {
    home();
    expect(() => P.runDirLast()).toThrow();
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
