// The quick hub (attached, or the detached job hub) does two grind-shaped things itself: gathering the
// brief's evidence and running the verify gate. These sentences are the hub's counterpart of the worker
// delegation block (2026-09-05-worker-delegation-reminder-design.md, amendment "quick's hub side"):
// the gathering and the log reading are delegable; the brief, every citation and the gate run are the
// hub's own.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const quick = readFileSync(join(process.cwd(), "commands", "quick.md"), "utf8").replace(/\s+/g, " ");
const stage0 = quick.slice(quick.indexOf("## Stage 0"), quick.indexOf("## Stage 1"));
const stage2 = quick.slice(quick.indexOf("## Stage 2"), quick.indexOf("## Stage 3"));
const detached = quick.slice(quick.indexOf("## DETACHED MODE"), quick.indexOf("## Flagging suspicions"));
const stage1 = quick.slice(quick.indexOf("## Stage 1"), quick.indexOf("## Stage 2"));

describe("quick.md hub side: the hub's own delegation split", () => {
  it("Stage 0's citation rule is first-person and names the evidence gathering as delegable grind", () => {
    expect(stage0).toContain("Read/Glob/`ls` you ran yourself in this turn.");
    expect(stage0).not.toContain("in *this* session");
    expect(stage0).toContain("**Gathering the evidence is grind; the brief is yours.**");
    expect(stage0).toContain("a subagent may enumerate what to open, never originate a citation.");
  });

  it("Stage 2 keeps the gate run and the VERIFY attestation with the hub", () => {
    expect(stage2).toContain("Reading the log and its failure tail is grind you may dispatch to a subagent");
    expect(stage2).toContain("the gate run itself is yours — run it in your own shell with the pin");
    expect(stage2).toContain("read off the tee'd log yourself, never off a subagent's summary.");
  });

  it("DETACHED MODE keeps the Monitors, the relay, the park and every rc-bearing verb with the hubs", () => {
    expect(detached).toContain("**Driving the run is your own turn, on either side.**");
    expect(detached).toContain("every `$CS` verb whose rc you branch on are never delegated");
    expect(detached).toContain("its report of a verb's output is not the verb's rc");
    expect(detached).toContain("since a job hub's own pane stands in the main checkout");
  });

  it("Stage 1 keeps the reply to a worker's question with the hub", () => {
    expect(stage1).toContain("The reply is yours: a subagent may look up what you ask it to");
    expect(stage1).toContain("you opened in `<TARGET>` yourself in this turn");
  });

  it("neither sentence leaks into Stage 1 or Stage 3", () => {
    const rest = quick.slice(quick.indexOf("## Stage 1"), quick.indexOf("## Stage 2")) + quick.slice(quick.indexOf("## Stage 3"));
    expect(rest).not.toContain("never originate a citation");
    expect(rest).not.toContain("never off a subagent's summary");
  });
});
