// Result-contract logic for /ap:autoresearch. Faithful to deep-research.sh
// (validate_result_json{,_v033}, scoreboard_render_row, normalize_result) and
// deep-research-score.sh (scoreboard build + sort). FROZEN wire schema.

export type ResultStatus = "ok" | "fail" | "timeout" | "cost_blown";

/** FROZEN flat schema written by a codex worker at the end of an experiment. */
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
  integrity?: {
    split_before_fit?: boolean;
    no_train_test_overlap?: boolean;
    target_not_in_features?: boolean;
    trained_steps?: number;
    seed?: number;
  };
  /** C1 run-card: how to obtain the same data + split for an independent re-run. Optional. */
  data_spec?: { source?: string; split_seed?: number; split_hash?: string; target_column?: string; feature_columns?: string[] };
  /** C1 run-card: a precise metric computation so a re-derived number is comparable. Optional. */
  metric_formula?: string;
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

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Render the value-bearing tail of one scoreboard row:
 *  "<metric%.4f|verbatim> | <status> | <runtime%.2fs|verbatim> | <approach> | <metric_name>".
 *  Each cell is `|`/newline-scrubbed: the scoreboard is re-parsed positionally by `split("|")`
 *  (checkCompletion.parseRows), so a worker-controlled `|` in any verbatim/text cell (approach_label,
 *  a non-numeric metric, an infeasible reason) would shift every later column and silently drop the
 *  row from floor/target/plateau accounting. */
export function renderScoreboardRow(
  metric: string, runtime: string, metricName: string, status: string, approach: string,
): string {
  const cell = (s: string): string => s.replace(/[|\r\n]/g, " ");
  const metricFmt = NUM_RE.test(metric) ? parseFloat(metric).toFixed(4) : metric;
  const runtimeFmt = NUM_RE.test(runtime) ? `${parseFloat(runtime).toFixed(2)}s` : runtime;
  return `${cell(metricFmt)} | ${cell(status)} | ${cell(runtimeFmt)} | ${cell(approach)} | ${cell(metricName)}`;
}

export interface ScoreRow {
  expId: string; agent: string; metric: string;
  status: string; runtime: string; approach: string; metricName: string;
  /** A2: trigger reason (mismatch / under-run / log-contradiction / audit-knob-drift) when infeasible;
   *  set => the row is routed to the non-ranked `xN` group instead of the ranked leader set. */
  infeasibleReason?: string;
}

function expNum(expId: string): number {
  const n = parseInt(expId.replace(/^exp-/, ""), 10);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

/** Build the full scoreboard.md. OK rows sorted best-metric-first (metric-desc for a maximize
 *  objective, metric-asc for minimize) / runtime-asc / exp-id; fail+partial grouped below sorted by
 *  exp-id; rank counter continuous; partial -> ~ rank. `direction` from metric.md (undefined =>
 *  maximize, byte-identical to the pre-fix descending sort; a deliberate ap divergence — roadmap C0).
 *  A2: ok rows whose `infeasibleReason` is set are routed to a separate `x<rank>` group between the
 *  ranked rows and the fail group (visible but out of the integer-ranked leader set, so
 *  checkCompletion/status-brief — which match only integer ranks — exclude them automatically). */
export function buildScoreboard(rows: ScoreRow[], direction?: "maximize" | "minimize"): string {
  const ranked = rows.filter((r) => r.status === "ok" && !r.infeasibleReason);
  const infeasible = rows.filter((r) => r.status === "ok" && r.infeasibleReason);
  const fail = rows.filter((r) => r.status !== "ok");
  const minimize = direction === "minimize";
  ranked.sort((a, b) =>
    (minimize ? parseFloat(a.metric) - parseFloat(b.metric) : parseFloat(b.metric) - parseFloat(a.metric)) ||
    (parseFloat(a.runtime) - parseFloat(b.runtime)) ||
    (expNum(a.expId) - expNum(b.expId)));
  infeasible.sort((a, b) => expNum(a.expId) - expNum(b.expId));
  fail.sort((a, b) => expNum(a.expId) - expNum(b.expId));

  const lines: string[] = [
    "<!-- scoreboard schema_version=2 -->",
    "# Scoreboard",
    "",
    "| Rank | Experiment | Agent | Metric | Status | Runtime | Approach | metric_name |",
    "|---|---|---|---|---|---|---|---|",
  ];
  let rank = 1;
  for (const r of ranked) {
    lines.push(`| ${rank} | ${r.expId} | ${r.agent} | ${renderScoreboardRow(r.metric, r.runtime, r.metricName, r.status, r.approach)} |`);
    rank++;
  }
  for (const r of infeasible) {
    lines.push(`| x${rank} | ${r.expId} | ${r.agent} | ${renderScoreboardRow(r.metric, r.runtime, r.metricName, `infeasible:${r.infeasibleReason}`, r.approach)} |`);
    rank++;
  }
  for (const r of fail) {
    const rankCell = r.status === "partial" ? `~${rank}` : `${rank}`;
    lines.push(`| ${rankCell} | ${r.expId} | ${r.agent} | ${renderScoreboardRow("n/a", r.runtime, r.metricName, r.status, r.approach)} |`);
    rank++;
  }
  return lines.join("\n") + "\n";
}

export type NormalizedStatus = ResultStatus | "partial";
export type NormalizedResult = Omit<ResultJson, "status"> & { status: NormalizedStatus };

/** Normalize one result: ok+null→partial; fail+non-null self_reported_ratio→partial (promoting
 *  the ratio into metric_value when it was null). Everything else passes through unchanged.
 *  Faithful to deep-research.sh normalize_result. */
export function normalizeResult(json: ResultJson): NormalizedResult {
  const { status, metric_value: mv, self_reported_ratio: srr } = json;
  if (status === "ok" && (mv === null || mv === undefined)) {
    return { ...json, status: "partial" };
  }
  if (status === "fail" && srr !== undefined && srr !== null) {
    const out: NormalizedResult = { ...json, status: "partial" };
    if (mv === null || mv === undefined) out.metric_value = srr;
    return out;
  }
  return json;
}
