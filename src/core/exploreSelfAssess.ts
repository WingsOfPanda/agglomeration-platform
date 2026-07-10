// src/core/exploreSelfAssess.ts — parser for the selfassess-<agent>.md artifact (worker
// self-assessment, written by the same research turn as findings). Pure + tolerant: missing
// file/sections → empty. The artifact is DELIBERATELY separate from findings-<agent>.md:
// computeSignals/buildAnnotations read raw findings with no section scoping, so embedding
// uncertainty vocabulary there would flip S5 vacuously true and restated citations would inflate
// S2. Nothing on the confidence/annotate path may ever read this file.

export type SelfConfidence = "high" | "medium" | "low";
export interface SelfAssessment {
  grades: { confidence: SelfConfidence; approach: string }[];
  leastSure: string[];
}

/** `<confidence>: <approach>` grade lines (outside the Least-sure section) + `- ` bullets under
 *  `## Least sure` (section ends at the next `## ` heading). "" → empty. */
export function parseSelfAssessment(text: string): SelfAssessment {
  const grades: SelfAssessment["grades"] = [];
  const leastSure: string[] = [];
  let inLeastSure = false;
  for (const line of text.split("\n")) {
    if (/^## Least sure/i.test(line)) { inLeastSure = true; continue; }
    if (/^## /.test(line)) { inLeastSure = false; continue; }
    if (inLeastSure) {
      const b = line.match(/^- (.+)$/);
      if (b) leastSure.push(b[1].trim());
      continue;
    }
    const g = line.match(/^(high|medium|low):[ \t]+(.+)$/i);
    if (g) grades.push({ confidence: g[1].toLowerCase() as SelfConfidence, approach: g[2].trim() });
  }
  return { grades, leastSure };
}
