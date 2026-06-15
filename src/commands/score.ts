// src/commands/score.ts
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc, archiveTopic } from "../core/archive.js";
import {
  deriveSlug, parseScoreArgs, scoreArtDir, scoreDraftDir,
  formatRosterFile, scoreDocPath, parseRosterFile,
  spawnRosterArg, spawnResultsTsv, spawnTally, parsePanesFile, verifyScopeFiles, lastTag,
  resolveDrilldownPath, cascadeTargets, exportDocTo,
  type RosterRow, type SpawnResult, type ResetPhase,
} from "../core/score.js";
import { assembleDoc, SECTIONS_SINGLE, synthesizeSeeds } from "../core/scoreDoc.js";
import { auditDoc } from "../core/audit.js";
import { readProviderList } from "../core/providers.js";
import { activeProvidersPath, workerDir, repoRoot, topicDir } from "../core/paths.js";
import { pickAgents } from "../core/agents.js";
import { outboxOffset, outboxPath, outboxWaitSince, type OutboxEvent } from "../core/ipc.js";
import { agentConsultValidated, consultTimeout, agentTimeoutMultiplier } from "../core/contracts.js";
import { composeResearchPrompt, researchState, parseLatestOffset, scaledTimeout, composeVerifyPrompt, verifyState, composeDrilldownPrompt, drilldownState, gateState } from "../core/scoreTurn.js";
import { runForensics, runFlag } from "../core/forensics.js";
import { diffFindings, type DiffPart } from "../core/scoreDiff.js";
import { adjudicate, type AdjudicateInput } from "../core/scoreAdjudicate.js";
import { classifyTopic, skillHintAppend } from "../core/scoreSkill.js";
import { readIfExists as readIf, readIfExistsOrNull } from "../core/fsread.js";
import { walkSectionState, auditIssueToSection } from "../core/scoreWalk.js";
import { run as sendRun } from "./send.js";
import { run as spawnRun } from "./spawn.js";
import { run as preflightRun } from "./preflight.js";

function usage(): number { log.error("usage: score <init|assemble|spawn-all|research-send|research-wait|wait-gate|diff|verify-send|verify-wait|adjudicate|synthesize|walk-state|drilldown|offset-reset|export-doc|flag|forensics|archive> ..."); return 2; }

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest, { valueFlags: new Set() }));
    case "assemble": return assembleRun(rest);
    case "spawn-all": return spawnAllRun(rest);
    case "research-send": return researchSendRun(rest);
    case "research-wait": return researchWaitRun(rest);
    case "diff": return diffRun(rest);
    case "verify-send": return verifySendRun(rest);
    case "verify-wait": return verifyWaitRun(rest);
    case "adjudicate": return adjudicateRun(rest);
    case "synthesize": return synthesizeRun(rest);
    case "walk-state": return walkStateRun(rest);
    case "wait-gate": return waitGateRun(rest);
    case "drilldown": return drilldownRun(rest);
    case "offset-reset": return offsetResetRun(rest);
    case "forensics": return forensicsRun(rest);
    case "flag": return runFlag("score", rest[0], rest.slice(1).join(" "));
    case "archive": return archiveRun(rest);
    case "export-doc": return exportDocRun(rest);
    default: return usage();
  }
}

export interface ScoreInitDeps {
  activeProviders(): string[];
  isValidated(provider: string): boolean;
  pickAgents(topic: string, n: number): string[];
}
const liveInitDeps: ScoreInitDeps = {
  activeProviders: () => readProviderList(activeProvidersPath()),
  isValidated: agentConsultValidated,
  pickAgents,
};

async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, liveInitDeps); }

export async function initWith(tokens: string[], d: ScoreInitDeps): Promise<number> {
  const { topicText, ensemble } = parseScoreArgs(tokens);
  if (!topicText) { log.error("score init: topic text is empty"); return 1; }
  const topic = deriveSlug(topicText);
  if (!topic) { log.error("score init: topic produced an empty slug; provide alphanumerics"); return 1; }

  let roster = d.activeProviders().filter((p) => d.isValidated(p));
  if (roster.length < 2) {
    log.error(`score init: needs >=2 consult-validated providers; got ${roster.length}`);
    log.error("  just ask Claude directly (this session) — no /ap:score orchestration needed");
    return 1;
  }
  if (roster.length > 3) { log.warn(`score init: ${roster.length} providers available; capping the ensemble to the first 3`); roster = roster.slice(0, 3); }

  const art = scoreArtDir(topic);
  if (existsSync(art)) { log.error(`score init: topic already in flight: ${art}`); log.error("  run /ap:coda or pick a different topic"); return 2; }

  const agents = d.pickAgents(topic, roster.length);
  if (agents.length < roster.length) { log.error(`score init: agent pool exhausted (need ${roster.length}, got ${agents.length})`); return 1; }
  const rows: RosterRow[] = roster.map((provider, i) => ({ provider, agent: agents[i] }));

  mkdirSync(scoreDraftDir(topic), { recursive: true }); // creates _score/design-doc/.draft
  atomicWrite(join(art, "topic.txt"), topicText);
  atomicWrite(join(art, "skill.txt"), classifyTopic(topicText));
  // Full roster written even on a fast-path run; the ensemble path (Phase C) reads roster.txt back.
  atomicWrite(join(art, "roster.txt"), formatRosterFile(rows, isoUtc()));

  log.ok(`score init: topic=${topic} N=${rows.length} ensemble=${ensemble ? "yes" : "no"}`);
  process.stdout.write(
    `TOPIC=${topic}\nN=${rows.length}\nENSEMBLE=${ensemble ? "yes" : "no"}\nART=${art}\n` +
    rows.map((r) => `PART=${r.agent}:${r.provider}`).join("\n") + "\n",
  );
  return 0;
}

async function assembleRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score assemble <topic>"); return 2; }
  const art = scoreArtDir(topic);
  const draftDir = scoreDraftDir(topic);
  if (!existsSync(draftDir)) { log.error(`score assemble: no draft dir at ${draftDir} (run score init + draft sections)`); return 2; }

  const title = (readIf(join(art, "topic.txt")).split("\n")[0] || topic).trim();
  const drafts = new Map<string, string>();
  // One trailing newline per section → a blank line between them (matches the behavioral source's
  // `cat draft; printf '\n'` and assembleDoc's missing-draft branch which emits a blank line).
  for (const k of SECTIONS_SINGLE) { const f = join(draftDir, `${k}.md`); if (existsSync(f)) drafts.set(k, readFileSync(f, "utf8").replace(/\n+$/, "") + "\n"); }

  const date = isoUtc().slice(0, 10);
  const doc = assembleDoc({ title, drafts });
  const out = scoreDocPath(topic, date);
  mkdirSync(join(art, "design-doc"), { recursive: true });
  atomicWrite(out, doc);

  const result = auditDoc(doc);
  const auditText = [`VERDICT=${result.verdict}`, ...result.issues.map((i) => `ISSUE=${i}`)].join("\n") + "\n";
  atomicWrite(join(art, "design-doc", "audit.log"), auditText);
  if (result.verdict === "FAIL") {
    for (const i of result.issues) process.stderr.write(`ISSUE=${i}\n`);
    for (const i of result.issues) process.stderr.write(`SECTION=${auditIssueToSection(i)}\n`);
    log.error(`score assemble: audit FAILED on ${out} (see design-doc/audit.log)`);
    return 1;
  }
  log.ok(`score assemble: audit PASSED`);
  process.stdout.write(out + "\n");
  return 0;
}

function exportDocRun(rest: string[]): number {
  const topic = rest[0];
  if (!topic) { log.error("usage: score export-doc <topic>"); return 2; }
  const dest = exportDocTo(topic, repoRoot());
  if (dest === null) {
    log.error(`score export-doc: no assembled *-${topic}-design.md found (run score assemble first)`);
    return 1;
  }
  log.ok(`score export-doc: exported to ${dest}`);
  process.stdout.write(`EXPORTED=${dest}\n`);
  return 0;
}

// ---- Phase C: escalation (spawn-all → research → diff) ----

export interface SpawnAllDeps {
  preflight(args: string[]): Promise<number>;
  spawn(args: string[]): Promise<number>;
  repoRoot(): string;
}
const liveSpawnAllDeps: SpawnAllDeps = { preflight: preflightRun, spawn: spawnRun, repoRoot };

async function spawnAllRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score spawn-all <topic>"); return 2; }
  return spawnAllWith(topic, liveSpawnAllDeps);
}

export async function spawnAllWith(topic: string, d: SpawnAllDeps): Promise<number> {
  const art = scoreArtDir(topic);
  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error(`score spawn-all: roster.txt missing at ${rosterPath} (run score init)`); return 2; }
  const rows = parseRosterFile(readFileSync(rosterPath, "utf8"));
  if (rows.length < 2) { log.error(`score spawn-all: need >=2 workers in roster.txt, got ${rows.length}`); return 2; }

  const pf = await d.preflight([topic, String(rows.length), "--roster", spawnRosterArg(rows), "--art-dir", art]);
  if (pf !== 0) { log.error(`score spawn-all: preflight failed (rc=${pf})`); return 2; }

  const panesPath = join(art, "preflight-panes.txt");
  if (!existsSync(panesPath)) { log.error(`score spawn-all: preflight wrote no ${panesPath}`); return 2; }
  const panes = parsePanesFile(readFileSync(panesPath, "utf8"));
  const orphans = rows.filter((r) => !panes.has(r.agent));
  if (orphans.length) { log.error(`score spawn-all: workers missing a preflight pane: ${orphans.map((r) => r.agent).join(", ")}`); return 2; }

  const cwd = d.repoRoot();
  const results: SpawnResult[] = await Promise.all(rows.map(async (r) => {
    const rc = await d.spawn([r.agent, r.provider, topic, "--target-pane", panes.get(r.agent)!, "--cwd", cwd, "--preflight-art-dir", art]);
    return { agent: r.agent, provider: r.provider, rc };
  }));
  atomicWrite(join(art, "spawn-results.tsv"), spawnResultsTsv(results));

  const rc = spawnTally(results.map((r) => r.rc));
  const nOk = results.filter((r) => r.rc === 0).length;
  if (rc === 0) log.ok(`score spawn-all: ${nOk}/${rows.length} workers ready`);
  else log.warn(`score spawn-all: ${nOk}/${rows.length} workers ready (rc=${rc})`);
  return rc;
}

export interface SendDeps {
  offsetFor(agent: string, model: string, topic: string): number;
  send(args: string[]): Promise<number>;
}
const liveResearchSendDeps: SendDeps = {
  offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)),
  send: sendRun,
};

async function researchSendRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: score research-send <topic> <agent> <provider>"); return 2; }
  return researchSendWith(topic, agent, provider, liveResearchSendDeps);
}

export async function researchSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = scoreArtDir(topic);
  const stateFile = join(art, `research-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`score research-send: ${stateFile} exists; rm to retry`); return 1; }

  const topicText = readIf(join(art, "topic.txt")).trim();
  if (!topicText) { log.error(`score research-send: topic.txt missing/empty at ${art} (run score init)`); return 1; }

  const findingsPath = join(workerDir(agent, provider, topic), "findings.md");
  const promptFile = join(art, `${agent}_research_prompt.md`);
  atomicWrite(promptFile, skillHintAppend(join(art, "skill.txt"), composeResearchPrompt(topicText, findingsPath)));

  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);

  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`score research-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`score research-send: ${agent} offset=${offset}`);
  return 0;
}

export interface WaitDeps {
  wait(agent: string, model: string, topic: string, offset: number, events: string[], timeoutSec: number): Promise<OutboxEvent | null>;
  multiplier(provider: string): string;
}
const liveResearchWaitDeps: WaitDeps = {
  wait: (i, m, t, off, ev, to) => outboxWaitSince(i, m, t, off, ev, to),
  multiplier: agentTimeoutMultiplier,
};

async function researchWaitRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: score research-wait <topic> <agent> <provider>"); return 2; }
  return researchWaitWith(topic, agent, provider, liveResearchWaitDeps);
}

export async function researchWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  const art = scoreArtDir(topic);
  const stateFile = join(art, `research-${agent}.txt`);
  if (!existsSync(stateFile)) { log.error(`score research-wait: ${stateFile} missing (run score research-send first)`); return 1; }
  const offset = parseLatestOffset(readFileSync(stateFile, "utf8"));
  if (offset === null) { log.error(`score research-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("research"), d.multiplier(provider));
  log.info(`score research-wait: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, ["done", "error", "question"], timeout);

  const findingsPath = join(workerDir(agent, provider, topic), "findings.md");
  const findingsText = readIfExistsOrNull(findingsPath);
  const fs = researchState(ev, findingsText);

  if (fs === "question" && ev) {
    atomicWrite(join(art, `question-${agent}.txt`), JSON.stringify(ev) + "\n");
    const bumped = outboxOffset(outboxPath(agent, provider, topic));
    appendFileSync(stateFile, `OFFSET=${bumped}\nFS=question\n`);
  } else {
    appendFileSync(stateFile, `FS=${fs}\n`);
  }
  writeFileSync(join(art, `research-${agent}.done`), "");
  log.ok(`score research-wait: ${agent} FS=${fs}`);
  return 0;
}

export async function diffRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score diff <topic>"); return 2; }
  const art = scoreArtDir(topic);
  if (!existsSync(art)) { log.error(`score diff: ${art} not found`); return 1; }
  if (existsSync(join(art, "diff.md"))) { log.error("score diff: diff.md exists; rm to retry"); return 1; }

  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error("score diff: roster.txt missing — run score init first"); return 1; }
  const rows = parseRosterFile(readFileSync(rosterPath, "utf8"));
  if (rows.length < 2) { log.error(`score diff: need >=2 workers in roster.txt, got ${rows.length}`); return 1; }

  const workers: DiffPart[] = [];
  for (const r of rows) {
    const f = join(workerDir(r.agent, r.provider, topic), "findings.md");
    if (!existsSync(f)) { log.error(`score diff: ${r.agent} findings.md missing: ${f}`); return 1; }
    workers.push({ name: r.agent, findings: readFileSync(f, "utf8") });
  }

  const result = diffFindings(workers);
  for (const file of result.files) atomicWrite(join(art, file.filename), file.content);
  atomicWrite(join(art, "diff.md"), result.diffMd);

  const summary = result.files
    .filter((f) => f.filename.endsWith("_only_items.txt") || f.filename === "consensus.txt")
    .map((f) => `${f.filename.replace(/\.txt$/, "")}=${f.content.split("\n").filter(Boolean).length}`)
    .join(" ");
  log.ok(`score diff: wrote ${join(art, "diff.md")} (${rows.length} workers) ${summary}`);
  return 0;
}

// ---- Phase D: cross-verify -> adjudicate -> synthesize ----

async function verifySendRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: score verify-send <topic> <agent> <provider>"); return 2; }
  return verifySendWith(topic, agent, provider, liveResearchSendDeps);
}

export async function verifySendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = scoreArtDir(topic);
  if (!existsSync(art)) { log.error(`score verify-send: ${art} not found`); return 1; }
  const stateFile = join(art, `verify-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`score verify-send: ${stateFile} exists; rm to retry`); return 1; }

  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error("score verify-send: roster.txt missing — run score init first"); return 1; }
  const agents = parseRosterFile(readFileSync(rosterPath, "utf8")).map((r) => r.agent);
  if (agents.length < 2) { log.error(`score verify-send: need >=2 workers, got ${agents.length}`); return 1; }
  if (!agents.includes(agent)) { log.error(`score verify-send: ${agent} not in roster.txt`); return 1; }

  const workers: string[] = [];
  for (const f of verifyScopeFiles(agent, agents)) {
    const p = join(art, f);
    if (!existsSync(p)) { log.error(`score verify-send: expected bucket missing: ${p} (run score diff first)`); return 1; }
    const c = readFileSync(p, "utf8");
    if (c.split("\n").some((l) => l.length > 0)) workers.push(c.replace(/\n+$/, ""));
  }
  const items = workers.join("\n");
  atomicWrite(join(art, `verify-claims-${agent}.txt`), items ? items + "\n" : "");

  if (!items) { atomicWrite(stateFile, "VS=skipped\n"); log.ok(`score verify-send: ${agent} VS=skipped (no claims to verify)`); return 0; }

  const verifyPath = join(workerDir(agent, provider, topic), "verify.md");
  const promptFile = join(art, `${agent}_verify_prompt.md`);
  atomicWrite(promptFile, skillHintAppend(join(art, "skill.txt"), composeVerifyPrompt(items, verifyPath)));

  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`score verify-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`score verify-send: ${agent} offset=${offset}`);
  return 0;
}

async function verifyWaitRun(rest: string[]): Promise<number> {
  const [topic, agent, provider] = rest;
  if (!topic || !agent || !provider) { log.error("usage: score verify-wait <topic> <agent> <provider>"); return 2; }
  return verifyWaitWith(topic, agent, provider, liveResearchWaitDeps);
}

export async function verifyWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  const art = scoreArtDir(topic);
  const stateFile = join(art, `verify-${agent}.txt`);
  if (!existsSync(stateFile)) { log.error(`score verify-wait: ${stateFile} missing (run score verify-send first)`); return 1; }
  const text = readFileSync(stateFile, "utf8");

  if (lastTag(text, "VS") === "skipped") { // empty-scope short-circuit
    writeFileSync(join(art, `verify-${agent}.done`), "");
    log.ok(`score verify-wait: ${agent} VS=skipped (already)`);
    return 0;
  }
  const offset = parseLatestOffset(text);
  if (offset === null) { log.error(`score verify-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("verify"), d.multiplier(provider));
  log.info(`score verify-wait: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, ["done", "error", "question"], timeout);

  const verifyPath = join(workerDir(agent, provider, topic), "verify.md");
  const verifyText = readIfExistsOrNull(verifyPath);
  const vs = verifyState(ev, verifyText);

  if (vs === "question" && ev) {
    atomicWrite(join(art, `question-${agent}.txt`), JSON.stringify(ev) + "\n");
    const bumped = outboxOffset(outboxPath(agent, provider, topic));
    appendFileSync(stateFile, `OFFSET=${bumped}\nVS=question\n`);
  } else {
    appendFileSync(stateFile, `VS=${vs}\n`);
  }
  writeFileSync(join(art, `verify-${agent}.done`), "");
  log.ok(`score verify-wait: ${agent} VS=${vs}`);
  return 0;
}

export async function adjudicateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score adjudicate <topic>"); return 2; }
  const art = scoreArtDir(topic);
  if (!existsSync(art)) { log.error(`score adjudicate: ${art} not found`); return 1; }
  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error("score adjudicate: roster.txt missing"); return 1; }
  const rows = parseRosterFile(readFileSync(rosterPath, "utf8"));
  if (rows.length < 2) { log.error(`score adjudicate: need >=2 workers, got ${rows.length}`); return 1; }

  const agents = rows.map((r) => r.agent);
  const verify: Record<string, string> = {};
  const vs: Record<string, string> = {};
  for (const r of rows) {
    verify[r.agent] = readIf(join(workerDir(r.agent, r.provider, topic), "verify.md"));
    vs[r.agent] = lastTag(readIf(join(art, `verify-${r.agent}.txt`)), "VS") ?? "skipped";
  }
  const buckets: Record<string, string> = {};
  const addBucket = (f: string): void => { buckets[f] = readIf(join(art, f)); };
  for (const c of agents) addBucket(`${c}_only_items.txt`);
  if (agents.length >= 3) {
    addBucket("consensus.txt");
    for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) addBucket(`${agents[i]}+${agents[j]}_only.txt`);
  }

  const input: AdjudicateInput = { workers: rows.map((r) => ({ agent: r.agent, provider: r.provider })), verify, vs, buckets };
  atomicWrite(join(art, "adjudicated-draft.md"), adjudicate(input));
  log.ok(`score adjudicate: wrote ${join(art, "adjudicated-draft.md")}`);
  log.info("  cp adjudicated-draft.md -> adjudicated.md, then resolve every '- PENDING:' line");
  return 0;
}

export async function synthesizeRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score synthesize <topic>"); return 2; }
  const art = scoreArtDir(topic);
  const adj = join(art, "adjudicated.md");
  if (!existsSync(adj)) { log.error(`score synthesize: ${adj} missing — cp adjudicated-draft.md -> adjudicated.md and resolve PENDINGs first`); return 1; }
  const adjText = readFileSync(adj, "utf8");
  if (/^- PENDING:/m.test(adjText)) { log.error("score synthesize: adjudicated.md still has '- PENDING:' lines; resolve them first"); return 1; }

  const draftDir = scoreDraftDir(topic);
  mkdirSync(draftDir, { recursive: true });
  const seeds = synthesizeSeeds(adjText);
  for (const s of seeds) atomicWrite(join(draftDir, `${s.section}.md`), s.body);
  log.ok(`score synthesize: wrote ${seeds.length} seed drafts to ${draftDir}`);
  return 0;
}

export async function walkStateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score walk-state <topic>"); return 2; }
  const states = walkSectionState(scoreDraftDir(topic), { withStatus: true });
  for (const s of states) process.stdout.write(`${s.name}\t${s.status}\n`);
  return 0;
}

export async function waitGateRun(rest: string[]): Promise<number> {
  const [topic, phase] = rest;
  if (!topic || !phase) { log.error("usage: score wait-gate <topic> <research|verify>"); return 2; }
  if (phase !== "research" && phase !== "verify") { log.error(`score wait-gate: phase must be research|verify (got ${phase})`); return 2; }
  const art = scoreArtDir(topic);
  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error(`score wait-gate: roster.txt missing at ${art}`); return 2; }
  const rows = parseRosterFile(readFileSync(rosterPath, "utf8"));
  if (rows.length === 0) { log.error("score wait-gate: roster.txt has no workers"); return 2; }
  const key = phase === "research" ? "FS" : "VS";
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

// ---- Phase F: drilldown (optional, workers still live) ----

interface DrilldownDeps extends SendDeps, WaitDeps {}
interface DrilldownTestHooks { writeProbe?: (outPath: string) => void; }
// Default to the research turn timeout (the bash predecessor's findings_timeout_s, ~600s) — a real
// drill turn (read the doc + write cited notes) routinely exceeds 90s; env-overridable. The wait
// returns as soon as done/error appears, so a generous ceiling only bounds the hang case.
const DRILLDOWN_TIMEOUT = (): number => Number(process.env.AP_DRILLDOWN_TIMEOUT_S) || consultTimeout("research");

async function drilldownRun(rest: string[]): Promise<number> {
  return drilldownWith(rest, { ...liveResearchSendDeps, ...liveResearchWaitDeps }, {});
}

export async function drilldownWith(rest: string[], d: DrilldownDeps, hooks: DrilldownTestHooks): Promise<number> {
  // positional: topic section ddDir focus designDoc i1 m1 [i2 m2]
  const n = rest.length;
  if (![7, 9].includes(n)) { log.error("usage: score drilldown <topic> <section> <dd-dir> <focus> <design-doc> <i1> <m1> [<i2> <m2>]"); return 2; }
  const [topic, section, ddDir, focus, designDoc, i1, m1] = rest;
  const [i2, m2] = n >= 9 ? [rest[7], rest[8]] : ["", ""];
  if (!existsSync(ddDir)) { log.error(`score drilldown: dd-dir not found: ${ddDir}`); return 2; }
  if (!existsSync(designDoc)) { log.error(`score drilldown: design-doc not found: ${designDoc}`); return 2; }

  const scratch = join(ddDir, "_scratch");
  mkdirSync(scratch, { recursive: true });
  const workers = [{ inst: i1, model: m1 }, ...(i2 ? [{ inst: i2, model: m2 }] : [])];

  // Resolve all out-paths BEFORE dispatch so parallel workers (distinct by agent in the filename)
  // never target the same file.
  const jobs = workers.map((p) => ({ ...p, outPath: resolveDrilldownPath(scratch, section, p.inst) }));
  const timeout = (provider: string): number => scaledTimeout(DRILLDOWN_TIMEOUT(), d.multiplier(provider));

  const results = await Promise.all(jobs.map(async (j) => {
    const promptFile = join(scratch, `.${j.inst}-drill-prompt.md`);
    atomicWrite(promptFile, composeDrilldownPrompt({ section, designDocPath: designDoc, focus, outPath: j.outPath }));
    const offset = d.offsetFor(j.inst, j.model, topic);          // BEFORE send
    const rc = await d.send(["--from", "hub", j.inst, topic, `@${promptFile}`]);
    if (rc !== 0) return "missing" as const;
    hooks.writeProbe?.(j.outPath);                                // test-only: simulate the worker's write
    const ev = await d.wait(j.inst, j.model, topic, offset, ["done", "error"], timeout(j.model));
    const fileText = readIfExistsOrNull(j.outPath);
    return drilldownState(ev, fileText);
  }));

  const ok = results.filter((r) => r === "ok").length;
  log.ok(`score drilldown: ${ok}/${jobs.length} workers produced notes`);
  return ok > 0 ? 0 : 1;
}

// ---- Phase F: offset-reset (clean-retry primitive) ----

export async function offsetResetRun(rest: string[]): Promise<number> {
  const keepFindings = rest.includes("--keep-findings");
  const pos = rest.filter((t) => !t.startsWith("--"));
  const [topic, agent, phase] = pos;
  if (!topic || !agent || !phase) { log.error("usage: score offset-reset <topic> <agent> <phase> [--keep-findings]"); return 2; }
  if (phase !== "research" && phase !== "verify") { log.error(`score offset-reset: phase must be research|verify (got ${phase})`); return 2; }
  const art = scoreArtDir(topic);
  if (!existsSync(art)) { log.error(`score offset-reset: art dir missing: ${art}`); return 1; }

  for (const f of [`${phase}-${agent}.txt`, `${phase}-${agent}.done`, `question-${agent}.txt`])
    rmSync(join(art, f), { force: true });

  const c = cascadeTargets(phase as ResetPhase, keepFindings);
  if (!keepFindings) {
    const td = topicDir(topic);
    if (existsSync(td)) for (const name of readdirSync(td))
      if (name.startsWith(`${agent}-`)) rmSync(join(td, name, c.workerFile), { force: true });
    for (const f of c.artFiles) rmSync(join(art, f), { force: true });
    const names = readdirSync(art);
    for (const g of c.artGlobs) { const re = new RegExp("^" + g.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$"); for (const n of names) if (re.test(n)) rmSync(join(art, n), { force: true }); }
  }
  log.ok(`score offset-reset: ${phase}/${agent}${keepFindings ? " (kept findings)" : ""}`);
  return 0;
}

// ---- Phase F: forensics + archive (thin wind-down verbs) ----

export async function forensicsRun(rest: string[]): Promise<number> {
  return runForensics("score", scoreArtDir, rest[0]);
}

export async function archiveRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score archive <topic>"); return 2; }
  archiveTopic(topic, "score");
  log.ok(`score archive: archived _score for ${topic}`);
  return 0;
}
