// tests/worker-liveness.test.ts — L2: a worker that dies is loud within minutes.
//
// The run this layer exists for (issue #157) burned 10.5h of a 14h budget while every status
// surface read `LIVENESS=alive HUB_STATE=working PARKED=no`. Its worker's spawn had been SIGTERMed
// 30s before its own ready deadline, so status.json stayed frozen at the platform-written seed
// (`{"state":"idle","last_event":"spawn"}`) and its outbox stayed empty — the exact fixture below.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { virtualClock } from "./helpers/clock.js";
import * as J from "../src/core/job.js";
import { scanTopicWorkers, readWorkerRec, readWorkerStatusRec } from "../src/core/workerLiveness.js";
import { outboxWaitSince, outboxPath } from "../src/core/ipc.js";
import { topicDir, workerDir } from "../src/core/paths.js";
import { run as jobRun, waitRun } from "../src/commands/job.js";
import { run as listRun } from "../src/commands/list.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h.home; }

/** The KV report goes to stdout, so it is only observable here (same shape as job-cmd.test.ts). */
async function capture(fn: () => Promise<number>): Promise<{ rc: number; out: string }> {
  const out: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  try { const rc = await fn(); return { rc, out: out.join("") }; }
  finally { process.stdout.write = so; }
}
const JS = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("JS="));

const NONCE = "ace6b021-d592-48aa-8a59-ba5860417a78";   // the field run's own pane nonce
const PANE = "%89";                                      // and its pane id
const SPAWNED = "2026-08-25T15:03:33Z";
const T_LATER = Date.parse("2026-08-25T15:10:00Z");      // 387s later; codex's deadline is 230s

const rec = (over: Partial<J.WorkerRec> = {}): J.WorkerRec =>
  ({ agent: "delta", model: "codex", paneId: PANE, nonce: NONCE, spawnedAt: SPAWNED, ...over });
const seedStatus: J.WorkerStatusRec = { state: "idle", lastEvent: "spawn" };
const livePane = (): Map<string, string> => new Map([[PANE, NONCE]]);
const noPanes = (): Map<string, string> => new Map();

// ---------------------------------------------------------------- the classifier

describe("classifyWorkerLiveness — one ordered table, first match wins", () => {
  it("rule 1: a status the worker itself reported as over is `terminal`, and never a death", () => {
    for (const state of ["done", "complete", "error", "DONE", " error "]) {
      const v = J.classifyWorkerLiveness(rec(), { state, lastEvent: "done" }, 3, noPanes(), 2, T_LATER);
      expect(v.verdict, state).toBe("terminal");
      expect(v.dead, state).toBe(false);
    }
  });

  // The whole reason this layer has its own state set. ipc.ts's TERMINAL_WORKER_STATES is the
  // send-side "not busy" gate and it CONTAINS `idle` and `ready`; the field case's status was
  // `state: idle`. Keying rule 1 on that set would call the dead worker `terminal` and hide the bug
  // this file was written for.
  it("rule 1 does NOT key on ipc's TERMINAL_WORKER_STATES: `idle` and `ready` are not over", () => {
    for (const state of ["idle", "ready"]) {
      const v = J.classifyWorkerLiveness(rec(), { state, lastEvent: "spawn" }, 0, noPanes(), 0, T_LATER);
      expect(v.verdict, state).not.toBe("terminal");
      expect(v.verdict, state).toBe("bootstrap-dead");
    }
  });

  it("rule 2: an expired seed with an EMPTY outbox is bootstrap-dead, and it is TERMINAL", () => {
    const v = J.classifyWorkerLiveness(rec(), seedStatus, 0, noPanes(), 0, T_LATER);
    expect(v).toEqual({ kind: "bootstrap-dead", verdict: "bootstrap-dead", dead: true, misses: 0 });
  });

  // The adversarial ordering case. A LIVE pane behind an expired seed is the killed-parent case:
  // spawn was SIGTERMed before it could stamp the failure, so a model TUI is still sitting there
  // that was never handed a task. Rule 3 first would report it `alive` for as long as it runs.
  it("rule 2 beats rule 3: a LIVE pane with an expired seed is still bootstrap-dead", () => {
    const v = J.classifyWorkerLiveness(rec(), seedStatus, 0, livePane(), 0, T_LATER);
    expect(v.verdict).toBe("bootstrap-dead");
    expect(v.dead).toBe(true);
  });

  it("rule 2 does not fire while the deadline has room, nor once the worker has spoken", () => {
    const early = Date.parse("2026-08-25T15:05:00Z");   // 87s in; codex's deadline is 20+150+60
    expect(J.classifyWorkerLiveness(rec(), seedStatus, 0, livePane(), 0, early).verdict).toBe("alive");
    expect(J.classifyWorkerLiveness(rec(), seedStatus, 0, noPanes(), 0, early).verdict).toBe("pane-missing (1/3)");
    // an outbox with anything in it means the worker DID report: the seed is stale, not expired
    expect(J.classifyWorkerLiveness(rec(), seedStatus, 1, livePane(), 0, T_LATER).verdict).toBe("alive");
  });

  it("rule 2 never fires on a spawn time it cannot measure", () => {
    for (const spawnedAt of ["", "not-a-date", "yesterday"]) {
      const v = J.classifyWorkerLiveness(rec({ spawnedAt }), seedStatus, 0, livePane(), 0, T_LATER);
      expect(v.verdict, spawnedAt).toBe("alive");
    }
  });

  it("rule 3: the pane carrying the recorded nonce is alive, and RESETS the miss counter", () => {
    const v = J.classifyWorkerLiveness(rec(), { state: "working", lastEvent: "ack" }, 4, livePane(), 2, T_LATER);
    expect(v).toEqual({ kind: "alive", verdict: "alive", dead: false, misses: 0 });
  });

  it("rule 4: an unverifiable nonce (or no pane id) is `unknown`, never dead", () => {
    const working = { state: "working", lastEvent: "ack" };
    for (const r of [rec({ nonce: "" }), rec({ nonce: "legacy-id" }), rec({ paneId: "" })]) {
      const v = J.classifyWorkerLiveness(r, working, 4, noPanes(), 2, T_LATER);
      expect(v.verdict).toBe("unknown");
      expect(v.dead).toBe(false);
      expect(v.misses).toBe(2);   // neither a hit nor a miss: the count is left exactly as it was
    }
  });

  it("rules 5/6: a foreign or absent pane counts misses, and only the third is terminal", () => {
    const working = { state: "working", lastEvent: "ack" };
    const foreign = new Map([[PANE, "11111111-2222-3333-4444-555555555555"]]);
    expect(J.classifyWorkerLiveness(rec(), working, 4, noPanes(), 0, T_LATER).verdict).toBe("pane-missing (1/3)");
    expect(J.classifyWorkerLiveness(rec(), working, 4, foreign, 1, T_LATER).verdict).toBe("pane-missing (2/3)");
    const dead = J.classifyWorkerLiveness(rec(), working, 4, noPanes(), 2, T_LATER);
    expect(dead).toEqual({ kind: "pane-dead", verdict: "pane-dead", dead: true, misses: 3 });
  });

  // The empty-snapshot hazard: livePaneNonces() returns an EMPTY map on ANY tmux error, so a single
  // miss read as terminal would end a healthy multi-hour run on one hiccup.
  it("ONE empty snapshot then recovery is never terminal: pane-missing (1/3), then alive", () => {
    const working = { state: "working", lastEvent: "ack" };
    const miss = J.classifyWorkerLiveness(rec(), working, 4, noPanes(), 0, T_LATER);
    expect(miss.verdict).toBe("pane-missing (1/3)");
    expect(miss.dead).toBe(false);
    const back = J.classifyWorkerLiveness(rec(), working, 4, livePane(), miss.misses, T_LATER);
    expect(back.verdict).toBe("alive");
    expect(back.misses).toBe(0);   // and the count is back to zero, so the next miss starts over
  });

  // The field case, reproduced from the ARCHIVED records of the run in issue #157.
  it("THE FIELD CASE: %89 / seed status / empty outbox / snapshot without it -> bootstrap-dead", () => {
    const v = J.classifyWorkerLiveness(
      { agent: "delta", model: "codex", paneId: "%89", nonce: NONCE, spawnedAt: "2026-08-25T15:03:33Z" },
      { state: "idle", lastEvent: "spawn" }, 0, new Map([["%3", NONCE]]), 0,
      Date.parse("2026-08-25T15:10:00Z"),
    );
    expect(v.verdict).toBe("bootstrap-dead");
    expect(v.dead).toBe(true);
  });
});

describe("bootstrapDeadlineS — spawn's own per-model deadline, plus a grace", () => {
  it("reads contracts.yaml per model rather than a constant", () => {
    expect(J.bootstrapDeadlineS("codex")).toBe(20 + 150 + 60);
    expect(J.bootstrapDeadlineS("claude")).toBe(12 + 150 + 60);
    // an unknown provider still gets a finite deadline from the accessors' own defaults
    expect(J.bootstrapDeadlineS("nosuch")).toBeGreaterThan(60);
  });
});

describe("the miss-counter file codec", () => {
  it("round-trips, and ends with a newline like every other state file", () => {
    const m = { "delta-codex": { misses: 2, last_seen: "2026-08-25T15:03:33Z" } };
    expect(J.formatWorkerMisses(m).endsWith("\n")).toBe(true);
    expect(J.parseWorkerMisses(J.formatWorkerMisses(m))).toEqual(m);
  });
  it("every unusable shape reads as NO counts — a torn file restarts the count, never fabricates one", () => {
    for (const text of ["", "{half-writ", "null", "[1,2]", '{"a":null}', '{"a":{"misses":"3"}}', '{"a":{"misses":-4}}']) {
      const out = J.parseWorkerMisses(text);
      expect(Object.values(out).every((v) => v.misses === 0), text).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- the scan (I/O)

/** A worker dir exactly as spawn leaves one. `outbox` defaults to the empty file spawn creates. */
function seedWorker(topic: string, agent: string, model: string, over?: {
  spawnedAt?: string; paneId?: string; nonce?: string; state?: string; lastEvent?: string; outbox?: string;
}): string {
  const dir = workerDir(agent, model, topic);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pane.json"), JSON.stringify({
    pane_id: over?.paneId ?? PANE, pane_nonce: over?.nonce ?? NONCE,
    agent, model, spawned_at: over?.spawnedAt ?? SPAWNED,
  }) + "\n");
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    state: over?.state ?? "idle", updated: SPAWNED, last_event: over?.lastEvent ?? "spawn",
  }) + "\n");
  writeFileSync(join(dir, "outbox.jsonl"), over?.outbox ?? "");
  return dir;
}

const REC: J.JobRecord = {
  command: "quick", topic: "demo", session: "ap-demo",
  hub: { agent: "alpha", model: "claude" },
  provider: "codex", finish: "keep", budget_hours: 14, max_rounds: 5,
  args_file: "/tmp/args", started: SPAWNED,
};
function seedJob(): void {
  const p = J.jobPath(REC.topic);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, J.formatJob(REC));
}

describe("scanTopicWorkers — the records the platform already holds", () => {
  it("classifies each worker dir and excludes the hub by name", () => {
    home();
    seedJob();
    seedWorker("demo", "alpha", "claude");        // the HUB's own dir
    seedWorker("demo", "delta", "codex");
    const rows = scanTopicWorkers("demo", noPanes(), T_LATER, { exclude: "alpha-claude" });
    expect(rows).toEqual([{ worker: "delta-codex", verdict: "bootstrap-dead", dead: true }]);
  });

  it("skips artifact dirs, and answers [] for a topic with no state at all", () => {
    home();
    mkdirSync(join(topicDir("demo"), "_quick"), { recursive: true });
    expect(scanTopicWorkers("demo", noPanes(), T_LATER)).toEqual([]);
    expect(scanTopicWorkers("nosuch", noPanes(), T_LATER)).toEqual([]);
  });

  it("persists the counter only when asked, and any hit resets it", () => {
    home();
    seedJob();
    // a REPORTING worker (rule 2 cannot fire), whose pane is missing
    seedWorker("demo", "delta", "codex", { state: "working", lastEvent: "ack", outbox: '{"event":"ack"}\n' });
    const path = J.workerLivenessPath("demo");

    // a read-only scan (ap list) reports the miss but records nothing
    expect(scanTopicWorkers("demo", noPanes(), T_LATER)[0].verdict).toBe("pane-missing (1/3)");
    expect(existsSync(path)).toBe(false);

    // the run's own rescans advance it; the THIRD consecutive miss is the death
    expect(scanTopicWorkers("demo", noPanes(), T_LATER, { persist: true })[0].verdict).toBe("pane-missing (1/3)");
    expect(scanTopicWorkers("demo", noPanes(), T_LATER, { persist: true })[0].verdict).toBe("pane-missing (2/3)");
    expect(J.parseWorkerMisses(readFileSync(path, "utf8"))["delta-codex"].misses).toBe(2);
    // ...unless the pane comes back, which resets the count to zero
    expect(scanTopicWorkers("demo", livePane(), T_LATER, { persist: true })[0].verdict).toBe("alive");
    expect(J.parseWorkerMisses(readFileSync(path, "utf8"))["delta-codex"].misses).toBe(0);
    expect(J.parseWorkerMisses(readFileSync(path, "utf8"))["delta-codex"].last_seen).not.toBe("");

    for (let i = 0; i < 2; i++) scanTopicWorkers("demo", noPanes(), T_LATER, { persist: true });
    expect(scanTopicWorkers("demo", noPanes(), T_LATER, { persist: true })[0]).toEqual(
      { worker: "delta-codex", verdict: "pane-dead", dead: true });
  });

  it("reads a torn or absent pane.json as unverifiable, never as dead", () => {
    home();
    const dir = workerDir("delta", "codex", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "working", last_event: "ack" }) + "\n");
    writeFileSync(join(dir, "outbox.jsonl"), '{"event":"ack"}\n');
    expect(scanTopicWorkers("demo", noPanes(), T_LATER)[0]).toEqual(
      { worker: "delta-codex", verdict: "unknown", dead: false });
    expect(readWorkerRec(dir).spawnedAt).toBe("");
    writeFileSync(join(dir, "pane.json"), "{half-writ");
    expect(readWorkerRec(dir).spawnedAt).toBe("");
    expect(scanTopicWorkers("demo", noPanes(), T_LATER)[0].verdict).toBe("unknown");
  });

  it("reads an absent or empty status.json as no status at all", () => {
    home();
    const dir = workerDir("delta", "codex", "demo");
    mkdirSync(dir, { recursive: true });
    expect(readWorkerStatusRec(dir)).toBeNull();
    writeFileSync(join(dir, "status.json"), "   \n");
    expect(readWorkerStatusRec(dir)).toBeNull();
    // ...and tolerates a pretty-printed one, the way every other status reader does
    writeFileSync(join(dir, "status.json"), '{\n  "state": "working",\n  "last_event": "ack"\n}\n');
    expect(readWorkerStatusRec(dir)).toEqual({ state: "working", lastEvent: "ack" });
  });
});

// ---------------------------------------------------------------- the surfaces

describe("job status — one WORKER= line per worker, the hub excluded", () => {
  it("names each worker and its verdict, and adds lines without changing any", async () => {
    home();
    seedJob();
    seedWorker("demo", "alpha", "claude");
    seedWorker("demo", "delta", "codex");
    const { out } = await capture(() => jobRun(["status", "demo"]));
    expect(out).toContain("WORKER=delta-codex bootstrap-dead\n");
    expect(out).not.toContain("WORKER=alpha-claude");   // the hub answers as LIVENESS=, once
    // every pre-existing line is still exactly where it was
    for (const line of ["COMMAND=quick", "TOPIC=demo", "HUB=alpha-claude", "BUDGET=", "PARKED=no"]) {
      expect(out).toContain(line);
    }
  });

  it("a healthy run's status gains a line that says so", async () => {
    home();
    seedJob();
    seedWorker("demo", "delta", "codex", { state: "working", lastEvent: "ack", outbox: '{"event":"ack"}\n' });
    const { out } = await capture(() => jobRun(["status", "demo"]));
    expect(out).toMatch(/WORKER=delta-codex (alive|pane-missing \(1\/3\))\n/);
  });
});

describe("ap list — the same verdict as a column", () => {
  it("carries a LIVENESS column, and reports without advancing the counter", async () => {
    home();
    seedWorker("demo", "delta", "codex");
    const { out } = await capture(() => listRun([]));
    expect(out).toContain("LIVENESS");
    expect(out).toMatch(/delta\s+codex\s+demo\s+%89\s+\S+\s+bootstrap-dead/);
    expect(existsSync(J.workerLivenessPath("demo"))).toBe(false);
  });
});

// ---------------------------------------------------------------- the mid-wait rescan

describe("job wait — the rescan runs INSIDE the wait, at the pane probe's cadence", () => {
  it("a worker alive at call time and gone mid-wait ends the wait, not the 3600s budget", async () => {
    home();
    seedJob();
    seedWorker("demo", "delta", "codex", { state: "working", lastEvent: "ack", outbox: '{"event":"ack"}\n' });
    const v = virtualClock(T_LATER);
    // alive for the first 20 virtual seconds, then the pane is gone for good
    const snapshot = async (): Promise<Map<string, string>> =>
      (v.clock.now() - T_LATER < 20_000 ? livePane() : noPanes());

    const { out, rc } = await capture(() => waitRun(["demo"], { snapshot, now: () => v.clock.now(), clock: v.clock }));
    expect(rc).toBe(0);
    expect(JS(out)).toEqual(["JS=worker-dead WORKER=delta-codex VERDICT=pane-dead"]);
    // three misses at the 15s cadence: ~45-60s of virtual time, nowhere near the 3600s budget
    expect(v.elapsed()).toBeLessThanOrEqual(60_000 + 1_000);
    expect(v.elapsed()).toBeGreaterThan(20_000);
  });

  it("a worker that is fine does not end the wait: the budget still governs", async () => {
    home();
    seedJob();
    seedWorker("demo", "delta", "codex", { state: "working", lastEvent: "ack", outbox: '{"event":"ack"}\n' });
    const v = virtualClock(T_LATER);
    const prev = process.env.AP_JOB_WAIT_TIMEOUT_S;
    process.env.AP_JOB_WAIT_TIMEOUT_S = "120";
    try {
      const { out, rc } = await capture(() => waitRun(["demo"], {
        snapshot: async () => livePane(), now: () => v.clock.now(), clock: v.clock,
      }));
      expect(rc).toBe(1);
      expect(JS(out)).toEqual(["JS=timeout"]);
    } finally {
      if (prev === undefined) delete process.env.AP_JOB_WAIT_TIMEOUT_S; else process.env.AP_JOB_WAIT_TIMEOUT_S = prev;
    }
  });

  it("the hub's own terminal event still wins over a dead worker", async () => {
    home();
    seedJob();
    seedWorker("demo", "delta", "codex");    // already bootstrap-dead
    const p = outboxPath(REC.hub.agent, REC.hub.model, REC.topic);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ event: "done", summary: "shipped" }) + "\n");
    const v = virtualClock(T_LATER);
    const { out } = await capture(() => waitRun(["demo"], {
      snapshot: async () => noPanes(), now: () => v.clock.now(), clock: v.clock,
    }));
    // the outbox is read on poll 0, before any liveness check runs at all
    expect(JS(out)).toEqual(["JS=done"]);
  });
});

describe("outboxWaitSince's onPoll hook — additive by construction", () => {
  it("fires at the SAME cadence as the pane probe, and its event ends the wait", async () => {
    const { cleanup } = freshHome();
    try {
      const p = outboxPath("a", "codex", "t");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "");
      const v = virtualClock();
      let polls = 0;
      const ev = await outboxWaitSince("a", "codex", "t", 0, ["done"], 600, {
        paneAlive: async () => true, paneId: "%1", everyS: 15,
        onPoll: async () => (++polls >= 3 ? { event: "worker-dead", worker: "x-codex", verdict: "pane-dead" } : null),
      }, v.clock);
      expect(ev?.event).toBe("worker-dead");
      expect(polls).toBe(3);
      expect(v.elapsed()).toBe(45_000);   // 3 polls x 15s, the pane probe's own cadence
    } finally { cleanup(); }
  });

  it("runs even when the pane id is null — an unverifiable pane.json disables ONE check, not both", async () => {
    const { cleanup } = freshHome();
    try {
      const p = outboxPath("a", "codex", "t");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "");
      const v = virtualClock();
      const ev = await outboxWaitSince("a", "codex", "t", 0, ["done"], 600, {
        paneAlive: async () => { throw new Error("must not be probed"); }, paneId: null, everyS: 15,
        onPoll: async () => ({ event: "worker-dead", worker: "x-codex", verdict: "bootstrap-dead" }),
      }, v.clock);
      expect(ev?.verdict).toBe("bootstrap-dead");
    } finally { cleanup(); }
  });

  it("a probe that throws is not evidence: the wait carries on to its own budget", async () => {
    const { cleanup } = freshHome();
    try {
      const p = outboxPath("a", "codex", "t");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "");
      const v = virtualClock();
      const ev = await outboxWaitSince("a", "codex", "t", 0, ["done"], 40, {
        paneAlive: async () => true, paneId: "%1", everyS: 15,
        onPoll: async () => { throw new Error("tmux is having a day"); },
      }, v.clock);
      expect(ev).toBeNull();
    } finally { cleanup(); }
  });
});
