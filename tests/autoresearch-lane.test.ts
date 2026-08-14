// tests/autoresearch-lane.test.ts — the worker lane: path, read, transition, and the two
// deliberately-divergent reconcile flavors.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { lanePath, readLane, applyTransition, reconcileLaneAtFinalize, reconcileLaneAtResume } from "../src/core/autoresearchLane.js";
import { autoresearchArtDir, workerStateDir, experimentDir } from "../src/core/autoresearch.js";
import { mergeState } from "../src/core/autoresearchState.js";
import { workerDir } from "../src/core/paths.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h; }

const TOPIC = "lane-topic";
const INST = "alpha";
const MODEL = "codex";
// resolveModel hashes process.cwd() (no cwd opt), so scaffold under process.cwd().
const opts = (h: { home: string }) => ({ home: h.home, cwd: process.cwd() });

const DONE = '{"event":"done","summary":"finished","ts":"T"}\n';

/** Scaffold a lane: art dir, worker state dir with `state`, a live pane dir (pane.json +
 *  outbox.jsonl carrying `outbox`), and exp-001's result.json when `result` is set. */
function scaffold(h: { home: string }, over: { state?: string; outbox?: string; result?: boolean } = {}) {
  const o = opts(h);
  const art = autoresearchArtDir(TOPIC, o);
  const sd = workerStateDir(art, INST);
  mkdirSync(sd, { recursive: true });
  if (over.state !== undefined) writeFileSync(join(sd, "state.txt"), over.state);
  const pd = workerDir(INST, MODEL, TOPIC, o);
  mkdirSync(pd, { recursive: true });
  writeFileSync(join(pd, "pane.json"), JSON.stringify({ pane_id: "%3", agent: INST, model: MODEL, spawned_at: "t" }));
  writeFileSync(join(pd, "outbox.jsonl"), over.outbox ?? "");
  if (over.result) {
    mkdirSync(experimentDir(art, INST, "exp-001"), { recursive: true });
    writeFileSync(join(experimentDir(art, INST, "exp-001"), "result.json"), "{}");
  }
  return { art, sd, o, outbox: join(pd, "outbox.jsonl") };
}

const phaseOf = (art: string) => readLane(art, INST).phase ?? "";

// ---- path + read ----

describe("lanePath / readLane", () => {
  it("lanePath is <art>/workers/<agent>/state.txt", () => {
    const h = home();
    const art = autoresearchArtDir(TOPIC, opts(h));
    expect(lanePath(art, INST)).toBe(join(workerStateDir(art, INST), "state.txt"));
  });

  it("readLane parses the lane KV", () => {
    const h = home();
    const { art } = scaffold(h, { state: "phase=working\ncurrent_exp_id=exp-002\n" });
    expect(readLane(art, INST)).toEqual({ phase: "working", current_exp_id: "exp-002" });
  });

  it("readLane on a missing state.txt is {} (never throws)", () => {
    const h = home();
    const art = autoresearchArtDir(TOPIC, opts(h));
    expect(readLane(art, "ghost")).toEqual({});
  });
});

// ---- the transition ----

describe("applyTransition", () => {
  it("writes exactly mergeState(on-disk, updates) — byte-identical", () => {
    const h = home();
    const before = "phase=working\nexp_counter=3\ncurrent_exp_id=exp-003\n";
    const { art } = scaffold(h, { state: before });
    const updates = { phase: "idle", current_exp_id: "", last_event: "scored" };
    applyTransition(art, INST, updates);
    expect(readFileSync(lanePath(art, INST), "utf8")).toBe(mergeState(before, updates));
  });

  it("overwrites touched keys and preserves every untouched one", () => {
    const h = home();
    const { art } = scaffold(h, { state: "phase=working\nexp_counter=7\nprobe_sent_ts=T1\n" });
    applyTransition(art, INST, { phase: "idle" });
    expect(readLane(art, INST)).toEqual({ phase: "idle", exp_counter: "7", probe_sent_ts: "T1" });
  });

  it("an absent state.txt merges onto nothing (fresh lane, no throw)", () => {
    const h = home();
    const { art } = scaffold(h);
    applyTransition(art, INST, { phase: "idle" });
    expect(readFileSync(lanePath(art, INST), "utf8")).toBe(mergeState(null, { phase: "idle" }));
  });
});

// ---- reconcile: finalize flavor ----

describe("reconcileLaneAtFinalize", () => {
  it("replays the outbox tail past the cursor: a done + result.json settles the lane to idle, then the case-map completes it", () => {
    const h = home();
    const { art, sd } = scaffold(h, { state: "phase=working\ncurrent_exp_id=exp-001\n", outbox: DONE, result: true });
    writeFileSync(join(sd, "liveness-cursor.txt"), "0");
    reconcileLaneAtFinalize(art, INST, TOPIC);
    expect(phaseOf(art)).toBe("complete");
  });

  it("a done WITHOUT result.json does not settle the lane; the case-map still normalizes working -> incomplete", () => {
    const h = home();
    const { art, sd } = scaffold(h, { state: "phase=working\ncurrent_exp_id=exp-001\n", outbox: DONE });
    writeFileSync(join(sd, "liveness-cursor.txt"), "0");
    reconcileLaneAtFinalize(art, INST, TOPIC);
    expect(phaseOf(art)).toBe("incomplete");
  });

  it("an error event wins over the case-map path: failed, which the case-map leaves alone", () => {
    const h = home();
    const { art, sd } = scaffold(h, { state: "phase=working\n", outbox: '{"event":"error","message":"boom","ts":"T"}\n' });
    writeFileSync(join(sd, "liveness-cursor.txt"), "0");
    reconcileLaneAtFinalize(art, INST, TOPIC);
    expect(phaseOf(art)).toBe("failed");
  });

  it("a cursor past the already-consumed events yields an empty tail (no reconcile write)", () => {
    const h = home();
    const { art, sd } = scaffold(h, { state: "phase=failed\ncurrent_exp_id=exp-001\n", outbox: DONE, result: true });
    writeFileSync(join(sd, "liveness-cursor.txt"), String(Buffer.byteLength(DONE)));
    reconcileLaneAtFinalize(art, INST, TOPIC);
    expect(phaseOf(art)).toBe("failed");   // finalizePhase("failed") is null too
  });

  it("a lane with no state.txt is skipped entirely (no file created)", () => {
    const h = home();
    const { art } = scaffold(h, { outbox: DONE });
    reconcileLaneAtFinalize(art, INST, TOPIC);
    expect(existsSync(lanePath(art, INST))).toBe(false);
  });
});

// ---- reconcile: resume flavor ----

describe("reconcileLaneAtResume", () => {
  it("a done past the delivery offset with result.json settles the lane to idle (no case-map)", () => {
    const h = home();
    const { art } = scaffold(h, { state: "phase=working\n", result: true });
    reconcileLaneAtResume(art, INST, DONE, 0, "exp-001");
    expect(phaseOf(art)).toBe("idle");
  });

  it("a done whose result.json is missing writes nothing (the experiment is still unfinished)", () => {
    const h = home();
    const { art } = scaffold(h, { state: "phase=working\n" });
    reconcileLaneAtResume(art, INST, DONE, 0, "exp-001");
    expect(phaseOf(art)).toBe("working");
  });

  it("an empty expId means no result.json can vouch for the done", () => {
    const h = home();
    const { art } = scaffold(h, { state: "phase=working\n", result: true });
    reconcileLaneAtResume(art, INST, DONE, 0, "");
    expect(phaseOf(art)).toBe("working");
  });

  it("events already consumed before the offset are not replayed", () => {
    const h = home();
    const { art } = scaffold(h, { state: "phase=working\n", result: true });
    reconcileLaneAtResume(art, INST, DONE, Buffer.byteLength(DONE), "exp-001");
    expect(phaseOf(art)).toBe("working");
  });
});

// ---- THE DIVERGENCE PIN ----
// The two flavors disagree on ONE input — an offset past EOF, i.e. a crash/rotation RECREATED the
// outbox and it now holds only new events. resume is shrink-guarded (re-reads from byte 0);
// finalize's hand-rolled Buffer.subarray yields an EMPTY tail. Unifying them is a behavior change,
// so both halves are pinned here: swapping the flavors flips both expectations.

describe("finalize-vs-resume divergence (offset past EOF)", () => {
  const SHRUNK_OFFSET = 9999;

  it("finalize sees NOTHING past a stale cursor: the done is missed, only the case-map fires", () => {
    const h = home();
    const { art, sd } = scaffold(h, { state: "phase=working\ncurrent_exp_id=exp-001\n", outbox: DONE, result: true });
    writeFileSync(join(sd, "liveness-cursor.txt"), String(SHRUNK_OFFSET));
    reconcileLaneAtFinalize(art, INST, TOPIC);
    expect(phaseOf(art)).toBe("incomplete");   // NOT "complete" — the done was never replayed
  });

  it("resume re-reads the recreated outbox from byte 0: the same done DOES settle the lane", () => {
    const h = home();
    const { art } = scaffold(h, { state: "phase=working\ncurrent_exp_id=exp-001\n", outbox: DONE, result: true });
    reconcileLaneAtResume(art, INST, DONE, SHRUNK_OFFSET, "exp-001");
    expect(phaseOf(art)).toBe("idle");
  });
});

// ---- structural pin: the lane machinery must not be re-inlined at the converted call sites ----

describe("command file delegates to the lane module", () => {
  const src = readFileSync(join(process.cwd(), "src", "commands", "autoresearch.ts"), "utf8");

  it("spells no read-modify-write of its own (applyTransition owns it)", () => {
    expect(src).not.toMatch(/mergeState\s*\(/);
  });

  it("reconstructs no state.txt path of its own (lanePath owns it)", () => {
    expect(src).not.toMatch(/,\s*"state\.txt"\s*\)/);
  });
});
