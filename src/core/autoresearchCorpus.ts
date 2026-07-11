// Read-only prior-campaign digest for /ap:autoresearch (campaign spine, phase A).
// Renders a capped, DATA-ONLY block of prior same-metric-family campaign outcomes
// for advisor context — governed like lessons: same-family filter, injection-
// denylist EXCLUSION (fail-closed), no imperative text, and it never feeds a gate.
// PURE: the corpus-digest verb walks ~/.ap/archive + ~/.ap/forensics and does the
// IO; NOTHING under the corpus roots is ever written by this path.

import { containsInjection } from "./autoresearchMemory.js";

export interface CorpusEntry {
  topicSlug: string;
  metricFamily: string;
  leaderMetric: string;     // final leader metric value ("" when none)
  verifiedLessons: number;  // A1 'verified' verdict count in the archived verification.tsv
  haltReason: string;       // halt.flag reason ("completed" when the campaign ran to term)
  forensicsFlags: number;   // matching forensics feed files for the topic
}

/** The rank-1 (integer-rank) scoreboard row's metric cell; "" when absent. Same
 *  row shape checkCompletion parses (| 1 | exp-… | agent | metric | …). */
export function leaderMetricOf(scoreboardMd: string | null): string {
  if (!scoreboardMd) return "";
  for (const line of scoreboardMd.split("\n")) {
    if (/^\|\s+1\s+\|\s+exp-/.test(line)) return line.split("|").map((s) => s.trim())[4] ?? "";
  }
  return "";
}

/** Render the digest block: same-family entries only, injection-matching entries
 *  EXCLUDED, capped (default 5, caller orders newest-first). "" when nothing survives. */
export function buildCorpusDigest(entries: CorpusEntry[], opts: { metricFamily: string; cap?: number }): string {
  const cap = opts.cap ?? 5;
  const kept = entries
    .filter((e) => e.metricFamily === opts.metricFamily)
    .filter((e) => !containsInjection([e.topicSlug, e.leaderMetric, e.haltReason].join(" ")))
    .slice(0, cap);
  if (kept.length === 0) return "";
  return [
    "## Prior campaigns (data-only)",
    "",
    ...kept.map((e) =>
      `- ${e.topicSlug}: leader=${e.leaderMetric || "n/a"} verified_lessons=${e.verifiedLessons} halt=${e.haltReason || "completed"} forensics_flags=${e.forensicsFlags}`),
  ].join("\n") + "\n";
}
