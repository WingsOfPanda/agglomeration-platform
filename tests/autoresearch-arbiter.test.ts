import { describe, expect, test } from "vitest";
import {
  frameMetric,
  defaultTimeBudget,
  triageQuestion,
} from "../src/core/autoresearchArbiter.js";
import { formatMetricBlock } from "../src/core/autoresearchMetric.js";

describe("frameMetric", () => {
  test("is deterministic and uses the metric vocab", () => {
    const a = frameMetric("maximize classification accuracy on cifar10");
    const b = frameMetric("maximize classification accuracy on cifar10");
    expect(a).toEqual(b); // deterministic
    expect(a.primary_metric).toBe("accuracy"); // from extractMetric vocab
    expect(a.direction).toBe("maximize");
    expect(a.min_acceptable).toBe("(not set)");
  });

  test("infers minimize for a loss objective", () => {
    expect(frameMetric("drive validation loss down").direction).toBe("minimize");
  });

  test("infers minimize from a minimize/reduce verb even with a maximize-by-default metric", () => {
    expect(frameMetric("reduce inference latency").direction).toBe("minimize");
    expect(frameMetric("minimize the accuracy gap").direction).toBe("minimize");
    expect(frameMetric("lower the params count").direction).toBe("minimize");
  });

  test("falls back to accuracy when no metric word is present", () => {
    const f = frameMetric("make the model better at recognizing cats");
    expect(f.primary_metric).toBe("accuracy");
    expect(f.direction).toBe("maximize");
  });

  test("ignores opts in the pure core (deterministic regardless of sota/memory)", () => {
    const plain = frameMetric("maximize accuracy");
    const withOpts = frameMetric("maximize accuracy", {
      sota: "0.99 on cifar10",
      memory: ["prior run hit 0.97"],
    });
    expect(withOpts).toEqual(plain);
  });

  test("returns formatMetricBlock-compatible keys", () => {
    const fields = frameMetric("maximize classification accuracy");
    // Should not throw: frameMetric must supply the required keys.
    const block = formatMetricBlock(fields);
    expect(block).toContain("**Primary metric:** accuracy");
    expect(block).toContain("**Direction:** maximize");
    expect(block).toContain("**min_acceptable:** (not set)");
  });
});

describe("defaultTimeBudget", () => {
  test("returns a parseable budget", () => {
    const b = defaultTimeBudget("anything");
    expect(b === "none" || /^[0-9]+$/.test(b)).toBe(true);
  });

  test("is deterministic", () => {
    expect(defaultTimeBudget("objective one")).toBe(defaultTimeBudget("objective two"));
  });
});

describe("triageQuestion", () => {
  test("answers a multiple-choice question from context", () => {
    const r = triageQuestion(
      { message: "Which split?", options: ["train", "test"] },
      { objective: "x", metric: "accuracy" },
    );
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(typeof r.answer).toBe("string");
    }
  });

  test("fails closed on an open-ended question with no context signal", () => {
    const r = triageQuestion(
      { message: "What novel architecture should I invent?" },
      { objective: "x", metric: "accuracy" },
    );
    expect(r.action).toBe("fail-closed");
    // The fail-closed branch carries no answer.
    expect("answer" in r).toBe(false);
  });

  test("picks the option most consistent with the locked metric/objective", () => {
    const r = triageQuestion(
      { message: "Which target?", options: ["latency", "accuracy"] },
      { objective: "improve accuracy on cifar10", metric: "accuracy" },
    );
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answer).toBe("accuracy");
    }
  });

  test("tie-breaks deterministically on the first option", () => {
    const r = triageQuestion(
      { message: "Which one?", options: ["foo", "bar"] },
      { objective: "x", metric: "accuracy" },
    );
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answer).toBe("foo");
    }
  });

  test("answers a closed factual question the context already carries", () => {
    const r = triageQuestion(
      { message: "What metric am I optimizing?" },
      { objective: "beat sota on cifar10", metric: "accuracy" },
    );
    expect(r.action).toBe("answer");
    if (r.action === "answer") {
      expect(r.answer).toContain("accuracy");
      expect(r.answer).toContain("beat sota on cifar10");
    }
  });

  test("is deterministic", () => {
    const q = { message: "Which split?", options: ["train", "test"] };
    const ctx = { objective: "x", metric: "accuracy" };
    expect(triageQuestion(q, ctx)).toEqual(triageQuestion(q, ctx));
  });
});
