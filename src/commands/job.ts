// src/commands/job.ts — `ap job <sub>`: launch and observe a DETACHED run.
//
// The origin hub (the operator's own Claude Code session) uses these verbs and nothing else. It
// launches with `start`, watches with `status` / `wait`, answers a parked question with `relay`,
// recovers a view after its own restart with `attach`, and tears down with `stop`. It never talks
// to the job's WORKERS — only the job hub does, because a second sender mid-run overwrites a
// running worker's inbox task and the worker idles.

import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { kvParse } from "../args.js";
import { log } from "../core/log.js";
import { atomicWrite } from "../core/atomic.js";
import { readIfExists } from "../core/fsread.js";
import { jobDir, topicDir, repoStateDir, repoRoot, isArtifactDir } from "../core/paths.js";
import { isoUtc } from "../core/archive.js";
import { validateSlug } from "../core/slug.js";
import { envNum } from "../core/env.js";
import { pickRandomAgent } from "../core/agents.js";
import { deriveSlug } from "../core/quick.js";
import { livePaneNonces, ownsPane, sessionExists, sessionPaneIds, killSession, validSessionName } from "../core/tmux.js";
import { paneMetaRead, paneMetaReadForDir, outboxPath, outboxOffset, parseEvent, statusPath, type OutboxEvent } from "../core/ipc.js";
import { liveOutboxWait } from "../core/waitLive.js";
import { percentEncode } from "../core/questionCodec.js";
import * as J from "../core/job.js";
import { run as spawnRun } from "./spawn.js";
import { run as sendRun } from "./send.js";
import { run as stopRun } from "./stop.js";

function usage(): number {
  process.stderr.write(
    "Usage: job start --command <implement|quick> --args-file <path> [--topic slug] [--provider p]\n" +
    "                 [--finish keep] [--budget-hours N] [--max-rounds N] [--hub-model claude]\n" +
    "       job status <topic>          one-screen composite: what was launched, is it alive, where is it\n" +
    "       job wait <topic>            block until the job hub emits done/error/question\n" +
    "       job relay <topic> <msg|@file>   answer a parked question\n" +
    "       job attach <topic>          re-arm block, after the origin hub restarted\n" +
    "       job list                    every job in this repo\n" +
    "       job stop <topic>            tear down, sweep the session, clear the record\n" +
    "       job mode <topic>            DETACHED=1 (exit 0) / DETACHED=0 (exit 1)\n" +
    "       job budget-check <topic>    BUDGET=within (exit 0) / exceeded (exit 1)\n");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start":        return startRun(rest);
    case "status":       return statusRun(rest);
    case "wait":         return waitRun(rest);
    case "relay":        return relayRun(rest);
    case "attach":       return attachRun(rest);
    case "list":         return listRun();
    case "stop":         return stopJobRun(rest);
    case "mode":         return modeRun(rest);
    case "budget-check": return budgetCheckRun(rest);
    default:             return usage();
  }
}

// ---------- shared reads ----------

function readJob(topic: string): J.JobRecord | null {
  return J.parseJob(readIfExists(J.jobPath(topic)));
}
function requireJob(topic: string, verb: string): J.JobRecord | null {
  if (!topic || !validateSlug(topic)) { log.error(`job ${verb}: topic must match [a-z0-9-]+ and be <= 32 chars; got: '${topic}'`); return null; }
  const rec = readJob(topic);
  if (!rec) { log.error(`job ${verb}: no readable job for topic '${topic}' (looked at ${J.jobPath(topic)})`); return null; }
  return rec;
}
function readEvents(path: string): OutboxEvent[] {
  return readIfExists(path).split("\n").map(parseEvent).filter((e): e is OutboxEvent => e !== null);
}
function hubState(rec: J.JobRecord): string {
  const m = /"state"\s*:\s*"([^"]*)"/.exec(readIfExists(statusPath(rec.hub.agent, rec.hub.model, rec.topic)));
  return m ? m[1] : "unknown";
}
/** Every pane under this topic that ap can PROVE is its own, right now. Collected before teardown,
 *  because teardown archives the pane.json files this reads. */
async function ownedPanes(topic: string): Promise<Set<string>> {
  const td = topicDir(topic);
  const out = new Set<string>();
  if (!existsSync(td)) return out;
  const live = await livePaneNonces();
  for (const e of readdirSync(td, { withFileTypes: true })) {
    if (!e.isDirectory() || isArtifactDir(e.name)) continue;
    const m = paneMetaReadForDir(join(td, e.name));
    if (m.paneId && ownsPane(live, m.paneId, m.nonce)) out.add(m.paneId);
  }
  return out;
}
/** Worker-authored text is percent-encoded before it reaches stdout. The hub's outbox is written by
 *  a model; a newline in a `message` would otherwise forge extra KV lines in this very report, which
 *  is the same trick a forged @ap_nonce plays on the pane snapshot. */
const enc = (s: unknown): string => percentEncode(typeof s === "string" ? s : "");

// ---------- start ----------

async function startRun(rest: string[]): Promise<number> {
  let command = "", argsFile = "", topic = "", provider = "", finish = "keep", hubModel = "claude";
  let budgetHours = 6, maxRounds = 5;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const take = (): string => { const r = kvParse(a, rest[i + 1]); i += r.shift - 1; return r.value; };
    if (a === "--command" || a.startsWith("--command=")) command = take();
    else if (a === "--args-file" || a.startsWith("--args-file=")) argsFile = take();
    else if (a === "--topic" || a.startsWith("--topic=")) topic = take();
    else if (a === "--provider" || a.startsWith("--provider=")) provider = take();
    else if (a === "--finish" || a.startsWith("--finish=")) finish = take();
    else if (a === "--hub-model" || a.startsWith("--hub-model=")) hubModel = take();
    else if (a === "--budget-hours" || a.startsWith("--budget-hours=")) budgetHours = Number(take());
    else if (a === "--max-rounds" || a.startsWith("--max-rounds=")) maxRounds = Number(take());
    else { log.error(`job start: unknown argument '${a}'`); return 2; }
  }

  if (!J.isJobCommand(command)) { log.error(`job start: --command must be one of ${J.JOB_COMMANDS.join("|")}; got: '${command}'`); return 2; }
  if (!argsFile || !existsSync(argsFile)) { log.error(`job start: --args-file must be an existing path; got: '${argsFile}'`); return 2; }
  if (!J.finishAllowedDetached(finish)) {
    log.error(`job start: --finish ${finish} is refused for a detached run. Nothing merges, pushes, or opens a PR while no one is watching: the run ends on its branch and you decide from there. Use --finish keep.`);
    return 2;
  }
  if (!Number.isFinite(budgetHours) || budgetHours <= 0) { log.error(`job start: --budget-hours must be a positive number; got: '${budgetHours}'`); return 2; }
  if (!Number.isInteger(maxRounds) || maxRounds <= 0) { log.error(`job start: --max-rounds must be a positive integer; got: '${maxRounds}'`); return 2; }

  const argsText = readIfExists(argsFile).trim();
  if (!topic) {
    topic = command === "implement"
      ? J.topicFromImplementArgs(argsText)
      : deriveSlug(J.stripFlags(argsText, new Set(["--provider"])));
  }
  if (!topic || !validateSlug(topic)) {
    log.error(`job start: could not derive a valid topic from ${argsFile} (got: '${topic}'); pass --topic <slug>`);
    return 2;
  }
  const session = `ap-${topic}`;
  if (!validSessionName(session)) { log.error(`job start: '${session}' is not a usable tmux session name; pick a shorter --topic`); return 2; }
  if (existsSync(J.jobPath(topic))) {
    log.error(`job start: topic '${topic}' already has a job in flight (${J.jobPath(topic)}); run 'ap job stop ${topic}' first`);
    return 2;
  }
  const agent = pickRandomAgent(topic);
  if (!agent) { log.error(`job start: no free agent in the pool for topic '${topic}'`); return 1; }

  const rec: J.JobRecord = {
    command, topic, session,
    hub: { agent, model: hubModel },
    provider, finish, budget_hours: budgetHours, max_rounds: maxRounds,
    args_file: argsFile, started: isoUtc(),
  };
  mkdirSync(jobDir(topic), { recursive: true });
  // The record is written BEFORE the spawn on purpose: a spawn that dies half-way leaves evidence
  // the operator (and `job stop`) can act on, rather than an unrecorded pane in a session nobody
  // knows the name of.
  atomicWrite(J.jobPath(topic), J.formatJob(rec));

  const rc = await spawnRun([agent, hubModel, topic, "--session", session, "--role", "job-hub", "--cwd", repoRoot(), J.jobBrief(rec)]);
  if (rc !== 0) {
    log.error(`job start: the job hub failed to spawn (rc ${rc}); the record is left at ${J.jobPath(topic)} — clear it with 'ap job stop ${topic}'`);
    return rc;
  }
  process.stdout.write(`TOPIC=${topic}\nSESSION=${session}\nHUB=${agent}-${hubModel}\nJOB=${J.jobPath(topic)}\nATTACH=tmux attach -t ${session}\n`);
  return 0;
}

// ---------- status ----------

async function statusRun(rest: string[]): Promise<number> {
  const rec = requireJob(rest[0], "status");
  if (!rec) return 1;
  const live = await livePaneNonces();
  const liveness = J.classifyJobLiveness(live, paneMetaRead(rec.hub.agent, rec.hub.model, rec.topic));
  const events = readEvents(outboxPath(rec.hub.agent, rec.hub.model, rec.topic));
  const { last, parked } = J.jobProgress(events);
  const now = Date.now();
  const el = J.elapsedHours(rec.started, now);

  process.stdout.write(
    `COMMAND=${rec.command}\nTOPIC=${rec.topic}\nSESSION=${rec.session}\n` +
    `HUB=${rec.hub.agent}-${rec.hub.model}\nLIVENESS=${liveness}\nHUB_STATE=${hubState(rec)}\n` +
    `STARTED=${rec.started}\nELAPSED_H=${el === null ? "?" : el.toFixed(2)}\nBUDGET_H=${rec.budget_hours}\n` +
    `BUDGET=${J.budgetExceeded(rec.started, rec.budget_hours, now) ? "exceeded" : "within"}\n` +
    `FINISH=${rec.finish}\nEVENTS=${events.length}\nLAST_EVENT=${last ? last.event : "none"}\n` +
    `PARKED=${parked ? "yes" : "no"}\n`);
  if (parked) process.stdout.write(`PARKED_MESSAGE=${enc(parked.message ?? parked.note ?? "")}\n`);
  if (liveness === "dead") {
    process.stdout.write(`NOTE=${enc(`the job hub's pane is gone. Its workers, if any, are now unsupervised: 'ap list ${rec.topic}' shows them, 'ap job stop ${rec.topic}' tears the whole job down. Nothing is auto-respawned — a second hub waking onto a live worker corrupts the run.`)}\n`);
  }
  const tail = events.slice(-10);
  if (tail.length) {
    process.stdout.write("--- recent events ---\n");
    for (const e of tail) process.stdout.write(`${e.ts ?? "?"}\t${e.event}\t${enc(e.summary ?? e.note ?? e.message ?? "")}\n`);
  }
  return 0;
}

// ---------- wait / relay / attach ----------

async function waitRun(rest: string[]): Promise<number> {
  const rec = requireJob(rest[0], "wait");
  if (!rec) return 1;
  const cursor = Number(readIfExists(J.jobCursorPath(rec.topic)).trim()) || 0;
  const budget = envNum("AP_JOB_WAIT_TIMEOUT_S", 3600);
  const ev = await liveOutboxWait(rec.hub.agent, rec.hub.model, rec.topic, cursor, ["done", "error", "question"], budget);
  if (!ev) { process.stdout.write("JS=timeout\n"); return 1; }
  process.stdout.write(`JS=${ev.event}\n`);
  if (ev.event === "question") process.stdout.write(`QUESTION=${enc(ev.message ?? "")}\n`);
  return 0;
}

async function relayRun(rest: string[]): Promise<number> {
  const rec = requireJob(rest[0], "relay");
  if (!rec) return 1;
  const msg = rest.slice(1).join(" ").trim();
  if (!msg) { log.error("job relay: a message (or @file) is required"); return 2; }
  const rc = await sendRun(["--from", "hub", rec.hub.agent, rec.topic, msg]);
  if (rc !== 0) return rc;
  // Consume everything up to now, so the next `job wait` does not re-report the question just
  // answered. Taken AFTER the send: the offset is a high-water mark, not a claim about ordering.
  atomicWrite(J.jobCursorPath(rec.topic), String(outboxOffset(outboxPath(rec.hub.agent, rec.hub.model, rec.topic))) + "\n");
  log.ok(`job relay: answer delivered to ${rec.hub.agent} on ${rec.topic}`);
  return 0;
}

function attachRun(rest: string[]): number {
  const rec = requireJob(rest[0], "attach");
  if (!rec) return 1;
  process.stdout.write(
    `TOPIC=${rec.topic}\nSESSION=${rec.session}\nHUB=${rec.hub.agent}-${rec.hub.model}\n` +
    `WATCH=tmux attach -t ${rec.session}\nSTATUS=ap job status ${rec.topic}\nWAIT=ap job wait ${rec.topic}\n` +
    `OUTBOX=${outboxPath(rec.hub.agent, rec.hub.model, rec.topic)}\n`);
  return 0;
}

// ---------- list ----------

function listRun(): number {
  const repo = repoStateDir();
  const W = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(`${W("TOPIC", 24)} ${W("COMMAND", 10)} ${W("HUB", 20)} ${W("SESSION", 24)} STARTED\n`);
  process.stdout.write(`${"-".repeat(24)} ${"-".repeat(10)} ${"-".repeat(20)} ${"-".repeat(24)} -------\n`);
  if (!existsSync(repo)) return 0;
  for (const t of readdirSync(repo, { withFileTypes: true })) {
    if (!t.isDirectory()) continue;
    const rec = readJob(t.name);
    if (!rec) continue;
    process.stdout.write(`${W(rec.topic, 24)} ${W(rec.command, 10)} ${W(`${rec.hub.agent}-${rec.hub.model}`, 20)} ${W(rec.session, 24)} ${rec.started}\n`);
  }
  return 0;
}

// ---------- stop ----------

async function stopJobRun(rest: string[]): Promise<number> {
  const rec = requireJob(rest[0], "stop");
  if (!rec) return 1;
  // Snapshot ownership BEFORE teardown: teardown archives the pane.json files this evidence lives in.
  const owned = await ownedPanes(rec.topic);
  const rc = await stopRun([rec.topic]);
  if (await sessionExists(rec.session)) {
    const panes = await sessionPaneIds(rec.session);
    if (J.sessionKillable(panes, owned)) { await killSession(rec.session); log.ok(`job stop: killed detached session ${rec.session}`); }
    else {
      const strangers = panes.filter((p) => !owned.has(p));
      log.warn(`job stop: session ${rec.session} left intact — ${strangers.length ? `it still holds ${strangers.join(", ")}, which ap cannot prove are its own` : "ap could not enumerate its panes"}. Inspect with: tmux list-panes -s -t =${rec.session}`);
    }
  }
  rmSync(jobDir(rec.topic), { recursive: true, force: true });
  try { rmdirSync(topicDir(rec.topic)); } catch { /* tolerate non-empty */ }
  log.ok(`job stop: ${rec.topic} torn down`);
  return rc;
}

// ---------- mechanical signals the directive branches on ----------

function modeRun(rest: string[]): number {
  const topic = rest[0];
  if (!topic || !validateSlug(topic)) { log.error("usage: job mode <topic>"); return 2; }
  const on = existsSync(J.jobPath(topic));
  process.stdout.write(`DETACHED=${on ? 1 : 0}\n`);
  return on ? 0 : 1;
}

function budgetCheckRun(rest: string[]): number {
  const rec = requireJob(rest[0], "budget-check");
  if (!rec) return 2;
  const now = Date.now();
  const el = J.elapsedHours(rec.started, now);
  const exceeded = J.budgetExceeded(rec.started, rec.budget_hours, now);
  process.stdout.write(`BUDGET=${exceeded ? "exceeded" : "within"}\nELAPSED_H=${el === null ? "?" : el.toFixed(2)}\nBUDGET_H=${rec.budget_hours}\n`);
  return exceeded ? 1 : 0;
}
