import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { runForensics } from "../src/core/forensics.js";
import { designArtDir } from "../src/core/design.js";
import { workerDir, forensicsQueueDir } from "../src/core/paths.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

/** The flat queue — with no consent (and the suite's env guard) every filing lands here. */
function queuedRecords(): string[] {
  const dir = forensicsQueueDir();
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : [];
}

describe("runForensics", () => {
  it("captures a worker's outbox errors into a command-tagged queue record (rc 0)", () => {
    mkdirSync(designArtDir("fix-x"), { recursive: true });
    const pd = workerDir("cody", "codex", "fix-x");
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "outbox.jsonl"), JSON.stringify({ event: "error", message: "boom" }) + "\n");
    expect(runForensics("design", designArtDir, "fix-x")).toBe(0);
    const files = queuedRecords();
    expect(files.length).toBe(1);
    const md = readFileSync(files[0], "utf8");
    expect(md).toContain("command: design");
    expect(md).toContain("kind: findings");
    expect(md).toContain("boom");
    // and the local trace the autoresearch corpus digest counts
    expect(readFileSync(join(designArtDir("fix-x"), "findings.log"), "utf8")).toMatch(/ findings\n$/);
  });
  it("files nothing when there are no findings (rc 0)", () => {
    mkdirSync(designArtDir("clean"), { recursive: true });
    expect(runForensics("design", designArtDir, "clean")).toBe(0);
    expect(queuedRecords().length).toBe(0);
  });
  it("rc 2 on missing topic", () => {
    expect(runForensics("design", designArtDir, undefined)).toBe(2);
  });
});
