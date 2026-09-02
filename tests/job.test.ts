import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as J from "../src/core/job.js";
import type { OutboxEvent, PaneOwner } from "../src/core/ipc.js";

const NONCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";   // the shape randomUUID mints
const REC: J.JobRecord = {
  command: "implement", topic: "demo", session: "ap-demo",
  hub: { agent: "alpha", model: "claude" },
  provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
  args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
  worktree: "/repo/.ap/worktrees/demo", base_sha: "f00dcafe", start_branch: "main",
  origin_session: "ap-origin",
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
    expect(r.origin_session).toBe("");   // pre-0.5.43: no return address, and the hub skips its hint
    expect(r.topic).toBe("demo");     // and everything else is unchanged
    expect(r.finish).toBe("keep");
  });
  it("non-string worktree fields are read as absent rather than carried through", () => {
    const r = J.parseJob(JSON.stringify({ ...REC, worktree: 42, base_sha: null, start_branch: false, origin_session: 7 }))!;
    expect(r.worktree).toBe("");
    expect(r.base_sha).toBe("");
    expect(r.start_branch).toBe("");
    expect(r.origin_session).toBe("");
  });
  // The environment-parity keys are OMITTED when empty, never written as [] or "": formatJob is
  // JSON.stringify, so an always-present key would change every clean-box job.json on disk.
  it("python_shadow / python_pin / provisioned are absent from a clean-box record, in both directions", () => {
    const text = J.formatJob(REC);
    expect(text).not.toContain("python_shadow");
    expect(text).not.toContain("python_pin");
    expect(text).not.toContain("provisioned");
    const r = J.parseJob(JSON.stringify({ ...REC, python_shadow: [], python_pin: "", provisioned: [] }))!;
    expect(r).toEqual(REC);
    expect(Object.keys(r)).not.toContain("python_shadow");
    expect(Object.keys(r)).not.toContain("python_pin");
    expect(Object.keys(r)).not.toContain("provisioned");
  });
  it("round-trips them when present, and reads each as a string-only value", () => {
    const full: J.JobRecord = { ...REC, python_shadow: ["/home/op/.local/lib/python3.12/site-packages/x.pth:1"], python_pin: "/repo/.ap/worktrees/demo/src", provisioned: ["pkg/_ext.so"] };
    expect(J.parseJob(J.formatJob(full))).toEqual(full);
    expect(J.parseJob(JSON.stringify({ ...REC, python_shadow: "not-an-array" }))!.python_shadow).toBeUndefined();
    expect(J.parseJob(JSON.stringify({ ...REC, python_shadow: ["a", 3] }))!.python_shadow).toEqual(["a"]);
    expect(J.parseJob(JSON.stringify({ ...REC, python_shadow: [3] }))!.python_shadow).toBeUndefined();
    expect(J.parseJob(JSON.stringify({ ...REC, python_pin: 7 }))!.python_pin).toBeUndefined();
    expect(J.parseJob(JSON.stringify({ ...REC, provisioned: [null, "pkg/_ext.so"] }))!.provisioned).toEqual(["pkg/_ext.so"]);
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
  // docFromImplementArgs is the topic rule's other half: `job start`'s invisible-doc preflight needs
  // the PATH, not the slug it derives to. The two must stay one rule — a preflight that disagrees
  // with init about which token is the doc gates the wrong file.
  it("docFromImplementArgs returns the design-doc positional", () => {
    expect(J.docFromImplementArgs("docs/superpowers/specs/x-design.md")).toBe("docs/superpowers/specs/x-design.md");
    expect(J.docFromImplementArgs("  docs/x-design.md  ")).toBe("docs/x-design.md");
  });
  it("docFromImplementArgs skips flag TOKENS and takes the first bare .md", () => {
    expect(J.docFromImplementArgs("--provider codex docs/x-design.md")).toBe("docs/x-design.md");
    expect(J.docFromImplementArgs("-p docs/x-design.md")).toBe("docs/x-design.md");
    expect(J.docFromImplementArgs("docs/first.md docs/second.md")).toBe("docs/first.md");
    // A flag's VALUE is not skipped — the rule looks at leading `-` only. Deliberately unchanged:
    // this is byte-for-byte what `implement init` reads the doc by, and a preflight that disagreed
    // with init about which token is the doc would gate the wrong file.
    expect(J.docFromImplementArgs("--args-file notes.md docs/x-design.md")).toBe("notes.md");
  });
  it("docFromImplementArgs yields empty when nothing names a doc", () => {
    expect(J.docFromImplementArgs("--no-branch")).toBe("");
    expect(J.docFromImplementArgs("")).toBe("");
    expect(J.docFromImplementArgs("fix the bug in src/foo.ts")).toBe("");
  });
  it("--topic steers the TOPIC and leaves the doc alone — the preflight still gates the file", () => {
    expect(J.docFromImplementArgs("docs/x-design.md --topic chosen")).toBe("docs/x-design.md");
    expect(J.docFromImplementArgs("docs/x-design.md --topic=chosen")).toBe("docs/x-design.md");
    expect(J.topicFromImplementArgs("docs/x-design.md --topic chosen")).toBe("chosen");
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
  // The brief is job.json.provider's ONLY consumer, and it says the run parameters are settled.
  // The fallback contradicts that unless the brief names it — a detached hub told "NOT yours to
  // change" would otherwise park or refuse the switch its own directive just told it to make.
  it("carves the provider fallback out of the settled parameters", () => {
    expect(b).toContain("provider-fallback step");
    expect(b).toContain("without asking");
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
  // W1: what the worktree does NOT contain is a fact only this layer knows. A fork of committed HEAD
  // carries no build products, no untracked config and none of the operator's WIP, and a hub that
  // does not know that reads a missing file as a path to guess at.
  it("states that the worktree is a FRESH checkout of committed HEAD, and what did not come across", () => {
    expect(b).toContain("FRESH checkout of the committed HEAD");
    expect(b).toContain("no build products");
    expect(b).toContain("untracked `.env`");
    expect(b).toContain("node_modules");
    expect(b).toContain("treat a file you cannot find as absent");
  });
  it("says nothing about a worktree for a --no-worktree run (or a pre-0.5.36 record)", () => {
    const none = J.jobBrief({ ...REC, worktree: "", base_sha: "" });
    expect(none).not.toContain("WORKTREE");
    expect(none).not.toContain("--target");
    expect(none).not.toContain("FRESH checkout of the committed HEAD");
  });

  // Environment parity (2026-09-02 worktree-run-provisi design, A4/A6). #197's hub probed a
  // package-level import in the MAIN checkout and wrote "the .so is already built here" into the
  // brief; on a src-layout shadow the same probe with cwd in the worktree but no pin answers about
  // the main checkout too. The rule therefore carries the submodule, the cwd and the pin.
  describe("python environment parity", () => {
    /** The rendered probe line of a brief. */
    const probeOf = (brief: string) => brief.split("\n").find((l) => l.includes("python3 -c 'from pkg.ext import sym'"))!.trim();
    it("EVERY worktree brief carries the probe rule and the pip -e prohibition, for quick and implement", () => {
      for (const command of ["quick", "implement"] as const) {
        const t = J.jobBrief({ ...REC, command });
        expect(t).toContain("A package-level import proves nothing about its");
        expect(t).toContain("cd '/repo/.ap/worktrees/demo' && python3 -c 'from pkg.ext import sym'");
        expect(t).toContain("by its own path under the worktree");
        expect(t).toContain("serves a submodule the worktree lacks from the main tree");
        expect(t).toContain("Never run `pip install -e .`");
        expect(t).toContain("re-points the operator's");
        // A9's ceiling, in the brief: the teardown keep-check is best-effort, so the prohibition stays load-bearing.
        expect(t).toContain("best-effort");
        expect(t).toContain("load-bearing, not a backstop");
      }
    });
    it("and none of it in a --no-worktree brief", () => {
      const none = J.jobBrief({ ...REC, worktree: "", base_sha: "" });
      expect(none).not.toContain("python3 -c");
      expect(none).not.toContain("pip install -e");
      expect(none).not.toContain("PYTHON");
    });
    it("a clean record contains no PYTHONPATH at all, and the probe carries no prefix", () => {
      expect(b).not.toContain("PYTHONPATH");
      expect(b).toContain("cd '/repo/.ap/worktrees/demo' && python3 -c 'from pkg.ext import sym'");
    });
    it("a shadowed record names the source, the pasteable export, the pin INSIDE the probe, and both caveats", () => {
      const s = J.jobBrief({ ...REC, python_shadow: ["/home/op/.local/lib/python3.12/site-packages/x.pth:1"], python_pin: "/repo/.ap/worktrees/demo" });
      expect(s).toContain("    /home/op/.local/lib/python3.12/site-packages/x.pth:1");
      expect(s).toContain('export PYTHONPATH="/repo/.ap/worktrees/demo${PYTHONPATH:+:$PYTHONPATH}"');
      expect(s).toContain("cd '/repo/.ap/worktrees/demo' && PYTHONPATH='/repo/.ap/worktrees/demo' python3 -c 'from pkg.ext import sym'");
      expect(s).toContain("`sys.path[0]` is the SCRIPT's directory");
      expect(s).toContain("the pin does not buy everything");
      expect(s).toContain("serves a submodule the worktree lacks from the main tree");
      // it says what ap already pinned, and what a quick hub must prefix by hand — on the SAME command
      // line as the python it pins, because a Bash call is its own shell
      expect(s).toContain("`implement verify-tests`");
      expect(s).toContain("YOUR pane is not pinned");
      expect(s).toContain("TEST_CMD");
      expect(s).toContain("on the SAME command line (`<the export>; cd '<worktree>' && <command>`)");
      expect(s).toContain("an export in an earlier call never reaches the next one");
      // two sources -> two lines, each named
      const two = J.jobBrief({ ...REC, python_shadow: ["/a/x.pth:1", "/b/__editable___y_finder.py:9"], python_pin: "/repo/.ap/worktrees/demo/src" });
      expect(two).toContain("    /a/x.pth:1\n    /b/__editable___y_finder.py:9");
      expect(two).toContain("PYTHONPATH='/repo/.ap/worktrees/demo/src' python3 -c");
    });
    // The probe is rendered for a hub to PASTE: a space in the checkout path or the import root must
    // survive as one word (the pin filter rejects the quote itself, so single quotes are safe).
    it("the probe line is single-quoted, so a path with a space pastes and runs", () => {
      const wt = "/home/op/my repo/.ap/worktrees/demo";
      const s = J.jobBrief({ ...REC, worktree: wt, python_shadow: ["/x.pth:1"], python_pin: `${wt}/my src` });
      expect(s).toContain(`cd '${wt}' && PYTHONPATH='${wt}/my src' python3 -c 'from pkg.ext import sym'`);
    });
    it("a shadow ap could NOT pin (exec line, or an unsafe path) is still named, with the by-hand remedy and no export", () => {
      const s = J.jobBrief({ ...REC, python_shadow: ["/home/op/.local/lib/python3.12/site-packages/hook.pth:1"] });
      expect(s).toContain("    /home/op/.local/lib/python3.12/site-packages/hook.pth:1");
      expect(s).toContain("NOTHING is pinned");
      expect(s).toContain("pin by hand");
      // the refusal slot's message names no path on purpose; the remedy it defers to must name the worktree
      expect(s).toContain("re-rooted under /repo/.ap/worktrees/demo");
      // ...and BOTH variables the reader must set: PIN_BY_HAND for the pasteable probe (the slot keys on
      // it, so a reader who only exports PYTHONPATH still gets the refusal), PYTHONPATH for the pane/gates.
      expect(s.split("\n").filter((l) => l.includes("PIN_BY_HAND=") && !l.includes("python3 -c"))).toHaveLength(1);
      // ...and that the export rides the probe's OWN command line: a hub's Bash calls are separate
      // shells, so an `export` in an earlier call never reaches the pasted line — and a bare prefix
      // binds only to the `cd` that opens the line.
      expect(s).toContain('put `export PIN_BY_HAND="<that directory>";` in front of it on the SAME command line');
      // clause (b), the hub's own gate run, carries the same rule — a separate export call never reaches it
      expect(s).toContain("export it as PYTHONPATH, again on the SAME command line as");
      expect(s).toContain("(`export PYTHONPATH=\"<that directory>\"; cd '/repo/.ap/worktrees/demo' && <command>`)");
      // no pasteable export with a REAL pin: the pinExport spelling appears only when ap derived one
      expect(s).not.toContain("${PYTHONPATH:+:$PYTHONPATH}");
      // A found-but-unpinnable shadow is NOT a clean box: the bare probe would answer about the MAIN
      // checkout on a src-layout shadow (SC6), so the slot carries a `${PIN_BY_HAND:?msg}` expansion
      // that makes the shell refuse the whole line until a pin is exported, instead of the clean form.
      expect(s).not.toContain("cd '/repo/.ap/worktrees/demo' && python3 -c 'from pkg.ext import sym'");
      expect(probeOf(s)).toBe("cd '/repo/.ap/worktrees/demo' && PYTHONPATH=\"${PIN_BY_HAND:?this box shadows the repo and ap could not derive a pin - export PIN_BY_HAND to the shadowed directory re-rooted under the worktree first, see NOTHING is pinned below}\" python3 -c 'from pkg.ext import sym'");
      // the same for the #183 hand-rolled shape, and the correction it points at is present
      const h = J.jobBrief({ ...REC, python_shadow: ["/home/op/.local/lib/python3.12/site-packages/hand.pth:1"] });
      expect(h).not.toContain("&& python3 -c");
      expect(h).toContain('PYTHONPATH="${PIN_BY_HAND:?');
      expect(h).toContain("NOTHING is pinned");
    });
    // SC6 by EXECUTION, load-bearing on its own: pasted as-is the unpinnable probe refuses to run
    // python (the shell aborts on the unset parameter and creates nothing); with the pin exported it
    // runs with EXACTLY that PYTHONPATH. Its own `it`, so a mutant that survives the string compare
    // above — or a future weakening of that literal — still meets these assertions. Run for the plain
    // worktree and for one whose path carries every character that would break a double-quoted word:
    // the refusal message must interpolate nothing path-derived.
    it("the unpinnable probe REFUSES to run until PIN_BY_HAND is exported, then runs with exactly that pin (executed)", () => {
      const run = (wt: string, pin?: string) => {
        const line = probeOf(J.jobBrief({ ...REC, worktree: wt, python_shadow: ["/x.pth:1"] }));
        const runnable = line.replace(`cd '${wt}'`, "true").replace("python3 -c 'from pkg.ext import sym'", "sh -c 'echo RAN:$PYTHONPATH'");
        return spawnSync("bash", ["-c", runnable], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...(pin ? { PIN_BY_HAND: pin } : {}) } });
      };
      for (const wt of ["/repo/.ap/worktrees/demo", "/repo/a}b\"c$HOME`id`/.ap/worktrees/demo"]) {
        const bare = run(wt);
        expect(bare.status).not.toBe(0);
        expect(bare.stdout).not.toContain("RAN");
        expect(bare.stderr).toContain("PIN_BY_HAND");
        expect(bare.stderr).not.toContain("uid=");          // nothing in the message is command-substituted
        const pinned = run(wt, "/wt/src");
        expect(pinned.status).toBe(0);
        expect(pinned.stdout.trim()).toBe("RAN:/wt/src");
      }
      // The remedy's own instruction — its EXACT template, `export PIN_BY_HAND="<that directory>";`,
      // taken from the rendered brief and filled with a directory that has a space — in front of the
      // line on the SAME command line runs with that pin, untruncated; the two shapes the remedy warns
      // against do not: an export in a separate earlier shell (the shell-per-call hub), and a bare
      // `VAR=… ` prefix, which binds only to the `cd` that opens the line.
      const brief = J.jobBrief({ ...REC, python_shadow: ["/x.pth:1"] });
      const line = probeOf(brief)
        .replace("cd '/repo/.ap/worktrees/demo'", "true").replace("python3 -c 'from pkg.ext import sym'", "sh -c 'echo RAN:$PYTHONPATH'");
      const template = 'export PIN_BY_HAND="<that directory>";';
      expect(brief).toContain(`\`${template}\``);
      const sh = (cmd: string) => spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
      const sameLine = sh(`${template.replace("<that directory>", "/wt/my src")} ${line}`);
      expect(sameLine.status).toBe(0);
      expect(sameLine.stdout.trim()).toBe("RAN:/wt/my src");
      for (const wrong of [`bash -c 'export PIN_BY_HAND=/wt/src'; ${line}`, `PIN_BY_HAND=/wt/src ${line}`]) {
        const r = sh(wrong);
        expect(r.status).not.toBe(0);
        expect(r.stdout).not.toContain("RAN");
      }
    });
    // A6/A13: the run that gets bitten arms the repo for the next one — the only mechanism by which
    // `.ap-provision` ever gets written.
    it("with nothing provisioned the manifest is unchanged AND names .ap-provision as the durable fix", () => {
      expect(b).toContain("no build products");
      expect(b).toContain("rebuilt\nHERE with the repo's own build command");
      expect(b).toContain("`.ap-provision` at the repo root");
      expect(b).toContain("name that in your handoff");
      // PR A ships no reader for the file, so the clause must not claim one exists yet
      expect(b).toContain("once that support lands");
      expect(b).not.toContain("starts armed");
      expect(b).not.toContain("declared gitignored artifact");
    });
    it("with provisioned artifacts the manifest lists them, drops the 'no build products' claim, and says they were built from MAIN", () => {
      const p = J.jobBrief({ ...REC, provisioned: ["pkg/_ext.so", "pkg/_other.so"] });
      expect(p).toContain("2 declared gitignored artifacts copied from the main checkout:");
      expect(p).toContain("    pkg/_ext.so\n    pkg/_other.so");
      expect(p).toContain("built from MAIN sources at launch");
      expect(p).not.toContain("no build products");
      expect(p).toContain("FRESH checkout of the committed HEAD");
      expect(p).toContain("treat a file you cannot find as absent");
      expect(J.jobBrief({ ...REC, provisioned: ["pkg/_ext.so"] })).toContain("1 declared gitignored artifact copied");
    });
  });
  // The return address for the hub's completion hint. A run launched outside tmux has none, and the
  // line is still rendered empty — the hub reads the empty value as "send no hint", which is a
  // different instruction from a missing line it would have to interpret.
  it("names the origin session, and renders the line empty rather than dropping it", () => {
    expect(b).toContain("ORIGIN_SESSION=ap-origin");
    const none = J.jobBrief({ ...REC, origin_session: "" });
    expect(none).toContain("ORIGIN_SESSION=");
    expect(none).not.toContain("ORIGIN_SESSION=ap-origin");
    expect(J.jobBrief({ ...REC, origin_session: undefined })).toContain("ORIGIN_SESSION=");
  });

  // The finish line is a literal, not a rendering of the record: `--finish` was removed 2026-08-18,
  // so a record carrying any other action (hand-edited, or written by an older ap) still briefs the
  // hub with the one legal ending.
  it("always briefs the single legal ending, whatever the record says", () => {
    expect(J.jobBrief({ ...REC, finish: "pr" })).toContain("finish      keep — never merge, never push, never open a PR");
    expect(J.jobBrief({ ...REC, finish: "pr" })).not.toContain("open a PR. NEVER merge");
  });
});
