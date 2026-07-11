import { describe, expect, it, test } from 'vitest';

import { metricFamilyOf, lessonVerdictOf, policyFromMetric, buildLessonDraft } from '../src/core/autoresearchLessonMap.js';
import { promotable, type Lesson, type MemoryPolicy } from '../src/core/autoresearchMemory.js';

test('metricFamilyOf maps known metrics, null for unknown', () => {
  expect(metricFamilyOf('accuracy')).toBe('accuracy');
  expect(metricFamilyOf('Loss')).toBe('loss');
  expect(metricFamilyOf('mean_average_precision')).toBeNull(); // not in closed set -> skip
});
test('lessonVerdictOf prefers C1, else A1, else negative/null', () => {
  expect(lessonVerdictOf('verified', 'reproduced')).toBe('c1-reimpl-ok');
  expect(lessonVerdictOf('verified', undefined)).toBe('a1-verified');
  expect(lessonVerdictOf('mismatch', 'not-reproduced')).toBe('negative');
  expect(lessonVerdictOf(undefined, undefined)).toBeNull();
});

describe("lessonVerdictOf negative mapping (single-run-promotable evidence)", () => {
  it("a1=mismatch -> negative; c1=not-reproduced -> negative", () => {
    expect(lessonVerdictOf("mismatch", undefined)).toBe("negative");
    expect(lessonVerdictOf(undefined, "not-reproduced")).toBe("negative");
    expect(lessonVerdictOf("mismatch", "not-reproduced")).toBe("negative");
  });
  it("INFEASIBLE is 'couldn't execute', not evidence: infeasible/unverified/absent -> null", () => {
    expect(lessonVerdictOf("infeasible", undefined)).toBeNull();
    expect(lessonVerdictOf("unverified", undefined)).toBeNull();
    expect(lessonVerdictOf(undefined, undefined)).toBeNull();
  });
  it("positives unchanged (and win over a conflicting negative signal)", () => {
    expect(lessonVerdictOf(undefined, "reproduced")).toBe("c1-reimpl-ok");
    expect(lessonVerdictOf("verified", undefined)).toBe("a1-verified");
    expect(lessonVerdictOf("verified", "not-reproduced")).toBe("a1-verified");
    expect(lessonVerdictOf("mismatch", "reproduced")).toBe("c1-reimpl-ok");
  });
  it("a negative lesson is promotable on a single run (no corroboration gate)", () => {
    const policy: MemoryPolicy = { halfLifeDays: 30, maxAgeDays: 60, minCorroboration: 2, writeRateMax: 5, k: 5, diversityFloor: 2, relevanceFloor: 0.1 };
    const lesson = {
      id: "x", schema_version: 1, claim: "c", operator: "improve", knob: "k",
      direction: "maximize", delta: -0.1, metric_family: "accuracy", applicability: ["accuracy"],
      risk_tags: [], provenance: { run_id: "r", exp_id: "exp-001", verdict: "negative", metric_family: "accuracy", source: "experiment", created_ts: "t" },
      score: 1, promotion_state: "quarantine", created_ts: "t", write_count: 1,
      reinforcement_count: 0, corroborating_runs: ["r"], hits: 0, misses: 0,
    } as Lesson;
    expect(promotable(lesson, policy)).toBe(true);
  });
});
test('policyFromMetric uses knobs + defaults', () => {
  const p = policyFromMetric({ memoryHalfLifeDays: 14 } as any);
  expect(p.halfLifeDays).toBe(14); expect(p.minCorroboration).toBe(2); expect(p.diversityFloor).toBe(2);
});
test('buildLessonDraft is data-only with delta', () => {
  const d = buildLessonDraft({ approachLabel: 'dropout sweep', metricName: 'accuracy', metricValue: 0.92, parentMetric: 0.90, direction: 'maximize', family: 'accuracy', operator: 'improve', knob: 'dropout', runId: 'r1', expId: 'exp-2', verdict: 'a1-verified', createdTs: '2026-06-25T00:00:00Z' }) as any;
  expect(d.provenance.source).toBe('experiment');
  expect(d.metric_family).toBe('accuracy');
  expect(d.delta).toBeCloseTo(0.02);
  expect(d.claim).not.toMatch(/ignore|always|END_OF_INSTRUCTION|From:/i);
});
