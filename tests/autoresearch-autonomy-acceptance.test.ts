// tests/autoresearch-autonomy-acceptance.test.ts — Task 17: the autonomy
// acceptance gate. Pins the autonomy invariant end-to-end across the already-
// built TS surface (the Task 14 autonomous init):
//
//   A no-question launch: `--autonomous` + only an objective seeds the inputs
//   a human would otherwise be asked for (metric.md / time-budget.txt /
//   session-start.txt / autonomous.txt), so the directive's metric/time-budget
//   AskUserQuestions are skipped.
//
// Test-only: consumes the cores by their public surfaces; no source changes.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
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
  configRoot: () => process.cwd(),
  ...over,
});

describe("autoresearch autonomy acceptance gate", () => {
  // A no-question launch: `--autonomous` with only an objective
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
});
