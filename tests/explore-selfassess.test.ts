import { describe, it, expect } from "vitest";
import { parseSelfAssessment } from "../src/core/exploreSelfAssess.js";

describe("parseSelfAssessment", () => {
  it("parses grade lines and least-sure bullets", () => {
    const r = parseSelfAssessment([
      "# Self-assessment",
      "high: FlashAttention",
      "medium: PagedAttention",
      "low: RingAttention",
      "",
      "## Least sure",
      "- RingAttention scales linearly [https://x.test/ring]",
      "- kernel fusion beats batching [src/a.ts:10]",
      "## Notes",
      "- not a least-sure bullet",
    ].join("\n"));
    expect(r.grades).toEqual([
      { confidence: "high", approach: "FlashAttention" },
      { confidence: "medium", approach: "PagedAttention" },
      { confidence: "low", approach: "RingAttention" },
    ]);
    expect(r.leastSure).toEqual([
      "RingAttention scales linearly [https://x.test/ring]",
      "kernel fusion beats batching [src/a.ts:10]",
    ]);
  });
  it("empty text / missing sections → empty result", () => {
    expect(parseSelfAssessment("")).toEqual({ grades: [], leastSure: [] });
    expect(parseSelfAssessment("just prose\nno structure here")).toEqual({ grades: [], leastSure: [] });
  });
  it("least-sure extraction stops at the next ## heading", () => {
    const r = parseSelfAssessment("## Least sure\n- a [x]\n## Later\n- b [y]\n");
    expect(r.leastSure).toEqual(["a [x]"]);
  });
  it("grade confidence is case-insensitive in, lowercased out", () => {
    expect(parseSelfAssessment("HIGH: Alpha").grades).toEqual([{ confidence: "high", approach: "Alpha" }]);
  });
  it("a grade-shaped line inside Least sure is NOT a grade", () => {
    const r = parseSelfAssessment("## Least sure\n- claim [x]\nlow: NotAGrade\n## End\n");
    expect(r.grades).toEqual([]);
    expect(r.leastSure).toEqual(["claim [x]"]);
  });
});
