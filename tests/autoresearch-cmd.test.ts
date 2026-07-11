// tests/autoresearch-cmd.test.ts — autoresearch CLI verbs (Phase B).
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { freshHome } from "./helpers/tmpHome.js";
import { initWith, type AutoresearchInitDeps } from "../src/commands/autoresearch.js";
import { metricWith, sotaWith } from "../src/commands/autoresearch.js";
import { spawnAllWith, type SpawnAllDeps } from "../src/commands/autoresearch.js";
import { dropWorkerWith, type DropWorkerDeps } from "../src/commands/autoresearch.js";
import { experimentSendWith, type ExperimentSendDeps } from "../src/commands/autoresearch.js";
import { experimentTimeoutDefault } from "../src/commands/autoresearch.js";
import { consultTimeout } from "../src/core/contracts.js";
import { scoreWith, liveScoreDeps, type AutoresearchScoreDeps } from "../src/commands/autoresearch.js";
import { type ScoreComputation } from "../src/core/autoresearchScore.js";
import { monitorRun } from "../src/commands/autoresearch.js";
import { statusBriefWith } from "../src/commands/autoresearch.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoresearchArtDir, workerStateDir, experimentDir, workersDir } from "../src/core/autoresearch.js";
import { workerDir } from "../src/core/paths.js";
import { inboxPath } from "../src/core/ipc.js";
import { ledgerPath, controllerGenPath, parseLedger, appendEvent, renderGen } from "../src/core/autoresearchLedger.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function home() { const h = freshHome(); cleanups.push(h.cleanup); return h; }

const okDeps = (over: Partial<AutoresearchInitDeps> = {}): AutoresearchInitDeps => ({
  haveCmd: () => true,
  agentBinary: (n) => (n === "codex" ? "codex" : undefined),
  now: () => "2026-05-30T00:00:00Z",
  probeHardware: () => {},
  configRoot: () => process.cwd(),
  ...over,
});

describe("autoresearch init", () => {
  it("a value flag with no value (trailing) throws KvError (missing flag value)", async () => {
    const h = home();
    await expect(initWith(["--metric"], okDeps({ opts: { home: h.home, cwd: h.home } })))
      .rejects.toThrow(/--metric requires a value/);
  });
  it("scaffolds the _autoresearch art dir, topic.txt, and a metric.txt seed; prints TOPIC + ART", async () => {
    const h = home();
    const out: string[] = [];
    const log = (s: string) => out.push(s);
    const rc = await initWith(["maximize accuracy under 100k params"],
      okDeps({ stdout: log, opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(0);
    // deriveSlug caps at 20 chars (canonical frozen pipeline) → "maximize-accuracy-un".
    const art = autoresearchArtDir("maximize-accuracy-un", { home: h.home, cwd: h.home });
    expect(existsSync(art)).toBe(true);
    expect(readFileSync(`${art}/topic.txt`, "utf8")).toBe("maximize accuracy under 100k params");
    expect(readFileSync(`${art}/metric.txt`, "utf8").trim()).toBe("accuracy");
    expect(out.join("\n")).toContain(`ART=${art}`);
    expect(out.join("\n")).toContain("TOPIC=maximize-accuracy-un");
  });
  it("seeds <art>/lib/ from config/autoresearch-lib-seed", async () => {
    const h = home();
    const rc = await initWith(["seed lib topic"], okDeps({ configRoot: () => process.cwd(), opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(0);
    const art = autoresearchArtDir("seed-lib-topic", { home: h.home, cwd: h.home });
    for (const f of ["arena.py", "__init__.py", "README.md"]) expect(existsSync(join(art, "lib", f))).toBe(true);
    expect(readFileSync(join(art, "lib", "arena.py"), "utf8")).toContain("def arena_color_rotated");
  });
  it("gates on codex availability (rc 3)", async () => {
    const h = home();
    const rc = await initWith(["x topic"], okDeps({ haveCmd: () => false, opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(3);
  });
  it("rejects an empty slug (rc 2)", async () => {
    const h = home();
    const rc = await initWith(["!!!"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(2);
  });
  it("refuses an already-in-flight topic (rc 2)", async () => {
    const h = home();
    const d = okDeps({ opts: { home: h.home, cwd: h.home } });
    expect(await initWith(["same topic"], d)).toBe(0);
    expect(await initWith(["same topic"], d)).toBe(2);
  });
  it("bootstraps the campaign ledger: campaign-init gen=1 + controller.gen", async () => {
    const h = home();
    const rc = await initWith(["ledger topic"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(0);
    const art = autoresearchArtDir("ledger-topic", { home: h.home, cwd: h.home });
    const evs = parseLedger(readFileSync(ledgerPath(art), "utf8"));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ seq: 1, gen: 1, kind: "campaign-init" });
    expect(readFileSync(controllerGenPath(art), "utf8")).toContain("gen=1");
  });
  it("in-flight refusal points at resume", async () => {
    const h = home();
    const d = okDeps({ opts: { home: h.home, cwd: h.home } });
    await initWith(["same topic"], d);
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { errs.push(String(s)); return true; });
    expect(await initWith(["same topic"], d)).toBe(2);
    spy.mockRestore();
    expect(errs.join("")).toContain("resume");
  });
  it("--metric pre-writes metric.md; --time-budget pre-writes time-budget.txt + session-start.txt", async () => {
    const h = home();
    const rc = await initWith([
      "--metric", "primary_metric=accuracy,direction=maximize,min_acceptable=>= 0.9,target=>= 0.99",
      "--time-budget", "4h", "tune model",
    ], okDeps({ opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(0);
    const art = autoresearchArtDir("tune-model", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art}/metric.md`, "utf8")).toContain("**Primary metric:** accuracy");
    expect(readFileSync(`${art}/time-budget.txt`, "utf8").trim()).toBe("14400");
    expect(readFileSync(`${art}/session-start.txt`, "utf8").trim()).toBe("2026-05-30T00:00:00Z");
  });
  it("--slug overrides derivation; --time-budget none resolves", async () => {
    const h = home();
    expect(await initWith(["--slug", "myrun", "--time-budget", "none", "anything"],
      okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(0);
    const art = autoresearchArtDir("myrun", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art}/time-budget.txt`, "utf8").trim()).toBe("none");
  });
  it("unknown flag -> rc 2", async () => {
    const h = home();
    expect(await initWith(["--bogus", "x topic"], okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(2);
  });
  it("--seed-from with a missing path -> rc 1", async () => {
    const h = home();
    expect(await initWith(["--seed-from", "/no/such/file", "seed topic"],
      okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(1);
  });
  it("--metric with a malformed block (missing direction) -> rc 2", async () => {
    const h = home();
    expect(await initWith(["--metric", "primary_metric=auc", "bad metric topic"],
      okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(2);
  });
  it("--slug rejects a value not matching ^[a-z][a-z0-9-]{0,19}$ -> rc 2", async () => {
    const h = home();
    expect(await initWith(["--slug", "9bad", "x"], okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(2);
    expect(await initWith(["--slug", "WAY-too-long-a-slug-value-here", "x"],
      okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(2);
  });
  it("--time-budget accepts <N>s and bare integer seconds", async () => {
    const h = home();
    expect(await initWith(["--slug", "tbsec", "--time-budget", "900s", "t"],
      okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(0);
    const art1 = autoresearchArtDir("tbsec", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art1}/time-budget.txt`, "utf8").trim()).toBe("900");
    expect(await initWith(["--slug", "tbint", "--time-budget", "1800", "t"],
      okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(0);
    const art2 = autoresearchArtDir("tbint", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art2}/time-budget.txt`, "utf8").trim()).toBe("1800");
  });
  it("--time-budget rejects a malformed value -> rc 2", async () => {
    const h = home();
    expect(await initWith(["--time-budget", "0h", "t"], okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(2);
    expect(await initWith(["--time-budget", "abc", "t"], okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(2);
  });
});

describe("autoresearch metric / sota verbs", () => {
  it("metric writes metric.md from --kv", async () => {
    const h = home();
    await initWith(["--slug", "r1", "topic one"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await metricWith(["r1", "--kv", "primary_metric=auc,direction=maximize,min_acceptable=>= 0.8"],
      { opts: { home: h.home, cwd: h.home } });
    expect(rc).toBe(0);
    const art = autoresearchArtDir("r1", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art}/metric.md`, "utf8")).toContain("**Primary metric:** auc");
  });
  it("metric returns 2 on a bad block (missing direction)", async () => {
    const h = home();
    await initWith(["--slug", "r2", "topic two"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    expect(await metricWith(["r2", "--kv", "primary_metric=auc"], { opts: { home: h.home, cwd: h.home } })).toBe(2);
  });
  it("sota writes sota.md from --kv with ref rows", async () => {
    const h = home();
    await initWith(["--slug", "r3", "topic three"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await sotaWith(["r3", "--kv",
      "topic=mnist,metric=accuracy,sweep_date=2026-05-30,ref_1=cnn|0.99|fits|url|note"],
      { opts: { home: h.home, cwd: h.home } });
    expect(rc).toBe(0);
    const art = autoresearchArtDir("r3", { home: h.home, cwd: h.home });
    const md = readFileSync(`${art}/sota.md`, "utf8");
    expect(md).toContain("# SOTA reference — mnist");
    expect(md).toContain("| cnn | 0.99 | fits | url | note |");
  });
});

describe("autoresearch spawn-all", () => {
  function deps(over: Partial<SpawnAllDeps> = {}): SpawnAllDeps {
    return {
      preflight: async (a) => {
        const art = a[a.indexOf("--art-dir") + 1];
        const list = a[a.indexOf("--list") + 1]; // "inst:codex,inst2:codex"
        const lines = list.split(",").map((e, i) => `${e.split(":")[0]}\t%${i + 1}`).join("\n");
        mkdirSync(art, { recursive: true });
        writeFileSync(`${art}/preflight-panes.txt`, lines + "\n");
        return 0;
      },
      spawn: async () => 0,
      repoRoot: () => "/repo",
      pickAgents: (_t, n) => Array.from({ length: n }, (_, i) => `inst${i + 1}`),
      ...over,
    };
  }
  it("picks N codex workers, spawns them, writes workers.txt + spawn-results.tsv, rc 0", async () => {
    const h = home();
    await initWith(["--slug", "s1", "spawn topic"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await spawnAllWith(["s1", "2"], deps(), { home: h.home, cwd: h.home });
    expect(rc).toBe(0);
    const art = autoresearchArtDir("s1", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art}/workers.txt`, "utf8").trim().split("\n")).toEqual(["inst1", "inst2"]);
    expect(readFileSync(`${art}/spawn-results.tsv`, "utf8")).toContain("inst1\tcodex\t0");
  });
  it("rc 1 when one worker fails to come up", async () => {
    const h = home();
    await initWith(["--slug", "s2", "spawn topic 2"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await spawnAllWith(["s2", "2"], deps({ spawn: async (a) => (a[0] === "inst2" ? 1 : 0) }), { home: h.home, cwd: h.home });
    expect(rc).toBe(1);
  });
  it("rc 3 when fewer than 2 agents can be picked", async () => {
    const h = home();
    await initWith(["--slug", "s3", "spawn topic 3"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await spawnAllWith(["s3", "2"], deps({ pickAgents: () => ["only1"] }), { home: h.home, cwd: h.home });
    expect(rc).toBe(3);
  });
  it("spawns every worker in parallel (no per-worker stagger delay)", async () => {
    const h = home();
    await initWith(["--slug", "s5", "spawn topic 5"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const spawned: string[] = [];
    const d = deps({
      spawn: async (a) => { spawned.push(a[0]); return 0; },
    });
    const rc = await spawnAllWith(["s5", "3"], d, { home: h.home, cwd: h.home });
    expect(rc).toBe(0);
    // Every picked worker is spawned concurrently (mirrors design/explore spawn-all).
    expect(spawned.sort()).toEqual(["inst1", "inst2", "inst3"]);
  });
  it("rc 3 when preflight omits a pane for some worker (orphan guard)", async () => {
    const h = home();
    await initWith(["--slug", "s4", "spawn topic 4"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const d = deps({
      preflight: async (a) => {
        const art = a[a.indexOf("--art-dir") + 1];
        mkdirSync(art, { recursive: true });
        // only allocate a pane for inst1, omit inst2 -> orphan
        writeFileSync(`${art}/preflight-panes.txt`, "inst1\t%1\n");
        return 0;
      },
    });
    expect(await spawnAllWith(["s4", "2"], d, { home: h.home, cwd: h.home })).toBe(3);
  });
});

describe("autoresearch drop-worker", () => {
  const TOPIC = "dp-topic";
  const opts = (h: { home: string }) => ({ home: h.home, cwd: process.cwd() });
  const noKill: DropWorkerDeps = { killPane: () => {} };
  it("prunes the named agent from workers.txt and reports remaining N", async () => {
    const h = home();
    const art = autoresearchArtDir(TOPIC, opts(h));
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "workers.txt"), "rex\nkeeli\ncolt\n");
    expect(await dropWorkerWith([TOPIC, "keeli"], noKill, opts(h))).toBe(0);
    expect(readFileSync(join(art, "workers.txt"), "utf8")).toBe("rex\ncolt\n");
  });
  it("writes an empty workers.txt when the last agent is dropped", async () => {
    const h = home();
    const art = autoresearchArtDir(TOPIC, opts(h));
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "workers.txt"), "rex\n");
    expect(await dropWorkerWith([TOPIC, "rex"], noKill, opts(h))).toBe(0);
    expect(readFileSync(join(art, "workers.txt"), "utf8")).toBe("");
  });
  it("rc 1 when workers.txt is missing", async () => {
    const h = home();
    expect(await dropWorkerWith([TOPIC, "rex"], noKill, opts(h))).toBe(1);
  });
  it("rc 1 when the agent is not present", async () => {
    const h = home();
    const art = autoresearchArtDir(TOPIC, opts(h));
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "workers.txt"), "rex\n");
    expect(await dropWorkerWith([TOPIC, "ghost"], noKill, opts(h))).toBe(1);
  });
  it("rc 2 on bad usage", async () => {
    const h = home();
    expect(await dropWorkerWith([TOPIC], noKill, opts(h))).toBe(2);
  });
  it("best-effort kills the dropped agent's preflight pane", async () => {
    const h = home();
    const art = autoresearchArtDir(TOPIC, opts(h));
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "workers.txt"), "rex\nkeeli\n");
    writeFileSync(join(art, "preflight-panes.txt"), "rex\t%5\nkeeli\t%6\n");
    const killed: string[] = [];
    await dropWorkerWith([TOPIC, "keeli"], { killPane: (p) => killed.push(p) }, opts(h));
    expect(killed).toEqual(["%6"]);
  });
});

describe("autoresearch experiment timeout env override", () => {
  const KEY = "AP_AUTORESEARCH_EXPERIMENT_TIMEOUT_OVERRIDE";
  const orig = process.env[KEY];
  afterEach(() => { if (orig === undefined) delete process.env[KEY]; else process.env[KEY] = orig; });
  it("honors a positive-integer override", () => {
    process.env[KEY] = "900";
    expect(experimentTimeoutDefault()).toBe(900);
  });
  it("falls through to the contracts default on a non-positive / non-integer value", () => {
    process.env[KEY] = "0";
    expect(experimentTimeoutDefault()).toBe(consultTimeout("experiment"));
    process.env[KEY] = "abc";
    expect(experimentTimeoutDefault()).toBe(consultTimeout("experiment"));
  });
});

// ---- Phase C: experiment-send — dispatch ONE experiment to a persistent codex worker ----

describe("autoresearch experiment-send", () => {
  const TOPIC = "es-topic";
  const INST = "bravo";
  const MODEL = "codex";
  // resolveModel (in ipc.ts) looks up the worker via topicDir(topic) with NO cwd opt,
  // so it hashes process.cwd(). Scaffold under the same cwd so the worker dir + art dir
  // (which thread opts) and resolveModel's lookup all land on one repoHash. home is set
  // via AP_HOME (freshHome) so the state root agrees regardless.
  const opts = (h: { home: string }) => ({ home: h.home, cwd: process.cwd() });

  /** Scaffold an in-flight topic: art dir + metric.md + topic.txt + worker state.txt (idle) +
   *  a live worker dir (pane.json + outbox.jsonl) so resolveModel/outbox/paneMetaRead resolve. */
  function scaffold(h: { home: string }, over: { phase?: string; metric?: boolean; state?: boolean; outbox?: boolean; sota?: string } = {}) {
    const o = opts(h);
    const art = autoresearchArtDir(TOPIC, o);
    mkdirSync(art, { recursive: true });
    if (over.metric !== false) writeFileSync(join(art, "metric.md"), "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n");
    writeFileSync(join(art, "topic.txt"), "improve accuracy");
    if (over.sota) writeFileSync(join(art, "sota.md"), over.sota);
    const sd = workerStateDir(art, INST);
    if (over.state !== false) { mkdirSync(sd, { recursive: true }); writeFileSync(join(sd, "state.txt"), `phase=${over.phase ?? "idle"}\nexp_counter=0\n`); }
    else mkdirSync(sd, { recursive: true });
    const pd = workerDir(INST, MODEL, TOPIC, o);
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "pane.json"), JSON.stringify({ pane_id: "%7", agent: INST, model: MODEL, spawned_at: "t" }));
    if (over.outbox !== false) writeFileSync(join(pd, "outbox.jsonl"), "");
    return { art, sd, pd, o };
  }

  function deps(h: { home: string }, over: Partial<ExperimentSendDeps> = {}): ExperimentSendDeps {
    return {
      now: () => "T",
      probeHardware: () => "no-gpu",
      paneSend: async () => {},
      consultTimeout: () => 1800,
      dryRun: true,
      opts: opts(h),
      ...over,
    };
  }

  /** Seed a campaign ledger + controller.gen into an already-scaffolded art dir. */
  function seedLedger(art: string, gen = 1) {
    writeFileSync(ledgerPath(art), appendEvent("", { gen: 1, ts: "T", kind: "campaign-init" }));
    writeFileSync(join(art, "controller.gen"), renderGen(gen, "T", "test"));
  }

  it("with a ledger: intent before delivered; delivered carries the pre-send outbox offset", async () => {
    const h = home();
    const { art, pd } = scaffold(h);
    seedLedger(art);
    writeFileSync(join(pd, "outbox.jsonl"), '{"event":"ready","ts":"t"}\n'); // non-zero pre-send offset
    const pre = statSync(join(pd, "outbox.jsonl")).size;
    const rc = await experimentSendWith([TOPIC, INST, "exp-001", "baseline", "b"], deps(h));
    expect(rc).toBe(0);
    const evs = parseLedger(readFileSync(ledgerPath(art), "utf8"));
    const intent = evs.find((e) => e.kind === "dispatch-intent");
    const delivered = evs.find((e) => e.kind === "dispatch-delivered");
    expect(intent).toMatchObject({ agent: INST, exp_id: "exp-001", gen: 1 });
    expect(delivered).toMatchObject({ agent: INST, exp_id: "exp-001" });
    expect(intent!.seq).toBeLessThan(delivered!.seq);
    expect(delivered!.data?.outboxOffset).toBe(pre);
  });

  it("crash injection: DI inboxWrite throws -> intent recorded, no delivered, state.txt untouched", async () => {
    const h = home();
    const { art, sd } = scaffold(h);
    seedLedger(art);
    const boom = () => { throw new Error("crash between intent and delivery"); };
    await expect(experimentSendWith([TOPIC, INST, "exp-001", "x", "y"], deps(h, { inboxWrite: boom })))
      .rejects.toThrow(/crash between/);
    const evs = parseLedger(readFileSync(ledgerPath(art), "utf8"));
    expect(evs.some((e) => e.kind === "dispatch-intent" && e.exp_id === "exp-001")).toBe(true);
    expect(evs.some((e) => e.kind === "dispatch-delivered")).toBe(false);
    expect(readFileSync(join(sd, "state.txt"), "utf8")).toContain("phase=idle"); // no transition
  });

  it("stale --gen refuses with rc 3 BEFORE any effect (no intent, no inbox)", async () => {
    const h = home();
    const { art } = scaffold(h);
    seedLedger(art, 2); // controller bumped to gen 2 (a resume happened)
    const spy = vi.fn();
    const rc = await experimentSendWith(["--gen", "1", TOPIC, INST, "exp-001", "x", "y"], deps(h, { inboxWrite: spy }));
    expect(rc).toBe(3);
    expect(spy).not.toHaveBeenCalled();
    expect(parseLedger(readFileSync(ledgerPath(art), "utf8")).some((e) => e.kind === "dispatch-intent")).toBe(false);
  });

  it("matching --gen dispatches normally (rc 0)", async () => {
    const h = home();
    const { art } = scaffold(h);
    seedLedger(art, 1);
    expect(await experimentSendWith(["--gen", "1", TOPIC, INST, "exp-001", "x", "y"], deps(h))).toBe(0);
    void art;
  });

  it("no ledger (old campaign): no ledger file created, dispatch behaves as today", async () => {
    const h = home();
    const { art } = scaffold(h);
    expect(await experimentSendWith([TOPIC, INST, "exp-001", "x", "y"], deps(h))).toBe(0);
    expect(existsSync(ledgerPath(art))).toBe(false);
  });

  it("malformed --gen -> rc 2", async () => {
    const h = home();
    scaffold(h);
    expect(await experimentSendWith(["--gen", "zero", TOPIC, INST, "exp-001", "x", "y"], deps(h))).toBe(2);
  });

  it("idle worker -> rc 0: renders prompt.md, writes inbox + transitions state", async () => {
    const h = home();
    const { art, sd, o } = scaffold(h);
    const rc = await experimentSendWith([TOPIC, INST, "exp-001", "baseline", "a plain baseline"], deps(h));
    expect(rc).toBe(0);
    const promptPath = join(art, "workers", INST, "experiments", "exp-001", "prompt.md");
    expect(existsSync(promptPath)).toBe(true);
    const prompt = readFileSync(promptPath, "utf8");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("baseline");
    expect(prompt).toContain("a plain baseline");
    // inbox carries the prompt + the canonical fence
    const inbox = readFileSync(inboxPath(INST, MODEL, TOPIC), "utf8");
    expect(inbox).toContain("a plain baseline");
    expect(inbox).toContain("END_OF_INSTRUCTION");
    // A1: the experiment template owns the SOLE done contract — no generic wrapper.
    expect(inbox).not.toContain("<one-line summary>");
    expect((inbox.match(/"event":"done"/g) ?? []).length).toBe(1);
    expect(inbox).toContain("experiment exp-001 metric=<value> status=<status>");
    // state transition
    const st = readFileSync(join(sd, "state.txt"), "utf8");
    expect(st).toContain("phase=working");
    expect(st).toContain("current_exp_id=exp-001");
    expect(st).toContain("exp_counter=1");
    expect(st).toContain("last_event=dispatched");
    void art; void o;
  });

  it("inbox carries exactly one done contract — the template's specific one, not the generic wrapper", async () => {
    const h = home();
    scaffold(h);
    await experimentSendWith([TOPIC, INST, "exp-001", "baseline", "a plain baseline"], deps(h));
    const inbox = readFileSync(inboxPath(INST, MODEL, TOPIC), "utf8");
    expect(inbox).toContain("END_OF_INSTRUCTION");
    expect(inbox).not.toContain("<one-line summary>");
    expect((inbox.match(/"event":"done"/g) ?? []).length).toBe(1);
  });

  it("phase=working -> rc 1 (state untouched)", async () => {
    const h = home();
    const { sd } = scaffold(h, { phase: "working" });
    expect(await experimentSendWith([TOPIC, INST, "exp-002", "x", "y"], deps(h))).toBe(1);
    expect(readFileSync(join(sd, "state.txt"), "utf8")).toContain("phase=working");
  });

  it("phase=abandoned -> rc 2 (distinct)", async () => {
    const h = home();
    scaffold(h, { phase: "abandoned" });
    expect(await experimentSendWith([TOPIC, INST, "exp-002", "x", "y"], deps(h))).toBe(2);
  });

  it("bad exp-id -> rc 2", async () => {
    const h = home();
    scaffold(h);
    expect(await experimentSendWith([TOPIC, INST, "exp1", "x", "y"], deps(h))).toBe(2);
  });

  it("bad agent -> rc 2", async () => {
    const h = home();
    scaffold(h);
    expect(await experimentSendWith([TOPIC, "Alpha", "exp-001", "x", "y"], deps(h))).toBe(2);
  });

  it("bad --timeout -> rc 2", async () => {
    const h = home();
    scaffold(h);
    expect(await experimentSendWith(["--timeout", "x", TOPIC, INST, "exp-001", "x", "y"], deps(h))).toBe(2);
  });

  it("wrong positional count -> rc 2", async () => {
    const h = home();
    scaffold(h);
    expect(await experimentSendWith([TOPIC, INST, "exp-001"], deps(h))).toBe(2);
  });

  it("missing metric.md -> rc 1", async () => {
    const h = home();
    scaffold(h, { metric: false });
    expect(await experimentSendWith([TOPIC, INST, "exp-001", "x", "y"], deps(h))).toBe(1);
  });

  it("missing state.txt -> rc 1", async () => {
    const h = home();
    scaffold(h, { state: false });
    expect(await experimentSendWith([TOPIC, INST, "exp-001", "x", "y"], deps(h))).toBe(1);
  });

  it("missing outbox -> rc 1", async () => {
    const h = home();
    scaffold(h, { outbox: false });
    expect(await experimentSendWith([TOPIC, INST, "exp-001", "x", "y"], deps(h))).toBe(1);
  });

  it("--parent with a valid same-lane parent writes lineage.txt and returns 0 (B2)", async () => {
    const h = home();
    const { art } = scaffold(h);
    mkdirSync(experimentDir(art, INST, "exp-001"), { recursive: true });
    const rc = await experimentSendWith(["--parent", "exp-001", TOPIC, INST, "exp-002", "typed-routing", "tweak lr only"], deps(h));
    expect(rc).toBe(0);
    const lp = join(experimentDir(art, INST, "exp-002"), "lineage.txt");
    expect(existsSync(lp)).toBe(true);
    expect(readFileSync(lp, "utf8")).toContain("parent_id=exp-001");
  });
  it("--parent to a non-existent exp returns rc 1 (B2)", async () => {
    const h = home();
    scaffold(h);
    expect(await experimentSendWith(["--parent", "exp-099", TOPIC, INST, "exp-002", "x", "y"], deps(h))).toBe(1);
  });
  it("no --parent writes no lineage.txt (Draft) and returns 0 (B2)", async () => {
    const h = home();
    const { art } = scaffold(h);
    expect(await experimentSendWith([TOPIC, INST, "exp-001", "single-pass", "baseline"], deps(h))).toBe(0);
    expect(existsSync(join(experimentDir(art, INST, "exp-001"), "lineage.txt"))).toBe(false);
  });

  it("missing art dir -> rc 1", async () => {
    const h = home();
    // no scaffold at all
    expect(await experimentSendWith([TOPIC, INST, "exp-001", "x", "y"], deps(h))).toBe(1);
  });

  it("--context-file unreadable -> rc 2", async () => {
    const h = home();
    scaffold(h);
    expect(await experimentSendWith(["--context-file", "/no/such/file", TOPIC, INST, "exp-001", "x", "y"], deps(h))).toBe(2);
  });

  it("--context-file readable -> its content appears in prompt.md", async () => {
    const h = home();
    const { art } = scaffold(h);
    const ctx = join(h.home, "ctx.txt");
    writeFileSync(ctx, "SPECIAL_CONTEXT_MARKER");
    const rc = await experimentSendWith(["--context-file", ctx, TOPIC, INST, "exp-003", "x", "y"], deps(h));
    expect(rc).toBe(0);
    const prompt = readFileSync(join(art, "workers", INST, "experiments", "exp-003", "prompt.md"), "utf8");
    expect(prompt).toContain("SPECIAL_CONTEXT_MARKER");
  });

  it("--smoke-test failing -> rc 2, smoke-test.err written, state still idle", async () => {
    const h = home();
    const { art, sd } = scaffold(h);
    const script = join(h.home, "smoke.sh");
    writeFileSync(script, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const rc = await experimentSendWith(["--smoke-test", script, TOPIC, INST, "exp-004", "x", "y"],
      deps(h, { runSmokeTest: () => ({ ok: false, stderr: "boom" }) }));
    expect(rc).toBe(2);
    expect(readFileSync(join(art, "workers", INST, "experiments", "exp-004", "smoke-test.err"), "utf8")).toContain("boom");
    expect(readFileSync(join(sd, "state.txt"), "utf8")).toContain("phase=idle");
  });

  it("sota.md present -> prompt.md contains the SOTA reference heading", async () => {
    const h = home();
    const { art } = scaffold(h, { sota: "# SOTA reference — mnist\n\n| a | b |\n" });
    const rc = await experimentSendWith([TOPIC, INST, "exp-005", "x", "y"], deps(h));
    expect(rc).toBe(0);
    const prompt = readFileSync(join(art, "workers", INST, "experiments", "exp-005", "prompt.md"), "utf8");
    expect(prompt).toContain("## Reference: SOTA");
  });

  it("best-effort nudge: a throwing paneSend still yields rc 0 with inbox + state written", async () => {
    const h = home();
    const { sd } = scaffold(h);
    const rc = await experimentSendWith([TOPIC, INST, "exp-006", "x", "y"],
      deps(h, { dryRun: false, paneSend: async () => { throw new Error("tmux down"); } }));
    expect(rc).toBe(0);
    expect(readFileSync(inboxPath(INST, MODEL, TOPIC), "utf8")).toContain("END_OF_INSTRUCTION");
    expect(readFileSync(join(sd, "state.txt"), "utf8")).toContain("phase=working");
  });
});

// ---- Phase C: score — thin FS shell over computeScore ----

describe("autoresearch score", () => {
  const SCORE_OPTS = (h: { home: string }) => ({ ...liveScoreDeps, opts: { home: h.home } });

  /** Write a valid result.json for one experiment. metric_name defaults to accuracy. */
  function result(over: { metric?: number; metricName?: string; approach?: string } = {}): string {
    return JSON.stringify({
      branch_id: "b", approach_label: over.approach ?? "approach",
      metric_name: over.metricName ?? "accuracy",
      metric_value: over.metric ?? 0.9, status: "ok", runtime_s: 10,
      log_paths: [], checkpoint_path: null, notes: "",
    });
  }

  /** Scaffold an in-flight autoresearch art dir with metric.md + two working workers each with one
   *  experiment result.json. `over.experiments` patches the per-agent result body/expId. */
  function scaffold(h: { home: string }, workers: Record<string, { expId: string; body: string; experiments?: boolean }>) {
    const art = autoresearchArtDir("topic", { home: h.home });
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "metric.md"), "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n");
    for (const [inst, p] of Object.entries(workers)) {
      const sd = workerStateDir(art, inst);
      mkdirSync(sd, { recursive: true });
      writeFileSync(join(sd, "state.txt"), `phase=working\ncurrent_exp_id=${p.expId}\n`);
      if (p.experiments !== false) {
        const expDir = join(sd, "experiments", p.expId);
        mkdirSync(expDir, { recursive: true });
        writeFileSync(join(expDir, "result.json"), p.body);
      }
    }
    return art;
  }

  it("rc 0; writes scoreboard.md (ranked) + results.tsv + clears phases to idle", async () => {
    const h = home();
    const art = scaffold(h, {
      alto: { expId: "exp-001", body: result({ metric: 0.95 }) },
      bass: { expId: "exp-001", body: result({ metric: 0.90 }) },
    });
    const rc = await scoreWith(["topic"], SCORE_OPTS(h));
    expect(rc).toBe(0);

    const sb = readFileSync(join(art, "scoreboard.md"), "utf8");
    expect(existsSync(join(art, "scoreboard.md"))).toBe(true);
    // 0.95 worker ranked #1, 0.90 ranked #2.
    const rank1 = sb.split("\n").find((l) => l.startsWith("| 1 |"))!;
    const rank2 = sb.split("\n").find((l) => l.startsWith("| 2 |"))!;
    expect(rank1).toContain("exp-001");
    expect(rank1).toContain("0.9500");
    expect(rank2).toContain("0.9000");

    const tsv = readFileSync(join(art, "results.tsv"), "utf8");
    expect(existsSync(join(art, "results.tsv"))).toBe(true);
    const tsvLines = tsv.trimEnd().split("\n");
    expect(tsvLines[0]).toBe("exp_id\tagent\tapproach\tmetric\tstatus\truntime_s\tmetric_name");
    expect(tsvLines).toHaveLength(3); // header + 2 rows
    // ascending walk order (alto before bass)
    expect(tsvLines[1]).toContain("alto");
    expect(tsvLines[2]).toContain("bass");

    // phase cleared on both workers
    for (const inst of ["alto", "bass"]) {
      const st = readFileSync(join(workerStateDir(art, inst), "state.txt"), "utf8");
      expect(st).toContain("phase=idle");
      expect(st).toContain("current_exp_id=");
      expect(st).not.toMatch(/current_exp_id=exp-001/);
    }
  });

  it("a bad result (metric_name mismatch) writes result-validation.txt and is absent from scoreboard; rc 0", async () => {
    const h = home();
    const art = scaffold(h, {
      good: { expId: "exp-001", body: result({ metric: 0.95 }) },
      bad: { expId: "exp-001", body: result({ metric: 0.80, metricName: "auc" }) },
    });
    const rc = await scoreWith(["topic"], SCORE_OPTS(h));
    expect(rc).toBe(0);
    const sidecar = join(workerStateDir(art, "bad"), "experiments", "exp-001", "result-validation.txt");
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(sidecar, "utf8")).toContain("FAILED");
    const sb = readFileSync(join(art, "scoreboard.md"), "utf8");
    expect(sb).toContain("0.9500"); // good row present
    expect(sb).not.toContain("0.8000"); // bad row absent
  });

  it("no topic -> rc 2", async () => {
    const h = home();
    expect(await scoreWith([], SCORE_OPTS(h))).toBe(2);
  });

  it(">1 positional -> rc 2", async () => {
    const h = home();
    expect(await scoreWith(["a", "b"], SCORE_OPTS(h))).toBe(2);
  });

  it("missing workers dir -> rc 1", async () => {
    const h = home();
    const art = autoresearchArtDir("topic", { home: h.home });
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "metric.md"), "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n");
    expect(await scoreWith(["topic"], SCORE_OPTS(h))).toBe(1);
  });

  it("ENOENT-safe: a worker with state.txt but no experiments/ dir does not crash -> rc 0", async () => {
    const h = home();
    const art = autoresearchArtDir("topic", { home: h.home });
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "metric.md"), "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n");
    const sd = workerStateDir(art, "quick");
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, "state.txt"), "phase=working\ncurrent_exp_id=exp-001\n");
    // NO experiments/ dir under quick -> live listDir must return [] not throw.
    expect(await scoreWith(["topic"], SCORE_OPTS(h))).toBe(0);
  });

  it("writes coverage.tsv from computeScore's coverageRows (B1)", async () => {
    const h = home();
    const art = autoresearchArtDir("topic", { home: h.home });
    mkdirSync(workersDir(art), { recursive: true });   // scoreWith requires workers/ to exist
    const writes: { path: string; content: string }[] = [];
    const comp: ScoreComputation = {
      scoreboardMd: "", resultsTsv: "", sidecars: [], staleSidecars: [], phaseClears: [],
      warnings: [], manifests: [], sanityRows: [], lineageRows: [],
      coverageRows: [{ family: "single-pass", count: 2, best: "0.96", ts: "T" }],
    };
    const deps: AutoresearchScoreDeps = {
      computeScore: () => comp,
      fs: { exists: () => false, read: () => null, listDir: () => [] },
      writeAtomic: (path, content) => { writes.push({ path, content }); },
      removeFile: () => {},
      now: () => "T",
      opts: { home: h.home },
    };
    expect(await scoreWith(["topic"], deps)).toBe(0);
    const cov = writes.find((w) => w.path === join(art, "coverage.tsv"));
    expect(cov).toBeDefined();
    expect(cov!.content).toBe("family\tcount\tbest\tts\nsingle-pass\t2\t0.96\tT\n");
  });

  it("writes lineage.tsv from computeScore's lineageRows (B2)", async () => {
    const h = home();
    const art = autoresearchArtDir("topic", { home: h.home });
    mkdirSync(workersDir(art), { recursive: true });   // scoreWith requires workers/ to exist
    const writes: { path: string; content: string }[] = [];
    const comp: ScoreComputation = {
      scoreboardMd: "", resultsTsv: "", sidecars: [], staleSidecars: [], phaseClears: [],
      warnings: [], manifests: [], sanityRows: [], coverageRows: [],
      lineageRows: [{ expId: "exp-003", agent: "golf", parentId: "exp-002", knobsChanged: "2", verdict: "improve-multi", ts: "T" }],
    };
    const deps: AutoresearchScoreDeps = {
      computeScore: () => comp,
      fs: { exists: () => false, read: () => null, listDir: () => [] },
      writeAtomic: (path, content) => { writes.push({ path, content }); },
      removeFile: () => {},
      now: () => "T",
      opts: { home: h.home },
    };
    expect(await scoreWith(["topic"], deps)).toBe(0);
    const lin = writes.find((w) => w.path === join(art, "lineage.tsv"));
    expect(lin).toBeDefined();
    expect(lin!.content).toBe("exp_id\tagent\tparent_id\tknobs_changed\tverdict\tts\nexp-003\tgolf\texp-002\t2\timprove-multi\tT\n");
  });
});

// ---- Phase C: monitor — per-worker liveness scan loop (C7) ----

describe("autoresearch monitor", () => {
  const TOPIC = "mon-topic";
  const INST = "alpha";
  const MODEL = "codex";
  // resolveModel hashes process.cwd() (no cwd opt), so scaffold under process.cwd().
  const opts = (h: { home: string }) => ({ home: h.home, cwd: process.cwd() });

  /** Scaffold an in-flight topic with a live codex worker (pane.json + outbox.jsonl carrying
   *  one done event) and a working state.txt under the art's worker state dir. */
  function scaffold(h: { home: string }) {
    const o = opts(h);
    const art = autoresearchArtDir(TOPIC, o);
    mkdirSync(art, { recursive: true });
    const pd = workerDir(INST, MODEL, TOPIC, o);
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "pane.json"), JSON.stringify({ agent: INST, model: MODEL, pane_id: "%1" }));
    writeFileSync(join(pd, "outbox.jsonl"), '{"event":"done","summary":"finished","ts":"T"}\n');
    const sd = workerStateDir(art, INST);
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, "state.txt"), "phase=working\n");
    return { art, pd, sd, o };
  }

  /** Capture process.stdout.write lines for the duration of fn. */
  async function capture(fn: () => Promise<number>): Promise<{ rc: number; lines: string[] }> {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const rc = await fn();
      return { rc, lines: lines.join("").split("\n").filter(Boolean) };
    } finally {
      spy.mockRestore();
    }
  }

  it("--once: emits the existing done event past a 0 cursor and persists the byte cursor; rc 0", async () => {
    const h = home();
    const { sd, pd } = scaffold(h);
    // Pre-seed the cursor at 0 so a fresh monitor's byte-tail sees the existing done line.
    writeFileSync(join(sd, "liveness-cursor.txt"), "0");
    const { rc, lines } = await capture(() => monitorRun([TOPIC, INST, "--once"], opts(h)));
    expect(rc).toBe(0);
    const events = lines.map((l) => JSON.parse(l) as { worker: string; event: string });
    expect(events.some((e) => e.worker === INST && e.event === "done")).toBe(true);
    // cursor advanced to the outbox byte size
    const size = readFileSync(join(pd, "outbox.jsonl")).length;
    expect(readFileSync(join(sd, "liveness-cursor.txt"), "utf8")).toBe(String(size));
  });

  it("wrong arg count -> rc 2", async () => {
    const h = home();
    scaffold(h);
    const { rc } = await capture(() => monitorRun([TOPIC], opts(h)));
    expect(rc).toBe(2);
  });

  it("missing art dir -> rc 2", async () => {
    const h = home();
    scaffold(h);
    const { rc } = await capture(() => monitorRun(["nope", INST, "--once"], opts(h)));
    expect(rc).toBe(2);
  });

  it("null model (no worker dir) -> rc 1", async () => {
    const h = home();
    scaffold(h);
    const { rc } = await capture(() => monitorRun([TOPIC, "ghost", "--once"], opts(h)));
    expect(rc).toBe(1);
  });

  it("--once flag is position-independent (leading flag) -> rc 0", async () => {
    const h = home();
    const { sd } = scaffold(h);
    writeFileSync(join(sd, "liveness-cursor.txt"), "0");
    const { rc } = await capture(() => monitorRun(["--once", TOPIC, INST], opts(h)));
    expect(rc).toBe(0);
  });

  it("non-once loop exits (does not hang) once the worker pane is gone", async () => {
    const h = home();
    scaffold(h);   // pane.json pane_id "%1" is present, so paneMetaRead resolves
    // Inject a probe that reports the pane dead + a 0ms tick + per-tick checks: the loop must exit
    // after two consecutive dead probes instead of polling forever. (Fails via the vitest timeout.)
    const { rc } = await capture(() => monitorRun([TOPIC, INST], {
      ...opts(h), paneAlive: async () => false, sleepMs: 0, paneCheckEveryTicks: 1,
    }));
    expect(rc).toBe(0);
  });

  it("non-once loop keeps running while the pane is alive (a live probe does not stop it early)", async () => {
    const h = home();
    scaffold(h);
    // Alive for the first checks, then dead — proves a live probe resets the dead-poll counter and
    // only a sustained death stops the loop (no false early-exit on a transient blip).
    let calls = 0;
    const { rc } = await capture(() => monitorRun([TOPIC, INST], {
      ...opts(h), paneAlive: async () => (++calls <= 3 ? calls % 2 === 1 : false), sleepMs: 0, paneCheckEveryTicks: 1,
    }));
    expect(rc).toBe(0);
    expect(calls).toBeGreaterThan(3);   // ran past the alive probes before the sustained death exit
  });
});

// ---- Phase C: status-brief — render a compact chat-shaped status update (C8) ----

describe("autoresearch status-brief", () => {
  const TOPIC = "sb-topic";
  const INST = "alpha";

  /** Scaffold an in-flight topic: art + metric.md + scoreboard.md (one OK row) +
   *  workers.txt (one agent) + the worker's working state.txt + its prompt.md. */
  function scaffold(h: { home: string }) {
    const o = { home: h.home };
    const art = autoresearchArtDir(TOPIC, o);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "metric.md"), "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n");
    writeFileSync(join(art, "scoreboard.md"), [
      "| Rank | Experiment | Agent | Metric | Status | Runtime | Approach | metric_name |",
      "|---|---|---|---|---|---|---|---|",
      "| 1 | exp-001 | alpha | 0.9500 | ok | 10.00s | baseline | accuracy |",
    ].join("\n") + "\n");
    writeFileSync(join(art, "workers.txt"), INST + "\n");
    const sd = workerStateDir(art, INST);
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, "state.txt"), "phase=working\ncurrent_exp_id=exp-001\n");
    const expDir = experimentDir(art, INST, "exp-001");
    mkdirSync(expDir, { recursive: true });
    writeFileSync(join(expDir, "prompt.md"), "Some preamble\n  Approach label:  baseline\nmore text\n");
    return { art, o };
  }

  async function capture(fn: (stdout: (l: string) => void) => Promise<number>): Promise<{ rc: number; text: string }> {
    const lines: string[] = [];
    const rc = await fn((l) => lines.push(l));
    return { rc, text: lines.join("\n") };
  }

  it("renders header, the | Worker | table with the working row, scoreboard top-3, and completion line; rc 0", async () => {
    const h = home();
    const { o } = scaffold(h);
    const { rc, text } = await capture((stdout) => statusBriefWith([TOPIC], { opts: o, stdout }));
    expect(rc).toBe(0);
    expect(text).toContain("## Experiment status");
    expect(text).toContain("| Worker | Phase | Current/last | Approach | Metric |");
    expect(text).not.toContain("| Trooper |");
    // working worker row: phase working, approach from prompt.md, metric (running)
    expect(text).toContain("| alpha | working | exp-001 | baseline | (running) |");
    // scoreboard top-3 line
    expect(text).toContain("1. alpha/exp-001 — 0.9500 — accuracy");
    // completion line
    expect(text).toContain("**Completion check:** floor_met=");
  });

  it("--latest-agent/--latest-exp name the just-landed experiment in the header", async () => {
    const h = home();
    const { o } = scaffold(h);
    const { rc, text } = await capture((stdout) =>
      statusBriefWith([TOPIC, "--latest-agent", INST, "--latest-exp", "exp-001"], { opts: o, stdout }));
    expect(rc).toBe(0);
    expect(text).toContain("## Experiment status — exp-001 (alpha) just landed");
  });

  it("non-working worker: approach comes from result.json (wins over prompt.md), metric is '<value> <status>'", async () => {
    const h = home();
    const o = { home: h.home };
    const art = autoresearchArtDir(TOPIC, o);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "metric.md"), "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n");
    writeFileSync(join(art, "workers.txt"), INST + "\n");
    const sd = workerStateDir(art, INST);
    mkdirSync(sd, { recursive: true });
    // Finished worker: idle, current/last exp via current_exp_id.
    writeFileSync(join(sd, "state.txt"), "phase=idle\ncurrent_exp_id=exp-002\n");
    const expDir = experimentDir(art, INST, "exp-002");
    mkdirSync(expDir, { recursive: true });
    // prompt.md says "baseline"; result.json says "deep-net" -> result.json must win.
    writeFileSync(join(expDir, "prompt.md"), "  Approach label:  baseline\n");
    writeFileSync(join(expDir, "result.json"), JSON.stringify({
      branch_id: "b", approach_label: "deep-net", metric_name: "accuracy",
      metric_value: 0.9, status: "ok", runtime_s: 12, log_paths: [],
    }));
    const { rc, text } = await capture((stdout) => statusBriefWith([TOPIC], { opts: o, stdout }));
    expect(rc).toBe(0);
    // result.json's approach_label (deep-net) wins; prompt.md's baseline must NOT appear.
    expect(text).toContain("| alpha | idle | exp-002 | deep-net | 0.9 ok |");
    expect(text).not.toContain("baseline");
  });

  it("metric.md absent -> completion line is the absent line (not an all-no row)", async () => {
    const h = home();
    const o = { home: h.home };
    const art = autoresearchArtDir(TOPIC, o);
    mkdirSync(art, { recursive: true });
    // scoreboard.md present but metric.md absent -> completion can't be computed.
    writeFileSync(join(art, "scoreboard.md"), [
      "| Rank | Experiment | Agent | Metric | Status | Runtime | Approach | metric_name |",
      "|---|---|---|---|---|---|---|---|",
      "| 1 | exp-001 | alpha | 0.9500 | ok | 10.00s | baseline | accuracy |",
    ].join("\n") + "\n");
    writeFileSync(join(art, "workers.txt"), INST + "\n");
    const { rc, text } = await capture((stdout) => statusBriefWith([TOPIC], { opts: o, stdout }));
    expect(rc).toBe(0);
    expect(text).toContain("**Completion check:** _(scoreboard or metric absent)_");
    expect(text).not.toContain("floor_met=");
  });

  it("no topic -> rc 2", async () => {
    const h = home();
    const { rc } = await capture((stdout) => statusBriefWith([], { opts: { home: h.home }, stdout }));
    expect(rc).toBe(2);
  });

  it("renders the Coverage line by joining coverage.tsv (B1)", async () => {
    const h = home();
    const o = { home: h.home };
    const art = autoresearchArtDir(TOPIC, o);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "metric.md"),
      "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n**min_families:** 2\n");
    writeFileSync(join(art, "scoreboard.md"), [
      "| Rank | Experiment | Agent | Metric | Status | Runtime | Approach | metric_name |",
      "|---|---|---|---|---|---|---|---|",
      "| 1 | exp-001 | alpha | 0.9600 | ok | 10.00s | single-pass | accuracy |",
    ].join("\n") + "\n");
    writeFileSync(join(art, "workers.txt"), INST + "\n");
    writeFileSync(join(art, "coverage.tsv"),
      "family\tcount\tbest\tts\nsingle-pass\t2\t0.96\tT\ntyped-routing\t1\t0.94\tT\n");
    const { rc, text } = await capture((stdout) => statusBriefWith([TOPIC], { opts: o, stdout }));
    expect(rc).toBe(0);
    expect(text).toContain("**Coverage:** 2 families [single-pass×2, typed-routing×1]");
    expect(text).toContain("min_families=2 (met)");
  });
});

import { createHash } from "node:crypto";
import { verifyPlanWith, type VerifyPlanDeps } from "../src/commands/autoresearch.js";

describe("autoresearch verify-plan", () => {
  const baseResult = { metric_value: 0.9, verify: { kind: "rescore", command: "python s.py", inputs: ["./p.json"], metric_from: "marker" } };
  const manifestFor = (preds: string) => ({ command: "python s.py", hashes: { "./p.json": createHash("sha256").update(preds).digest("hex") } });

  function deps(over: Partial<VerifyPlanDeps>): { d: VerifyPlanDeps; rows: any[]; out: string[] } {
    const rows: any[] = []; const out: string[] = [];
    const d: VerifyPlanDeps = {
      readResult: () => baseResult,
      readManifest: () => manifestFor("PREDS"),
      readInput: () => "PREDS",
      writeRow: (_a, _i, _e, r) => { rows.push(r); },
      now: () => "T",
      stdout: (l) => out.push(l),
      ...over,
    };
    return { d, rows, out };
  }

  it("clean -> emits RUN_CMD, persists nothing", async () => {
    const { d, rows, out } = deps({});
    expect(await verifyPlanWith(["topic", "alpha", "exp-001"], d)).toBe(0);
    expect(out.some((l) => l.startsWith("RUN_CMD=python s.py"))).toBe(true);
    expect(out.some((l) => l.startsWith("METRIC_FROM=marker"))).toBe(true);
    expect(rows).toHaveLength(0);
  });
  it("provenance change -> persists mismatch, no RUN_CMD", async () => {
    const { d, rows, out } = deps({ readInput: () => "TAMPERED" });
    await verifyPlanWith(["topic", "alpha", "exp-001"], d);
    expect(rows[0]).toMatchObject({ verdict: "mismatch", reason: "provenance:./p.json" });
    expect(out.some((l) => l.startsWith("RUN_CMD"))).toBe(false);
  });
  it("rerun without --authorize-rerun -> pending", async () => {
    const { d, rows } = deps({ readResult: () => ({ metric_value: 1, verify: { kind: "rerun", command: "c" } }) });
    await verifyPlanWith(["topic", "alpha", "exp-001"], d);
    expect(rows[0]).toMatchObject({ verdict: "pending", reason: "rerun-deferred" });
  });
  it("missing result -> rc 1", async () => {
    const { d } = deps({ readResult: () => null });
    expect(await verifyPlanWith(["topic", "alpha", "exp-001"], d)).toBe(1);
  });
  it("bad arity -> rc 2", async () => {
    const { d } = deps({});
    expect(await verifyPlanWith(["topic", "alpha"], d)).toBe(2);
  });
});

import { verifyCheckWith, type VerifyCheckDeps } from "../src/commands/autoresearch.js";

describe("autoresearch verify-check", () => {
  function deps(over: Partial<VerifyCheckDeps>): { d: VerifyCheckDeps; rows: any[]; out: string[] } {
    const rows: any[] = []; const out: string[] = [];
    const d: VerifyCheckDeps = {
      readResult: () => ({ metric_value: 0.9, verify: { kind: "rescore", command: "c", metric_from: "marker" } }),
      readMetricMd: () => "**Primary metric:** accuracy\n",
      readStdout: () => "VERIFY_METRIC=0.901\n",
      readJson: () => null,
      writeRow: (_a, _i, _e, r) => rows.push(r),
      now: () => "T",
      stdout: (l) => out.push(l),
      ...over,
    };
    return { d, rows, out };
  }
  it("recomputed within epsilon -> verified", async () => {
    const { d, rows } = deps({});
    expect(await verifyCheckWith(["topic", "alpha", "exp-001", "--stdout-file", "/x"], d)).toBe(0);
    expect(rows[0]).toMatchObject({ verdict: "verified" });
  });
  it("beyond epsilon -> mismatch", async () => {
    const { d, rows } = deps({ readStdout: () => "VERIFY_METRIC=0.5\n" });
    await verifyCheckWith(["topic", "alpha", "exp-001", "--stdout-file", "/x"], d);
    expect(rows[0].verdict).toBe("mismatch");
  });
  it("--run-failed -> mismatch rerun-failed", async () => {
    const { d, rows } = deps({});
    await verifyCheckWith(["topic", "alpha", "exp-001", "--run-failed"], d);
    expect(rows[0]).toMatchObject({ verdict: "mismatch", reason: "rerun-failed" });
  });
  it("honors metric.md verify_epsilon", async () => {
    const { d, rows } = deps({ readMetricMd: () => "**Primary metric:** accuracy\n**verify_epsilon:** 0.2\n", readStdout: () => "VERIFY_METRIC=0.75\n" });
    await verifyCheckWith(["topic", "alpha", "exp-001", "--stdout-file", "/x"], d);
    expect(rows[0].verdict).toBe("verified");
  });
  it("missing --stdout-file and no --run-failed -> rc 2", async () => {
    const { d } = deps({});
    expect(await verifyCheckWith(["topic", "alpha", "exp-001"], d)).toBe(2);
  });
});

import { inspectPlanWith, inspectCheckWith, type InspectPlanDeps, type InspectCheckDeps } from "../src/commands/autoresearch.js";
type InspectionRowT = import("../src/core/autoresearchInspect.js").InspectionRow;

describe("autoresearch inspect-plan (C1)", () => {
  const mkPlan = (over: Partial<InspectPlanDeps> = {}, result: Record<string, unknown> | null = { metric_value: 0.9, metric_name: "accuracy", approach_label: "x", data_spec: { source: "ds" }, metric_formula: "macro-F1" }) => {
    const lines: string[] = []; const rows: InspectionRowT[] = [];
    const deps: InspectPlanDeps = {
      readResult: () => result,
      readMetricMd: () => "**Primary metric:** accuracy\n",
      inspectionCount: () => 0,
      workerProvider: () => "codex",
      writeRow: (_a, _i, _e, row) => { rows.push(row); },
      now: () => "T",
      stdout: (l) => lines.push(l),
      ...over,
    };
    return { deps, lines, rows };
  };
  it("without --authorize-inspect -> inconclusive inspect-deferred", async () => {
    const { deps, rows, lines } = mkPlan();
    expect(await inspectPlanWith(["t", "golf", "exp-001"], deps)).toBe(0);
    expect(rows[0].verdict).toBe("inconclusive");
    expect(rows[0].reason).toBe("inspect-deferred");
    expect(lines.join("\n")).toContain("VERDICT=inconclusive reason=inspect-deferred");
  });
  it("authorized but no data_spec -> run-card-insufficient", async () => {
    const { deps, rows } = mkPlan({}, { metric_value: 0.9, metric_name: "accuracy", approach_label: "x", metric_formula: "f" });
    expect(await inspectPlanWith(["t", "golf", "exp-001", "--authorize-inspect"], deps)).toBe(0);
    expect(rows[0].reason).toBe("run-card-insufficient");
  });
  it("authorized + budget hit -> budget-exhausted", async () => {
    const { deps, rows } = mkPlan({ inspectionCount: () => 5, readMetricMd: () => "**c1_budget:** 2\n**Primary metric:** accuracy\n" });
    expect(await inspectPlanWith(["t", "golf", "exp-001", "--authorize-inspect"], deps)).toBe(0);
    expect(rows[0].reason).toBe("budget-exhausted");
  });
  it("authorized + claude worker -> same-family", async () => {
    const { deps, rows } = mkPlan({ workerProvider: () => "claude" });
    expect(await inspectPlanWith(["t", "golf", "exp-001", "--authorize-inspect"], deps)).toBe(0);
    expect(rows[0].reason).toBe("same-family");
  });
  it("authorized + sufficient -> prints INSPECT_CWD + run-card", async () => {
    const { deps, lines } = mkPlan();
    expect(await inspectPlanWith(["t", "golf", "exp-001", "--authorize-inspect"], deps)).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("INSPECT_CWD=");
    expect(out).toContain("METRIC_FORMULA=macro-F1");
    expect(out).toContain("DATA_SPEC=");
  });
  it("missing result.json -> rc 1", async () => {
    const { deps } = mkPlan({}, null);
    expect(await inspectPlanWith(["t", "golf", "exp-001", "--authorize-inspect"], deps)).toBe(1);
  });
});

describe("autoresearch inspect-check (C1)", () => {
  const mkCheck = (over: Partial<InspectCheckDeps> = {}, result: Record<string, unknown> | null = { metric_value: 0.9, metric_name: "accuracy" }) => {
    const lines: string[] = []; const rows: InspectionRowT[] = [];
    const deps: InspectCheckDeps = {
      readResult: () => result,
      readMetricMd: () => "**Primary metric:** accuracy\n**c1_epsilon:** 0.02\n",
      readStdout: () => "VERIFY_METRIC=0.91\n",
      readJson: () => null,
      writeRow: (_a, _i, _e, row) => { rows.push(row); },
      now: () => "T",
      stdout: (l) => lines.push(l),
      ...over,
    };
    return { deps, lines, rows };
  };
  it("--stdout-file within c1_epsilon -> reproduced", async () => {
    const { deps, rows } = mkCheck();
    expect(await inspectCheckWith(["t", "golf", "exp-001", "--stdout-file", "/x"], deps)).toBe(0);
    expect(rows[0].verdict).toBe("reproduced");
  });
  it("--stdout-file beyond c1_epsilon -> not-reproduced", async () => {
    const { deps, rows } = mkCheck({ readStdout: () => "VERIFY_METRIC=0.5\n" });
    expect(await inspectCheckWith(["t", "golf", "exp-001", "--stdout-file", "/x"], deps)).toBe(0);
    expect(rows[0].verdict).toBe("not-reproduced");
  });
  it("--run-failed -> inconclusive", async () => {
    const { deps, rows } = mkCheck();
    expect(await inspectCheckWith(["t", "golf", "exp-001", "--run-failed"], deps)).toBe(0);
    expect(rows[0].verdict).toBe("inconclusive");
  });
  it("--integrity-refuted -> not-reproduced", async () => {
    const { deps, rows } = mkCheck();
    expect(await inspectCheckWith(["t", "golf", "exp-001", "--integrity-refuted"], deps)).toBe(0);
    expect(rows[0].verdict).toBe("not-reproduced");
    expect(rows[0].reason).toBe("integrity-refuted");
  });
});

describe("experiment template verify contract", () => {
  it("instructs the worker to emit a verify block + VERIFY_METRIC marker", () => {
    const tpl = readFileSync("config/prompt-templates/autoresearch/experiment.md", "utf8");
    expect(tpl).toContain("\"verify\"");
    expect(tpl).toContain("VERIFY_METRIC=");
    expect(tpl).toContain("rescore");
  });
});

describe("experiment template integrity attestation", () => {
  it("instructs the worker to emit an integrity block", () => {
    const tpl = readFileSync("config/prompt-templates/autoresearch/experiment.md", "utf8");
    expect(tpl).toContain("\"integrity\"");
    expect(tpl).toContain("split_before_fit");
    expect(tpl).toContain("no_train_test_overlap");
  });
});
