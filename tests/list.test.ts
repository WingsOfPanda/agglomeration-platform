import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveState, classifyStale, lastOutboxEvent, rowState } from "../src/commands/list.js";

afterEach(() => { /* no env */ });

describe("list pure logic", () => {
  it("deriveState mapping", () => {
    expect(deriveState(undefined)).toBe("spawning");
    expect(deriveState("done")).toBe("idle (done)");
    expect(deriveState("error")).toBe("idle (error)");
    expect(deriveState("ack")).toBe("working");
    expect(deriveState("ready")).toBe("ready");
    expect(deriveState("progress")).toBe("progress");
    expect(deriveState("question")).toBe("question");
  });
  it("classifyStale only reclassifies working past threshold", () => {
    const f = join(mkdtempSync(join(tmpdir(), "rs-")), "outbox.jsonl");
    closeSync(openSync(f, "w"));
    const old = (Date.now() - 300_000) / 1000;
    utimesSync(f, old, old);
    expect(classifyStale("working", f, 180)).toBe("stale");
    expect(classifyStale("working", f, 999999)).toBe("working");
    expect(classifyStale("idle (done)", f, 1)).toBe("idle (done)");
    expect(classifyStale("working", "/nope/x.jsonl", 180)).toBe("working");
  });
  it("lastOutboxEvent: JSON.parse, embedded-event safe", () => {
    const f = join(mkdtempSync(join(tmpdir(), "le-")), "outbox.jsonl");
    writeFileSync(f, `{"event":"ack"}\n{"event":"progress","note":"\\"event\\":\\"done\\""}\n`);
    expect(lastOutboxEvent(f)).toBe("progress"); // last line's real event, not the quoted "done"
  });
});

// A live row is the prompt to run `stop` on that worker, so it must never be fabricated for a pane
// id a restarted tmux handed to another program.
describe("list rowState (pane ownership)", () => {
  const outbox = () => {
    const f = join(mkdtempSync(join(tmpdir(), "rs-")), "outbox.jsonl");
    writeFileSync(f, `{"event":"ack"}\n`);
    return f;
  };
  const meta = (paneId: string, nonce: string) => ({ agent: "bravo", model: "codex", paneId, nonce });

  it("live pane + matching nonce → the real state", () => {
    expect(rowState(new Map([["%1", "n1"]]), meta("%1", "n1"), outbox(), 180)).toBe("working");
  });
  it("live pane + DIFFERENT nonce (id reused after a tmux restart) → [ORPHAN]", () => {
    expect(rowState(new Map([["%1", "stranger"]]), meta("%1", "n1"), outbox(), 180)).toBe("[ORPHAN]");
  });
  it("live pane carrying no @ap_nonce at all → [ORPHAN]", () => {
    expect(rowState(new Map([["%1", ""]]), meta("%1", "n1"), outbox(), 180)).toBe("[ORPHAN]");
  });
  it("legacy pane.json (no recorded nonce) → [ORPHAN], even against a live id", () => {
    expect(rowState(new Map([["%1", "n1"]]), meta("%1", ""), outbox(), 180)).toBe("[ORPHAN]");
  });
  it("pane gone, and no pane id recorded at all → [ORPHAN]", () => {
    expect(rowState(new Map(), meta("%1", "n1"), outbox(), 180)).toBe("[ORPHAN]");
    expect(rowState(new Map([["%1", "n1"]]), meta("", ""), outbox(), 180)).toBe("[ORPHAN]");
  });
});
