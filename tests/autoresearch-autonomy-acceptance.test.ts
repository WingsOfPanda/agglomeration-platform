// tests/autoresearch-autonomy-acceptance.test.ts — Task 17: the autonomy
// acceptance gate. Pins the autonomy invariants end-to-end across the already-
// built TS surfaces (the Task 15 arbiter + the Task 14 autonomous init):
//
//   1. In autonomous mode, NO worker question ever parks at phase=blocked — a
//      battery of question shapes (multiple-choice, factual, several open-ended)
//      each resolves to {reply} or {infeasible}, never {blocked}.
//   2. A no-question launch: `--autonomous` + only an objective seeds the inputs
//      a human would otherwise be asked for (metric.md / time-budget.txt /
//      session-start.txt / autonomous.txt), so the directive's metric/time-budget
//      AskUserQuestions are skipped.
//   3. The autonomy behavior is mode-gated, not a global change: interactive
//      mode (autonomous=false) still returns {blocked:true}.
//
// Test-only: consumes the cores by their public surfaces; no source changes.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { decideQuestion } from "../src/core/autoresearchArbiter.js";
import { initWith, type AutoresearchInitDeps } from "../src/commands/autoresearch.js";
import { autoresearchArtDir } from "../src/core/autoresearch.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  delete process.env.AP_AUTORESEARCH_AUTONOMOUS;
  while (cleanups.length) cleanups.pop()!();
});

function home() {
  const h = freshHome();
  cleanups.push(h.cleanup);
  return h;
}

// Mirror the init-autonomous test's fake deps so init runs with no real binary
// probe / clock / fs-outside-the-temp-home.
const okDeps = (over: Partial<AutoresearchInitDeps> = {}): AutoresearchInitDeps => ({
  haveCmd: () => true,
  agentBinary: (n) => (n === "codex" ? "codex" : undefined),
  now: () => "2026-05-30T00:00:00Z",
  probeHardware: () => {},
  configRoot: () => process.cwd(),
  ...over,
});

// The locked run context a worker's questions are triaged against.
const ctx = {
  objective: "maximize accuracy on cifar10",
  metric: "accuracy",
};

describe("autoresearch autonomy acceptance gate", () => {
  // Invariant 1 (headline): no worker question ever parks at phase=blocked in
  // autonomous mode. Drive a battery of shapes — multiple-choice, factual, and
  // several open-ended — and assert NONE block. Each is {reply} or {infeasible}.
  it("never blocks in autonomous mode across a battery of question shapes", () => {
    const battery: Array<{ message: string; options?: string[] }> = [
      // multiple-choice (options present)
      { message: "which train/val split should I use?", options: ["80/20", "90/10"] },
      { message: "pick an optimizer", options: ["adam", "sgd", "adamw"] },
      // factual (the context already answers these)
      { message: "which metric are we optimizing?" },
      { message: "what is the objective and time budget?" },
      // open-ended (no grounded answer in context) — must fail closed to
      // {infeasible}, never {blocked}
      { message: "invent a novel architecture for this task" },
      { message: "what should we do next?" },
      { message: "is there a better dataset somewhere?" },
      { message: "design the whole experiment plan from scratch" },
    ];

    let sawReply = false;
    let sawInfeasible = false;
    for (const q of battery) {
      const result = decideQuestion(q, ctx, true);
      // The headline invariant: nothing parks at phase=blocked in autonomous mode.
      expect(result.blocked).toBeFalsy();
      // And every result is one of the two terminal shapes (reply XOR infeasible).
      const isReply = typeof result.reply === "string";
      const isInfeasible = result.infeasible === true;
      expect(isReply || isInfeasible).toBe(true);
      expect(isReply && isInfeasible).toBe(false);
      sawReply = sawReply || isReply;
      sawInfeasible = sawInfeasible || isInfeasible;
    }

    // Prove the battery genuinely exercises BOTH terminal paths (not a tautology
    // where everything happens to reply, or everything happens to be infeasible):
    // the grounded shapes reply, the open-ended ones route to infeasible.
    expect(sawReply).toBe(true);
    expect(sawInfeasible).toBe(true);
  });

  // Invariant 2: a no-question launch. `--autonomous` with only an objective
  // (no --metric, no --time-budget) returns 0 and machine-seeds the inputs a
  // human would otherwise be asked for, so the directive's metric/time-budget
  // AskUserQuestions are skipped.
  it("seeds metric/time-budget/start/flag from --autonomous + objective only (no prompt inputs)", async () => {
    const h = home();
    const rc = await initWith(
      ["--autonomous", "maximize accuracy on cifar10"],
      okDeps({ opts: { home: h.home, cwd: h.home } }),
    );
    expect(rc).toBe(0);

    const art = autoresearchArtDir("maximize-accuracy-on", { home: h.home, cwd: h.home });
    // The four inputs a human would otherwise be asked for are all present.
    expect(existsSync(join(art, "metric.md"))).toBe(true);
    expect(existsSync(join(art, "time-budget.txt"))).toBe(true);
    expect(existsSync(join(art, "session-start.txt"))).toBe(true);
    expect(existsSync(join(art, "autonomous.txt"))).toBe(true);

    // The seeded metric is real (frames accuracy from the objective) and carries
    // no leftover interactive prompt — the metric AskUserQuestion is skipped.
    const metricMd = readFileSync(join(art, "metric.md"), "utf8");
    expect(metricMd).toMatch(/Primary metric:.*accuracy/);
    expect(metricMd).not.toContain("AskUserQuestion");

    // The autonomous flag file marks the run so the loop reads it as autonomous.
    expect(readFileSync(join(art, "autonomous.txt"), "utf8").trim()).toBe("1");
  });

  // Invariant 3: the autonomy behavior is mode-gated, not a global change.
  // Interactive mode (autonomous=false) still blocks on a worker question — the
  // exact same questions that auto-resolve above surface to a human here.
  it("interactive mode still blocks on a worker question (mode-gated)", () => {
    const probes: Array<{ message: string; options?: string[] }> = [
      { message: "which train/val split should I use?", options: ["80/20", "90/10"] },
      { message: "which metric are we optimizing?" },
      { message: "invent a novel architecture for this task" },
    ];
    for (const q of probes) {
      const result = decideQuestion(q, ctx, false);
      expect(result.blocked).toBe(true);
      expect(result.reply).toBeUndefined();
      expect(result.infeasible).toBeUndefined();
    }
  });
});
