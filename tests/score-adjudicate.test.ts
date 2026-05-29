import { describe, it, expect } from "vitest";
import { parseVerdicts } from "../src/core/scoreAdjudicate.js";

describe("parseVerdicts", () => {
  it("parses AGREE/DISPUTE/UNCERTAIN under ## Verdicts with optional indented evidence", () => {
    const md = [
      "# Verify", "## Verdicts",
      "1. AGREE [src/a.ts:1] claim one",
      "   confirmed by reading the file",
      "2. DISPUTE [src/b.ts:2] claim two",
      "3. UNCERTAIN [https://x] claim three",
      "   could not fetch",
      "   second evidence line",
      "## Notes", "4. AGREE [out/scope] ignored (outside block)",
    ].join("\n");
    expect(parseVerdicts(md)).toEqual([
      { tag: "AGREE", cite: "src/a.ts:1", text: "claim one", evidence: "confirmed by reading the file" },
      { tag: "DISPUTE", cite: "src/b.ts:2", text: "claim two", evidence: "" },
      { tag: "UNCERTAIN", cite: "https://x", text: "claim three", evidence: "could not fetch second evidence line" },
    ]);
  });
  it("hallucinated tags (UNKNOWN/MAYBE) are dropped; no block → []", () => {
    expect(parseVerdicts("## Verdicts\n1. MAYBE [a] x\n")).toEqual([]);
    expect(parseVerdicts("# V\n")).toEqual([]);
  });
});
