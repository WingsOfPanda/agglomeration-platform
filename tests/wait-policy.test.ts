// tests/wait-policy.test.ts — awaitTurn's policy table (2026-08-15 spec).
// One wait, two protections held as slots: `confirm` (the AP_TURN_CONFIRM_S quiet window over
// OUTBOX growth, the turn/round verbs) and `artifact` (the AP_ARTIFACT_GRACE_S grace over ARTIFACT
// growth, the phase waits). Before this module the two lived in disjoint wrappers serving disjoint
// callers, and neither family could use the other's protection. These pins cover each slot alone,
// NEITHER slot, and — the point of the refactor — BOTH at once on a synthetic ctx, which is what
// "phase waits confirm too" or "implement's verify report gets grace" would cost: a flag flip.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { outboxPath, type OutboxEvent } from "../src/core/ipc.js";
import { globalRoot } from "../src/core/paths.js";
import { END_OF_ARTIFACT } from "../src/core/artifact.js";
import { awaitTurn, type TurnCtx, type TurnDeps, type TurnPolicy, type TurnResult } from "../src/core/wait.js";

const I = "bravo", M = "codex", T = "auth";
const DONE = '{"event":"done","summary":"premature"}';
const DONE2 = '{"event":"done","summary":"real"}';
const PROGRESS = '{"event":"progress","note":"still working"}';
const ERROR2 = '{"event":"error","reason":"tests failed"}';
const doneEv = (summary: string): OutboxEvent => ({ event: "done", summary });

function writeOutbox(lines: string[]): string {
  const p = outboxPath(I, M, T);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => l + "\n").join(""));
  return p;
}
function appendOutbox(lines: string[]): void {
  appendFileSync(outboxPath(I, M, T), lines.map((l) => l + "\n").join(""));
}

/** A state file carrying `OFFSET=<n>` — the only input awaitTurn resolves for itself. */
function stateFile(body = "OFFSET=0\n"): string {
  const p = join(globalRoot(), "phase-state.txt");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}
function artifactPath(): string {
  const p = join(globalRoot(), "findings-bravo.md");
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

function ctxWith(policy: TurnPolicy, sf: string, timeoutS = 600): TurnCtx {
  return { agent: I, model: M, topic: T, stateFile: sf, timeoutS, label: "explore research-wait", policy };
}

/** The harness that replaces the two mock stacks: one scripted wait, one scripted sleep (which runs
 *  the next outbox/artifact mutation, so "the worker kept writing" is deterministic), one flag sink. */
function harness(events: Array<OutboxEvent | null>, steps: Array<() => void> = []) {
  const waits: Array<{ off: number; to: number }> = [];
  const sleeps: number[] = [];
  const flags: string[] = [];
  const armed: number[] = [];
  const d: TurnDeps = {
    wait: async (_i, _m, _t, off, _ev, to) => { waits.push({ off, to }); return events.shift() ?? null; },
    clock: { now: () => Date.now(), sleep: async (ms: number) => { sleeps.push(ms); steps.shift()?.(); } },
    onArmed: (off) => { armed.push(off); },
    onFlag: (note) => { flags.push(note); },
  };
  return { d, waits, sleeps, flags, armed };
}

const settled = (r: TurnResult | { missingOffset: true }): TurnResult => {
  if ("missingOffset" in r) throw new Error("expected a settled turn, got missingOffset");
  return r;
};

describe("awaitTurn: offset resolution (owned by the wait, reported to the caller)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); delete process.env.AP_TURN_CONFIRM_S; delete process.env.AP_ARTIFACT_GRACE_S; });

  it("reads the LATEST OFFSET= line and arms the wait from it", async () => {
    const { d, waits, armed } = harness([doneEv("real")]);
    await awaitTurn(ctxWith({}, stateFile("OFFSET=10\nFS=question\nOFFSET=512\n")), d);
    expect(armed).toEqual([512]);
    expect(waits[0].off).toBe(512);
  });

  it("a state file with no OFFSET= returns missingOffset and never waits", async () => {
    const { d, waits, armed } = harness([doneEv("real")]);
    const r = await awaitTurn(ctxWith({}, stateFile("FS=timeout\n")), d);
    expect(r).toEqual({ missingOffset: true });
    expect(waits).toEqual([]);
    expect(armed).toEqual([]);   // nothing to log: the caller prints its own error instead
  });
});

describe("awaitTurn: the policy table", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); delete process.env.AP_TURN_CONFIRM_S; delete process.env.AP_ARTIFACT_GRACE_S; });

  it("NEITHER slot: the wait's own event passes through, with no window and no grace", async () => {
    writeOutbox([DONE, PROGRESS]);          // growth that a confirm policy would veto on
    const first = doneEv("premature");
    const { d, waits, sleeps, flags } = harness([first]);
    const r = settled(await awaitTurn(ctxWith({}, stateFile()), d));
    expect(r.event).toBe(first);            // same object: nothing was re-read
    expect(r.accept).toBeNull();            // no artifact policy ran
    expect(sleeps).toEqual([]);
    expect(waits.length).toBe(1);
    expect(flags).toEqual([]);
  });

  it("CONFIRM only: the quiet window runs, and no artifact verdict is produced", async () => {
    writeOutbox([DONE]);
    const { d, sleeps, flags } = harness([doneEv("premature")]);
    const r = settled(await awaitTurn(ctxWith({ confirm: true }, stateFile()), d));
    expect(r.event!.summary).toBe("premature");
    expect(r.accept).toBeNull();            // a turn verb writes no AC= line
    expect(sleeps).toEqual([20_000]);       // exactly one window at the default
    expect(flags).toEqual([]);
  });

  it("ARTIFACT only: the grace runs, and no confirmation window is spent", async () => {
    const artifact = artifactPath();
    writeFileSync(artifact, `body\n${END_OF_ARTIFACT}\n`);
    writeOutbox([DONE, PROGRESS]);          // growth a confirm policy would veto on; this one must not
    const { d, waits, sleeps, flags } = harness([doneEv("premature")]);
    const r = settled(await awaitTurn(ctxWith({ artifact: { path: artifact, key: "FS" } }, stateFile()), d));
    expect(r.accept).toBe("sentinel");
    expect(sleeps).toEqual([]);             // the sentinel is the fast path, and no window is owed
    expect(waits.length).toBe(1);           // no re-arm: confirmation is off for this policy
    expect(flags).toEqual([]);
  });

  it("ARTIFACT only: grace applies to `done` alone — an error event yields no verdict", async () => {
    const artifact = artifactPath();        // never written: an expiry would be the alternative
    const { d, sleeps } = harness([{ event: "error", reason: "tests failed" }]);
    const r = settled(await awaitTurn(ctxWith({ artifact: { path: artifact, key: "FS" } }, stateFile()), d));
    expect(r.event!.event).toBe("error");
    expect(r.accept).toBeNull();
    expect(sleeps).toEqual([]);
  });

  it("ARTIFACT only: a missing artifact expires, flagged, with the phase key named", async () => {
    process.env.AP_ARTIFACT_GRACE_S = "10";
    const artifact = artifactPath();
    const { d, flags } = harness([doneEv("premature")]);
    const r = settled(await awaitTurn(ctxWith({ artifact: { path: artifact, key: "VS" } }, stateFile()), d));
    expect(r.accept).toBe("expired");
    expect(flags).toEqual([
      `artifact-incomplete: ${I} ${artifact} done-event without ${END_OF_ARTIFACT} after 10s grace`,
    ]);
  });

  it("BOTH slots on one ctx: the window vetoes the premature done AND the grace judges the artifact", async () => {
    const artifact = artifactPath();
    writeOutbox([DONE]);
    // The window's sleep is when the worker keeps writing: a trailing progress + its REAL done, and
    // only then the artifact lands complete. Confirmation picks the later done; the grace accepts.
    const steps = [() => { appendOutbox([DONE, PROGRESS, DONE2]); writeFileSync(artifact, `body\n${END_OF_ARTIFACT}\n`); }];
    const { d, sleeps, flags } = harness([doneEv("premature"), doneEv("real")], steps);
    const r = settled(await awaitTurn(
      ctxWith({ confirm: true, artifact: { path: artifact, key: "FS" } }, stateFile()), d));
    expect(r.event!.summary).toBe("real");  // the confirmation layer ran
    expect(r.accept).toBe("sentinel");      // and so did the artifact layer, on the confirmed event
    expect(sleeps).toEqual([20_000, 20_000]);
    expect(flags).toEqual([`turn-confirm-veto: ${M} premature done — outbox still active`]);
  });

  it("BOTH slots: the artifact is judged against the CONFIRMED event, not the premature one", async () => {
    process.env.AP_ARTIFACT_GRACE_S = "10";
    const artifact = artifactPath();        // never written: judged on the premature done it would expire
    writeOutbox([DONE]);
    // The turn really ended in an ERROR the premature done hid. The confirmation settles on it, and
    // the artifact policy must then produce NO verdict at all — proof the grace reads the SETTLED
    // event: judged on the premature done instead, this same file would have expired.
    const steps = [() => { appendOutbox([PROGRESS, ERROR2]); }];
    const { d, flags } = harness([doneEv("premature"), { event: "error", reason: "tests failed" }], steps);
    const r = settled(await awaitTurn(
      ctxWith({ confirm: true, artifact: { path: artifact, key: "FS" } }, stateFile()), d));
    expect(r.event!.event).toBe("error");
    expect(r.accept).toBeNull();
    expect(flags).toEqual([`turn-confirm-veto: ${M} premature done — outbox still active`]);
  });

  it("AP_TURN_CONFIRM_S=0 disables only the confirm slot; the artifact slot still judges", async () => {
    process.env.AP_TURN_CONFIRM_S = "0";
    const artifact = artifactPath();
    writeFileSync(artifact, `body\n${END_OF_ARTIFACT}\n`);
    writeOutbox([DONE, PROGRESS]);
    const first = doneEv("premature");
    const { d, sleeps } = harness([first]);
    const r = settled(await awaitTurn(
      ctxWith({ confirm: true, artifact: { path: artifact, key: "FS" } }, stateFile()), d));
    expect(r.event).toBe(first);
    expect(r.accept).toBe("sentinel");
    expect(sleeps).toEqual([]);
  });

  it("AP_ARTIFACT_GRACE_S=0 disables only the artifact slot; the confirm slot still runs", async () => {
    process.env.AP_ARTIFACT_GRACE_S = "0";
    const artifact = artifactPath();
    writeOutbox([DONE]);
    const steps = [() => { appendOutbox([DONE, PROGRESS, DONE2]); }];
    const { d, sleeps, flags } = harness([doneEv("premature"), doneEv("real")], steps);
    const r = settled(await awaitTurn(
      ctxWith({ confirm: true, artifact: { path: artifact, key: "FS" } }, stateFile()), d));
    expect(r.event!.summary).toBe("real");
    expect(r.accept).toBe("unchecked");     // the operator turned the check off; the wait says so
    expect(sleeps).toEqual([20_000, 20_000]);
    expect(flags).toEqual([`turn-confirm-veto: ${M} premature done — outbox still active`]);
  });
});
