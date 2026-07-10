// src/core/exploreContribution.ts — per-provider contribution scoreboard for /ap:explore (E4).
// Pure: pre-read artifact texts in → plain-count rows + TSV out. STRICTLY informational: the verb
// archives the TSV with the art dir and Phase 10 prints it; nothing here feeds a gate, a dispatch
// decision, or synthesis weighting (gate-as-loop-predicate and entropy/diversity metrics are
// rejected non-goals — plain integer counts and enum cells only). Missing/skipped artifacts →
// zeros/"skipped", never an error.
import { parseClaims, citationOverlaps } from "./designDiff.js";
import { parseVerdicts } from "./designAdjudicate.js";
import { parseBucketLines } from "./exploreRebuttal.js";
import { parseAdversaryVerdict } from "./exploreVerdict.js";

export interface ContributionArtifacts {
  findings: string;            // findings-<agent>.md ("" when missing)
  soloBucket: string;          // <agent>_only_items.txt ("" when missing)
  adversary: string;           // adversary-<agent>.md ("" when missing)
  adversaryTag: string | null; // last AS= tag (null when no state file)
  rebuttal: string;            // rebuttal-<agent>.md ("" when missing)
  signoff: string;             // signoff-<agent>.md ("" when missing)
  signoffTag: string | null;   // last SS= tag (null when no state file)
}
export interface ContributionInput {
  rows: { agent: string; provider: string }[];      // list-original.txt when present, else list.txt
  artifacts: Record<string, ContributionArtifacts>; // by agent
  crossverify: Record<string, string>;              // by VERIFYING agent → crossverify-<agent>.md text
}
export interface ContributionRow {
  agent: string; provider: string;
  claims_total: number; claims_solo: number; claims_consensus: number;
  peer_agree: number; peer_dispute: number; peer_uncertain: number;
  adversary_verdict: string;
  rebuttal_defended: number; rebuttal_conceded: number;
  signoff: string;
}

const NO_ARTIFACTS: ContributionArtifacts = {
  findings: "", soloBucket: "", adversary: "", adversaryTag: null, rebuttal: "", signoff: "", signoffTag: null,
};

/** Best-effort count of `N. TAG ...` response lines anywhere in a rebuttal file. */
function countResponses(text: string, tag: "DEFEND" | "CONCEDE"): number {
  return text.split("\n").filter((l) => new RegExp(`^[0-9]+\\. ${tag}\\b`).test(l)).length;
}

/** First `VERDICT: fair|misrepresented` line; "skipped" on SS=skipped/empty; else "malformed". */
function signoffVerdict(text: string, tag: string | null): string {
  if (tag === "skipped" || !text.trim()) return "skipped";
  const m = text.match(/^VERDICT:[ \t]*(fair|misrepresented)[ \t]*$/im);
  return m ? m[1].toLowerCase() : "malformed";
}

export function buildContribution(input: ContributionInput): ContributionRow[] {
  return input.rows.map((r) => {
    const a = input.artifacts[r.agent] ?? NO_ARTIFACTS;
    const solo = parseBucketLines(a.soloBucket);
    const total = parseClaims(a.findings, ["Approaches"]).length;
    // Peer verdicts on THIS worker's solo claims: parse the OTHER workers' crossverify files and
    // attribute each verdict to the owner bucket by citation overlap. At N=2 no consensus file
    // exists (designDiff writes only <name>_only_items.txt) — consensus is DERIVED, never read.
    let agree = 0, dispute = 0, uncertain = 0;
    for (const [verifier, text] of Object.entries(input.crossverify)) {
      if (verifier === r.agent) continue;
      for (const v of parseVerdicts(text)) {
        if (solo.some((c) => citationOverlaps(v.cite, c.cite))) {
          if (v.tag === "AGREE") agree++; else if (v.tag === "DISPUTE") dispute++; else uncertain++;
        }
      }
    }
    const adversary_verdict = a.adversaryTag === "skipped" || !a.adversary.trim()
      ? "skipped" : parseAdversaryVerdict(a.adversary);
    return {
      agent: r.agent, provider: r.provider,
      claims_total: total, claims_solo: solo.length, claims_consensus: Math.max(0, total - solo.length),
      peer_agree: agree, peer_dispute: dispute, peer_uncertain: uncertain,
      adversary_verdict,
      rebuttal_defended: countResponses(a.rebuttal, "DEFEND"),
      rebuttal_conceded: countResponses(a.rebuttal, "CONCEDE"),
      signoff: signoffVerdict(a.signoff, a.signoffTag),
    };
  });
}

const COLUMNS = [
  "agent", "provider", "claims_total", "claims_solo", "claims_consensus",
  "peer_agree", "peer_dispute", "peer_uncertain",
  "adversary_verdict", "rebuttal_defended", "rebuttal_conceded", "signoff",
] as const;

/** `# `-prefixed header + one TSV row per worker; cells scrubbed of tabs/newlines (single space). */
export function renderContributionTsv(rows: ContributionRow[]): string {
  const scrub = (v: string | number): string => String(v).replace(/[\t\n\r]+/g, " ");
  return `# ${COLUMNS.join("\t")}\n` +
    rows.map((r) => COLUMNS.map((c) => scrub(r[c])).join("\t") + "\n").join("");
}
