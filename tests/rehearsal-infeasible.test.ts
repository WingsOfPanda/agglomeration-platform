import { describe, it, expect } from "vitest";
import { classifyInfeasible, parseVerdicts, INFEASIBLE_FLAGS } from "../src/core/rehearsalInfeasible.js";

describe("classifyInfeasible", () => {
  it("verdict=mismatch -> 'mismatch'", () => {
    expect(classifyInfeasible("mismatch", [])).toBe("mismatch");
  });
  it("an invalidating flag -> that flag (mismatch takes precedence)", () => {
    expect(classifyInfeasible(undefined, ["under-run"])).toBe("under-run");
    expect(classifyInfeasible(undefined, ["audit-knob-drift"])).toBe("audit-knob-drift");
    expect(classifyInfeasible(undefined, ["log-contradiction"])).toBe("log-contradiction");
    expect(classifyInfeasible("mismatch", ["under-run"])).toBe("mismatch");
  });
  it("advisory-only flags / verified / none -> null", () => {
    expect(classifyInfeasible("verified", ["ceiling-exceeded"])).toBeNull();
    expect(classifyInfeasible(undefined, ["integrity-attestation-incomplete"])).toBeNull();
    expect(classifyInfeasible(undefined, [])).toBeNull();
    expect(classifyInfeasible(undefined, ["ceiling-exceeded", "integrity-attestation-incomplete"])).toBeNull();
  });
  it("INFEASIBLE_FLAGS is the core-unambiguous set", () => {
    expect([...INFEASIBLE_FLAGS].sort()).toEqual(["audit-knob-drift", "log-contradiction", "under-run"]);
  });
});

describe("parseVerdicts", () => {
  it("maps instrument/exp -> verdict, last write wins, header/blank skipped", () => {
    const tsv = "exp_id\tinstrument\tverdict\treason\trecomputed\tts\n" +
      "exp-001\tviola\tverified\t\t0.9\tT1\n" +
      "exp-001\tviola\tmismatch\tvalue\t0.5\tT2\n" +
      "exp-002\toboe\tunavailable\tno-contract\t\tT3\n";
    expect(parseVerdicts(tsv)).toEqual({ "viola/exp-001": "mismatch", "oboe/exp-002": "unavailable" });
  });
  it("empty / headerless input -> {}", () => {
    expect(parseVerdicts("")).toEqual({});
  });
});
