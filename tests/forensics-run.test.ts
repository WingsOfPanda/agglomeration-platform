import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { runForensics } from "../src/core/forensics.js";
import { designArtDir } from "../src/core/design.js";
import { workerDir, globalRoot } from "../src/core/paths.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

function walkForensicsMd(): string[] {
  const root = join(globalRoot(), "forensics");
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }) as Dirent[]) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

describe("runForensics", () => {
  it("captures a worker's outbox errors into a command-tagged file (rc 0)", () => {
    mkdirSync(designArtDir("fix-x"), { recursive: true });
    const pd = workerDir("cody", "codex", "fix-x");
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "outbox.jsonl"), JSON.stringify({ event: "error", message: "boom" }) + "\n");
    expect(runForensics("design", designArtDir, "fix-x")).toBe(0);
    const files = walkForensicsMd();
    expect(files.length).toBe(1);
    const md = readFileSync(files[0], "utf8");
    expect(md).toContain("command: design");
    expect(md).toContain("boom");
  });
  it("writes nothing when there are no findings (rc 0)", () => {
    mkdirSync(designArtDir("clean"), { recursive: true });
    expect(runForensics("design", designArtDir, "clean")).toBe(0);
    expect(walkForensicsMd().length).toBe(0);
  });
  it("rc 2 on missing topic", () => {
    expect(runForensics("design", designArtDir, undefined)).toBe(2);
  });
});
