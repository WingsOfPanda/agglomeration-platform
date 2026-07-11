// tests/autoresearch-ledger.test.ts — campaign event ledger (pure core).
import { describe, it, expect } from "vitest";
import {
  appendEvent, parseLedger, replayLedger, readGen, renderGen,
  ledgerPath, controllerGenPath, type LedgerEvent,
} from "../src/core/autoresearchLedger.js";
import { nextExpId } from "../src/core/autoresearchExperiment.js";

const T = "2026-07-11T00:00:00Z";
const line = (prev: string, ev: Omit<LedgerEvent, "seq">) => prev + appendEvent(prev, ev);

describe("appendEvent", () => {
  it("mints seq 1 on an empty ledger and strictly increments", () => {
    let text = line("", { gen: 1, ts: T, kind: "campaign-init" });
    text = line(text, { gen: 1, ts: T, kind: "dispatch-intent", agent: "bravo", exp_id: "exp-001" });
    const evs = parseLedger(text);
    expect(evs.map((e) => e.seq)).toEqual([1, 2]);
  });
  it("rejects a stale gen (lower than the ledger's controller gen)", () => {
    let text = line("", { gen: 1, ts: T, kind: "campaign-init" });
    text = line(text, { gen: 2, ts: T, kind: "resume" });
    expect(() => appendEvent(text, { gen: 1, ts: T, kind: "dispatch-intent", agent: "bravo", exp_id: "exp-002" }))
      .toThrow(/stale gen/);
  });
  it("tolerates malformed prev lines (seq continues from the last VALID line)", () => {
    const prev = line("", { gen: 1, ts: T, kind: "campaign-init" }) + "not json\n{\"seq\":\"x\"}\n";
    const next = appendEvent(prev, { gen: 1, ts: T, kind: "dispatch-intent", agent: "b", exp_id: "exp-001" });
    expect((JSON.parse(next) as LedgerEvent).seq).toBe(2);
  });
});

describe("parseLedger", () => {
  it("skips non-JSON, non-integer-seq, and unknown-kind lines", () => {
    const good = appendEvent("", { gen: 1, ts: T, kind: "campaign-init" });
    const text = "garbage\n" + good + '{"seq":2,"gen":1,"ts":"t","kind":"bogus-kind"}\n';
    expect(parseLedger(text)).toHaveLength(1);
  });
});

describe("replayLedger", () => {
  function seeded(): string {
    let t = line("", { gen: 1, ts: T, kind: "campaign-init" });
    t = line(t, { gen: 1, ts: T, kind: "dispatch-intent", agent: "bravo", exp_id: "exp-001" });
    t = line(t, { gen: 1, ts: T, kind: "dispatch-delivered", agent: "bravo", exp_id: "exp-001", data: { outboxOffset: 120 } });
    t = line(t, { gen: 1, ts: T, kind: "dispatch-intent", agent: "juliet", exp_id: "exp-001" });
    t = line(t, { gen: 1, ts: T, kind: "result-recorded", agent: "bravo", exp_id: "exp-001" });
    t = line(t, { gen: 1, ts: T, kind: "dispatch-intent", agent: "bravo", exp_id: "exp-002" });
    return t;
  }
  it("pairs intents with deliveries; undelivered intents surface as delivered=false", () => {
    const r = replayLedger(seeded());
    expect(r.intents.get("bravo/exp-001")).toMatchObject({ delivered: true, outboxOffset: 120 });
    expect(r.intents.get("juliet/exp-001")).toMatchObject({ delivered: false });
    expect(r.intents.get("bravo/exp-002")).toMatchObject({ delivered: false });
  });
  it("completionOrder lists result-recorded keys in seq order; counters are per-agent intent maxima", () => {
    const r = replayLedger(seeded());
    expect(r.completionOrder).toEqual(["bravo/exp-001"]);
    expect(r.counters.get("bravo")).toBe(2);
    expect(r.counters.get("juliet")).toBe(1);
    expect(r.lastDeliveredOffset.get("bravo")).toBe(120);
    expect(r.lastDeliveredOffset.get("juliet")).toBeUndefined();
  });
  it("gen is the highest campaign-init/resume gen; lastSeq the last valid seq", () => {
    let t = seeded();
    t = line(t, { gen: 2, ts: T, kind: "resume" });
    const r = replayLedger(t);
    expect(r.gen).toBe(2);
    expect(r.lastSeq).toBe(7);
  });
});

describe("controller.gen round-trip", () => {
  it("renderGen -> readGen round-trips; absent/garbled -> gen 0", () => {
    const body = renderGen(3, T, "resume");
    expect(readGen(body)).toMatchObject({ gen: 3 });
    expect(readGen(body).fields.holder).toBe("resume");
    expect(readGen(null).gen).toBe(0);
    expect(readGen("gen=abc\n").gen).toBe(0);
  });
});

describe("nextExpId (counter reconstructible as max(state, ledger intents))", () => {
  it("takes the max of state exp_counter and the ledger intent max, +1, zero-padded", () => {
    expect(nextExpId("exp_counter=4\nphase=idle\n", 5)).toBe("exp-006");
    expect(nextExpId("exp_counter=7\nphase=idle\n", 5)).toBe("exp-008");
    expect(nextExpId(null, 0)).toBe("exp-001");
    expect(nextExpId("exp_counter=junk\n", 2)).toBe("exp-003");
  });
});

describe("path helpers", () => {
  it("ledgerPath / controllerGenPath land under the art dir", () => {
    expect(ledgerPath("/a/_autoresearch")).toBe("/a/_autoresearch/campaign-ledger.jsonl");
    expect(controllerGenPath("/a/_autoresearch")).toBe("/a/_autoresearch/controller.gen");
  });
});
