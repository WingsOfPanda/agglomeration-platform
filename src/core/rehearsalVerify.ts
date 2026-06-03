// Metric-trust (verify-by-re-execution) pure logic for /consort:rehearsal (research-validity A1).
// The harness re-runs the part's declared scoring step OUTSIDE the part's pane and adjudicates a
// verdict. Pure: FS access is injected; the verbs apply the returned plan/rows.
import { createHash } from "node:crypto";

export type Verdict = "verified" | "mismatch" | "unavailable" | "pending";

export interface VerifyBlock {
  kind: "rescore" | "rerun" | "none";
  command?: string;
  inputs?: string[];
  metric_from?: string;
}

/** Pull a valid verify block out of a parsed result.json; undefined if absent/malformed/bad-kind. */
export function parseVerifyBlock(result: Record<string, unknown>): VerifyBlock | undefined {
  const v = result.verify;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind !== "rescore" && o.kind !== "rerun" && o.kind !== "none") return undefined;
  const block: VerifyBlock = { kind: o.kind };
  if (typeof o.command === "string") block.command = o.command;
  if (Array.isArray(o.inputs)) block.inputs = o.inputs.filter((x): x is string => typeof x === "string");
  if (typeof o.metric_from === "string") block.metric_from = o.metric_from;
  return block;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MARKER_RE = /^VERIFY_METRIC=(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;

/** Recomputed metric from the command's captured stdout (marker) or a JSON file it wrote. */
export function recomputedFromOutput(
  stdout: string, metricFrom: string, readJson: (path: string) => string | null,
): number | null {
  if (metricFrom === "marker") {
    const lines = stdout.split("\n").map((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(MARKER_RE);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }
  const raw = readJson(metricFrom);
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return typeof o.metric_value === "number" ? o.metric_value : null;
  } catch { return null; }
}

export function checkVerify(opts: {
  recomputed: number | null; runFailed: boolean; reported: number | null; epsilon: number;
}): { verdict: Verdict; reason: string } {
  if (opts.runFailed) return { verdict: "mismatch", reason: "rerun-failed" };
  if (opts.recomputed === null) return { verdict: "mismatch", reason: "no-marker" };
  if (opts.reported === null) return { verdict: "mismatch", reason: "no-reported" };
  if (Math.abs(opts.recomputed - opts.reported) <= opts.epsilon) return { verdict: "verified", reason: "" };
  return { verdict: "mismatch", reason: `value:${opts.recomputed}vs${opts.reported}` };
}

export interface VerificationRow {
  expId: string; instrument: string; verdict: Verdict; reason: string; recomputed: string; ts: string;
}
export const VERIFICATION_TSV_HEADER = "exp_id\tinstrument\tverdict\treason\trecomputed\tts\n";
export function verificationRow(r: VerificationRow): string {
  return `${r.expId}\t${r.instrument}\t${r.verdict}\t${r.reason}\t${r.recomputed}\t${r.ts}\n`;
}
