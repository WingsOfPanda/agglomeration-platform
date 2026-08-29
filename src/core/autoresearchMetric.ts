// Pure metric helpers for /ap:autoresearch. Faithful to deep-research.sh
// (extract_metric, format_metric_block, check_completion's metric.md parse,
// format_sota_block), modernized to typed TS.

/** Canonical metric vocabulary (whole-word, first-by-position wins). */
export const METRIC_VOCAB = [
  "accuracy", "auc", "cost", "f1", "latency", "loss",
  "memory", "params", "precision", "recall", "throughput",
] as const;

/** Heuristic seed: faithful to deep-research.sh extract_metric — whole-word GATE
 *  (bordered match), but position RANKED by first plain-substring occurrence on the
 *  unpadded lowercased topic; lowercased word; "" if none. */
export function extractMetric(topic: string): string {
  if (!topic) return "";
  const lowerRaw = topic.toLowerCase();
  const lowerPadded = ` ${lowerRaw} `;
  let bestPos = Infinity;
  let bestWord = "";
  for (const word of METRIC_VOCAB) {
    // Whole-word eligibility (border on both sides). NB: every vocab word is plain
    // [a-z0-9]+ with no regex metacharacters, so interpolating into RegExp is safe.
    if (!new RegExp(`[^a-z0-9]${word}[^a-z0-9]`).test(lowerPadded)) continue;
    // Position = first plain-substring occurrence (mirrors bash `${lower%%word*}`).
    const pos = lowerRaw.indexOf(word);
    if (pos < bestPos) { bestPos = pos; bestWord = word; }
  }
  return bestWord;
}

/** Render metric.md from K=V fields. Required: primary_metric, direction(maximize|minimize).
 *  Defaults: min_acceptable=(not set), K_corroboration=1, plateau_window=5, plateau_threshold=0.01.
 *  Throws on missing required keys / bad direction. Byte-faithful to format_metric_block. */
export function formatMetricBlock(fields: Record<string, string>): string {
  const primary = fields.primary_metric ?? "";
  const direction = fields.direction ?? "";
  if (!primary) throw new Error("missing required key: primary_metric");
  if (!direction) throw new Error("missing required key: direction");
  if (direction !== "maximize" && direction !== "minimize") {
    throw new Error(`direction must be 'maximize' or 'minimize'; got '${direction}'`);
  }
  const min = fields.min_acceptable || "(not set)";
  const K = fields.K_corroboration || "1";
  const pw = fields.plateau_window || "5";
  const pt = fields.plateau_threshold || "0.01";

  const lines = ["# Research goal", ""];
  lines.push(`**Primary metric:** ${primary}`);
  lines.push(`**Direction:** ${direction}`);
  lines.push(`**min_acceptable:** ${min}`);
  if (fields.target) lines.push(`**target:** ${fields.target}`);
  lines.push(`**K_corroboration:** ${K}`);
  lines.push(`**plateau_window:** ${pw}`);
  lines.push(`**plateau_threshold:** ${pt}`);
  if (fields.acceptable) lines.push(`**acceptable (legacy):** ${fields.acceptable}`);
  if (fields.hard_constraints) lines.push(`**Hard constraints:** ${fields.hard_constraints}`);
  let out = lines.join("\n") + "\n";
  if (fields.notes) out += `\n**Notes:** ${fields.notes}\n`;
  return out;
}

export interface MetricThresholds {
  primaryMetric: string;
  /** maximize|minimize from metric.md `**Direction:**`; undefined when absent (treated as maximize). */
  direction?: "maximize" | "minimize";
  /** optional metric.md `**verify_epsilon:**` for A1 verify-by-re-execution; default 0.01 in callers. */
  verifyEpsilon?: number;
  /** optional metric.md `**ceiling:**` (plausible bound) for A3 too-good-to-be-true; skip if absent. */
  ceiling?: number;
  /** optional metric.md `**min_runtime_s:**` for A3 under-run; caller defaults to 1.0 if absent. */
  minRuntimeS?: number;
  /** optional metric.md `**max_debug_attempts:**` for A2 bounded re-dispatch; caller defaults to 2. */
  maxDebugAttempts?: number;
  /** optional metric.md `**min_families:**` for B1 coverage floor; parsed with default 2 (>= 1). */
  minFamilies: number;
  /** optional metric.md `**c1_epsilon:**` for C1 round-trip tolerance; caller defaults to 2x verify_epsilon (0.02). */
  c1Epsilon?: number;
  /** optional metric.md `**c1_budget:**` max C1 inspections per session; caller defaults to 2. */
  c1Budget?: number;
  /** optional metric.md `**select_k:**` worker-selection breadth; caller supplies default. */
  selectK?: number;
  /** optional metric.md `**select_signal:**` selection signal (e.g. "held-out"); caller supplies default. */
  selectSignal?: string;
  /** optional metric.md `**memory_half_life_days:**` memory decay half-life; caller supplies default. */
  memoryHalfLifeDays?: number;
  /** optional metric.md `**memory_max_age_days:**` hard memory age cutoff; caller supplies default. */
  memoryMaxAgeDays?: number;
  /** optional metric.md `**memory_min_corroboration:**` corroboration floor for memory reuse; caller supplies default. */
  memoryMinCorroboration?: number;
  /** optional metric.md `**memory_write_rate_max:**` max memory writes per window; caller supplies default. */
  memoryWriteRateMax?: number;
  /** optional metric.md `**marginal_gain_threshold:**` min marginal gain to keep dispatching; caller supplies default. */
  marginalGainThreshold?: number;
  minOp?: string; minVal?: string;
  tgtOp?: string; tgtVal?: string;
  kRequired: number; plateauWindow: number; plateauThreshold: number;
}

/** Parse the thresholds out of a rendered metric.md. `**min_acceptable:** >= 0.95` -> op ">=", val "0.95".
 *  Unparseable / "(not set)" values leave op/val as-is (a later numeric compare against them simply fails). */
export function parseMetricMd(text: string): MetricThresholds {
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\*\*([A-Za-z_][A-Za-z_ 0-9]*):\*\*\s+(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  const num = (k: string): number | undefined => {
    const n = parseFloat(kv[k]);
    return Number.isNaN(n) ? undefined : n;
  };
  const int = (k: string): number | undefined => {
    const n = parseInt(kv[k], 10);
    return Number.isNaN(n) ? undefined : n;
  };
  /** ">= 0.95" -> [">=", "0.95"]; absent key -> [undefined, undefined]. */
  const opVal = (k: string): [string | undefined, string | undefined] => {
    if (kv[k] === undefined) return [undefined, undefined];
    const parts = kv[k].split(/\s+/);
    return [parts[0] ?? "", parts.slice(1).join(" ")];
  };
  const d = kv["Direction"];
  const [minOp, minVal] = opVal("min_acceptable");
  const [tgtOp, tgtVal] = opVal("target");
  return {
    primaryMetric: kv["Primary metric"] ?? "",
    direction: d === "maximize" || d === "minimize" ? d : undefined,
    minOp, minVal, tgtOp, tgtVal,
    kRequired: int("K_corroboration") || 1,
    plateauWindow: int("plateau_window") || 5,
    plateauThreshold: num("plateau_threshold") || 0.01,
    verifyEpsilon: num("verify_epsilon"),
    ceiling: num("ceiling"),
    minRuntimeS: num("min_runtime_s"),
    maxDebugAttempts: int("max_debug_attempts"),
    minFamilies: Math.max(1, int("min_families") ?? 2),
    c1Epsilon: num("c1_epsilon"),
    c1Budget: int("c1_budget"),
    selectK: int("select_k"),
    selectSignal: kv["select_signal"],
    memoryHalfLifeDays: num("memory_half_life_days"),
    memoryMaxAgeDays: num("memory_max_age_days"),
    memoryMinCorroboration: int("memory_min_corroboration"),
    memoryWriteRateMax: num("memory_write_rate_max"),
    marginalGainThreshold: num("marginal_gain_threshold"),
  };
}

export interface ValidityThresholds {
  /** A1 verify-by-re-execution tolerance. */
  verifyEpsilon: number;
  /** C1 round-trip tolerance — twice A1's unless metric.md pins it. */
  c1Epsilon: number;
  /** C1 inspections allowed per campaign. */
  c1Budget: number;
}

/** The research-validity defaults resolved from a campaign's metric.md (null = no file, all
 *  defaults). The verbs read these instead of restating the chains where they adjudicate. */
export function resolveValidityThresholds(mdText: string | null): ValidityThresholds {
  const t = mdText ? parseMetricMd(mdText) : null;
  const verifyEpsilon = t?.verifyEpsilon ?? 0.01;
  return { verifyEpsilon, c1Epsilon: t?.c1Epsilon ?? 2 * verifyEpsilon, c1Budget: t?.c1Budget ?? 2 };
}

export interface SotaInput {
  topic: string; metric: string; sweep_date: string; queries?: string;
  /** Each ref is "family|best|compliance|source|notes". Capped at 7. */
  refs: string[];
}

/** Render the SOTA reference block. Faithful to format_sota_block. */
export function formatSotaBlock(input: SotaInput): string {
  if (!input.topic) throw new Error("missing required key: topic");
  if (!input.metric) throw new Error("missing required key: metric");
  if (!input.sweep_date) throw new Error("missing required key: sweep_date");

  const lines: string[] = [];
  lines.push(`# SOTA reference — ${input.topic}`, "");
  lines.push(`> **Sweep date:** ${input.sweep_date}`);
  lines.push(`> **Optimizing for:** ${input.metric}`);
  if (input.queries) lines.push(`> **Queries fired:** ${input.queries}`);
  lines.push("");
  lines.push("| Approach family | Best known | Constraint compliance | Source | Notes |");
  lines.push("|---|---|---|---|---|");

  let rendered = 0;
  for (const row of input.refs.slice(0, 7)) {
    if (!row) continue;
    const [family = "", best = "", compliance = "", source = "", ...rest] = row.split("|");
    const notes = rest.join("|");
    lines.push(`| ${family} | ${best} | ${compliance} | ${source} | ${notes} |`);
    rendered++;
  }
  let out = lines.join("\n") + "\n";
  if (rendered === 0) {
    out += "\n_Note: sweep returned no usable references; worker-side web search remains available._\n";
  }
  return out;
}
