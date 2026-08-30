import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { recordHubFlag, runFlag } from "../src/core/forensics.js";
import { parseForensicsFrontmatter, parseMechanicalFindings } from "../src/core/review.js";
import { forensicsQueueDir } from "../src/core/paths.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

function queuedRecords(): string[] {
  const dir = forensicsQueueDir();
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : [];
}

describe("recordHubFlag", () => {
  it("queues a hub_flag record naming the run, the kind and the command", () => {
    const line = recordHubFlag({ command: "implement", topic: "auth-x", note: "  the diff touched an unrelated file  " });
    const files = queuedRecords();
    expect(files).toHaveLength(1);
    expect(line).toBe(`QUEUED=${files[0]}`);
    const text = readFileSync(files[0], "utf8");
    const meta = parseForensicsFrontmatter(text);
    expect(meta.command).toBe("implement");
    expect(meta.topic).toBe("auth-x");
    expect(meta.nFindings).toBe(1);
    expect(text).toContain("kind: flag");
    expect(text).toContain("title: [ap:implement] the diff touched an unrelated file");
    expect(parseMechanicalFindings(text)).toEqual([
      { source: "hub_flag", key: "the diff touched an unrelated file", context: "from=hub command=implement" },
    ]);
  });
  it("returns '' for an empty/whitespace note (nothing queued)", () => {
    expect(recordHubFlag({ command: "design", topic: "t", note: "   " })).toBe("");
    expect(queuedRecords()).toHaveLength(0);
  });
});

describe("runFlag", () => {
  it("rc 2 on missing topic or empty note", () => {
    expect(runFlag("quick", undefined, "x")).toBe(2);
    expect(runFlag("quick", "t", "")).toBe(2);
  });
  it("rc 0 and queues a hub_flag record on a valid flag", () => {
    const rc = runFlag("design", "topic-y", "looks off");
    expect(rc).toBe(0);
    const files = queuedRecords();
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("-flag-");
    expect(readFileSync(files[0], "utf8")).toContain("looks off");
  });
});
