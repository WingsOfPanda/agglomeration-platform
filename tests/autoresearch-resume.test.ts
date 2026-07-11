// tests/autoresearch-resume.test.ts — resume verb crash-injection matrix (campaign spine).
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { resumeWith, experimentSendWith, type AutoresearchResumeDeps, type ExperimentSendDeps } from "../src/commands/autoresearch.js";
import { autoresearchArtDir, workerStateDir, experimentDir } from "../src/core/autoresearch.js";
import { workerDir } from "../src/core/paths.js";
import { ledgerPath, controllerGenPath, appendEvent, parseLedger, renderGen, type LedgerEvent } from "../src/core/autoresearchLedger.js";
import { parseState } from "../src/core/autoresearchState.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h; }

const TOPIC = "rs-topic";
const INST = "bravo";
const MODEL = "codex";
const opts = (h: { home: string }) => ({ home: h.home, cwd: process.cwd() });

/** Scaffold a ledgered campaign: art dir + metric.md + workers.txt + worker state +
 *  live worker dir (pane.json + outbox.jsonl) + campaign-init ledger + controller.gen. */
function scaffold(h: { home: string }, over: { phase?: string; expCounter?: string; currentExp?: string } = {}) {
  const o = opts(h);
  const art = autoresearchArtDir(TOPIC, o);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "metric.md"), "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n");
  writeFileSync(join(art, "topic.txt"), "improve accuracy");
  writeFileSync(join(art, "workers.txt"), `${INST}\n`);
  const sd = workerStateDir(art, INST);
  mkdirSync(join(sd, "experiments"), { recursive: true });
  writeFileSync(join(sd, "state.txt"),
    `phase=${over.phase ?? "idle"}\nexp_counter=${over.expCounter ?? "0"}\ncurrent_exp_id=${over.currentExp ?? ""}\n`);
  const pd = workerDir(INST, MODEL, TOPIC, o);
  mkdirSync(pd, { recursive: true });
  writeFileSync(join(pd, "pane.json"), JSON.stringify({ pane_id: "%9", agent: INST, model: MODEL, spawned_at: "t" }));
  writeFileSync(join(pd, "outbox.jsonl"), "");
  writeFileSync(ledgerPath(art), appendEvent("", { gen: 1, ts: "T", kind: "campaign-init" }));
  writeFileSync(controllerGenPath(art), renderGen(1, "T", "init"));
  return { art, sd, pd, o, outbox: join(pd, "outbox.jsonl") };
}

function ledgerAdd(art: string, ev: Omit<LedgerEvent, "seq">) {
  appendFileSync(ledgerPath(art), appendEvent(readFileSync(ledgerPath(art), "utf8"), ev));
}
function evs(art: string) { return parseLedger(readFileSync(ledgerPath(art), "utf8")); }
function state(sd: string) { return parseState(readFileSync(join(sd, "state.txt"), "utf8")); }

function deps(h: { home: string }, over: Partial<AutoresearchResumeDeps> = {}): AutoresearchResumeDeps {
  return { now: () => "T2", paneAlive: async () => true, freshWorker: vi.fn(async () => 0), opts: opts(h), ...over };
}
async function run(h: { home: string }, d: AutoresearchResumeDeps) {
  const out: string[] = [];
  const rc = await resumeWith([TOPIC], { ...d, stdout: (l) => out.push(l) });
  return { rc, out };
}

describe("resume: guards", () => {
  it("rc 1 when no art dir; rc 1 when art exists but no ledger (pre-spine campaign)", async () => {
    const h = home();
    expect((await run(h, deps(h))).rc).toBe(1);
    const { art } = scaffold(h);
    // strip the ledger -> pre-spine campaign
    const { rmSync } = await import("node:fs");
    rmSync(ledgerPath(art));
    expect((await run(h, deps(h))).rc).toBe(1);
  });
});

describe("resume: crash matrix", () => {
  it("1. crash AFTER intent, BEFORE inbox -> REDISPATCH with the SAME exp id; counter unchanged", async () => {
    const h = home();
    const { art, sd } = scaffold(h); // idle, exp_counter=0
    ledgerAdd(art, { gen: 1, ts: "T", kind: "dispatch-intent", agent: INST, exp_id: "exp-001" });
    const { rc, out } = await run(h, deps(h));
    expect(rc).toBe(0);
    expect(out).toContain("REDISPATCH=bravo:exp-001");
    expect(state(sd).exp_counter).toBe("0"); // repair only happens on resolved-as-delivered
    expect(evs(art).filter((e) => e.kind === "dispatch-intent")).toHaveLength(1); // no new id minted
  });

  it("2. crash AFTER inbox, BEFORE state.txt (hazard-1 window): worker acked -> delivered backfilled, state repaired, NO redispatch", async () => {
    const h = home();
    const { art, sd, outbox } = scaffold(h, { expCounter: "0" });
    ledgerAdd(art, { gen: 1, ts: "T", kind: "dispatch-intent", agent: INST, exp_id: "exp-001" });
    appendFileSync(outbox, '{"event":"ack","task_summary":"exp-001","ts":"t"}\n');
    const { rc, out } = await run(h, deps(h));
    expect(rc).toBe(0);
    expect(out.some((l) => l.startsWith("REDISPATCH="))).toBe(false);
    const d = evs(art).find((e) => e.kind === "dispatch-delivered");
    expect(d).toMatchObject({ agent: INST, exp_id: "exp-001" });
    // state repaired to what buildDispatchState would have written (counter reconstructible)
    const st = state(sd);
    expect(st.phase).toBe("working");
    expect(st.current_exp_id).toBe("exp-001");
    expect(st.exp_counter).toBe("1");
  });

  it("3. worker finished while hub was dead -> result-recorded backfilled, state reconciles to idle", async () => {
    const h = home();
    const { art, sd, outbox } = scaffold(h, { phase: "working", expCounter: "1", currentExp: "exp-001" });
    ledgerAdd(art, { gen: 1, ts: "T", kind: "dispatch-intent", agent: INST, exp_id: "exp-001" });
    ledgerAdd(art, { gen: 1, ts: "T", kind: "dispatch-delivered", agent: INST, exp_id: "exp-001", data: { outboxOffset: 0 } });
    appendFileSync(outbox, '{"event":"done","summary":"experiment exp-001","ts":"t"}\n');
    mkdirSync(experimentDir(art, INST, "exp-001"), { recursive: true });
    writeFileSync(join(experimentDir(art, INST, "exp-001"), "result.json"), JSON.stringify({ status: "ok", metric_value: 0.9 }));
    const { rc } = await run(h, deps(h));
    expect(rc).toBe(0);
    expect(state(sd).phase).toBe("idle");
    expect(evs(art).some((e) => e.kind === "result-recorded" && e.exp_id === "exp-001")).toBe(true);
  });

  it("4. done WITHOUT result.json -> no state write (today's reconcile rule held)", async () => {
    const h = home();
    const { art, sd, outbox } = scaffold(h, { phase: "working", expCounter: "1", currentExp: "exp-001" });
    ledgerAdd(art, { gen: 1, ts: "T", kind: "dispatch-intent", agent: INST, exp_id: "exp-001" });
    ledgerAdd(art, { gen: 1, ts: "T", kind: "dispatch-delivered", agent: INST, exp_id: "exp-001", data: { outboxOffset: 0 } });
    appendFileSync(outbox, '{"event":"done","summary":"x","ts":"t"}\n');
    const { rc } = await run(h, deps(h));
    expect(rc).toBe(0);
    expect(state(sd).phase).toBe("working"); // untouched
  });

  it("5. an OLD done BEFORE the recorded dispatch offset is NOT this experiment's completion", async () => {
    const h = home();
    const { art, sd, outbox } = scaffold(h, { phase: "working", expCounter: "2", currentExp: "exp-002" });
    const oldDone = '{"event":"done","summary":"experiment exp-001","ts":"t"}\n';
    appendFileSync(outbox, oldDone);
    ledgerAdd(art, { gen: 1, ts: "T", kind: "dispatch-intent", agent: INST, exp_id: "exp-002" });
    ledgerAdd(art, { gen: 1, ts: "T", kind: "dispatch-delivered", agent: INST, exp_id: "exp-002", data: { outboxOffset: Buffer.byteLength(oldDone) } });
    // exp-002's result exists on disk? No — and the old done must not flip state to idle.
    const { rc, out } = await run(h, deps(h));
    expect(rc).toBe(0);
    expect(state(sd).phase).toBe("working"); // un-keyed-completion hazard closed
    expect(out.some((l) => l.startsWith("REDISPATCH="))).toBe(false); // delivered + live pane -> still working
  });

  it("6. dead pane + phase=working -> interrupted appended, state reset idle, REDISPATCH printed, respawn attempted", async () => {
    const h = home();
    const { art, sd } = scaffold(h, { phase: "working", expCounter: "1", currentExp: "exp-001" });
    ledgerAdd(art, { gen: 1, ts: "T", kind: "dispatch-intent", agent: INST, exp_id: "exp-001" });
    const fresh = vi.fn(async () => 0);
    const { rc, out } = await run(h, deps(h, { paneAlive: async () => false, freshWorker: fresh }));
    expect(rc).toBe(0);
    expect(evs(art).some((e) => e.kind === "interrupted" && e.exp_id === "exp-001")).toBe(true);
    const st = state(sd);
    expect(st.phase).toBe("idle");
    expect(st.current_exp_id).toBe("");
    expect(out).toContain("REDISPATCH=bravo:exp-001");
    expect(fresh).toHaveBeenCalledWith(TOPIC, INST); // dead pane respawned after the reset
    expect(evs(art).some((e) => e.kind === "fresh-worker-respawn" && e.agent === INST)).toBe(true);
  });

  it("7. double resume -> gen bumps twice, second replay is a state no-op", async () => {
    const h = home();
    const { art, sd } = scaffold(h);
    const r1 = await run(h, deps(h));
    expect(r1.out).toContain("GEN=2");
    const stateAfter1 = readFileSync(join(sd, "state.txt"), "utf8");
    const r2 = await run(h, deps(h));
    expect(r2.out).toContain("GEN=3");
    expect(readFileSync(join(sd, "state.txt"), "utf8")).toBe(stateAfter1); // idempotent on state
    const kinds = evs(art).map((e) => e.kind);
    expect(kinds.filter((k) => k === "resume")).toHaveLength(2);
  });

  it("8. stale-gen dispatch after a resume: experiment-send --gen 1 -> rc 3, inbox spy not called", async () => {
    const h = home();
    const { art } = scaffold(h);
    await run(h, deps(h)); // bumps controller gen to 2
    const spy = vi.fn();
    const esDeps: ExperimentSendDeps = {
      now: () => "T", probeHardware: () => "no-gpu", paneSend: async () => {},
      consultTimeout: () => 1800, dryRun: true, opts: opts(h), inboxWrite: spy,
    };
    const rc = await experimentSendWith(["--gen", "1", TOPIC, INST, "exp-001", "x", "y"], esDeps);
    expect(rc).toBe(3);
    expect(spy).not.toHaveBeenCalled();
    void art;
  });
});

describe("resume: report shape", () => {
  it("prints GEN, WORKER rows, MONITOR rows for live workers, LAST_SEQ", async () => {
    const h = home();
    scaffold(h);
    const { out } = await run(h, deps(h));
    expect(out[0]).toBe("GEN=2");
    expect(out).toContain("WORKER=bravo:idle:yes");
    expect(out).toContain("MONITOR=bravo");
    expect(out[out.length - 1]).toMatch(/^LAST_SEQ=\d+$/);
  });
});
