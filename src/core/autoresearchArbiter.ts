// Pure, deterministic metric arbiter for /ap:autoresearch (capability A).
// Frames a measurable metric (primary_metric + direction + min_acceptable) from a
// free-text objective, and supplies a default time budget. No fs/clock/IO/LLM:
// same objective -> byte-identical result. The arbiter is the PRODUCER of MetricFields
// (memory later consumes this shape); do NOT import the type from memory.

import { extractMetric } from "./autoresearchMetric.js";

/** A bag of metric.md K=V fields. Compatible with formatMetricBlock(fields). */
export type MetricFields = Record<string, string>;

/** Metric words whose better direction is "smaller is better". */
const MINIMIZE_METRICS = new Set(["loss", "latency", "cost", "memory", "params"]);

/** Objective phrasing that flips a default-maximize metric to minimize. */
const MINIMIZE_WORDS = /\b(minimi[sz]e|reduce|lower|decrease|down)\b/i;

/**
 * Deterministically frame a measurable metric from a free-text objective.
 *
 * - `primary_metric` = extractMetric(objective) || 'accuracy' (vocab, first-by-position).
 * - `direction` = 'minimize' if the metric word is smaller-is-better OR the objective
 *   phrases a reduction (minimize/reduce/lower/decrease/down); else 'maximize'.
 * - `min_acceptable` = '(not set)' (formatMetricBlock default; explicit for clarity).
 *
 * `opts` (sota/memory) is reserved for a future LLM-assist hook wired in the verb;
 * the pure core ignores it so the result stays deterministic and IO-free.
 *
 * The returned object is a valid input to formatMetricBlock (supplies primary_metric
 * + direction at minimum), so formatMetricBlock(frameMetric(objective)) never throws.
 */
export function frameMetric(
  objective: string,
  _opts?: { sota?: string; memory?: string[] },
): MetricFields {
  const metric = extractMetric(objective) || "accuracy";
  const minimize = MINIMIZE_METRICS.has(metric) || MINIMIZE_WORDS.test(objective);
  return {
    primary_metric: metric,
    direction: minimize ? "minimize" : "maximize",
    min_acceptable: "(not set)",
  };
}

/**
 * Default time budget for an autoresearch run. Returns a parseable budget:
 * 'none' (unbounded) or a string of seconds. The pure core returns 'none';
 * the verb may override from flags/config.
 */
export function defaultTimeBudget(_objective: string): string {
  return "none";
}
