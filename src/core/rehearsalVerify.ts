// Metric-trust (verify-by-re-execution) pure logic for /ap:rehearsal (research-validity A1).
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

export interface VerifyManifest { command: string; hashes: Record<string, string>; }

/** Snapshot command + sha256(inputs utf8) at score-time. null when kind=none / no command. */
export function buildManifest(block: VerifyBlock, readInput: (rel: string) => string | null): VerifyManifest | null {
  if (block.kind === "none" || !block.command) return null;
  const hashes: Record<string, string> = {};
  for (const rel of block.inputs ?? []) {
    const c = readInput(rel);
    if (c !== null) hashes[rel] = hashContent(c);
  }
  return { command: block.command, hashes };
}

export type VerifyPlan =
  | { run: false; verdict: Verdict; reason: string }
  | { run: true; command: string; metricFrom: string };

export interface PlanInput {
  block: VerifyBlock | undefined;
  manifest: VerifyManifest | null;
  authorizeRerun: boolean;
  readInput: (rel: string) => string | null;
}

export function planVerify(p: PlanInput): VerifyPlan {
  const b = p.block;
  if (!b || b.kind === "none" || !b.command) {
    return { run: false, verdict: "unavailable", reason: b ? "part-declined" : "no-contract" };
  }
  if (b.kind === "rerun" && !p.authorizeRerun) return { run: false, verdict: "pending", reason: "rerun-deferred" };
  if (p.manifest === null) return { run: false, verdict: "unavailable", reason: "no-manifest" };
  for (const rel of b.inputs ?? []) {
    const c = p.readInput(rel);
    if (c === null) return { run: false, verdict: "unavailable", reason: `missing-input:${rel}` };
    if (hashContent(c) !== p.manifest.hashes[rel]) return { run: false, verdict: "mismatch", reason: `provenance:${rel}` };
  }
  return { run: true, command: b.command, metricFrom: b.metric_from ?? "marker" };
}
