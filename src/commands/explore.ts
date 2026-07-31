// src/commands/explore.ts — /ap:explore CLI verbs (port of meditate). Built on design's DI
// pattern + IPC/wait/archive helpers; meditate-specific logic lives in src/core/explore*.ts.
import { existsSync, mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc, archiveTopic } from "../core/archive.js";
import { exploreArtDir, deriveSlug, finalLandscapePath, missingListArtifacts } from "../core/explore.js";
import { extractHandoffData } from "../core/exploreHandoff.js";
import { runForensics, runFlag } from "../core/forensics.js";
import { artifactBackstop } from "../core/artifact.js";
import { killNow } from "../core/tmux.js";
import {
  type ListRow, formatListFile, parseListFile, parsePanesFile, spawnAllBatch, lastTag, verifyScopeFiles,
} from "../core/roster.js";
import { readProviderList } from "../core/providers.js";
import { activeProvidersPath, repoRoot } from "../core/paths.js";
import { pickAgents } from "../core/agents.js";
import { agentConsultValidated } from "../core/contracts.js";
import { classifyTopic } from "../core/exploreLit.js";
import { computeSignals, renderSkipRecord, sectionText, type Decision } from "../core/exploreConfidence.js";
import { buildAnnotations, soloTokensFromAnnotations } from "../core/exploreAnnotate.js";
import { composeVerifyPrompt } from "../core/designTurn.js";
import {
  PHASES, dispatchPrompt, phaseWait, waitGateVerb, guardSkipped, skipDispatch, triad,
  liveSendDeps, liveWaitDeps, type SendDeps, type WaitDeps, type PhaseKey,
} from "../core/phaseTable.js";
import { composeExploreResearchPrompt, composeAdversaryPrompt, composeGapPrompt, composeSignoffPrompt, litGuidance, ADVERSARY_LENSES, researchLens } from "../core/exploreTurn.js";
import { run as spawnRun } from "./spawn.js";
import { run as preflightRun } from "./preflight.js";
import { readIfExists as readIf, readIfExistsOrNull } from "../core/fsread.js";
import { parseOpenQuestions, assignOpenQuestions, formatOpenqClaims, parseOpenqClaims, composeOpenqPrompt } from "../core/exploreOpenq.js";
import { parseAdversaryVerdict, tallyVerdicts } from "../core/exploreVerdict.js";
import { diffFindings, type DiffPart, type Claim } from "../core/designDiff.js";
import { parseBucketLines, selectRebuttalTargets, composeRebuttalPrompt, type CritiqueInput } from "../core/exploreRebuttal.js";
import { parseSelfAssessment } from "../core/exploreSelfAssess.js";
import { buildContribution, renderContributionTsv, type ContributionArtifacts } from "../core/exploreContribution.js";

function usage(): number {
  log.error("usage: explore <init|classify|spawn-all|research-send|research-wait|survivors|openq-collate|openq-send|openq-wait|diff|crossverify-send|crossverify-wait|wait-gate|synth-preliminary|" +
    "confidence|annotate|adversary-send|adversary-wait|rebuttal-send|rebuttal-wait|gap-send|gap-wait|signoff-send|signoff-wait|synth-final|verdict-tally|contribution|forensics|teardown|handoff-extract> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest, { valueFlags: new Set<string>() }));
    case "classify": return classifyRun(rest);
    case "spawn-all": return spawnAllRun(rest);
    case "research-send": return triad("explore research-send", researchSendWith, liveSendDeps)(rest);
    case "research-wait": return triad("explore research-wait", researchWaitWith, liveWaitDeps)(rest);
    case "survivors": return survivorsRun(rest);
    case "openq-collate": return openqCollateRun(rest);
    case "openq-send": return triad("explore openq-send", openqSendWith, liveSendDeps)(rest);
    case "openq-wait": return triad("explore openq-wait", openqWaitWith, liveWaitDeps)(rest);
    case "diff": return diffExploreRun(rest);
    case "crossverify-send": return triad("explore crossverify-send", crossverifySendWith, liveSendDeps)(rest);
    case "crossverify-wait": return triad("explore crossverify-wait", crossverifyWaitWith, liveWaitDeps)(rest);
    case "rebuttal-send": return triad("explore rebuttal-send", rebuttalSendWith, liveSendDeps)(rest);
    case "rebuttal-wait": return triad("explore rebuttal-wait", rebuttalWaitWith, liveWaitDeps)(rest);
    case "gap-send": return triad("explore gap-send", gapSendWith, liveSendDeps)(rest);
    case "gap-wait": return triad("explore gap-wait", gapWaitWith, liveWaitDeps)(rest);
    case "signoff-send": return triad("explore signoff-send", signoffSendWith, liveSendDeps)(rest);
    case "signoff-wait": return triad("explore signoff-wait", signoffWaitWith, liveWaitDeps)(rest);
    case "contribution": return contributionRun(rest);
    case "wait-gate": return exploreWaitGateRun(rest);
    case "synth-preliminary": return synthPreliminaryRun(rest);
    case "confidence": return confidenceRun(rest);
    case "annotate": return annotateRun(rest);
    case "adversary-send": return triad("explore adversary-send", adversarySendWith, liveSendDeps)(rest);
    case "adversary-wait": return triad("explore adversary-wait", adversaryWaitWith, liveWaitDeps)(rest);
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

// ---- the phase table: every send/wait skeleton below is a thin wrapper over core/phaseTable.ts ----
// Destructured in pipeline order — the order is the contract the guard chains are transcribed from.
const [RESEARCH, OPENQ, CROSSVERIFY, ADVERSARY, REBUTTAL, GAP, SIGNOFF] = PHASES;

// ---- research-send / research-wait ----
export async function researchSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `research-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore research-send: ${stateFile} exists; rm to retry`); return 1; }
  const topicText = readIf(join(art, "topic.txt")).trim();
  if (!topicText) { log.error(`explore research-send: topic.txt missing/empty at ${art} (run explore init)`); return 1; }

  const track = readIf(join(art, "lit-track.txt")).startsWith("ON") ? "ON" : "OFF";
  const findingsPath = join(art, `findings-${agent}.md`); // art-dir-flat (faithful to meditate)
  const promptFile = join(art, `${agent}_research_prompt.md`);
  atomicWrite(promptFile, composeExploreResearchPrompt(topicText, findingsPath, litGuidance(track), researchLens(provider), join(art, `selfassess-${agent}.md`)));
  return dispatchPrompt(RESEARCH, { topic, agent, provider, stateFile, promptFile }, d);
}

export async function researchWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  return phaseWait(RESEARCH, topic, agent, provider, d);
}

// ---- openq-collate / openq-send / openq-wait (Phase 4b open-questions peer relay) ----
export async function openqCollateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore openq-collate <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore openq-collate: ${art} not found — run explore init`); return 1; }
  const rows = parseListFile(readIf(join(art, "list.txt")));
  if (rows.length === 0) { log.error(`explore openq-collate: list.txt missing or empty at ${art}`); return 1; }

  // Findings pre-read: same sentinel backstop as survivors. A still-writing file refuses the whole
  // collate (rc 1 — re-run the wait-gate and retry) rather than routing half of a worker's open
  // questions; a dropped worker contributes none. An absent/empty findings file is the pre-existing
  // "no questions" path and never reaches the backstop.
  const questionsByAgent = new Map<string, string[]>();
  for (const r of rows) {
    const findings = join(art, `findings-${r.agent}.md`);
    const text = readIf(findings);
    const verdict = text.trim() ? artifactBackstop({
      label: "explore openq-collate", command: "explore", topic, art, agent: r.agent,
      artifact: findings, text,
      stateText: readIf(join(art, `research-${r.agent}.txt`)), key: "FS",
    }) : "complete";
    if (verdict === "still-writing") return 1;
    questionsByAgent.set(r.agent, parseOpenQuestions(verdict === "drop" ? "" : text));
  }

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

export async function openqSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `openq-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore openq-send: ${stateFile} exists; rm to retry`); return 1; }

  if (guardSkipped(OPENQ, art, agent, stateFile)) return 0; // timeout-dispatch guard first
  const claims = parseOpenqClaims(readIf(join(art, `openq-claims-${agent}.txt`)));
  if (claims.length === 0) return skipDispatch(OPENQ, agent, stateFile, "no questions routed to it");

  const answersPath = join(art, `openq-${agent}.md`);
  const promptFile = join(art, `${agent}_openq_prompt.md`);
  atomicWrite(promptFile, composeOpenqPrompt(claims, answersPath));
  return dispatchPrompt(OPENQ, { topic, agent, provider, stateFile, promptFile }, d);
}

export async function openqWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  return phaseWait(OPENQ, topic, agent, provider, d);
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
    // Sentinel backstop, design diff's shape: a still-writing findings file refuses the whole diff
    // (the hub runs research-wait and retries); one the wait never accepted buckets as EMPTY —
    // bucketing half a worker's Approaches would mis-scope every later phase. The bytes judged are
    // the bytes bucketed (one read, passed in) — a `mv` landing between the two would otherwise
    // bucket exactly the half-written file the check just cleared.
    const text = readFileSync(f, "utf8");
    const verdict = artifactBackstop({
      label: "explore diff", command: "explore", topic, art, agent: r.agent, artifact: f, text,
      stateText: readIf(join(art, `research-${r.agent}.txt`)), key: "FS",
    });
    if (verdict === "still-writing") return 1;
    workers.push({ name: r.agent, findings: verdict === "drop" ? "" : text });
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
export async function crossverifySendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `crossverify-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore crossverify-send: ${stateFile} exists; rm to retry`); return 1; }

  if (guardSkipped(CROSSVERIFY, art, agent, stateFile)) return 0; // timeout-dispatch guard first

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
  if (!items) return skipDispatch(CROSSVERIFY, agent, stateFile, "no peer claims to verify");

  const outPath = join(art, `crossverify-${agent}.md`);
  const promptFile = join(art, `${agent}_crossverify_prompt.md`);
  atomicWrite(promptFile, composeVerifyPrompt(items, outPath));
  return dispatchPrompt(CROSSVERIFY, { topic, agent, provider, stateFile, promptFile }, d);
}

export async function crossverifyWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  return phaseWait(CROSSVERIFY, topic, agent, provider, d);
}

// ---- rebuttal-send / rebuttal-wait (Phase 7b bounded defend-or-concede) ----
export async function rebuttalSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `rebuttal-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore rebuttal-send: ${stateFile} exists — one rebuttal round per worker (the one-turn cap)`); return 1; }

  if (guardSkipped(REBUTTAL, art, agent, stateFile)) return 0; // latest-phase guard (AS -> VS -> QS -> FS)

  const rows = parseListFile(readIf(join(art, "list.txt")));
  if (!rows.some((r) => r.agent === agent)) { log.error(`explore rebuttal-send: ${agent} not in list.txt at ${art}`); return 1; }

  const buckets = new Map<string, Claim[]>();
  for (const r of rows) buckets.set(r.agent, parseBucketLines(readIf(join(art, `${r.agent}_only_items.txt`))));

  // Same backstop as the findings consumers, over the OTHER artifact this phase reads: rebuttal
  // targets are selected FROM the critiques, so a half-written adversary-<peer>.md silently narrows
  // what this worker is asked to defend. A critique the wait never accepted contributes nothing.
  const critiques: CritiqueInput[] = [];
  for (const r of rows) {
    const stateText = readIf(join(art, `adversary-${r.agent}.txt`));
    if (lastTag(stateText, "AS") === "skipped") continue;
    const critique = join(art, `adversary-${r.agent}.md`);
    const text = readIf(critique);
    if (!text.trim()) continue;
    const verdict = artifactBackstop({
      label: "explore rebuttal-send", command: "explore", topic, art, agent: r.agent,
      artifact: critique, text, stateText, key: "AS",
    });
    if (verdict === "still-writing") return 1;
    if (verdict === "complete") critiques.push({ agent: r.agent, text });
  }

  const mine = selectRebuttalTargets(critiques, buckets).get(agent);
  if (!mine || mine.findings.length === 0) {
    return skipDispatch(REBUTTAL, agent, stateFile, "no needs-attention findings attributed to it");
  }

  const outPath = join(art, `rebuttal-${agent}.md`);
  const promptFile = join(art, `${agent}_rebuttal_prompt.md`);
  atomicWrite(promptFile, composeRebuttalPrompt(mine.claims, mine.findings, outPath));
  return dispatchPrompt(REBUTTAL, { topic, agent, provider, stateFile, promptFile }, d);
}

export async function rebuttalWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  return phaseWait(REBUTTAL, topic, agent, provider, d);
}

// ---- gap-send / gap-wait (Phase 7c post-gate gap enrichment; trigger = recorded S1/S2 false) ----
export async function gapSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `gap-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore gap-send: ${stateFile} exists; rm to retry`); return 1; }

  // Trigger: the Phase 5.5 record's signals_passed line — S1=false or S2=false fires the round.
  // The record is READ ONLY here; the gate ran once and adversary-skip.txt is never rewritten.
  const signalsLine = readIf(join(art, "adversary-skip.txt")).split("\n").find((l) => l.startsWith("signals_passed:")) ?? "";
  if (!/\bS1=false\b/.test(signalsLine) && !/\bS2=false\b/.test(signalsLine)) {
    return skipDispatch(GAP, agent, stateFile, "no recorded S1/S2 failure — trigger not fired");
  }

  if (guardSkipped(GAP, art, agent, stateFile)) return 0; // latest-phase guard (RS -> AS -> VS -> QS -> FS)

  const agents = parseListFile(readIf(join(art, "list.txt"))).map((r) => r.agent);
  if (!agents.includes(agent)) { log.error(`explore gap-send: ${agent} not in list.txt at ${art}`); return 1; }

  const items: string[] = [];
  for (const f of verifyScopeFiles(agent, agents)) {
    for (const l of readIf(join(art, f)).split("\n")) if (l.length > 0) items.push(l);
  }
  if (items.length === 0) return skipDispatch(GAP, agent, stateFile, "no peer-only items to enrich");

  const outPath = join(art, `gap-${agent}.md`);
  const promptFile = join(art, `${agent}_gap_prompt.md`);
  atomicWrite(promptFile, composeGapPrompt(items, outPath));
  return dispatchPrompt(GAP, { topic, agent, provider, stateFile, promptFile }, d);
}

export async function gapWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  return phaseWait(GAP, topic, agent, provider, d);
}

// ---- signoff-send / signoff-wait (Phase 8b bounded final-doc fairness check) ----
export async function signoffSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const stateFile = join(art, `signoff-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore signoff-send: ${stateFile} exists — one sign-off turn per worker (the one-turn cap)`); return 1; }

  if (guardSkipped(SIGNOFF, art, agent, stateFile)) return 0; // latest-phase guard (GS -> RS -> AS -> VS -> QS -> FS)

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
  return dispatchPrompt(SIGNOFF, { topic, agent, provider, stateFile, promptFile }, d);
}

export async function signoffWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  return phaseWait(SIGNOFF, topic, agent, provider, d);
}

// ---- contribution (Phase 8a read-only per-provider scoreboard; archived, never gates) ----
export async function contributionRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore contribution <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore contribution: ${art} not found — run explore init`); return 1; }
  // Roster = the ORIGINAL list when survivors rewrote it — dropped workers appear with their real
  // (usually zero) counts instead of vanishing from the record.
  const listRaw = readIf(join(art, "list-original.txt")) || readIf(join(art, "list.txt"));
  const rows = parseListFile(listRaw);
  if (rows.length === 0) { log.error(`explore contribution: list.txt missing or empty at ${art}`); return 1; }

  const artifacts: Record<string, ContributionArtifacts> = {};
  const crossverify: Record<string, string> = {};
  for (const r of rows) {
    artifacts[r.agent] = {
      findings: readIf(join(art, `findings-${r.agent}.md`)),
      soloBucket: readIf(join(art, `${r.agent}_only_items.txt`)),
      adversary: readIf(join(art, `adversary-${r.agent}.md`)),
      adversaryTag: lastTag(readIf(join(art, `adversary-${r.agent}.txt`)), "AS"),
      rebuttal: readIf(join(art, `rebuttal-${r.agent}.md`)),
      signoff: readIf(join(art, `signoff-${r.agent}.md`)),
      signoffTag: lastTag(readIf(join(art, `signoff-${r.agent}.txt`)), "SS"),
    };
    crossverify[r.agent] = readIf(join(art, `crossverify-${r.agent}.md`));
  }
  const tsv = renderContributionTsv(buildContribution({ rows, artifacts, crossverify }));
  atomicWrite(join(art, "contribution.tsv"), tsv);
  process.stdout.write(tsv);
  log.ok(`explore contribution: wrote ${join(art, "contribution.tsv")} (${rows.length} rows)`);
  return 0;
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
  // Sentinel backstop over the findings that ARE present: a file still being written cannot enter
  // the survivor set (refuse, the hub runs research-wait), and one the wait held open until grace
  // expired is dropped as empty through the machinery below.
  let stillWriting = false;
  for (const r of rows) {
    if (missing.has(`findings-${r.agent}.md`)) continue;
    const verdict = artifactBackstop({
      label: "explore survivors", command: "explore", topic, art, agent: r.agent,
      artifact: join(art, `findings-${r.agent}.md`),
      stateText: readIf(join(art, `research-${r.agent}.txt`)), key: "FS",
    });
    if (verdict === "still-writing") stillWriting = true;
    else if (verdict === "drop") missing.add(`findings-${r.agent}.md`);
  }
  if (stillWriting) return 1;
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
  // Sentinel backstop, same rule as survivors: still-writing refuses (rc 1, retry after the wait),
  // a worker whose artifact the wait never accepted joins the missing list (survivors drops it).
  let stillWriting = false;
  for (const r of rows) {
    if (missing.includes(`findings-${r.agent}.md`)) continue;
    const verdict = artifactBackstop({
      label: "explore synth-preliminary", command: "explore", topic, art, agent: r.agent,
      artifact: join(art, `findings-${r.agent}.md`),
      stateText: readIf(join(art, `research-${r.agent}.txt`)), key: "FS",
    });
    if (verdict === "still-writing") stillWriting = true;
    else if (verdict === "drop") missing.push(`findings-${r.agent}.md`);
  }
  if (stillWriting) return 1;
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
  // Each findings file is read ONCE here; the missing-list predicate IS missingListArtifacts'
  // readIf().trim() (whitespace-only counts as missing) and buildAnnotations reuses the same texts.
  const texts = new Map(rows.map((r) => [r.agent, readIf(join(art, `findings-${r.agent}.md`))]));
  const missing = rows.filter((r) => !(texts.get(r.agent) ?? "").trim()).map((r) => `findings-${r.agent}.md`);
  if (missing.length) {
    log.error("explore annotate: blocked — missing or empty findings:");
    for (const m of missing) log.error(`  - ${join(art, m)}`);
    return 1;
  }
  const findings = rows.map((r) => texts.get(r.agent) ?? "");

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
export async function adversarySendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = exploreArtDir(topic);
  const draft = readIf(join(art, "landscape-draft.md"));
  if (!draft.trim()) { log.error("explore adversary-send: landscape-draft.md missing or empty — run synth-preliminary first"); return 1; }
  const stateFile = join(art, `adversary-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`explore adversary-send: ${stateFile} exists; rm to retry`); return 1; }

  if (guardSkipped(ADVERSARY, art, agent, stateFile)) return 0; // latest phase first (VS -> QS -> FS)

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
  return dispatchPrompt(ADVERSARY, { topic, agent, provider, stateFile, promptFile }, d);
}

export async function adversaryWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  return phaseWait(ADVERSARY, topic, agent, provider, d);
}

// ---- wait-gate (composes the pure gateState over the per-phase state files) ----
export async function exploreWaitGateRun(rest: string[]): Promise<number> {
  const [topic, phase] = rest;
  const KEYS: Record<string, PhaseKey> = {
    research: "FS", openq: "QS", crossverify: "VS", adversary: "AS", rebuttal: "RS", gap: "GS", signoff: "SS",
  };
  if (!topic || !phase) { log.error("usage: explore wait-gate <topic> <research|openq|crossverify|adversary|rebuttal|gap|signoff>"); return 2; }
  const key = KEYS[phase];
  if (!key) { log.error(`explore wait-gate: phase must be research|openq|crossverify|adversary|rebuttal|gap|signoff (got ${phase})`); return 2; }
  return waitGateVerb("explore", exploreArtDir(topic), phase, key);
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
    // Sentinel backstop, synth-preliminary's shape, over the critiques the final doc quotes: a
    // still-writing critique refuses (rc 1), one the wait never accepted joins the missing list.
    let stillWriting = false;
    for (const r of active) {
      if (missing.includes(`adversary-${r.agent}.md`)) continue;
      const verdict = artifactBackstop({
        label: "explore synth-final", command: "explore", topic, art, agent: r.agent,
        artifact: join(art, `adversary-${r.agent}.md`),
        stateText: readIf(join(art, `adversary-${r.agent}.txt`)), key: "AS",
      });
      if (verdict === "still-writing") stillWriting = true;
      else if (verdict === "drop") missing.push(`adversary-${r.agent}.md`);
    }
    if (stillWriting) return 1;
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
  // Sentinel backstop over each critique before its `## Verdict` line is tallied: a half-written
  // critique parses as `unavailable` and quietly shifts the run's consensus. Refuse instead (rc 1);
  // a critique the wait never accepted tallies as if empty, which IS `unavailable`, but recorded.
  const verdictRows: Array<{ agent: string; verdict: string }> = [];
  for (const r of rows) {
    const stateText = readIf(join(art, `adversary-${r.agent}.txt`));
    if (lastTag(stateText, "AS") === "skipped") { verdictRows.push({ agent: r.agent, verdict: "skipped" }); continue; }
    const critique = join(art, `adversary-${r.agent}.md`);
    const text = readIf(critique);
    const verdict = text.trim() ? artifactBackstop({
      label: "explore verdict-tally", command: "explore", topic, art, agent: r.agent,
      artifact: critique, text, stateText, key: "AS",
    }) : "complete";
    if (verdict === "still-writing") return 1;
    verdictRows.push({ agent: r.agent, verdict: parseAdversaryVerdict(verdict === "drop" ? "" : text) });
  }
  for (const v of verdictRows) process.stdout.write(`VERDICT=${v.agent}:${v.verdict}\n`);
  // Every worker's adversary round guarded away is a silent loss of the run's only challenge layer:
  // TALLY=unavailable reads like a parse hiccup, so say it out loud. Non-blocking by design — the
  // hub decides, the verb only refuses to let it happen quietly.
  if (verdictRows.length > 0 && verdictRows.every((v) => v.verdict === "skipped")) {
    log.warn("explore verdict-tally: all adversary rounds skipped — the landscape will ship without adversarial review; verify this is intended");
  }
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
