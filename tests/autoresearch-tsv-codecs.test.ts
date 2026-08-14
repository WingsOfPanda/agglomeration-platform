import { describe, it, expect } from "vitest";

import { splitTsvRows } from "../src/core/tsv.js";
import {
  sanityRow, sanityTsvPath, parseSanityRows, SANITY_TSV_HEADER, type SanityRow,
} from "../src/core/autoresearchSanity.js";
import {
  coverageRow, coverageTsvPath, parseCoverageRows, COVERAGE_TSV_HEADER, type CoverageRow,
} from "../src/core/autoresearchCoverage.js";
import {
  lineageRow, lineageTsvPath, parseLineageRows, LINEAGE_TSV_HEADER, type LineageRow,
} from "../src/core/autoresearchLineage.js";
import {
  verificationRow, verificationTsvPath, parseVerificationRows, VERIFICATION_TSV_HEADER,
  type VerificationRow,
} from "../src/core/autoresearchVerify.js";
import {
  inspectionRow, inspectionTsvPath, parseInspectionRows, INSPECTION_TSV_HEADER,
  type InspectionRow,
} from "../src/core/autoresearchInspect.js";

/** The on-disk file for one artifact: header + rendered rows, exactly as the writers build it. */
function render<T>(header: string, rows: T[], one: (r: T) => string): string {
  return header + rows.map(one).join("");
}

describe("splitTsvRows", () => {
  it("skips the header row and blank lines, tab-splits the rest", () => {
    expect(splitTsvRows("exp_id\tagent\n\na\tb\n\nc\td\n", "exp_id\t")).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("empty text and a header-only file both yield no rows", () => {
    expect(splitTsvRows("", "exp_id\t")).toEqual([]);
    expect(splitTsvRows("exp_id\tagent\tverdict\n", "exp_id\t")).toEqual([]);
  });
  it("only the configured header token is skipped (a coverage file keeps its exp_id-looking data)", () => {
    expect(splitTsvRows("family\tcount\nexp_id\t3\n", "family\t")).toEqual([["exp_id", "3"]]);
  });
});

describe("sanity.tsv codec", () => {
  const rows: SanityRow[] = [
    { expId: "exp-001", agent: "alpha", flag: "under-run", detail: "runtime=0.1 floor=1", ts: "2026-08-14T00:00:00Z" },
    { expId: "exp-002", agent: "bravo", flag: "data-leakage", detail: "", ts: "" },
  ];
  it("render -> parse round-trips every column, empty fields included", () => {
    expect(parseSanityRows(render(SANITY_TSV_HEADER, rows, sanityRow))).toEqual(rows);
  });
  it("header-only / absent-as-empty yields no rows", () => {
    expect(parseSanityRows(SANITY_TSV_HEADER)).toEqual([]);
    expect(parseSanityRows("")).toEqual([]);
  });
  it("a short row reads its missing trailing cells as empty strings", () => {
    expect(parseSanityRows("exp-003\tcharlie\tceiling-exceeded\n")).toEqual([
      { expId: "exp-003", agent: "charlie", flag: "ceiling-exceeded", detail: "", ts: "" },
    ]);
  });
  it("states the filename once", () => {
    expect(sanityTsvPath("/a/_autoresearch")).toBe("/a/_autoresearch/sanity.tsv");
  });
});

describe("coverage.tsv codec", () => {
  const rows: CoverageRow[] = [
    { family: "dropout", count: 3, best: "0.91", ts: "2026-08-14T00:00:00Z" },
    { family: "(unlabeled)", count: 0, best: "", ts: "" },
  ];
  it("render -> parse round-trips every column, empty fields included", () => {
    expect(parseCoverageRows(render(COVERAGE_TSV_HEADER, rows, coverageRow))).toEqual(rows);
  });
  it("count keeps the tolerant parse (absent / unparseable -> 0)", () => {
    expect(parseCoverageRows("aug\n").map((r) => r.count)).toEqual([0]);
    expect(parseCoverageRows("aug\tmany\n").map((r) => r.count)).toEqual([0]);
  });
  it("header-only / absent-as-empty yields no rows", () => {
    expect(parseCoverageRows(COVERAGE_TSV_HEADER)).toEqual([]);
    expect(parseCoverageRows("")).toEqual([]);
  });
  it("states the filename once", () => {
    expect(coverageTsvPath("/a/_autoresearch")).toBe("/a/_autoresearch/coverage.tsv");
  });
});

describe("lineage.tsv codec", () => {
  const rows: LineageRow[] = [
    { expId: "exp-001", agent: "alpha", parentId: "", knobsChanged: "", verdict: "draft", ts: "T1" },
    { expId: "exp-002", agent: "alpha", parentId: "exp-001", knobsChanged: "2", verdict: "improve-multi", ts: "T2" },
  ];
  it("render -> parse round-trips every column, empty fields included", () => {
    expect(parseLineageRows(render(LINEAGE_TSV_HEADER, rows, lineageRow))).toEqual(rows);
  });
  it("verdict is the 5th column, not the 3rd (a swapped parser would read parent_id here)", () => {
    expect(parseLineageRows(render(LINEAGE_TSV_HEADER, rows, lineageRow))
      .filter((r) => r.verdict === "improve-multi").map((r) => r.expId)).toEqual(["exp-002"]);
  });
  it("header-only / absent-as-empty yields no rows", () => {
    expect(parseLineageRows(LINEAGE_TSV_HEADER)).toEqual([]);
    expect(parseLineageRows("")).toEqual([]);
  });
  it("states the filename once", () => {
    expect(lineageTsvPath("/a/_autoresearch")).toBe("/a/_autoresearch/lineage.tsv");
  });
});

describe("verification.tsv codec", () => {
  const rows: VerificationRow[] = [
    { expId: "exp-001", agent: "alpha", verdict: "verified", reason: "", recomputed: "0.95", ts: "T1" },
    { expId: "exp-002", agent: "bravo", verdict: "mismatch", reason: "value:0.5vs0.9", recomputed: "0.5", ts: "T2" },
    { expId: "exp-003", agent: "bravo", verdict: "unavailable", reason: "no-manifest", recomputed: "", ts: "" },
  ];
  it("render -> parse round-trips reason/recomputed too (the columns nothing used to read)", () => {
    expect(parseVerificationRows(render(VERIFICATION_TSV_HEADER, rows, verificationRow))).toEqual(rows);
  });
  it("header-only / absent-as-empty yields no rows", () => {
    expect(parseVerificationRows(VERIFICATION_TSV_HEADER)).toEqual([]);
    expect(parseVerificationRows("")).toEqual([]);
  });
  it("states the filename once", () => {
    expect(verificationTsvPath("/a/_autoresearch")).toBe("/a/_autoresearch/verification.tsv");
  });
});

describe("inspection.tsv codec", () => {
  const rows: InspectionRow[] = [
    { expId: "exp-001", agent: "alpha", verdict: "reproduced", reason: "", reimplMetric: "0.94", ts: "T1" },
    { expId: "exp-002", agent: "alpha", verdict: "not-reproduced", reason: "integrity-refuted", reimplMetric: "", ts: "T2" },
    { expId: "exp-003", agent: "bravo", verdict: "inconclusive", reason: "reimpl-failed", reimplMetric: "", ts: "" },
  ];
  it("render -> parse round-trips reason/reimpl_metric too (the columns nothing used to read)", () => {
    expect(parseInspectionRows(render(INSPECTION_TSV_HEADER, rows, inspectionRow))).toEqual(rows);
  });
  it("header-only / absent-as-empty yields no rows", () => {
    expect(parseInspectionRows(INSPECTION_TSV_HEADER)).toEqual([]);
    expect(parseInspectionRows("")).toEqual([]);
  });
  it("states the filename once", () => {
    expect(inspectionTsvPath("/a/_autoresearch")).toBe("/a/_autoresearch/inspection.tsv");
  });
});

describe("tsv format limit", () => {
  it("a tab inside a field is not escaped by the renderer — it reads back as extra columns", () => {
    const [r] = parseSanityRows(sanityRow(
      { expId: "exp-001", agent: "alpha", flag: "log-contradiction", detail: "file=a\tb", ts: "T1" }));
    expect(r.detail).toBe("file=a");   // the embedded tab shifted ts; documented, not supported
    expect(r.ts).toBe("b");
  });
});
