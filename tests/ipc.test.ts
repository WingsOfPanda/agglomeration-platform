import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as IPC from "../src/core/ipc.js";
import { workerDir } from "../src/core/paths.js";

beforeEach(() => { process.env.CLAUDE_PLUGIN_ROOT = process.cwd(); });
afterEach(() => { delete process.env.AP_HOME; });
function home() { const h = mkdtempSync(join(tmpdir(), "ipc-")); process.env.AP_HOME = h; return h; }
function seedPart(i: string, m: string, t: string) { const d = workerDir(i, m, t); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "outbox.jsonl"), ""); return d; }

describe("ipc inbox", () => {
  it("inboxWrite: From: hub, END_OF_INSTRUCTION last line, body intact", () => {
    home(); seedPart("bravo", "codex", "demo");
    IPC.inboxWrite("bravo", "codex", "demo", "do the thing");
    const txt = readFileSync(IPC.inboxPath("bravo", "codex", "demo"), "utf8");
    const lines = txt.split("\n");
    expect(lines[0]).toBe("From: hub");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("do the thing");
    expect(txt.trimEnd().split("\n").at(-1)).toBe("END_OF_INSTRUCTION");
    expect(txt).toContain('`{"event":"done","summary":"<one-line summary>","ts":"<iso-timestamp>"}`');
  });
  it("inboxWrite: --from override and validation", () => {
    home(); seedPart("bravo", "codex", "demo");
    IPC.inboxWrite("bravo", "codex", "demo", "t", { from: "charlie" });
    expect(readFileSync(IPC.inboxPath("bravo", "codex", "demo"), "utf8").split("\n")[0]).toBe("From: charlie");
    expect(() => IPC.inboxWrite("bravo", "codex", "demo", "t", { from: "bad name!" })).toThrow();
    expect(() => IPC.inboxWrite("bravo", "codex", "demo", "t", { from: "" })).toThrow();
  });
});

describe("ipc identity", () => {
  it("identityWrite substitutes tokens + appends agent ready block", () => {
    home(); const d = seedPart("bravo", "codex", "demo");
    IPC.identityWrite("bravo", "codex", "demo");
    const txt = readFileSync(join(d, "identity.md"), "utf8");
    expect(txt).toContain("**bravo**");        // {{agent}}
    expect(txt).toContain("codex-class");        // {{model}}
    expect(txt).toContain("**demo**");           // {{topic}}
    expect(txt).toContain(d);                    // {{state_dir}}
    expect(txt).toContain('"event":"ready"');
    expect(txt).toContain('\\"agent\\":\\"bravo\\"'); // ready block uses agent, not commander
    expect(txt).not.toContain("commander");
  });
});

describe("ipc outbox", () => {
  it("outboxOffset bytes", () => {
    home(); const d = seedPart("bravo", "codex", "demo");
    writeFileSync(join(d, "outbox.jsonl"), "hello world"); // 11 bytes, no newline
    expect(IPC.outboxOffset(join(d, "outbox.jsonl"))).toBe(11);
    expect(IPC.outboxOffset(join(d, "nope.jsonl"))).toBe(0);
  });
  it("outboxWait returns LAST matching event (tail-n1), done resolves fast", async () => {
    home(); const d = seedPart("bravo", "codex", "demo");
    writeFileSync(join(d, "outbox.jsonl"),
      `{"event":"ack","task_summary":"x"}\n` +
      `{"event":"progress","note":"\\"event\\":\\"done\\" inside"}\n` +
      `{"event":"done","summary":"first"}\n` +
      `{"event":"done","summary":"actually finished"}\n`);
    const ev = await IPC.outboxWait("bravo", "codex", "demo", ["done", "error"], 5);
    expect(ev?.event).toBe("done");
    expect(ev?.summary).toBe("actually finished");
  });
  it("outboxWait times out → null", async () => {
    home(); seedPart("bravo", "codex", "demo");
    const ev = await IPC.outboxWait("bravo", "codex", "demo", ["done"], 1);
    expect(ev).toBeNull();
  });
  it("outboxWaitSince only matches after offset", async () => {
    home(); const d = seedPart("bravo", "codex", "demo");
    writeFileSync(join(d, "outbox.jsonl"), `{"event":"done","summary":"stale"}\n`);
    const off = IPC.outboxOffset(join(d, "outbox.jsonl"));
    const p = IPC.outboxWaitSince("bravo", "codex", "demo", off, ["done"], 3);
    writeFileSync(join(d, "outbox.jsonl"),
      `{"event":"done","summary":"stale"}\n{"event":"done","summary":"fresh"}\n`);
    const ev = await p;
    expect(ev?.summary).toBe("fresh");
  });
  it("outboxWaitSince re-reads when outbox shrinks below the offset", async () => {
    home(); const d = seedPart("bravo", "codex", "demo");
    writeFileSync(join(d, "outbox.jsonl"), `{"event":"ack"}\n{"event":"progress","note":"x"}\n`);
    const off = IPC.outboxOffset(join(d, "outbox.jsonl")); // large offset
    const p = IPC.outboxWaitSince("bravo", "codex", "demo", off, ["done"], 3);
    // simulate crash/recreate: file rewritten smaller, with a fresh done
    writeFileSync(join(d, "outbox.jsonl"), `{"event":"done","summary":"after-restart"}\n`);
    const ev = await p;
    expect(ev?.summary).toBe("after-restart");
  });
  it("event precedence: ready (listed first) beats a later error", async () => {
    home(); const d = seedPart("bravo", "codex", "demo");
    writeFileSync(join(d, "outbox.jsonl"), `{"event":"ready","ts":"t"}\n{"event":"error","message":"late","fatal":false}\n`);
    const ev = await IPC.outboxWait("bravo", "codex", "demo", ["ready", "error"], 3);
    expect(ev?.event).toBe("ready");
  });
  it("event precedence: done (listed first) beats error regardless of file order", async () => {
    home(); const d = seedPart("bravo", "codex", "demo");
    writeFileSync(join(d, "outbox.jsonl"), `{"event":"error","message":"x"}\n{"event":"done","summary":"ok"}\n`);
    const ev = await IPC.outboxWait("bravo", "codex", "demo", ["done", "error"], 3);
    expect(ev?.event).toBe("done");
  });
  it("event precedence: first-listed absent falls through to next", async () => {
    home(); const d = seedPart("bravo", "codex", "demo");
    writeFileSync(join(d, "outbox.jsonl"), `{"event":"error","message":"boom","fatal":true}\n`);
    const ev = await IPC.outboxWait("bravo", "codex", "demo", ["ready", "error"], 3);
    expect(ev?.event).toBe("error");
  });
});

describe("ipc outbox pane-liveness escape hatch", () => {
  it("returns a synthetic pane-died error after two consecutive dead polls", async () => {
    home(); seedPart("bravo", "codex", "demo");
    const ev = await IPC.outboxWaitSince("bravo", "codex", "demo", 0, ["done"], 5, {
      paneAlive: async () => false, paneId: "%1", everyS: 1,
    });
    expect(ev?.event).toBe("error");
    expect(ev?.note).toBe("pane-died");
  });
  it("a single dead poll then a live one does NOT short-circuit (no false kill)", async () => {
    home(); seedPart("bravo", "codex", "demo");
    let call = 0;
    const ev = await IPC.outboxWaitSince("bravo", "codex", "demo", 0, ["done"], 3, {
      paneAlive: async () => (++call === 1 ? false : true), paneId: "%1", everyS: 1,
    });
    expect(ev).toBeNull();   // recovered before two consecutive dead polls -> times out normally
  });
  it("a probe that throws (tmux server gone) counts as dead", async () => {
    home(); seedPart("bravo", "codex", "demo");
    const ev = await IPC.outboxWaitSince("bravo", "codex", "demo", 0, ["done"], 5, {
      paneAlive: async () => { throw new Error("no server running"); }, paneId: "%1", everyS: 1,
    });
    expect(ev?.note).toBe("pane-died");
  });
  it("a null paneId disables the check (never probes; degrades to plain wait)", async () => {
    home(); seedPart("bravo", "codex", "demo");
    let probed = false;
    const ev = await IPC.outboxWaitSince("bravo", "codex", "demo", 0, ["done"], 1, {
      paneAlive: async () => { probed = true; return false; }, paneId: null, everyS: 1,
    });
    expect(ev).toBeNull();
    expect(probed).toBe(false);
  });
  it("a terminal event in the outbox wins over a dead pane", async () => {
    home(); const d = seedPart("bravo", "codex", "demo");
    writeFileSync(join(d, "outbox.jsonl"), `{"event":"done","summary":"finished"}\n`);
    const ev = await IPC.outboxWaitSince("bravo", "codex", "demo", 0, ["done"], 5, {
      paneAlive: async () => false, paneId: "%1", everyS: 1,
    });
    expect(ev?.event).toBe("done");
    expect(ev?.summary).toBe("finished");
  });
});

describe("ipc pane meta", () => {
  it("paneMeta round-trips hyphenated model via JSON, not dir parse", () => {
    home(); seedPart("bravo", "claude-haiku", "demo");
    IPC.paneMetaWrite("bravo", "claude-haiku", "demo", "%99");
    const m = IPC.paneMetaReadForDir(workerDir("bravo", "claude-haiku", "demo"));
    expect(m).toEqual({ agent: "bravo", model: "claude-haiku", paneId: "%99" });
  });
});
