// src/commands/implement.ts — single-repo command path for /ap:implement.
// Byte-faithful port of the prior bash plugin's deploy verb set; WIRES the Phase-A core modules.
// Rebrand: _deploy/->_implement/, feat/deploy-->feat/implement-, conductor sender->From: hub.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { expandArgsFile, kvParse } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { repoRoot, repoStateDir } from "../core/paths.js";
import { jobPath, keepOnBranch, parseJob, sliceWorktreePathFor, withMainCheckout } from "../core/job.js";
import { auditDoc } from "../core/audit.js";
import {
  parseImplementArgs, deriveTopicFromPath, detectProvider,
  implementArtDir, targetCwd, assertImplementTopic, ImplementArgError,
  parseSetProviderArgs, FALLBACK_REASONS, recordProviderFallback,
} from "../core/implement.js";
import { isoUtc, archiveTopic } from "../core/archive.js";
import { extractComponentsPaths, extractTestingPaths, lintComponentsPaths, matchDiffAgainstComponents, pathsInvisibleInTarget, testingBulletsWithoutPaths, unresolvedDeclaredPaths } from "../core/implementScope.js";
import { runnerAt, preSnapshot, createOrResumeBranch, currentBranch, shortstat, finishWork, hasDistinctBranch, targetProblem, type Runner } from "../core/gitwork.js";
import { runForensics, runFlag, recordHubFlag, runReflect } from "../core/forensics.js";
import { haveCmd } from "../core/deps.js";
import {
  implementState, composeRound1Prompt, composeFixPrompt,
  composePlanPrompt, composeGrillPrompt, composeSliceRound1Prompt, composePreludePrompt, composeAbsorbPrompt,
  evidencePathFor, NAMED_ROUNDS,
} from "../core/implementTurn.js";
import {
  MAX_SLICES, ABANDON_REASONS, absorbIssues, checkSlicePlan, parsePlanTasks, readSlices, sliceMandate, writeSlices,
  type AbandonReason, type SliceRow, type SliceStatus,
} from "../core/implementSlices.js";
import { integrateSlices, readIntegrate, writeIntegrate } from "../core/implementIntegrate.js";
import { spawnSlices, type SpawnSlicesDeps } from "../core/implementSpawnSlices.js";
import { pickAgents } from "../core/agents.js";
import { provisionWorktree } from "./job.js";
import { run as spawnRun } from "./spawn.js";
import { run as stopRun } from "./stop.js";
import { extractQuestionPayload, parseQuestionPayload } from "../core/questionCodec.js";
import { outboxOffset, outboxPath, paneMetaRead, realClock, statusPath, workerSendGate, resolveModel, PANE_DIED_NOTE, type Clock } from "../core/ipc.js";
import { holdPrematureDone, liveRearm, paneIdleProbe, prematureDoneS, type RearmFn } from "../core/implementHold.js";
import { capturePane, selectLayoutMainVertical, windowHeight } from "../core/tmux.js";
import { kvField, readField, readIfExists, readIfExistsOrNull } from "../core/fsread.js";
import { branchNameFor, readBranchRecord } from "../core/branchRecord.js";
import { agentBinary, agentTimeoutMultiplier, listAgents } from "../core/contracts.js";
import { awaitTurn, scaledTimeout, lastKeyedNumber, recordWaitOutcome, type WaitFn } from "../core/wait.js";
import { envNum, DEFAULT_TURN_BUDGET_S } from "../core/env.js";
import { run as sendRun } from "./send.js";
import { detectTestCommand } from "../core/quick.js";
import { classifyTestRun, liveTestRunner, parseWorkerDuration, shouldSkipVerify, type TestRunner, type TestVerdict } from "../core/implementVerifyTests.js";

const WORKER = "lead";
const IMPLEMENT_TURN_TIMEOUT = (): number => envNum("AP_IMPLEMENT_TURN_TIMEOUT_S", DEFAULT_TURN_BUDGET_S);
/** The plan and grill turns write ONE file and implement nothing, so they get their own budget: a
 *  lead that never plans must not spend the run's 4h turn budget before the fan-out starts. */
const PLAN_TURN_TIMEOUT = (): number => envNum("AP_IMPLEMENT_PLAN_TURN_TIMEOUT_S", 3600);
/** A turn token: a numbered fix round, or one of the lead's NAMED parallel-phase turns (which are
 *  outside MAX_ROUNDS — it keeps counting the numbered rounds exactly as today). */
const ROUND_RE = new RegExp(`^([1-9][0-9]*|${NAMED_ROUNDS.join("|")})$`);
/** A slice's per-agent file stem; the lead's is the bare round, so its 0.5.68 names are unchanged. */
function stemFor(agent: string, round: number | string): string {
  return agent === WORKER ? `${round}` : `${agent}-${round}`;
}
/** The report a build-shaped turn writes. "" for the plan and grill turns: they write `plan.md`
 *  (which `evidencePathFor` returns as their COMPLETION evidence) and no report at all. */
function reportPathFor(art: string, round: number | string, agent: string): string {
  return round === "plan" || round === "grill" ? "" : evidencePathFor(art, round, agent);
}

/** model for the lead worker = the resolved provider (codex|claude). Reads provider.txt; default codex. */
function workerModel(art: string): string {
  return readIfExists(join(art, "provider.txt")).trim() || "codex";
}
/** Does the lead worker that actually got spawned carry the model provider.txt names? An override
 *  changes only the SPAWN's provider — the claude-confirm gate's "fall back to codex", a detached
 *  job.json naming a provider — so provider.txt keeps naming the auto-detected one and both turn
 *  verbs then address a `lead-<wrong-model>` dir that was never created. The first detached dogfood
 *  hit exactly that and cost a hand-edit of provider.txt mid-run; failing closed here, before any
 *  send or state write, with the one verb that reconciles it is the fix. `null` (no worker dir yet)
 *  passes: the spawn simply has not happened. */
function assertLeadMatches(topic: string, model: string, verb: string): boolean {
  const spawned = resolveModel(WORKER, topic);
  if (spawned === null || spawned === model) return true;
  log.error(`implement ${verb}: provider.txt says '${model}' but the spawned ${WORKER} worker is '${spawned}' — reconcile with: implement set-provider ${topic} ${spawned}`);
  return false;
}
/** The LAST `OBJECTIONS=<n>` count persisted in a per-dispatch state file (0 if absent). The
 *  objection cap reads + increments this on every re-arm so the count survives the background-task
 *  re-entry that drives the re-armed wait. Latest-line-wins, mirroring parseLatestOffset. */
function latestObjections(stateFile: string): number {
  if (!existsSync(stateFile)) return 0;
  return lastKeyedNumber(readFileSync(stateFile, "utf8"), "OBJECTIONS") ?? 0;
}
function usage(): number {
  log.error("usage: implement <init|audit|set-provider|pre-snapshot|branch|turn-send|turn-wait|reset-status|slice-check|spawn-slices|abandon-slice|slice-gate|integrate|scope-check|verify-tests|summary|finish|forensics|archive|find-latest-doc> ...");
  return 2;
}

// ---- find-latest-doc (deploy Step 0.4 no-arg source default) — newest */_design/design-doc/*-design.md by mtime ----
async function findLatestDocRun(): Promise<number> {
  const stateDir = repoStateDir();
  let best: { path: string; mt: number } | null = null;
  if (existsSync(stateDir)) for (const topic of readdirSync(stateDir)) {
    const dd = join(stateDir, topic, "_design", "design-doc");
    if (!existsSync(dd)) continue;
    for (const f of readdirSync(dd)) {
      if (!f.endsWith("-design.md")) continue;
      const p = join(dd, f); let mt = 0;
      try { mt = statSync(p).mtimeMs; } catch { continue; }
      if (!best || mt > best.mt) best = { path: p, mt };
    }
  }
  if (!best) { log.error("implement find-latest-doc: no *-design.md found"); return 1; }
  process.stdout.write(`DOC=${best.path}\n`);
  return 0;
}

// ---- audit (deploy.md Step 0 "Proceed anyway" precheck, standalone) ----
// rc 0 = PASS, 1 = FAIL (ISSUE= lines on stderr), 2 = unreadable/bad usage.
async function auditRun(rest: string[]): Promise<number> {
  const doc = rest[0];
  if (!doc || rest.length !== 1) { log.error("usage: implement audit <doc>"); return 2; }
  if (!existsSync(doc)) { log.error(`implement audit: doc unreadable: ${doc}`); return 2; }
  let text: string;
  try { text = readFileSync(doc, "utf8"); } catch { log.error(`implement audit: doc unreadable: ${doc}`); return 2; }
  // Warn-only path lint (catches docs authored outside /ap:design); the audit below owns the verdict.
  for (const p of lintComponentsPaths(text, repoRoot())) {
    log.warn(`implement audit: Components path not found in this checkout: ${p} — mark it [on-box] if it is deliberately box-local, or fix the path`);
  }
  // Warn-only Testing-bullet count (2026-08-23-brief-path-correctness-design.md, C3). A bullet that
  // names only a behavior contributes nothing to scope, and the cost of that lands at Stage 4 as an
  // OOS surprise on a file the design meant all along. Measured HERE, before a worker is spawned.
  const tb = testingBulletsWithoutPaths(text);
  if (tb.withoutPath > 0) {
    log.warn(`implement audit: ${tb.withoutPath} of ${tb.withPath + tb.withoutPath} Testing bullets declare no path — lead each bullet with the file path it covers, or scope-check will read the files they touch as out-of-scope`);
  }
  const ad = auditDoc(text);
  if (ad.verdict === "FAIL") { for (const i of ad.issues) process.stderr.write(`ISSUE=${i}\n`); return 1; }
  log.ok(`implement audit: PASS ${doc}`);
  return 0;
}

export async function run(args: string[]): Promise<number> {
  // ONE state tree per run, whatever directory the hub is standing in -- see `withMainCheckout`.
  return withMainCheckout(() => dispatchVerb(args));
}

async function dispatchVerb(args: string[]): Promise<number> {
  const verb = args[0]; const rest = args.slice(1);
  switch (verb) {
    case "init":      return initRun(expandArgsFile(rest));
    case "audit":     return auditRun(rest);
    case "set-provider": return setProviderRun(rest);
    case "turn-send": return turnSendRun(rest);
    case "turn-wait": return turnWaitRun(rest);
    case "reset-status": return resetStatusRun(rest);
    case "slice-check":   return sliceCheckRun(rest);
    case "spawn-slices":  return spawnSlicesRun(rest);
    case "abandon-slice": return abandonSliceRun(rest);
    case "slice-gate":    return sliceGateRun(rest);
    case "integrate":     return integrateRun(rest);
    case "pre-snapshot": return preSnapshotRun(rest);
    case "branch":       return branchRun(expandArgsFile(rest));
    case "scope-check":  return scopeCheckRun(rest);
    case "verify-tests": return verifyTestsRun(rest);
    case "summary":      return summaryRun(rest);
    case "finish":       return finishRun(rest);
    case "forensics":    return forensicsRun(rest);
    case "flag":         return runFlag("implement", rest[0], rest.slice(1).join(" "));
    case "reflect":      return runReflect("implement", rest[0], rest[1]);
    case "archive":      return archiveRun(rest);
    case "find-latest-doc": if (rest.length) { log.error("implement find-latest-doc: takes no arguments"); return 2; } return findLatestDocRun();
    default:          return usage();
  }
}

// ---- init (deploy-init.sh + deploy.md Step 0 audit, folded in) ----
export interface ImplementInitDeps { repoRoot(): string; }
const liveInitDeps: ImplementInitDeps = { repoRoot };
async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, liveInitDeps); }

export async function initWith(tokens: string[], d: ImplementInitDeps): Promise<number> {
  let parsed; try { parsed = parseImplementArgs(tokens); }
  catch (e) { if (e instanceof ImplementArgError) { log.error(e.message); return e.code; } throw e; }
  const designPath = parsed.rest.trim();
  if (!designPath || designPath.includes(" ")) { log.error("implement init: exactly one design-doc path is required"); return 2; }
  if (!existsSync(designPath)) { log.error(`implement init: design doc unreadable: ${designPath}`); return 1; }
  const text = readFileSync(designPath, "utf8");
  const topic = parsed.topic || deriveTopicFromPath(designPath);
  if (!topic) { log.error("implement init: could not derive topic; pass --topic <slug>"); return 1; }
  if (!assertImplementTopic(topic)) { log.error(`implement init: invalid topic slug '${topic}' (must match ^[a-z0-9][a-z0-9-]{0,31}$, <= 32 chars; pass a shorter --topic)`); return 2; }

  const ad = auditDoc(text);
  if (ad.verdict === "FAIL") {
    for (const i of ad.issues) process.stderr.write(`ISSUE=${i}\n`);
    if (!parsed.force) { log.error(`implement init: audit FAILED on ${designPath}`); return 1; }
    log.warn(`implement init: audit FAILED on ${designPath} but --force given; proceeding`);
  }

  const art = implementArtDir(topic);
  if (existsSync(art)) { log.error(`implement init: topic already in flight: ${art} (run /ap:stop or pick a different --topic)`); return 2; }

  // The target is the repo root UNLESS the caller named one. A detached run's `job start` forks an
  // isolated worktree and passes it here, so the worker's branch checkout never lands in the main
  // checkout the operator is still working in. Everything downstream already flows from
  // target_cwd.txt, so this one assignment re-homes the whole run.
  const targetCwd = parsed.target || d.repoRoot();
  if (parsed.target) {
    const bad = targetProblem(parsed.target);
    if (bad) { log.error(`implement init: ${bad}`); return 1; }
  }
  const provider = detectProvider(targetCwd);

  mkdirSync(art, { recursive: true });
  atomicWrite(join(art, "design.md"), text);
  atomicWrite(join(art, "topic.txt"), topic);                       // NO trailing newline
  atomicWrite(join(art, "target_cwd.txt"), targetCwd + "\n");
  atomicWrite(join(art, "provider.txt"), provider + "\n");
  atomicWrite(join(art, "auto_provider.txt"), provider + "\n");   // deploy claude-confirm marker (the auto-detected provider)

  log.ok(`implement init: topic=${topic} provider=${provider}`);
  process.stdout.write(`ART=${art}\nTOPIC=${topic}\nPROVIDER=${provider}\nTARGET_CWD=${targetCwd}\n`);
  // Which cited paths this run cannot SEE. A detached run's worktree forks committed HEAD, so an
  // uncommitted file — twice now the design doc itself — exists where the operator is standing and
  // nowhere the worker can read. Reported only when a `--target` actually moved the run: with no
  // target the two roots are the same directory and the answer is always empty, so an attached run's
  // stdout stays byte-identical.
  //
  // rc is deliberately UNCHANGED (0): this is a report, not a gate. And it is written to disk as
  // well as printed, because stdout is gone after the reading hub's turn ends — the layer that knows
  // records its own verdict where the next layer can still read it.
  if (parsed.target && targetCwd !== d.repoRoot()) {
    const invisible = pathsInvisibleInTarget(text, d.repoRoot(), targetCwd);
    process.stdout.write(`INVISIBLE_IN_TARGET=${invisible.length}\n`);
    for (const p of invisible) process.stdout.write(`INVISIBLE_PATH=${p}\n`);
    atomicWrite(join(art, "path-lint.txt"),
      `MAIN_ROOT=${d.repoRoot()}\nTARGET_CWD=${targetCwd}\nINVISIBLE_IN_TARGET=${invisible.length}\n` +
      invisible.map((p) => `INVISIBLE_PATH=${p}\n`).join(""));
  }
  return 0;
}

// ---- set-provider — the ONE mechanical way an override reaches the file the turn verbs route by ----
// `init` writes provider.txt (routing) and auto_provider.txt (detection evidence) from one detection.
// Every override after that — the claude-confirm gate's "fall back to codex", a detached job.json
// naming a provider — used to change only the SPAWN, leaving provider.txt naming a model no worker
// dir exists for, so turn-send dispatched at a phantom `lead-<model>` and failed (the first detached
// dogfood repaired it by hand-editing the file). auto_provider.txt is deliberately NOT touched: it
// records what detection SAID, this records what was CHOSEN, and one fact belongs in one file.
async function setProviderRun(rest: string[]): Promise<number> {
  // `--reason <r>` marks the override as the directive's PROVIDER FALLBACK (0.5.64): the same
  // rewrite, plus the artifact + the flag on the run's issue + a `PROVIDER=` line the hub rebinds
  // from. Without the flag every byte of this verb's behaviour is what it was before.
  const { pos, reason, badReason } = parseSetProviderArgs(rest);
  const [topic, provider] = pos;
  if (!topic || !provider || pos.length !== 2 || badReason) { log.error("usage: implement set-provider <topic> <provider> [--reason <pane_dead|timeout>]"); return 2; }
  if (!assertImplementTopic(topic)) { log.error(`implement set-provider: invalid topic slug '${topic}' (must match ^[a-z0-9][a-z0-9-]{0,31}$, <= 32 chars)`); return 2; }
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement set-provider: ${art} not found — run implement init first`); return 1; }
  if (!agentBinary(provider)) { log.error(`implement set-provider: unknown provider '${provider}' — contracts.yaml defines: ${listAgents().join(", ")}`); return 2; }
  if (reason !== undefined && !FALLBACK_REASONS.has(reason)) { log.error(`implement set-provider: unknown --reason '${reason}' — accepted: pane_dead, timeout`); return 2; }
  const from = readField(join(art, "provider.txt")) || "unknown";
  atomicWrite(join(art, "provider.txt"), provider + "\n");
  if (reason !== undefined) {
    recordProviderFallback("implement", art, topic, from, provider, reason);
    process.stdout.write(`PROVIDER=${provider}\n`);
  }
  log.ok(`implement set-provider: topic=${topic} provider=${provider}`);
  return 0;
}

// ---- turn-send (deploy-turn-send.sh) — offset-before-send dispatch ----
export interface ImplementSendDeps { offsetFor(i: string, m: string, t: string): number; send(args: string[]): Promise<number>; }
const liveSendDeps: ImplementSendDeps = { offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)), send: sendRun };
/** The `<topic> <round> [--agent <a>]` head both turn verbs parse, or the rc to return. One parser
 *  so the two verbs cannot drift on which rounds a slice may be sent (D7: round 1 only) and which
 *  turns are the lead's alone (the four named ones). */
interface TurnArgs { topic: string; round: number | string; agent: string; rest: string[] }
function parseTurnArgs(rest: string[], verb: string): TurnArgs | number {
  let agent = WORKER; const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--agent" || t.startsWith("--agent=")) { const { value, shift } = kvParse(t, rest[i + 1]); agent = value; if (shift === 2) i++; continue; }
    pos.push(t);
  }
  const [topic, roundStr, ...extra] = pos;
  if (!topic || !roundStr) { log.error(`usage: implement ${verb} <topic> <round> [--agent <agent>]`); return 2; }
  if (!ROUND_RE.test(roundStr)) { log.error(`implement ${verb}: round must be a positive integer or one of ${NAMED_ROUNDS.join(", ")} (got: ${roundStr})`); return 1; }
  const named = (NAMED_ROUNDS as readonly string[]).includes(roundStr);
  if (agent !== WORKER) {
    if (named) { log.error(`implement ${verb}: the ${roundStr} turn is ${WORKER}-only — a slice runs round 1 and nothing else`); return 2; }
    if (roundStr !== "1") { log.error(`implement ${verb}: a slice runs round 1 only; rounds >= 2 are ${WORKER}'s serial fix loop`); return 2; }
  }
  return { topic, round: named ? roundStr : Number(roundStr), agent, rest: extra };
}

/** Resolve the model a turn verb addresses. The lead's comes from `provider.txt` and is reconciled
 *  against the spawned worker; a SLICE's comes from its own worker dir, because a per-slice
 *  codex->claude fallback never touches the run's `provider.txt`. "" = no such worker. */
function turnModel(art: string, topic: string, agent: string, verb: string): string | null {
  if (agent === WORKER) {
    const model = workerModel(art);
    return assertLeadMatches(topic, model, verb) ? model : null;
  }
  const model = resolveModel(agent, topic);
  if (model === null) { log.error(`implement ${verb}: no worker for agent=${agent} on topic=${topic} — was the slice spawned?`); return null; }
  return model;
}

async function turnSendRun(rest: string[]): Promise<number> {
  const a = parseTurnArgs(rest, "turn-send");
  if (typeof a === "number") return a;
  // `turn-send <topic> grill @<file>`: the hub's own text — what it was trying to group and why.
  const hubFile = a.rest[0]?.startsWith("@") ? a.rest[0].slice(1) : undefined;
  return turnSendWith(a.topic, a.round, liveSendDeps, a.agent, hubFile);
}
export async function turnSendWith(topic: string, round: number | string, d: ImplementSendDeps, agent = WORKER, hubFile?: string): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement turn-send: ${art} not found — run implement init first`); return 1; }
  const model = turnModel(art, topic, agent, "turn-send");
  if (model === null) return 1;
  // A slice runs in its OWN worktree, so its suite is detected there — the same repo, hence the
  // same answer, but stated so the composer reads the tree it names.
  const cwd = agent === WORKER ? readIfExists(join(art, "target_cwd.txt")).trim() : sliceWorktreePathFor(repoRoot(), topic, agent);
  const testCmd = cwd ? detectTestCommand(cwd) : "";
  const stateFile = join(art, `turn-${agent}-${round}.txt`);
  if (existsSync(stateFile)) { log.error(`implement turn-send: ${stateFile} already exists; rm to retry`); return 1; }
  if (!workerSendGate(agent, model, topic, "implement turn-send", "turn")) return 1;
  const prompt = composeTurnPrompt(art, topic, agent, round, testCmd, hubFile);
  if (prompt === null) return 1;
  const promptFile = join(art, `${agent}_turn_prompt_${round}.md`);
  atomicWrite(promptFile, prompt);
  const offset = d.offsetFor(agent, model, topic);             // BEFORE send (deploy_send_dispatch order)
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`implement turn-send: send failed (rc=${rc}); ${stateFile} kept (rm to retry)`); return 1; }
  log.info(`[turn-send] ${agent} round=${round} offset=${offset}`); return 0;
}

/** The prompt for one turn, or null when its inputs are not on disk (the error is already logged).
 *  The lead's numbered rounds are byte-identical to 0.5.68 — every other arm is a parallel-phase
 *  turn, whose composer takes the log paths explicitly because N slices share one art dir. */
function composeTurnPrompt(art: string, topic: string, agent: string, round: number | string, testCmd: string, hubFile?: string): string | null {
  const designPath = join(art, "design.md"), planPath = join(art, "plan.md");
  const verifyPath = reportPathFor(art, round, agent);
  const stem = stemFor(agent, round);
  const testLog = join(art, `test-output-${stem}.log`);
  const durationLog = join(art, `worker-test-duration-${stem}.txt`);
  if (round === "plan") return composePlanPrompt({ designPath, planPath, maxSlices: MAX_SLICES });
  if (round === "grill") {
    if (!hubFile) { log.error("usage: implement turn-send <topic> grill @<file>  (the file holds the hub's grouping and why)"); return null; }
    const hubText = readIfExistsOrNull(hubFile);
    if (hubText === null) { log.error(`implement turn-send: grill text not found: ${hubFile}`); return null; }
    const refusals = splitLines(readIfExists(join(art, "slice-refusals.txt")));
    if (!refusals.length) { log.error(`implement turn-send: no slice-refusals.txt under ${art} — the grill turn exists to answer a slice-check refusal`); return null; }
    return composeGrillPrompt({ hubText, planPath, refusalLines: refusals });
  }
  if (round === "prelude") {
    const ids = readIfExists(join(art, "prelude.txt")).split(/[,\s]+/).filter(Boolean);
    if (!ids.length) { log.error(`implement turn-send: prelude.txt is empty or missing under ${art} — an empty prelude has no turn`); return null; }
    return composePreludePrompt({ designPath, planPath, preludeIds: ids, verifyPath, testLog, durationLog, testCmd });
  }
  if (round === "absorb") {
    const parsed = parsePlanTasks(readIfExists(planPath));
    const issuesText = absorbIssues({
      topic, rows: readSlices(join(art, "slices.tsv")), integrate: readIntegrate(join(art, "integrate-1.tsv")),
      reportTextFor: (a) => readIfExists(evidencePathFor(art, 1, a)),
      planTasks: parsed.ok ? parsed.tasks : [],
    });
    // Symmetric with the prelude arm above: G takes the absorb turn only when the slices LEFT
    // something, and an empty ISSUES block is a turn that asks the lead to absorb nothing.
    if (!issuesText) { log.error(`implement turn-send: nothing to absorb — slices.tsv, integrate-1.tsv and the slice reports under ${art} are clean`); return null; }
    return composeAbsorbPrompt({ designPath, planPath, issuesText, verifyPath, testLog, durationLog, testCmd });
  }
  if (agent !== WORKER) {
    const mandateText = readIfExistsOrNull(join(art, `slice-${agent}.md`));
    if (mandateText === null) { log.error(`implement turn-send: slice-${agent}.md not found under ${art}; run implement slice-check first`); return null; }
    return composeSliceRound1Prompt({ designPath, planPath, mandateText, verifyPath, testLog, durationLog, testCmd });
  }
  if (round === 1) return composeRound1Prompt({ designPath, planPath, verifyPath, round, testCmd });
  const bundle = join(art, `fix-prompt-${round}.md`);
  if (!existsSync(bundle)) { log.error(`implement turn-send: fix-prompt-${round}.md not found at ${bundle}; the directive must write it first`); return null; }
  return composeFixPrompt(round as number, readFileSync(bundle, "utf8"), verifyPath, testCmd);
}
/** Non-empty lines of a state artifact, trimmed. */
function splitLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

// ---- turn-wait (deploy-turn-wait.sh) — rc 0 ALWAYS; TS= carries outcome ----
/** `now` is NOT a clock: it stamps the question payload's ASKED_AT in epoch SECONDS. The wait's
 *  own time source is `clock`. */
export interface ImplementWaitDeps {
  wait?: WaitFn; clock?: Clock; multiplier(model: string): string; now(): number;
  /** The premature-`done` hold's re-armed wait (J). Left unset by the live verb — the default IS
   *  `liveRearm`, i.e. `awaitTurn` again on the pane-probed wait (src/core/implementHold.ts).
   *  Tests script it the way they script `wait`. */
  rearm?: RearmFn;
}
const liveWaitDeps: ImplementWaitDeps = { multiplier: agentTimeoutMultiplier, now: () => Math.floor(Date.now() / 1000) };
async function turnWaitRun(rest: string[]): Promise<number> {
  const a = parseTurnArgs(rest, "turn-wait");
  if (typeof a === "number") return a;
  return turnWaitWith(a.topic, a.round, liveWaitDeps, a.agent);
}
export async function turnWaitWith(topic: string, round: number | string, d: ImplementWaitDeps, agent = WORKER): Promise<number> {
  const art = implementArtDir(topic);
  const model = turnModel(art, topic, agent, "turn-wait");
  if (model === null) return 1;
  const stateFile = join(art, `turn-${agent}-${round}.txt`);
  if (!existsSync(stateFile)) { log.error(`implement turn-wait: ${stateFile} missing — run implement turn-send first`); return 1; }
  const budget = round === "plan" || round === "grill" ? PLAN_TURN_TIMEOUT() : IMPLEMENT_TURN_TIMEOUT();
  const timeout = scaledTimeout(budget, d.multiplier(model));
  const clock = d.clock ?? realClock;
  const startMs = clock.now();
  // The confirmation layer's flags name the MODEL, which with N workers on one provider no longer
  // identifies the worker — so every flag this wait produces is prefixed with the agent.
  const agentFlag = (note: string): void => { recordHubFlag({ command: "implement", topic, note: `${agent}: ${note}` }); };
  const r = await awaitTurn({
    agent, model, topic, stateFile, timeoutS: timeout,
    label: "[turn-wait]", policy: { confirm: true },
  }, {
    wait: d.wait, clock: d.clock,
    onArmed: (offset) => { log.info(`[turn-wait] ${agent} round=${round} offset=${offset} timeout=${timeout}s`); },
    onFlag: agentFlag,
  });
  if ("missingOffset" in r) { log.error(`implement turn-wait: OFFSET not set in ${stateFile}`); return 1; }
  // The turn's COMPLETION EVIDENCE, which is per turn and not per round token: the plan and grill
  // turns write plan.md and no report at all, a slice writes a per-agent one.
  const evidencePath = evidencePathFor(art, round, agent);
  // J: a `done` whose evidence is absent is HELD, not failed — the worker that emits `done`
  // per task is still working. The hold needs a pane to watch: an unverifiable pane record
  // (paneMetaRead null, or no ownership nonce) is not evidence to act on, so it takes today's
  // `failed` at once, as does `AP_IMPLEMENT_PREMATURE_DONE_S=0`.
  const idleS = prematureDoneS();
  const pane = paneMetaRead(agent, model, topic);
  let ev = r.event;
  if (idleS > 0 && pane?.nonce) {
    const probe = paneIdleProbe({ capture: () => capturePane(pane.paneId), now: clock.now, idleS });
    const ctx = { agent, model, topic, stateFile, round };
    // NOT `agentFlag`: the hold's own note already names the agent.
    const onFlag = (note: string): void => { recordHubFlag({ command: "implement", topic, note }); };
    ev = await holdPrematureDone(ev, ctx, {
      evidencePath, deadlineMs: startMs + timeout * 1000, now: clock.now,
      rearm: d.rearm ?? liveRearm(ctx, { pane, probe, clock, onFlag: agentFlag }), onFlag,
    });
  }
  // Lead lines, written AHEAD of the terminal TS= so it stays the file's last line. `PANE=died`
  // because nothing else carries the engine's synthetic pane death out of this process, and
  // `PLAN=unparseable` so the hub can tell "no plan" from "a plan the verb cannot read".
  const leadLines: string[] = [];
  if (ev?.event === "error" && ev.note === PANE_DIED_NOTE) leadLines.push("PANE=died");
  let evidenceText = readIfExistsOrNull(evidencePath);
  if (round === "plan" || round === "grill") {
    const parsed = evidenceText === null ? null : parsePlanTasks(evidenceText);
    const usable = parsed !== null && parsed.ok && parsed.tasks.length >= 2;
    if (parsed !== null && !usable) leadLines.push("PLAN=unparseable");
    if (!usable) evidenceText = null;      // a plan the verb cannot read is not completion evidence
  }
  let ts = implementState(ev, evidenceText);
  let question: { file: string; body: string; extraLines?: string } | undefined;
  if (ts === "question" && ev) {
    const payload = extractQuestionPayload(ev, d.now());
    if (payload !== null) {
      const objLine = parseQuestionPayload(payload).route === "objection"
        ? `OBJECTIONS=${latestObjections(stateFile) + 1}\n` : "";
      question = { file: join(art, `question-${agent}-${round}.txt`), body: payload, extraLines: objLine };
    } else { ts = "failed"; log.warn("[turn-wait] malformed question (no message); downgraded to failed"); }
  }
  recordWaitOutcome(agent, model, topic, stateFile, ts, "TS", question, leadLines.length ? leadLines.join("\n") : undefined);
  writeFileSync(join(art, `turn-${agent}-${round}.done`), "");
  log.ok(`[turn-wait] ${agent} round=${round} TS=${ts}`); return 0;
}

// ---- reset-status — force a not-idle worker back to idle (deploy "Force-retry" recovery) ----
// The not-idle gate in turnSendWith refuses when status.json state != idle. After a timed-out
// turn the worker is left non-idle; the directive calls this to force-reset so the retry can send.
async function resetStatusRun(rest: string[]): Promise<number> {
  const [topic, agent] = rest;
  if (!topic || !agent || rest.length !== 2) { log.error("usage: implement reset-status <topic> <agent>"); return 2; }
  const model = resolveModel(agent, topic);
  if (model === null) { log.error(`implement reset-status: no worker for agent=${agent} on topic=${topic}`); return 1; }
  atomicWrite(statusPath(agent, model, topic), `{"state":"idle","last_event":"force-reset"}\n`);
  log.ok(`implement reset-status: ${agent} state=idle`);
  return 0;
}

// ---- the parallel-slices verbs (2026-09-04-parallel-slices-design.md, B / D / E / F / G) -------
// Five thin adapters: the grouping check, the sequential fan-out, one abandonment, the barrier, and
// the fan-in. Everything each of them DECIDES lives in a core module; what is here is the CLI shape
// — argument validation, the art-dir reads, the `KEY=value` stdout, and the rc.

const SLICES_TSV = "slices.tsv";

export interface SliceCheckDeps { agentsFor(topic: string, n: number): string[]; root(): string }
const liveSliceCheckDeps: SliceCheckDeps = { agentsFor: pickAgents, root: repoRoot };
async function sliceCheckRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic || rest.length !== 1) { log.error("usage: implement slice-check <topic>"); return 2; }
  return sliceCheckWith(topic, liveSliceCheckDeps);
}
/** Check the hub's grouping (slice-plan.md) against the lead's plan (plan.md) and, when it stands,
 *  write the roster every later slice verb reads plus one mandate per slice.
 *
 *  A refusal writes the refusal LINES (and nothing else): stdout is gone by the time `turn-send
 *  grill` composes the turn that answers them, and a layer records its own verdict where the next
 *  layer can still read it. `SLICES` of 0 or 1 is rc 0 — the directive takes the serial path. */
export async function sliceCheckWith(topic: string, d: SliceCheckDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement slice-check: ${art} not found — run implement init first`); return 1; }
  const planText = readIfExistsOrNull(join(art, "plan.md"));
  if (planText === null) { log.error(`implement slice-check: plan.md missing under ${art} — run the plan turn first`); return 1; }
  const slicePlan = readIfExistsOrNull(join(art, "slice-plan.md"));
  if (slicePlan === null) { log.error(`implement slice-check: slice-plan.md missing under ${art} — the Hub writes its decided grouping there`); return 1; }
  const base = readIfExists(join(art, "target_cwd.txt")).trim() || d.root();
  const res = checkSlicePlan({
    plan: planText, slicePlan, existingRows: readSlices(join(art, SLICES_TSV)),
    agentsFor: (n) => d.agentsFor(topic, n),
    fileExists: (p) => existsSync(join(base, p)),
  });
  for (const w of res.warnings) process.stdout.write(w + "\n");
  if (!res.ok) {
    atomicWrite(join(art, "slice-refusals.txt"), res.refusals.join("\n") + "\n");
    for (const r of res.refusals) process.stdout.write(r + "\n");
    log.error(`implement slice-check: ${res.refusals.length} refusal(s) — send them to the lead with: implement turn-send ${topic} grill @<file>`);
    return 1;
  }
  const model = workerModel(art);
  const parsed = parsePlanTasks(planText);
  const tasks = parsed.ok ? parsed.tasks : [];
  const rows: SliceRow[] = res.slices.map((s, i) => ({ agent: res.agents[i], model, label: s.label, status: "planned", tasks: s.tasks, files: s.files }));
  writeSlices(join(art, SLICES_TSV), rows);
  for (const [i, s] of res.slices.entries()) {
    atomicWrite(join(art, `slice-${res.agents[i]}.md`), sliceMandate(s, tasks, sliceWorktreePathFor(d.root(), topic, res.agents[i])));
  }
  if (res.prelude.length) atomicWrite(join(art, "prelude.txt"), res.prelude.join(", ") + "\n");
  process.stdout.write(`SLICES=${rows.length}\nPRELUDE=${res.prelude.length ? 1 : 0}\nAGENTS=${rows.map((r) => r.agent).join(",")}\n`);
  log.ok(`implement slice-check: ${rows.length} slice(s), prelude=${res.prelude.length}`);
  return 0;
}

async function spawnSlicesRun(rest: string[]): Promise<number> {
  const pos = rest.filter((t) => t !== "--retry");
  const retry = rest.includes("--retry");
  if (pos.length !== 1 || !pos[0]) { log.error("usage: implement spawn-slices <topic> [--retry]"); return 2; }
  return spawnSlicesWith(pos[0], retry, liveSpawnSlicesDeps);
}
export type SpawnSlicesAdapterDeps = (topic: string, root: string, runCwd: string) => SpawnSlicesDeps;
/** Exported for the wiring test: which RUNNER each git call goes through — the root's or the run
 *  worktree's — is what a wrong root would silently break (C), and it is invisible to every test
 *  that injects its own adapter. */
export const liveSpawnSlicesDeps: SpawnSlicesAdapterDeps = (topic, root, runCwd) => {
  const rootRunner = runnerAt(root);
  return {
    root, rootRunner, runRunner: runnerAt(runCwd),
    windowRows: () => windowHeight(process.env.TMUX_PANE || undefined),
    layout: async () => {
      try { const t = process.env.TMUX_PANE; if (t) await selectLayoutMainVertical(t); }
      catch { /* layout is cosmetic; the pane is up */ }
    },
    spawn: (argv) => spawnRun(argv),
    stop: (agent) => stopRun([agent, topic]),
    provision: (worktree) => { provisionWorktree(root, worktree, rootRunner); },
    flag: (note) => { recordHubFlag({ command: "implement", topic, note }); },
  };
};
/** Fan out: a worktree, a branch and a pane per planned slice, one at a time.
 *
 *  Detached-only by construction (D2): slices branch from the RUN worktree's HEAD, so a job with no
 *  record — or a `--no-worktree` one, which runs in the operator's live checkout — is refused rc 2
 *  and the directive takes the serial path. */
export async function spawnSlicesWith(topic: string, retry: boolean, mk: SpawnSlicesAdapterDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement spawn-slices: ${art} not found — run implement init first`); return 2; }
  const rec = parseJob(readIfExists(jobPath(topic)));
  if (!rec) { log.error(`implement spawn-slices: no detached job record for '${topic}' (${jobPath(topic)}) — slices are detached-only`); return 2; }
  if (!rec.worktree) { log.error(`implement spawn-slices: this job runs with --no-worktree — slices fork a run worktree, never the operator's live checkout`); return 2; }
  const runCwd = readIfExists(join(art, "target_cwd.txt")).trim();
  if (!runCwd) { log.error(`implement spawn-slices: target_cwd.txt missing under ${art}`); return 2; }
  const out = await spawnSlices(topic, art, retry, mk(topic, repoRoot(), runCwd));
  if (!out.ok) {
    for (const l of out.refusals) process.stdout.write(l + "\n");
    log.error(`implement spawn-slices: refused, nothing spawned — commit or resolve what the lines above name, then re-run`);
    return 1;
  }
  process.stdout.write(`SPAWNED=${out.spawned.length}\nFALLBACK=${out.fallback.join(",")}\nFAILED=${out.failed.join(",")}\n`);
  log.ok(`implement spawn-slices: ${out.spawned.length} spawned, ${out.failed.length} failed (rc=${out.rc})`);
  return out.rc;
}

export interface AbandonSliceDeps { stop(agent: string, topic: string): Promise<number> }
const liveAbandonDeps: AbandonSliceDeps = { stop: (agent, topic) => stopRun([agent, topic]) };
async function abandonSliceRun(rest: string[]): Promise<number> {
  const [topic, agent, reason] = rest;
  if (!topic || !agent || !reason || rest.length !== 3) { log.error(`usage: implement abandon-slice <topic> <agent> <${ABANDON_REASONS.join("|")}>`); return 2; }
  if (!(ABANDON_REASONS as readonly string[]).includes(reason)) { log.error(`implement abandon-slice: unknown reason '${reason}' — accepted: ${ABANDON_REASONS.join(", ")}`); return 2; }
  return abandonSliceWith(topic, agent, reason as AbandonReason, liveAbandonDeps);
}
/** Retire one slice. Its worktree and branch are LEFT for `job stop`'s sweep: anything it committed
 *  survives, and `integrate` still merges the branch if it has commits — an abandoned slice's
 *  partial work is not thrown away. */
export async function abandonSliceWith(topic: string, agent: string, reason: AbandonReason, d: AbandonSliceDeps): Promise<number> {
  const art = implementArtDir(topic);
  const roster = join(art, SLICES_TSV);
  const rows = readSlices(roster);
  const row = rows.find((r) => r.agent === agent);
  if (!row) { log.error(`implement abandon-slice: no slice row for agent '${agent}' on topic '${topic}' (${roster})`); return 1; }
  const wasSpawned = row.status === "spawned";
  row.status = `abandoned:${reason}` as SliceStatus;
  writeSlices(roster, rows);
  if (wasSpawned) await d.stop(agent, topic);
  recordHubFlag({ command: "implement", topic, note: `slice-abandoned: ${agent} (${row.label}) ${reason}` });
  process.stdout.write(`ABANDONED=${agent}\nREASON=${reason}\n`);
  log.ok(`implement abandon-slice: ${agent} ${reason}`);
  return 0;
}

async function sliceGateRun(rest: string[]): Promise<number> {
  const [topic, round] = rest;
  if (!topic || !round || rest.length !== 2) { log.error("usage: implement slice-gate <topic> <round>"); return 2; }
  if (!/^[1-9][0-9]*$/.test(round)) { log.error(`implement slice-gate: round must be a positive integer (got: ${round})`); return 2; }
  const art = implementArtDir(topic);
  const rows = readSlices(join(art, SLICES_TSV));
  let live = 0, ok = 0;
  for (const r of rows) {
    const st = sliceGateState(art, r, round);
    process.stdout.write(`${r.agent}\t${r.label}\t${st}\n`);
    if (st === "abandoned") continue;
    live++;
    if (st === "ok") ok++;
  }
  // A gate over zero live slices is rc 1, never vacuously green: it blocks nothing itself — the
  // Monitors do the waiting — so the only thing it can be wrong about is saying the wave is done.
  return live > 0 && ok === live ? 0 : 1;
}
/** One slice's state for the barrier: the roster's `abandoned`, a hold in progress (the state
 *  file's last line is the hold's own `PD=`), the last `TS=`, or `pending`. */
function sliceGateState(art: string, row: SliceRow, round: string): string {
  if (row.status.startsWith("abandoned:")) return "abandoned";
  const text = readIfExistsOrNull(join(art, `turn-${row.agent}-${round}.txt`));
  if (text === null) return "pending";
  const lines = splitLines(text);
  if (lines.at(-1)?.startsWith("PD=")) return "held";
  const ts = [...text.matchAll(/^TS=(.*)$/gm)].at(-1);
  return ts ? ts[1].trim() : "pending";
}

async function integrateRun(rest: string[]): Promise<number> {
  const [topic, round] = rest;
  if (!topic || !round || rest.length !== 2) { log.error("usage: implement integrate <topic> <round>"); return 2; }
  if (!/^[1-9][0-9]*$/.test(round)) { log.error(`implement integrate: round must be a positive integer (got: ${round})`); return 2; }
  return integrateWith(topic, round, liveScopeDeps);
}
/** Fan in: merge each finished slice branch into `feat/implement-<topic>`. A REPORT, not a gate —
 *  rc 0 whatever the per-slice outcomes, the `scope-check` discipline — except when an aborted merge
 *  left the tree dirty, which needs eyes before Stage 2 runs a suite in it. */
export async function integrateWith(topic: string, round: string, d: ScopeDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement integrate: ${art} not found — run implement init first`); return 1; }
  const cwd = targetCwd(topic);
  if (!cwd) { log.error(`implement integrate: target_cwd.txt missing under ${art}`); return 1; }
  const out = integrateSlices(topic, readSlices(join(art, SLICES_TSV)), d.runnerFor(cwd));
  if (!out.ok) {
    for (const l of out.refusals) process.stdout.write(l + "\n");
    log.error(`implement integrate: precondition refused in ${cwd} — the run branch must be checked out and its tracked files clean; nothing was merged`);
    return 1;
  }
  writeIntegrate(join(art, `integrate-${round}.tsv`), out.rows);
  const of = (s: string): string[] => out.rows.filter((r) => r.status === s).map((r) => r.agent);
  const skipped = out.rows.filter((r) => r.status.startsWith("skipped")).map((r) => r.agent);
  process.stdout.write(`MERGED=${of("merged").length}\nCONFLICT=${of("conflict").join(",")}\nEMPTY=${of("empty").join(",")}\nSKIPPED=${skipped.join(",")}\n`);
  log.ok(`implement integrate: round=${round} ${of("merged").length} merged, ${of("conflict").length} conflicted, ${skipped.length} skipped`);
  return out.rc;
}

// ---- pre-snapshot (deploy-pre-snapshot.sh) ----
async function preSnapshotRun(rest: string[]): Promise<number> {
  if (rest.length !== 1) { log.error("usage: implement pre-snapshot <topic>"); return 2; }
  return preSnapshotWith(rest[0], {}, runnerAt);
}
export async function preSnapshotWith(topic: string, opts: { home?: string; cwd?: string }, runnerFor: (cwd: string) => Runner): Promise<number> {
  const art = implementArtDir(topic, opts);
  if (!existsSync(art)) { log.error(`implement pre-snapshot: art-dir missing: ${art} (run implement init first)`); return 1; }
  mkdirSync(join(art, "baselines"), { recursive: true });
  let clean = 0, committed = 0, blocked = 0;
  const cwd = targetCwd(topic, opts);
  if (cwd) {
    const snap = preSnapshot(runnerFor(cwd), "implement", topic);
    if (snap.state === "not-git") { log.error(`implement pre-snapshot: not a git repository: ${cwd}`); return 2; }
    atomicWrite(join(art, "baselines", "main.tsv"),
      `slug=main\ncwd=${cwd}\nbranch=${snap.branch}\nbaseline_sha=${snap.baseSha}\nstate=${snap.state}\nsnapshot_ts=${isoUtc()}\n`);
    if (snap.state === "clean") clean++; else if (snap.state === "wip-committed") committed++; else if (snap.state === "hook-blocked") blocked++;
  }
  log.ok(`implement pre-snapshot: ${clean} clean, ${committed} committed, ${blocked} hook-blocked`); return 0;
}

// ---- branch (deploy-branch.sh) ----
async function branchRun(rest: string[]): Promise<number> {
  let noBranch = false, branchName: string | undefined; const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) { const t = rest[i];
    if (t === "--no-branch") { noBranch = true; continue; }
    if (t === "--branch" || t.startsWith("--branch=")) { const { value, shift } = kvParse(t, rest[i + 1]); branchName = value; if (shift === 2) i++; continue; }
    pos.push(t); }
  if (pos.length !== 1) { log.error("usage: implement branch [--no-branch] [--branch <name>] <topic>"); return 2; }
  return branchWith({ topic: pos[0], noBranch, branchName }, {}, runnerAt);
}
/** The stale-branch refusal, shared by branchWith's resume and create arms. ap deletes, renames and
 *  force-updates nothing — the branch is the operator's work, so this only reports and names the
 *  three ways forward. */
function staleBranchRefusal(branch: string, cwd: string): void {
  log.error(`implement branch: ${branch} already exists in ${cwd} and has diverged from the current HEAD (its commits are likely already merged, e.g. by a squash merge) — refusing to resume it`);
  log.error(`  delete it (git -C ${cwd} branch -D ${branch}), rename it (git -C ${cwd} branch -m ${branch} <new-name>), or check it out by hand and re-run`);
}
export async function branchWith(a: { topic: string; noBranch: boolean; branchName?: string }, opts: { home?: string; cwd?: string }, runnerFor: (cwd: string) => Runner): Promise<number> {
  const art = implementArtDir(a.topic, opts);
  if (!existsSync(art)) { log.error(`implement branch: art-dir missing: ${art} (run implement init first)`); return 1; }
  const defaultBranch = a.branchName ?? branchNameFor("implement", a.topic);
  // Refuse BEFORE writing anything, on either baseline a finish cannot come back from: the feat
  // branch itself (the hub checked it out before pre-snapshot, so baseline and work branch are one
  // ref and every finish action is a no-op), or a detached HEAD (no branch to restore, and a merge
  // would integrate into whatever HEAD happens to be).
  const cwd = targetCwd(a.topic, opts);
  if (!a.noBranch && cwd) {
    const baselineBranch = kvField(join(art, "baselines", "main.tsv"), "branch");
    if (baselineBranch === defaultBranch) {
      log.error(`implement branch: HEAD was already ${defaultBranch} at pre-snapshot; checkout the intended base branch, re-run pre-snapshot, then branch, or pass --no-branch if implementing on the current branch is intended`);
      return 1;
    }
    if (baselineBranch === "(detached)") {
      log.error("implement branch: pre-snapshot recorded a detached HEAD, which has no restorable start branch; checkout a branch, re-run pre-snapshot, then branch");
      return 1;
    }
  }
  let row = "";
  if (cwd) {
    const r = runnerFor(cwd); let recorded: string;
    if (a.noBranch) { recorded = currentBranch(r) || "(detached)"; log.info(`branch: (--no-branch) staying on ${recorded} in ${cwd}`); }
    else if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${defaultBranch}`]).code === 0) {
      // Resume arm. A leftover branch from a SQUASH-merged run of this same topic is not a
      // continuation of this checkout; resuming it would re-propose merged work. Refuse before the
      // records below are written, the way the two baseline refusals above do. ap touches no branch.
      if (createOrResumeBranch(r, defaultBranch) === "stale") { staleBranchRefusal(defaultBranch, cwd); return 1; }
      log.info(`branch: resumed ${defaultBranch} in ${cwd}`); recorded = defaultBranch;
    }
    else {
      // Create arm: the ref was absent a line ago, so `stale` is unreachable here — but it is
      // spelled out rather than folded into a truthiness test, so it can never read as success.
      const outcome = createOrResumeBranch(r, defaultBranch);
      if (outcome === "stale") { staleBranchRefusal(defaultBranch, cwd); return 1; }
      if (outcome === "created") { log.info(`branch: created ${defaultBranch} in ${cwd}`); recorded = defaultBranch; }
      else { recorded = currentBranch(r) || "(detached)"; log.warn(`branch: checkout -b failed in ${cwd}; staying on current branch`); }
    }
    row = `main\t${recorded}`;
    const baseline = join(art, "baselines", "main.tsv");
    if (existsSync(baseline)) { const m = readFileSync(baseline, "utf8").match(/^baseline_sha=(.*)$/m); if (m) atomicWrite(join(art, "branch-base.sha"), m[1] + "\n"); }
  }
  atomicWrite(join(art, "implement-branches.tsv"), row ? row + "\n" : "");
  // The INTENT, recorded: on disk a deliberate --no-branch run and a run that failed to leave the
  // baseline branch look identical, and finish must not read the second as the first.
  atomicWrite(join(art, "branch-mode.txt"), (a.noBranch ? "no-branch" : "branch") + "\n");
  log.ok(`implement branch: ${row ? 1 : 0} target(s) recorded`); return 0;
}

// ---- scope-check (deploy-scope) ----
export interface ScopeDeps { runnerFor(cwd: string): Runner; }
const liveScopeDeps: ScopeDeps = { runnerFor: runnerAt };
async function scopeCheckRun(rest: string[]): Promise<number> { const topic = rest[0]; if (!topic) { log.error("usage: implement scope-check <topic>"); return 2; } return scopeCheckWith(topic, liveScopeDeps); }
/**
 * Scope conformance: collect the diff path set, then match it against the design's declared scope
 * paths. Single-repo: the diff comes from `target_cwd.txt` + `branch-base.sha`.
 */
export async function scopeCheckWith(topic: string, d: ScopeDeps): Promise<number> {
  const art = implementArtDir(topic);
  const designFile = join(art, "design.md");
  const targetFile = join(art, "target_cwd.txt"), baseFile = join(art, "branch-base.sha");
  if (!existsSync(targetFile) || !existsSync(baseFile)) { log.error(`implement scope-check: target_cwd.txt/branch-base.sha missing under ${art}`); return 1; }
  if (!existsSync(designFile)) { log.error(`implement scope-check: design.md missing under ${art}`); return 1; }
  const targetCwd = readField(targetFile);
  const base = readField(baseFile);
  const diffPaths = d.runnerFor(targetCwd).run("git", ["diff", "--name-only", `${base}..HEAD`]).stdout.split("\n").filter((x) => x.length > 0);
  atomicWrite(join(art, "diff-paths.txt"), diffPaths.length ? diffPaths.join("\n") + "\n" : "");
  const design = readFileSync(designFile, "utf8");
  const compPaths = extractComponentsPaths(design);
  const testingPaths = extractTestingPaths(design);
  atomicWrite(join(art, "components-paths.txt"), compPaths.length ? compPaths.join("\n") + "\n" : "");
  atomicWrite(join(art, "testing-paths.txt"), testingPaths.length ? testingPaths.join("\n") + "\n" : "");
  const declaredPaths = [...new Set([...compPaths, ...testingPaths])];
  if (declaredPaths.length === 0) log.warn("scope conformance: design declared 0 parseable scope paths; ALL changed files flagged by default (guard no-op)");
  const oos = matchDiffAgainstComponents(diffPaths, declaredPaths);
  const oosPath = join(art, "scope-out-of-scope.txt");
  atomicWrite(oosPath, oos.length ? oos.join("\n") + "\n" : "");
  if (oos.length > 0) log.warn(`scope conformance: ${oos.length} out-of-scope path(s) detected`);
  // Declared-path precision (2026-08-23-declared-path-precision-design.md): report how much of the
  // declared count is a slash-bearing PROSE fragment rather than a path the matcher can key on, so
  // the number a human weighs `OOS_COUNT` against at Stage 4 is honest. Computed ALONGSIDE
  // `declaredPaths` and deliberately never subtracted from it — `declaredPaths` above is the
  // matcher's input, byte-identical to what it was before this report existed. The two counts are
  // per SECTION (Components / Testing), matching how `TESTING_DECLARED` already reports the Testing
  // section beside the deduped union in `SCOPE_DECLARED`; the artifact holds the deduped union, in
  // declaration order, because stdout is gone once the hub's turn ends.
  const unresolved = unresolvedDeclaredPaths(declaredPaths);
  atomicWrite(join(art, "scope-unresolved.txt"), unresolved.length ? unresolved.join("\n") + "\n" : "");
  process.stdout.write(`SCOPE_DECLARED=${declaredPaths.length}\nTESTING_DECLARED=${testingPaths.length}\nOOS_COUNT=${oos.length}\nOOS_PATH=${oosPath}\nSCOPE_UNRESOLVED=${unresolvedDeclaredPaths(compPaths).length}\nTESTING_UNRESOLVED=${unresolvedDeclaredPaths(testingPaths).length}\n`); return 0;
}

// ---- verify-tests (v1 hub-side independent test re-run, IN-PLACE in target_cwd) ----
export interface VerifyTestsDeps { runner: TestRunner; detect(root: string): string; now(): string; }
const liveVerifyTestsDeps: VerifyTestsDeps = { runner: liveTestRunner, detect: detectTestCommand, now: isoUtc };
function implementTestTimeout(): number { return envNum("AP_IMPLEMENT_TEST_TIMEOUT_S", 1800); }
function maxVerifyS(): number { return envNum("AP_IMPLEMENT_VERIFY_MAX_S", implementTestTimeout()); }
async function verifyTestsRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  if (!topic || !roundStr) { log.error("usage: implement verify-tests <topic> <round>"); return 2; }
  if (!/^[1-9][0-9]*$/.test(roundStr)) { log.error(`implement verify-tests: round must be a positive integer (got: ${roundStr})`); return 2; }
  return verifyTestsWith(topic, Number(roundStr), liveVerifyTestsDeps);
}
/** Hub-side independent test re-run for round <round>. Runs the repo's detected test command in
 *  target_cwd (the worker's branch, in place) and classifies the hub's OWN exit code — UNLESS the
 *  worker's self-reported duration (worker-test-duration-<round>.txt) exceeds the verify budget
 *  (AP_IMPLEMENT_VERIFY_MAX_S, default = the run timeout), in which case it emits VERDICT=skipped
 *  without running (the hub trusts the worker's report rather than ~doubling the wall-clock). A
 *  missing/unparseable duration never skips (fail-safe: verify). Writes hub-test-output-<round>.log
 *  (only when a command actually ran) + hub-verify-<round>.tsv; prints
 *  TESTCMD=/HUB_RC=/WORKER_DURATION_S=/VERDICT= to stdout for the Stage 2 directive. rc 0 always on a
 *  completed run; rc 1 only when the art-dir / target_cwd.txt is missing. */
export async function verifyTestsWith(topic: string, round: number, d: VerifyTestsDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement verify-tests: art-dir missing: ${art}`); return 1; }
  const targetFile = join(art, "target_cwd.txt");
  if (!existsSync(targetFile)) { log.error(`implement verify-tests: target_cwd.txt missing under ${art}`); return 1; }
  const targetCwd = readField(targetFile);
  const testCmd = d.detect(targetCwd);
  const durFile = join(art, `worker-test-duration-${round}.txt`);
  const workerDur = existsSync(durFile) ? parseWorkerDuration(readFileSync(durFile, "utf8")) : null;
  let code: number | null = null;
  let verdict: TestVerdict;
  if (testCmd === "") {
    verdict = "none";                                   // no suite detected — nothing to run or skip
  } else if (shouldSkipVerify(workerDur, maxVerifyS())) {
    verdict = "skipped";                                // worker's suite over budget — trust its report
  } else {
    const r = d.runner.run(targetCwd, testCmd, implementTestTimeout());
    code = r.code;
    atomicWrite(join(art, `hub-test-output-${round}.log`), r.output);
    verdict = classifyTestRun(testCmd, code);
  }
  atomicWrite(join(art, `hub-verify-${round}.tsv`),
    `round=${round}\ntest_cmd=${testCmd}\nhub_rc=${code === null ? "" : code}\nworker_duration_s=${workerDur === null ? "" : workerDur}\nverdict=${verdict}\nverified_ts=${d.now()}\n`);
  process.stdout.write(`TESTCMD=${testCmd || "none"}\nHUB_RC=${code === null ? "" : code}\nWORKER_DURATION_S=${workerDur === null ? "" : workerDur}\nVERDICT=${verdict}\n`);
  log.ok(`implement verify-tests: round=${round} verdict=${verdict}${verdict === "skipped" ? ` (worker=${workerDur}s > ${maxVerifyS()}s)` : testCmd ? ` (rc=${code})` : ""}`);
  return 0;
}

// ---- summary (deploy-summary.sh) ----
export interface SummaryDeps { runnerFor(cwd: string): Runner; now(): string; }
const liveSummaryDeps: SummaryDeps = { runnerFor: runnerAt, now: () => isoUtc() };
async function summaryRun(rest: string[]): Promise<number> { const topic = rest[0]; if (!topic) { log.error("usage: implement summary <topic>"); return 2; } return summaryWith(topic, liveSummaryDeps); }
export async function summaryWith(topic: string, d: SummaryDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement summary: art-dir missing: ${art}`); return 1; }
  mkdirSync(join(art, "posts"), { recursive: true });
  const cwd = targetCwd(topic);
  if (!cwd) return 0;
  const baseline = join(art, "baselines", "main.tsv"), post = join(art, "posts", "main.tsv");
  if (!existsSync(baseline)) { log.error(`implement summary: baseline missing for slug=main (${baseline})`); return 0; }
  let st: ReturnType<typeof statSync> | undefined;
  try { st = statSync(cwd); } catch { /* target unusable (ENOENT/EACCES/ELOOP alike) */ }
  if (!st?.isDirectory()) { log.warn(`implement summary: target gone for slug=main (cwd=${cwd}); omitting block`); return 0; }
  const r = d.runnerFor(cwd); postSweep(r, topic, baseline, post, d.now());
  process.stdout.write(formatSummaryBlock(r, baseline, post) + "\n\n");
  return 0;
}
function postSweep(r: Runner, topic: string, baseline: string, post: string, ts: string): void {
  const slug = kvField(baseline, "slug"), cwd = kvField(baseline, "cwd"), base = kvField(baseline, "branch");
  const postBranch = currentBranch(r) || "(detached)";
  const dirty = r.run("git", ["status", "--porcelain"]).stdout.trim();
  let state: string;
  if (!dirty) state = "no-leftovers";
  else { r.run("git", ["add", "-A"]); state = r.run("git", ["commit", "-q", "-m", `chore: post-implement leftovers for ${topic}`]).code === 0 ? "swept" : (log.warn(`implement post-sweep: commit hook blocked sweep in ${cwd}`), "sweep-failed"); }
  const postSha = r.run("git", ["rev-parse", "HEAD"]).stdout.trim();
  atomicWrite(post, `slug=${slug}\ncwd=${cwd}\nbranch=${postBranch}\npost_sha=${postSha}\nstate=${state}\nbranch_changed=${base === postBranch ? "false" : "true"}\nsweep_ts=${ts}\n`);
}
function formatSummaryBlock(r: Runner, baseline: string, post: string): string {
  const slug = kvField(baseline, "slug"), cwd = kvField(baseline, "cwd"), baseBranch = kvField(baseline, "branch"), baselineSha = kvField(baseline, "baseline_sha"), baseState = kvField(baseline, "state");
  const postBranch = kvField(post, "branch"), postSha = kvField(post, "post_sha"), postState = kvField(post, "state"), changed = kvField(post, "branch_changed");
  const L: string[] = [`=== ${slug} [${cwd}] ===`];
  if (changed === "true") L.push(`  [WARNING: branch changed from ${baseBranch} to ${postBranch}]`);
  if (baseState === "hook-blocked") L.push("  [WARNING: pre-implement snapshot hook-blocked; baseline = pre-attempt HEAD]");
  if (postState === "sweep-failed") L.push("  [WARNING: post-implement sweep hook-blocked; leftovers remain in working tree]");
  if (baseBranch === "(detached)") L.push("  [WARNING: baseline branch detached]");
  L.push(`  branch:     ${postBranch}`); L.push(`  baseline:   ${baselineSha}   ${baseBranch}   (${baseState})`); L.push(`  HEAD:       ${postSha}   ${postBranch}`);
  const stat = shortstat(r, baselineSha);
  L.push(stat ? `  diff stat:  ${stat}` : "  diff stat:  (no changes since baseline)");
  L.push("  commits (oldest -> newest):");
  const commits = r.run("git", ["log", "--reverse", "--oneline", `${baselineSha}..HEAD`]).stdout.replace(/\n+$/, "");
  L.push(commits ? commits.split("\n").map((c) => "    " + c).join("\n") : "    (no commits since baseline)");
  return L.join("\n");
}

// ---- finish (deploy-finish.sh) ----
export interface FinishDeps { runnerFor(cwd: string): Runner; hasGh: boolean; }
const liveFinishDeps: FinishDeps = { runnerFor: runnerAt, hasGh: haveCmd("gh") };
async function finishRun(rest: string[]): Promise<number> {
  const topic = rest[0], action = rest[1];
  if (!topic || !action) { log.error("usage: implement finish <topic> <merge|pr|keep|discard>"); return 2; }
  if (!["merge", "pr", "keep", "discard"].includes(action)) { log.error(`implement finish: unknown action '${action}'`); return 2; }
  return finishWith(topic, action as "merge" | "pr" | "keep" | "discard", liveFinishDeps);
}
// The finish body (deploy-finish.sh:1398-1419 / deploy.md:1398-1419). Resolves the worker's feat
// branch + start branch, then runs the action through finishWork.
function applyFinish(topic: string, art: string, cwd: string, action: "merge" | "pr" | "keep" | "discard", d: FinishDeps): string {
  const rec = readBranchRecord("implement", { dir: art, slug: "main" });
  // The recorded intent decides FIRST, in both directions: a --no-branch run must not act on a
  // branch it never created (a `feat/implement-<topic>` left behind by an earlier run is not this
  // run's to merge or delete), and a branch-mode run must not read a missing one as deliberate.
  if (rec.mode === "no-branch") return "no-branch";
  const branch = rec.branch;
  const startBranch = rec.startBranch;
  const r = d.runnerFor(cwd);
  // A detached baseline names no branch to restore, yet `branch !== startBranch` passes: a merge
  // would report success having integrated into whatever HEAD was. `branch` refuses this baseline
  // now; art dirs written before it still arrive here.
  if (startBranch === "(detached)") {
    log.warn("finish: main baseline is a detached HEAD — no start branch to merge into or return to, so NOTHING was merged, pushed, or discarded");
    log.warn(`  recover: the work is on '${branch || "the current branch"}'; checkout the intended base branch, re-run pre-snapshot + branch, and finish again`);
    return "same-branch";
  }
  // Nothing to act on in a run that meant to branch: the work is sitting on the baseline branch and
  // every action would silently do nothing — say so instead.
  if (!hasDistinctBranch(r, branch, startBranch)) {
    log.warn(`finish: main has no branch distinct from the baseline '${startBranch}' (recorded branch: '${branch || "none"}') — NOTHING was merged, pushed, or discarded`);
    log.warn("  recover: push and open the PR by hand, or checkout the intended base branch, re-run pre-snapshot + branch, and finish again");
    return "same-branch";
  }
  // `keep` is the detached run's only ending, and a detached run's target is its OWN worktree — where
  // restoring the start branch would swap the tree under a job that may still be executing from it
  // (issue #165). Proven per target, never inferred from the record's mere existence: a
  // `--no-worktree` job runs in the operator's checkout, which still needs its branch back.
  return finishWork(r, { branch, base: startBranch, action, hasGh: d.hasGh, titlePrefix: "implement", keepOnBranch: keepOnBranch(topic, cwd) }).outcome;
}
export async function finishWith(topic: string, action: "merge" | "pr" | "keep" | "discard", d: FinishDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement finish: art-dir missing: ${art}`); return 1; }
  // The mechanical half of a detached run's "never merge, never push, never open a PR". The
  // directive says it in prose; this refuses it in code, before the results file is truncated, so a
  // mis-instructed job hub cannot publish work no operator has seen. Filed as a flag on the run's
  // issue as well as stderr: a hub that got here at all is a defect /ap:review must see.
  // `keep` is the ONLY ending a detached run has while its record exists — the recorded-action
  // indirection left with the `--finish pr` opt-in (removed 2026-08-18), so the gate is a literal
  // again: the operator finishes the branch themselves.
  if (existsSync(jobPath(topic)) && action !== "keep") {
    log.error(`implement finish: detached job in flight (${jobPath(topic)}) — only 'keep' is allowed; ${action} would publish with no one watching`);
    runFlag("implement", topic, `finish ${action}: REFUSED — a detached job record is in flight for this topic, so only 'keep' is allowed; nothing was merged, pushed, or discarded`);
    return 2;
  }
  const results = join(art, "finish-results.tsv"); writeFileSync(results, "");
  let n = 0, stranded = 0, baseBlocked = 0;
  const cwd = targetCwd(topic);
  if (cwd) {
    const outcome = applyFinish(topic, art, cwd, action, d);
    if (outcome === "same-branch") stranded++;
    else if (outcome === "base-checkout-failed") baseBlocked++;
    appendFileSync(results, `main\t${action}\t${outcome}\n`);
    log.info(`finish: main -> ${action} -> ${outcome}`); n++;
  }
  // The defect this outcome exists to catch has to reach /ap:review, not just this session's log.
  if (stranded) runFlag("implement", topic, `finish ${action}: same-branch on ${stranded} target(s) — the work was left on the baseline branch (no distinct branch to act on), nothing merged, pushed, or discarded`);
  // Same reason, different cause — and a different recovery, so it is counted and worded apart: the
  // branch exists and holds the work, the finisher just could not get onto the base to act.
  if (baseBlocked) runFlag("implement", topic, `finish ${action}: base-checkout-failed on ${baseBlocked} target(s) — the checkout of the baseline branch was refused (check the checkout's own error: e.g. a dirty tree, the baseline held by another worktree, or its ref gone), so NOTHING was merged or discarded; the work is still on the feature branch`);
  log.ok(`implement finish: ${n} target(s) completed`); return 0;
}

// ---- forensics (best-effort) + archive (deploy-archive.sh) ----
async function forensicsRun(rest: string[]): Promise<number> {
  return runForensics("implement", implementArtDir, rest[0]);
}
export async function archiveRun(rest: string[]): Promise<number> {
  const topic = rest[0]; if (!topic) { log.error("usage: implement archive <topic>"); return 2; }
  archiveTopic(topic, "implement"); log.ok(`implement archive: archived _implement for ${topic}`); return 0;
}
