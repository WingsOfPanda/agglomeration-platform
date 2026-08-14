// tests/turn-confirm.test.ts — turn-wait terminal confirmation (2026-08-14 spec).
// The layer: a terminal event ends a turn only after the outbox goes quiet; continued activity
// vetoes the classification (bounded by a veto cap AND a deadline) and the wait re-arms through the
// injected wait; a question never waits at all; the verdict is the LATEST terminal in FILE order.
// AP_TURN_CONFIRM_S=0 restores 0.5.14 behavior byte-for-byte.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { outboxEventsSince, outboxOffset, outboxPath, type OutboxEvent } from "../src/core/ipc.js";
import { classifyTurn, turnConfirmS, waitTurnConfirmed, type TurnConfirmDeps } from "../src/core/turn.js";
import { globalRoot } from "../src/core/paths.js";

const I = "bravo", M = "codex", T = "auth";

function writeOutbox(lines: string[], i = I, m = M, t = T): string {
  const p = outboxPath(i, m, t);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => l + "\n").join(""));
  return p;
}
function appendOutbox(lines: string[], i = I, m = M, t = T): void {
  appendFileSync(outboxPath(i, m, t), lines.map((l) => l + "\n").join(""));
}
const DONE1 = '{"event":"done","summary":"premature"}';
const DONE2 = '{"event":"done","summary":"real"}';
const DONE3 = '{"event":"done","summary":"third"}';
const QUESTION = '{"event":"question","message":"which db?"}';
const PROGRESS = '{"event":"progress","note":"still working"}';
const ERROR2 = '{"event":"error","reason":"tests failed"}';
const doneEv = (summary: string): OutboxEvent => ({ event: "done", summary });

/** Injected window sleep: runs the next scripted outbox mutation on each call (and advances the
 *  virtual clock when one is supplied), so "the worker kept writing" is deterministic. */
function scriptedSleep(steps: Array<() => void>, clock?: { advance: (ms: number) => void }) {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => { calls.push(ms); clock?.advance(ms); steps.shift()?.(); },
  };
}

/** Injected wait: step 1 answers the first leg, later steps answer each re-arm round. Every call's
 *  offset+timeout is recorded, which is how the re-arm's routing through d.wait is pinned. */
function scriptedWait(steps: Array<{ ev?: OutboxEvent | null; run?: () => void }>) {
  const calls: Array<{ off: number; to: number }> = [];
  return {
    calls,
    wait: async (_i: string, _m: string, _t: string, off: number, _ev: string[], to: number) => {
      calls.push({ off, to });
      const step = steps.shift();
      step?.run?.();
      return step?.ev ?? null;
    },
  };
}

function fakeClock(t0 = 1_700_000_000_000) {
  let t = t0;
  return { t0, now: () => t, advance: (ms: number) => { t += ms; } };
}

/** Every hub-flag forensics file's text under the temp AP_HOME. */
function forensicsTexts(): string[] {
  const root = join(globalRoot(), "forensics");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const day of readdirSync(root)) {
    for (const f of readdirSync(join(root, day))) out.push(readFileSync(join(root, day, f), "utf8"));
  }
  return out;
}

describe("outboxEventsSince", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("returns every event in FILE order, skipping non-JSON lines", () => {
    writeOutbox([DONE1, "not json at all", PROGRESS, ERROR2]);
    expect(outboxEventsSince(I, M, T, 0).map((e) => e.event)).toEqual(["done", "progress", "error"]);
  });

  it("offset semantics: only the region at/after offset (a split first line is skipped)", () => {
    const body = DONE1 + "\n";
    writeOutbox([DONE1, DONE2]);
    expect(outboxEventsSince(I, M, T, Buffer.byteLength(body)).map((e) => e.summary)).toEqual(["real"]);
    expect(outboxEventsSince(I, M, T, 5).map((e) => e.summary)).toEqual(["real"]); // partial line dropped
  });

  it("shrink-safe: an offset past a truncated file re-reads from the start", () => {
    writeOutbox([DONE2]);
    expect(outboxEventsSince(I, M, T, 10_000).map((e) => e.summary)).toEqual(["real"]);
  });

  it("absent outbox → []", () => {
    expect(outboxEventsSince(I, M, "nope", 0)).toEqual([]);
  });
});

describe("turnConfirmS (AP_TURN_CONFIRM_S)", () => {
  afterEach(() => { delete process.env.AP_TURN_CONFIRM_S; });

  it("unset → 20; garbage → 20", () => {
    delete process.env.AP_TURN_CONFIRM_S;
    expect(turnConfirmS()).toBe(20);
    process.env.AP_TURN_CONFIRM_S = "soon";
    expect(turnConfirmS()).toBe(20);
  });

  it("explicit 0 (and negatives) DISABLE the layer — not the envNum fallback", () => {
    process.env.AP_TURN_CONFIRM_S = "0";
    expect(turnConfirmS()).toBe(0);
    process.env.AP_TURN_CONFIRM_S = "-5";
    expect(turnConfirmS()).toBe(0);
  });

  it("clamps a nonzero value to 5..120", () => {
    process.env.AP_TURN_CONFIRM_S = "4";
    expect(turnConfirmS()).toBe(5);
    process.env.AP_TURN_CONFIRM_S = "500";
    expect(turnConfirmS()).toBe(120);
  });
});

describe("waitTurnConfirmed", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); delete process.env.AP_TURN_CONFIRM_S; });

  /** Wrapper deps from a scripted wait + sleep, collecting every forensics note. */
  function deps(w: ReturnType<typeof scriptedWait>, s: ReturnType<typeof scriptedSleep>, flags: string[], clock?: { now: () => number }): TurnConfirmDeps {
    return { wait: w.wait, sleep: s.sleep, nowMs: clock?.now, onVeto: (note) => { flags.push(note); } };
  }

  it("timeout (wait → null) is passed through with no confirmation work", async () => {
    const w = scriptedWait([{ ev: null }]), s = scriptedSleep([]), flags: string[] = [];
    expect(await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, flags))).toBeNull();
    expect(s.calls).toEqual([]);
    expect(w.calls.length).toBe(1);
    expect(flags).toEqual([]);
  });

  it("quiet window → the terminal event is accepted, classification unchanged", async () => {
    writeOutbox([DONE1]);
    const w = scriptedWait([{ ev: doneEv("premature") }]), s = scriptedSleep([]), flags: string[] = [];
    const ev = await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, flags));
    expect(classifyTurn(ev)).toBe("ok");
    expect(ev!.summary).toBe("premature");
    expect(s.calls).toEqual([20_000]); // exactly one window, at the default grace
    expect(w.calls.length).toBe(1);    // no re-arm
    expect(flags).toEqual([]);
  });

  it("no outbox bytes in the region → the wait's own event is returned unchanged", async () => {
    const first = doneEv("premature");
    const w = scriptedWait([{ ev: first }]), s = scriptedSleep([]), flags: string[] = [];
    expect(await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, flags))).toBe(first);
  });

  it("done-then-error already in the region → the LATER error wins (file order)", async () => {
    writeOutbox([DONE1, ERROR2]);
    const w = scriptedWait([{ ev: doneEv("premature") }]), s = scriptedSleep([]), flags: string[] = [];
    const ev = await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, flags));
    expect(classifyTurn(ev)).toBe("failed");
    expect(flags).toEqual([]); // a quiet outbox is not a veto
  });

  it("AP_TURN_CONFIRM_S=0 → the wait's first event, byte-identical 0.5.14 (no sleeps, no reads)", async () => {
    process.env.AP_TURN_CONFIRM_S = "0";
    writeOutbox([DONE1, ERROR2]); // the file-order rule would say error; disabled, done still wins
    const first = doneEv("premature");
    const w = scriptedWait([{ ev: first }]), s = scriptedSleep([]), flags: string[] = [];
    const ev = await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, flags));
    expect(ev).toBe(first);            // same object: nothing was re-read
    expect(classifyTurn(ev)).toBe("ok");
    expect(s.calls).toEqual([]);
    expect(w.calls.length).toBe(1);
    expect(flags).toEqual([]);
  });

  it("premature done + continued activity → veto flagged (by PROVIDER), re-arm classifies the REAL done", async () => {
    writeOutbox([DONE1]);
    const s = scriptedSleep([() => appendOutbox([PROGRESS, DONE2])]);
    const w = scriptedWait([{ ev: doneEv("premature") }, { ev: doneEv("real") }]);
    const flags: string[] = [];
    const ev = await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, flags));
    expect(classifyTurn(ev)).toBe("ok");
    expect(ev!.summary).toBe("real");
    expect(flags).toEqual(["turn-confirm-veto: codex premature done — outbox still active"]);
    expect(s.calls).toEqual([20_000, 20_000]); // vetoed window + the confirming one
  });

  it("the re-arm runs THROUGH the injected wait (pane-liveness), from the window's offset", async () => {
    const body = DONE1 + "\n";
    writeOutbox([DONE1]);
    const s = scriptedSleep([() => appendOutbox([PROGRESS, DONE2])]);
    const w = scriptedWait([{ ev: doneEv("premature") }, { ev: doneEv("real") }]);
    await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, []));
    expect(w.calls[0]).toEqual({ off: 0, to: 600 });                              // first leg unchanged
    expect(w.calls[1]).toEqual({ off: Buffer.byteLength(body), to: 20 });         // past the armed event, one window long
  });

  it("a synthetic pane-died error from the re-arm (never in the file) becomes the verdict → failed", async () => {
    writeOutbox([DONE1]);
    const s = scriptedSleep([() => appendOutbox([PROGRESS])]);
    const w = scriptedWait([{ ev: doneEv("premature") }, { ev: { event: "error", note: "pane-died" } }]);
    const ev = await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, []));
    expect(classifyTurn(ev)).toBe("failed");
    expect(ev!.note).toBe("pane-died");
  });

  it("premature done + continued activity ending in error → failed", async () => {
    writeOutbox([DONE1]);
    const s = scriptedSleep([() => appendOutbox([PROGRESS, ERROR2])]);
    const w = scriptedWait([{ ev: doneEv("premature") }, { ev: { event: "error", reason: "tests failed" } }]);
    const flags: string[] = [];
    const ev = await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, flags));
    expect(classifyTurn(ev)).toBe("failed");
    expect(flags.length).toBe(1);
  });

  it("BLOCKER: a real done + one trailing progress accepts promptly (no waiting out the budget)", async () => {
    writeOutbox([DONE1]);
    const s = scriptedSleep([() => appendOutbox([PROGRESS])]);   // one trailing line, then silence
    const w = scriptedWait([{ ev: doneEv("premature") }]);       // the re-arm finds nothing
    const flags: string[] = [];
    const ev = await waitTurnConfirmed(I, M, T, 0, 14_400, deps(w, s, flags));
    expect(classifyTurn(ev)).toBe("ok");
    expect(ev!.summary).toBe("premature");
    expect(w.calls.length).toBe(2);        // first leg + exactly ONE short re-arm wait
    expect(s.calls).toEqual([20_000]);     // and one window; nothing polls out the 4h budget
    expect(flags).toEqual(["turn-confirm-veto: codex premature done — outbox still active"]);
  });

  it("BLOCKER: a question is never confirmed — returns at once even with trailing bytes", async () => {
    writeOutbox([QUESTION, PROGRESS]);
    const w = scriptedWait([{ ev: { event: "question", message: "which db?" } }]);
    const s = scriptedSleep([]), flags: string[] = [];
    const ev = await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, flags));
    expect(classifyTurn(ev)).toBe("question");
    expect(ev!.message).toBe("which db?");
    expect(s.calls).toEqual([]);      // no window at all: the hub must be free to relay the answer
    expect(w.calls.length).toBe(1);
    expect(flags).toEqual([]);
  });

  it("done-then-question and error-then-question resolve to the QUESTION (the worker's last word)", async () => {
    writeOutbox([DONE1, QUESTION]);
    const w1 = scriptedWait([{ ev: doneEv("premature") }]), s1 = scriptedSleep([]);
    expect(classifyTurn(await waitTurnConfirmed(I, M, T, 0, 600, deps(w1, s1, [])))).toBe("question");

    writeOutbox([ERROR2, QUESTION]);
    const w2 = scriptedWait([{ ev: { event: "error", reason: "tests failed" } }]), s2 = scriptedSleep([]);
    expect(classifyTurn(await waitTurnConfirmed(I, M, T, 0, 600, deps(w2, s2, [])))).toBe("question");
  });

  it("question-then-done → done (unchanged from 0.5.14's argument-order pick)", async () => {
    writeOutbox([QUESTION, DONE2]);
    const w = scriptedWait([{ ev: { event: "question", message: "which db?" } }]), s = scriptedSleep([]);
    const ev = await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, []));
    expect(classifyTurn(ev)).toBe("ok");
    expect(ev!.summary).toBe("real");
  });

  it("veto cap: a worker writing through every window is accepted after MAX_VETOES, with a cap flag", async () => {
    writeOutbox([DONE1]);
    const s = scriptedSleep([
      () => appendOutbox([PROGRESS]),
      () => appendOutbox([PROGRESS]),
      () => appendOutbox([PROGRESS]),   // third burst: the cap is spent, accept what is armed
    ]);
    const w = scriptedWait([
      { ev: doneEv("premature") },
      { ev: doneEv("real"), run: () => appendOutbox([DONE2]) },
      { ev: doneEv("third"), run: () => appendOutbox([DONE3]) },
    ]);
    const flags: string[] = [];
    const ev = await waitTurnConfirmed(I, M, T, 0, 600, deps(w, s, flags));
    expect(ev!.summary).toBe("third");
    expect(flags).toEqual([
      "turn-confirm-veto: codex premature done — outbox still active",
      "turn-confirm-veto: codex premature done — outbox still active",
      "turn-confirm-cap: codex still writing after 3 windows — accepting done",
    ]);
    expect(s.calls.length).toBe(3);   // bounded BY ASSERTION: MAX_VETOES+1 windows, then out
    expect(w.calls.length).toBe(3);
  });

  it("deadline: a chatty worker with no new terminal is accepted at the deadline, with its own flag", async () => {
    writeOutbox([DONE1]);
    const clock = fakeClock();
    const s = scriptedSleep([() => appendOutbox([PROGRESS])], clock);
    let calls = 0;
    const wait = async () => {
      calls++;
      if (calls === 1) return doneEv("premature");        // first leg, no time consumed
      clock.advance(20_000); appendOutbox([PROGRESS]);    // each re-arm round: chatty, no terminal
      return null;
    };
    const flags: string[] = [];
    // base deadline t0+100s; floor is legEnd+3 windows = t0+60s -> the base wins.
    const ev = await waitTurnConfirmed(I, M, T, 0, 100, { wait, sleep: s.sleep, nowMs: clock.now, onVeto: (n) => flags.push(n) });
    expect(ev!.summary).toBe("premature");
    expect(calls).toBe(5);   // first leg + 4 re-arm rounds (20s window + 4x20s = 100s)
    expect(flags).toEqual([
      "turn-confirm-veto: codex premature done — outbox still active",
      "turn-confirm-deadline: codex re-arm expired — accepting done",
    ]);
  });

  it("a liveness-extended first leg still gets a real confirmation (deadline floors past the leg's end)", async () => {
    writeOutbox([DONE1]);
    const clock = fakeClock();
    const s = scriptedSleep([() => appendOutbox([PROGRESS])], clock);
    let calls = 0;
    const wait = async () => {
      calls++;
      if (calls === 1) { clock.advance(100_000); return doneEv("premature"); }  // leg blew the 10s budget
      if (calls === 2) { clock.advance(20_000); appendOutbox([PROGRESS]); return null; }
      appendOutbox([DONE2]); return doneEv("real");
    };
    const flags: string[] = [];
    const ev = await waitTurnConfirmed(I, M, T, 0, 10, { wait, sleep: s.sleep, nowMs: clock.now, onVeto: (n) => flags.push(n) });
    expect(ev!.summary).toBe("real");           // the re-arm ran instead of expiring on arrival
    expect(flags).toEqual(["turn-confirm-veto: codex premature done — outbox still active"]);
  });
});

// ---- verb wiring: each verb must route its wait through the wrapper (mutation-resistant) ----
import { turnWaitWith as quickTurnWait } from "../src/commands/quick.js";
import { roundWaitWith as bridgeRoundWait } from "../src/commands/bridge.js";
import { turnWaitWith as implementTurnWait } from "../src/commands/implement.js";
import { quickArtDir, quickExecDir } from "../src/core/quick.js";
import { bridgeArtDir, bridgeExecDir } from "../src/core/bridge.js";
import { implementArtDir } from "../src/core/implement.js";

const noSleep = async () => {};
const premature = async () => doneEv("premature");

/** The two-round script every veto pin uses: the window grows, the re-arm finds the real done. */
function vetoScript(agent: string) {
  return {
    sleepDep: scriptedSleep([() => appendOutbox([PROGRESS, DONE2], agent)]),
    waitDep: scriptedWait([{ ev: doneEv("premature") }, { ev: doneEv("real") }]),
  };
}

describe("turn-wait verbs are wired to the confirmation layer", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function seedQuick(): void {
    mkdirSync(quickExecDir(T), { recursive: true });
    writeFileSync(join(quickArtDir(T), "agent.txt"), "bravo\n");
    writeFileSync(join(quickArtDir(T), "selected-provider.txt"), "codex\n");
    writeFileSync(join(quickExecDir(T), "turn-1.txt"), "OFFSET=0\n");
  }
  function seedBridge(): void {
    mkdirSync(bridgeExecDir(T), { recursive: true });
    writeFileSync(join(bridgeArtDir(T), "agent.txt"), "alpha\n");
    writeFileSync(join(bridgeArtDir(T), "selected-provider.txt"), "codex\n");
    writeFileSync(join(bridgeExecDir(T), "round-1.txt"), "OFFSET=0\n");
  }
  function seedImplement(): string {
    const art = implementArtDir(T);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "provider.txt"), "codex\n");
    writeFileSync(join(art, "verify-report-1.md"), "VERDICT: PASS\n");   // done alone would be TS=ok
    writeFileSync(join(art, "turn-lead-1.txt"), "OFFSET=0\n");
    return art;
  }
  function vetoFlags(): string[] {
    return forensicsTexts().filter((x) => x.includes("turn-confirm-veto"));
  }

  it("quick turn-wait: a LATER error in the outbox overrides the wait's done → TS=failed", async () => {
    seedQuick();
    writeOutbox([DONE1, ERROR2]);
    expect(await quickTurnWait(T, 1, { wait: premature, sleep: noSleep })).toBe(0);
    expect(readFileSync(join(quickExecDir(T), "turn-1.txt"), "utf8")).toContain("TS=failed");
  });

  it("quick turn-wait: a veto records a turn-confirm-veto flag and waits for the real end", async () => {
    seedQuick();
    writeOutbox([DONE1]);
    const { sleepDep, waitDep } = vetoScript("bravo");
    expect(await quickTurnWait(T, 1, { wait: waitDep.wait, sleep: sleepDep.sleep })).toBe(0);
    expect(readFileSync(join(quickExecDir(T), "turn-1.txt"), "utf8")).toContain("TS=ok");
    const flags = vetoFlags();
    expect(flags.length).toBe(1);
    expect(flags[0]).toContain("turn-confirm-veto: codex premature done");
    expect(flags[0]).toContain("command=quick");
    expect(flags[0]).toContain(`topic: ${T}`);
  });

  it("bridge round-wait: a LATER error in the outbox overrides the wait's done → TS=failed", async () => {
    seedBridge();
    writeOutbox([DONE1, ERROR2], "alpha");
    expect(await bridgeRoundWait(T, 1, { wait: premature, sleep: noSleep })).toBe(0);
    expect(readFileSync(join(bridgeExecDir(T), "round-1.txt"), "utf8")).toContain("TS=failed");
  });

  it("bridge round-wait: a veto records a turn-confirm-veto flag", async () => {
    seedBridge();
    writeOutbox([DONE1], "alpha");
    const { sleepDep, waitDep } = vetoScript("alpha");
    expect(await bridgeRoundWait(T, 1, { wait: waitDep.wait, sleep: sleepDep.sleep })).toBe(0);
    expect(readFileSync(join(bridgeExecDir(T), "round-1.txt"), "utf8")).toContain("TS=ok");
    const flags = vetoFlags();
    expect(flags.length).toBe(1);
    expect(flags[0]).toContain("command=bridge");
    expect(flags[0]).toContain(`topic: ${T}`);
  });

  it("implement turn-wait: a LATER error overrides a done whose verify report passed → TS=failed", async () => {
    const art = seedImplement();
    writeOutbox([DONE1, ERROR2], "lead");
    const rc = await implementTurnWait(T, 1, {
      wait: premature, sleep: noSleep, multiplier: () => "1", now: () => 1700000000,
    });
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "turn-lead-1.txt"), "utf8")).toContain("TS=failed");
  });

  it("implement turn-wait: a veto records a turn-confirm-veto flag", async () => {
    const art = seedImplement();
    writeOutbox([DONE1], "lead");
    const { sleepDep, waitDep } = vetoScript("lead");
    const rc = await implementTurnWait(T, 1, {
      wait: waitDep.wait, sleep: sleepDep.sleep, multiplier: () => "1", now: () => 1700000000,
    });
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "turn-lead-1.txt"), "utf8")).toContain("TS=ok");
    const flags = vetoFlags();
    expect(flags.length).toBe(1);
    expect(flags[0]).toContain("command=implement");
    expect(flags[0]).toContain(`topic: ${T}`);
  });
});

// ---- E2E through the built dist: the field shape, real sleeps, real outbox ----
import { spawn } from "node:child_process";

describe("E2E: quick turn-wait through dist/ap.cjs (requires npm run build first)", () => {
  let h: { home: string; cleanup: () => void };
  const CLI = join(process.cwd(), "dist", "ap.cjs");

  beforeAll(() => {
    const bundle = readFileSync(CLI, "utf8");
    if (!bundle.includes("AP_TURN_CONFIRM_S")) {
      throw new Error("dist/ap.cjs predates the turn-confirmation layer — run `npm run build` first");
    }
  });
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("replays the codex shape (premature done → progress → real done): one veto, TS=ok exactly once", async () => {
    mkdirSync(quickExecDir(T), { recursive: true });
    writeFileSync(join(quickArtDir(T), "agent.txt"), "bravo\n");
    writeFileSync(join(quickArtDir(T), "selected-provider.txt"), "codex\n");
    writeFileSync(join(quickExecDir(T), "turn-1.txt"), "OFFSET=0\n");
    writeOutbox([DONE1]);                       // the premature terminal is already there
    const child = spawn("node", [CLI, "quick", "turn-wait", T, "1"], {
      env: { ...process.env, AP_HOME: h.home, AP_TURN_CONFIRM_S: "5", AP_QUICK_TURN_TIMEOUT: "120" },
    });
    // Anchor the bursts on the child's own "wait started" line, not on wall-clock guesswork: the
    // worker must keep writing INSIDE the confirmation window for the veto to be the thing tested.
    const timers: ReturnType<typeof setTimeout>[] = [];
    let stderr = "", armed = false;
    child.stderr.on("data", (b: Buffer) => {
      stderr += String(b);
      if (armed || !/quick turn-wait: round=1/.test(stderr)) return;
      armed = true;
      timers.push(setTimeout(() => appendOutbox([PROGRESS]), 1000));
      timers.push(setTimeout(() => appendOutbox(['{"event":"progress","note":"3 commits"}']), 2000));
      timers.push(setTimeout(() => appendOutbox([DONE2]), 3000));
    });
    const code = await new Promise<number>((res) => { child.on("close", (c) => res(c ?? -1)); });
    for (const t of timers) clearTimeout(t);
    expect(armed).toBe(true);
    expect(code).toBe(0);
    expect(stderr).toContain("TS=ok");
    const state = readFileSync(join(quickExecDir(T), "turn-1.txt"), "utf8");
    expect(state.match(/^TS=/gm)!.length).toBe(1);
    expect(state).toContain("TS=ok");
    expect(outboxOffset(outboxPath(I, M, T))).toBeGreaterThan(0);
    const flags = forensicsTexts().filter((x) => x.includes("turn-confirm-veto"));
    expect(flags.length).toBe(1);
    expect(flags[0]).toContain("command=quick");
  }, 60_000);
});
