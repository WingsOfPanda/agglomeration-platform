// src/core/exploreAnnotate.ts — Phase 5b evidence-weakness annotations for /ap:explore.
// Pure: (draft, findings) -> annotated draft + plan. The annotations are constructed so that
// computeSignals over the annotated draft equals computeSignals over the original draft (all five
// signals byte-identical) — the gate is blind to them. See the design spec
// docs/superpowers/specs/2026-06-22-explore-evidence-annotations-design.md.
import { draftCitations } from "./exploreConfidence.js";

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
