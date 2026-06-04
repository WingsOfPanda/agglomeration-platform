// Independent re-implementation inspector pure logic for /consort:rehearsal (research-validity C1).
// The cross-family Maestro re-runs the experiment from the run-card alone and re-derives the metric;
// this adjudicates a THREE-WAY verdict. Unlike A1's checkVerify (which returns `mismatch` on a failed
// re-run), C1 returns `inconclusive` on any couldn't-complete path so the gate never demotes an
// expensive-to-reproduce honest result. Pure: FS injected; the verbs apply the rows.

export type InspectVerdict = "reproduced" | "not-reproduced" | "inconclusive";

/** Three-way adjudication of the independent re-run vs the part's reported metric.
 *  not-reproduced = a confident disagreement (gaming/irreproducibility signal) OR integrity refuted;
 *  inconclusive = couldn't complete a confident comparison (never a demotion). */
export function classifyInspect(opts: {
  reimplMetric: number | null; runFailed: boolean; reported: number | null; epsilon: number; integrityRefuted: boolean;
}): { verdict: InspectVerdict; reason: string } {
  if (opts.integrityRefuted) return { verdict: "not-reproduced", reason: "integrity-refuted" };
  if (opts.runFailed) return { verdict: "inconclusive", reason: "reimpl-failed" };
  if (opts.reimplMetric === null) return { verdict: "inconclusive", reason: "no-marker" };
  if (opts.reported === null) return { verdict: "inconclusive", reason: "no-reported" };
  if (Math.abs(opts.reimplMetric - opts.reported) <= opts.epsilon) return { verdict: "reproduced", reason: "" };
  return { verdict: "not-reproduced", reason: `value:${opts.reimplMetric}vs${opts.reported}` };
}

/** A confident C1 not-reproduced routes the row to A2's infeasible group; else no infeasible. */
export function inspectInfeasibleReason(verdict: string | undefined): string | null {
  return verdict === "not-reproduced" ? "reimpl-mismatch" : null;
}

/** inspection.tsv -> instrument/exp -> latest verdict (last write wins). Mirrors parseVerdicts. */
export function parseInspections(tsv: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of tsv.split("\n")) {
    if (!line || line.startsWith("exp_id\t")) continue;
    const c = line.split("\t");   // exp_id, instrument, verdict, reason, reimpl_metric, ts
    if (c[0] && c[1] && c[2]) out[`${c[1]}/${c[0]}`] = c[2];
  }
  return out;
}

export interface InspectionRow {
  expId: string; instrument: string; verdict: InspectVerdict; reason: string; reimplMetric: string; ts: string;
}
export const INSPECTION_TSV_HEADER = "exp_id\tinstrument\tverdict\treason\treimpl_metric\tts\n";
export function inspectionRow(r: InspectionRow): string {
  return `${r.expId}\t${r.instrument}\t${r.verdict}\t${r.reason}\t${r.reimplMetric}\t${r.ts}\n`;
}
