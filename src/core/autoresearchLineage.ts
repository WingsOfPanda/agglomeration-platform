// Lineage advisory for /ap:autoresearch (B2 operators & ideation quality). Pure: no FS/clock.
// Records the Draft/Improve edge per experiment; the audit-knob diff vs a named parent classifies
// whether an Improve's metric delta is cleanly attributable. Flag-don't-block (A3 philosophy);
// only "improve-multi" is surfaced by the status brief.

import { join } from "node:path";

import { splitTsvRows } from "./tsv.js";

export interface LineageRow {
  expId: string;
  agent: string;
  parentId: string;
  knobsChanged: string;   // "" for draft / unavailable; the integer count otherwise
  verdict: string;        // draft | improve-single | improve-multi | improve-unverified
  ts: string;
}

export const LINEAGE_TSV_HEADER = "exp_id\tagent\tparent_id\tknobs_changed\tverdict\tts\n";

export function lineageRow(r: LineageRow): string {
  return `${r.expId}\t${r.agent}\t${r.parentId}\t${r.knobsChanged}\t${r.verdict}\t${r.ts}\n`;
}
export function lineageTsvPath(art: string): string { return join(art, "lineage.tsv"); }
/** lineage.tsv text -> rows. Missing trailing cells read as ""; picking out the improve-multi rows
 *  (the only verdict any reader surfaces) is the caller's. */
export function parseLineageRows(text: string): LineageRow[] {
  return splitTsvRows(text, "exp_id\t").map((c) => ({
    expId: c[0] ?? "", agent: c[1] ?? "", parentId: c[2] ?? "", knobsChanged: c[3] ?? "",
    verdict: c[4] ?? "", ts: c[5] ?? "",
  }));
}

/** Numeric-tolerant value compare: differ iff both parse as numbers and are unequal, else compared
 *  as strings. The single source for the A3 audit-knob-drift compare (shared by sanityFlags). */
export function knobsDiffer(a: unknown, b: unknown): boolean {
  const x = parseFloat(String(a)), y = parseFloat(String(b));
  return (!Number.isNaN(x) && !Number.isNaN(y)) ? x !== y : String(a) !== String(b);
}

/** Count mandated knobs that differ (numeric-tolerant) over the union of keys — uses the same
 *  knobsDiffer compare as the A3 audit-knob-drift check. Returns null when either audit is missing
 *  (cannot diff). A key present on only one side counts as a difference. */
export function diffAuditKnobs(
  parentAudit: Record<string, unknown> | null,
  childAudit: Record<string, unknown> | null,
): number | null {
  if (!parentAudit || !childAudit) return null;
  const keys = new Set([...Object.keys(parentAudit), ...Object.keys(childAudit)]);
  let n = 0;
  for (const k of keys) {
    if (knobsDiffer(parentAudit[k], childAudit[k])) n += 1;
  }
  return n;
}

/** Lineage verdict from the recorded parent + audit-knob diff. No parent -> draft (a deliberate new
 *  angle). 0 changed knobs OR an unavailable diff -> improve-unverified (the change was a non-mandated
 *  knob, or the parent has no audit.json — cannot confirm a single mandated change). */
export function classifyLineage(parentId: string | undefined, knobsChanged: number | null): string {
  if (!parentId) return "draft";
  if (knobsChanged === null || knobsChanged === 0) return "improve-unverified";
  if (knobsChanged === 1) return "improve-single";
  return "improve-multi";
}
