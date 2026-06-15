// tests/design-spawn.test.ts
import { describe, it, expect } from "vitest";
import { spawnListArg, spawnResultsTsv, spawnTally, parsePanesFile } from "../src/core/design.js";

describe("spawnListArg", () => {
  it("formats <agent>:<provider> pairs (model = provider), preserving order", () => {
    expect(spawnListArg([{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }]))
      .toBe("alpha:codex,charlie:claude");
  });
});

describe("spawnResultsTsv", () => {
  it("one TSV row per worker; reason empty on rc 0, spawn-failed otherwise; trailing newline", () => {
    expect(spawnResultsTsv([
      { agent: "alpha", provider: "codex", rc: 0 },
      { agent: "charlie", provider: "claude", rc: 1 },
    ])).toBe("alpha\tcodex\t0\t\ncharlie\tclaude\t1\tspawn-failed\n");
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
    const m = parsePanesFile("# header\nalpha\t%3\n\ncharlie\t%7\n");
    expect(m.get("alpha")).toBe("%3");
    expect(m.get("charlie")).toBe("%7");
    expect(m.size).toBe(2);
  });
});
