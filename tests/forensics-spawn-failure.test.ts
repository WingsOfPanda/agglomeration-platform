import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureSpawnFailure, NO_EVENT_SENTINEL } from "../src/core/forensics.js";
import { parseMechanicalFindings } from "../src/core/review.js";
import { globalRoot, forensicsQueueDir, workerDir } from "../src/core/paths.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

function queuedRecords(): string[] {
  const dir = forensicsQueueDir();
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : [];
}

describe("captureSpawnFailure", () => {
  it("queues a command:spawn record review can parse, with its run under the WORKER dir", () => {
    const line = captureSpawnFailure({
      agent: "lima", model: "codex", topic: "plan-x",
      reason: "config_error", detail: "identity template not found",
      failureReportPath: "/p/failure-reason.txt",
    });
    const files = queuedRecords();
    expect(files).toHaveLength(1);
    expect(line).toBe(`QUEUED=${files[0]}`);
    const md = readFileSync(files[0], "utf8");
    expect(md).toContain("command: spawn");
    expect(md).toContain("topic: plan-x");
    expect(md).toContain("n_findings_mechanical: 2");
    expect(md).toContain("title: [ap:spawn] config_error");
    expect(md).toContain(`art_dir: ${workerDir("lima", "codex", "plan-x")}`);
    const findings = parseMechanicalFindings(md);
    expect(findings.some((f) => f.source === "spawn_failure" && /reason=config_error/.test(f.key))).toBe(true);
    expect(findings.some((f) => /failure_report=\/p\/failure-reason\.txt/.test(f.key))).toBe(true);
    expect(md).toContain("worker=lima-codex");
    // the spawn failure IS its own run: the trace lands beside the worker's state
    expect(existsSync(join(workerDir("lima", "codex", "plan-x"), "findings.log"))).toBe(true);
  });

  it("emits a single finding when no failure report is given", () => {
    captureSpawnFailure({ agent: "zulu", model: "claude", topic: "t", reason: "timeout", detail: NO_EVENT_SENTINEL });
    expect(readFileSync(queuedRecords()[0], "utf8")).toContain("n_findings_mechanical: 1");
  });

  it("is best-effort: returns '' and queues nothing when the queue dir can't be created", () => {
    mkdirSync(globalRoot(), { recursive: true });
    writeFileSync(join(globalRoot(), "forensics"), "x"); // a FILE where the dir would go -> mkdirSync throws
    expect(captureSpawnFailure({ agent: "a", model: "b", topic: "t", reason: "spawn_error", detail: "x" })).toBe("");
  });
});
