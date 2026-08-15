// tests/status-fail-closed.test.ts — the busy gate fails CLOSED on a status file that EXISTS but
// yields nothing (2026-08-15 spec). Two holes, both reproduced against the shipped dist: a
// zero-length status.json (what a worker SIGKILLed inside `> status.json` leaves behind) read as
// IDLE and let a send clobber the in-flight inbox, and a chmod-000 one threw an uncaught EACCES.
// The third shape — non-empty but unmatched content — is a spec'd, test-locked design decision
// (see artifact-completeness.test.ts "unreadable/state-less status.json reads as idle") and is
// asserted UNCHANGED here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { sendDeps } from "./helpers/phaseDeps.js";
import { exploreArtDir } from "../src/core/explore.js";
import { researchSendWith } from "../src/commands/explore.js";
import {
  STATUS_UNREADABLE, seedWorkerStatus, statusPath, workerBusyState, workerSendGate,
  workerStatusReport,
} from "../src/core/ipc.js";
import { workerDir } from "../src/core/paths.js";

const TOPIC = "x";
const AGENT = "alpha";
const PROVIDER = "codex";

let h: { home: string; cleanup: () => void };
beforeEach(() => { h = freshHome(); });
afterEach(() => h.cleanup());

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

/** _explore art dir + worker dir, the state a research-send runs against. Returns the art dir. */
function seed(): string {
  const art = exploreArtDir(TOPIC);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "topic.txt"), "attention kernels");
  writeFileSync(join(art, "list.txt"), `${PROVIDER}\t${AGENT}\n`);
  mkdirSync(workerDir(AGENT, PROVIDER, TOPIC), { recursive: true });
  return art;
}

/** dispatchPrompt's rc-3 busy-gate, reached through explore's research send. */
async function research(): Promise<{ rc: number; sent: boolean; err: string }> {
  const send = vi.fn(async () => 0);
  const err = captureStderr();
  let rc: number;
  try { rc = await researchSendWith(TOPIC, AGENT, PROVIDER, sendDeps({ offsetFor: () => 1, send })); } finally { err.restore(); }
  return { rc, sent: send.mock.calls.length > 0, err: err.text() };
}

// Root ignores mode bits, so a chmod-000 file stays readable and the refusal never fires. CI runs as
// root in a container; skip there rather than assert something the uid makes untrue.
const asRoot = process.getuid?.() === 0;

describe("busy gate on an unreadable status.json", () => {
  it("zero-length status.json refuses the send (rc 3), no state file, inbox untouched", async () => {
    const art = seed();
    writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), "");
    const { rc, sent, err } = await research();
    expect(rc).toBe(3);
    expect(sent).toBe(false);
    expect(err).toContain(`worker ${AGENT} busy (state=${STATUS_UNREADABLE})`);
    expect(existsSync(join(art, `research-${AGENT}.txt`))).toBe(false);
  });

  it("whitespace-only status.json is the same crash remnant — still refuses", () => {
    seed();
    writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), "\n  \n");
    expect(workerBusyState(AGENT, PROVIDER, TOPIC)).toBe(STATUS_UNREADABLE);
  });

  it.skipIf(asRoot)("chmod-000 status.json refuses cleanly instead of throwing EACCES", async () => {
    const art = seed();
    const sp = statusPath(AGENT, PROVIDER, TOPIC);
    writeFileSync(sp, '{"state":"working","last_event":"progress"}\n');
    chmodSync(sp, 0o000);
    try {
      const { rc, sent, err } = await research();
      expect(rc).toBe(3);
      expect(sent).toBe(false);
      expect(err).toContain(`worker ${AGENT} busy (state=${STATUS_UNREADABLE})`);
      expect(existsSync(join(art, `research-${AGENT}.txt`))).toBe(false);
      // The guard's evidence leg (a) reads the same file through workerStatusReport: it must answer
      // "silence", not throw ahead of the other legs.
      expect(workerStatusReport(AGENT, PROVIDER, TOPIC)).toBe("absent");
    } finally { chmodSync(sp, 0o644); }
  });

  it("workerSendGate (implement's turn gate) refuses on the same two shapes", () => {
    seed();
    writeFileSync(join(workerDir(AGENT, PROVIDER, TOPIC), "outbox.jsonl"), "");
    const err = captureStderr();
    try {
      writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), "");
      expect(workerSendGate(AGENT, PROVIDER, TOPIC, "implement turn-send", "turn")).toBe(false);
    } finally { err.restore(); }
    expect(err.text()).toContain(`worker not idle (state=${STATUS_UNREADABLE})`);
  });
});

describe("the shapes that must NOT change", () => {
  it("absent status.json stays idle — the send proceeds", async () => {
    const art = seed();
    expect(existsSync(statusPath(AGENT, PROVIDER, TOPIC))).toBe(false);
    const { rc, sent } = await research();
    expect(rc).toBe(0);
    expect(sent).toBe(true);
    expect(existsSync(join(art, `research-${AGENT}.txt`))).toBe(true);
  });

  it("the spawn seed stays idle — a fresh worker is dispatchable", async () => {
    seed();
    seedWorkerStatus(AGENT, PROVIDER, TOPIC);
    expect(workerBusyState(AGENT, PROVIDER, TOPIC)).toBeNull();
    const { rc, sent } = await research();
    expect(rc).toBe(0);
    expect(sent).toBe(true);
  });

  it("non-empty but unmatched content still reads as idle (spec'd: a drifted format is not a lockout)", async () => {
    seed();
    writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), "not json at all");
    expect(workerBusyState(AGENT, PROVIDER, TOPIC)).toBeNull();
    const { rc, sent } = await research();
    expect(rc).toBe(0);
    expect(sent).toBe(true);
  });

  it("a healthy working status still refuses with its own state name", async () => {
    seed();
    writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), '{"state":"working","last_event":"progress"}\n');
    const { rc, sent, err } = await research();
    expect(rc).toBe(3);
    expect(sent).toBe(false);
    expect(err).toContain(`worker ${AGENT} busy (state=working)`);
  });
});
