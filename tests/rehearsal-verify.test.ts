import { describe, it, expect } from "vitest";
import {
  parseVerifyBlock, checkVerify, recomputedFromOutput, verificationRow,
} from "../src/core/rehearsalVerify.js";
import { buildManifest, planVerify, type VerifyManifest } from "../src/core/rehearsalVerify.js";

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

describe("buildManifest", () => {
  it("hashes command + inputs; null for kind=none/no-command", () => {
    const read = (rel: string) => (rel === "./p.json" ? "PREDS" : null);
    const m = buildManifest({ kind: "rescore", command: "c", inputs: ["./p.json", "./missing"] }, read)!;
    expect(m.command).toBe("c");
    expect(Object.keys(m.hashes)).toEqual(["./p.json"]); // missing input skipped at snapshot
    expect(buildManifest({ kind: "none" }, read)).toBeNull();
  });
});

describe("planVerify", () => {
  const read = (rel: string) => (rel === "./p.json" ? "PREDS" : null);
  const fixed = (): VerifyManifest => buildManifest({ kind: "rescore", command: "c", inputs: ["./p.json"] }, read)!;

  it("no block -> unavailable no-contract", () => {
    expect(planVerify({ block: undefined, manifest: null, authorizeRerun: false, readInput: read }))
      .toEqual({ run: false, verdict: "unavailable", reason: "no-contract" });
  });
  it("kind=none -> unavailable part-declined", () => {
    expect((planVerify({ block: { kind: "none" }, manifest: null, authorizeRerun: false, readInput: read }) as { reason: string }).reason).toBe("part-declined");
  });
  it("rerun without authorization -> pending rerun-deferred", () => {
    expect(planVerify({ block: { kind: "rerun", command: "c" }, manifest: fixed(), authorizeRerun: false, readInput: read }))
      .toEqual({ run: false, verdict: "pending", reason: "rerun-deferred" });
  });
  it("no manifest -> unavailable no-manifest", () => {
    expect((planVerify({ block: { kind: "rescore", command: "c", inputs: ["./p.json"] }, manifest: null, authorizeRerun: false, readInput: read }) as { reason: string }).reason).toBe("no-manifest");
  });
  it("provenance hash change -> mismatch", () => {
    const tampered = (rel: string) => (rel === "./p.json" ? "DIFFERENT" : null);
    expect(planVerify({ block: { kind: "rescore", command: "c", inputs: ["./p.json"] }, manifest: fixed(), authorizeRerun: false, readInput: tampered }))
      .toEqual({ run: false, verdict: "mismatch", reason: "provenance:./p.json" });
  });
  it("clean -> run with command + metricFrom default marker", () => {
    expect(planVerify({ block: { kind: "rescore", command: "c", inputs: ["./p.json"] }, manifest: fixed(), authorizeRerun: false, readInput: read }))
      .toEqual({ run: true, command: "c", metricFrom: "marker" });
  });
});
