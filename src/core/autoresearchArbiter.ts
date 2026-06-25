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

/**
 * Conservatively triage a worker's clarifying question against the locked run
 * context: answer it ONLY when the answer is grounded by the context, else fail
 * closed. Never fabricates an open-ended design decision and never makes a silent
 * guess. Pure + deterministic: same (question, context) -> same result.
 *
 * Policy:
 * - Multiple-choice (`options` non-empty): pick the option most consistent with
 *   the locked metric/objective (most option-words present in the lowercased
 *   objective+metric); deterministic tie-break = first option.
 * - Closed factual question whose answer the context carries (message mentions
 *   metric/objective/budget/direction): answer from context.
 * - Otherwise: { action: 'fail-closed' } — the hub must surface it to a human.
 */
export function triageQuestion(
  question: { message: string; options?: string[] },
  context: { objective: string; metric: string; sota?: string; lessons?: string[] },
): { action: "answer"; answer: string } | { action: "fail-closed" } {
  const opts = question.options ?? [];
  if (opts.length > 0) {
    // Pick the option most consistent with the locked metric/objective;
    // tie -> first option (deterministic).
    const lc = `${context.objective} ${context.metric}`.toLowerCase();
    const ranked = [...opts].sort((a, b) => score(b, lc) - score(a, lc));
    return { action: "answer", answer: ranked[0] };
  }
  // Closed factual questions the context already answers.
  if (/\b(metric|objective|budget|direction)\b/i.test(question.message)) {
    return {
      action: "answer",
      answer: `Optimize ${context.metric}; objective: ${context.objective}.`,
    };
  }
  return { action: "fail-closed" };
}

/** Count option words present in the lowercased objective+metric haystack. */
function score(opt: string, lc: string): number {
  return opt
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w && lc.includes(w)).length;
}
