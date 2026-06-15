// tests/score-spawn.test.ts
import { describe, it, expect } from "vitest";
import { spawnRosterArg, spawnResultsTsv, spawnTally, parsePanesFile } from "../src/core/score.js";

describe("spawnRosterArg", () => {
  it("formats <agent>:<provider> pairs (model = provider), preserving order", () => {
    expect(spawnRosterArg([{ provider: "codex", agent: "viola" }, { provider: "claude", agent: "cello" }]))
      .toBe("viola:codex,cello:claude");
  });
});

describe("spawnResultsTsv", () => {
  it("one TSV row per worker; reason empty on rc 0, spawn-failed otherwise; trailing newline", () => {
    expect(spawnResultsTsv([
      { agent: "viola", provider: "codex", rc: 0 },
      { agent: "cello", provider: "claude", rc: 1 },
    ])).toBe("viola\tcodex\t0\t\ncello\tclaude\t1\tspawn-failed\n");
  });
  it("empty input → empty string", () => { expect(spawnResultsTsv([])).toBe(""); });
});

describe("spawnTally", () => {
  it("all ok → 0; none ok → 2; partial → 1", () => {
    expect(spawnTally([0, 0])).toBe(0);
    expect(spawnTally([1, 1])).toBe(2);
    expect(spawnTally([0, 1])).toBe(1);
  });
});

describe("parsePanesFile", () => {
  it("parses TSV agent→pane, skipping #/blank lines", () => {
    const m = parsePanesFile("# header\nviola\t%3\n\ncello\t%7\n");
    expect(m.get("viola")).toBe("%3");
    expect(m.get("cello")).toBe("%7");
    expect(m.size).toBe(2);
  });
});
