// The autoresearch stale probe is a mid-experiment inbox write to a worker whose task states its own
// done contract. It must carry --no-done-instruction, or the worker answers the probe with a generic
// `done` the loop scores as the experiment's completion (2026-09-05-worker-delegation-reminder-design.md,
// exposure 4). Pinned here because no verb composes that line: the hub types it from the directive.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const directive = readFileSync(join(process.cwd(), "commands", "autoresearch.md"), "utf8");

describe("autoresearch directive: the stale probe", () => {
  const stale = directive.slice(directive.indexOf("- **`stale`**"), directive.indexOf("- **`stuck`**"));

  it("is the one stale bullet, and it sends with --no-done-instruction", () => {
    expect(stale.length).toBeGreaterThan(0);
    expect(stale).toMatch(/\$CS send --from hub --no-done-instruction <agent> <TOPIC> "status\? brief\s+update on the\s+current experiment please"/);
  });

  it("keeps the lane visible as stale and says the monitor still counts toward stuck", () => {
    expect(stale).toContain("`phase=stale, probe_sent_ts=<now UTC ISO>`");
    expect(stale).toContain("`stuck` notification below still fires for a probed lane");
  });

  // Root cause, not symptom: EVERY mid-experiment message to an autoresearch worker (probe, autonomous
  // answer to a question, operator's clarifying prompt) goes to a worker whose experiment brief owns
  // the done contract, so every worker-directed send line in the directive must carry the flag.
  it("every worker-directed send in the directive carries the flag", () => {
    const sends = directive.split("\n").filter((l) => /\$CS send --from hub .*<agent> <TOPIC>/.test(l));
    expect(sends.length).toBeGreaterThanOrEqual(3);
    for (const l of sends) expect(l).toContain("$CS send --from hub --no-done-instruction <agent> <TOPIC>");
  });
});
