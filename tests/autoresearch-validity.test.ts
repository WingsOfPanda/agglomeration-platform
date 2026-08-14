// tests/autoresearch-validity.test.ts — the validity verbs' real append path + threshold defaults.
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { autoresearchArtDir, experimentDir } from "../src/core/autoresearch.js";
import { appendVerificationRow, appendInspectionRow, readExperimentResult } from "../src/core/autoresearchValidity.js";
import { resolveValidityThresholds } from "../src/core/autoresearchMetric.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** A fresh campaign art dir with alpha/exp-001's experiment dir on disk (the sidecar's home). */
function artWithExperiment(): string {
  const h = freshHome();
  cleanups.push(h.cleanup);
  const art = autoresearchArtDir("validity-topic", { home: h.home });
  mkdirSync(experimentDir(art, "alpha", "exp-001"), { recursive: true });
  return art;
}

describe("appendVerificationRow", () => {
  it("seeds the header on the first row and appends to it on the second", () => {
    const art = artWithExperiment();
    appendVerificationRow(art, "alpha", "exp-001", { expId: "exp-001", agent: "alpha", verdict: "verified", reason: "", recomputed: "0.9", ts: "T1" });
    expect(readFileSync(join(art, "verification.tsv"), "utf8")).toBe(
      "exp_id\tagent\tverdict\treason\trecomputed\tts\nexp-001\talpha\tverified\t\t0.9\tT1\n");
    appendVerificationRow(art, "alpha", "exp-001", { expId: "exp-002", agent: "alpha", verdict: "mismatch", reason: "no-marker", recomputed: "", ts: "T2" });
    expect(readFileSync(join(art, "verification.tsv"), "utf8")).toBe(
      "exp_id\tagent\tverdict\treason\trecomputed\tts\n" +
      "exp-001\talpha\tverified\t\t0.9\tT1\n" +
      "exp-002\talpha\tmismatch\tno-marker\t\tT2\n");
  });
  it("stamps the experiment's verification.txt sidecar", () => {
    const art = artWithExperiment();
    appendVerificationRow(art, "alpha", "exp-001", { expId: "exp-001", agent: "alpha", verdict: "mismatch", reason: "value:0.5vs0.9", recomputed: "0.5", ts: "T1" });
    expect(readFileSync(join(experimentDir(art, "alpha", "exp-001"), "verification.txt"), "utf8"))
      .toBe("mismatch reason=value:0.5vs0.9 recomputed=0.5 at T1\n");
  });
});

describe("appendInspectionRow", () => {
  it("seeds the header on the first row and appends to it on the second", () => {
    const art = artWithExperiment();
    appendInspectionRow(art, "alpha", "exp-001", { expId: "exp-001", agent: "alpha", verdict: "reproduced", reason: "", reimplMetric: "0.9", ts: "T1" });
    expect(readFileSync(join(art, "inspection.tsv"), "utf8")).toBe(
      "exp_id\tagent\tverdict\treason\treimpl_metric\tts\nexp-001\talpha\treproduced\t\t0.9\tT1\n");
    appendInspectionRow(art, "alpha", "exp-001", { expId: "exp-002", agent: "alpha", verdict: "inconclusive", reason: "reimpl-failed", reimplMetric: "", ts: "T2" });
    expect(readFileSync(join(art, "inspection.tsv"), "utf8")).toBe(
      "exp_id\tagent\tverdict\treason\treimpl_metric\tts\n" +
      "exp-001\talpha\treproduced\t\t0.9\tT1\n" +
      "exp-002\talpha\tinconclusive\treimpl-failed\t\tT2\n");
  });
  it("stamps the experiment's inspection.txt sidecar with the reimpl_metric field", () => {
    const art = artWithExperiment();
    appendInspectionRow(art, "alpha", "exp-001", { expId: "exp-001", agent: "alpha", verdict: "not-reproduced", reason: "integrity-refuted", reimplMetric: "", ts: "T1" });
    expect(readFileSync(join(experimentDir(art, "alpha", "exp-001"), "inspection.txt"), "utf8"))
      .toBe("not-reproduced reason=integrity-refuted reimpl_metric= at T1\n");
  });
});

// chmod is a no-op for root, so the sidecar write would succeed and the ordering go unprobed.
const asRoot = process.getuid?.() === 0;
describe.skipIf(asRoot)("append ordering", () => {
  it("writes the TSV before the sidecar: a sidecar that cannot be written keeps the row", () => {
    const art = artWithExperiment();
    const exp = experimentDir(art, "alpha", "exp-001");
    chmodSync(exp, 0o555);
    try {
      expect(() => appendVerificationRow(art, "alpha", "exp-001",
        { expId: "exp-001", agent: "alpha", verdict: "verified", reason: "", recomputed: "0.9", ts: "T1" })).toThrow();
      expect(readFileSync(join(art, "verification.tsv"), "utf8")).toBe(
        "exp_id\tagent\tverdict\treason\trecomputed\tts\nexp-001\talpha\tverified\t\t0.9\tT1\n");
      expect(existsSync(join(exp, "verification.txt"))).toBe(false);
    } finally {
      chmodSync(exp, 0o755); // else the home cleanup cannot unlink through it
    }
  });
});

describe("readExperimentResult", () => {
  it("reads the experiment's result.json", () => {
    const art = artWithExperiment();
    writeFileSync(join(experimentDir(art, "alpha", "exp-001"), "result.json"), '{"metric_value":0.9}\n');
    expect(readExperimentResult(art, "alpha", "exp-001")).toEqual({ metric_value: 0.9 });
    expect(readExperimentResult(art, "alpha", "exp-002")).toBeNull();
  });
});

describe("resolveValidityThresholds", () => {
  it("no metric.md -> the defaults, c1Epsilon twice verifyEpsilon", () => {
    expect(resolveValidityThresholds(null)).toEqual({ verifyEpsilon: 0.01, c1Epsilon: 0.02, c1Budget: 2 });
  });
  it("a metric.md without the validity fields -> the same defaults", () => {
    expect(resolveValidityThresholds("**Primary metric:** accuracy\n**Direction:** maximize\n"))
      .toEqual({ verifyEpsilon: 0.01, c1Epsilon: 0.02, c1Budget: 2 });
  });
  it("verify_epsilon alone widens c1Epsilon with it", () => {
    expect(resolveValidityThresholds("**verify_epsilon:** 0.2\n"))
      .toEqual({ verifyEpsilon: 0.2, c1Epsilon: 0.4, c1Budget: 2 });
  });
  it("an explicit c1_epsilon wins over the derivation", () => {
    expect(resolveValidityThresholds("**verify_epsilon:** 0.2\n**c1_epsilon:** 0.05\n**c1_budget:** 3\n"))
      .toEqual({ verifyEpsilon: 0.2, c1Epsilon: 0.05, c1Budget: 3 });
  });
});
