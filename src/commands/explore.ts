// src/commands/explore.ts — /ap:explore CLI verbs (port of meditate). Built on design's DI
// pattern + IPC/wait/archive helpers; meditate-specific logic lives in src/core/explore*.ts.
// NOTE: verbs are added task-by-task; the dispatcher's switch grows as each verb lands.
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
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
  type ListRow, formatListFile, parseListFile, parsePanesFile, spawnAllBatch, lastTag,
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
import { parseLatestOffset, scaledTimeout, researchState, verifyState, gateState, recordWaitOutcome } from "../core/designTurn.js";
import { composeExploreResearchPrompt, composeAdversaryPrompt, litGuidance, ADVERSARY_LENSES } from "../core/exploreTurn.js";
import { run as sendRun } from "./send.js";
import { run as spawnRun } from "./spawn.js";
import { run as preflightRun } from "./preflight.js";
import { readIfExists as readIf, readIfExistsOrNull } from "../core/fsread.js";
import { parseOpenQuestions, assignOpenQuestions, formatOpenqClaims } from "../core/exploreOpenq.js";

function usage(): number {
  log.error("usage: explore <init|classify|spawn-all|research-send|research-wait|openq-collate|wait-gate|synth-preliminary|" +
    "confidence|annotate|adversary-send|adversary-wait|synth-final|forensics|teardown|handoff-extract> ...");
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
    case "openq-collate": return openqCollateRun(rest);
    case "wait-gate": return exploreWaitGateRun(rest);
    case "synth-preliminary": return synthPreliminaryRun(rest);
    case "confidence": return confidenceRun(rest);
    case "annotate": return annotateRun(rest);
    case "adversary-send": return adversarySendRun(rest);
    case "adversary-wait": return adversaryWaitRun(rest);
    case "synth-final": return synthFinalRun(rest);
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
  atomicWrite(promptFile, composeExploreResearchPrompt(topicText, findingsPath, litGuidance(track)));

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

/** List rows whose `<prefix>-<agent>.md` art file is missing/empty → list of the missing filenames. */
function missingListArtifacts(art: string, rows: ListRow[], prefix: string): string[] {
  return rows.filter((r) => !readIf(join(art, `${prefix}-${r.agent}.md`)).trim()).map((r) => `${prefix}-${r.agent}.md`);
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
  if (fsTag === "timeout" || fsTag === "failed") {
    atomicWrite(stateFile, "AS=skipped\n");
    log.warn(`explore adversary-send: ${agent} skipped — research ended FS=${fsTag} (worker may still be busy; sending would clobber its inbox)`);
    return 0;
  }

  const rows = parseListFile(readIf(join(art, "list.txt")));
  const index = rows.findIndex((r) => r.agent === agent);
  if (index < 0) { log.error(`explore adversary-send: ${agent} not in list.txt at ${art}`); return 1; }
  const peerFindingsPaths = rows.filter((r) => r.agent !== agent).map((r) => join(art, `findings-${r.agent}.md`));
  const lens = ADVERSARY_LENSES[index % ADVERSARY_LENSES.length];

  const outPath = join(art, `adversary-${agent}.md`);
  const promptFile = join(art, `${agent}_adversary_prompt.md`);
  atomicWrite(promptFile, composeAdversaryPrompt(draft, agent, outPath, { peerFindingsPaths, lens }));

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
  if (!topic || !phase) { log.error("usage: explore wait-gate <topic> <research|adversary>"); return 2; }
  if (phase !== "research" && phase !== "adversary") { log.error(`explore wait-gate: phase must be research|adversary (got ${phase})`); return 2; }
  const art = exploreArtDir(topic);
  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error(`explore wait-gate: list.txt missing at ${art}`); return 2; }
  const rows = parseListFile(readFileSync(listPath, "utf8"));
  if (rows.length === 0) { log.error("explore wait-gate: list.txt has no workers"); return 2; }
  const key = phase === "research" ? "FS" : "AS";
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
