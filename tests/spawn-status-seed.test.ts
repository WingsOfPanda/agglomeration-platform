import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import * as IPC from "../src/core/ipc.js";
import { prepareWorkerState } from "../src/commands/spawn.js";
import { workerDir } from "../src/core/paths.js";

const cleanups: Array<() => void> = [];
const ORIG_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
beforeEach(() => { process.env.CLAUDE_PLUGIN_ROOT = process.cwd(); });
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (ORIG_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = ORIG_ROOT;
});
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h.home; }
function seedPart(i: string, m: string, t: string) { const d = workerDir(i, m, t); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "outbox.jsonl"), ""); return d; }

describe("seedWorkerStatus", () => {
  it("writes state=idle / last_event=spawn / second-precision UTC updated at statusPath", () => {
    home(); seedPart("bravo", "codex", "demo");
    IPC.seedWorkerStatus("bravo", "codex", "demo", new Date("2026-08-08T01:02:03.456Z"));
    const o = JSON.parse(readFileSync(IPC.statusPath("bravo", "codex", "demo"), "utf8"));
    expect(o.state).toBe("idle");
    expect(o.last_event).toBe("spawn");
    expect(o.updated).toBe("2026-08-08T01:02:03Z");
  });
  it("the seeded worker reads as not busy and passes the send gate", () => {
    home(); seedPart("bravo", "codex", "demo");
    IPC.seedWorkerStatus("bravo", "codex", "demo");
    expect(IPC.workerBusyState("bravo", "codex", "demo")).toBeNull();
    expect(IPC.workerSendGate("bravo", "codex", "demo", "test", "turn")).toBe(true);
  });
  it("unconditional overwrite: seeding replaces any existing status (defence-in-depth; stateInit clears it on the real path)", () => {
    home(); seedPart("bravo", "codex", "demo");
    writeFileSync(IPC.statusPath("bravo", "codex", "demo"), '{"state":"working"}\n');
    expect(IPC.workerBusyState("bravo", "codex", "demo")).toBe("working");
    IPC.seedWorkerStatus("bravo", "codex", "demo");
    expect(IPC.workerBusyState("bravo", "codex", "demo")).toBeNull();
    expect(JSON.parse(readFileSync(IPC.statusPath("bravo", "codex", "demo"), "utf8")).state).toBe("idle");
  });
  it("state filename stays status.json (frozen)", () => {
    home();
    expect(basename(IPC.statusPath("bravo", "codex", "demo"))).toBe("status.json");
  });
});

describe("prepareWorkerState", () => {
  it("one call leaves identity.md and an idle status.json in the worker dir", () => {
    home();
    prepareWorkerState("bravo", "codex", "demo");
    expect(existsSync(IPC.identityPath("bravo", "codex", "demo"))).toBe(true);
    expect(existsSync(join(workerDir("bravo", "codex", "demo"), "outbox.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(IPC.statusPath("bravo", "codex", "demo"), "utf8")).state).toBe("idle");
  });
});
