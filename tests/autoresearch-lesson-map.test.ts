import { expect, test } from 'vitest';

import { metricFamilyOf, lessonVerdictOf, policyFromMetric, buildLessonDraft } from '../src/core/autoresearchLessonMap.js';

test('metricFamilyOf maps known metrics, null for unknown', () => {
  expect(metricFamilyOf('accuracy')).toBe('accuracy');
  expect(metricFamilyOf('Loss')).toBe('loss');
  expect(metricFamilyOf('mean_average_precision')).toBeNull(); // not in closed set -> skip
});
test('lessonVerdictOf prefers C1, else A1, else null', () => {
  expect(lessonVerdictOf('verified', 'reproduced')).toBe('c1-reimpl-ok');
  expect(lessonVerdictOf('verified', undefined)).toBe('a1-verified');
  expect(lessonVerdictOf('mismatch', 'not-reproduced')).toBeNull();
  expect(lessonVerdictOf(undefined, undefined)).toBeNull();
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
