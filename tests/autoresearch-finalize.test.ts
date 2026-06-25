import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { finalizePhase, parseHardConstraints } from "../src/core/autoresearchFinalize.js";
import { finalizeWith, type AutoresearchFinalizeDeps } from "../src/commands/autoresearch.js";
import { autoresearchArtDir, workerStateDir, experimentDir } from "../src/core/autoresearch.js";
import { workerDir, repoHash as repoHashOf } from "../src/core/paths.js";
import { liveMemoryIo, retrieveForDispatch, type MemoryIo } from "../src/core/autoresearchMemoryStore.js";
import { policyFromMetric } from "../src/core/autoresearchLessonMap.js";
import { parseMetricMd } from "../src/core/autoresearchMetric.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h; }

// ---- PURE: finalizePhase ----
describe("finalizePhase", () => {
  it("working/stale/stuck/blocked -> incomplete", () => {
    for (const p of ["working", "stale", "stuck", "blocked"]) expect(finalizePhase(p)).toBe("incomplete");
  });
  it("idle/complete -> complete", () => {
    expect(finalizePhase("idle")).toBe("complete");
    expect(finalizePhase("complete")).toBe("complete");
  });
  it("failed/abandoned/unknown -> null (no write)", () => {
    expect(finalizePhase("failed")).toBeNull();
    expect(finalizePhase("abandoned")).toBeNull();
    expect(finalizePhase("")).toBeNull();
    expect(finalizePhase("whatever")).toBeNull();
  });
});

// ---- PURE: parseHardConstraints ----
describe("parseHardConstraints", () => {
  it("reads numeric k=v lines only inside the Hard constraints block, stops at blank line", () => {
    const md = [
      "# Experiment",
      "",
      "Prose mentioning mcts_sims=999 outside the block.",
      "",
      "**Hard constraints:**",
      "  epochs = 10",
      "  lr=0.001",
      "  batch_size = 64 extra-text-ignored",
      "",
      "  ignored = 5",
    ].join("\n");
    expect(parseHardConstraints(md)).toEqual([
      { key: "epochs", value: "10" },
      { key: "lr", value: "0.001" },
      { key: "batch_size", value: "64" },
    ]);
  });
  it("returns [] when the block header is absent", () => {
    expect(parseHardConstraints("no constraints here\nk=1\n")).toEqual([]);
  });
});

// ---- INTEGRATION ----
describe("autoresearch finalize", () => {
  const TOPIC = "fin-topic";
  const MODEL = "codex";
  const opts = (h: { home: string }) => ({ home: h.home, cwd: process.cwd() });
  const deps = (h: { home: string }, over: Partial<AutoresearchFinalizeDeps> = {}): AutoresearchFinalizeDeps => ({
    now: () => "2026-05-30T12:00:00Z",
    opts: opts(h),
    ...over,
  });

  /** Scaffold the art dir with workers.txt listing the given agents. */
  function scaffoldArt(h: { home: string }, agents: string[]) {
    const o = opts(h);
    const art = autoresearchArtDir(TOPIC, o);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "workers.txt"), agents.join("\n") + "\n");
    return { art, o };
  }

  /** Scaffold one worker: its art-tree state.txt + a live pane dir (pane.json + outbox.jsonl). */
  function scaffoldPart(h: { home: string }, art: string, inst: string, stateKv: string, outbox = "") {
    const o = opts(h);
    const sd = workerStateDir(art, inst);
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, "state.txt"), stateKv);
    const pd = workerDir(inst, MODEL, TOPIC, o);
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "pane.json"), JSON.stringify({ pane_id: "%1", agent: inst, model: MODEL, spawned_at: "t" }));
    writeFileSync(join(pd, "outbox.jsonl"), outbox);
    return { sd, pd };
  }

  function writeResult(art: string, inst: string, expId: string, obj: Record<string, unknown>) {
    const ed = experimentDir(art, inst, expId);
    mkdirSync(ed, { recursive: true });
    writeFileSync(join(ed, "result.json"), JSON.stringify(obj));
    return ed;
  }

  it("rc 1 when art dir is missing", async () => {
    const h = home();
    const rc = await finalizeWith([TOPIC], deps(h));
    expect(rc).toBe(1);
  });

  it("working worker with a terminal done event + a result.json -> reconciled to complete", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["bravo"]);
    const outbox = '{"event":"done","summary":"ok","ts":"2026-05-30T11:00:00Z"}\n';
    scaffoldPart(h, art, "bravo", "phase=working\ncurrent_exp_id=exp-001\n", outbox);
    writeResult(art, "bravo", "exp-001", {
      branch_id: "exp-001", approach_label: "a", metric_name: "acc", metric_value: 0.9,
      status: "ok", runtime_s: 1, log_paths: [], checkpoint_path: null, notes: "",
    });
    const rc = await finalizeWith([TOPIC], deps(h));
    expect(rc).toBe(0);
    const st = readFileSync(join(workerStateDir(art, "bravo"), "state.txt"), "utf8");
    expect(st).toContain("phase=complete");
  });

  it("working worker with NO terminal event -> incomplete", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["alpha"]);
    scaffoldPart(h, art, "alpha", "phase=working\ncurrent_exp_id=exp-001\n", "");
    const rc = await finalizeWith([TOPIC], deps(h));
    expect(rc).toBe(0);
    const st = readFileSync(join(workerStateDir(art, "alpha"), "state.txt"), "utf8");
    expect(st).toContain("phase=incomplete");
  });

  it("idle worker -> complete", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["charlie"]);
    scaffoldPart(h, art, "charlie", "phase=idle\n", "");
    await finalizeWith([TOPIC], deps(h));
    const st = readFileSync(join(workerStateDir(art, "charlie"), "state.txt"), "utf8");
    expect(st).toContain("phase=complete");
  });

  it("ok+metric_value:null result.json -> rewritten to partial", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["golf"]);
    scaffoldPart(h, art, "golf", "phase=idle\n", "");
    writeResult(art, "golf", "exp-001", {
      branch_id: "exp-001", approach_label: "a", metric_name: "acc", metric_value: null,
      status: "ok", runtime_s: 1, log_paths: [], checkpoint_path: null, notes: "",
    });
    await finalizeWith([TOPIC], deps(h));
    const r = JSON.parse(readFileSync(join(experimentDir(art, "golf", "exp-001"), "result.json"), "utf8"));
    expect(r.status).toBe("partial");
  });

  it("structured halt.flag -> session-summary.md with ## Halt, reason, ## Status, no format= line", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["foxtrot"]);
    scaffoldPart(h, art, "foxtrot", "phase=idle\n", "");
    writeFileSync(join(art, "halt.flag"), "halted_by=hub\nhalted_at=2026-05-30T11:00:00Z\nreason=converged\n");
    const rc = await finalizeWith([TOPIC], deps(h));
    expect(rc).toBe(0);
    const ss = readFileSync(join(art, "session-summary.md"), "utf8");
    expect(ss).toContain("## Halt");
    expect(ss).toContain("reason=converged");
    expect(ss).not.toContain("format=");
    expect(ss).toContain("## Status");
    expect(ss).toContain("| Worker |");
  });

  it("prune removes other *.pt files, keeps checkpoint_path; --keep-intermediate keeps both", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["delta"]);
    scaffoldPart(h, art, "delta", "phase=idle\n", "");
    const ed = writeResult(art, "delta", "exp-001", {
      branch_id: "exp-001", approach_label: "a", metric_name: "acc", metric_value: 0.9,
      status: "ok", runtime_s: 1, log_paths: [], checkpoint_path: "model.pt", notes: "",
    });
    writeFileSync(join(ed, "model.pt"), "keep");
    writeFileSync(join(ed, "epoch1.pt"), "drop");
    await finalizeWith([TOPIC], deps(h));
    expect(existsSync(join(ed, "model.pt"))).toBe(true);
    expect(existsSync(join(ed, "epoch1.pt"))).toBe(false);

    // --keep-intermediate keeps both
    const h2 = home();
    const { art: art2 } = scaffoldArt(h2, ["delta"]);
    scaffoldPart(h2, art2, "delta", "phase=idle\n", "");
    const ed2 = writeResult(art2, "delta", "exp-001", {
      branch_id: "exp-001", approach_label: "a", metric_name: "acc", metric_value: 0.9,
      status: "ok", runtime_s: 1, log_paths: [], checkpoint_path: "model.pt", notes: "",
    });
    writeFileSync(join(ed2, "model.pt"), "keep");
    writeFileSync(join(ed2, "epoch1.pt"), "keep2");
    await finalizeWith(["--keep-intermediate", TOPIC], deps(h2, { keepIntermediate: undefined }));
    expect(existsSync(join(ed2, "model.pt"))).toBe(true);
    expect(existsSync(join(ed2, "epoch1.pt"))).toBe(true);
  });

  it("rc 0 on the happy path with a session-summary.md written", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["bravo", "alpha"]);
    scaffoldPart(h, art, "bravo", "phase=idle\n", "");
    scaffoldPart(h, art, "alpha", "phase=working\n", "");
    const rc = await finalizeWith([TOPIC], deps(h));
    expect(rc).toBe(0);
    expect(existsSync(join(art, "session-summary.md"))).toBe(true);
  });

  it("audit_warn appends after size (truncate) and coexists with size_warn", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["hotel"]);
    scaffoldPart(h, art, "hotel", "phase=idle\n", "");
    const ed = writeResult(art, "hotel", "exp-001", {
      branch_id: "exp-001", approach_label: "a", metric_name: "acc", metric_value: 0.9,
      status: "ok", runtime_s: 1, log_paths: [], checkpoint_path: null, notes: "",
    });
    writeFileSync(join(ed, "prompt.md"), [
      "# Experiment", "", "**Hard constraints:**", "  max_params = 100000", "",
    ].join("\n"));
    writeFileSync(join(ed, "audit.json"), JSON.stringify({ max_params: 120000 }));
    // A bulky file forces a size_warn at the low threshold; result.json + prompt.md
    // + audit.json already count toward the depth-1 file_count.
    writeFileSync(join(ed, "big.bin"), Buffer.alloc(2048));

    // sizeWarnGb tiny so the exp dir trips the size threshold too.
    await finalizeWith([TOPIC], deps(h, { sizeWarnGb: 0.000001 }));

    const w = readFileSync(join(art, "warnings.txt"), "utf8");
    expect(w).toContain("audit_warn\thotel/exp-001\tmax_params\tprompt=100000  actual=120000");
    expect(w).toMatch(/^size_warn\thotel\/exp-001\t/m);
    // ordering: size row is written first (truncate), audit row appended after.
    expect(w.indexOf("size_warn")).toBeLessThan(w.indexOf("audit_warn"));
  });

  it("folds an improve-multi lineage row into warnings.txt (B2)", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["golf"]);
    scaffoldPart(h, art, "golf", "phase=idle\n", "");
    writeFileSync(join(art, "lineage.tsv"),
      "exp_id\tagent\tparent_id\tknobs_changed\tverdict\tts\n" +
      "exp-003\tgolf\texp-002\t2\timprove-multi\tT\n");
    const rc = await finalizeWith([TOPIC], deps(h));
    expect(rc).toBe(0);
    const w = readFileSync(join(art, "warnings.txt"), "utf8");
    expect(w).toContain("lineage");
    expect(w).toContain("improve-multi");
    expect(w).toContain("golf/exp-003");
    // ...and it must reach the rendered ## Warnings section of session-summary.md (not just warnings.txt).
    const ss = readFileSync(join(art, "session-summary.md"), "utf8");
    expect(ss).toContain("## Warnings");
    expect(ss).toContain("lineage: golf/exp-003 improve-multi");
  });

  it("folds a not-reproduced inspection into warnings.txt AND ## Warnings (C1)", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["golf"]);
    scaffoldPart(h, art, "golf", "phase=idle\n", "");
    writeFileSync(join(art, "inspection.tsv"),
      "exp_id\tagent\tverdict\treason\treimpl_metric\tts\n" +
      "exp-003\tgolf\tnot-reproduced\tvalue:0.5vs0.9\t0.5\tT\n");
    expect(await finalizeWith([TOPIC], deps(h))).toBe(0);
    const w = readFileSync(join(art, "warnings.txt"), "utf8");
    expect(w).toContain("reimpl");
    expect(w).toContain("not-reproduced");
    const ss = readFileSync(join(art, "session-summary.md"), "utf8");
    expect(ss).toContain("## Warnings");
    expect(ss).toContain("reimpl: golf/exp-003 not-reproduced");
  });

  it("failed worker is preserved (not coerced) when no terminal event reconciles it", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["quebec"]);
    scaffoldPart(h, art, "quebec", "phase=failed\n", "");
    const rc = await finalizeWith([TOPIC], deps(h));
    expect(rc).toBe(0);
    const st = readFileSync(join(workerStateDir(art, "quebec"), "state.txt"), "utf8");
    expect(st).toContain("phase=failed");
  });

  it("usage error (no positional) -> rc 2", async () => {
    const h = home();
    const rc = await finalizeWith([], deps(h));
    expect(rc).toBe(2);
  });

  // ---- M2: cross-run memory WRITE at finalize (best-effort tail step) ----

  /** Fresh temp store root (own dir, cleaned up). */
  function tempStore(): string {
    const d = mkdtempSync(join(tmpdir(), "ap-memstore-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  }

  it("WRITE: two ok+verified experiments of one approach corroborate into a retrievable lesson", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["india"]);
    scaffoldPart(h, art, "india", "phase=idle\n", "");
    // metric.md -> family `accuracy`, direction maximize.
    writeFileSync(join(art, "metric.md"),
      "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n");
    // Two ok experiments of the SAME approach (so they share a fingerprint and merge).
    for (const exp of ["exp-001", "exp-002"]) {
      writeResult(art, "india", exp, {
        branch_id: exp, approach_label: "resnet50", metric_name: "accuracy", metric_value: 0.91,
        status: "ok", runtime_s: 1, log_paths: [], checkpoint_path: null, notes: "",
      });
    }
    // Both verified in A1 verification.tsv.
    writeFileSync(join(art, "verification.tsv"),
      "exp_id\tagent\tverdict\tts\n" +
      "exp-001\tindia\tverified\tT\n" +
      "exp-002\tindia\tverified\tT\n");

    const storeRoot = tempStore();
    const rc = await finalizeWith([TOPIC], deps(h, {
      memoryStoreRoot: storeRoot,
      // real liveMemoryIo (node fs) against the temp store
    }));
    expect(rc).toBe(0);

    // The per-family lessons.jsonl exists.
    const rh = repoHashOf(process.cwd());
    const lessonsFile = join(storeRoot, "v1", rh, "accuracy", "lessons.jsonl");
    expect(existsSync(lessonsFile)).toBe(true);

    // Corroboration (2 distinct runs >= minCorroboration) -> retrievable.
    const thresholds = parseMetricMd(readFileSync(join(art, "metric.md"), "utf8"));
    const rendered = retrieveForDispatch(liveMemoryIo, {
      storeRoot, repoHash: rh, metricFamily: "accuracy",
      objective: "resnet50 accuracy", direction: "maximize",
      policy: policyFromMetric(thresholds), now: "2026-05-30T12:00:00Z",
    });
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.join("\n")).toContain("resnet50");
  });

  it("NON-REGRESSION: a throwing memoryIo cannot change finalize rc or its artifacts", async () => {
    const h = home();
    const { art } = scaffoldArt(h, ["juliet"]);
    scaffoldPart(h, art, "juliet", "phase=idle\n", "");
    writeFileSync(join(art, "metric.md"),
      "# Research goal\n\n**Primary metric:** accuracy\n**Direction:** maximize\n");
    writeResult(art, "juliet", "exp-001", {
      branch_id: "exp-001", approach_label: "a", metric_name: "accuracy", metric_value: 0.9,
      status: "ok", runtime_s: 1, log_paths: [], checkpoint_path: null, notes: "",
    });
    writeFileSync(join(art, "verification.tsv"),
      "exp_id\tagent\tverdict\tts\nexp-001\tjuliet\tverified\tT\n");

    const throwing: MemoryIo = {
      exists() { throw new Error("boom-exists"); },
      readFile() { throw new Error("boom-read"); },
      mkdir() { throw new Error("boom-mkdir"); },
      writeAtomic() { throw new Error("boom-write"); },
    };
    const storeRoot = tempStore();
    const rc = await finalizeWith([TOPIC], deps(h, { memoryIo: throwing, memoryStoreRoot: storeRoot }));
    // finalize returns its normal rc despite the lesson-write throwing.
    expect(rc).toBe(0);
    // ...and still produced its normal artifacts.
    expect(existsSync(join(art, "session-summary.md"))).toBe(true);
    const st = readFileSync(join(workerStateDir(art, "juliet"), "state.txt"), "utf8");
    expect(st).toContain("phase=complete");
  });
});
