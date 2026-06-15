// src/commands/quick.ts
import { mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc } from "../core/archive.js";
import { repoRoot } from "../core/paths.js";
import { quickArtDir, quickExecDir, deriveSlug, parseQuickArgs, detectTestCommand, renderSummary, renderResume, type SummaryFacts } from "../core/quick.js";
import { runForensics, runFlag } from "../core/forensics.js";
import { agentBinary } from "../core/contracts.js";
import { haveCmd } from "../core/deps.js";
import { pickRandomAgent } from "../core/agents.js";
import { runnerAt, preSnapshot, createOrResumeBranch, finishBranch } from "../core/gitwork.js";
import type { Runner } from "../core/gitwork.js";
import { outboxOffset, outboxPath, outboxWaitSince, statusPath, type OutboxEvent } from "../core/ipc.js";
import { composeRound1Prompt, composeFixPrompt, classifyTurn } from "../core/turn.js";
import { parseLatestOffset } from "../core/designTurn.js";
import { run as sendRun } from "./send.js";
import { readIfExists } from "../core/fsread.js";

function usage(): number {
  log.error("usage: quick <init|branch|turn-send|turn-wait|detect-test|finish|forensics|summary> ...");
  return 2;
}

export interface InitDeps {
  haveCmd(name: string): boolean;
  agentBinary(name: string): string | undefined;
  pickRandomAgent(topic: string): string | null;
}
const liveInitDeps: InitDeps = { haveCmd, agentBinary, pickRandomAgent };

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest, { valueFlags: new Set(["--provider"]) }));
    case "branch": return branchRun(rest);
    case "turn-send": return turnSendRun(rest);
    case "turn-wait": return turnWaitRun(rest);
    case "detect-test": return detectTestRun(rest);
    case "finish": return finishRun(rest);
    case "forensics": return forensicsRun(rest);
    case "flag": return runFlag("quick", rest[0], rest.slice(1).join(" "));
    case "summary": return summaryRun(rest);
    default: return usage();
  }
}

// ---- forensics (delegates to core runForensics). Feeds /ap:review. ----
export async function forensicsRun(rest: string[]): Promise<number> {
  return runForensics("quick", quickArtDir, rest[0]);
}

async function initRun(tokens: string[]): Promise<number> {
  return initWith(tokens, liveInitDeps);
}

export async function initWith(tokens: string[], d: InitDeps): Promise<number> {
  const { topicText, provider: provArg, finish } = parseQuickArgs(tokens);
  if (!topicText) { log.error("quick init: topic text is empty"); return 1; }
  const slug = deriveSlug(topicText);
  if (!slug) { log.error("quick init: topic produced an empty slug; provide alphanumerics"); return 1; }

  const provider = provArg ?? "codex";
  const binary = d.agentBinary(provider);
  if (!binary) { log.error(`quick init: provider '${provider}' has no entry in contracts.yaml`); return 3; }
  if (!d.haveCmd(binary)) { log.error(`quick init: ${provider}'s binary '${binary}' is not on PATH`); return 3; }

  const art = quickArtDir(slug);
  if (existsSync(art)) { log.error(`quick init: topic already in flight: ${art}`); log.error("  run /ap:stop or pick a different topic"); return 2; }

  const agent = d.pickRandomAgent(slug);
  if (!agent) { log.error(`quick init: no available agent in the pool for '${slug}'`); return 1; }

  const exec = quickExecDir(slug);
  mkdirSync(exec, { recursive: true });
  atomicWrite(join(art, "topic.txt"), slug + "\n");
  atomicWrite(join(art, "topic-text.txt"), topicText);
  atomicWrite(join(art, "selected-provider.txt"), provider + "\n");
  atomicWrite(join(art, "agent.txt"), agent + "\n");
  atomicWrite(join(art, "timing.txt"), `started=${isoUtc()}\n`);
  atomicWrite(join(exec, "provider.txt"), provider + "\n");
  atomicWrite(join(exec, "finish.txt"), (finish ? "yes" : "no") + "\n");

  const target = repoRoot();
  log.ok(`quick init: topic=${slug} agent=${agent} provider=${provider} finish=${finish ? "yes" : "no"}`);
  process.stdout.write(`SLUG=${slug}\nAGENT=${agent}\nPROVIDER=${provider}\nFINISH=${finish ? "yes" : "no"}\nTARGET=${target}\n`);
  return 0;
}
async function branchRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: quick branch <topic>"); return 2; }
  const target = repoRoot();
  return branchWith(topic, target, runnerAt(target));
}

/** Testable core: snapshot + branch the target repo, recording execute/ facts. */
export async function branchWith(topic: string, target: string, r: Runner): Promise<number> {
  const snap = preSnapshot(r, "quick", topic);
  if (snap.state === "not-git") { log.error(`quick branch: ${target} is not a git repository`); return 1; }
  const branch = `feat/quick-${topic}`;
  const onBranch = createOrResumeBranch(r, branch);
  const exec = quickExecDir(topic);
  atomicWrite(join(exec, "target_cwd.txt"), target + "\n");
  atomicWrite(join(exec, "start-branch.txt"), snap.branch + "\n");
  atomicWrite(join(exec, "branch-base.sha"), snap.baseSha + "\n");
  atomicWrite(join(exec, "branch.txt"), branch + "\n");
  if (!onBranch) { log.warn(`quick branch: checkout ${branch} failed; staying on ${snap.branch}`); }
  log.ok(`quick branch: ${branch} (snapshot=${snap.state}, base=${snap.baseSha.slice(0, 8)})`);
  return 0;
}
export interface TurnSendDeps {
  offsetFor(agent: string, model: string, topic: string): number;
  send(args: string[]): Promise<number>;
}

async function turnSendRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  const round = Number(roundStr);
  if (!topic || !Number.isInteger(round) || round < 1) { log.error("usage: quick turn-send <topic> <round>=1.."); return 2; }
  return turnSendWith(topic, round, {
    offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)),
    send: (args) => sendRun(args),
  });
}

export async function turnSendWith(topic: string, round: number, d: TurnSendDeps): Promise<number> {
  const art = quickArtDir(topic);
  const exec = quickExecDir(topic);
  const agent = readField(join(art, "agent.txt"));
  const provider = readField(join(art, "selected-provider.txt"));
  if (!agent || !provider) { log.error("quick turn-send: missing agent.txt/selected-provider.txt (run quick init)"); return 1; }

  const outbox = outboxPath(agent, provider, topic);
  if (!existsSync(outbox)) { log.error(`quick turn-send: outbox not found at ${outbox} — was ${agent} spawned?`); return 1; }
  const sp = statusPath(agent, provider, topic);
  if (existsSync(sp)) { const m = readFileSync(sp, "utf8").match(/"state":"([^"]*)"/); if (m && m[1] && m[1] !== "idle") { log.error(`quick turn-send: worker not idle (state=${m[1]}); previous turn still in flight`); return 1; } }

  const stateFile = join(exec, `turn-${round}.txt`);
  if (existsSync(stateFile)) { log.error(`quick turn-send: ${stateFile} already exists; rm to retry`); return 1; }

  let prompt: string;
  if (round === 1) {
    const brief = readIfExists(join(art, "task-brief.md"));
    const branch = readField(join(exec, "branch.txt")) || `feat/quick-${topic}`;
    prompt = composeRound1Prompt(brief, branch);
  } else {
    const bundle = join(exec, `fix-prompt-${round}.md`);
    if (!existsSync(bundle)) { log.error(`quick turn-send: fix bundle missing: ${bundle} (the directive must write it first)`); return 1; }
    prompt = composeFixPrompt(readFileSync(bundle, "utf8"), round);
  }

  const promptFile = join(exec, `turn-prompt-${round}.md`);
  atomicWrite(promptFile, prompt);
  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);

  const rc = await d.send([agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`quick turn-send: send failed (rc=${rc}); ${stateFile} kept for retry`); return 1; }
  log.ok(`quick turn-send: round=${round} offset=${offset}`);
  return 0;
}

/** Read the first line of a single-value state file, trimmed; "" if absent. */
function readField(path: string): string {
  return readIfExists(path).split("\n")[0].trim();
}
export interface TurnWaitDeps {
  wait(agent: string, model: string, topic: string, offset: number, events: string[], timeoutSec: number): Promise<OutboxEvent | null>;
}

const QUICK_TURN_TIMEOUT = Number(process.env.AP_QUICK_TURN_TIMEOUT) || 14400;

async function turnWaitRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  const round = Number(roundStr);
  if (!topic || !Number.isInteger(round) || round < 1) { log.error("usage: quick turn-wait <topic> <round>=1.."); return 2; }
  return turnWaitWith(topic, round, {
    wait: (i, m, t, off, ev, to) => outboxWaitSince(i, m, t, off, ev, to),
  });
}

export async function turnWaitWith(topic: string, round: number, d: TurnWaitDeps): Promise<number> {
  const art = quickArtDir(topic);
  const exec = quickExecDir(topic);
  const agent = readField(join(art, "agent.txt"));
  const provider = readField(join(art, "selected-provider.txt"));
  if (!agent || !provider) { log.error("quick turn-wait: missing agent.txt/selected-provider.txt"); return 1; }
  const stateFile = join(exec, `turn-${round}.txt`);
  if (!existsSync(stateFile)) { log.error(`quick turn-wait: ${stateFile} missing (run quick turn-send first)`); return 1; }
  const offset = parseLatestOffset(readFileSync(stateFile, "utf8"));
  if (offset === null) { log.error(`quick turn-wait: OFFSET not set in ${stateFile}`); return 1; }

  log.info(`quick turn-wait: round=${round} offset=${offset} timeout=${QUICK_TURN_TIMEOUT}s`);
  const ev = await d.wait(agent, provider, topic, offset, ["done", "error", "question"], QUICK_TURN_TIMEOUT);
  const ts = classifyTurn(ev);
  if (ts === "question" && ev) {
    atomicWrite(join(exec, `question-${round}.txt`), JSON.stringify(ev) + "\n");
    // Advance the offset past the handled question so a same-round re-arm does not re-read it
    // (mirrors implement turnWaitWith; quick has no objection routing, so no OBJECTIONS= line).
    const bumped = outboxOffset(outboxPath(agent, provider, topic));
    appendFileSync(stateFile, `OFFSET=${bumped}\nTS=question\n`);
  } else {
    appendFileSync(stateFile, `TS=${ts}\n`);
  }
  log.ok(`quick turn-wait: round=${round} TS=${ts}`);
  return 0;
}
async function detectTestRun(rest: string[]): Promise<number> {
  const cwd = rest[0] || repoRoot();
  process.stdout.write(detectTestCommand(cwd) + "\n");
  return 0;
}
async function finishRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: quick finish <topic>"); return 2; }
  const target = readField(join(quickExecDir(topic), "target_cwd.txt")) || repoRoot();
  return finishWith(topic, runnerAt(target), haveCmd("gh"));
}

export async function finishWith(topic: string, r: Runner, hasGh: boolean): Promise<number> {
  const exec = quickExecDir(topic);
  const branch = readField(join(exec, "branch.txt"));
  const startBranch = readField(join(exec, "start-branch.txt")) || "main";
  const doFinish = readField(join(exec, "finish.txt")) === "yes";

  if (!doFinish) {
    r.run("git", ["checkout", "-q", startBranch]);
    atomicWrite(join(exec, "finish-result.txt"), `none\tbranch-only (kept ${branch})\n`);
    log.ok(`quick finish: branch-only — kept ${branch}, restored ${startBranch}`);
    return 0;
  }
  const brief = readIfExists(join(quickArtDir(topic), "task-brief.md"));
  const verify = readField(join(exec, "verify-result.txt"));
  const res = finishBranch(r, {
    branch, startBranch, hasGh,
    title: `quick: ${branch}`,
    body: `${brief}\n\nVerify: ${verify}\n\n(Automated quick branch — review and merge into ${startBranch}.)`,
  });
  atomicWrite(join(exec, "finish-result.txt"), `${res.action}\t${res.outcome}\n`);
  log.ok(`quick finish: ${res.action} → ${res.outcome}`);
  return 0;
}
async function summaryRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: quick summary <topic> [--aborted <phase> <gate> <reason...>]"); return 2; }
  const art = quickArtDir(topic);
  const exec = quickExecDir(topic);

  const started = kvField(join(art, "timing.txt"), "started") || "unknown";
  let ended: string | undefined;
  let duration: number | undefined;

  const i = rest.indexOf("--aborted");
  const aborted = i >= 0;
  if (!aborted) {
    ended = isoUtc();
    const s = Date.parse(started), e = Date.parse(ended);
    duration = Number.isFinite(s) && Number.isFinite(e) ? Math.round((e - s) / 1000) : 0;
    atomicWrite(join(art, "timing.txt"), `started=${started}\nended=${ended}\nduration=${duration}\n`);
  }

  const facts: SummaryFacts = {
    topic,
    status: aborted ? "aborted" : "ok",
    started, ended, duration,
    provider: readField(join(art, "selected-provider.txt")) || "unknown",
    agent: readField(join(art, "agent.txt")) || "unknown",
    branch: readField(join(exec, "branch.txt")) || "unknown",
    verify: readField(join(exec, "verify-result.txt")) || "unknown",
    diffStats: readField(join(exec, "diff-stats.txt")) || "unknown",
    archived: readField(join(art, "archived-path.txt")) || "(not archived)",
    targetCwd: readField(join(exec, "target_cwd.txt")) || "<target>",
    branchBase: readField(join(exec, "branch-base.sha")) || "<base>",
    abortedPhase: aborted ? rest[i + 1] : undefined,
    abortedGate: aborted ? rest[i + 2] : undefined,
    abortedReason: aborted ? rest.slice(i + 3).join(" ") || "unknown" : undefined,
  };

  atomicWrite(join(art, "SUMMARY.md"), renderSummary(facts));
  if (aborted) {
    atomicWrite(join(art, "RESUME.md"), renderResume({
      topic, branch: facts.branch, artDir: art, phase: facts.abortedPhase ?? "unknown", gate: facts.abortedGate ?? "unknown",
    }));
  }
  log.ok(`quick summary: wrote ${join(art, "SUMMARY.md")}`);
  return 0;
}

/** Read a `key=value` line from a KV file; "" if absent. */
function kvField(path: string, key: string): string {
  if (!existsSync(path)) return "";
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = readFileSync(path, "utf8").match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}
