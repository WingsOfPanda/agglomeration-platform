import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as I from "../src/core/instruments.js";
import { partDir } from "../src/core/paths.js";

afterEach(() => { delete process.env.AP_HOME; delete process.env.CLAUDE_CODE_SESSION_ID; });
function home() {
  const h = mkdtempSync(join(tmpdir(), "in-"));
  process.env.AP_HOME = h;
  writeFileSync(join(h, "instruments.yaml"), "instruments:\n  - violin\n  - viola\n  - cello\n");
  return h;
}
function seed(i: string, m: string, t: string) {
  const d = partDir(i, m, t); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "pane.json"), JSON.stringify({ pane_id: "%1", instrument: i, model: m, spawned_at: "t" }));
  return d;
}

describe("instruments", () => {
  it("loadInstrumentPool parses list", () => {
    home();
    expect(I.loadInstrumentPool()).toEqual(["violin", "viola", "cello"]);
  });
  it("inUse reads canonical instrument field (hyphenated model safe)", () => {
    home(); seed("violin", "claude-haiku", "demo");
    expect(I.instrumentInUse("violin", "demo")).toBe(true);
    expect(I.instrumentInUse("viola", "demo")).toBe(false);
    expect(I.instrumentsInUseInTopic("demo")).toContain("violin");
  });
  it("pickRandom prefers globally-unused, deterministic with one candidate", () => {
    home(); seed("violin", "codex", "t1"); seed("viola", "codex", "t2");
    expect(I.pickRandomInstrument("new", () => 0)).toBe("cello"); // only globally-unused
  });
  it("pickRandom null when saturated", () => {
    home(); seed("violin", "codex", "x"); seed("viola", "codex", "x"); seed("cello", "codex", "x");
    expect(I.pickRandomInstrument("x", () => 0)).toBeNull();
  });
  it("collision: foreign owner shows owned-by line + coda command", () => {
    home();
    const d = seed("violin", "codex", "demo");
    writeFileSync(join(d, ".session_id"), "aaaaaaaa-1111\n");
    const msg = I.formatCollisionError("violin", "codex", "demo", "bbbbbbbb-2222");
    expect(msg).toContain("violin is already deployed on demo; pick another instrument");
    expect(msg).toContain("owned by another Claude Code session");
    expect(msg).toContain("aaaaaaaa");
    expect(msg).toContain("/ap:coda violin demo");
  });
  it("collision: same session omits owned-by line", () => {
    home();
    const d = seed("violin", "codex", "demo");
    writeFileSync(join(d, ".session_id"), "same\n");
    const msg = I.formatCollisionError("violin", "codex", "demo", "same");
    expect(msg).not.toContain("owned by another");
  });
});

describe("pickInstruments", () => {
  it("returns n DISTINCT instruments from the pool", () => {
    home();
    const picks = I.pickInstruments("t-distinct", 3);
    expect(picks).toHaveLength(3);
    expect(new Set(picks).size).toBe(3);
  });
  it("deterministic with a fixed rng (always index 0 → first available, no repeats)", () => {
    home();
    const picks = I.pickInstruments("t-fixed", 2, () => 0);
    expect(new Set(picks).size).toBe(2); // index-0 each round, but picked are excluded → 2 distinct
  });
});
