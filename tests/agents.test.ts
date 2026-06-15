import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as I from "../src/core/agents.js";
import { workerDir } from "../src/core/paths.js";

afterEach(() => { delete process.env.AP_HOME; delete process.env.CLAUDE_CODE_SESSION_ID; });
function home() {
  const h = mkdtempSync(join(tmpdir(), "in-"));
  process.env.AP_HOME = h;
  writeFileSync(join(h, "agents.yaml"), "agents:\n  - bravo\n  - alpha\n  - charlie\n");
  return h;
}
function seed(i: string, m: string, t: string) {
  const d = workerDir(i, m, t); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "pane.json"), JSON.stringify({ pane_id: "%1", agent: i, model: m, spawned_at: "t" }));
  return d;
}

describe("agents", () => {
  it("loadAgentPool parses list", () => {
    home();
    expect(I.loadAgentPool()).toEqual(["bravo", "alpha", "charlie"]);
  });
  it("inUse reads canonical agent field (hyphenated model safe)", () => {
    home(); seed("bravo", "claude-haiku", "demo");
    expect(I.agentInUse("bravo", "demo")).toBe(true);
    expect(I.agentInUse("alpha", "demo")).toBe(false);
    expect(I.agentsInUseInTopic("demo")).toContain("bravo");
  });
  it("pickRandom prefers globally-unused, deterministic with one candidate", () => {
    home(); seed("bravo", "codex", "t1"); seed("alpha", "codex", "t2");
    expect(I.pickRandomAgent("new", () => 0)).toBe("charlie"); // only globally-unused
  });
  it("pickRandom null when saturated", () => {
    home(); seed("bravo", "codex", "x"); seed("alpha", "codex", "x"); seed("charlie", "codex", "x");
    expect(I.pickRandomAgent("x", () => 0)).toBeNull();
  });
  it("collision: foreign owner shows owned-by line + coda command", () => {
    home();
    const d = seed("bravo", "codex", "demo");
    writeFileSync(join(d, ".session_id"), "aaaaaaaa-1111\n");
    const msg = I.formatCollisionError("bravo", "codex", "demo", "bbbbbbbb-2222");
    expect(msg).toContain("bravo is already deployed on demo; pick another agent");
    expect(msg).toContain("owned by another Claude Code session");
    expect(msg).toContain("aaaaaaaa");
    expect(msg).toContain("/ap:coda bravo demo");
  });
  it("collision: same session omits owned-by line", () => {
    home();
    const d = seed("bravo", "codex", "demo");
    writeFileSync(join(d, ".session_id"), "same\n");
    const msg = I.formatCollisionError("bravo", "codex", "demo", "same");
    expect(msg).not.toContain("owned by another");
  });
});

describe("pickAgents", () => {
  it("returns n DISTINCT agents from the pool", () => {
    home();
    const picks = I.pickAgents("t-distinct", 3);
    expect(picks).toHaveLength(3);
    expect(new Set(picks).size).toBe(3);
  });
  it("deterministic with a fixed rng (always index 0 → first available, no repeats)", () => {
    home();
    const picks = I.pickAgents("t-fixed", 2, () => 0);
    expect(new Set(picks).size).toBe(2); // index-0 each round, but picked are excluded → 2 distinct
  });
});
