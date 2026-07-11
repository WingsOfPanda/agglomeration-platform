// Pure mapping policy for /ap:autoresearch cross-run memory (capability B).
//
// This is the seam the memory store waits on: it turns raw experiment signals
// (a metric name, the A1/C1 verifier verdicts, a parent/child metric pair) into
// the typed inputs the write gate (`filterLesson` in autoresearchMemory.ts)
// consumes. Every function here FAILS CLOSED — an unrecognized metric or an
// unconfirmed verdict yields `null` so the caller SKIPS rather than fabricating
// an unscoped path or an unjustified lesson.
//
// PURE: no fs/clock/IO. The caller injects `createdTs` (ISO). Same inputs ->
// byte-identical output. The produced draft is DATA-ONLY: its `claim` carries
// no imperative or injection text, so it survives `filterLesson`'s denylist.

import { METRIC_FAMILIES, type LessonVerdict, type MemoryPolicy } from "./autoresearchMemory.js";
import { type MetricThresholds } from "./autoresearchMetric.js";

/**
 * Map a primary-metric label to its closed metric family, or `null` when it is
 * outside the taxonomy. Lowercases + trims, then tests the whole string first
 * and, failing that, its leading word token (split on non-alphanumerics). A
 * `null` here tells the caller to SKIP — it must never let an unknown family
 * reach `scopeKey`, which THROWS on an unrecognized family (fail-closed).
 */
export function metricFamilyOf(primaryMetric: string): string | null {
  const norm = (primaryMetric ?? "").toLowerCase().trim();
  if (!norm) return null;
  const families = METRIC_FAMILIES as readonly string[];
  if (families.includes(norm)) return norm;
  // Leading word token: split on non-alphanumerics, take the first non-empty.
  const lead = norm.split(/[^a-z0-9]+/).filter(Boolean)[0];
  if (lead && families.includes(lead)) return lead;
  return null;
}

/**
 * Collapse the A1 (verify-by-re-execution) and C1 (independent re-implementation)
 * verifier verdicts into the lesson verdict to persist. C1 reproduction is the
 * stronger positive and wins when present; an A1 `verified` yields the weaker
 * positive. A REFUTED outcome — A1 `mismatch` or C1 `not-reproduced` — yields
 * `"negative"`: a verified do-not-repeat signal, single-run-promotable by design
 * (see `promotable`). INFEASIBLE stays null: `infeasible`/`unverified`/absent is
 * "couldn't be validly executed", not evidence for or against the idea.
 */
export function lessonVerdictOf(a1?: string, c1?: string): LessonVerdict | null {
  if (c1 === "reproduced") return "c1-reimpl-ok";
  if (a1 === "verified") return "a1-verified";
  if (a1 === "mismatch" || c1 === "not-reproduced") return "negative";
  return null;
}

/**
 * Derive the runtime MemoryPolicy from the parsed metric.md thresholds, applying
 * the v1 defaults for any knob the operator did not set. `k` reuses the existing
 * `select_k` worker-selection breadth (default 5); `diversityFloor` and
 * `relevanceFloor` are fixed policy (not operator-tunable in v1).
 */
export function policyFromMetric(t: MetricThresholds): MemoryPolicy {
  return {
    halfLifeDays: t.memoryHalfLifeDays ?? 30,
    maxAgeDays: t.memoryMaxAgeDays ?? 60,
    minCorroboration: t.memoryMinCorroboration ?? 2,
    writeRateMax: t.memoryWriteRateMax ?? 5,
    k: t.selectK ?? 5,
    diversityFloor: 2,
    relevanceFloor: 0.1,
  };
}

/** Raw experiment signals the mapper turns into a lesson draft. */
export interface LessonDraftInput {
  approachLabel: string;
  metricName: string;
  metricValue: number;
  /** Parent (baseline) metric the child improved on; `null` for a rootless draft. */
  parentMetric: number | null;
  direction: "maximize" | "minimize";
  family: string;
  operator?: string;
  knob?: string;
  runId: string;
  expId: string;
  verdict: LessonVerdict;
  createdTs: string; // ISO; injected by the caller (no clock here)
}

/**
 * The draft shape `filterLesson` consumes. Data-only: every free-text field is
 * scanned by the write gate's injection denylist, so nothing imperative may
 * appear here. `delta` is `null` when there is no parent to diff against.
 */
export interface LessonDraft {
  claim: string;
  operator: string;
  knob: string;
  direction: "maximize" | "minimize";
  delta: number | null;
  metric_family: string;
  applicability: string[];
  risk_tags: string[];
  provenance: {
    run_id: string;
    exp_id: string;
    verdict: LessonVerdict;
    metric_family: string;
    source: "experiment";
    created_ts: string;
  };
  score: number;
}

/**
 * Assemble a DATA-ONLY lesson draft from one experiment's signals. The `claim`
 * is a flat statement of the observed numbers — never an instruction — so it
 * passes cleanly through `filterLesson`'s injection denylist. `operator`
 * defaults to `'improve'` when a parent metric exists (a measured gain over a
 * baseline) and to `'draft'` otherwise (a rootless observation). `delta` is the
 * signed `metricValue - parentMetric`, or `null` with no parent. PURE — no IO.
 */
export function buildLessonDraft(input: LessonDraftInput): LessonDraft {
  const hasParent = input.parentMetric != null;
  const delta = hasParent ? input.metricValue - (input.parentMetric as number) : null;
  const operator = input.operator ?? (hasParent ? "improve" : "draft");
  const knob = input.knob ?? input.approachLabel ?? "";

  const deltaPhrase =
    delta == null ? "(draft, no parent)" : `(delta ${delta >= 0 ? "+" : ""}${delta} vs parent)`;
  const claim = `${input.approachLabel}: ${input.metricName}=${input.metricValue} ${deltaPhrase}`;

  return {
    claim,
    operator,
    knob,
    direction: input.direction,
    delta,
    metric_family: input.family,
    applicability: [input.family],
    risk_tags: [],
    provenance: {
      run_id: input.runId,
      exp_id: input.expId,
      verdict: input.verdict,
      metric_family: input.family,
      source: "experiment",
      created_ts: input.createdTs,
    },
    score: 1,
  };
}
