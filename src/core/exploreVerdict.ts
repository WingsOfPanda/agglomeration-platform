// src/core/exploreVerdict.ts — deterministic adversary-verdict parse + tally for /ap:explore.
// Pure: critique text / verdict rows in → enum + majority out. Consumed by the `verdict-tally`
// verb; the tally shapes the Hub's Phase 8 prose obligations only — NEVER an automatic loop or
// re-dispatch (gate-as-loop-predicate stays a rejected non-goal).

/** Severity order, most severe first. A tie in the tally breaks toward the earlier entry. */
const SEVERITY = ["needs-attention", "minor-revisions", "accept"] as const;
export type AdversaryVerdict = (typeof SEVERITY)[number];

function isVerdict(v: string): v is AdversaryVerdict {
  return (SEVERITY as readonly string[]).includes(v);
}

/** The first non-empty line under `## Verdict` (until the next `## ` heading), trimmed and
 *  lowercased. Anything other than the three enum values — including a missing heading or an
 *  empty section — is `malformed`. */
export function parseAdversaryVerdict(text: string): AdversaryVerdict | "malformed" {
  let inVerdict = false;
  for (const line of text.split("\n")) {
    if (/^## Verdict\b/.test(line)) { inVerdict = true; continue; }
    if (/^## /.test(line)) { inVerdict = false; continue; }
    if (!inVerdict || !line.trim()) continue;
    const v = line.trim().toLowerCase();
    return isVerdict(v) ? v : "malformed";
  }
  return "malformed";
}

export interface VerdictRow { agent: string; verdict: string }

/** Majority over the countable rows (the three enum values). Ties break to the MOST severe;
 *  `skipped`/`malformed` rows are excluded from the majority (reported per-agent by the verb);
 *  zero countable rows → `unavailable`. */
export function tallyVerdicts(rows: VerdictRow[]): { tally: string } {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (isVerdict(r.verdict)) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
  }
  let tally = "unavailable";
  let best = 0;
  for (const v of SEVERITY) { // severity order + strict > : a tie keeps the more severe value
    const n = counts.get(v) ?? 0;
    if (n > best) { tally = v; best = n; }
  }
  return { tally };
}
