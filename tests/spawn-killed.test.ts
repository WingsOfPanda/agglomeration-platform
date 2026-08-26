// tests/spawn-killed.test.ts — L1: a spawn that is KILLED mid-ready-wait, and a pane that DIES
// mid-ready-wait, both end as loud terminal failures instead of a worker frozen at the spawn seed.
// Field failure this covers: GitHub issue #157 — the hub's 120s Bash-tool default SIGTERMed a codex
// spawn 30s before spawn's own 150s deadline, so none of the bootstrap-failure path ran and the run
// read `alive/working` for 10.5h. No pane, no signal and no real exit is used here: the sequence's
// deps are injected, and the ready-wait runs the REAL engine over a real temp outbox on a fake clock.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { virtualClock } from "./helpers/clock.js";
import {
  spawnKilled, withSigtermGuard, readyWait, bootstrapFailureReason, realSpawnKilledDeps,
  READY_EVENTS, SPAWN_KILLED_EXIT, type SpawnKilledDeps,
} from "../src/commands/spawn.js";
import { captureFailure, captureSpawnFailure, FAILURE_FILENAME } from "../src/core/forensics.js";
import { outboxPath, outboxWaitSince, seedWorkerStatus, statusPath, writeWorkerStatus, PANE_DIED_NOTE } from "../src/core/ipc.js";
import { stateArchive } from "../src/core/archive.js";
import { globalRoot, workerDir } from "../src/core/paths.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function home(): string { const h = freshHome(); cleanups.push(h.cleanup); return h.home; }

function mkWorker(i: string, m: string, t: string): string {
  const d = workerDir(i, m, t);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "outbox.jsonl"), "");
  seedWorkerStatus(i, m, t);
  return d;
}

function forensicsMd(): string[] {
  const root = join(globalRoot(), "forensics");
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }) as Dirent[]) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** The real sequence with a recorder around every step: the ORDER is the contract (a status write
 *  after the archive would land in a directory that has moved), so the log is asserted, not just the
 *  effects. Only `killNow`/`capturePane`/`exit` are faked — everything that writes state is real. */
function recordingDeps(rec: string[], over: Partial<SpawnKilledDeps> = {}): SpawnKilledDeps {
  return {
    writeWorkerStatus: (i, m, t, state, lastEvent) => { rec.push(`status:${state}/${lastEvent}`); writeWorkerStatus(i, m, t, state, lastEvent); },
    killNow: async (pane) => { rec.push(`kill:${pane}`); },
    capturePane: async () => "codex: bootstrap line\n",
    captureFailure: (input, deps) => { rec.push(`capture:${input.reason}`); return captureFailure(input, deps); },
    captureSpawnFailure: (opts) => { rec.push(`forensics:${opts.reason}`); return captureSpawnFailure(opts); },
    stateArchive: (i, m, t, suffix) => { rec.push(`archive:${suffix}`); return stateArchive(i, m, t, suffix); },
    exit: (code) => { rec.push(`exit:${code}`); },
    ...over,
  };
}

const CTX = { agent: "delta", model: "codex", topic: "killed-demo", pane: "%89", readyTimeout: 150 };

describe("spawnKilled — the SIGTERM bootstrap-failure sequence", () => {
  it("runs status -> kill -> forensics -> archive -> exit 143, in that order", async () => {
    home(); mkWorker(CTX.agent, CTX.model, CTX.topic);
    const rec: string[] = [];
    await spawnKilled(CTX, recordingDeps(rec));
    expect(rec).toEqual([
      "status:error/spawn-killed",
      "kill:%89",
      "capture:killed",
      "forensics:killed",
      "archive:FAILED",
      `exit:${SPAWN_KILLED_EXIT}`,
    ]);
    expect(SPAWN_KILLED_EXIT).toBe(143);
  });

  it("the status write comes FIRST — before the kill and before the archive", async () => {
    home(); mkWorker(CTX.agent, CTX.model, CTX.topic);
    const rec: string[] = [];
    await spawnKilled(CTX, recordingDeps(rec));
    const status = rec.indexOf("status:error/spawn-killed");
    expect(status).toBe(0);
    expect(status).toBeLessThan(rec.indexOf("kill:%89"));
    expect(status).toBeLessThan(rec.indexOf("archive:FAILED"));
  });

  it("kills the pane it was given, and kills it BEFORE the archive hides it from every teardown", async () => {
    home(); mkWorker(CTX.agent, CTX.model, CTX.topic);
    const rec: string[] = [];
    await spawnKilled(CTX, recordingDeps(rec));
    expect(rec, "the pane must be killed, or the archive strands a live worker no teardown can reach").toContain("kill:%89");
    expect(rec.indexOf("kill:%89")).toBeLessThan(rec.indexOf("archive:FAILED"));
  });

  it("archives FAILED, leaving nothing dangling under the topic", async () => {
    home();
    const dir = mkWorker(CTX.agent, CTX.model, CTX.topic);
    let archived = "";
    await spawnKilled(CTX, recordingDeps([], {
      stateArchive: (i, m, t, s) => { archived = stateArchive(i, m, t, s) ?? ""; return archived; },
    }));
    expect(existsSync(dir)).toBe(false);
    expect(archived).toMatch(/-FAILED$/);
    expect(existsSync(archived)).toBe(true);
  });

  it("stamps the terminal state over the spawn seed: error / spawn-killed", async () => {
    home(); mkWorker(CTX.agent, CTX.model, CTX.topic);
    expect(JSON.parse(readFileSync(statusPath(CTX.agent, CTX.model, CTX.topic), "utf8")).last_event).toBe("spawn");
    let archived = "";
    await spawnKilled(CTX, recordingDeps([], {
      stateArchive: (i, m, t, s) => { archived = stateArchive(i, m, t, s) ?? ""; return archived; },
    }));
    const st = JSON.parse(readFileSync(join(archived, "status.json"), "utf8"));
    expect(st.state).toBe("error");
    expect(st.last_event).toBe("spawn-killed");
  });

  it("writes a failure report and a command:spawn forensics finding, both with reason=killed", async () => {
    home(); mkWorker(CTX.agent, CTX.model, CTX.topic);
    let archived = "";
    await spawnKilled(CTX, recordingDeps([], {
      stateArchive: (i, m, t, s) => { archived = stateArchive(i, m, t, s) ?? ""; return archived; },
    }));
    const report = readFileSync(join(archived, FAILURE_FILENAME), "utf8");
    expect(report).toContain("fail_reason:   killed");
    expect(report).toContain("pane_id:       %89");
    const feed = forensicsMd();
    expect(feed.length).toBe(1);
    const md = readFileSync(feed[0], "utf8");
    expect(md).toContain("reason=killed");
    expect(md).toContain("worker=delta-codex");
  });

  it("each step is guarded: a status write that throws still costs neither the kill nor the archive", async () => {
    home(); mkWorker(CTX.agent, CTX.model, CTX.topic);
    const rec: string[] = [];
    await spawnKilled(CTX, recordingDeps(rec, {
      writeWorkerStatus: () => { rec.push("status:threw"); throw new Error("disk gone"); },
    }));
    expect(rec).toContain("kill:%89");
    expect(rec).toContain("archive:FAILED");
    expect(rec.at(-1)).toBe(`exit:${SPAWN_KILLED_EXIT}`);
  });

  it("exits 143 even when the whole sequence fails", async () => {
    home(); // no worker dir at all: every step has nothing to write to
    const rec: string[] = [];
    await spawnKilled(CTX, recordingDeps(rec, {
      killNow: async () => { throw new Error("tmux gone"); },
      stateArchive: () => { throw new Error("archive gone"); },
    }));
    expect(rec.at(-1)).toBe(`exit:${SPAWN_KILLED_EXIT}`);
  });

  it("realSpawnKilledDeps wires the shipped implementations (not a test double)", () => {
    const d = realSpawnKilledDeps();
    expect(d.writeWorkerStatus).toBe(writeWorkerStatus);
    expect(d.captureFailure).toBe(captureFailure);
    expect(d.captureSpawnFailure).toBe(captureSpawnFailure);
    expect(d.stateArchive).toBe(stateArchive);
  });
});

describe("withSigtermGuard — installed for the ready-wait only", () => {
  it("a SIGTERM during the wait runs the failure sequence", async () => {
    let fired = 0;
    const r = await withSigtermGuard(() => { fired++; }, async () => {
      process.emit("SIGTERM");
      return "wait-returned";
    });
    expect(fired, "no SIGTERM handler ran — a killed spawn is silent again").toBe(1);
    expect(r).toBe("wait-returned");
  });

  it("fires at most once: a second signal must not restart a sequence already archiving", async () => {
    let fired = 0;
    await withSigtermGuard(() => { fired++; }, async () => {
      process.emit("SIGTERM");
      process.emit("SIGTERM");
    });
    expect(fired).toBe(1);
  });

  it("removes the handler when the wait ends — the rest of the spawn keeps the default terminate", async () => {
    const before = process.listenerCount("SIGTERM");
    await withSigtermGuard(() => {}, async () => {
      expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    });
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("removes the handler even when the wait throws", async () => {
    const before = process.listenerCount("SIGTERM");
    await expect(withSigtermGuard(() => {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("readyWait — the bootstrap wait carries the pane-liveness escape hatch", () => {
  function mkOutbox(i: string, m: string, t: string): string {
    const p = outboxPath(i, m, t);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "");
    return p;
  }

  it("a pane that dies during bootstrap ends the wait at the next liveness poll, not at the deadline", async () => {
    home(); mkOutbox("delta", "codex", "t");
    const v = virtualClock();
    const ev = await readyWait(
      { agent: "delta", model: "codex", topic: "t", pane: "%89", nonce: "n1", readyTimeout: 150 },
      { wait: outboxWaitSince, paneAlive: async () => false, clock: v.clock },
    );
    expect(v.elapsed(), "the wait ran its full deadline — the liveness opts are not wired").toBeLessThan(60_000);
    expect(ev?.event).toBe("error");
    expect(ev?.note).toBe(PANE_DIED_NOTE);
  });

  it("passes the worker's own nonce to the probe (an id alone can name a stranger's pane)", async () => {
    home(); mkOutbox("delta", "codex", "t");
    const v = virtualClock();
    const seen: Array<[string, string]> = [];
    await readyWait(
      { agent: "delta", model: "codex", topic: "t", pane: "%89", nonce: "nonce-abc", readyTimeout: 40 },
      { wait: outboxWaitSince, paneAlive: async (p, n) => { seen.push([p, n]); return false; }, clock: v.clock },
    );
    expect(seen[0]).toEqual(["%89", "nonce-abc"]);
  });

  it("a live pane cannot stretch the bootstrap deadline (no extendMult)", async () => {
    home(); mkOutbox("delta", "codex", "t");
    const v = virtualClock();
    const ev = await readyWait(
      { agent: "delta", model: "codex", topic: "t", pane: "%89", nonce: "n1", readyTimeout: 30 },
      { wait: outboxWaitSince, paneAlive: async () => true, clock: v.clock },
    );
    expect(ev).toBeNull();
    expect(v.elapsed()).toBeLessThan(31_000);
  });

  it("a real ready event still wins over the liveness check", async () => {
    home();
    const p = mkOutbox("delta", "codex", "t");
    const v = virtualClock();
    v.at(5_000, () => { writeFileSync(p, '{"event":"ready","ts":"t"}\n'); });
    const ev = await readyWait(
      { agent: "delta", model: "codex", topic: "t", pane: "%89", nonce: "n1", readyTimeout: 150 },
      { wait: outboxWaitSince, paneAlive: async () => false, clock: v.clock },
    );
    expect(ev?.event).toBe("ready");
  });

  it("listens for the frozen {ready,error} pair", () => {
    expect(READY_EVENTS).toEqual(["ready", "error"]);
  });
});

describe("failure reports carry the two new reasons", () => {
  const deps = { workerDir, capturePane: async () => "tail\n", atomicWriteSync: (d: string, c: string) => writeFileSync(d, c), isWritableDir: (d: string) => existsSync(d), now: () => "2026-08-26T00:00:00Z" };

  it("pane_dead is a valid reason, and its report carries the synthetic event instead of the no-event sentinel", async () => {
    home(); mkWorker("delta", "codex", "t");
    const line = JSON.stringify({ event: "error", note: PANE_DIED_NOTE });
    const r = await captureFailure({ agent: "delta", model: "codex", topic: "t", paneId: "%89", reason: "pane_dead", eventLine: line, readyTimeout: 150 }, deps);
    expect(r.ok).toBe(true);
    const txt = readFileSync(join(workerDir("delta", "codex", "t"), FAILURE_FILENAME), "utf8");
    expect(txt).toContain("fail_reason:   pane_dead");
    expect(txt).toContain(line);
  });

  it("an unknown reason is still rejected (the union did not become a free string)", async () => {
    home(); mkWorker("delta", "codex", "t");
    const r = await captureFailure({ agent: "delta", model: "codex", topic: "t", paneId: "%1", reason: "kaboom" as never }, deps);
    expect(r).toEqual({ ok: false, code: 2 });
  });
});

describe("bootstrapFailureReason (pure)", () => {
  it("no event -> timeout", () => { expect(bootstrapFailureReason(null)).toBe("timeout"); });
  it("the synthetic pane-death error -> pane_dead, never the worker's own error_event", () => {
    expect(bootstrapFailureReason({ event: "error", note: PANE_DIED_NOTE })).toBe("pane_dead");
  });
  it("an error the worker itself wrote -> error_event", () => {
    expect(bootstrapFailureReason({ event: "error", message: "codex bootstrap failed" })).toBe("error_event");
  });
});
