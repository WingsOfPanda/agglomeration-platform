import { describe, it, expect } from "vitest";
import { parseAdversaryVerdict, tallyVerdicts } from "../src/core/exploreVerdict.js";

describe("parseAdversaryVerdict", () => {
  it("parses each enum value from the first non-empty line under ## Verdict", () => {
    expect(parseAdversaryVerdict("# T\n## Verdict\naccept\n## Material findings\n")).toBe("accept");
    expect(parseAdversaryVerdict("## Verdict\nminor-revisions")).toBe("minor-revisions");
    expect(parseAdversaryVerdict("## Verdict\nneeds-attention\n")).toBe("needs-attention");
  });
  it("tolerates surrounding whitespace and value case", () => {
    expect(parseAdversaryVerdict("## Verdict\n\n   Accept  \n")).toBe("accept");
    expect(parseAdversaryVerdict("## Verdict\n  NEEDS-ATTENTION\n")).toBe("needs-attention");
  });
  it("prose on the verdict line is malformed", () => {
    expect(parseAdversaryVerdict("## Verdict\nlooks fine to me\n")).toBe("malformed");
    expect(parseAdversaryVerdict("## Verdict\n<one line: needs-attention | minor-revisions | accept>\n")).toBe("malformed");
  });
  it("missing ## Verdict heading, empty section, or empty text is malformed", () => {
    expect(parseAdversaryVerdict("# critique\nno verdict here\n")).toBe("malformed");
    expect(parseAdversaryVerdict("## Verdict\n## Material findings\naccept\n")).toBe("malformed");
    expect(parseAdversaryVerdict("")).toBe("malformed");
  });
});

describe("tallyVerdicts", () => {
  const r = (agent: string, verdict: string) => ({ agent, verdict });
  it("majority wins", () => {
    expect(tallyVerdicts([r("a", "accept"), r("b", "accept"), r("c", "needs-attention")]).tally).toBe("accept");
    expect(tallyVerdicts([r("a", "minor-revisions"), r("b", "minor-revisions"), r("c", "accept")]).tally).toBe("minor-revisions");
  });
  it("1-1 tie at N=2 breaks to the MOST severe", () => {
    expect(tallyVerdicts([r("a", "accept"), r("b", "needs-attention")]).tally).toBe("needs-attention");
    expect(tallyVerdicts([r("a", "minor-revisions"), r("b", "accept")]).tally).toBe("minor-revisions");
    expect(tallyVerdicts([r("a", "needs-attention"), r("b", "minor-revisions")]).tally).toBe("needs-attention");
  });
  it("skipped and malformed rows are excluded from the majority", () => {
    expect(tallyVerdicts([r("a", "accept"), r("b", "skipped"), r("c", "malformed")]).tally).toBe("accept");
    expect(tallyVerdicts([r("a", "needs-attention"), r("b", "skipped"), r("c", "accept"), r("d", "accept")]).tally).toBe("accept");
  });
  it("zero countable rows → unavailable", () => {
    expect(tallyVerdicts([]).tally).toBe("unavailable");
    expect(tallyVerdicts([r("a", "skipped"), r("b", "malformed")]).tally).toBe("unavailable");
  });
});
