// tests/perform-wave-wait.test.ts — C2: perform wave-wait per-part barrier (deploy-wave-wait.sh).
// rc 0 in EVERY wait-outcome case; TS= carries the outcome; a wave-<instr>.done sentinel is dropped.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { performArtDir } from "../src/core/perform.js";
import { scaledTimeout, parseLatestOffset } from "../src/core/scoreTurn.js";
import { outboxPath, outboxOffset, outboxWaitSince } from "../src/core/ipc.js";
import type { OutboxEvent } from "../src/core/ipc.js";
import {
  run as performRun, waveWaitWith, type PerformWaitDeps,
} from "../src/commands/perform.js";

const TOPIC = "multi-svc";
const INSTR = "violin";
const PROVIDER = "codex";

interface WaitCall { i: string; m: string; t: string; off: number; ev: string[]; to: number; }

// Build an injectable PerformWaitDeps that returns `ev` and records the wait call.
function waitDeps(ev: OutboxEvent | null, over: Partial<PerformWaitDeps> = {}): { d: PerformWaitDeps; calls: WaitCall[] } {
  const calls: WaitCall[] = [];
  const d: PerformWaitDeps = {
    wait: over.wait ?? (async (i, m, t, off, evs, to) => { calls.push({ i, m, t, off, ev: evs, to }); return ev; }),
    multiplier: over.multiplier ?? (() => "1"),
    now: over.now ?? (() => 0),
  };
  return { d, calls };
}

function waveFile(art: string): string { return join(art, `wave-${INSTR}.txt`); }

describe("perform wave-wait (rc 0 always; TS= carries the outcome; .done sentinel)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => {
    h = freshHome();
    mkdirSync(performArtDir(TOPIC), { recursive: true }); // pre-create the art dir
  });
  afterEach(() => {
    h.cleanup();
    delete process.env.CONSORT_PERFORM_WAVE_TIMEOUT_OVERRIDE;
    delete process.env.CONSORT_PERFORM_TURN_TIMEOUT_S;
  });

  it("done event → rc 0, TS=ok + EVENT=done, wave-<instr>.done created", async () => {
    const art = performArtDir(TOPIC);
    const { d } = waitDeps({ event: "done", summary: "x" });
    const rc = await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(rc).toBe(0);
    const txt = readFileSync(waveFile(art), "utf8");
    expect(txt).toContain("TS=ok\n");
    expect(txt).toContain("EVENT=done\n");
    expect(existsSync(join(art, `wave-${INSTR}.done`))).toBe(true);
  });

  it("error event with reason → TS=failed + EVENT=error + REASON=boom, rc 0", async () => {
    const art = performArtDir(TOPIC);
    const { d } = waitDeps({ event: "error", reason: "boom" });
    expect(await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d)).toBe(0);
    const txt = readFileSync(waveFile(art), "utf8");
    expect(txt).toContain("TS=failed\n");
    expect(txt).toContain("EVENT=error\n");
    expect(txt).toContain("REASON=boom\n");
  });

  it("error event without reason → REASON= (empty), rc 0", async () => {
    const art = performArtDir(TOPIC);
    const { d } = waitDeps({ event: "error" });
    expect(await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d)).toBe(0);
    const txt = readFileSync(waveFile(art), "utf8");
    expect(txt).toContain("TS=failed\n");
    expect(txt).toContain("REASON=\n");
  });

  it("null (timeout) → TS=timeout + TIMEOUT_S=<scaled>, rc 0", async () => {
    const art = performArtDir(TOPIC);
    const { d } = waitDeps(null); // multiplier '1', default timeout 14400
    expect(await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d)).toBe(0);
    const txt = readFileSync(waveFile(art), "utf8");
    expect(txt).toContain("TS=timeout\n");
    expect(txt).toContain(`TIMEOUT_S=${scaledTimeout(14400, "1")}\n`);
  });

  it("unknown event (progress) → TS=failed + EVENT=unknown, rc 0", async () => {
    const art = performArtDir(TOPIC);
    const { d } = waitDeps({ event: "progress" });
    expect(await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d)).toBe(0);
    const txt = readFileSync(waveFile(art), "utf8");
    expect(txt).toContain("TS=failed\n");
    expect(txt).toContain("EVENT=unknown\n");
  });

  it("wait is called with offset===0 and events [done,error,question] on first dispatch", async () => {
    const { d, calls } = waitDeps({ event: "done" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(calls).toHaveLength(1);
    expect(calls[0].off).toBe(0);
    expect(calls[0].ev).toEqual(["done", "error", "question"]);
    expect(calls[0].i).toBe(INSTR);
    expect(calls[0].m).toBe(PROVIDER);
    expect(calls[0].t).toBe(TOPIC);
  });

  it("field order: TS / INSTRUMENT / PROVIDER / TOPIC then extras (TS=ok unchanged)", async () => {
    const art = performArtDir(TOPIC);
    const { d } = waitDeps({ event: "done" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(readFileSync(waveFile(art), "utf8")).toBe(
      `TS=ok\nINSTRUMENT=${INSTR}\nPROVIDER=${PROVIDER}\nTOPIC=${TOPIC}\nEVENT=done\n`,
    );
  });

  it("CONSORT_PERFORM_WAVE_TIMEOUT_OVERRIDE=5 + multiplier '2' → wait gets scaledTimeout(5,'2')===10", async () => {
    process.env.CONSORT_PERFORM_WAVE_TIMEOUT_OVERRIDE = "5";
    const { d, calls } = waitDeps(null, { multiplier: () => "2" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(calls[0].to).toBe(scaledTimeout(5, "2"));
    expect(calls[0].to).toBe(10);
  });

  it("missing art dir → rc 1", async () => {
    const { d } = waitDeps({ event: "done" });
    expect(await waveWaitWith("no-such-topic", INSTR, PROVIDER, 0, d)).toBe(1);
  });

  it("runner arg validation: missing provider → rc 2", async () => {
    expect(await performRun(["wave-wait", TOPIC, INSTR])).toBe(2);
  });

  it("runner arg validation: missing dispatch → rc 2", async () => {
    expect(await performRun(["wave-wait", TOPIC, INSTR, PROVIDER])).toBe(2);
  });

  it("runner arg validation: bad topic 'Bad_Topic' (with dispatch) → rc 2", async () => {
    expect(await performRun(["wave-wait", "Bad_Topic", INSTR, PROVIDER, "0"])).toBe(2);
  });

  it("question event with OBJECTION: → TS=question, payload + per-dispatch offset file (wave identity)", async () => {
    const art = performArtDir(TOPIC);
    const ob = outboxPath(INSTR, PROVIDER, TOPIC);
    mkdirSync(dirname(ob), { recursive: true });
    writeFileSync(ob, '{"event":"question","message":"OBJECTION: bad slice"}\n'); // seed so the bump is non-zero
    const { d } = waitDeps({ event: "question", message: "OBJECTION: bad slice" });
    const rc = await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(rc).toBe(0);
    expect(readFileSync(waveFile(art), "utf8")).toBe(
      `TS=question\nINSTRUMENT=${INSTR}\nPROVIDER=${PROVIDER}\nTOPIC=${TOPIC}\nEVENT=question\n`,
    );
    expect(readFileSync(join(art, `question-${INSTR}-0.txt`), "utf8")).toContain("ROUTE=objection\n");
    const dispatchText = readFileSync(join(art, `wave-${INSTR}-0.txt`), "utf8");
    expect(dispatchText).toContain("TS=question\n");
    expect(dispatchText).toContain("OBJECTIONS=1\n");
    const bumped = parseLatestOffset(dispatchText);
    expect(bumped).toBe(outboxOffset(ob));     // wave-path identity, not PART/model
    expect(bumped!).toBeGreaterThan(0);
  });

  it("start offset: defaults to 0 on first dispatch; <since> overrides", async () => {
    const { d, calls } = waitDeps({ event: "done" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);          // no since, no dispatch file
    expect(calls[0].off).toBe(0);
    const { d: d2, calls: c2 } = waitDeps({ event: "done" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 1, d2, 42);     // since overrides
    expect(c2[0].off).toBe(42);
  });

  it("escalate question (no claim, no marker) → TS=question but NO OBJECTIONS line", async () => {
    const art = performArtDir(TOPIC);
    const ob = outboxPath(INSTR, PROVIDER, TOPIC);
    mkdirSync(dirname(ob), { recursive: true });
    writeFileSync(ob, '{"event":"question","message":"which fallback?"}\n');
    const { d } = waitDeps({ event: "question", message: "which fallback?" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(readFileSync(join(art, `wave-${INSTR}-0.txt`), "utf8")).not.toContain("OBJECTIONS=");
  });

  it("malformed question (no message) → downgraded TS=failed + EVENT=question-malformed, no payload/dispatch file", async () => {
    const art = performArtDir(TOPIC);
    const { d } = waitDeps({ event: "question" }); // no message → extractQuestionPayload returns null
    const rc = await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(rc).toBe(0);
    const txt = readFileSync(waveFile(art), "utf8");
    expect(txt.split("\n")[0]).toBe("TS=failed");
    expect(txt).toContain("EVENT=question-malformed\n");
    expect(existsSync(join(art, `question-${INSTR}-0.txt`))).toBe(false); // no payload written
    expect(existsSync(join(art, `wave-${INSTR}-0.txt`))).toBe(false);     // dispatch/offset file untouched
  });

  it("real outboxWaitSince: reading PAST a handled question returns the terminal done, not the question", async () => {
    const ob = outboxPath(INSTR, PROVIDER, TOPIC);
    mkdirSync(dirname(ob), { recursive: true });
    const qLine = '{"event":"question","message":"OBJECTION: x"}\n';
    writeFileSync(ob, qLine + '{"event":"done","summary":"ok"}\n');
    const hit = await outboxWaitSince(INSTR, PROVIDER, TOPIC, Buffer.byteLength(qLine), ["done", "error", "question"], 5);
    expect(hit?.event).toBe("done");
  });

  it("real outboxWaitSince: a handled question BELOW the offset is not re-returned", async () => {
    const ob = outboxPath(INSTR, PROVIDER, TOPIC);
    mkdirSync(dirname(ob), { recursive: true });
    const qLine = '{"event":"question","message":"OBJECTION: x"}\n';
    writeFileSync(ob, qLine); // only the handled question, nothing after it
    const hit = await outboxWaitSince(INSTR, PROVIDER, TOPIC, Buffer.byteLength(qLine), ["done", "error", "question"], 1);
    expect(hit).toBeNull(); // nothing past the bump → no re-handle (1s poll, then null)
  });
});
