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
import { runForensics, runFlag, runReflect } from "../core/forensics.js";
import { killNow, killPreflightOrphans, livePaneNonces } from "../core/tmux.js";
import {
  type ListRow, type SpawnAllBatchDeps, formatListFile, parseListFile, spawnAllBatch, lastTag, verifyScopeFiles,
} from "../core/roster.js";
import { readProviderList } from "../core/providers.js";
import { activeProvidersPath, repoRoot } from "../core/paths.js";
import { withMainCheckout } from "../core/job.js";
import { pickAgents } from "../core/agents.js";
import { agentConsultValidated } from "../core/contracts.js";
import { classifyTopic } from "../core/exploreLit.js";
import { computeSignals, renderSkipRecord, skipRecordSaysUserSkip, sectionText, type Decision } from "../core/exploreConfidence.js";
import { buildAnnotations, soloTokensFromAnnotations } from "../core/exploreAnnotate.js";
import { composeVerifyPrompt } from "../core/designTurn.js";
import {
  PHASES, phaseSend, phaseWait, phaseStems, rowFor, waitGateVerb, surveyPhaseArtifact, diffVerb, triad,
  liveSendDeps, liveWaitDeps, type SendDeps, type WaitDeps, type PhaseRow,
} from "../core/phaseTable.js";
import { composeExploreResearchPrompt, composeAdversaryPrompt, composeGapPrompt, composeSignoffPrompt, litGuidance, ADVERSARY_LENSES, researchLens } from "../core/exploreTurn.js";
import { run as spawnRun } from "./spawn.js";
import { run as preflightRun } from "./preflight.js";
import { readIfExists as readIf, readIfExistsOrNull } from "../core/fsread.js";
import { parseOpenQuestions, assignOpenQuestions, formatOpenqClaims, parseOpenqClaims, composeOpenqPrompt } from "../core/exploreOpenq.js";
import { parseFacts, composeDrillPrompt } from "../core/exploreGrill.js";
import { parseAdversaryVerdict, tallyVerdicts } from "../core/exploreVerdict.js";
import { type Claim } from "../core/designDiff.js";
import { parseBucketLines, selectRebuttalTargets, composeRebuttalPrompt, type CritiqueInput } from "../core/exploreRebuttal.js";
import { parseSelfAssessment } from "../core/exploreSelfAssess.js";
import { buildContribution, renderContributionTsv, type ContributionArtifacts } from "../core/exploreContribution.js";

function usage(): number {
  log.error("usage: explore <init|classify|spawn-all|research-send|research-wait|survivors|openq-collate|openq-send|openq-wait|diff|crossverify-send|crossverify-wait|wait-gate|synth-preliminary|" +
    "confidence|annotate|adversary-send|adversary-wait|rebuttal-send|rebuttal-wait|gap-send|gap-wait|signoff-send|signoff-wait|drill-send|drill-wait|synth-final|verdict-tally|contribution|forensics|teardown|handoff-extract> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  // ONE state tree per run, whatever directory the hub is standing in -- see `withMainCheckout`.
  return withMainCheckout(() => dispatchVerb(args));
}

async function dispatchVerb(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest, { valueFlags: new Set<string>() }));
    case "classify": return classifyRun(rest);
    case "spawn-all": return spawnAllRun(rest);
    case "research-send": return triad("explore research-send", researchSendWith, liveSendDeps)(rest);
    case "survivors": return survivorsRun(rest);
    case "openq-collate": return openqCollateRun(rest);
    case "openq-send": return triad("explore openq-send", openqSendWith, liveSendDeps)(rest);
    case "diff": return diffExploreRun(rest);
    case "crossverify-send": return triad("explore crossverify-send", crossverifySendWith, liveSendDeps)(rest);
    case "rebuttal-send": return triad("explore rebuttal-send", rebuttalSendWith, liveSendDeps)(rest);
    case "gap-send": return triad("explore gap-send", gapSendWith, liveSendDeps)(rest);
    case "signoff-send": return triad("explore signoff-send", signoffSendWith, liveSendDeps)(rest);
    case "drill-send": return triad("explore drill-send", drillSendWith, liveSendDeps)(rest);
    case "contribution": return contributionRun(rest);
    case "wait-gate": return exploreWaitGateRun(rest);
    case "synth-preliminary": return synthPreliminaryRun(rest);
    case "confidence": return confidenceRun(rest);
    case "annotate": return annotateRun(rest);
    case "adversary-send": return triad("explore adversary-send", adversarySendWith, liveSendDeps)(rest);
    case "synth-final": return synthFinalRun(rest);
    case "verdict-tally": return verdictTallyRun(rest);
    case "forensics": return forensicsRun(rest);
    case "flag": return runFlag("explore", rest[0], rest.slice(1).join(" "));
    case "reflect": return runReflect("explore", rest[0], rest[1]);
    case "teardown": return teardownRun(rest);
    case "handoff-extract": return handoffExtractRun(rest);
    default: {
      // The `-wait` half is the table's: every phase's wait is one bound phaseWait, so a new PHASES
      // row needs no case here (the `-send` bodies below are what genuinely differ per phase).
      const row = verb?.endsWith("-wait") ? rowFor("explore", verb.slice(0, -"-wait".length)) : null;
      if (!row) return usage();
      return triad<WaitDeps>(`explore ${row.phase}-wait`, (t, a, p, d) => phaseWait(row, t, a, p, d), liveWaitDeps)(rest);
    }
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
export type ExploreSpawnAllDeps = SpawnAllBatchDeps;
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
const [RESEARCH, OPENQ, CROSSVERIFY, ADVERSARY, REBUTTAL, GAP, SIGNOFF, DRILL] = PHASES;

// ---- research-send / research-wait ----
export async function researchSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  return phaseSend(RESEARCH, { topic, agent, provider }, d, {
    prepare: ({ art, artifact }) => {
      const topicText = readIf(join(art, "topic.txt")).trim();
      if (!topicText) { log.error(`explore research-send: topic.txt missing/empty at ${art} (run explore init)`); return { fail: 1 }; }
      const track = readIf(join(art, "lit-track.txt")).startsWith("ON") ? "ON" : "OFF";
      // Phase 0.5's frame record when the user answered the framing round; absent (the common case
      // and every pre-0.5.61 run) leaves the prompt byte-identical.
      const frame = readIf(join(art, "frame.md"));
      return { prompt: composeExploreResearchPrompt(topicText, artifact, litGuidance(track), researchLens(provider), join(art, `selfassess-${agent}.md`), frame) };
    },
  });
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
    const { text, verdict } = surveyPhaseArtifact(RESEARCH, r, {
      topic, label: "explore openq-collate", emptyIsComplete: true,
    });
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
  return phaseSend(OPENQ, { topic, agent, provider }, d, {
    prepare: ({ art, artifact }) => {
      const claims = parseOpenqClaims(readIf(join(art, `openq-claims-${agent}.txt`)));
      if (claims.length === 0) return { skip: "no questions routed to it" };
      return { prompt: composeOpenqPrompt(claims, artifact) };
    },
  });
}

// ---- diff (Approaches-schema buckets; foundation for crossverify/rebuttal/gap rounds) ----
export async function diffExploreRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore diff <topic>"); return 2; }
  // Approaches, not Claims: bucketing half a worker's Approaches would mis-scope every later phase.
  return diffVerb(RESEARCH, topic, {
    headings: ["Approaches"], notFoundHint: " — run explore init", artifactNoun: "findings",
  });
}

// ---- crossverify-send / crossverify-wait (Phase 4c peer cross-verification) ----
export async function crossverifySendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  return phaseSend(CROSSVERIFY, { topic, agent, provider }, d, {
    prepare: ({ art, artifact }) => {
      const agents = parseListFile(readIf(join(art, "list.txt"))).map((r) => r.agent);
      if (agents.length < 2) { log.error(`explore crossverify-send: need >=2 workers in list.txt, got ${agents.length}`); return { fail: 1 }; }
      if (!agents.includes(agent)) { log.error(`explore crossverify-send: ${agent} not in list.txt`); return { fail: 1 }; }

      const parts: string[] = [];
      for (const f of verifyScopeFiles(agent, agents)) {
        const p = join(art, f);
        if (!existsSync(p)) { log.error(`explore crossverify-send: expected bucket missing: ${p} (run explore diff first)`); return { fail: 1 }; }
        const c = readFileSync(p, "utf8");
        if (c.split("\n").some((l) => l.length > 0)) parts.push(c.replace(/\n+$/, ""));
      }
      const items = parts.join("\n");
      atomicWrite(join(art, `crossverify-claims-${agent}.txt`), items ? items + "\n" : "");
      if (!items) return { skip: "no peer claims to verify" };
      return { prompt: composeVerifyPrompt(items, artifact) };
    },
  });
}

// ---- rebuttal-send / rebuttal-wait (Phase 7b bounded defend-or-concede) ----
export async function rebuttalSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  return phaseSend(REBUTTAL, { topic, agent, provider }, d, {
    prepare: ({ art, artifact }) => {
      const rows = parseListFile(readIf(join(art, "list.txt")));
      if (!rows.some((r) => r.agent === agent)) { log.error(`explore rebuttal-send: ${agent} not in list.txt at ${art}`); return { fail: 1 }; }

      const buckets = new Map<string, Claim[]>();
      for (const r of rows) buckets.set(r.agent, parseBucketLines(readIf(join(art, `${r.agent}_only_items.txt`))));

      // Same backstop as the findings consumers, over the OTHER artifact this phase reads: rebuttal
      // targets are selected FROM the critiques, so a half-written adversary-<peer>.md silently
      // narrows what this worker is asked to defend. A critique the wait never accepted contributes
      // nothing.
      const critiques: CritiqueInput[] = [];
      for (const r of rows) {
        const s = surveyPhaseArtifact(ADVERSARY, r, {
          topic, label: "explore rebuttal-send", emptyIsComplete: true, skipTag: true,
        });
        if ("skipped" in s) continue;
        if (!s.text.trim()) continue; // an empty critique is omitted, never judged
        if (s.verdict === "still-writing") return { fail: 1 };
        if (s.verdict === "complete") critiques.push({ agent: r.agent, text: s.text });
      }

      const mine = selectRebuttalTargets(critiques, buckets).get(agent);
      if (!mine || mine.findings.length === 0) return { skip: "no needs-attention findings attributed to it" };
      return { prompt: composeRebuttalPrompt(mine.claims, mine.findings, artifact) };
    },
  });
}

// ---- gap-send / gap-wait (Phase 7c post-gate gap enrichment; trigger = recorded S1/S2 false) ----
export async function gapSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  return phaseSend(GAP, { topic, agent, provider }, d, {
    // Trigger: the Phase 5.5 record's signals_passed line — S1=false or S2=false fires the round.
    // The record is READ ONLY here; the gate ran once and adversary-skip.txt is never rewritten.
    // It precedes the dispatch guard, as the shipped verb did: an untriggered round must not probe.
    preGuard: ({ art }) => {
      const signalsLine = readIf(join(art, "adversary-skip.txt")).split("\n").find((l) => l.startsWith("signals_passed:")) ?? "";
      if (/\bS1=false\b/.test(signalsLine) || /\bS2=false\b/.test(signalsLine)) return null;
      return { skip: "no recorded S1/S2 failure — trigger not fired" };
    },
    prepare: ({ art, artifact }) => {
      const agents = parseListFile(readIf(join(art, "list.txt"))).map((r) => r.agent);
      if (!agents.includes(agent)) { log.error(`explore gap-send: ${agent} not in list.txt at ${art}`); return { fail: 1 }; }

      const items: string[] = [];
      for (const f of verifyScopeFiles(agent, agents)) {
        for (const l of readIf(join(art, f)).split("\n")) if (l.length > 0) items.push(l);
      }
      if (items.length === 0) return { skip: "no peer-only items to enrich" };
      return { prompt: composeGapPrompt(items, artifact) };
    },
  });
}

// ---- signoff-send / signoff-wait (Phase 8b bounded final-doc fairness check) ----
export async function signoffSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  return phaseSend(SIGNOFF, { topic, agent, provider }, d, {
    prepare: ({ art, artifact }) => {
      const rows = parseListFile(readIf(join(art, "list.txt")));
      if (!rows.some((r) => r.agent === agent)) { log.error(`explore signoff-send: ${agent} not in list.txt at ${art}`); return { fail: 1 }; }

      const finalPath = finalLandscapePath(art);
      const conclusion = finalPath ? sectionText(readIf(finalPath), ["Conclusion"]) : "";
      if (!conclusion) { log.error(`explore signoff-send: final landscape doc missing or has no ## Conclusion at ${art} — author it (Phase 8) first`); return { fail: 1 }; }

      // Solo bucket + diff.md Agreed/Consensus text are tolerant-empty: a degraded N=1 run never ran
      // diff, and sign-off is exactly the misattribution check a single-source survey needs.
      const soloBucketLines = readIf(join(art, `${agent}_only_items.txt`)).split("\n").filter((l) => l.length > 0);
      const agreedText = sectionText(readIf(join(art, "diff.md")), ["Agreed", "Consensus"]);
      return { prompt: composeSignoffPrompt(conclusion, soloBucketLines, agreedText, artifact) };
    },
  });
}

// ---- drill-send / drill-wait (Phase 8c grill fact turn; one drill per worker, the one-turn cap) ----
export async function drillSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  return phaseSend(DRILL, { topic, agent, provider }, d, {
    prepare: ({ art, artifact }) => {
      // The grill routes this round's unresolved facts by writing grill-facts-<agent>.txt. No file
      // (the mop-up's every-undrilled-worker pass) or no bullets in it = nothing to ask.
      const facts = parseFacts(readIf(join(art, `grill-facts-${agent}.txt`)));
      if (facts.length === 0) return { skip: "no drill facts routed" };
      // The verbatim topic, not the slug the state dir is keyed by (a slug reads as garbage to a worker).
      const topicText = readIf(join(art, "topic.txt")).trim() || topic;
      return { prompt: composeDrillPrompt(topicText, facts, artifact) };
    },
  });
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

/** The missing-artifact sweep the three roster validators share: `missingListArtifacts`' own
 *  predicate first, then the sentinel backstop over the files that ARE present — a worker whose
 *  artifact the wait never accepted joins the missing list. Null = one is still being written, and
 *  the caller refuses (rc 1) so the hub can re-run the wait. The whole roster is surveyed either
 *  way: the strikes the shipped code recorded stay recorded. */
function surveyMissing(row: PhaseRow, rows: ListRow[], art: string, topic: string, label: string, prefix: string): string[] | null {
  const missing = missingListArtifacts(art, rows, prefix);
  let stillWriting = false;
  for (const r of rows) {
    if (missing.includes(`${prefix}-${r.agent}.md`)) continue;
    const { verdict } = surveyPhaseArtifact(row, r, { topic, label, emptyIsComplete: false });
    if (verdict === "still-writing") stillWriting = true;
    else if (verdict === "drop") missing.push(`${prefix}-${r.agent}.md`);
  }
  return stillWriting ? null : missing;
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
  // whitespace-only findings file must not survive here only to block synth-preliminary anyway),
  // plus the sentinel backstop: a file still being written cannot enter the survivor set (refuse,
  // the hub runs research-wait), and one the wait held open until grace expired is dropped as empty.
  const found = surveyMissing(RESEARCH, rows, art, topic, "explore survivors", "findings");
  if (!found) return 1;
  const missing = new Set(found);
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
  // Sentinel backstop, same rule as survivors: still-writing refuses (rc 1, retry after the wait),
  // a worker whose artifact the wait never accepted joins the missing list (survivors drops it).
  const missing = surveyMissing(RESEARCH, rows, art, topic, "explore synth-preliminary", "findings");
  if (!missing) return 1;
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
  // The draft precondition runs BEFORE the state-file check, as the shipped verb did: with no draft
  // the whole phase is out of order, and saying so beats naming a state file the operator would
  // then delete.
  const art = exploreArtDir(topic);
  const draft = readIf(join(art, "landscape-draft.md"));
  if (!draft.trim()) { log.error("explore adversary-send: landscape-draft.md missing or empty — run synth-preliminary first"); return 1; }

  return phaseSend(ADVERSARY, { topic, agent, provider }, d, {
    prepare: ({ art, artifact }) => {
      const rows = parseListFile(readIf(join(art, "list.txt")));
      const index = rows.findIndex((r) => r.agent === agent);
      if (index < 0) { log.error(`explore adversary-send: ${agent} not in list.txt at ${art}`); return { fail: 1 }; }
      const peerFindingsPaths = rows.filter((r) => r.agent !== agent).map((r) => RESEARCH.artifactFor(art, r.agent, r.provider, topic));
      const lens = ADVERSARY_LENSES[index % ADVERSARY_LENSES.length];
      const priorityTargets = soloTokensFromAnnotations(readIfExistsOrNull(join(art, "annotations.json")));
      const lowConfidenceClaims: string[] = []; // union across ALL workers' selfassess files (missing → skip)
      for (const r of rows) {
        for (const l of parseSelfAssessment(readIf(join(art, `selfassess-${r.agent}.md`))).leastSure) {
          if (!lowConfidenceClaims.includes(l)) lowConfidenceClaims.push(l);
        }
      }
      return { prompt: composeAdversaryPrompt(draft, agent, artifact, { peerFindingsPaths, lens, priorityTargets, lowConfidenceClaims }) };
    },
  });
}

// ---- wait-gate (composes the pure gateState over the per-phase state files) ----
export async function exploreWaitGateRun(rest: string[]): Promise<number> {
  const [topic, phase] = rest;
  if (!topic || !phase) { log.error(`usage: explore wait-gate <topic> <${phaseStems("explore")}>`); return 2; }
  const row = rowFor("explore", phase);
  if (!row) { log.error(`explore wait-gate: phase must be ${phaseStems("explore")} (got ${phase})`); return 2; }
  return waitGateVerb(row, topic);
}

// ---- synth-final (input validator) ----
export async function synthFinalRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore synth-final <topic>"); return 2; }
  const art = exploreArtDir(topic);
  if (!existsSync(art)) { log.error(`explore synth-final: ${art} not found`); return 1; }
  if (!readIf(join(art, "landscape-draft.md")).trim()) { log.error("explore synth-final: landscape-draft.md missing"); return 1; }
  if (!readIf(join(art, "topic.txt")).trim()) { log.error("explore synth-final: topic.txt missing"); return 1; }

  const skipped = skipRecordSaysUserSkip(art);
  if (!skipped) {
    const rows = parseListFile(readIf(join(art, "list.txt")));
    const active = rows.filter((r) => lastTag(readIf(join(art, `adversary-${r.agent}.txt`)), "AS") !== "skipped");
    // Sentinel backstop, synth-preliminary's shape, over the critiques the final doc quotes: a
    // still-writing critique refuses (rc 1), one the wait never accepted joins the missing list.
    const missing = surveyMissing(ADVERSARY, active, art, topic, "explore synth-final", "adversary");
    if (!missing) return 1;
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
    const s = surveyPhaseArtifact(ADVERSARY, r, {
      topic, label: "explore verdict-tally", emptyIsComplete: true, skipTag: true,
    });
    if ("skipped" in s) { verdictRows.push({ agent: r.agent, verdict: "skipped" }); continue; }
    if (s.verdict === "still-writing") return 1;
    verdictRows.push({ agent: r.agent, verdict: parseAdversaryVerdict(s.verdict === "drop" ? "" : s.text) });
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
  /** ONE server-wide pane+nonce snapshot for the whole sweep; the ids in preflight-panes.txt are
   *  only killable when the live pane still carries the nonce preflight recorded for it. */
  livePaneNonces(): Promise<Map<string, string>>;
  archiveTopic(topic: string, suite: "explore"): string | null;
  stdout?: (l: string) => void;
}
const liveExploreTeardownDeps: ExploreTeardownDeps = {
  killPane: (p) => killNow(p),
  livePaneNonces: () => livePaneNonces(),
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

  await killPreflightOrphans(art, deps, "explore teardown:");

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
