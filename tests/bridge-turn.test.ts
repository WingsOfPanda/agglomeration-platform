// tests/bridge-turn.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeBridgeBrief, composeBridgeFollowup } from "../src/core/bridgeTurn.js";
import { inboxWrite, inboxPath } from "../src/core/ipc.js";
import { workerDir } from "../src/core/paths.js";
import { freshHome } from "./helpers/tmpHome.js";

describe("composeBridgeBrief", () => {
  const p = composeBridgeBrief("implement X", "/abs/repoB", "feat/bridge-demo");
  it("names repo B's path, the branch, and the cross-repo framing + carries the task", () => {
    expect(p).toContain("/abs/repoB");
    expect(p).toContain("feat/bridge-demo");
    expect(p).toMatch(/separate repository|conductor/i);
    expect(p).toContain("implement X");
  });
  it("does NOT embed its own done-event line or END_OF_INSTRUCTION (inboxWrite owns them)", () => {
    expect(p).not.toContain('{"event":"done"');
    expect(p).not.toContain("END_OF_INSTRUCTION");
  });
});

describe("composeBridgeFollowup", () => {
  const p = composeBridgeFollowup("now also handle Y", 2);
  it("frames it as round N and inlines the conductor's text", () => {
    expect(p).toContain("round 2");
    expect(p).toContain("now also handle Y");
  });
  it("does NOT embed its own done-event line or END_OF_INSTRUCTION", () => {
    expect(p).not.toContain('{"event":"done"');
    expect(p).not.toContain("END_OF_INSTRUCTION");
  });
});

describe("bridge inbox carries a single done contract (no duplicate END_OF_INSTRUCTION)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => h.cleanup());
  const count = (s: string, sub: string): number => s.split(sub).length - 1;
  it("brief → exactly one END_OF_INSTRUCTION and one done line", () => {
    const d = workerDir("alpha", "codex", "demo"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "outbox.jsonl"), "");
    inboxWrite("alpha", "codex", "demo", composeBridgeBrief("t", "/abs/repoB", "feat/bridge-demo"));
    const txt = readFileSync(inboxPath("alpha", "codex", "demo"), "utf8");
    expect(count(txt, "END_OF_INSTRUCTION")).toBe(1);
    expect(count(txt, '"event":"done"')).toBe(1);
    expect(txt.trimEnd().endsWith("END_OF_INSTRUCTION")).toBe(true);
  });
});
