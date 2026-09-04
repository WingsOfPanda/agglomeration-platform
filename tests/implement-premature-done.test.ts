// tests/implement-premature-done.test.ts — the premature-`done` HOLD
// (docs/superpowers/specs/2026-09-04-parallel-slices-design.md, J; Success Criterion 5).
//
// The evidence run behind issue #217 parked twice because its worker emitted `done` after every
// plan task: the turn wait accepted the first one, `verify-report-1.md` did not exist yet, the turn
// classified `failed`, and the retry re-sent round 1 into a worker that was still implementing.
// These pins cover the hold that replaces that: a report-less `done` re-arms the wait, `PD=` lines
// record each hold, and the turn still ends — `ok` on the real `done`, `failed` on a pane that has
// stopped changing, `timeout` at the turn deadline.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { noSleepClock } from "./helpers/clock.js";
import { implementArtDir } from "../src/core/implement.js";
import { outboxPath, paneMetaPath, paneMetaWrite, TERMINAL_EVENTS, type Clock, type OutboxEvent } from "../src/core/ipc.js";
import type { WaitFn } from "../src/core/wait.js";
import { forensicsQueueDir } from "../src/core/paths.js";
import { holdPrematureDone, holdWaitOpts, liveRearm, paneIdleProbe, prematureDoneS, type HoldCtx, type RearmFn } from "../src/core/implementHold.js";
import { turnWaitWith, type ImplementWaitDeps } from "../src/commands/implement.js";

const TOPIC = "add-oauth";
const MODEL = "codex";

/** The art dir + a worker dir whose pane.json is VERIFIABLE (id plus ownership nonce) — the record
 *  the hold requires before it will hold anything. */
function seed(opts: { pane?: boolean } = {}): string {
  const art = implementArtDir(TOPIC);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "provider.txt"), MODEL + "\n");
  writeFileSync(join(art, "design.md"), "# design\n");
  const outbox = outboxPath("lead", MODEL, TOPIC);
  mkdirSync(dirname(outbox), { recursive: true });
  writeFileSync(outbox, '{"event":"done","summary":"task 1"}\n');
  if (opts.pane !== false) paneMetaWrite("lead", MODEL, TOPIC, "%7", "abc123");
  writeFileSync(join(art, "turn-lead-1.txt"), "OFFSET=0\n");
  return art;
}

const done = (summary: string): OutboxEvent => ({ event: "done", summary });

function waitDeps(over: Partial<ImplementWaitDeps> = {}): ImplementWaitDeps {
  return {
    wait: over.wait ?? (async () => done("premature")),
    clock: over.clock ?? noSleepClock,
    multiplier: over.multiplier ?? (() => "1"),
    now: over.now ?? (() => 1700000000),
    rearm: over.rearm,
  };
}

/** Every forensics record this run queued under the fresh AP_HOME (no `gh` is ever reached: with no
 *  consent file the gate queues instead of filing). */
function flags(): string[] {
  const dir = forensicsQueueDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(dir, f), "utf8"));
}
/** A re-arm that ENDS the turn `ok` (writes the report, returns the real `done`). The two
 *  no-hold gates below assert it was never called: a rearm that returned another report-less `done`
 *  would leave a gate mutation looping instead of failing an assertion. */
function finishingRearm(art: string, count: () => void): RearmFn {
  return async () => {
    count();
    writeFileSync(join(art, "verify-report-1.md"), "VERDICT: PASS\n");
    return done("real");
  };
}

const stateText = (art: string): string => readFileSync(join(art, "turn-lead-1.txt"), "utf8");

describe("implement turn-wait: the premature-done hold (spec J)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => {
    h.cleanup();
    delete process.env.AP_IMPLEMENT_PREMATURE_DONE_S;
    delete process.env.AP_IMPLEMENT_TURN_TIMEOUT_S;
  });

  it("held done -> a later done with the report present is TS=ok (SC5), with OFFSET=/PD= and ONE flag", async () => {
    const art = seed();
    const rearm: RearmFn = async () => {
      writeFileSync(join(art, "verify-report-1.md"), "VERDICT: PASS\n");   // the worker finished
      return done("real");
    };
    expect(await turnWaitWith(TOPIC, 1, waitDeps({ rearm }))).toBe(0);
    const txt = stateText(art);
    expect(txt).toContain("TS=ok\n");
    expect(txt).toContain("PD=1\n");
    // the hold's own OFFSET= line, appended AHEAD of the terminal line
    expect(txt.match(/^OFFSET=\d+$/gm)!.length).toBe(2);
    expect(txt.indexOf("PD=1")).toBeLessThan(txt.indexOf("TS=ok"));
    const f = flags();
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("premature-done: lead 1");
  });

  it("the re-arm is armed from the outbox size NOW, bounded by what is left of the turn budget", async () => {
    const art = seed();
    process.env.AP_IMPLEMENT_TURN_TIMEOUT_S = "600";
    const seen: number[] = [];
    const rearm: RearmFn = async (timeoutS) => {
      seen.push(timeoutS);
      writeFileSync(join(art, "verify-report-1.md"), "VERDICT: PASS\n");
      return done("real");
    };
    await turnWaitWith(TOPIC, 1, waitDeps({ rearm }));
    const size = readFileSync(outboxPath("lead", MODEL, TOPIC), "utf8").length;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThanOrEqual(600);
    // the offset the leg resumes from is this line — the live re-arm reads it back through awaitTurn
    expect(stateText(art)).toContain(`OFFSET=${size}\n`);
  });

  it("done then a pane that stopped changing -> TS=failed", async () => {
    const art = seed();
    const rearm: RearmFn = async () => ({ event: "error", note: "pane-idle" });
    await turnWaitWith(TOPIC, 1, waitDeps({ rearm }));
    expect(stateText(art)).toContain("TS=failed\n");
    expect(stateText(art)).toContain("PD=1\n");
  });

  it("a re-armed leg that expires is TS=timeout, and every leg is bounded by what is LEFT of the budget", async () => {
    const art = seed();
    process.env.AP_IMPLEMENT_TURN_TIMEOUT_S = "600";
    let t = 1_700_000_000_000;
    const clock: Clock = { now: () => t, sleep: async () => {} };
    const seen: number[] = [];
    // Each leg burns half of what it was given and comes back with another report-less `done`, so
    // the budgets can only halve if the hold re-derives them from the elapsed clock; the last leg
    // expires (null), which is the only way this turn reaches `timeout`.
    const rearm: RearmFn = async (timeoutS) => {
      seen.push(timeoutS);
      t += Math.floor(timeoutS / 2) * 1000;
      return seen.length < 3 ? done(`task ${seen.length}`) : null;
    };
    await turnWaitWith(TOPIC, 1, waitDeps({ clock, rearm }));
    expect(seen).toEqual([600, 300, 150]);
    const txt = stateText(art);
    expect(txt).toContain("PD=3\n");
    expect(txt).toContain("TS=timeout\n");
  });

  it("a deadline already spent when the wait returns is not held at all", async () => {
    const art = seed();
    process.env.AP_IMPLEMENT_TURN_TIMEOUT_S = "600";
    process.env.AP_TURN_CONFIRM_S = "0";        // the confirm layer returns the first event as-is
    let t = 1_700_000_000_000;
    const clock: Clock = { now: () => t, sleep: async () => {} };
    let rearms = 0;
    await turnWaitWith(TOPIC, 1, waitDeps({
      clock,
      wait: async () => { t += 601_000; return done("premature"); },   // the turn budget is gone
      rearm: finishingRearm(art, () => { rearms++; }),
    }));
    delete process.env.AP_TURN_CONFIRM_S;
    expect(rearms).toBe(0);
    expect(stateText(art)).toContain("TS=failed\n");
    expect(stateText(art)).not.toContain("PD=");
  });

  it("AP_IMPLEMENT_PREMATURE_DONE_S=0 restores today's TS=failed at once", async () => {
    const art = seed();
    process.env.AP_IMPLEMENT_PREMATURE_DONE_S = "0";
    let rearms = 0;
    await turnWaitWith(TOPIC, 1, waitDeps({ rearm: finishingRearm(art, () => { rearms++; }) }));
    expect(rearms).toBe(0);
    expect(stateText(art)).toContain("TS=failed\n");
    expect(stateText(art)).not.toContain("PD=");
    expect(flags()).toHaveLength(0);
  });

  it("an unverifiable pane (no pane.json) is TS=failed at once — unverifiable is not evidence", async () => {
    const art = seed({ pane: false });
    let rearms = 0;
    await turnWaitWith(TOPIC, 1, waitDeps({ rearm: finishingRearm(art, () => { rearms++; }) }));
    expect(rearms).toBe(0);
    expect(stateText(art)).toContain("TS=failed\n");
    expect(stateText(art)).not.toContain("PD=");
  });

  it("a pane.json with no ownership nonce is TS=failed at once, like an absent one", async () => {
    const art = seed();
    // the legacy record: an id, no `pane_nonce` — paneMetaRead reads it back as nonce "", which no
    // ownership check accepts, so the hold has no pane it may probe
    writeFileSync(paneMetaPath("lead", MODEL, TOPIC), JSON.stringify({ pane_id: "%7", agent: "lead", model: MODEL }) + "\n");
    let rearms = 0;
    await turnWaitWith(TOPIC, 1, waitDeps({ rearm: finishingRearm(art, () => { rearms++; }) }));
    expect(rearms).toBe(0);
    expect(stateText(art)).toContain("TS=failed\n");
    expect(stateText(art)).not.toContain("PD=");
  });

  it("a done whose report exists but is EMPTY is held — spec J's evidence is present AND non-empty", async () => {
    const art = seed();
    writeFileSync(join(art, "verify-report-1.md"), "");   // touched, not yet written
    let rearms = 0;
    await turnWaitWith(TOPIC, 1, waitDeps({ rearm: finishingRearm(art, () => { rearms++; }) }));
    expect(rearms).toBe(1);
    expect(stateText(art)).toContain("PD=1\n");
    expect(stateText(art)).toContain("TS=ok\n");
  });

  it("three holds in one turn: PD=1..3 and still exactly ONE flag", async () => {
    const art = seed();
    let n = 0;
    const rearm: RearmFn = async () => {
      if (++n < 3) return done(`task ${n}`);
      writeFileSync(join(art, "verify-report-1.md"), "VERDICT: PASS\n");
      return done("real");
    };
    await turnWaitWith(TOPIC, 1, waitDeps({ rearm }));
    const txt = stateText(art);
    expect(txt).toContain("PD=1\n");
    expect(txt).toContain("PD=2\n");
    expect(txt).toContain("PD=3\n");
    expect(txt).toContain("TS=ok\n");
    expect(flags()).toHaveLength(1);
  });

  it("a done whose report is already there is never held; nor is an error or a question", async () => {
    const art = seed();
    writeFileSync(join(art, "verify-report-1.md"), "VERDICT: PASS\n");
    let rearms = 0;
    const rearm: RearmFn = async () => { rearms++; return null; };
    await turnWaitWith(TOPIC, 1, waitDeps({ rearm }));
    expect(stateText(art)).toContain("TS=ok\n");
    expect(rearms).toBe(0);
    expect(flags()).toHaveLength(0);
  });
});

describe("the hold on a NAMED turn: one evidence path feeds both the hold and the classification", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); delete process.env.AP_IMPLEMENT_PREMATURE_DONE_S; });

  /** A plan the `plan` turn's own classifier accepts: two parseable tasks (spec B). */
  const twoTasks = "### T1: one\nfiles: src/a.ts\ndepends: none\n\n### T2: two\nfiles: src/b.ts\ndepends: none\n";
  const planState = (art: string): string => readFileSync(join(art, "turn-lead-plan.txt"), "utf8");

  it("the plan turn's `done` with plan.md PRESENT is ok and is never held (spec J)", async () => {
    const art = seed();
    writeFileSync(join(art, "turn-lead-plan.txt"), "OFFSET=0\n");
    writeFileSync(join(art, "plan.md"), twoTasks);
    const rearm: RearmFn = async () => { throw new Error("must not hold: plan.md IS this turn's completion evidence"); };
    expect(await turnWaitWith(TOPIC, "plan", waitDeps({ rearm }))).toBe(0);
    expect(planState(art)).toBe("OFFSET=0\nTS=ok\n");
  });

  it("the plan turn's `done` with plan.md ABSENT is HELD, and ends ok once the plan lands", async () => {
    const art = seed();
    writeFileSync(join(art, "turn-lead-plan.txt"), "OFFSET=0\n");
    const rearm: RearmFn = async () => { writeFileSync(join(art, "plan.md"), twoTasks); return done("real"); };
    expect(await turnWaitWith(TOPIC, "plan", waitDeps({ rearm }))).toBe(0);
    const txt = planState(art);
    expect(txt).toContain("PD=1\n");
    expect(txt).toContain("TS=ok\n");
    expect(txt.indexOf("PD=1")).toBeLessThan(txt.indexOf("TS=ok"));
  });
});

describe("holdPrematureDone (the loop, over injected deps)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function ctx(): { agent: string; model: string; topic: string; stateFile: string; round: number } {
    const art = implementArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
    const stateFile = join(art, "turn-lead-1.txt");
    writeFileSync(stateFile, "OFFSET=0\n");
    return { agent: "lead", model: MODEL, topic: TOPIC, stateFile, round: 1 };
  }

  it("returns a non-done event untouched and writes nothing", async () => {
    const c = ctx();
    const ev = { event: "question", message: "which?" };
    const notes: string[] = [];
    const out = await holdPrematureDone(ev, c, {
      evidencePath: join(dirname(c.stateFile), "verify-report-1.md"),
      deadlineMs: Date.now() + 600_000, now: () => Date.now(),
      rearm: async () => null, onFlag: (n) => notes.push(n),
    });
    expect(out).toBe(ev);
    expect(readFileSync(c.stateFile, "utf8")).toBe("OFFSET=0\n");
    expect(notes).toEqual([]);
  });

  it("stops at the deadline and returns the last event unchanged", async () => {
    const c = ctx();
    const ev = done("premature");
    const out = await holdPrematureDone(ev, c, {
      evidencePath: join(dirname(c.stateFile), "verify-report-1.md"),
      deadlineMs: 1000, now: () => 1000,
      rearm: async () => { throw new Error("must not re-arm past the deadline"); },
      onFlag: () => {},
    });
    expect(out).toBe(ev);
    expect(readFileSync(c.stateFile, "utf8")).not.toContain("PD=");
  });
});

describe("liveRearm — the wait a held turn re-arms on (spec J steps 2 and 4)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  const PANE = { paneId: "%7", nonce: "abc123" };
  const noProbe = async (): Promise<OutboxEvent | null> => null;

  /** A turn whose state file carries the hold's `OFFSET=` line and whose outbox holds `outbox`. */
  function ctx(outbox: string): HoldCtx {
    const art = implementArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
    const stateFile = join(art, "turn-lead-1.txt");
    writeFileSync(stateFile, "OFFSET=0\n");
    const p = outboxPath("lead", MODEL, TOPIC);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, outbox);
    return { agent: "lead", model: MODEL, topic: TOPIC, stateFile, round: 1 };
  }

  it("runs every leg on extendMult 1 with the pane-idle probe on the poll hook", () => {
    const o = holdWaitOpts(PANE, noProbe);
    // the turn deadline is the leg's ONLY bound: the default AP_WAIT_EXTEND_MULT=3 would stretch a
    // held leg to 12h, and the probe is the only thing that can end a hold before that deadline
    expect(o.extendMult).toBe(1);
    expect(o.onPoll).toBe(noProbe);
    expect(o.paneId).toBe(PANE.paneId);
    expect(typeof o.paneAlive).toBe("function");
  });

  it("relays a question that landed AFTER the report-less done on the same leg (J step 4)", async () => {
    // `lastMatch`'s frozen argument-order precedence returns the `done` here; going back through
    // awaitTurn re-derives the leg's terminal event in FILE order, so the worker's question is
    // relayed instead of the hold appending a new offset past it and holding again.
    const c = ctx('{"event":"done","summary":"task 2"}\n{"event":"question","message":"which db?"}\n');
    const ev = await liveRearm(c, { pane: PANE, probe: noProbe, clock: noSleepClock, onFlag: () => {} })(600);
    expect(ev).toMatchObject({ event: "question", message: "which db?" });
  });

  it("resumes from the state file's LATEST OFFSET= — the line the hold just appended", async () => {
    const c = ctx('{"event":"done","summary":"task 1"}\n');
    appendFileSync(c.stateFile, "OFFSET=34\nPD=1\n");
    const seen: unknown[][] = [];
    const wait: WaitFn = async (i, m, t, off, events, to) => { seen.push([i, m, t, off, events, to]); return null; };
    const ev = await liveRearm(c, { pane: PANE, probe: noProbe, clock: noSleepClock, onFlag: () => {}, wait })(450);
    expect(ev).toBeNull();
    expect(seen).toEqual([["lead", MODEL, TOPIC, 34, TERMINAL_EVENTS, 450]]);
  });
});

describe("paneIdleProbe", () => {
  const cap = (s: () => string) => async () => s();

  it("first call only records the baseline", async () => {
    let t = 0;
    const probe = paneIdleProbe({ capture: cap(() => "same"), now: () => t, idleS: 60 });
    expect(await probe()).toBeNull();
    t = 10_000_000;                       // far past the window, but only one sample so far
    expect(await probe()).not.toBeNull();  // the SECOND call is the one that can decide
  });

  it("an unchanged pane returns the in-process pane-idle event once the window has passed", async () => {
    let t = 0;
    const probe = paneIdleProbe({ capture: cap(() => "frozen"), now: () => t, idleS: 60 });
    await probe();
    t = 59_000;
    expect(await probe()).toBeNull();
    t = 60_000;
    const ev = await probe();
    expect(ev).toMatchObject({ event: "error", note: "pane-idle" });
    expect(ev!.ts).toBeTypeOf("string");
  });

  it("a pane that keeps changing never goes idle, and each change restarts the window", async () => {
    let t = 0, content = "a";
    const probe = paneIdleProbe({ capture: cap(() => content), now: () => t, idleS: 60 });
    await probe();
    t = 100_000; content = "b";
    expect(await probe()).toBeNull();      // changed: baseline moves to t
    t = 150_000;
    expect(await probe()).toBeNull();      // only 50s unchanged
    t = 160_000;
    expect(await probe()).not.toBeNull();
  });
});

describe("prematureDoneS", () => {
  afterEach(() => { delete process.env.AP_IMPLEMENT_PREMATURE_DONE_S; });

  it("defaults to 1800 when unset, empty, or non-numeric", () => {
    expect(prematureDoneS()).toBe(1800);
    process.env.AP_IMPLEMENT_PREMATURE_DONE_S = "  ";
    expect(prematureDoneS()).toBe(1800);
    process.env.AP_IMPLEMENT_PREMATURE_DONE_S = "soon";
    expect(prematureDoneS()).toBe(1800);
  });

  it("honours an explicit 0 (and any value <= 0) as DISABLED — not envNum's `|| def`", () => {
    process.env.AP_IMPLEMENT_PREMATURE_DONE_S = "0";
    expect(prematureDoneS()).toBe(0);
    process.env.AP_IMPLEMENT_PREMATURE_DONE_S = "-5";
    expect(prematureDoneS()).toBe(0);
  });

  it("takes a positive override as seconds", () => {
    process.env.AP_IMPLEMENT_PREMATURE_DONE_S = "45";
    expect(prematureDoneS()).toBe(45);
  });
});
