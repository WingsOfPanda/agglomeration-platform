// tests/spawn-retry-directive.test.ts — GitHub issue #175, a producer<->consumer contract in the
// style of tests/spawn-timeout-directive.test.ts: a codex worker dying at bootstrap is transient and
// recurring, so `spawn` PRODUCES one machine-readable failure reason on stdout and the single-worker
// directives CONSUME it to retry a cold start exactly once. `explore` has tolerated this since its
// Phase 2 (spawn-retry-once); quick/implement treated any non-zero spawn as terminal.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { captureSpawnFailure } from "../src/core/forensics.js";
import { globalRoot } from "../src/core/paths.js";

describe("spawn prints ONE machine-readable failure reason on stdout", () => {
  let env: { home: string; cleanup: () => void };
  beforeEach(() => { env = freshHome(); });
  afterEach(() => { env.cleanup(); });

  // The retryable pair and one deterministic reason: the directives branch on exactly this token.
  for (const reason of ["pane_dead", "timeout", "binary_not_found"]) {
    it(`emits 'SPAWN_FAILED reason=${reason}' exactly once`, () => {
      const out = captureStdout();
      try { captureSpawnFailure({ agent: "lima", model: "codex", topic: "t", reason, detail: "d" }); }
      finally { out.restore(); }
      expect(out.text().match(/^SPAWN_FAILED reason=\S+$/gm)).toEqual([`SPAWN_FAILED reason=${reason}`]);
    });
  }

  it("still prints when the record cannot be filed — the line is a CLI contract, not a byproduct", () => {
    mkdirSync(globalRoot(), { recursive: true });
    writeFileSync(join(globalRoot(), "forensics"), "x"); // a FILE where the queue dir would go
    const out = captureStdout();
    try { expect(captureSpawnFailure({ agent: "a", model: "b", topic: "t", reason: "pane_dead", detail: "x" })).toBe(""); }
    finally { out.restore(); }
    expect(out.text()).toContain("SPAWN_FAILED reason=pane_dead");
  });
});

// Pins are whitespace-collapsed so re-wrapping the prose does not break them.
const flat = (p: string) => readFileSync(join(process.cwd(), "commands", p), "utf8").replace(/\s+/g, " ");
const para = (p: string, end: string): string => {
  const f = flat(p);
  return f.slice(f.indexOf("**spawn-retry-once**"), f.indexOf(end));
};
const RETRY_PARAGRAPHS: Array<[string, string]> = [
  ["quick.md", para("quick.md", "Dispatch round 1")],
  ["implement.md", para("implement.md", "## Stage 1 — run the worker turn")],
];

describe("the single-worker directives consume that reason (spawn-retry-once)", () => {
  for (const [rel, para] of RETRY_PARAGRAPHS) {
    it(`${rel} branches on the stdout line, not on stderr`, () => {
      expect(para, `${rel} must name the line a hub greps for`).toContain("SPAWN_FAILED reason=");
    });

    it(`${rel} retries the cold-start reasons exactly once`, () => {
      expect(para, `${rel} must name pane_dead as retryable`).toContain("pane_dead");
      expect(para, `${rel} must name timeout as retryable`).toContain("timeout");
      expect(para, `${rel} must bound the retry at one`).toContain("once");
    });

    it(`${rel} refuses to retry a deterministic reason`, () => {
      expect(para, `${rel} must name binary_not_found as non-retried`)
        .toContain("Every other reason (`binary_not_found`");
      expect(para).toContain("deterministic");
    });
  }
});
