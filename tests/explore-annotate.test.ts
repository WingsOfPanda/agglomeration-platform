import { describe, it, expect } from "vitest";
import { uncitedMatrixReasons, buildAnnotations } from "../src/core/exploreAnnotate.js";
import { computeSignals } from "../src/core/exploreConfidence.js";

const MATRIX = [
  "## Tradeoff matrix",
  "| Priority | Best fit | Reason |",
  "|---|---|---|",
  "| latency | flash | it is simply faster |",        // uncited -> flagged
  "| memory | ring | /papers/ring.pdf shows it |",    // cited -> not flagged
  "## Citations",
].join("\n");

describe("uncitedMatrixReasons", () => {
  it("flags only data rows whose Reason cell has no citation token", () => {
    const out = uncitedMatrixReasons(MATRIX);
    expect(out.map((r) => r.lineIndex)).toEqual([3]); // the 'it is simply faster' row
    expect(out[0].reason).toBe("it is simply faster");
  });
  it("ignores the header and separator rows", () => {
    // header 'Reason' and separator '---' both lack citations but must NOT be flagged
    expect(uncitedMatrixReasons(MATRIX).length).toBe(1);
  });
  it("empty when every Reason cell carries a citation", () => {
    const m = ["## Tradeoff matrix", "| a | b | /p/x.pdf ok |", "## End"].join("\n");
    expect(uncitedMatrixReasons(m)).toEqual([]);
  });
  it("column-count guard ignores a 4-column row; detects a trailing uncited 3-col row", () => {
    const m = [
      "## Tradeoff matrix",
      "| a | b | c | d |",                  // 4 columns, uncited -> ignored by the cells.length guard
      "| latency | one | plain prose |",    // trailing 3-col uncited row (last line, no separator after)
    ].join("\n");
    expect(uncitedMatrixReasons(m).map((r) => r.lineIndex)).toEqual([2]);
  });
});

const FIND_A = "alpha found https://solo.example/q . also https://both.example/p . uncertain about edge.";
const FIND_B = "beta found https://both.example/p only.";

const DRAFT = [
  "## Approaches",
  "1. [https://solo.example/q] Approach One — desc",   // solo citation on an Approaches line
  "## Findings by worker",
  "Claim backed by https://solo.example/q and https://both.example/p.",
  "## Tradeoff matrix",
  "| latency | One | it is simply faster |",            // uncited reason cell
  "## Citations",
  "- https://solo.example/q single-source",             // trailing text -> newline-safe token
  "- https://both.example/p corroborated",
].join("\n");

describe("buildAnnotations", () => {
  it("appends [unverified] to a solo citation outside Approaches", () => {
    const { annotatedDraft } = buildAnnotations(DRAFT, [FIND_A, FIND_B]);
    expect(annotatedDraft).toContain("https://solo.example/q [unverified] and https://both.example/p");
    expect(annotatedDraft).not.toContain("https://both.example/p [unverified]"); // corroborated -> untouched
  });
  it("does NOT edit an Approaches line; records it as approaches-flagged", () => {
    const { annotatedDraft, plan } = buildAnnotations(DRAFT, [FIND_A, FIND_B]);
    expect(annotatedDraft).toContain("1. [https://solo.example/q] Approach One — desc"); // byte-identical
    expect(plan.items.some((i) => i.kind === "approaches-flagged" && i.token === "https://solo.example/q")).toBe(true);
  });
  it("appends [no citation] inside an uncited matrix Reason cell", () => {
    const { annotatedDraft } = buildAnnotations(DRAFT, [FIND_A, FIND_B]);
    expect(annotatedDraft).toContain("| latency | One | it is simply faster [no citation] |");
  });

  it("INVARIANT: all five gate signals are byte-identical after annotation", () => {
    const findings = [FIND_A, FIND_B];
    const { annotatedDraft } = buildAnnotations(DRAFT, findings);
    expect(computeSignals(annotatedDraft, findings)).toEqual(computeSignals(DRAFT, findings));
  });
  it("INVARIANT holds for a CONTESTED-saturated, low-convergence draft", () => {
    const d = DRAFT + "\nThis is CONTESTED and uncertain.";
    const findings = ["nothing relevant", "also nothing"];
    const { annotatedDraft } = buildAnnotations(d, findings);
    expect(computeSignals(annotatedDraft, findings)).toEqual(computeSignals(d, findings));
  });
  it("IDEMPOTENT: re-annotating an annotated draft is a no-op", () => {
    const findings = [FIND_A, FIND_B];
    const once = buildAnnotations(DRAFT, findings).annotatedDraft;
    const twice = buildAnnotations(once, findings).annotatedDraft;
    expect(twice).toBe(once);
  });
  it("INVARIANT: a solo path-citation LEADING a matrix Reason cell keeps S4 (and all signals)", () => {
    // /papers/p.pdf leads the Reason cell (S4-good) and is solo (1 finding). Rule 1 appends
    // [unverified] INSIDE the cell after the path, so the cell still leads with '/' -> S4 stays good.
    const d = [
      "## Approaches", "1. One — x",
      "## Tradeoff matrix", "| latency | one | /papers/p.pdf proves it |",
      "## Citations", "- /papers/p.pdf single",
    ].join("\n");
    const findings = ["only alpha cites /papers/p.pdf here", "beta cites nothing relevant"];
    const { annotatedDraft } = buildAnnotations(d, findings);
    expect(annotatedDraft).toContain("/papers/p.pdf [unverified] proves it");
    expect(computeSignals(annotatedDraft, findings)).toEqual(computeSignals(d, findings));
  });
});
