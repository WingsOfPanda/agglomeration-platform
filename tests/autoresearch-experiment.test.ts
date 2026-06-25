import { describe, it, expect } from "vitest";
import { OPERATORS, isOperator, buildStaggeredSpawns } from "../src/core/autoresearchExperiment.js";

describe("OPERATORS / isOperator", () => {
  it("operator set includes the expanded one-variable kinds in order", () => {
    expect(OPERATORS).toEqual([
      "draft", "improve", "debug", "ablate", "replicate", "crossover", "literature-refresh",
    ]);
  });
  it("isOperator accepts every known operator", () => {
    for (const op of OPERATORS) expect(isOperator(op)).toBe(true);
  });
  it("isOperator rejects unknown labels", () => {
    expect(isOperator("nonsense")).toBe(false);
    expect(isOperator("")).toBe(false);
    expect(isOperator("Draft")).toBe(false);
  });
});

describe("buildStaggeredSpawns", () => {
  it("staggers spawns by bootstrap_sleep_s", () => {
    const s = buildStaggeredSpawns(["a", "b", "c", "d"], 20);
    expect(s).toEqual([
      { agent: "a", delayS: 0 },
      { agent: "b", delayS: 20 },
      { agent: "c", delayS: 40 },
      { agent: "d", delayS: 60 },
    ]);
    expect(s.map((x) => x.delayS)).toEqual([0, 20, 40, 60]);
  });
  it("first agent starts immediately (delayS 0)", () => {
    expect(buildStaggeredSpawns(["only"], 20)).toEqual([{ agent: "only", delayS: 0 }]);
  });
  it("returns empty for no agents", () => {
    expect(buildStaggeredSpawns([], 20)).toEqual([]);
  });
});
