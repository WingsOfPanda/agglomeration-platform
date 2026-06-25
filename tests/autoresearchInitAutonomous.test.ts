// tests/autoresearchInitAutonomous.test.ts — Task 14: `--autonomous` init seeds
// the metric + time-budget so a no-follow-up run skips those interactive prompts.
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

function home() { const h = freshHome(); cleanups.push(h.cleanup); return h; }

const okDeps = (over: Partial<AutoresearchInitDeps> = {}): AutoresearchInitDeps => ({
  haveCmd: () => true,
  agentBinary: (n) => (n === "codex" ? "codex" : undefined),
  now: () => "2026-05-30T00:00:00Z",
  probeHardware: () => {},
  configRoot: () => process.cwd(),
  ...over,
});

describe("autoresearch init --autonomous", () => {
  it("seeds metric.md + time-budget.txt + session-start.txt + autonomous.txt without prompting", async () => {
    const h = home();
    const rc = await initWith(
      ["--autonomous", "maximize accuracy on cifar10"],
      okDeps({ opts: { home: h.home, cwd: h.home } }),
    );
    expect(rc).toBe(0);
    const art = autoresearchArtDir("maximize-accuracy-on", { home: h.home, cwd: h.home });
    expect(existsSync(join(art, "metric.md"))).toBe(true);
    const metricMd = readFileSync(join(art, "metric.md"), "utf8");
    expect(metricMd).toMatch(/Primary metric:.*accuracy/);
    expect(metricMd).not.toContain("AskUserQuestion");
    expect(existsSync(join(art, "time-budget.txt"))).toBe(true);
    expect(existsSync(join(art, "session-start.txt"))).toBe(true);
    expect(readFileSync(join(art, "session-start.txt"), "utf8").trim()).toBe("2026-05-30T00:00:00Z");
    expect(existsSync(join(art, "autonomous.txt"))).toBe(true);
    expect(readFileSync(join(art, "autonomous.txt"), "utf8").trim()).toBe("1");
  });

  it("AP_AUTORESEARCH_AUTONOMOUS=1 env also triggers autonomous seeding", async () => {
    const h = home();
    process.env.AP_AUTORESEARCH_AUTONOMOUS = "1";
    const rc = await initWith(
      ["minimize loss on a held-out set"],
      okDeps({ opts: { home: h.home, cwd: h.home } }),
    );
    expect(rc).toBe(0);
    const art = autoresearchArtDir("minimize-loss-on-a-h", { home: h.home, cwd: h.home });
    expect(existsSync(join(art, "metric.md"))).toBe(true);
    expect(existsSync(join(art, "autonomous.txt"))).toBe(true);
  });

  it("explicit --metric / --time-budget win over autonomous defaults", async () => {
    const h = home();
    const rc = await initWith(
      [
        "--autonomous",
        "--metric", "primary_metric=auc,direction=maximize,min_acceptable=>= 0.8",
        "--time-budget", "2h",
        "tune the model",
      ],
      okDeps({ opts: { home: h.home, cwd: h.home } }),
    );
    expect(rc).toBe(0);
    const art = autoresearchArtDir("tune-the-model", { home: h.home, cwd: h.home });
    expect(readFileSync(join(art, "metric.md"), "utf8")).toContain("**Primary metric:** auc");
    expect(readFileSync(join(art, "time-budget.txt"), "utf8").trim()).toBe("7200");
    expect(existsSync(join(art, "autonomous.txt"))).toBe(true);
  });

  it("interactive path (no --autonomous, no env) does NOT write metric.md/autonomous.txt", async () => {
    const h = home();
    const rc = await initWith(
      ["maximize accuracy on cifar10"],
      okDeps({ opts: { home: h.home, cwd: h.home } }),
    );
    expect(rc).toBe(0);
    const art = autoresearchArtDir("maximize-accuracy-on", { home: h.home, cwd: h.home });
    expect(existsSync(join(art, "metric.md"))).toBe(false);
    expect(existsSync(join(art, "time-budget.txt"))).toBe(false);
    expect(existsSync(join(art, "session-start.txt"))).toBe(false);
    expect(existsSync(join(art, "autonomous.txt"))).toBe(false);
  });
});
