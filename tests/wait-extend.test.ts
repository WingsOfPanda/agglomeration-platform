import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { virtualClock } from "./helpers/clock.js";
import { outboxWaitSince, outboxPath } from "../src/core/ipc.js";
import { globalRoot } from "../src/core/paths.js";
import { awaitTurn } from "../src/core/wait.js";
import { liveOutboxWait } from "../src/core/waitLive.js";
import { gateAnomalies } from "../src/core/designTurn.js";

function mkOutbox(i: string, m: string, t: string): string {
  const p = outboxPath(i, m, t);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "");
  return p;
}

describe("outboxWaitSince liveness extension", () => {
  it("legacy: no liveness opts -> null at the base budget (no extension)", async () => {
    const { cleanup } = freshHome();
    try {
      mkOutbox("a", "codex", "t");
      const t0 = Date.now();
      expect(await outboxWaitSince("a", "codex", "t", 0, ["done"], 1)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2500);
    } finally { cleanup(); }
  });

  it("extension: pane alive past the budget -> a late event is still captured", async () => {
    const { cleanup } = freshHome();
    try {
      const p = mkOutbox("a", "codex", "t");
      setTimeout(() => appendFileSync(p, '{"event":"done","summary":"late"}\n'), 2300);
      const ev = await outboxWaitSince("a", "codex", "t", 0, ["done"], 1,
        { paneAlive: async () => true, paneId: "%1", everyS: 1, extendMult: 6 });
      expect(ev?.event).toBe("done");
      expect(ev?.summary).toBe("late");
    } finally { cleanup(); }
  });

  it("hard cap: pane alive but no event -> null at extendMult x budget", async () => {
    const { cleanup } = freshHome();
    try {
      mkOutbox("a", "codex", "t");
      const t0 = Date.now();
      const ev = await outboxWaitSince("a", "codex", "t", 0, ["done"], 1,
        { paneAlive: async () => true, paneId: "%1", everyS: 1, extendMult: 2 });
      expect(ev).toBeNull();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(1900);
      expect(elapsed).toBeLessThan(4500);
    } finally { cleanup(); }
  });

  it("pane death during the extension -> synthetic pane-died error, not a full-cap block", async () => {
    const { cleanup } = freshHome();
    try {
      mkOutbox("a", "codex", "t");
      let calls = 0;
      const ev = await outboxWaitSince("a", "codex", "t", 0, ["done"], 1,
        { paneAlive: async () => ++calls < 2, paneId: "%1", everyS: 1, extendMult: 30 });
      expect(ev?.event).toBe("error");
      expect(ev?.note).toBe("pane-died");
    } finally { cleanup(); }
  });

  it("extendMult=1 keeps the hard stop even with liveness opts (the documented off-switch)", async () => {
    const { cleanup } = freshHome();
    try {
      mkOutbox("a", "codex", "t");
      const t0 = Date.now();
      const ev = await outboxWaitSince("a", "codex", "t", 0, ["done"], 1,
        { paneAlive: async () => true, paneId: "%1", everyS: 1, extendMult: 1 });
      expect(ev).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2500);
    } finally { cleanup(); }
  });
});

// The same extension math on a VIRTUAL clock: the engine's poll now reads an injected time source,
// so these run the REAL matcher over a real temp outbox at CPU speed and assert the budget EXACTLY
// (`elapsed()` in virtual ms) instead of bracketing real wall time. The real-timer block above
// stays: it is the only thing that proves the DEFAULT clock actually sleeps — a `realClock.sleep`
// that resolved immediately would spin every wait at 100% CPU and still pass everything here.
describe("outboxWaitSince on a virtual clock", () => {
  const LIVE = { paneAlive: async () => true, paneId: "%1", everyS: 1 };

  it("legacy: no liveness opts -> null at exactly the base budget", async () => {
    const { cleanup } = freshHome();
    try {
      mkOutbox("a", "codex", "t");
      const v = virtualClock();
      expect(await outboxWaitSince("a", "codex", "t", 0, ["done"], 5, undefined, v.clock)).toBeNull();
      expect(v.elapsed()).toBe(5_000);
    } finally { cleanup(); }
  });

  it("extension: an event landing past the base budget is captured at the moment it lands", async () => {
    const { cleanup } = freshHome();
    try {
      const p = mkOutbox("a", "codex", "t");
      const v = virtualClock();
      v.at(8_000, () => appendFileSync(p, '{"event":"done","summary":"late"}\n'));
      const ev = await outboxWaitSince("a", "codex", "t", 0, ["done"], 5, { ...LIVE, extendMult: 3 }, v.clock);
      expect(ev?.summary).toBe("late");
      expect(v.elapsed()).toBe(8_000);   // past the 5s budget, inside the 15s extended cap
    } finally { cleanup(); }
  });

  it("hard cap: pane alive but no event -> null at exactly extendMult x budget", async () => {
    const { cleanup } = freshHome();
    try {
      mkOutbox("a", "codex", "t");
      const v = virtualClock();
      expect(await outboxWaitSince("a", "codex", "t", 0, ["done"], 5, { ...LIVE, extendMult: 2 }, v.clock)).toBeNull();
      expect(v.elapsed()).toBe(10_000);
    } finally { cleanup(); }
  });

  it("pane death during the extension -> synthetic pane-died error on the second dead poll", async () => {
    const { cleanup } = freshHome();
    try {
      mkOutbox("a", "codex", "t");
      const v = virtualClock();
      let calls = 0;
      const ev = await outboxWaitSince("a", "codex", "t", 0, ["done"], 5,
        { paneAlive: async () => ++calls < 2, paneId: "%1", everyS: 1, extendMult: 30 }, v.clock);
      expect(ev?.note).toBe("pane-died");
      expect(v.elapsed()).toBe(3_000);   // probes at 1s, 2s, 3s: alive, dead, dead
    } finally { cleanup(); }
  });
});

// The interaction the old seam made unobservable. `AP_WAIT_EXTEND_MULT` is applied inside the
// engine while the re-arm deadline is computed one layer up, and with the wait mocked away no test
// could see one act on the other. On one clock, both are visible at once.
describe("AP_WAIT_EXTEND_MULT x the confirmation deadline floor", () => {
  const I = "bravo", M = "codex", T = "auth";

  it("a liveness-extended first leg still gets a real confirmation (the floor leaves room)", async () => {
    const { cleanup } = freshHome();
    process.env.AP_TURN_CONFIRM_S = "5";
    try {
      const p = mkOutbox(I, M, T);
      const stateFile = join(globalRoot(), "turn-1.txt");
      writeFileSync(stateFile, "OFFSET=0\n");
      const v = virtualClock();
      // The worker's first `done` lands at 8s — past the 5s budget, inside the 3x extension —
      // then it keeps writing through the confirmation window and emits its REAL done at 14s.
      v.at(8_000, () => appendFileSync(p, '{"event":"done","summary":"premature"}\n'));
      v.at(11_000, () => appendFileSync(p, '{"event":"progress","note":"still working"}\n'));
      v.at(14_000, () => appendFileSync(p, '{"event":"done","summary":"real"}\n'));

      const flags: string[] = [];
      const r = await awaitTurn(
        { agent: I, model: M, topic: T, stateFile, timeoutS: 5, label: "quick turn-wait", policy: { confirm: true } },
        {
          // the REAL engine, with a test pane probe instead of tmux, on the same clock
          wait: (i, m, t, off, ev, to) => outboxWaitSince(i, m, t, off, ev, to,
            { paneAlive: async () => true, paneId: "%1", everyS: 1, extendMult: 3 }, v.clock),
          clock: v.clock,
          onFlag: (note) => { flags.push(note); },
        });

      expect("missingOffset" in r).toBe(false);
      expect((r as { event: { summary?: string } | null }).event!.summary).toBe("real");
      // The base deadline (start + 5s) was ALREADY SPENT when the first leg returned at 8s; only
      // the legEnd + 3-window floor keeps the re-arm alive, so a deadline flag here would mean the
      // layer gave up on the confirmation it had just flagged a veto for.
      expect(flags).toEqual(["turn-confirm-veto: codex premature done — outbox still active"]);
      expect(v.elapsed()).toBe(19_000);   // 8s leg + 5s window + re-arm to 14s + one quiet window
    } finally { delete process.env.AP_TURN_CONFIRM_S; cleanup(); }
  });
});

describe("gateAnomalies", () => {
  const w = (agent: string, doneExists: boolean, stateText: string | null) => ({ agent, doneExists, stateText });

  it("reports terminal timeout, failed and missing workers", () => {
    // `missing` joined the warned set on 2026-08-08: a worker that ANSWERED but wrote no artifact is
    // the quietest member of the silent-degrade class, and it cascaded unnoticed through the gate.
    const out = gateAnomalies([
      w("alpha", true, "OFFSET=0\nFS=timeout\n"),
      w("charlie", true, "OFFSET=0\nFS=failed\n"),
      w("delta", true, "OFFSET=0\nFS=missing\n"),
    ], "FS");
    expect(out).toEqual([
      { agent: "alpha", value: "timeout" }, { agent: "charlie", value: "failed" },
      { agent: "delta", value: "missing" },
    ]);
  });

  it("does not report ok, skipped, or question states", () => {
    const out = gateAnomalies([
      w("a", true, "FS=ok\n"),
      w("c", true, "FS=skipped\n"), w("d", true, "OFFSET=3\nFS=question\n"),
    ], "FS");
    expect(out).toEqual([]);
  });

  it("does not report a timeout state whose .done marker is absent (still pending)", () => {
    expect(gateAnomalies([w("a", false, "FS=timeout\n")], "FS")).toEqual([]);
  });

  it("uses the LAST key line (a re-armed question later timing out is reported)", () => {
    expect(gateAnomalies([w("a", true, "OFFSET=0\nVS=question\nOFFSET=9\nVS=timeout\n")], "VS"))
      .toEqual([{ agent: "a", value: "timeout" }]);
  });
});

// liveOutboxWait binds the real tmux probe, and that probe can only ever answer false for a record
// with no nonce. Enabling the escape hatch on one fabricated a `pane-died` error ~30s into every
// wait on a live pre-0.5.30 worker; an unverifiable record must degrade to the plain outbox-only
// poll, exactly as an ABSENT pane.json does.
describe("liveOutboxWait: a legacy pane.json disables the liveness check", () => {
  const seed = (nonce: string | null): void => {
    mkOutbox("a", "codex", "t");
    const pj = join(dirname(outboxPath("a", "codex", "t")), "pane.json");
    writeFileSync(pj, JSON.stringify({
      pane_id: "%1", ...(nonce === null ? {} : { pane_nonce: nonce }), agent: "a", model: "codex",
    }));
  };

  it("legacy record + no terminal event -> runs the full budget and returns null (never pane-died)", async () => {
    const { cleanup } = freshHome();
    try {
      seed(null);
      const v = virtualClock();
      // everyS defaults to 15 and the budget is 60, so a live probe would have fired 3 times over
      // this window; with the check disabled the wait simply expires.
      const ev = await liveOutboxWait("a", "codex", "t", 0, ["done"], 60, v.clock);
      expect(ev).toBeNull();
    } finally { cleanup(); }
  });

  it("no pane.json at all behaves identically (the degrade this matches)", async () => {
    const { cleanup } = freshHome();
    try {
      mkOutbox("a", "codex", "t");
      const v = virtualClock();
      expect(await liveOutboxWait("a", "codex", "t", 0, ["done"], 60, v.clock)).toBeNull();
    } finally { cleanup(); }
  });

  it("a legacy record still returns a real terminal event from the outbox", async () => {
    const { cleanup } = freshHome();
    try {
      seed(null);
      const p = outboxPath("a", "codex", "t");
      const v = virtualClock();
      v.at(3000, () => { appendFileSync(p, '{"event":"done","summary":"ok"}\n'); });
      const ev = await liveOutboxWait("a", "codex", "t", 0, ["done"], 60, v.clock);
      expect(ev?.event).toBe("done");
    } finally { cleanup(); }
  });
});
