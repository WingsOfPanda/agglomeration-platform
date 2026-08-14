// src/commands/design.ts
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc, archiveTopic } from "../core/archive.js";
import {
  deriveSlug, parseDesignArgs, designArtDir, designDraftDir, designWalkDir, designDocPath,
  resolveDrilldownPath, cascadeTargets, exportDocTo, type ResetPhase,
} from "../core/design.js";
import {
  formatListFile, parseListFile, spawnAllBatch, verifyScopeFiles, type ListRow,
} from "../core/roster.js";
import { assembleDoc, SECTIONS_SINGLE, synthesizeSeeds } from "../core/designDoc.js";
import { auditDoc } from "../core/audit.js";
import { lintComponentsPaths } from "../core/implementScope.js";
import { readProviderList } from "../core/providers.js";
import { activeProvidersPath, workerDir, repoRoot, topicDir } from "../core/paths.js";
import { pickAgents } from "../core/agents.js";
import { agentConsultValidated, consultTimeout } from "../core/contracts.js";
import { composeResearchPrompt, scaledTimeout, composeVerifyPrompt, composeDrilldownPrompt, drilldownState, parseLatestOffset } from "../core/designTurn.js";
import {
  DESIGN_PHASES, dispatchPrompt, phaseWait, waitGateVerb, skipDispatch, surveyPhaseArtifact, triad,
  liveSendDeps, liveWaitDeps, type SendDeps, type WaitDeps,
} from "../core/phaseTable.js";
import { statusPath, workerBusyState } from "../core/ipc.js";
import { envNum } from "../core/env.js";
import { runForensics, runFlag } from "../core/forensics.js";
import { clearAgentStrikes } from "../core/artifact.js";
import { diffFindings, type DiffPart } from "../core/designDiff.js";
import { adjudicate, type AdjudicateInput } from "../core/designAdjudicate.js";
import { classifyTopic, skillHintAppend } from "../core/designSkill.js";
import { readIfExists as readIf, readIfExistsOrNull } from "../core/fsread.js";
import { walkSectionState, auditIssueToSection, parseWalkVerdict, WALK_VERDICTS } from "../core/designWalk.js";
import { run as spawnRun } from "./spawn.js";
import { run as preflightRun } from "./preflight.js";

function usage(): number { log.error("usage: design <init|assemble|spawn-all|research-send|research-wait|wait-gate|diff|verify-send|verify-wait|adjudicate|synthesize|walk-approve|walk-state|drilldown|offset-reset|export-doc|flag|forensics|archive> ..."); return 2; }

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest, { valueFlags: new Set() }));
    case "assemble": return assembleRun(rest);
    case "spawn-all": return spawnAllRun(rest);
    case "research-send": return triad("design research-send", researchSendWith, liveSendDeps)(rest);
    case "research-wait": return triad("design research-wait", researchWaitWith, liveWaitDeps)(rest);
    case "diff": return diffRun(rest);
    case "verify-send": return triad("design verify-send", verifySendWith, liveSendDeps)(rest);
    case "verify-wait": return triad("design verify-wait", verifyWaitWith, liveWaitDeps)(rest);
    case "adjudicate": return adjudicateRun(rest);
    case "synthesize": return synthesizeRun(rest);
    case "walk-approve": return walkApproveRun(rest);
    case "walk-state": return walkStateRun(rest);
    case "wait-gate": return waitGateRun(rest);
    case "drilldown": return drilldownRun(rest);
    case "offset-reset": return offsetResetRun(rest);
    case "forensics": return forensicsRun(rest);
    case "flag": return runFlag("design", rest[0], rest.slice(1).join(" "));
    case "archive": return archiveRun(rest);
    case "export-doc": return exportDocRun(rest);
    default: return usage();
  }
}

export interface DesignInitDeps {
  activeProviders(): string[];
  isValidated(provider: string): boolean;
  pickAgents(topic: string, n: number): string[];
}
const liveInitDeps: DesignInitDeps = {
  activeProviders: () => readProviderList(activeProvidersPath()),
  isValidated: agentConsultValidated,
  pickAgents,
};

async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, liveInitDeps); }

export async function initWith(tokens: string[], d: DesignInitDeps): Promise<number> {
  const { topicText, ensemble } = parseDesignArgs(tokens);
  if (!topicText) { log.error("design init: topic text is empty"); return 1; }
  const topic = deriveSlug(topicText);
  if (!topic) { log.error("design init: topic produced an empty slug; provide alphanumerics"); return 1; }

  let list = d.activeProviders().filter((p) => d.isValidated(p));
  if (list.length < 2) {
    log.error(`design init: needs >=2 consult-validated providers; got ${list.length}`);
    log.error("  just ask Claude directly (this session) — no /ap:design orchestration needed");
    return 1;
  }
  if (list.length > 3) { log.warn(`design init: ${list.length} providers available; capping the ensemble to the first 3`); list = list.slice(0, 3); }

  const art = designArtDir(topic);
  if (existsSync(art)) { log.error(`design init: topic already in flight: ${art}`); log.error("  run /ap:stop or pick a different topic"); return 2; }

  const agents = d.pickAgents(topic, list.length);
  if (agents.length < list.length) { log.error(`design init: agent pool exhausted (need ${list.length}, got ${agents.length})`); return 1; }
  const rows: ListRow[] = list.map((provider, i) => ({ provider, agent: agents[i] }));

  mkdirSync(designDraftDir(topic), { recursive: true }); // creates _design/design-doc/.draft
  atomicWrite(join(art, "topic.txt"), topicText);
  atomicWrite(join(art, "skill.txt"), classifyTopic(topicText));
  // Full list written even on a fast-path run; the ensemble path (Phase C) reads list.txt back.
  atomicWrite(join(art, "list.txt"), formatListFile(rows, isoUtc()));

  log.ok(`design init: topic=${topic} N=${rows.length} ensemble=${ensemble ? "yes" : "no"}`);
  process.stdout.write(
    `TOPIC=${topic}\nN=${rows.length}\nENSEMBLE=${ensemble ? "yes" : "no"}\nART=${art}\n` +
    rows.map((r) => `PART=${r.agent}:${r.provider}`).join("\n") + "\n",
  );
  return 0;
}

async function assembleRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: design assemble <topic>"); return 2; }
  const art = designArtDir(topic);
  const draftDir = designDraftDir(topic);
  if (!existsSync(draftDir)) { log.error(`design assemble: no draft dir at ${draftDir} (run design init + draft sections)`); return 2; }

  const title = (readIf(join(art, "topic.txt")).split("\n")[0] || topic).trim();
  const drafts = new Map<string, string>();
  // One trailing newline per section → a blank line between them (matches the behavioral source's
  // `cat draft; printf '\n'` and assembleDoc's missing-draft branch which emits a blank line).
  for (const k of SECTIONS_SINGLE) { const f = join(draftDir, `${k}.md`); if (existsSync(f)) drafts.set(k, readFileSync(f, "utf8").replace(/\n+$/, "") + "\n"); }

  const date = isoUtc().slice(0, 10);
  const doc = assembleDoc({ title, drafts });
  const out = designDocPath(topic, date);
  mkdirSync(join(art, "design-doc"), { recursive: true });
  atomicWrite(out, doc);

  // Warn-only path lint: a phantom Components path costs a worker question round later, so name it
  // here. The audit below owns the verdict — this loop never changes it.
  for (const p of lintComponentsPaths(doc, repoRoot())) {
    log.warn(`design assemble: Components path not found in this checkout: ${p} — mark it [on-box] if it is deliberately box-local, or fix the path`);
  }

  const result = auditDoc(doc);
  const auditText = [`VERDICT=${result.verdict}`, ...result.issues.map((i) => `ISSUE=${i}`)].join("\n") + "\n";
  atomicWrite(join(art, "design-doc", "audit.log"), auditText);
  if (result.verdict === "FAIL") {
    for (const i of result.issues) process.stderr.write(`ISSUE=${i}\n`);
    for (const i of result.issues) process.stderr.write(`SECTION=${auditIssueToSection(i)}\n`);
    log.error(`design assemble: audit FAILED on ${out} (see design-doc/audit.log)`);
    return 1;
  }
  log.ok(`design assemble: audit PASSED`);
  process.stdout.write(out + "\n");
  return 0;
}

function exportDocRun(rest: string[]): number {
  const topic = rest[0];
  if (!topic) { log.error("usage: design export-doc <topic>"); return 2; }
  const dest = exportDocTo(topic, repoRoot());
  if (dest === null) {
    log.error(`design export-doc: no assembled *-${topic}-design.md found (run design assemble first)`);
    return 1;
  }
  log.ok(`design export-doc: exported to ${dest}`);
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
  if (!topic) { log.error("usage: design spawn-all <topic>"); return 2; }
  return spawnAllWith(topic, liveSpawnAllDeps);
}

export async function spawnAllWith(topic: string, d: SpawnAllDeps): Promise<number> {
  return spawnAllBatch("design", topic, designArtDir(topic), d);
}

// design's two worker phases, in pipeline order. The send/wait skeletons live in core/phaseTable.ts
// (shared with explore's seven); `SendDeps`/`WaitDeps` keep their names here for callers + tests.
const [RESEARCH, VERIFY] = DESIGN_PHASES;
export type { SendDeps, WaitDeps };

export async function researchSendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = designArtDir(topic);
  const stateFile = join(art, `research-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`design research-send: ${stateFile} exists; rm to retry`); return 1; }

  const topicText = readIf(join(art, "topic.txt")).trim();
  if (!topicText) { log.error(`design research-send: topic.txt missing/empty at ${art} (run design init)`); return 1; }

  const findingsPath = join(workerDir(agent, provider, topic), "findings.md");
  const promptFile = join(art, `${agent}_research_prompt.md`);
  atomicWrite(promptFile, skillHintAppend(join(art, "skill.txt"), composeResearchPrompt(topicText, findingsPath)));
  return dispatchPrompt(RESEARCH, { topic, agent, provider, stateFile, promptFile }, d);
}

export async function researchWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  return phaseWait(RESEARCH, topic, agent, provider, d);
}

export async function diffRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: design diff <topic>"); return 2; }
  const art = designArtDir(topic);
  if (!existsSync(art)) { log.error(`design diff: ${art} not found`); return 1; }
  if (existsSync(join(art, "diff.md"))) { log.error("design diff: diff.md exists; rm to retry"); return 1; }

  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error("design diff: list.txt missing — run design init first"); return 1; }
  const rows = parseListFile(readFileSync(listPath, "utf8"));
  if (rows.length < 2) { log.error(`design diff: need >=2 workers in list.txt, got ${rows.length}`); return 1; }

  const workers: DiffPart[] = [];
  for (const r of rows) {
    const f = RESEARCH.artifactFor(art, r.agent, r.provider, topic);
    if (!existsSync(f)) { log.error(`design diff: ${r.agent} findings.md missing: ${f}`); return 1; }
    // Sentinel backstop: a still-writing findings file refuses the whole diff (the hub runs
    // research-wait and retries); one the wait never accepted diffs as EMPTY.
    const { text, verdict } = surveyPhaseArtifact(RESEARCH, r, {
      topic, label: "design diff", emptyIsComplete: false,
    });
    if (verdict === "still-writing") return 1;
    workers.push({ name: r.agent, findings: verdict === "drop" ? "" : text });
  }

  const result = diffFindings(workers);
  for (const file of result.files) atomicWrite(join(art, file.filename), file.content);
  atomicWrite(join(art, "diff.md"), result.diffMd);

  const summary = result.files
    .filter((f) => f.filename.endsWith("_only_items.txt") || f.filename === "consensus.txt")
    .map((f) => `${f.filename.replace(/\.txt$/, "")}=${f.content.split("\n").filter(Boolean).length}`)
    .join(" ");
  log.ok(`design diff: wrote ${join(art, "diff.md")} (${rows.length} workers) ${summary}`);
  return 0;
}

// ---- Phase D: cross-verify -> adjudicate -> synthesize ----

export async function verifySendWith(topic: string, agent: string, provider: string, d: SendDeps): Promise<number> {
  const art = designArtDir(topic);
  if (!existsSync(art)) { log.error(`design verify-send: ${art} not found`); return 1; }
  const stateFile = join(art, `verify-${agent}.txt`);
  if (existsSync(stateFile)) { log.error(`design verify-send: ${stateFile} exists; rm to retry`); return 1; }

  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error("design verify-send: list.txt missing — run design init first"); return 1; }
  const agents = parseListFile(readFileSync(listPath, "utf8")).map((r) => r.agent);
  if (agents.length < 2) { log.error(`design verify-send: need >=2 workers, got ${agents.length}`); return 1; }
  if (!agents.includes(agent)) { log.error(`design verify-send: ${agent} not in list.txt`); return 1; }

  const workers: string[] = [];
  for (const f of verifyScopeFiles(agent, agents)) {
    const p = join(art, f);
    if (!existsSync(p)) { log.error(`design verify-send: expected bucket missing: ${p} (run design diff first)`); return 1; }
    const c = readFileSync(p, "utf8");
    if (c.split("\n").some((l) => l.length > 0)) workers.push(c.replace(/\n+$/, ""));
  }
  const items = workers.join("\n");
  atomicWrite(join(art, `verify-claims-${agent}.txt`), items ? items + "\n" : "");

  if (!items) return skipDispatch(VERIFY, agent, stateFile, "no claims to verify");

  const verifyPath = join(workerDir(agent, provider, topic), "verify.md");
  const promptFile = join(art, `${agent}_verify_prompt.md`);
  atomicWrite(promptFile, skillHintAppend(join(art, "skill.txt"), composeVerifyPrompt(items, verifyPath)));
  return dispatchPrompt(VERIFY, { topic, agent, provider, stateFile, promptFile }, d);
}

export async function verifyWaitWith(topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> {
  return phaseWait(VERIFY, topic, agent, provider, d);
}

export async function adjudicateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: design adjudicate <topic>"); return 2; }
  const art = designArtDir(topic);
  if (!existsSync(art)) { log.error(`design adjudicate: ${art} not found`); return 1; }
  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error("design adjudicate: list.txt missing"); return 1; }
  const rows = parseListFile(readFileSync(listPath, "utf8"));
  if (rows.length < 2) { log.error(`design adjudicate: need >=2 workers, got ${rows.length}`); return 1; }

  const agents = rows.map((r) => r.agent);
  const verify: Record<string, string> = {};
  const vs: Record<string, string> = {};
  for (const r of rows) {
    // Same backstop as diff, over the OTHER worker-authored artifact this command adjudicates: a
    // half-written verify.md would silently under-report its verdicts. An absent/empty verify.md is
    // the pre-existing VS=skipped path (nothing was ever sent) and never reaches the backstop.
    const { text, tag, verdict } = surveyPhaseArtifact(VERIFY, r, {
      topic, label: "design adjudicate", emptyIsComplete: true,
    });
    if (verdict === "still-writing") return 1;
    verify[r.agent] = verdict === "drop" ? "" : text;
    vs[r.agent] = tag ?? "skipped";
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
  log.ok(`design adjudicate: wrote ${join(art, "adjudicated-draft.md")}`);
  log.info("  cp adjudicated-draft.md -> adjudicated.md, then resolve every '- PENDING:' line");
  return 0;
}

export async function synthesizeRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: design synthesize <topic>"); return 2; }
  const art = designArtDir(topic);
  const adj = join(art, "adjudicated.md");
  if (!existsSync(adj)) { log.error(`design synthesize: ${adj} missing — cp adjudicated-draft.md -> adjudicated.md and resolve PENDINGs first`); return 1; }
  const adjText = readFileSync(adj, "utf8");
  if (/^- PENDING:/m.test(adjText)) { log.error("design synthesize: adjudicated.md still has '- PENDING:' lines; resolve them first"); return 1; }

  const draftDir = designDraftDir(topic);
  mkdirSync(draftDir, { recursive: true });
  // A section the walk already settled keeps its draft. Re-seeding it would overwrite the approved
  // (or skipped) text on every Stage-10 re-entry — destroying exactly the work the markers record.
  const settled = new Set(walkSectionState(designWalkDir(topic)));
  const seeds = synthesizeSeeds(adjText).filter((s) => !settled.has(s.section));
  for (const s of seeds) atomicWrite(join(draftDir, `${s.section}.md`), s.body);
  if (settled.size) log.info(`design synthesize: kept ${[...settled].sort().join(", ")} (already walked; rm the .walk/<section>.state marker to re-seed)`);
  log.ok(`design synthesize: wrote ${seeds.length} seed drafts to ${draftDir}`);
  return 0;
}

/** The walk's own record of a settled section — the ONLY thing walk-state reads back. Called once
 *  per user decision in the Stage 10 walk (Approve/Skip); a section nobody decided stays pending. */
export async function walkApproveRun(rest: string[]): Promise<number> {
  const [topic, section, verdict] = rest;
  if (rest.length !== 3 || !topic || !section || !verdict) { log.error("usage: design walk-approve <topic> <section> <approved|skipped>"); return 2; }
  if (!(SECTIONS_SINGLE as readonly string[]).includes(section)) { log.error(`design walk-approve: unknown section '${section}' (expected one of: ${SECTIONS_SINGLE.join(", ")})`); return 2; }
  if (!parseWalkVerdict(verdict)) { log.error(`design walk-approve: verdict must be ${WALK_VERDICTS.join("|")} (got ${verdict})`); return 2; }
  const art = designArtDir(topic);
  if (!existsSync(art)) { log.error(`design walk-approve: art dir missing: ${art} (run design init first)`); return 1; }
  const dir = designWalkDir(topic);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${section}.state`), verdict + "\n");
  log.ok(`design walk-approve: ${section}=${verdict}`);
  return 0;
}

export async function walkStateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: design walk-state <topic>"); return 2; }
  const states = walkSectionState(designWalkDir(topic), { withStatus: true });
  for (const s of states) process.stdout.write(`${s.name}\t${s.status}\n`);
  return 0;
}

export async function waitGateRun(rest: string[]): Promise<number> {
  const [topic, phase] = rest;
  if (!topic || !phase) { log.error("usage: design wait-gate <topic> <research|verify>"); return 2; }
  if (phase !== "research" && phase !== "verify") { log.error(`design wait-gate: phase must be research|verify (got ${phase})`); return 2; }
  return waitGateVerb("design", designArtDir(topic), phase, phase === "research" ? "FS" : "VS");
}

// ---- Phase F: drilldown (optional, workers still live) ----

interface DrilldownDeps extends SendDeps, WaitDeps {}
interface DrilldownTestHooks { writeProbe?: (outPath: string) => void; }
// Default to the research turn timeout (the bash predecessor's findings_timeout_s, ~600s) — a real
// drill turn (read the doc + write cited notes) routinely exceeds 90s; env-overridable. The wait
// returns as soon as done/error appears, so a generous ceiling only bounds the hang case.
const DRILLDOWN_TIMEOUT = (): number => envNum("AP_DRILLDOWN_TIMEOUT_S", consultTimeout("research"));

async function drilldownRun(rest: string[]): Promise<number> {
  return drilldownWith(rest, { ...liveSendDeps, ...liveWaitDeps }, {});
}

export async function drilldownWith(rest: string[], d: DrilldownDeps, hooks: DrilldownTestHooks): Promise<number> {
  // positional: topic section ddDir focus designDoc i1 m1 [i2 m2]
  const n = rest.length;
  if (![7, 9].includes(n)) { log.error("usage: design drilldown <topic> <section> <dd-dir> <focus> <design-doc> <i1> <m1> [<i2> <m2>]"); return 2; }
  const [topic, section, ddDir, focus, designDoc, i1, m1] = rest;
  const [i2, m2] = n >= 9 ? [rest[7], rest[8]] : ["", ""];
  if (!existsSync(ddDir)) { log.error(`design drilldown: dd-dir not found: ${ddDir}`); return 2; }
  if (!existsSync(designDoc)) { log.error(`design drilldown: design-doc not found: ${designDoc}`); return 2; }

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
    // The same busy-gate every phase send runs (dispatchPrompt's, via the shared workerBusyState):
    // drilldown is an optional EXTRA turn dispatched while the workers are still live, so it is the
    // likeliest send of all to land on a worker mid-turn and rewrite the inbox task it is working on.
    const busy = (d.busyState ?? workerBusyState)(j.inst, j.model, topic);
    if (busy) {
      log.error(`design drilldown: worker ${j.inst} busy (state=${busy}) — not sending; re-run the drilldown once it is idle (status: ${statusPath(j.inst, j.model, topic)})`);
      return "missing" as const;
    }
    const offset = d.offsetFor(j.inst, j.model, topic);          // BEFORE send
    const rc = await d.send(["--from", "hub", j.inst, topic, `@${promptFile}`]);
    if (rc !== 0) return "missing" as const;
    hooks.writeProbe?.(j.outPath);                                // test-only: simulate the worker's write
    const ev = await d.wait(j.inst, j.model, topic, offset, ["done", "error"], timeout(j.model));
    const fileText = readIfExistsOrNull(j.outPath);
    return drilldownState(ev, fileText);
  }));

  const ok = results.filter((r) => r === "ok").length;
  log.ok(`design drilldown: ${ok}/${jobs.length} workers produced notes`);
  return ok > 0 ? 0 : 1;
}

// ---- Phase F: offset-reset (clean-retry primitive) ----

export async function offsetResetRun(rest: string[]): Promise<number> {
  const keepFindings = rest.includes("--keep-findings");
  const pos = rest.filter((t) => !t.startsWith("--"));
  const [topic, agent, phase] = pos;
  if (!topic || !agent || !phase) { log.error("usage: design offset-reset <topic> <agent> <phase> [--keep-findings]"); return 2; }
  if (phase !== "research" && phase !== "verify") { log.error(`design offset-reset: phase must be research|verify (got ${phase})`); return 2; }
  const art = designArtDir(topic);
  if (!existsSync(art)) { log.error(`design offset-reset: art dir missing: ${art}`); return 1; }

  // With --keep-findings the state file is REDUCED to its last `OFFSET=` line instead of deleted:
  // the worker's artifact is still on disk, so a re-armed `<phase>-wait` resumes from that offset
  // and re-judges it. That is the busy-worker recovery — a re-SEND is refused while the file exists
  // and would clobber the live turn if the file were simply removed. The default path has just
  // destroyed the findings and the whole cascade, so nothing is left for a re-wait to judge and a
  // kept offset would only re-derive a terminal miss; the file goes, as it did before. Either way a
  // file that never carried an OFFSET= (nothing was ever sent) is deleted.
  const stateFile = join(art, `${phase}-${agent}.txt`);
  const keptOffset = keepFindings ? parseLatestOffset(readIf(stateFile)) : null;
  if (keptOffset === null) rmSync(stateFile, { force: true });
  else atomicWrite(stateFile, `OFFSET=${keptOffset}\n`);
  // The refusal logs go with the state file, in BOTH modes (--keep-findings included): a reset
  // re-arms the phase, so strikes from the episode it just cleared must not carry into the retry
  // and degrade a fresh artifact as "no growth". Swept by agent prefix — the logs are per ARTIFACT
  // (`stillwriting-<agent>-<file>.txt`), and a reset re-arms all of that agent's work.
  for (const f of [`${phase}-${agent}.done`, `question-${agent}.txt`])
    rmSync(join(art, f), { force: true });
  clearAgentStrikes(art, agent);

  const c = cascadeTargets(phase as ResetPhase, keepFindings);
  if (!keepFindings) {
    const td = topicDir(topic);
    if (existsSync(td)) for (const name of readdirSync(td))
      if (name.startsWith(`${agent}-`)) rmSync(join(td, name, c.workerFile), { force: true });
    for (const f of c.artFiles) rmSync(join(art, f), { force: true });
    const names = readdirSync(art);
    for (const g of c.artGlobs) { const re = new RegExp("^" + g.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$"); for (const n of names) if (re.test(n)) rmSync(join(art, n), { force: true }); }
  }
  log.ok(`design offset-reset: ${phase}/${agent}${keepFindings ? " (kept findings)" : ""}${keptOffset === null ? "" : `; state file kept at OFFSET=${keptOffset}; re-arm the wait, or rm it to re-send`}`);
  return 0;
}

// ---- Phase F: forensics + archive (thin wind-down verbs) ----

export async function forensicsRun(rest: string[]): Promise<number> {
  return runForensics("design", designArtDir, rest[0]);
}

export async function archiveRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: design archive <topic>"); return 2; }
  archiveTopic(topic, "design");
  log.ok(`design archive: archived _design for ${topic}`);
  return 0;
}
