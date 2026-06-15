// tests/perform-reset-status.test.ts — T7: perform reset-status verb (force-idle recovery).
// reset-status atomically writes the resolved worker's status.json to idle so the not-idle
// gate in turnSendWith stops refusing after a timed-out turn (deploy "Force-retry" parity).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { workerDir } from "../src/core/paths.js";
import { run } from "../src/commands/perform.js";

describe("perform reset-status", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("atomically writes idle state for the resolved worker", async () => {
    const pd = workerDir("alpha", "codex", "svc");
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "pane.json"), JSON.stringify({ agent: "alpha", model: "codex" }) + "\n");
    writeFileSync(join(pd, "status.json"), '{"state":"working"}\n');
    const rc = await run(["reset-status", "svc", "alpha"]);
    expect(rc).toBe(0);
    expect(readFileSync(join(pd, "status.json"), "utf8")).toContain('"state":"idle"');
  });

  it("rc 1 when no worker dir resolves", async () => {
    expect(await run(["reset-status", "svc", "ghost"])).toBe(1);
  });

  it("rc 2 on bad usage (missing agent)", async () => {
    expect(await run(["reset-status", "svc"])).toBe(2);
  });
});
