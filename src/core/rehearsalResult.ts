// Result-contract logic for /consort:rehearsal. Faithful to deep-research.sh
// (validate_result_json{,_v033}, scoreboard_render_row, normalize_result) and
// deep-research-score.sh (scoreboard build + sort). FROZEN wire schema.

export type ResultStatus = "ok" | "fail" | "timeout" | "cost_blown";

/** FROZEN flat schema written by a codex part at the end of an experiment. */
export interface ResultJson {
  branch_id: string;
  approach_label: string;
  metric_name: string;
  metric_value: number | null;
  status: ResultStatus;
  runtime_s: number;
  log_paths: string[];
  checkpoint_path: string | null;
  notes: string;
  self_reported_count?: number;
  self_reported_ratio?: number | null;
  self_reported_notes?: string;
}

const REQUIRED_FIELDS = [
  "branch_id", "approach_label", "metric_name", "metric_value", "status", "runtime_s", "log_paths",
] as const;
const STATUS_ENUM: readonly string[] = ["ok", "fail", "timeout", "cost_blown"];

export interface ValidateOpts {
  /** metric.md primary_metric — when given, the result's metric_name must equal it (v033). */
  expectedMetric?: string;
  /** Existence check for each log_path (injected; pure). Defaults to "exists". */
  logPathExists?: (p: string) => boolean;
}

export type ValidateResult = { ok: true } | { ok: false; error: string };

/** Validate a parsed result.json object. Enforces required fields, status enum,
 *  metric_value non-null IFF status=ok, log_path existence, and (optional) metric_name match. */
export function validateResult(json: unknown, opts: ValidateOpts = {}): ValidateResult {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, error: "malformed JSON" };
  }
  const o = json as Record<string, unknown>;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in o)) return { ok: false, error: `missing required field: ${f}` };
  }
  if (typeof o.status !== "string" || !STATUS_ENUM.includes(o.status)) {
    return { ok: false, error: `invalid status: ${String(o.status)}` };
  }
  const isNull = o.metric_value === null;
  if (o.status === "ok" && isNull) return { ok: false, error: "status=ok requires non-null metric_value" };
  if (o.status !== "ok" && !isNull) return { ok: false, error: `status=${o.status} requires null metric_value` };
  if (!Array.isArray(o.log_paths)) return { ok: false, error: "log_paths must be an array" };
  const exists = opts.logPathExists ?? (() => true);
  for (const p of o.log_paths) {
    if (!exists(String(p))) return { ok: false, error: `log_path missing: ${String(p)}` };
  }
  if (opts.expectedMetric !== undefined && o.metric_name !== opts.expectedMetric) {
    return { ok: false, error: `metric_name '${String(o.metric_name)}' != metric.md primary '${opts.expectedMetric}'` };
  }
  return { ok: true };
}
