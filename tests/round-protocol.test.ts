// tests/round-protocol.test.ts — the shared send/wait skeleton (src/core/roundProtocol.ts) seen
// through BOTH descriptors, driven via each command's own binding.
//
// The per-command suites (quick-cmd, bridge-cmd, turn-confirm) still pin each command's behavior;
// what this file pins is the skeleton's ORDER and the descriptor's slots, so the three mutations the
// collapse could hide all fail here: swapping two slot values (every assertion names the row's own
// filename/wording, and the other row's filenames must be absent), moving the offset capture after
// the send (the send dep reads the state file at dispatch time), and dropping the gate (a busy
// worker must refuse without sending).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { noSleepClock } from "./helpers/clock.js";
import { workerDir } from "../src/core/paths.js";
import { turnSendWith, turnWaitWith } from "../src/commands/quick.js";
import { roundSendWith, roundWaitWith } from "../src/commands/bridge.js";
import { quickArtDir, quickExecDir } from "../src/core/quick.js";
import { bridgeArtDir, bridgeExecDir } from "../src/core/bridge.js";
import type { RoundSendDeps, RoundWaitDeps } from "../src/core/roundProtocol.js";

const T = "auth";
const MARK = "MARKER-TEXT-42";

/** Whatever the code under test wrote to stderr while fn() ran (log.error/warn/info land there). */
async function withStderr(fn: () => Promise<number>): Promise<{ rc: number; err: string }> {
  const chunks: string[] = [];
  const se = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => { chunks.push(String(s)); return true; }) as typeof process.stderr.write;
  try { return { rc: await fn(), err: chunks.join("") }; }
  finally { process.stderr.write = se; }
}

interface Row {
  name: string;
  agent: string;
  send(topic: string, round: number, d: RoundSendDeps): Promise<number>;
  wait(topic: string, round: number, d: RoundWaitDeps): Promise<number>;
  art(topic: string): string;
  exec(topic: string): string;
  /** The identity + round-1 input files a live init/branch would have left behind. */
  seedIdentity(): void;
  sendLabel: string;
  waitLabel: string;
  initHint: string;
  gateNoun: string;
  missingBundle: string;
  /** The branch `seedIdentity` records (deliberately NOT the fallback), and the fallback the
   *  round-1 composer substitutes when branch.txt is gone. */
  seededBranch: string;
  branchFallback: string;
  /** This command's own turn-budget knob, and the value the timeout pin sets it to. */
  timeoutEnv: string;
  timeoutValue: number;
  /** The wait binding re-imported after `vi.resetModules()`, so the module-level `envNum` budget is
   *  read again. A literal import path per row keeps it statically analyzable. */
  loadWait(): Promise<(topic: string, round: number, d: RoundWaitDeps) => Promise<number>>;
  state(round: number): string;
  prompt(round: number): string;
  bundle(round: number): string;
  question(round: number): string;
  /** A literal only THIS command's composers emit (round 1 / round >= 2, the latter carrying the
   *  round number so a follow-up composed for the wrong round fails). */
  firstMark: string;
  followupMark(round: number): string;
  /** The other descriptor's state + prompt files, which this row must never write. */
  foreign(round: number): string[];
}

const QUICK: Row = {
  name: "quick",
  agent: "bravo",
  send: turnSendWith,
  wait: turnWaitWith,
  art: quickArtDir,
  exec: quickExecDir,
  seedIdentity: () => {
    writeFileSync(join(quickArtDir(T), "task-brief.md"), `## Goal\n${MARK}`);
    writeFileSync(join(quickExecDir(T), "branch.txt"), "feat/quick-SEEDED\n");
  },
  sendLabel: "quick turn-send",
  waitLabel: "quick turn-wait",
  initHint: "run quick init",
  gateNoun: "turn",
  missingBundle: "fix bundle missing",
  seededBranch: "feat/quick-SEEDED",
  branchFallback: `feat/quick-${T}`,
  timeoutEnv: "AP_QUICK_TURN_TIMEOUT",
  timeoutValue: 111,
  loadWait: async () => (await import("../src/commands/quick.js")).turnWaitWith,
  state: (r) => join(quickExecDir(T), `turn-${r}.txt`),
  prompt: (r) => join(quickExecDir(T), `turn-prompt-${r}.md`),
  bundle: (r) => join(quickExecDir(T), `fix-prompt-${r}.md`),
  question: (r) => join(quickExecDir(T), `question-${r}.txt`),
  firstMark: "This is one autonomous turn",
  followupMark: (r) => `ROUND ${r} of /ap:quick (fix loop)`,
  foreign: (r) => [join(quickExecDir(T), `round-${r}.txt`), join(quickExecDir(T), `round-prompt-${r}.md`)],
};

const BRIDGE: Row = {
  name: "bridge",
  agent: "alpha",
  send: roundSendWith,
  wait: roundWaitWith,
  art: bridgeArtDir,
  exec: bridgeExecDir,
  seedIdentity: () => {
    writeFileSync(join(bridgeArtDir(T), "topic-text.txt"), MARK);
    writeFileSync(join(bridgeExecDir(T), "target_cwd.txt"), "/abs/repoB\n");
    writeFileSync(join(bridgeExecDir(T), "branch.txt"), "feat/bridge-SEEDED\n");
  },
  sendLabel: "bridge round-send",
  waitLabel: "bridge round-wait",
  initHint: "run bridge init",
  gateNoun: "round",
  missingBundle: "follow-up bundle missing",
  seededBranch: "feat/bridge-SEEDED",
  branchFallback: "the current branch",
  timeoutEnv: "AP_DUET_TURN_TIMEOUT",
  timeoutValue: 222,
  loadWait: async () => (await import("../src/commands/bridge.js")).roundWaitWith,
  state: (r) => join(bridgeExecDir(T), `round-${r}.txt`),
  prompt: (r) => join(bridgeExecDir(T), `round-prompt-${r}.md`),
  bundle: (r) => join(bridgeExecDir(T), `followup-${r}.md`),
  question: (r) => join(bridgeExecDir(T), `question-${r}.txt`),
  firstMark: "You are collaborating with a conductor",
  followupMark: (r) => `round ${r}, still on the same branch`,
  foreign: (r) => [join(bridgeExecDir(T), `turn-${r}.txt`), join(bridgeExecDir(T), `turn-prompt-${r}.md`)],
};

describe.each([QUICK, BRIDGE])("round protocol via $name", (row) => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); seed(); });
  afterEach(() => { h.cleanup(); });

  /** A worker that was spawned and is idle, plus the command's identity + round-1 input files. */
  function seed(): void {
    mkdirSync(row.exec(T), { recursive: true });
    writeFileSync(join(row.art(T), "agent.txt"), row.agent + "\n");
    writeFileSync(join(row.art(T), "selected-provider.txt"), "codex\n");
    row.seedIdentity();
    const pd = workerDir(row.agent, "codex", T);
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "outbox.jsonl"), "");
    writeFileSync(join(pd, "status.json"), JSON.stringify({ state: "idle" }) + "\n");
  }

  function sendDeps(over: Partial<RoundSendDeps> = {}): RoundSendDeps & { sent: string[][] } {
    const sent: string[][] = [];
    return { sent, offsetFor: () => 42, send: async (a) => { sent.push(a); return 0; }, ...over };
  }

  it("missing identity files: the error names this command's own init hint", async () => {
    writeFileSync(join(row.art(T), "agent.txt"), "\n");
    const { rc, err } = await withStderr(() => row.send(T, 1, sendDeps()));
    expect(rc).toBe(1);
    expect(err).toContain(`${row.sendLabel}: missing agent.txt/selected-provider.txt (${row.initHint})`);
  });

  it("the gate refuses a worker that is not idle: rc 1, nothing sent, no state file", async () => {
    writeFileSync(join(workerDir(row.agent, "codex", T), "status.json"), JSON.stringify({ state: "working" }) + "\n");
    const d = sendDeps();
    const { rc, err } = await withStderr(() => row.send(T, 1, d));
    expect(rc).toBe(1);
    expect(d.sent).toEqual([]);
    expect(existsSync(row.state(1))).toBe(false);
    // The whole line, not just the label: the unit is the `gateNoun` slot, and a swapped one
    // survives every other assertion in the suite.
    expect(err).toContain(`${row.sendLabel}: worker not idle (state=working); previous ${row.gateNoun} still in flight`);
  });

  it("an existing state file refuses the round and leaves it untouched", async () => {
    writeFileSync(row.state(1), "OFFSET=7\n");
    const d = sendDeps();
    const { rc, err } = await withStderr(() => row.send(T, 1, d));
    expect(rc).toBe(1);
    expect(d.sent).toEqual([]);
    expect(readFileSync(row.state(1), "utf8")).toBe("OFFSET=7\n");
    expect(err).toContain(`${row.sendLabel}: ${row.state(1)} already exists; rm to retry`);
  });

  it("round 1: writes THIS command's prompt + state files (and none of the other's)", async () => {
    const d = sendDeps();
    expect(await row.send(T, 1, d)).toBe(0);
    expect(readFileSync(row.state(1), "utf8")).toBe("OFFSET=42\n");
    const prompt = readFileSync(row.prompt(1), "utf8");
    expect(prompt).toContain(MARK);              // composeFirst read this command's own round-1 input
    expect(prompt).toContain(row.firstMark);     // ...through this command's own composer
    expect(prompt).toContain(row.seededBranch);  // ...and the branch recorded by its branch step
    expect(d.sent).toEqual([[row.agent, T, `@${row.prompt(1)}`]]);
    for (const f of row.foreign(1)) expect(existsSync(f)).toBe(false);
  });

  it("round 1 without branch.txt: this command's own branch fallback", async () => {
    rmSync(join(row.exec(T), "branch.txt"));
    expect(await row.send(T, 1, sendDeps())).toBe(0);
    const prompt = readFileSync(row.prompt(1), "utf8");
    expect(prompt).toContain(row.branchFallback);
    expect(prompt).not.toContain(row.seededBranch);
  });

  it("round 2 without its bundle: rc 1, in this command's own wording", async () => {
    const d = sendDeps();
    const { rc, err } = await withStderr(() => row.send(T, 2, d));
    expect(rc).toBe(1);
    expect(d.sent).toEqual([]);
    expect(err).toContain(`${row.sendLabel}: ${row.missingBundle}: ${row.bundle(2)} (the directive must write it first)`);
  });

  it("a later round with its bundle: the follow-up composer wraps it, for THAT round", async () => {
    writeFileSync(row.bundle(3), MARK);
    expect(await row.send(T, 3, sendDeps())).toBe(0);
    const prompt = readFileSync(row.prompt(3), "utf8");
    expect(prompt).toContain(MARK);
    expect(prompt).toContain(row.followupMark(3));  // the round argument is threaded, not fixed at 2
  });

  it("the offset is captured and written BEFORE the send", async () => {
    let atSend: string | null = null;
    const d = sendDeps({
      send: async () => { atSend = existsSync(row.state(1)) ? readFileSync(row.state(1), "utf8") : null; return 0; },
    });
    expect(await row.send(T, 1, d)).toBe(0);
    expect(atSend).toBe("OFFSET=42\n"); // an offset read after the send would miss an instant reply
  });

  it("a failed send keeps the state file for the retry", async () => {
    const { rc, err } = await withStderr(() => row.send(T, 1, sendDeps({ send: async () => 2 })));
    expect(rc).toBe(1);
    expect(readFileSync(row.state(1), "utf8")).toBe("OFFSET=42\n");
    expect(err).toContain(`${row.sendLabel}: send failed (rc=2); ${row.state(1)} kept for retry`);
  });

  it("wait: a missing state file points at this command's own send verb", async () => {
    const { rc, err } = await withStderr(() => row.wait(T, 1, { wait: async () => null, clock: noSleepClock }));
    expect(rc).toBe(1);
    expect(err).toContain(`${row.waitLabel}: ${row.state(1)} missing (run ${row.sendLabel} first)`);
  });

  it("wait: a missing OFFSET names this command's own state file", async () => {
    writeFileSync(row.state(1), "TS=stale\n");
    const { rc, err } = await withStderr(() => row.wait(T, 1, { wait: async () => null, clock: noSleepClock }));
    expect(rc).toBe(1);
    expect(err).toContain(`${row.waitLabel}: OFFSET not set in ${row.state(1)}`);
  });

  it("wait: done appends TS=ok, under this command's own label and timeout", async () => {
    writeFileSync(row.state(1), "OFFSET=0\n");
    const { rc, err } = await withStderr(() =>
      row.wait(T, 1, { wait: async () => ({ event: "done", summary: "ok" }), clock: noSleepClock }));
    expect(rc).toBe(0);
    expect(readFileSync(row.state(1), "utf8")).toBe("OFFSET=0\nTS=ok\n");
    expect(err).toContain(`${row.waitLabel}: round=1 offset=0 timeout=14400s`);
    expect(err).toContain(`${row.waitLabel}: round=1 TS=ok`);
  });

  it("wait: the budget comes from this command's OWN knob", async () => {
    // Both knobs default to DEFAULT_TURN_BUDGET_S, so only the NAME distinguishes the two slots:
    // set both to different values and each row must log its own. envNum runs at module load, hence
    // the reset + re-import (the setup file clears both knobs for every other test in the suite).
    writeFileSync(row.state(1), "OFFSET=0\n");
    process.env.AP_QUICK_TURN_TIMEOUT = "111";
    process.env.AP_DUET_TURN_TIMEOUT = "222";
    try {
      vi.resetModules();
      const waitFor = await row.loadWait();
      const { rc, err } = await withStderr(() =>
        waitFor(T, 1, { wait: async () => ({ event: "done", summary: "ok" }), clock: noSleepClock }));
      expect(rc).toBe(0);
      expect(err).toContain(`${row.waitLabel}: round=1 offset=0 timeout=${row.timeoutValue}s`);
    } finally {
      delete process.env.AP_QUICK_TURN_TIMEOUT;
      delete process.env.AP_DUET_TURN_TIMEOUT;
      vi.resetModules();
    }
  });

  it("wait: a question writes this command's question file and bumps OFFSET for the re-arm", async () => {
    writeFileSync(row.state(1), "OFFSET=0\n");
    const body = '{"event":"question","message":"which db?"}\n';
    writeFileSync(join(workerDir(row.agent, "codex", T), "outbox.jsonl"), body);
    const seen: number[] = [];
    const wait = async (_i: string, _m: string, _t: string, off: number) => {
      seen.push(off);
      return seen.length === 1 ? { event: "question", message: "which db?" } : { event: "done", summary: "ok" };
    };
    expect(await row.wait(T, 1, { wait, clock: noSleepClock })).toBe(0);
    expect(await row.wait(T, 1, { wait, clock: noSleepClock })).toBe(0);
    expect(readFileSync(row.question(1), "utf8")).toContain("which db?");
    expect(seen).toEqual([0, Buffer.byteLength(body)]); // the re-arm resumed past the handled question
  });
});
