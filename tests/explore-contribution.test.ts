import { describe, it, expect } from "vitest";
import { buildContribution, renderContributionTsv, type ContributionArtifacts } from "../src/core/exploreContribution.js";

const EMPTY: ContributionArtifacts = {
  findings: "", soloBucket: "", adversary: "", adversaryTag: null, rebuttal: "", signoff: "", signoffTag: null,
};
const FINDINGS_ALPHA = [
  "## Approaches",
  "1. [src/a.ts:10] Shared — both",
  "2. [src/only-a.ts:1] AlphaOnly — solo",
  "3. [paper:arxiv:7] AlphaPaper — solo",
  "## Notes", "n",
].join("\n");

describe("buildContribution", () => {
  it("counts total/solo, derives consensus, attributes peer verdicts via citation overlap", () => {
    const rows = buildContribution({
      rows: [{ agent: "alpha", provider: "codex" }, { agent: "charlie", provider: "claude" }],
      artifacts: {
        alpha: {
          ...EMPTY,
          findings: FINDINGS_ALPHA,
          soloBucket: "[src/only-a.ts:1] AlphaOnly — solo\n[paper:arxiv:7] AlphaPaper — solo\n",
          adversary: "## Verdict\naccept\n", adversaryTag: "ok",
          rebuttal: "# Rebuttal\n## Responses\n1. DEFEND the claim holds\n   [src/only-a.ts:1]\n2. CONCEDE the doc should soften\n",
          signoff: "# Sign-off\nVERDICT: fair\n", signoffTag: "ok",
        },
        charlie: { ...EMPTY, findings: "## Approaches\n1. [src/a.ts:10] Shared — both\n" },
      },
      // charlie verified alpha's solo claims: AGREE on the file cite (overlap), DISPUTE on the
      // paper: cite (exact match), plus a verdict on an unrelated cite that must NOT attribute.
      crossverify: {
        charlie: [
          "# Verify", "## Verdicts",
          "1. AGREE [src/only-a.ts:1] AlphaOnly — solo",
          "   checked the file",
          "2. DISPUTE [paper:arxiv:7] AlphaPaper — solo",
          "   the paper says otherwise",
          "3. AGREE [src/unrelated.ts:5] SomethingElse",
        ].join("\n"),
        alpha: "",
      },
    });
    expect(rows[0]).toEqual({
      agent: "alpha", provider: "codex",
      claims_total: 3, claims_solo: 2, claims_consensus: 1,
      peer_agree: 1, peer_dispute: 1, peer_uncertain: 0,
      adversary_verdict: "accept",
      rebuttal_defended: 1, rebuttal_conceded: 1,
      signoff: "fair",
    });
    expect(rows[1].claims_total).toBe(1);
    expect(rows[1].claims_solo).toBe(0);
    expect(rows[1].claims_consensus).toBe(1);
  });
  it("a worker's own crossverify file never attributes to itself", () => {
    const rows = buildContribution({
      rows: [{ agent: "alpha", provider: "codex" }],
      artifacts: { alpha: { ...EMPTY, soloBucket: "[src/x.ts:1] X — solo\n" } },
      crossverify: { alpha: "## Verdicts\n1. AGREE [src/x.ts:1] X — solo\n" },
    });
    expect(rows[0].peer_agree).toBe(0);
  });
  it("missing/skipped artifacts → zeros and skipped, never an error", () => {
    const rows = buildContribution({
      rows: [{ agent: "golf", provider: "agy" }],
      artifacts: {}, crossverify: {},
    });
    expect(rows[0]).toEqual({
      agent: "golf", provider: "agy",
      claims_total: 0, claims_solo: 0, claims_consensus: 0,
      peer_agree: 0, peer_dispute: 0, peer_uncertain: 0,
      adversary_verdict: "skipped",
      rebuttal_defended: 0, rebuttal_conceded: 0,
      signoff: "skipped",
    });
  });
  it("AS=skipped → adversary_verdict skipped; SS=skipped → signoff skipped even with file text", () => {
    const rows = buildContribution({
      rows: [{ agent: "alpha", provider: "codex" }],
      artifacts: { alpha: { ...EMPTY, adversary: "## Verdict\naccept\n", adversaryTag: "skipped", signoff: "VERDICT: fair\n", signoffTag: "skipped" } },
      crossverify: {},
    });
    expect(rows[0].adversary_verdict).toBe("skipped");
    expect(rows[0].signoff).toBe("skipped");
  });
  it("garbage adversary/signoff text → malformed (still no throw)", () => {
    const rows = buildContribution({
      rows: [{ agent: "alpha", provider: "codex" }],
      artifacts: { alpha: { ...EMPTY, adversary: "no verdict heading", adversaryTag: "ok", signoff: "prose only", signoffTag: "ok" } },
      crossverify: {},
    });
    expect(rows[0].adversary_verdict).toBe("malformed");
    expect(rows[0].signoff).toBe("malformed");
  });
});

describe("renderContributionTsv", () => {
  it("renders a # header + one tab-separated row per worker, scrubbing tabs/newlines in cells", () => {
    const tsv = renderContributionTsv([{
      agent: "al\tpha", provider: "co\ndex",
      claims_total: 2, claims_solo: 1, claims_consensus: 1,
      peer_agree: 1, peer_dispute: 0, peer_uncertain: 0,
      adversary_verdict: "accept", rebuttal_defended: 0, rebuttal_conceded: 0, signoff: "fair",
    }]);
    const lines = tsv.trimEnd().split("\n");
    expect(lines[0]).toBe("# agent\tprovider\tclaims_total\tclaims_solo\tclaims_consensus\tpeer_agree\tpeer_dispute\tpeer_uncertain\tadversary_verdict\trebuttal_defended\trebuttal_conceded\tsignoff");
    expect(lines[1]).toBe("al pha\tco dex\t2\t1\t1\t1\t0\t0\taccept\t0\t0\tfair");
    expect(lines.length).toBe(2);
  });
});
