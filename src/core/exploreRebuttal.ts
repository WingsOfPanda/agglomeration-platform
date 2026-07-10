// src/core/exploreRebuttal.ts — bounded-rebuttal helpers for /ap:explore Phase 7b.
// Pure (no fs, no IPC). After the adversary gate, only `needs-attention` critiques whose
// Material findings attribute cleanly to ONE worker (via diff-bucket citation overlap) earn
// that worker exactly one defend-or-concede turn. Attribution comes from the diff buckets,
// never from guessing. The prompt body carries NO done-event line and NO END_OF_INSTRUCTION —
// `send` → `inboxWrite` appends exactly one of each (same contract as exploreTurn.ts).
import { type Claim, citationOverlaps } from "./designDiff.js";
import { draftCitations } from "./exploreConfidence.js";
import { parseAdversaryVerdict } from "./exploreVerdict.js";

/** Parse `[cite] text` bucket-file lines (the shape diffFindings emits) into Claims. */
export function parseBucketLines(text: string): Claim[] {
  const out: Claim[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\[([^\]]+)\] (.*)$/);
    if (m) out.push({ cite: m[1], text: m[2] });
  }
  return out;
}

/** `### Finding N` blocks under `## Material findings` — each block runs to the next `### ` or
 *  `## ` heading. Missing section or zero findings → []. */
export function parseFindings(critique: string): string[] {
  const out: string[] = [];
  let inSection = false;
  let cur: string[] | null = null;
  const flush = (): void => { if (cur) out.push(cur.join("\n").trimEnd()); cur = null; };
  for (const line of critique.split("\n")) {
    if (/^## Material findings/.test(line)) { inSection = true; continue; }
    if (/^## /.test(line)) { flush(); inSection = false; continue; }
    if (!inSection) continue;
    if (/^### /.test(line)) { flush(); cur = [line]; continue; }
    if (cur) cur.push(line);
  }
  flush();
  return out;
}

/** The unique bucket owner a finding's citation tokens attribute to, or null (zero matches or a
 *  tie). Tokens come from the draftCitations regex (file paths + URLs; `paper:` ids deliberately
 *  not matched — such findings stay unattributed and the hub weighs them alone, as today). */
export function attributeFinding(findingText: string, buckets: Map<string, Claim[]>): string | null {
  const owners = new Set<string>();
  for (const token of draftCitations(findingText)) {
    for (const [agent, claims] of buckets) {
      if (claims.some((c) => citationOverlaps(token, c.cite))) owners.add(agent);
    }
  }
  return owners.size === 1 ? [...owners][0] : null;
}

export interface CritiqueInput { agent: string; text: string }
export interface RebuttalTarget { findings: string[]; claims: Claim[] }

/** Group needs-attention critiques' findings per attributed bucket owner. Critiques with any
 *  other verdict (or malformed) are dropped whole; unattributed findings are dropped. `claims`
 *  is the owner's bucket claims the finding's tokens actually overlap — the attacked set. */
export function selectRebuttalTargets(
  critiques: CritiqueInput[], buckets: Map<string, Claim[]>,
): Map<string, RebuttalTarget> {
  const out = new Map<string, RebuttalTarget>();
  for (const c of critiques) {
    if (parseAdversaryVerdict(c.text) !== "needs-attention") continue;
    for (const finding of parseFindings(c.text)) {
      const owner = attributeFinding(finding, buckets);
      if (owner === null) continue;
      const t = out.get(owner) ?? { findings: [], claims: [] };
      t.findings.push(finding);
      const own = buckets.get(owner) ?? [];
      for (const token of draftCitations(finding)) {
        for (const cl of own) {
          if (citationOverlaps(token, cl.cite) && !t.claims.some((x) => x.cite === cl.cite && x.text === cl.text)) {
            t.claims.push(cl);
          }
        }
      }
      out.set(owner, t);
    }
  }
  return out;
}

/** One defend-or-concede turn over the findings attributed to this worker's solo claims. */
export function composeRebuttalPrompt(claims: Claim[], critiques: string[], outPath: string): string {
  const claimLines = claims.map((c, i) => `${i + 1}. [${c.cite}] ${c.text}`).join("\n");
  return [
    "An adversary round challenged the synthesized landscape doc. The critiques below",
    "attack claims that YOU raised during research (your peers did not raise them, so",
    "you are the only worker who can defend them).",
    "",
    "Your attacked claims:",
    claimLines,
    "",
    "The critiques against them:",
    "",
    critiques.join("\n\n"),
    "",
    "For EACH critique, do ONE of:",
    "",
    "  DEFEND  — rebut it with concrete evidence (cite a file/line/URL/paper)",
    "  CONCEDE — accept it explicitly; say what the landscape doc should say instead",
    "",
    "This is ONE turn: no counter-attacks on the adversary, no new claims beyond the",
    "evidence needed to defend, and no follow-up round.",
    "",
    `Write your responses to ${outPath} with this EXACT structure:`,
    "",
    "  # Rebuttal",
    "",
    "  ## Responses",
    "  1. <DEFEND|CONCEDE> <one-line restatement of the critique>",
    "     <evidence or concession, with [citation] anchors>",
    "  2. ...",
    "",
    "An honest concession is more useful than a weak defense — do not pad.",
  ].join("\n");
}
