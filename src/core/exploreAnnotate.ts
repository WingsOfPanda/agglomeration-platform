// src/core/exploreAnnotate.ts — Phase 5b evidence-weakness annotations for /ap:explore.
// Pure: (draft, findings) -> annotated draft + plan. The annotations are constructed so that
// computeSignals over the annotated draft equals computeSignals over the original draft (all five
// signals byte-identical) — the gate is blind to them. See the design spec
// docs/superpowers/specs/2026-06-22-explore-evidence-annotations-design.md.
import { draftCitations, soloCitations } from "./exploreConfidence.js";

/** A markdown table separator row, e.g. `|---|---|---|` or `| :-- | --- |`. */
function isSeparatorRow(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

/** Tradeoff-matrix Reason (3rd) cells that contain NO citation token. Skips header + separator. */
export function uncitedMatrixReasons(draft: string): { reason: string; lineIndex: number }[] {
  const out: { reason: string; lineIndex: number }[] = [];
  const lines = draft.split("\n");
  let inMatrix = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^## Tradeoff matrix/.test(line)) { inMatrix = true; continue; }
    if (/^## /.test(line)) { inMatrix = false; continue; }
    if (!inMatrix) continue;
    if (!line.startsWith("| ") || !line.endsWith("|")) continue;
    if (isSeparatorRow(line)) continue;
    const cells = line.split("|");       // ["", c1, c2, reason, ""] for a 3-column row
    if (cells.length !== 5) continue;
    if (i + 1 < lines.length && isSeparatorRow(lines[i + 1])) continue; // this is the header row
    const reason = cells[3];
    if (draftCitations(reason).length === 0) out.push({ reason: reason.trim(), lineIndex: i });
  }
  return out;
}

export interface AnnotationItem {
  kind: "unverified" | "no-citation" | "approaches-flagged";
  token?: string;
  lineIndex: number;
}
export interface AnnotationPlan { items: AnnotationItem[]; }

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Line indices that sit under a `## Approaches` heading (until the next `## ` heading). */
function approachesLines(lines: string[]): Set<number> {
  const set = new Set<number>();
  let inApp = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Approaches/.test(lines[i])) { inApp = true; continue; }
    if (/^## /.test(lines[i])) { inApp = false; continue; }
    if (inApp) set.add(i);
  }
  return set;
}

/** Annotate evidence-weakness into the draft. The annotations never change any of the 5 gate
 *  signals (see the module header + the invariant test). Deterministic and idempotent. */
export function buildAnnotations(draft: string, findings: string[]): { annotatedDraft: string; plan: AnnotationPlan } {
  const solo = soloCitations(draft, findings);
  const lines = draft.split("\n");
  const inApp = approachesLines(lines);
  const items: AnnotationItem[] = [];

  // Rule 1: solo citations. Append " [unverified]" after each occurrence OUTSIDE ## Approaches.
  // On Approaches lines, record (do not edit) so topApproach() / S1 stay byte-identical.
  for (let i = 0; i < lines.length; i++) {
    for (const tok of solo) {
      if (!lines[i].includes(tok)) continue;
      if (inApp.has(i)) {
        items.push({ kind: "approaches-flagged", token: tok, lineIndex: i });
        continue;
      }
      // (?![A-Za-z0-9_./:-]) = not a prefix of a longer token; (?! \[unverified\]) = idempotent.
      const re = new RegExp(escapeRegExp(tok) + "(?![A-Za-z0-9_./:-])(?! \\[unverified\\])", "g");
      if (re.test(lines[i])) {
        lines[i] = lines[i].replace(
          new RegExp(escapeRegExp(tok) + "(?![A-Za-z0-9_./:-])(?! \\[unverified\\])", "g"),
          tok + " [unverified]",
        );
        items.push({ kind: "unverified", token: tok, lineIndex: i });
      }
    }
  }

  // Rule 2: uncited matrix Reason cells. Append " [no citation]" inside the cell (idempotent).
  for (const { lineIndex } of uncitedMatrixReasons(lines.join("\n"))) {
    if (lines[lineIndex].includes("[no citation]")) continue;
    lines[lineIndex] = lines[lineIndex].replace(/ \|$/, " [no citation] |");
    items.push({ kind: "no-citation", lineIndex });
  }

  return { annotatedDraft: lines.join("\n"), plan: { items } };
}
