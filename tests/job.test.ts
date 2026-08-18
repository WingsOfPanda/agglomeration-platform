import { describe, it, expect } from "vitest";
import * as J from "../src/core/job.js";
import type { OutboxEvent, PaneOwner } from "../src/core/ipc.js";

const NONCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";   // the shape randomUUID mints
const REC: J.JobRecord = {
  command: "implement", topic: "demo", session: "ap-demo",
  hub: { agent: "alpha", model: "claude" },
  provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
  args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
  worktree: "/repo/.ap/worktrees/demo", base_sha: "f00dcafe", start_branch: "main",
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
  // A run launched by 0.5.35 can still be in flight when the bundle is upgraded under it. Its record
  // has neither worktree field, and it must keep reading as a live job — not become uninterpretable,
  // which for `budget-check` and `mode` would mean parking a healthy run or telling its hub it is
  // attached.
  it("a record written before worktrees existed still parses, with empty worktree fields", () => {
    const old = JSON.stringify({
      command: "implement", topic: "demo", session: "ap-demo", hub: { agent: "alpha", model: "claude" },
      provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
      args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
    });
    const r = J.parseJob(old)!;
    expect(r.worktree).toBe("");
    expect(r.base_sha).toBe("");
    expect(r.start_branch).toBe("");
    expect(r.topic).toBe("demo");     // and everything else is unchanged
    expect(r.finish).toBe("keep");
  });
  it("non-string worktree fields are read as absent rather than carried through", () => {
    const r = J.parseJob(JSON.stringify({ ...REC, worktree: 42, base_sha: null, start_branch: false }))!;
    expect(r.worktree).toBe("");
    expect(r.base_sha).toBe("");
    expect(r.start_branch).toBe("");
  });
});

describe("worktree location + provenance", () => {
  it("lives under the REPO root's .ap, not the state dir (cp -al needs one filesystem)", () => {
    expect(J.worktreePathFor("/repo", "demo")).toBe("/repo/.ap/worktrees/demo");
  });
  it("a path this platform could have created under the root is provenanced", () => {
    expect(J.worktreeProvenanced("/repo/.ap/worktrees/demo", "/repo")).toBe(true);
  });
  // The pane-ownership rule, applied to directories: `job stop` removes only what it can PROVE it
  // created. A hand-edited or carried-over record naming any other checkout is a defect to surface,
  // never a path to rm.
  it("anything else is NOT — including the worktrees dir itself and a sibling that merely shares the prefix", () => {
    expect(J.worktreeProvenanced("/repo/.ap/worktrees", "/repo")).toBe(false);
    expect(J.worktreeProvenanced("/repo/.ap/worktrees/", "/repo")).toBe(false);
    expect(J.worktreeProvenanced("/repo/.ap/worktrees-evil/demo", "/repo")).toBe(false);
    expect(J.worktreeProvenanced("/repo/.ap/state/demo", "/repo")).toBe(false);
    expect(J.worktreeProvenanced("/repo", "/repo")).toBe(false);
    expect(J.worktreeProvenanced("/elsewhere/.ap/worktrees/demo", "/repo")).toBe(false);
    expect(J.worktreeProvenanced("", "/repo")).toBe(false);
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

describe("sessionKillable — fail closed, on the LIVE nonce and not on the id", () => {
  const NONCE2 = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
  const recorded = new Map([["%1", NONCE], ["%2", NONCE2]]);
  it("true only when the session holds panes and EVERY one still carries the nonce we recorded", () => {
    expect(J.sessionKillable(["%1", "%2"], recorded, new Map([["%1", NONCE], ["%2", NONCE2], ["%3", "x"]]))).toBe(true);
  });
  it("a recycled id — live, but carrying a different nonce or none — refuses the kill", () => {
    expect(J.sessionKillable(["%1", "%2"], recorded, new Map([["%1", NONCE], ["%2", NONCE]]))).toBe(false);
    expect(J.sessionKillable(["%1"], recorded, new Map([["%1", ""]]))).toBe(false);   // a fresh server's %1
  });
  it("a pane the evidence never recorded refuses the kill, however live it is", () => {
    expect(J.sessionKillable(["%1", "%9"], recorded, new Map([["%1", NONCE], ["%9", "someone-elses"]]))).toBe(false);
  });
  it("an empty listing is 'nothing to kill', NOT 'safe to kill' (it also means tmux errored)", () => {
    expect(J.sessionKillable([], recorded, new Map([["%1", NONCE]]))).toBe(false);
    expect(J.sessionKillable([], new Map(), new Map())).toBe(false);
  });
  it("no recorded evidence at all refuses the kill", () => {
    expect(J.sessionKillable(["%1"], new Map(), new Map([["%1", NONCE]]))).toBe(false);
  });
  it("an empty LIVE snapshot (no tmux server) refuses the kill", () => {
    expect(J.sessionKillable(["%1"], recorded, new Map())).toBe(false);
  });
});

describe("mergePaneEvidence — a re-run can still finish an interrupted sweep", () => {
  it("the current snapshot wins per id, and what only the prior run proved survives", () => {
    expect(J.mergePaneEvidence({ "%1": "old", "%7": "gone-from-tmux" }, new Map([["%1", NONCE], ["%2", NONCE]])))
      .toEqual({ "%1": NONCE, "%2": NONCE, "%7": "gone-from-tmux" });
  });
  it("either side empty is the other side", () => {
    expect(J.mergePaneEvidence({}, new Map([["%1", NONCE]]))).toEqual({ "%1": NONCE });
    expect(J.mergePaneEvidence({ "%1": NONCE }, new Map())).toEqual({ "%1": NONCE });
    expect(J.mergePaneEvidence({}, new Map())).toEqual({});
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

describe("relaySnapshot — one read decides both the verdict and the offset it was taken at", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
  it("a question that is the newest event is parked", () => {
    const text = line({ event: "progress" }) + line({ event: "question", message: "which provider?" });
    expect(J.relaySnapshot(text).parked?.message).toBe("which provider?");
  });
  it("an ack or a terminal event after the question means it was already answered", () => {
    expect(J.relaySnapshot(line({ event: "question" }) + line({ event: "ack" })).parked).toBeNull();
    expect(J.relaySnapshot(line({ event: "question" }) + line({ event: "done" })).parked).toBeNull();
    expect(J.relaySnapshot(line({ event: "question" }) + line({ event: "ack" })).last?.event).toBe("ack");
  });
  it("the cursor is the BYTE size of the snapshot, multibyte text included", () => {
    const text = line({ event: "question", message: "café — ok?" });
    expect(J.relaySnapshot(text).cursor).toBe(Buffer.byteLength(text, "utf8"));
    expect(J.relaySnapshot(text).cursor).toBeGreaterThan(text.length);   // not the character count
  });
  it("an empty outbox parks nothing at offset zero", () => {
    expect(J.relaySnapshot("")).toEqual({ last: null, parked: null, cursor: 0 });
  });
  it("non-JSON noise between events is skipped, but still counts toward the offset", () => {
    const text = "starting up\n" + line({ event: "question" });
    expect(J.relaySnapshot(text).parked?.event).toBe("question");
    expect(J.relaySnapshot(text).cursor).toBe(Buffer.byteLength(text, "utf8"));
  });
});

describe("questionConsumed — closes the duplicate-relay loop", () => {
  it("a cursor at or past the outbox's size means the newest question was already answered", () => {
    expect(J.questionConsumed(196, 196)).toBe(true);
    expect(J.questionConsumed(196, 300)).toBe(true);   // the hub shrank/rotated its outbox
  });
  it("bytes beyond the cursor mean the question is genuinely new", () => {
    expect(J.questionConsumed(196, 115)).toBe(false);
    expect(J.questionConsumed(196, 0)).toBe(false);    // nothing relayed yet
  });
  it("an empty outbox is consumed by definition (there is nothing to answer)", () => {
    expect(J.questionConsumed(0, 0)).toBe(true);
  });
});

describe("launch-time gates", () => {
  // `pr` joined `keep` in 0.5.36: a PR is REVIEWABLE, so the code still reaches a human before it
  // reaches the base branch. merge and discard stay out — the run cross-verifies against the fork
  // base while main moves on, and nobody is watching what a discard destroys.
  it("keep and pr are the finish actions a detached run accepts; merge and discard never are", () => {
    expect(J.finishAllowedDetached("keep")).toBe(true);
    expect(J.finishAllowedDetached("pr")).toBe(true);
    expect(J.finishAllowedDetached("merge")).toBe(false);
    expect(J.finishAllowedDetached("discard")).toBe(false);
    expect(J.finishAllowedDetached("")).toBe(false);
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
  // The worktree path is the ONE thing the hub cannot derive: its own state stays keyed to the repo
  // root, so nothing it reads would ever point at the worker's target.
  it("names the worktree and the --target flag that re-homes the run", () => {
    expect(b).toContain("/repo/.ap/worktrees/demo");
    expect(b).toContain("ap implement init --target /repo/.ap/worktrees/demo");
    expect(b).toContain("never check out");
  });
  it("tells a quick hub to pass --target to BOTH init and branch", () => {
    const q = J.jobBrief({ ...REC, command: "quick", topic: "demo" });
    expect(q).toContain("ap quick init --target /repo/.ap/worktrees/demo");
    expect(q).toContain("ap quick branch --target /repo/.ap/worktrees/demo");
  });
  it("says nothing about a worktree for a --no-worktree run (or a pre-0.5.36 record)", () => {
    const none = J.jobBrief({ ...REC, worktree: "", base_sha: "" });
    expect(none).not.toContain("WORKTREE");
    expect(none).not.toContain("--target");
  });
  // A brief that promised "never push" under a `pr` run would have the hub fighting its own finish
  // verb, which is now the thing that ALLOWS the push.
  it("a --finish pr run is told to push and open a PR, and still never to merge", () => {
    const pr = J.jobBrief({ ...REC, finish: "pr" });
    expect(pr).toContain("push the branch and open a PR");
    expect(pr).toContain("NEVER merge");
    expect(pr).not.toContain("never merge, never push, never open a PR");
  });
});
