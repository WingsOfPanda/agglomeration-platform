// The design fast path spawns no worker, so the worker identity's delegation block never reaches it:
// the hub researches and drafts the doc itself. These two sentences are the hub's counterpart
// (2026-09-05-worker-delegation-reminder-design.md, amendment "the hub on design's fast path"):
// the research pass is delegable grind, and every citation the hub keeps it opened itself.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const design = readFileSync(join(process.cwd(), "commands", "design.md"), "utf8").replace(/\s+/g, " ");
const stage1 = design.slice(design.indexOf("## Stage 1 — routing"), design.indexOf("## Stage 2 — fast-path"));
const stage2 = design.slice(design.indexOf("## Stage 2 — fast-path"), design.indexOf("Then assemble + audit"));

describe("design.md fast path: the hub's own delegation split", () => {
  it("Stage 1's research pass is named as grind the hub dispatches, keeping the check and the route", () => {
    expect(stage1.length).toBeGreaterThan(0);
    expect(stage1).toContain("The research pass is grind: apply your own orchestrator/executor split");
    expect(stage1).toContain("dispatch the searches and repo sweeps to subagents with an explicit cheaper model");
    expect(stage1).toContain("the 4-signal check and the route decision stay with you");
  });

  it("Stage 2 keeps every citation's opening with the hub", () => {
    expect(stage2.length).toBeGreaterThan(0);
    expect(stage2).toContain("Every `path:line`, URL or runtime observation the doc cites, you opened or observed yourself");
    expect(stage2).toContain("a subagent may enumerate what to open, never originate a citation");
  });

  it("neither fast-path sentence leaks into the ensemble stages (the ensemble hub has its own section)", () => {
    const rest = design.slice(design.indexOf("## Stage 3"));
    expect(rest).not.toContain("orchestrator/executor split");
    expect(rest).not.toContain("never originate a citation");
  });
});
