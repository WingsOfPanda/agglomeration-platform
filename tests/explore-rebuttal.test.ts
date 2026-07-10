import { describe, it, expect } from "vitest";
import {
  parseBucketLines, parseFindings, attributeFinding, selectRebuttalTargets, composeRebuttalPrompt,
  type CritiqueInput,
} from "../src/core/exploreRebuttal.js";
import type { Claim } from "../src/core/designDiff.js";

const buckets = (): Map<string, Claim[]> => new Map([
  ["alpha", [{ cite: "src/a.ts:10", text: "AlphaClaim — solo" }]],
  ["charlie", [{ cite: "src/c.ts:5", text: "CharlieClaim — solo" }]],
]);

const CRITIQUE_NEEDS_ATTENTION = [
  "# Adversary critique: charlie's pass",
  "## Verdict",
  "needs-attention",
  "## Material findings",
  "### Finding 1: alpha's solo claim over-reaches",
  "- **Targets:** src/a.ts:10 in the draft",
  "- **Why vulnerable:** the cited file does not say that",
  "- **Concrete fix:** soften the claim",
  "## Notes",
  "n/a",
].join("\n");

describe("parseBucketLines", () => {
  it("parses [cite] text lines; ignores non-matching lines and blanks", () => {
    expect(parseBucketLines("[src/a.ts:10] AlphaClaim — solo\n\nnot a bucket line\n")).toEqual([
      { cite: "src/a.ts:10", text: "AlphaClaim — solo" },
    ]);
  });
});

describe("parseFindings", () => {
  it("extracts each ### Finding block under ## Material findings", () => {
    const fs = parseFindings(CRITIQUE_NEEDS_ATTENTION);
    expect(fs).toHaveLength(1);
    expect(fs[0]).toContain("### Finding 1: alpha's solo claim over-reaches");
    expect(fs[0]).toContain("**Targets:** src/a.ts:10");
    expect(fs[0]).not.toContain("## Notes");
  });
  it("missing section or zero findings → []", () => {
    expect(parseFindings("## Verdict\naccept\n")).toEqual([]);
  });
});

describe("attributeFinding", () => {
  it("token overlapping exactly one agent's bucket → that agent", () => {
    expect(attributeFinding("Targets src/a.ts:10 only", buckets())).toBe("alpha");
  });
  it("tokens hitting two agents' buckets → null (tie)", () => {
    expect(attributeFinding("hits src/a.ts:10 and src/c.ts:5", buckets())).toBe(null);
  });
  it("no citation tokens → null", () => {
    expect(attributeFinding("purely prose finding with no anchors", buckets())).toBe(null);
  });
});

describe("selectRebuttalTargets", () => {
  it("only needs-attention critiques pass; findings grouped per attributed agent with attacked claims", () => {
    const critiques: CritiqueInput[] = [
      { agent: "charlie", text: CRITIQUE_NEEDS_ATTENTION },
      { agent: "alpha", text: "## Verdict\naccept\n## Material findings\n### Finding 1: x\n- **Targets:** src/c.ts:5\n" },
    ];
    const out = selectRebuttalTargets(critiques, buckets());
    expect([...out.keys()]).toEqual(["alpha"]); // accept-verdict critique dropped whole
    expect(out.get("alpha")!.findings).toHaveLength(1);
    expect(out.get("alpha")!.claims).toEqual([{ cite: "src/a.ts:10", text: "AlphaClaim — solo" }]);
  });
  it("unattributed findings are excluded", () => {
    const critiques: CritiqueInput[] = [{
      agent: "charlie",
      text: "## Verdict\nneeds-attention\n## Material findings\n### Finding 1: vague\n- **Targets:** no anchors here\n",
    }];
    expect(selectRebuttalTargets(critiques, buckets()).size).toBe(0);
  });
});

describe("composeRebuttalPrompt", () => {
  it("contains the claims, the critique text, defend-or-concede + one-turn rules, the output path; no fence", () => {
    const p = composeRebuttalPrompt(
      [{ cite: "src/a.ts:10", text: "AlphaClaim — solo" }],
      ["### Finding 1: over-reach\n- **Targets:** src/a.ts:10"],
      "/art/rebuttal-alpha.md",
    );
    expect(p).toContain("[src/a.ts:10] AlphaClaim — solo");
    expect(p).toContain("### Finding 1: over-reach");
    expect(p).toContain("DEFEND");
    expect(p).toContain("CONCEDE");
    expect(p).toContain("no counter-attacks");
    expect(p).toContain("/art/rebuttal-alpha.md");
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event"');
  });
});
