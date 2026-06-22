import { describe, it, expect } from "vitest";
import { uncitedMatrixReasons } from "../src/core/exploreAnnotate.js";

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
});
