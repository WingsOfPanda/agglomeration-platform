import { describe, it, expect } from "vitest";
import { classifyInspect, inspectInfeasibleReason, parseInspections, inspectionRow, INSPECTION_TSV_HEADER } from "../src/core/rehearsalInspect.js";

describe("classifyInspect", () => {
  const base = { reimplMetric: 0.90, runFailed: false, reported: 0.90, epsilon: 0.02, integrityRefuted: false };
  it("within epsilon -> reproduced", () => {
    expect(classifyInspect({ ...base, reimplMetric: 0.91 }).verdict).toBe("reproduced");
  });
  it("beyond epsilon -> not-reproduced", () => {
    const r = classifyInspect({ ...base, reimplMetric: 0.70 });
    expect(r.verdict).toBe("not-reproduced");
    expect(r.reason).toContain("value:");
  });
  it("integrityRefuted -> not-reproduced (precedence)", () => {
    const r = classifyInspect({ ...base, integrityRefuted: true });
    expect(r.verdict).toBe("not-reproduced");
    expect(r.reason).toBe("integrity-refuted");
  });
  it("runFailed -> inconclusive (NOT a demotion)", () => {
    expect(classifyInspect({ ...base, runFailed: true }).verdict).toBe("inconclusive");
  });
  it("no reimpl marker -> inconclusive", () => {
    expect(classifyInspect({ ...base, reimplMetric: null }).verdict).toBe("inconclusive");
  });
  it("no reported metric -> inconclusive", () => {
    expect(classifyInspect({ ...base, reported: null }).verdict).toBe("inconclusive");
  });
});

describe("inspectInfeasibleReason", () => {
  it("not-reproduced -> reimpl-mismatch", () => expect(inspectInfeasibleReason("not-reproduced")).toBe("reimpl-mismatch"));
  it("reproduced/inconclusive/absent -> null", () => {
    expect(inspectInfeasibleReason("reproduced")).toBeNull();
    expect(inspectInfeasibleReason("inconclusive")).toBeNull();
    expect(inspectInfeasibleReason(undefined)).toBeNull();
  });
});

describe("parseInspections", () => {
  it("keys agent/exp, last-write-wins, header skipped", () => {
    const tsv = INSPECTION_TSV_HEADER +
      "exp-001\tgolf\treproduced\t\t0.9\tT\n" +
      "exp-002\tgolf\tnot-reproduced\tvalue\t0.5\tT\n" +
      "exp-002\tgolf\tinconclusive\treimpl-failed\t\tT2\n";
    const m = parseInspections(tsv);
    expect(m["golf/exp-001"]).toBe("reproduced");
    expect(m["golf/exp-002"]).toBe("inconclusive");
  });
});

describe("inspectionRow + header", () => {
  it("exact tab layout", () => {
    expect(INSPECTION_TSV_HEADER).toBe("exp_id\tagent\tverdict\treason\treimpl_metric\tts\n");
    expect(inspectionRow({ expId: "exp-003", agent: "golf", verdict: "not-reproduced", reason: "value:0.5vs0.9", reimplMetric: "0.5", ts: "T" }))
      .toBe("exp-003\tgolf\tnot-reproduced\tvalue:0.5vs0.9\t0.5\tT\n");
  });
});
