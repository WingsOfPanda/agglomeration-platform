import { describe, it, expect } from "vitest";
import {
  parseVerifyBlock, checkVerify, recomputedFromOutput, verificationRow,
} from "../src/core/rehearsalVerify.js";

describe("parseVerifyBlock", () => {
  it("extracts a valid block", () => {
    const b = parseVerifyBlock({ verify: { kind: "rescore", command: "python s.py", inputs: ["./p.json"], metric_from: "marker" } });
    expect(b).toEqual({ kind: "rescore", command: "python s.py", inputs: ["./p.json"], metric_from: "marker" });
  });
  it("returns undefined for absent/malformed/bad-kind", () => {
    expect(parseVerifyBlock({})).toBeUndefined();
    expect(parseVerifyBlock({ verify: 7 })).toBeUndefined();
    expect(parseVerifyBlock({ verify: { kind: "weird" } })).toBeUndefined();
  });
  it("keeps kind=none with no command", () => {
    expect(parseVerifyBlock({ verify: { kind: "none" } })).toEqual({ kind: "none" });
  });
});

describe("checkVerify", () => {
  it("verified within epsilon", () => {
    expect(checkVerify({ recomputed: 0.901, runFailed: false, reported: 0.9, epsilon: 0.01 }))
      .toEqual({ verdict: "verified", reason: "" });
  });
  it("mismatch beyond epsilon", () => {
    expect(checkVerify({ recomputed: 0.8, runFailed: false, reported: 0.9, epsilon: 0.01 }).verdict).toBe("mismatch");
  });
  it("run-failed -> mismatch", () => {
    expect(checkVerify({ recomputed: null, runFailed: true, reported: 0.9, epsilon: 0.01 }))
      .toEqual({ verdict: "mismatch", reason: "rerun-failed" });
  });
  it("no marker / no reported -> mismatch", () => {
    expect(checkVerify({ recomputed: null, runFailed: false, reported: 0.9, epsilon: 0.01 }).reason).toBe("no-marker");
    expect(checkVerify({ recomputed: 0.9, runFailed: false, reported: null, epsilon: 0.01 }).reason).toBe("no-reported");
  });
});

describe("recomputedFromOutput", () => {
  it("parses the LAST VERIFY_METRIC marker on stdout", () => {
    expect(recomputedFromOutput("noise\nVERIFY_METRIC=0.5\nVERIFY_METRIC=0.93\n", "marker", () => null)).toBe(0.93);
  });
  it("returns null when no marker", () => {
    expect(recomputedFromOutput("just logs\n", "marker", () => null)).toBeNull();
  });
  it("reads metric_value from a declared json file", () => {
    expect(recomputedFromOutput("", "./verify-out.json", () => JSON.stringify({ metric_value: 0.77 }))).toBe(0.77);
    expect(recomputedFromOutput("", "./verify-out.json", () => "not json")).toBeNull();
  });
});

describe("verificationRow", () => {
  it("renders a 6-col tsv row", () => {
    expect(verificationRow({ expId: "exp-001", instrument: "viola", verdict: "verified", reason: "", recomputed: "0.93", ts: "T" }))
      .toBe("exp-001\tviola\tverified\t\t0.93\tT\n");
  });
});
