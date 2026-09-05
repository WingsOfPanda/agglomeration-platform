// The bridge hub briefs a worker every round about repo B, a repo it does not stand in, and runs the
// advisory verify there itself. These sentences are the hub's counterpart of the worker delegation
// block (2026-09-05-worker-delegation-reminder-design.md, amendment "bridge's hub side"): the review
// reading and the log reading are delegable; every repo-B citation, the verify run and its `VERIFY`
// token, and every `$CS` verb are the hub's own.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const bridge = readFileSync(join(process.cwd(), "commands", "bridge.md"), "utf8").replace(/\s+/g, " ");
const flagging = bridge.slice(bridge.indexOf("## Flagging suspicions"), bridge.indexOf("## Stage 0"));
const stage2 = bridge.slice(bridge.indexOf("## Stage 2"), bridge.indexOf("## Stage 3"));
const stage3 = bridge.slice(bridge.indexOf("## Stage 3"), bridge.indexOf("## Stage 4"));
const before2 = bridge.slice(bridge.indexOf("## Stage 0"), bridge.indexOf("## Stage 2"));

describe("bridge.md hub side: the hub's own delegation split", () => {
  it("Flagging keeps every $CS verb with the hub and bounds a repo-B subagent", () => {
    expect(flagging).toContain("Every `$CS` verb is keyed to YOUR cwd (repo A): run them yourself.");
    expect(flagging).toContain("never a `$CS` command");
  });

  it("Stage 2 keeps the brief's citations and the relayed answer with the hub", () => {
    expect(stage2).toContain("Reviewing the outbox and the diff is grind you may dispatch to a subagent");
    expect(stage2).toContain("never originate a citation.");
    expect(stage2).toContain("the answer you relay is yours");
  });

  it("Stage 3 keeps the verify run and its VERIFY token with the hub", () => {
    expect(stage3).toContain("the run in `<TARGET>` is yours, in your own shell");
    expect(stage3).toContain("never off a subagent's summary");
  });

  it("none of the sentences leaks before Stage 2", () => {
    expect(before2).not.toContain("never originate a citation");
    expect(before2).not.toContain("never off a subagent's summary");
  });
});
