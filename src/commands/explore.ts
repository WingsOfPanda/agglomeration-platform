// src/commands/explore.ts — /ap:explore CLI verbs (port of meditate). Built on design's DI
// pattern + IPC/wait/archive helpers; meditate-specific logic lives in src/core/explore*.ts.
// NOTE: verbs are added task-by-task; the dispatcher's switch grows as each verb lands.
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc, archiveTopic } from "../core/archive.js";
import { exploreArtDir, deriveSlug } from "../core/explore.js";
import { extractHandoffData } from "../core/exploreHandoff.js";
import { runForensics, runFlag } from "../core/forensics.js";
import { killNow } from "../core/tmux.js";
import {
  type ListRow, formatListFile, parseListFile, parsePanesFile, spawnAllBatch, lastTag, verifyScopeFiles,
} from "../core/design.js";
import { readProviderList } from "../core/providers.js";
import { activeProvidersPath, repoRoot } from "../core/paths.js";
import { pickAgents } from "../core/agents.js";
import { agentConsultValidated, consultTimeout, agentTimeoutMultiplier } from "../core/contracts.js";
import { classifyTopic } from "../core/exploreLit.js";
import { computeSignals, renderSkipRecord, type Decision } from "../core/exploreConfidence.js";
import { buildAnnotations } from "../core/exploreAnnotate.js";
import { outboxOffset, outboxPath, TERMINAL_EVENTS, type OutboxEvent } from "../core/ipc.js";
import { liveOutboxWait } from "../core/waitLive.js";
import { parseLatestOffset, scaledTimeout, researchState, verifyState, gateState, recordWaitOutcome, composeVerifyPrompt } from "../core/designTurn.js";
import { composeExploreResearchPrompt, composeAdversaryPrompt, composeGapPrompt, composeSignoffPrompt, litGuidance, ADVERSARY_LENSES, researchLens } from "../core/exploreTurn.js";
import { run as sendRun } from "./send.js";
import { run as spawnRun } from "./spawn.js";
import { run as preflightRun } from "./preflight.js";
import { readIfExists as readIf, readIfExistsOrNull } from "../core/fsread.js";
import { parseOpenQuestions, assignOpenQuestions, formatOpenqClaims, parseOpenqClaims, composeOpenqPrompt } from "../core/exploreOpenq.js";
import { parseAdversaryVerdict, tallyVerdicts } from "../core/exploreVerdict.js";
import { diffFindings, type DiffPart, type Claim } from "../core/designDiff.js";
import { parseBucketLines, selectRebuttalTargets, composeRebuttalPrompt, type CritiqueInput } from "../core/exploreRebuttal.js";
import { parseSelfAssessment } from "../core/exploreSelfAssess.js";

function usage(): number {
  log.error("usage: explore <init|classify|spawn-all|research-send|research-wait|survivors|openq-collate|openq-send|openq-wait|diff|crossverify-send|crossverify-wait|wait-gate|synth-preliminary|" +
    "confidence|annotate|adversary-send|adversary-wait|rebuttal-send|rebuttal-wait|gap-send|gap-wait|signoff-send|signoff-wait|synth-final|verdict-tally|forensics|teardown|handoff-extract> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest, { valueFlags: new Set<string>() }));
    case "classify": return classifyRun(rest);
    case "spawn-all": return spawnAllRun(rest);
    case "research-send": return researchSendRun(rest);
    case "research-wait": return researchWaitRun(rest);
    case "survivors": return survivorsRun(rest);
    case "openq-collate": return openqCollateRun(rest);
    case "openq-send": return openqSendRun(rest);
    case "openq-wait": return openqWaitRun(rest);
    case "diff": return diffExploreRun(rest);
    case "crossverify-send": return crossverifySendRun(rest);
    case "crossverify-wait": return crossverifyWaitRun(rest);
    case "rebuttal-send": return rebuttalSendRun(rest);
    case "rebuttal-wait": return rebuttalWaitRun(rest);
    case "gap-send": return gapSendRun(rest);
    case "gap-wait": return gapWaitRun(rest);
    case "signoff-send": return signoffSendRun(rest);
    case "signoff-wait": return signoffWaitRun(rest);
    case "wait-gate": return exploreWaitGateRun(rest);
    case "synth-preliminary": return synthPreliminaryRun(rest);
    case "confidence": return confidenceRun(rest);
    case "annotate": return annotateRun(rest);
    case "adversary-send": return adversarySendRun(rest);
    case "adversary-wait": return adversaryWaitRun(rest);
    case "synth-final": return synthFinalRun(rest);
    case "verdict-tally": return verdictTallyRun(rest);
    case "forensics": return forensicsRun(rest);
    case "flag": return runFlag("explore", rest[0], rest.slice(1).join(" "));
    case "teardown": return teardownRun(rest);
    case "handoff-extract": return handoffExtractRun(rest);
    default: return usage();
  }
}

// ---- init ----

export interface ExploreInitDeps {
  activeProviders(): string[];
  isValidated(provider: string): boolean;
  pickAgents(topic: string, n: number): string[];
}
const liveExploreInitDeps: ExploreInitDeps = {
  activeProviders: () => readProviderList(activeProvidersPath()),
  isValidated: agentConsultValidated,
  pickAgents,
};
async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, liveExploreInitDeps); }

export async function initWith(tokens: string[], d: ExploreInitDeps): Promise<number> {
  const topicText = tokens.join(" ").trim();
  if (!topicText) { log.error("explore init: topic text is empty"); return 1; }
  const topic = deriveSlug(topicText);
  if (!topic) { log.error("explore init: topic produced an empty slug; provide alphanumerics"); return 1; }

  let list = d.activeProviders().filter((p) => d.isValidated(p));
  if (list.length < 2) {
    log.error(`explore init: needs >=2 consult-validated providers; got ${list.length}`);
    log.error("  just ask Claude directly (this session) — no /ap:explore orchestration needed");
    return 1;
  }
  if (list.length > 3) { log.warn(`explore init: ${list.length} providers available; capping to the first 3`); list = list.slice(0, 3); }

  const art = exploreArtDir(topic);
  if (existsSync(art)) { log.error(`explore init: topic already in flight: ${art}`); log.error("  run /ap:stop or pick a different topic"); return 2; }

  const agents = d.pickAgents(topic, list.length);
  if (agents.length < list.length) { log.error(`explore init: agent pool exhausted (need ${list.length}, got ${agents.length})`); return 1; }
  const rows: ListRow[] = list.map((provider, i) => ({ provider, agent: agents[i] }));

  mkdirSync(art, { recursive: true });
  atomicWrite(join(art, "topic.txt"), topicText);
  atomicWrite(join(art, "list.txt"), formatListFile(rows, isoUtc()));

  log.ok(`explore init: topic=${topic} N=${rows.length}`);
  process.stdout.write(
    `TOPIC=${topic}\nN=${rows.length}\nART=${art}\n` +
    rows.map((r) => `PART=${r.agent}:${r.provider}`).join("\n") + "\n",
  );
  return 0;
}

// ---- classify (lit auto-detect) ----
export async function classifyRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore classify <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore classify: ${art} not found (run explore init)`); return 1; }
  const topicText = readIf(join(art, "topic.txt")).trim();
  const track = classifyTopic(topicText);
  atomicWrite(join(art, "lit-track.txt"), `${track}\nreason: auto-detect via keyword scan\n`);
  log.ok(`explore classify: lit-track=${track}`);
  return 0;
}

// ---- spawn-all ----
export interface ExploreSpawnAllDeps {
  preflight(args: string[]): Promise<number>;
  spawn(args: string[]): Promise<number>;
  repoRoot(): string;
}
const liveExploreSpawnAllDeps: ExploreSpawnAllDeps = { preflight: preflightRun, spawn: spawnRun, repoRoot };

async function spawnAllRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore spawn-all <topic>"); return 2; }
  return spawnAllWith(topic, liveExploreSpawnAllDeps);
}

export async function spawnAllWith(topic: string, d: ExploreSpawnAllDeps): Promise<number> {
  return spawnAllBatch("explore", topic, exploreArtDir(topic), d);
}

// ---- research-send / research-wait ----
export interface ResearchSendDeps {
  offsetFor(agent: string, model: string, topic: string): number;
  send(args: string[]): Promise<number>;
}
const liveResearchSendDeps: ResearchSendDeps = {
  offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)),
  send: sendRun,
};
async function researchSendRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore research-send <topic> <agent> <provider>"); return 2; }
  return researchSendWith(topic, agent, provider, liveResearchSendDeps);
}
export async function researchSendWith(topic: string, agent: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `research-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore research-send: ${stateFile} exists; rm to retry`); return 1; }
  const topicText = readIf(join(art, "topic.txt")).trim();
  if (!topicText) { log.error(`explore research-send: topic.txt missing/empty at ${art} (run explore init)`); return 1; }

  const track = readIf(join(art, "lit-track.txt")).startsWith("ON") ? "ON" : "OFF";
  const findingsPath = join(art, `findings-${agent}.md`); // art-dir-flat (faithful to meditate)
  const promptFile = join(art, `${agent}_research_prompt.md`);
  atomicWrite(promptFile, composeExploreResearchPrompt(topicText, findingsPath, litGuidance(track), researchLens(provider), join(art, `selfassess-${agent}.md`)));

  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`explore research-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`explore research-send: ${agent} offset=${offset}`);
  return 0;
}

export interface ResearchWaitDeps {
  wait(agent: string, model: string, topic: string, offset: number, events: string[], timeoutSec: number): Promise<OutboxEvent | null>;
  multiplier(provider: string): string;
}
const liveResearchWaitDeps: ResearchWaitDeps = {
  wait: liveOutboxWait,
  multiplier: agentTimeoutMultiplier,
};
async function researchWaitRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore research-wait <topic> <agent> <provider>"); return 2; }
  return researchWaitWith(topic, agent, provider, liveResearchWaitDeps);
}
export async function researchWaitWith(topic: string, agent: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `research-${agent}.txt`);
  if (!existsSync(stateFile)) { log.error(`explore research-wait: ${stateFile} missing (run explore research-send first)`); return 1; }
  const offset = parseLatestOffset(readFileSync(stateFile, "utf8"));
  if (offset === null) { log.error(`explore research-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("research"), d.multiplier(provider));
  log.info(`explore research-wait: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, TERMINAL_EVENTS, timeout);

  const findingsPath = join(art, `findings-${agent}.md`);
  const findingsText = readIfExistsOrNull(findingsPath);
  const fs = researchState(ev, findingsText);
  recordWaitOutcome(agent, provider, topic, stateFile, fs, "FS",
    ev ? { file: join(art, `question-${agent}.txt`), body: JSON.stringify(ev) + "\n" } : undefined);
  writeFileSync(join(art, `research-${agent}.done`), "");
  log.ok(`explore research-wait: ${agent} FS=${fs}`);
  return 0;
}

// ---- openq-collate / openq-send / openq-wait (Phase 4b open-questions peer relay) ----
export async function openqCollateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore openq-collate <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore openq-collate: ${art} not found — run explore init`); return 1; }
  const rows = parseListFile(readIf(join(art, "list.txt")));
  if (rows.length === 0) { log.error(`explore openq-collate: list.txt missing or empty at ${art}`); return 1; }

  const questionsByAgent = new Map<string, string[]>();
  for (const r of rows) questionsByAgent.set(r.agent, parseOpenQuestions(readIf(join(art, `findings-${r.agent}.md`))));

  const assignments = assignOpenQuestions(rows, questionsByAgent);
  if (assignments.size === 0) {
    log.ok("explore openq-collate: no open questions in any findings — phase skips");
    process.stdout.write("OPENQ=none\n");
    return 0;
  }
  const collated = rows.map((r) => {
    const qs = questionsByAgent.get(r.agent) ?? [];
    return `## ${r.agent}\n` + (qs.length ? qs.map((q) => `- ${q}`).join("\n") : "(none)");
  }).join("\n\n") + "\n";
  atomicWrite(join(art, "open-questions.md"), collated);
  for (const [target, list] of assignments) {
    atomicWrite(join(art, `openq-claims-${target}.txt`), formatOpenqClaims(list));
  }
  log.ok(`explore openq-collate: routed questions to ${assignments.size} worker(s)`);
  process.stdout.write(`OPENQ=${assignments.size}\n`);
  return 0;
}

async function openqSendRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore openq-send <topic> <agent> <provider>"); return 2; }
  return openqSendWith(topic, agent, provider, liveResearchSendDeps);
}
export async function openqSendWith(topic: string, agent: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `openq-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore openq-send: ${stateFile} exists; rm to retry`); return 1; }

  const fsTag = lastTag(readIf(join(art, `research-${agent}.txt`)), "FS"); // timeout-dispatch guard first
  if (fsTag === "timeout" || fsTag === "failed") {
    atomicWrite(stateFile, "QS=skipped\n");
    log.warn(`explore openq-send: ${agent} skipped — research ended FS=${fsTag} (worker may still be busy; sending would clobber its inbox)`);
    return 0;
  }
  const claims = parseOpenqClaims(readIf(join(art, `openq-claims-${agent}.txt`)));
  if (claims.length === 0) {
    atomicWrite(stateFile, "QS=skipped\n");
    log.ok(`explore openq-send: ${agent} QS=skipped (no questions routed to it)`);
    return 0;
  }
  const answersPath = join(art, `openq-${agent}.md`);
  const promptFile = join(art, `${agent}_openq_prompt.md`);
  atomicWrite(promptFile, composeOpenqPrompt(claims, answersPath));

  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`explore openq-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`explore openq-send: ${agent} offset=${offset}`);
  return 0;
}

async function openqWaitRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore openq-wait <topic> <agent> <provider>"); return 2; }
  return openqWaitWith(topic, agent, provider, liveResearchWaitDeps);
}
export async function openqWaitWith(topic: string, agent: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `openq-${agent}.txt`);
  if (!existsSync(stateFile)) { log.error(`explore openq-wait: ${stateFile} missing (run explore openq-send first)`); return 1; }
  const text = readFileSync(stateFile, "utf8");
  if (lastTag(text, "QS") === "skipped") { // guard/zero-questions short-circuit: nothing was sent
    writeFileSync(join(art, `openq-${agent}.done`), "");
    log.ok(`explore openq-wait: ${agent} QS=skipped (already)`);
    return 0;
  }
  const offset = parseLatestOffset(text);
  if (offset === null) { log.error(`explore openq-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("openq"), d.multiplier(provider));
  log.info(`explore openq-wait: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, TERMINAL_EVENTS, timeout);

  const answersPath = join(art, `openq-${agent}.md`);
  const qs = verifyState(ev, readIfExistsOrNull(answersPath)); // done → ok iff answers file non-empty
  recordWaitOutcome(agent, provider, topic, stateFile, qs, "QS",
    ev ? { file: join(art, `question-${agent}.txt`), body: JSON.stringify(ev) + "\n" } : undefined);
  writeFileSync(join(art, `openq-${agent}.done`), "");
  log.ok(`explore openq-wait: ${agent} QS=${qs}`);
  return 0;
}

// ---- diff (Approaches-schema buckets; foundation for crossverify/rebuttal/gap rounds) ----
export async function diffExploreRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore diff <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore diff: ${art} not found — run explore init`); return 1; }
  if (existsSync(join(art, "diff.md"))) { log.error("explore diff: diff.md exists; rm to retry"); return 1; }
  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error("explore diff: list.txt missing — run explore init first"); return 1; }
  const rows = parseListFile(readFileSync(listPath, "utf8"));
  if (rows.length < 2) { log.error(`explore diff: need >=2 workers in list.txt, got ${rows.length}`); return 1; }

  const workers: DiffPart[] = [];
  for (const r of rows) {
    const f = join(art, `findings-${r.agent}.md`);
    if (!existsSync(f)) { log.error(`explore diff: ${r.agent} findings missing: ${f}`); return 1; }
    workers.push({ name: r.agent, findings: readFileSync(f, "utf8") });
  }
  const result = diffFindings(workers, ["Approaches"]);
  for (const file of result.files) atomicWrite(join(art, file.filename), file.content);
  atomicWrite(join(art, "diff.md"), result.diffMd);
  const summary = result.files
    .filter((f) => f.filename.endsWith("_only_items.txt") || f.filename === "consensus.txt")
    .map((f) => `${f.filename.replace(/\.txt$/, "")}=${f.content.split("\n").filter(Boolean).length}`)
    .join(" ");
  log.ok(`explore diff: wrote ${join(art, "diff.md")} (${rows.length} workers) ${summary}`);
  return 0;
}

// ---- crossverify-send / crossverify-wait (Phase 4c peer cross-verification) ----
async function crossverifySendRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore crossverify-send <topic> <agent> <provider>"); return 2; }
  return crossverifySendWith(topic, agent, provider, liveResearchSendDeps);
}
export async function crossverifySendWith(topic: string, agent: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `crossverify-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore crossverify-send: ${stateFile} exists; rm to retry`); return 1; }

  const fsTag = lastTag(readIf(join(art, `research-${agent}.txt`)), "FS"); // timeout-dispatch guard first
  const qsTag = lastTag(readIf(join(art, `openq-${agent}.txt`)), "QS");
  const unsafe = fsTag === "timeout" || fsTag === "failed" ? `FS=${fsTag}`
    : qsTag === "timeout" || qsTag === "failed" ? `QS=${qsTag}` : null;
  if (unsafe) {
    atomicWrite(stateFile, "VS=skipped\n");
    log.warn(`explore crossverify-send: ${agent} skipped — previous phase ended ${unsafe} (worker may still be busy; sending would clobber its inbox)`);
    return 0;
  }

  const agents = parseListFile(readIf(join(art, "list.txt"))).map((r) => r.agent);
  if (agents.length < 2) { log.error(`explore crossverify-send: need >=2 workers in list.txt, got ${agents.length}`); return 1; }
  if (!agents.includes(agent)) { log.error(`explore crossverify-send: ${agent} not in list.txt`); return 1; }

  const parts: string[] = [];
  for (const f of verifyScopeFiles(agent, agents)) {
    const p = join(art, f);
    if (!existsSync(p)) { log.error(`explore crossverify-send: expected bucket missing: ${p} (run explore diff first)`); return 1; }
    const c = readFileSync(p, "utf8");
    if (c.split("\n").some((l) => l.length > 0)) parts.push(c.replace(/\n+$/, ""));
  }
  const items = parts.join("\n");
  atomicWrite(join(art, `crossverify-claims-${agent}.txt`), items ? items + "\n" : "");
  if (!items) { atomicWrite(stateFile, "VS=skipped\n"); log.ok(`explore crossverify-send: ${agent} VS=skipped (no peer claims to verify)`); return 0; }

  const outPath = join(art, `crossverify-${agent}.md`);
  const promptFile = join(art, `${agent}_crossverify_prompt.md`);
  atomicWrite(promptFile, composeVerifyPrompt(items, outPath));

  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`explore crossverify-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`explore crossverify-send: ${agent} offset=${offset}`);
  return 0;
}

async function crossverifyWaitRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore crossverify-wait <topic> <agent> <provider>"); return 2; }
  return crossverifyWaitWith(topic, agent, provider, liveResearchWaitDeps);
}
export async function crossverifyWaitWith(topic: string, agent: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `crossverify-${agent}.txt`);
  if (!existsSync(stateFile)) { log.error(`explore crossverify-wait: ${stateFile} missing (run explore crossverify-send first)`); return 1; }
  const text = readFileSync(stateFile, "utf8");
  if (lastTag(text, "VS") === "skipped") { // guard/empty-scope short-circuit: nothing was sent
    writeFileSync(join(art, `crossverify-${agent}.done`), "");
    log.ok(`explore crossverify-wait: ${agent} VS=skipped (already)`);
    return 0;
  }
  const offset = parseLatestOffset(text);
  if (offset === null) { log.error(`explore crossverify-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("verify"), d.multiplier(provider));
  log.info(`explore crossverify-wait: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, TERMINAL_EVENTS, timeout);

  const vs = verifyState(ev, readIfExistsOrNull(join(art, `crossverify-${agent}.md`))); // done → ok iff verdicts non-empty
  recordWaitOutcome(agent, provider, topic, stateFile, vs, "VS",
    ev ? { file: join(art, `question-${agent}.txt`), body: JSON.stringify(ev) + "\n" } : undefined);
  writeFileSync(join(art, `crossverify-${agent}.done`), "");
  log.ok(`explore crossverify-wait: ${agent} VS=${vs}`);
  return 0;
}

// ---- rebuttal-send / rebuttal-wait (Phase 7b bounded defend-or-concede) ----
async function rebuttalSendRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore rebuttal-send <topic> <agent> <provider>"); return 2; }
  return rebuttalSendWith(topic, agent, provider, liveResearchSendDeps);
}
export async function rebuttalSendWith(topic: string, agent: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `rebuttal-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore rebuttal-send: ${stateFile} exists — one rebuttal round per worker (the one-turn cap)`); return 1; }

  const asTag = lastTag(readIf(join(art, `adversary-${agent}.txt`)), "AS"); // timeout-dispatch guard first
  if (asTag === "timeout" || asTag === "failed") {
    atomicWrite(stateFile, "RS=skipped\n");
    log.warn(`explore rebuttal-send: ${agent} skipped — adversary ended AS=${asTag} (worker may still be busy; sending would clobber its inbox)`);
    return 0;
  }

  const rows = parseListFile(readIf(join(art, "list.txt")));
  if (!rows.some((r) => r.agent === agent)) { log.error(`explore rebuttal-send: ${agent} not in list.txt at ${art}`); return 1; }

  const buckets = new Map<string, Claim[]>();
  for (const r of rows) buckets.set(r.agent, parseBucketLines(readIf(join(art, `${r.agent}_only_items.txt`))));

  const critiques: CritiqueInput[] = rows
    .filter((r) => lastTag(readIf(join(art, `adversary-${r.agent}.txt`)), "AS") !== "skipped")
    .map((r) => ({ agent: r.agent, text: readIf(join(art, `adversary-${r.agent}.md`)) }))
    .filter((c) => c.text.trim().length > 0);

  const mine = selectRebuttalTargets(critiques, buckets).get(agent);
  if (!mine || mine.findings.length === 0) {
    atomicWrite(stateFile, "RS=skipped\n");
    log.ok(`explore rebuttal-send: ${agent} RS=skipped (no needs-attention findings attributed to it)`);
    return 0;
  }

  const outPath = join(art, `rebuttal-${agent}.md`);
  const promptFile = join(art, `${agent}_rebuttal_prompt.md`);
  atomicWrite(promptFile, composeRebuttalPrompt(mine.claims, mine.findings, outPath));

  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`explore rebuttal-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`explore rebuttal-send: ${agent} offset=${offset}`);
  return 0;
}

async function rebuttalWaitRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore rebuttal-wait <topic> <agent> <provider>"); return 2; }
  return rebuttalWaitWith(topic, agent, provider, liveResearchWaitDeps);
}
export async function rebuttalWaitWith(topic: string, agent: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `rebuttal-${agent}.txt`);
  if (!existsSync(stateFile)) { log.error(`explore rebuttal-wait: ${stateFile} missing (run explore rebuttal-send first)`); return 1; }
  const text = readFileSync(stateFile, "utf8");
  if (lastTag(text, "RS") === "skipped") { // guard/no-targets short-circuit: nothing was sent
    writeFileSync(join(art, `rebuttal-${agent}.done`), "");
    log.ok(`explore rebuttal-wait: ${agent} RS=skipped (already)`);
    return 0;
  }
  const offset = parseLatestOffset(text);
  if (offset === null) { log.error(`explore rebuttal-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("rebuttal"), d.multiplier(provider));
  log.info(`explore rebuttal-wait: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, TERMINAL_EVENTS, timeout);

  const rs = verifyState(ev, readIfExistsOrNull(join(art, `rebuttal-${agent}.md`))); // done → ok iff responses non-empty
  recordWaitOutcome(agent, provider, topic, stateFile, rs, "RS",
    ev ? { file: join(art, `question-${agent}.txt`), body: JSON.stringify(ev) + "\n" } : undefined);
  writeFileSync(join(art, `rebuttal-${agent}.done`), "");
  log.ok(`explore rebuttal-wait: ${agent} RS=${rs}`);
  return 0;
}

// ---- gap-send / gap-wait (Phase 7c post-gate gap enrichment; trigger = recorded S1/S2 false) ----
async function gapSendRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore gap-send <topic> <agent> <provider>"); return 2; }
  return gapSendWith(topic, agent, provider, liveResearchSendDeps);
}
export async function gapSendWith(topic: string, agent: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `gap-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore gap-send: ${stateFile} exists; rm to retry`); return 1; }

  // Trigger: the Phase 5.5 record's signals_passed line — S1=false or S2=false fires the round.
  // The record is READ ONLY here; the gate ran once and adversary-skip.txt is never rewritten.
  const signalsLine = readIf(join(art, "adversary-skip.txt")).split("\n").find((l) => l.startsWith("signals_passed:")) ?? "";
  if (!/\bS1=false\b/.test(signalsLine) && !/\bS2=false\b/.test(signalsLine)) {
    atomicWrite(stateFile, "GS=skipped\n");
    log.ok(`explore gap-send: ${agent} GS=skipped (no recorded S1/S2 failure — trigger not fired)`);
    return 0;
  }

  // Latest-phase guard: first non-skipped tag among RS -> AS -> FS decides safety.
  const tags: Array<[string, string | null]> = [
    ["RS", lastTag(readIf(join(art, `rebuttal-${agent}.txt`)), "RS")],
    ["AS", lastTag(readIf(join(art, `adversary-${agent}.txt`)), "AS")],
    ["FS", lastTag(readIf(join(art, `research-${agent}.txt`)), "FS")],
  ];
  const latest = tags.find(([, v]) => v !== null && v !== "skipped");
  if (latest && (latest[1] === "timeout" || latest[1] === "failed")) {
    atomicWrite(stateFile, "GS=skipped\n");
    log.warn(`explore gap-send: ${agent} skipped — latest phase ended ${latest[0]}=${latest[1]} (worker may still be busy; sending would clobber its inbox)`);
    return 0;
  }

  const agents = parseListFile(readIf(join(art, "list.txt"))).map((r) => r.agent);
  if (!agents.includes(agent)) { log.error(`explore gap-send: ${agent} not in list.txt at ${art}`); return 1; }

  const items: string[] = [];
  for (const f of verifyScopeFiles(agent, agents)) {
    for (const l of readIf(join(art, f)).split("\n")) if (l.length > 0) items.push(l);
  }
  if (items.length === 0) {
    atomicWrite(stateFile, "GS=skipped\n");
    log.ok(`explore gap-send: ${agent} GS=skipped (no peer-only items to enrich)`);
    return 0;
  }

  const outPath = join(art, `gap-${agent}.md`);
  const promptFile = join(art, `${agent}_gap_prompt.md`);
  atomicWrite(promptFile, composeGapPrompt(items, outPath));

  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`explore gap-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`explore gap-send: ${agent} offset=${offset}`);
  return 0;
}

async function gapWaitRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore gap-wait <topic> <agent> <provider>"); return 2; }
  return gapWaitWith(topic, agent, provider, liveResearchWaitDeps);
}
export async function gapWaitWith(topic: string, agent: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `gap-${agent}.txt`);
  if (!existsSync(stateFile)) { log.error(`explore gap-wait: ${stateFile} missing (run explore gap-send first)`); return 1; }
  const text = readFileSync(stateFile, "utf8");
  if (lastTag(text, "GS") === "skipped") { // trigger/guard/empty-scope short-circuit: nothing was sent
    writeFileSync(join(art, `gap-${agent}.done`), "");
    log.ok(`explore gap-wait: ${agent} GS=skipped (already)`);
    return 0;
  }
  const offset = parseLatestOffset(text);
  if (offset === null) { log.error(`explore gap-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("gap"), d.multiplier(provider));
  log.info(`explore gap-wait: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, TERMINAL_EVENTS, timeout);

  const gs = verifyState(ev, readIfExistsOrNull(join(art, `gap-${agent}.md`))); // done → ok iff answers non-empty
  recordWaitOutcome(agent, provider, topic, stateFile, gs, "GS",
    ev ? { file: join(art, `question-${agent}.txt`), body: JSON.stringify(ev) + "\n" } : undefined);
  writeFileSync(join(art, `gap-${agent}.done`), "");
  log.ok(`explore gap-wait: ${agent} GS=${gs}`);
  return 0;
}

// ---- signoff-send / signoff-wait (Phase 8b bounded final-doc fairness check) ----
/** The final landscape doc (`landscape-<date>-<topic>.md`), newest by name; null when unwritten.
 *  `landscape-draft.md` never matches (the date segment is required). */
function finalLandscapePath(art: string): string | null {
  let names: string[];
  try { names = readdirSync(art); } catch { return null; }
  const finals = names.filter((f) => /^landscape-\d{4}-\d{2}-\d{2}-.+\.md$/.test(f)).sort();
  return finals.length ? join(art, finals[finals.length - 1]) : null;
}

/** Body of the first matching `## <heading>` section (until the next `## `), "" when absent. */
function sectionText(text: string, headings: string[]): string {
  const out: string[] = [];
  let inSection = false;
  for (const line of text.split("\n")) {
    if (headings.some((h) => line.startsWith(`## ${h}`))) { inSection = true; continue; }
    if (/^## /.test(line)) { if (inSection) break; continue; }
    if (inSection) out.push(line);
  }
  return out.join("\n").trim();
}

async function signoffSendRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore signoff-send <topic> <agent> <provider>"); return 2; }
  return signoffSendWith(topic, agent, provider, liveResearchSendDeps);
}
export async function signoffSendWith(topic: string, agent: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `signoff-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore signoff-send: ${stateFile} exists — one sign-off turn per worker (the one-turn cap)`); return 1; }

  // Latest-phase guard: first non-skipped tag among GS -> RS -> AS -> QS -> FS decides safety.
  const tags: Array<[string, string | null]> = [
    ["GS", lastTag(readIf(join(art, `gap-${agent}.txt`)), "GS")],
    ["RS", lastTag(readIf(join(art, `rebuttal-${agent}.txt`)), "RS")],
    ["AS", lastTag(readIf(join(art, `adversary-${agent}.txt`)), "AS")],
    ["QS", lastTag(readIf(join(art, `openq-${agent}.txt`)), "QS")],
    ["FS", lastTag(readIf(join(art, `research-${agent}.txt`)), "FS")],
  ];
  const latest = tags.find(([, v]) => v !== null && v !== "skipped");
  if (latest && (latest[1] === "timeout" || latest[1] === "failed")) {
    atomicWrite(stateFile, "SS=skipped\n");
    log.warn(`explore signoff-send: ${agent} skipped — latest phase ended ${latest[0]}=${latest[1]} (worker may still be busy; sending would clobber its inbox)`);
    return 0;
  }

  const rows = parseListFile(readIf(join(art, "list.txt")));
  if (!rows.some((r) => r.agent === agent)) { log.error(`explore signoff-send: ${agent} not in list.txt at ${art}`); return 1; }

  const finalPath = finalLandscapePath(art);
  const conclusion = finalPath ? sectionText(readIf(finalPath), ["Conclusion"]) : "";
  if (!conclusion) { log.error(`explore signoff-send: final landscape doc missing or has no ## Conclusion at ${art} — author it (Phase 8) first`); return 1; }

  // Solo bucket + diff.md Agreed/Consensus text are tolerant-empty: a degraded N=1 run never ran
  // diff, and sign-off is exactly the misattribution check a single-source survey needs.
  const soloBucketLines = readIf(join(art, `${agent}_only_items.txt`)).split("\n").filter((l) => l.length > 0);
  const agreedText = sectionText(readIf(join(art, "diff.md")), ["Agreed", "Consensus"]);

  const outPath = join(art, `signoff-${agent}.md`);
  const promptFile = join(art, `${agent}_signoff_prompt.md`);
  atomicWrite(promptFile, composeSignoffPrompt(conclusion, soloBucketLines, agreedText, outPath));

  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`explore signoff-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`explore signoff-send: ${agent} offset=${offset}`);
  return 0;
}

async function signoffWaitRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore signoff-wait <topic> <agent> <provider>"); return 2; }
  return signoffWaitWith(topic, agent, provider, liveResearchWaitDeps);
}
export async function signoffWaitWith(topic: string, agent: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `signoff-${agent}.txt`);
  if (!existsSync(stateFile)) { log.error(`explore signoff-wait: ${stateFile} missing (run explore signoff-send first)`); return 1; }
  const text = readFileSync(stateFile, "utf8");
  if (lastTag(text, "SS") === "skipped") { // guard short-circuit: nothing was sent
    writeFileSync(join(art, `signoff-${agent}.done`), "");
    log.ok(`explore signoff-wait: ${agent} SS=skipped (already)`);
    return 0;
  }
  const offset = parseLatestOffset(text);
  if (offset === null) { log.error(`explore signoff-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("signoff"), d.multiplier(provider));
  log.info(`explore signoff-wait: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, TERMINAL_EVENTS, timeout);

  const ss = verifyState(ev, readIfExistsOrNull(join(art, `signoff-${agent}.md`))); // done → ok iff sign-off non-empty
  recordWaitOutcome(agent, provider, topic, stateFile, ss, "SS",
    ev ? { file: join(art, `question-${agent}.txt`), body: JSON.stringify(ev) + "\n" } : undefined);
  writeFileSync(join(art, `signoff-${agent}.done`), "");
  log.ok(`explore signoff-wait: ${agent} SS=${ss}`);
  return 0;
}

/** List rows whose `<prefix>-<agent>.md` art file is missing/empty → list of the missing filenames. */
function missingListArtifacts(art: string, rows: ListRow[], prefix: string): string[] {
  return rows.filter((r) => !readIf(join(art, `${prefix}-${r.agent}.md`)).trim()).map((r) => `${prefix}-${r.agent}.md`);
}

// ---- survivors (Phase 4a N-1 continuation: drop findings-less rows, preserve the roster) ----
export async function survivorsRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore survivors <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore survivors: ${art} not found — run explore init`); return 1; }
  const listPath = join(art, "list.txt");
  const rows = parseListFile(readIf(listPath));
  if (rows.length === 0) { log.error(`explore survivors: list.txt missing or empty at ${art}`); return 1; }

  // Survivor predicate IS missingListArtifacts' readIf().trim() — reused, never re-implemented (a
  // whitespace-only findings file must not survive here only to block synth-preliminary anyway).
  const missing = new Set(missingListArtifacts(art, rows, "findings"));
  const survivors = rows.filter((r) => !missing.has(`findings-${r.agent}.md`));
  const dropped = rows.filter((r) => missing.has(`findings-${r.agent}.md`));

  if (survivors.length === 0) {
    log.error("explore survivors: zero survivors — every findings file is missing or empty");
    return 1;
  }
  if (dropped.length === 0) {
    log.ok(`explore survivors: all ${rows.length} workers produced findings`);
    process.stdout.write(`SURVIVORS=${rows.length}\n`);
    return 0;
  }
  const originalPath = join(art, "list-original.txt");
  if (!existsSync(originalPath)) atomicWrite(originalPath, readFileSync(listPath, "utf8")); // once — crash/retry-safe
  atomicWrite(listPath, formatListFile(survivors, isoUtc()));
  log.warn(`explore survivors: dropped ${dropped.map((r) => r.agent).join(", ")} — ${survivors.length} of ${rows.length} continue`);
  process.stdout.write(`SURVIVORS=${survivors.length}\n`);
  for (const r of dropped) process.stdout.write(`DROPPED=${r.agent}\n`);
  if (survivors.length === 1) process.stdout.write("DEGRADED=1\n");
  return 0;
}

// ---- synth-preliminary (input validator) ----
export async function synthPreliminaryRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore synth-preliminary <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore synth-preliminary: ${art} not found — run explore init`); return 1; }
  for (const f of ["topic.txt", "list.txt"]) {
    if (!readIf(join(art, f)).trim()) { log.error(`explore synth-preliminary: missing or empty: ${join(art, f)}`); return 1; }
  }
  const rows = parseListFile(readIf(join(art, "list.txt")));
  const missing = missingListArtifacts(art, rows, "findings");
  if (missing.length) {
    log.error("explore synth-preliminary: blocked — missing or empty findings:");
    for (const m of missing) log.error(`  - ${join(art, m)}`);
    return 1;
  }
  const out = join(art, "landscape-draft.md");
  log.ok(`explore synth-preliminary: inputs validated for ${topic}`);
  process.stdout.write(out + "\n");
  return 0;
}

// ---- confidence (5-signal gate; two-call contract) ----
export async function confidenceRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore confidence <topic> [--decision skip|continue]"); return 2; }
  let decision: Decision | null = null;
  const di = rest.indexOf("--decision");
  if (di >= 0) {
    const v = rest[di + 1];
    if (v !== "skip" && v !== "continue") { log.error("explore confidence: --decision must be 'skip' or 'continue'"); return 2; }
    decision = v;
  }
  const art = exploreArtDir(topic);
  const draft = readIf(join(art, "landscape-draft.md"));
  if (!draft.trim()) { log.error(`explore confidence: landscape-draft.md missing/empty at ${art}`); return 1; }
  const rows = parseListFile(readIf(join(art, "list.txt")));
  const findings = rows.map((r) => readIf(join(art, `findings-${r.agent}.md`)));

  const s = computeSignals(draft, findings);
  log.info(`explore confidence: S1=${s.s1} S2=${s.s2} S3=${s.s3} S4=${s.s4} S5=${s.s5} — ALL_HOLD=${s.allHold}`);
  process.stdout.write(`S1=${s.s1}\nS2=${s.s2}\nS3=${s.s3}\nS4=${s.s4}\nS5=${s.s5}\n`);
  process.stdout.write(`ALL_HOLD=${s.allHold}\n`);

  if (decision) { // --decision path: record the user's choice
    atomicWrite(join(art, "adversary-skip.txt"), renderSkipRecord({ signals: s, decision, now: isoUtc() }));
    return 0;
  }
  if (!s.allHold) { // gate not offered → record not-offered, fall through to adversary
    atomicWrite(join(art, "adversary-skip.txt"), renderSkipRecord({ signals: s, decision: "not-offered", now: isoUtc() }));
  }
  // ALL_HOLD=true with no flag: write nothing — the Hub asks, then re-invokes with --decision.
  return 0;
}

// ---- annotate (Phase 5b evidence-weakness transparency overlay) ----
export async function annotateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore annotate <topic>"); return 2; }
  const art = exploreArtDir(topic);
  const markerPath = join(art, "annotate-applied.txt");
  if (existsSync(markerPath)) { log.ok(`explore annotate: already applied (${markerPath}) — no-op`); return 0; }
  const draftPath = join(art, "landscape-draft.md");
  const draft = readIf(draftPath);
  if (!draft.trim()) { log.error(`explore annotate: landscape-draft.md missing/empty at ${art}`); return 1; }
  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error(`explore annotate: list.txt missing at ${art}`); return 1; }
  const rows = parseListFile(readIf(listPath));
  const missing = missingListArtifacts(art, rows, "findings");
  if (missing.length) {
    log.error("explore annotate: blocked — missing or empty findings:");
    for (const m of missing) log.error(`  - ${join(art, m)}`);
    return 1;
  }
  const findings = rows.map((r) => readIf(join(art, `findings-${r.agent}.md`)));

  const { annotatedDraft, plan } = buildAnnotations(draft, findings);
  const counts = {
    n_unverified: plan.items.filter((i) => i.kind === "unverified").length,
    n_no_citation: plan.items.filter((i) => i.kind === "no-citation").length,
    n_approaches_flagged: plan.items.filter((i) => i.kind === "approaches-flagged").length,
  };
  atomicWrite(draftPath, annotatedDraft);
  atomicWrite(join(art, "annotations.json"), JSON.stringify({ topic, counts, items: plan.items }, null, 2) + "\n");
  atomicWrite(markerPath,
    `applied: ${isoUtc()}\nunverified=${counts.n_unverified} no_citation=${counts.n_no_citation} ` +
    `approaches_flagged=${counts.n_approaches_flagged}\n`);
  log.ok(`explore annotate: ${counts.n_unverified} unverified, ${counts.n_no_citation} no-citation, ` +
    `${counts.n_approaches_flagged} approaches-flagged`);
  return 0;
}

// ---- adversary-send / adversary-wait ----
/** Solo-citation tokens from annotations.json (kind unverified | approaches-flagged), unique, in
 *  file order. Missing/empty/malformed → [] — the Priority targets block is optional sharpening,
 *  never an error (annotate always runs before Phase 6, but a skip must not break dispatch). */
function soloTokensFromAnnotations(raw: string | null): string[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as { items?: { kind?: string; token?: string }[] };
    const seen = new Set<string>();
    for (const it of parsed.items ?? []) {
      if ((it.kind === "unverified" || it.kind === "approaches-flagged") && it.token) seen.add(it.token);
    }
    return [...seen];
  } catch { return []; }
}

async function adversarySendRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore adversary-send <topic> <agent> <provider>"); return 2; }
  return adversarySendWith(topic, agent, provider, liveResearchSendDeps);
}
export async function adversarySendWith(topic: string, agent: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const draft = readIf(join(art, "landscape-draft.md"));
  if (!draft.trim()) { log.error("explore adversary-send: landscape-draft.md missing or empty — run synth-preliminary first"); return 1; }
  const stateFile = join(art, `adversary-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore adversary-send: ${stateFile} exists; rm to retry`); return 1; }

  const fsTag = lastTag(readIf(join(art, `research-${agent}.txt`)), "FS");
  const qsTag = lastTag(readIf(join(art, `openq-${agent}.txt`)), "QS");
  const unsafe = fsTag === "timeout" || fsTag === "failed" ? `FS=${fsTag}`
    : qsTag === "timeout" || qsTag === "failed" ? `QS=${qsTag}` : null;
  if (unsafe) {
    atomicWrite(stateFile, "AS=skipped\n");
    log.warn(`explore adversary-send: ${agent} skipped — previous phase ended ${unsafe} (worker may still be busy; sending would clobber its inbox)`);
    return 0;
  }

  const rows = parseListFile(readIf(join(art, "list.txt")));
  const index = rows.findIndex((r) => r.agent === agent);
  if (index < 0) { log.error(`explore adversary-send: ${agent} not in list.txt at ${art}`); return 1; }
  const peerFindingsPaths = rows.filter((r) => r.agent !== agent).map((r) => join(art, `findings-${r.agent}.md`));
  const lens = ADVERSARY_LENSES[index % ADVERSARY_LENSES.length];
  const priorityTargets = soloTokensFromAnnotations(readIfExistsOrNull(join(art, "annotations.json")));
  const lowConfidenceClaims: string[] = []; // union across ALL workers' selfassess files (missing → skip)
  for (const r of rows) {
    for (const l of parseSelfAssessment(readIf(join(art, `selfassess-${r.agent}.md`))).leastSure) {
      if (!lowConfidenceClaims.includes(l)) lowConfidenceClaims.push(l);
    }
  }

  const outPath = join(art, `adversary-${agent}.md`);
  const promptFile = join(art, `${agent}_adversary_prompt.md`);
  atomicWrite(promptFile, composeAdversaryPrompt(draft, agent, outPath, { peerFindingsPaths, lens, priorityTargets, lowConfidenceClaims }));

  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`explore adversary-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`explore adversary-send: ${agent} offset=${offset}`);
  return 0;
}

async function adversaryWaitRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: explore adversary-wait <topic> <agent> <provider>"); return 2; }
  return adversaryWaitWith(topic, agent, provider, liveResearchWaitDeps);
}
export async function adversaryWaitWith(topic: string, agent: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `adversary-${agent}.txt`);
  if (!existsSync(stateFile)) { log.error(`explore adversary-wait: ${stateFile} missing (run explore adversary-send first)`); return 1; }
  const text = readFileSync(stateFile, "utf8");
  if (lastTag(text, "AS") === "skipped") { // guard short-circuit: nothing was sent
    writeFileSync(join(art, `adversary-${agent}.done`), "");
    log.ok(`explore adversary-wait: ${agent} AS=skipped (already)`);
    return 0;
  }
  const offset = parseLatestOffset(text);
  if (offset === null) { log.error(`explore adversary-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("adversary"), d.multiplier(provider));
  log.info(`explore adversary-wait: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, TERMINAL_EVENTS, timeout);

  const outPath = join(art, `adversary-${agent}.md`);
  const outText = readIfExistsOrNull(outPath);
  const as = verifyState(ev, outText); // done -> ok iff non-empty; mirrors the adversary wait's -s check
  recordWaitOutcome(agent, provider, topic, stateFile, as, "AS",
    ev ? { file: join(art, `question-${agent}.txt`), body: JSON.stringify(ev) + "\n" } : undefined);
  writeFileSync(join(art, `adversary-${agent}.done`), "");
  log.ok(`explore adversary-wait: ${agent} AS=${as}`);
  return 0;
}

// ---- wait-gate (composes the pure gateState over research/adversary state files) ----
export async function exploreWaitGateRun(rest: string[]): Promise<number> {
  const [topic, phase] = rest;
  const KEYS: Record<string, "FS" | "VS" | "AS" | "QS" | "RS" | "GS" | "SS"> = {
    research: "FS", openq: "QS", crossverify: "VS", adversary: "AS", rebuttal: "RS", gap: "GS", signoff: "SS",
  };
  if (!topic || !phase) { log.error("usage: explore wait-gate <topic> <research|openq|crossverify|adversary|rebuttal|gap|signoff>"); return 2; }
  const key = KEYS[phase];
  if (!key) { log.error(`explore wait-gate: phase must be research|openq|crossverify|adversary|rebuttal|gap|signoff (got ${phase})`); return 2; }
  const art = exploreArtDir(topic);
  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error(`explore wait-gate: list.txt missing at ${art}`); return 2; }
  const rows = parseListFile(readFileSync(listPath, "utf8"));
  if (rows.length === 0) { log.error("explore wait-gate: list.txt has no workers"); return 2; }
  const workers = rows.map((r) => {
    const stateFile = join(art, `${phase}-${r.agent}.txt`);
    return {
      agent: r.agent,
      doneExists: existsSync(join(art, `${phase}-${r.agent}.done`)),
      stateText: readIfExistsOrNull(stateFile),
    };
  });
  const states = gateState(workers, key);
  for (const s of states) process.stdout.write(`${s.agent}\t${s.status}\n`);
  return states.every((s) => s.status === "terminal") ? 0 : 1;
}

// ---- synth-final (input validator) ----
export async function synthFinalRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore synth-final <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore synth-final: ${art} not found`); return 1; }
  if (!readIf(join(art, "landscape-draft.md")).trim()) { log.error("explore synth-final: landscape-draft.md missing"); return 1; }
  if (!readIf(join(art, "topic.txt")).trim()) { log.error("explore synth-final: topic.txt missing"); return 1; }

  const skipped = /^user_decision: skip$/m.test(readIf(join(art, "adversary-skip.txt")));
  if (!skipped) {
    const rows = parseListFile(readIf(join(art, "list.txt")));
    const active = rows.filter((r) => lastTag(readIf(join(art, `adversary-${r.agent}.txt`)), "AS") !== "skipped");
    const missing = missingListArtifacts(art, active, "adversary");
    if (missing.length) {
      log.error("explore synth-final: blocked — adversary ran but critiques missing:");
      for (const m of missing) log.error(`  - ${join(art, m)}`);
      return 1;
    }
  }
  const today = isoUtc().slice(0, 10);
  const out = join(art, `landscape-${today}-${topic}.md`);
  log.ok(`explore synth-final: inputs validated for ${topic} (adversary_ran=${skipped ? 0 : 1})`);
  process.stdout.write(out + "\n");
  return 0;
}

// ---- verdict-tally (deterministic adversary consensus; Phase 8 consumes the stdout) ----
export async function verdictTallyRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore verdict-tally <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore verdict-tally: ${art} not found — run explore init`); return 1; }
  const listRaw = readIf(join(art, "list.txt"));
  if (!listRaw.trim()) { log.error(`explore verdict-tally: list.txt missing or empty at ${art}`); return 1; }
  const rows = parseListFile(listRaw);
  const verdictRows = rows.map((r) => {
    const as = lastTag(readIf(join(art, `adversary-${r.agent}.txt`)), "AS");
    const verdict = as === "skipped" ? "skipped" : parseAdversaryVerdict(readIf(join(art, `adversary-${r.agent}.md`)));
    return { agent: r.agent, verdict };
  });
  for (const v of verdictRows) process.stdout.write(`VERDICT=${v.agent}:${v.verdict}\n`);
  const { tally } = tallyVerdicts(verdictRows);
  process.stdout.write(`TALLY=${tally}\n`);
  log.ok(`explore verdict-tally: ${tally}`);
  return 0;
}

// ---- forensics (delegates to core runForensics) ----
export async function forensicsRun(rest: string[]): Promise<number> {
  return runForensics("explore", exploreArtDir, rest[0]);
}

// ---- teardown (orphan kill + archive; panes torn down by the directive's stop --pairs) ----
export interface ExploreTeardownDeps {
  killPane(pane: string): Promise<void>;
  archiveTopic(topic: string, suite: "explore"): string | null;
  stdout?: (l: string) => void;
}
const liveExploreTeardownDeps: ExploreTeardownDeps = {
  killPane: (p) => killNow(p),
  archiveTopic: (t, s) => archiveTopic(t, s),
};
async function teardownRun(rest: string[]): Promise<number> { return teardownWith(rest, liveExploreTeardownDeps); }

export async function teardownWith(args: string[], deps: ExploreTeardownDeps): Promise<number> {
  const out = deps.stdout ?? ((l: string): void => { process.stdout.write(l + "\n"); });
  // --panes-only is the mid-flight reset for Phase 2's spawn-retry: kill the partial-spawn
  // panes + clear the per-attempt artifacts, but PRESERVE list/topic/research state (no
  // archive) so the immediately-following spawn-all can reuse it. The default (archiving)
  // mode is the terminal Phase-9 teardown.
  const panesOnly = args.includes("--panes-only");
  const topic = args.find((a) => !a.startsWith("--"));
  if (!topic) { log.error("explore teardown: topic required"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art) || !statSync(art).isDirectory()) { log.error(`${art} not found`); return 1; }

  const pf = join(art, "preflight-panes.txt");
  if (existsSync(pf)) {
    for (const pane of parsePanesFile(readFileSync(pf, "utf8")).values()) {
      try { await deps.killPane(pane); } catch { /* best-effort */ }
    }
  }

  if (panesOnly) {
    for (const f of ["preflight-panes.txt", "spawn-results.tsv"]) {
      try { rmSync(join(art, f), { force: true }); } catch { /* best-effort */ }
    }
    log.ok(`[teardown] panes-only reset for ${topic} (state preserved for retry)`);
    return 0;
  }

  const dest = deps.archiveTopic(topic, "explore");
  if (dest) { out(dest); log.ok(`[teardown] archived ${topic} -> ${dest}`); }
  return 0;
}

// ---- handoff-extract (runs against the archived art-dir) ----
export async function handoffExtractRun(rest: string[]): Promise<number> {
  const artDir = rest[0];
  if (!artDir) { log.error("usage: explore handoff-extract <art-dir>"); return 2; }
  const path = extractHandoffData(artDir);
  if (!path) { log.error(`explore handoff-extract: art-dir or topic.txt missing under ${artDir}`); return 2; }
  log.ok(`explore handoff-extract: wrote ${path}`);
  process.stdout.write(path + "\n");
  return 0;
}
