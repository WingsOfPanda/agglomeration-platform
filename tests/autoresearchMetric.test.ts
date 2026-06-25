import { describe, test, expect } from "vitest";
import { parseMetricMd } from "../src/core/autoresearchMetric.js";

describe("parseMetricMd autonomous-bundle knobs", () => {
  test("parses new autonomous-bundle knobs with values", () => {
    const md = [
      "# Research goal",
      "**Primary metric:** accuracy",
      "**Direction:** maximize",
      "**select_k:** 4",
      "**select_signal:** held-out",
      "**max_workers:** 6",
      "**memory_half_life_days:** 14",
      "**memory_max_age_days:** 40",
      "**memory_min_corroboration:** 3",
      "**memory_scope:** repo+family",
      "**memory_write_rate_max:** 8",
      "**marginal_gain_threshold:** 0.002",
    ].join("\n");
    const t = parseMetricMd(md);
    expect(t.selectK).toBe(4);
    expect(t.selectSignal).toBe("held-out");
    expect(t.maxWorkers).toBe(6);
    expect(t.memoryHalfLifeDays).toBe(14);
    expect(t.memoryMaxAgeDays).toBe(40);
    expect(t.memoryMinCorroboration).toBe(3);
    expect(t.memoryScope).toBe("repo+family");
    expect(t.memoryWriteRateMax).toBe(8);
    expect(t.marginalGainThreshold).toBeCloseTo(0.002);
  });

  test("new knobs are undefined when absent (callers default)", () => {
    const t = parseMetricMd("# Research goal\n**Primary metric:** loss\n**Direction:** minimize\n");
    expect(t.selectK).toBeUndefined();
    expect(t.maxWorkers).toBeUndefined();
    expect(t.memoryScope).toBeUndefined();
  });
});
