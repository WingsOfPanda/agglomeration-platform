import { describe, expect, test } from "vitest";
import { selectFinalists, pickWinner } from "../src/core/autoresearchSelect.js";
import type { ScoreRowWithSignals } from "../src/core/autoresearchSelect.js";

// Build a row with the REAL ScoreRow shape: metric + runtime are STRINGS
// (mirrors buildScoreboard, which parseFloat()s them). The caller may attach
// optional numeric heldOut / reliability fields on top.
const row = (o: Partial<ScoreRowWithSignals>): ScoreRowWithSignals => ({
  status: "ok",
  runtime: "1",
  expId: "exp-1",
  agent: "a",
  approach: "x",
  metricName: "acc",
  metric: "0",
  ...o,
});

describe("selectFinalists", () => {
  test("returns top-k feasible ok rows in direction order, excludes x-rank/fail", () => {
    const rows = [
      row({ metric: "0.9", expId: "exp-1" }),
      row({ metric: "0.95", expId: "exp-2" }),
      row({ metric: "0.8", expId: "exp-3" }),
      row({ status: "ok", metric: "0.99", expId: "exp-4", infeasibleReason: "data-leakage" }), // x-rank
      row({ status: "fail", metric: "n/a", expId: "exp-5" }), // non-numeric metric
    ];
    const f = selectFinalists(rows, 2, "maximize");
    expect(f.map((r) => r.expId)).toEqual(["exp-2", "exp-1"]);
  });

  test("minimize direction reverses the order", () => {
    const rows = [
      row({ metric: "0.9", expId: "exp-1" }),
      row({ metric: "0.95", expId: "exp-2" }),
      row({ metric: "0.8", expId: "exp-3" }),
    ];
    const f = selectFinalists(rows, 2, "minimize");
    expect(f.map((r) => r.expId)).toEqual(["exp-3", "exp-1"]);
  });

  test("excludes rows whose metric is empty / non-finite", () => {
    const rows = [
      row({ metric: "", expId: "exp-1" }),
      row({ metric: "n/a", expId: "exp-2" }),
      row({ metric: "0.5", expId: "exp-3" }),
    ];
    const f = selectFinalists(rows, 5, "maximize");
    expect(f.map((r) => r.expId)).toEqual(["exp-3"]);
  });

  test("ties on metric break by parsed runtime ascending, then expId", () => {
    const rows = [
      row({ metric: "0.9", runtime: "30", expId: "exp-2" }),
      row({ metric: "0.9", runtime: "10", expId: "exp-3" }),
      row({ metric: "0.9", runtime: "10", expId: "exp-1" }),
    ];
    const f = selectFinalists(rows, 3, "maximize");
    // runtime 10 before runtime 30; within runtime 10, expId localeCompare (exp-1 before exp-3)
    expect(f.map((r) => r.expId)).toEqual(["exp-1", "exp-3", "exp-2"]);
  });

  test("k is clamped to at least 1", () => {
    const rows = [row({ metric: "0.9", expId: "exp-1" }), row({ metric: "0.8", expId: "exp-2" })];
    const f = selectFinalists(rows, 0, "maximize");
    expect(f.map((r) => r.expId)).toEqual(["exp-1"]);
  });
});

describe("pickWinner", () => {
  test("prefers held-out over raw metric", () => {
    const f = [
      row({ metric: "0.95", heldOut: 0.8, expId: "exp-2" }),
      row({ metric: "0.9", heldOut: 0.88, expId: "exp-1" }),
    ];
    const { winner, degraded } = pickWinner(f, "held-out", "maximize");
    expect(winner!.expId).toBe("exp-1"); // higher held-out wins despite lower validation metric
    expect(degraded).toBe(false);
  });

  test("uses reliability signal when requested", () => {
    const f = [
      row({ metric: "0.95", reliability: 0.5, expId: "exp-2" }),
      row({ metric: "0.9", reliability: 0.9, expId: "exp-1" }),
    ];
    const { winner, degraded } = pickWinner(f, "reliability", "maximize");
    expect(winner!.expId).toBe("exp-1");
    expect(degraded).toBe(false);
  });

  test("degrades to rank-1 when no reliable signal", () => {
    const f = [row({ metric: "0.95", expId: "exp-2" }), row({ metric: "0.9", expId: "exp-1" })];
    const { winner, degraded } = pickWinner(f, "held-out", "maximize");
    expect(winner!.expId).toBe("exp-2");
    expect(degraded).toBe(true);
  });

  test("ignores rows with a non-finite signal value", () => {
    const f = [
      row({ metric: "0.95", heldOut: Number.NaN, expId: "exp-2" }),
      row({ metric: "0.9", heldOut: 0.88, expId: "exp-1" }),
    ];
    const { winner, degraded } = pickWinner(f, "held-out", "maximize");
    expect(winner!.expId).toBe("exp-1");
    expect(degraded).toBe(false);
  });

  test("empty finalists -> null winner, degraded", () => {
    const { winner, degraded } = pickWinner([], "held-out", "maximize");
    expect(winner).toBeNull();
    expect(degraded).toBe(true);
  });

  test("minimize direction picks lowest signal", () => {
    const f = [
      row({ metric: "0.1", heldOut: 0.5, expId: "exp-2" }),
      row({ metric: "0.2", heldOut: 0.3, expId: "exp-1" }),
    ];
    const { winner, degraded } = pickWinner(f, "held-out", "minimize");
    expect(winner!.expId).toBe("exp-1"); // lowest held-out wins under minimize
    expect(degraded).toBe(false);
  });
});
