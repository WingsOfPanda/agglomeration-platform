import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { outboxWaitSince, outboxPath } from "../src/core/ipc.js";
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

describe("gateAnomalies", () => {
  const w = (agent: string, doneExists: boolean, stateText: string | null) => ({ agent, doneExists, stateText });

  it("reports terminal timeout and failed workers", () => {
    const out = gateAnomalies([
      w("alpha", true, "OFFSET=0\nFS=timeout\n"),
      w("charlie", true, "OFFSET=0\nFS=failed\n"),
    ], "FS");
    expect(out).toEqual([{ agent: "alpha", value: "timeout" }, { agent: "charlie", value: "failed" }]);
  });

  it("does not report ok, missing, skipped, or question states", () => {
    const out = gateAnomalies([
      w("a", true, "FS=ok\n"), w("b", true, "FS=missing\n"),
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
