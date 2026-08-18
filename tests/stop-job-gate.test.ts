// tests/stop-job-gate.test.ts — the PUBLIC forms of `stop` while a detached job is in flight.
// A job hub is mechanically an ordinary worker whose state dir sits under the topic it supervises,
// so a whole-topic teardown archives the CONTROLLER's outbox before its `done` reaches the origin's
// `job wait`, which then reports a synthetic pane death. The topic form must refuse; the per-agent
// forms (the sanctioned detached teardown) must not.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { formatJob, jobPath } from "../src/core/job.js";
import { topicDir, workerDir } from "../src/core/paths.js";
import { run as stopRun } from "../src/commands/stop.js";
import { run as jobRun } from "../src/commands/job.js";

const TOPIC = "job-attach-parked";
const PLAIN = "plain-topic";
const AGENT = "alpha";
const MODEL = "claude";

async function capture(fn: () => Promise<number>): Promise<{ rc: number; err: string }> {
  const err: string[] = [];
  const se = process.stderr.write.bind(process.stderr);
  const so = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { const rc = await fn(); return { rc, err: err.join("") }; }
  finally { process.stderr.write = se; process.stdout.write = so; }
}

function seedWorker(topic: string, agent = AGENT, model = MODEL): string {
  const wd = workerDir(agent, model, topic);
  mkdirSync(wd, { recursive: true });
  writeFileSync(join(wd, "outbox.jsonl"), '{"event":"progress","note":"round 1","ts":"2026-08-18T00:00:00Z"}\n');
  // A pane id no server hands out, paired with a nonce nothing live can carry: the ownership check
  // can then only ever answer "not ours", so no kill path is reachable even if tmux were consulted.
  writeFileSync(join(wd, "pane.json"), JSON.stringify({
    pane_id: "%999999", pane_nonce: "00000000-0000-4000-8000-0000deadbeef", agent, model,
  }) + "\n");
  return wd;
}

function seedJob(topic: string): void {
  const p = jobPath(topic);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, formatJob({
    command: "implement", topic, session: `ap-${topic}`,
    hub: { agent: AGENT, model: MODEL },
    provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
    args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
  }));
}

describe("stop — a detached job in flight gates the whole-topic forms", () => {
  let h: { home: string; cleanup: () => void };
  let path0: string | undefined;
  beforeEach(() => {
    h = freshHome();
    // No tmux, ever: `livePaneNonces` shells out, and a test must neither consult nor depend on a
    // live server. An unresolvable binary is the same answer a tmux-less CI box gives — the empty
    // snapshot, i.e. "ap can prove it owns nothing".
    path0 = process.env.PATH;
    process.env.PATH = join(h.home, "no-bin");
  });
  afterEach(() => { process.env.PATH = path0; h.cleanup(); });

  it("stop <topic> REFUSES (rc 1) and tears down NOTHING — worker, outbox and record all survive", async () => {
    const wd = seedWorker(TOPIC);
    seedJob(TOPIC);
    const { rc, err } = await capture(() => stopRun([TOPIC]));
    expect(rc).toBe(1);
    expect(existsSync(wd)).toBe(true);
    expect(existsSync(join(wd, "outbox.jsonl"))).toBe(true);
    expect(existsSync(jobPath(TOPIC))).toBe(true);
    // Both remedies are named: the whole job, and the one-worker form the detached directives use.
    expect(err).toContain(`ap job stop ${TOPIC}`);
    expect(err).toContain(`ap stop <agent> ${TOPIC}`);
  });

  it("stop --pairs <topic> <agent> still tears the worker down; the job record survives", async () => {
    const wd = seedWorker(TOPIC);
    seedJob(TOPIC);
    const { rc } = await capture(() => stopRun(["--pairs", TOPIC, AGENT]));
    expect(rc).toBe(0);
    expect(existsSync(wd)).toBe(false);              // archived out of the topic dir
    expect(existsSync(jobPath(TOPIC))).toBe(true);
  });

  it("stop <agent> <topic> still tears the worker down; the job record survives", async () => {
    const wd = seedWorker(TOPIC);
    seedJob(TOPIC);
    const { rc } = await capture(() => stopRun([AGENT, TOPIC]));
    expect(rc).toBe(0);
    expect(existsSync(wd)).toBe(false);
    expect(existsSync(jobPath(TOPIC))).toBe(true);
  });

  it("stop --all --yes sweeps the plain topic and LOUDLY skips the one with a job record", async () => {
    const jobWorker = seedWorker(TOPIC);
    seedJob(TOPIC);
    const plainWorker = seedWorker(PLAIN, "bravo", "codex");
    const { rc, err } = await capture(() => stopRun(["--all", "--yes"]));
    expect(rc).toBe(0);
    expect(existsSync(plainWorker)).toBe(false);
    expect(existsSync(jobWorker)).toBe(true);
    expect(existsSync(jobPath(TOPIC))).toBe(true);
    expect(err).toContain(`skipping ${TOPIC}`);
    expect(err).toContain(`ap job stop ${TOPIC}`);
  });

  it("job stop still owns the ungated path: the worker is archived and the record cleared", async () => {
    const wd = seedWorker(TOPIC);
    seedJob(TOPIC);
    const { rc } = await capture(() => jobRun(["stop", TOPIC]));
    expect(rc).toBe(0);
    expect(existsSync(wd)).toBe(false);
    expect(existsSync(jobPath(TOPIC))).toBe(false);
    expect(existsSync(topicDir(TOPIC))).toBe(false);
  });
});
