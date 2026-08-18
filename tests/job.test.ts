import { describe, it, expect } from "vitest";
import * as J from "../src/core/job.js";
import type { OutboxEvent, PaneOwner } from "../src/core/ipc.js";

const NONCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";   // the shape randomUUID mints
const REC: J.JobRecord = {
  command: "implement", topic: "demo", session: "ap-demo",
  hub: { agent: "alpha", model: "claude" },
  provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
  args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
};
const owner = (paneId: string, nonce: string): PaneOwner => ({ paneId, nonce });

describe("job record codec", () => {
  it("round-trips", () => {
    expect(J.parseJob(J.formatJob(REC))).toEqual(REC);
  });
  it("formatJob ends with a newline (the file is line-oriented like every other state file)", () => {
    expect(J.formatJob(REC).endsWith("\n")).toBe(true);
  });
  it("an unusable record reads as NO job, never as a half-populated one", () => {
    expect(J.parseJob("")).toBeNull();
    expect(J.parseJob("{not json")).toBeNull();
    expect(J.parseJob("null")).toBeNull();
    expect(J.parseJob(JSON.stringify({ ...REC, command: "explore" }))).toBeNull();  // not a job command
    expect(J.parseJob(JSON.stringify({ ...REC, topic: "" }))).toBeNull();
    expect(J.parseJob(JSON.stringify({ ...REC, session: "" }))).toBeNull();
    expect(J.parseJob(JSON.stringify({ ...REC, started: "" }))).toBeNull();
    expect(J.parseJob(JSON.stringify({ ...REC, hub: { agent: "alpha" } }))).toBeNull();
  });
  it("defaults the soft fields rather than rejecting the record", () => {
    const r = J.parseJob(JSON.stringify({ command: "quick", topic: "t", session: "ap-t", hub: { agent: "a", model: "claude" }, started: "2026-08-18T00:00:00Z" }))!;
    expect(r.finish).toBe("keep");
    expect(r.budget_hours).toBe(0);
    expect(r.provider).toBe("");
  });
});

describe("classifyJobLiveness — three-valued, and never 'dead' without proof", () => {
  it("alive: the pane is live and carries the nonce we recorded", () => {
    expect(J.classifyJobLiveness(new Map([["%1", NONCE]]), owner("%1", NONCE))).toBe("alive");
  });
  it("dead: a VERIFIABLE nonce whose pane is gone, or now belongs to someone else", () => {
    expect(J.classifyJobLiveness(new Map(), owner("%1", NONCE))).toBe("dead");
    expect(J.classifyJobLiveness(new Map([["%1", "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"]]), owner("%1", NONCE))).toBe("dead");
  });
  it("unknown: no record, no pane id, or a nonce ap could never have minted", () => {
    expect(J.classifyJobLiveness(new Map(), null)).toBe("unknown");
    expect(J.classifyJobLiveness(new Map(), owner("", NONCE))).toBe("unknown");
    expect(J.classifyJobLiveness(new Map(), owner("%1", ""))).toBe("unknown");          // pre-nonce pane.json
    expect(J.classifyJobLiveness(new Map(), owner("%1", "not-a-uuid"))).toBe("unknown");
    // and it stays unknown even when a pane by that id is live — no nonce, no proof either way
    expect(J.classifyJobLiveness(new Map([["%1", ""]]), owner("%1", ""))).toBe("unknown");
  });
});

describe("budget", () => {
  const t0 = Date.parse("2026-08-18T00:00:00Z");
  const at = (h: number) => t0 + h * 3_600_000;
  it("exactly at the budget is still WITHIN; a second past it is not", () => {
    expect(J.budgetExceeded(REC.started, 6, at(6))).toBe(false);
    expect(J.budgetExceeded(REC.started, 6, at(6) + 1000)).toBe(true);
  });
  it("well inside the budget is within", () => {
    expect(J.budgetExceeded(REC.started, 6, at(1))).toBe(false);
  });
  it("fails CLOSED (toward parking) on anything it cannot interpret", () => {
    expect(J.budgetExceeded("not a date", 6, at(1))).toBe(true);
    expect(J.budgetExceeded(REC.started, 0, at(1))).toBe(true);
    expect(J.budgetExceeded(REC.started, -3, at(1))).toBe(true);
    expect(J.budgetExceeded(REC.started, NaN, at(1))).toBe(true);
  });
  it("elapsedHours is null exactly when the start time is unreadable", () => {
    expect(J.elapsedHours(REC.started, at(2))).toBeCloseTo(2, 6);
    expect(J.elapsedHours("nope", at(2))).toBeNull();
  });
});

describe("sessionKillable — fail closed", () => {
  it("true only when the session holds panes and EVERY one is provably ours", () => {
    expect(J.sessionKillable(["%1", "%2"], new Set(["%1", "%2", "%3"]))).toBe(true);
  });
  it("one unaccounted-for pane refuses the kill", () => {
    expect(J.sessionKillable(["%1", "%9"], new Set(["%1"]))).toBe(false);
  });
  it("an empty listing is 'nothing to kill', NOT 'safe to kill' (it also means tmux errored)", () => {
    expect(J.sessionKillable([], new Set(["%1"]))).toBe(false);
    expect(J.sessionKillable([], new Set())).toBe(false);
  });
  it("no owned panes at all refuses the kill", () => {
    expect(J.sessionKillable(["%1"], new Set())).toBe(false);
  });
});

describe("jobProgress", () => {
  const ev = (event: string, extra: Record<string, unknown> = {}): OutboxEvent => ({ event, ...extra });
  it("a question is parked only while it is the newest event", () => {
    expect(J.jobProgress([ev("ack"), ev("question", { message: "which?" })]).parked?.message).toBe("which?");
  });
  it("anything after the question means it was answered and the run moved on", () => {
    expect(J.jobProgress([ev("question"), ev("ack")]).parked).toBeNull();
    expect(J.jobProgress([ev("question"), ev("done")]).parked).toBeNull();
  });
  it("an empty outbox has no last event and nothing parked", () => {
    expect(J.jobProgress([])).toEqual({ last: null, parked: null });
  });
});

describe("launch-time gates", () => {
  it("keep is the ONLY finish action a detached run accepts", () => {
    expect(J.finishAllowedDetached("keep")).toBe(true);
    expect(J.finishAllowedDetached("merge")).toBe(false);
    expect(J.finishAllowedDetached("pr")).toBe(false);
    expect(J.finishAllowedDetached("discard")).toBe(false);
  });
  it("isJobCommand admits only the two wired commands", () => {
    expect(J.isJobCommand("implement")).toBe(true);
    expect(J.isJobCommand("quick")).toBe(true);
    expect(J.isJobCommand("explore")).toBe(false);
    expect(J.isJobCommand("autoresearch")).toBe(false);
  });
});

describe("topic derivation", () => {
  it("an explicit --topic wins, in both forms, exactly as implement init does", () => {
    expect(J.topicFromImplementArgs("docs/x-design.md --topic chosen")).toBe("chosen");
    expect(J.topicFromImplementArgs("docs/x-design.md --topic=chosen")).toBe("chosen");
  });
  it("otherwise it derives from the design-doc positional", () => {
    expect(J.topicFromImplementArgs("docs/superpowers/specs/2026-08-18-detached-job-design.md")).toBeTruthy();
  });
  it("no doc and no --topic yields empty, so the caller can demand --topic", () => {
    expect(J.topicFromImplementArgs("--no-branch")).toBe("");
    expect(J.topicFromImplementArgs("")).toBe("");
  });
  it("stripFlags drops flags and the values of value-flags, leaving the free text", () => {
    expect(J.stripFlags("fix the bug --provider codex --no-finish", new Set(["--provider"]))).toBe("fix the bug");
    expect(J.stripFlags("--provider codex", new Set(["--provider"]))).toBe("");
  });
});

describe("jobBrief", () => {
  const b = J.jobBrief(REC);
  it("names the skill to invoke and the args file", () => {
    expect(b).toContain('skill name "ap:implement"');
    expect(b).toContain("/tmp/args");
  });
  it("carries the mechanical detached-mode check and the budget verb", () => {
    expect(b).toContain("ap job mode demo");
    expect(b).toContain("ap job budget-check demo");
  });
  it("states the three things the hub may not change", () => {
    expect(b).toContain("never merge, never push, never open a PR");
    expect(b).toContain("6h");
    expect(b).toContain("Never call AskUserQuestion");
  });
});
