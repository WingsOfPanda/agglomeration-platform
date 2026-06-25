import { describe, it, expect } from "vitest";
import { OPERATORS, isOperator } from "../src/core/autoresearchExperiment.js";

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
