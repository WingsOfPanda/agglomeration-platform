import { describe, it, expect } from "vitest";
import { OPERATORS } from "../src/core/autoresearchExperiment.js";

describe("OPERATORS", () => {
  it("operator set includes the expanded one-variable kinds in order", () => {
    expect(OPERATORS).toEqual([
      "draft", "improve", "debug", "ablate", "replicate", "crossover", "literature-refresh",
    ]);
  });
});
