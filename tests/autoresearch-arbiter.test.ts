import { describe, expect, test } from "vitest";
import {
  frameMetric,
  defaultTimeBudget,
  triageQuestion,
  decideQuestion,
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

describe("decideQuestion", () => {
  test("autonomous: a multiple-choice question replies, never blocks", () => {
    const a = decideQuestion(
      { message: "Which split?", options: ["train", "test"] },
      { objective: "x", metric: "accuracy" },
      true,
    );
    expect(a.blocked).toBeFalsy();
    expect(a.infeasible).toBeFalsy();
    expect(a.reply).toBeTruthy();
    expect(typeof a.reply).toBe("string");
  });

  test("autonomous: an open-ended/no-signal question fails closed, never blocks", () => {
    const b = decideQuestion(
      { message: "What novel architecture should I invent?" },
      { objective: "x", metric: "accuracy" },
      true,
    );
    expect(b.infeasible).toBe(true);
    expect(b.blocked).toBeFalsy();
    expect(b.reply).toBeFalsy();
  });

  test("interactive (autonomous=false): any question blocks, no reply/infeasible", () => {
    const r = decideQuestion(
      { message: "q" },
      { objective: "x", metric: "m" },
      false,
    );
    expect(r.blocked).toBe(true);
    expect(r.reply).toBeFalsy();
    expect(r.infeasible).toBeFalsy();
  });

  test("interactive blocks even a triageable multiple-choice question", () => {
    const r = decideQuestion(
      { message: "Which split?", options: ["train", "test"] },
      { objective: "x", metric: "accuracy" },
      false,
    );
    expect(r.blocked).toBe(true);
    expect(r.reply).toBeFalsy();
    expect(r.infeasible).toBeFalsy();
  });

  test("is deterministic", () => {
    const q = { message: "Which split?", options: ["train", "test"] };
    const ctx = { objective: "x", metric: "accuracy" };
    expect(decideQuestion(q, ctx, true)).toEqual(decideQuestion(q, ctx, true));
    expect(decideQuestion(q, ctx, false)).toEqual(decideQuestion(q, ctx, false));
  });
});
