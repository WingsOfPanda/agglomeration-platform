// src/commands/implement.ts — single-repo command path for /ap:implement.
// Byte-faithful port of the prior bash plugin's deploy verb set; WIRES the Phase-A core modules.
// Rebrand: _deploy/->_implement/, feat/deploy-->feat/implement-, conductor sender->From: hub.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile, kvParse } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { repoRoot, repoStateDir } from "../core/paths.js";
import { auditDoc } from "../core/audit.js";
import {
  parseImplementArgs, deriveTopicFromPath, detectProvider,
  implementArtDir, iterTargets, assertImplementTopic, ImplementArgError,
} from "../core/implement.js";
import { isoUtc, archiveTopic } from "../core/archive.js";
import { extractComponentsPaths, matchDiffAgainstComponents } from "../core/implementScope.js";
import { runnerAt, preSnapshot, createOrResumeBranch, shortstat, finishBranchAction, type Runner } from "../core/gitwork.js";
import { runForensics, runFlag } from "../core/forensics.js";
import { haveCmd } from "../core/deps.js";
import { implementState, composeRound1Prompt, composeFixPrompt } from "../core/implementTurn.js";
import { extractQuestionPayload, parseQuestionPayload } from "../core/implementQuestions.js";
import { outboxOffset, outboxPath, outboxWaitSince, statusPath, workerSendGate, TERMINAL_EVENTS, resolveModel, type OutboxEvent } from "../core/ipc.js";
import { kvField, readField, readIfExists, readIfExistsOrNull } from "../core/fsread.js";
import { agentTimeoutMultiplier } from "../core/contracts.js";
import { scaledTimeout, parseLatestOffset, lastKeyedNumber, recordWaitOutcome } from "../core/designTurn.js";
import { envNum, DEFAULT_TURN_BUDGET_S } from "../core/env.js";
import { run as sendRun } from "./send.js";
import { detectTestCommand } from "../core/quick.js";
import { classifyTestRun, liveTestRunner, parseWorkerDuration, shouldSkipVerify, type TestRunner, type TestVerdict } from "../core/implementVerifyTests.js";

const WORKER = "lead";
const IMPLEMENT_TURN_TIMEOUT = (): number => envNum("AP_IMPLEMENT_TURN_TIMEOUT_S", DEFAULT_TURN_BUDGET_S);

/** model for the lead worker = the resolved provider (codex|claude). Reads provider.txt; default codex. */
function workerModel(art: string): string {
  return readIfExists(join(art, "provider.txt")).trim() || "codex";
}
/** The LAST `OBJECTIONS=<n>` count persisted in a per-dispatch state file (0 if absent). The
 *  objection cap reads + increments this on every re-arm so the count survives the background-task
 *  re-entry that drives the re-armed wait. Latest-line-wins, mirroring parseLatestOffset. */
function latestObjections(stateFile: string): number {
  if (!existsSync(stateFile)) return 0;
  return lastKeyedNumber(readFileSync(stateFile, "utf8"), "OBJECTIONS") ?? 0;
}
function usage(): number {
  log.error("usage: implement <init|audit|pre-snapshot|branch|turn-send|turn-wait|reset-status|scope-check|verify-tests|summary|finish|forensics|archive|find-latest-doc> ...");
  return 2;
}

// ---- find-latest-doc (deploy Step 0.4 no-arg source default) — newest */_design/design-doc/*-design.md by mtime ----
async function findLatestDocRun(rest: string[]): Promise<number> {
  let cwd: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--cwd") { cwd = rest[i + 1]; i++; }
    else if (rest[i].startsWith("--cwd=")) { cwd = rest[i].slice("--cwd=".length); }
  }
  const stateDir = repoStateDir(cwd ? { cwd } : undefined);
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
  const ad = auditDoc(text);
  if (ad.verdict === "FAIL") { for (const i of ad.issues) process.stderr.write(`ISSUE=${i}\n`); return 1; }
  log.ok(`implement audit: PASS ${doc}`);
  return 0;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0]; const rest = args.slice(1);
  switch (verb) {
    case "init":      return initRun(applyArgsFile(rest));
    case "audit":     return auditRun(rest);
    case "turn-send": return turnSendRun(rest);
    case "turn-wait": return turnWaitRun(rest);
    case "reset-status": return resetStatusRun(rest);
    case "pre-snapshot": return preSnapshotRun(rest);
    case "branch":       return branchRun(applyArgsFile(rest));
    case "scope-check":  return scopeCheckRun(rest);
    case "verify-tests": return verifyTestsRun(rest);
    case "summary":      return summaryRun(rest);
    case "finish":       return finishRun(rest);
    case "forensics":    return forensicsRun(rest);
    case "flag":         return runFlag("implement", rest[0], rest.slice(1).join(" "));
    case "archive":      return archiveRun(rest);
    case "find-latest-doc": return findLatestDocRun(rest);
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

  const targetCwd = d.repoRoot();
  const provider = detectProvider(targetCwd);

  mkdirSync(art, { recursive: true });
  atomicWrite(join(art, "design.md"), text);
  atomicWrite(join(art, "topic.txt"), topic);                       // NO trailing newline
  atomicWrite(join(art, "target_cwd.txt"), targetCwd + "\n");
  atomicWrite(join(art, "provider.txt"), provider + "\n");
  atomicWrite(join(art, "auto_provider.txt"), provider + "\n");   // deploy claude-confirm marker (the auto-detected provider)

  log.ok(`implement init: topic=${topic} provider=${provider}`);
  process.stdout.write(`ART=${art}\nTOPIC=${topic}\nPROVIDER=${provider}\nTARGET_CWD=${targetCwd}\n`);
  return 0;
}

// ---- turn-send (deploy-turn-send.sh) — offset-before-send dispatch ----
export interface ImplementSendDeps { offsetFor(i: string, m: string, t: string): number; send(args: string[]): Promise<number>; }
const liveSendDeps: ImplementSendDeps = { offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)), send: sendRun };
async function turnSendRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  if (!topic || !roundStr) { log.error("usage: implement turn-send <topic> <round>"); return 2; }
  if (!/^[1-9][0-9]*$/.test(roundStr)) { log.error(`implement turn-send: round must be a positive integer (got: ${roundStr})`); return 1; }
  return turnSendWith(topic, Number(roundStr), liveSendDeps);
}
export async function turnSendWith(topic: string, round: number, d: ImplementSendDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement turn-send: ${art} not found — run implement init first`); return 1; }
  const model = workerModel(art);
  const targetCwd = readIfExists(join(art, "target_cwd.txt")).trim();
  const testCmd = targetCwd ? detectTestCommand(targetCwd) : "";
  const stateFile = join(art, `turn-${WORKER}-${round}.txt`);
  if (existsSync(stateFile)) { log.error(`implement turn-send: ${stateFile} already exists; rm to retry`); return 1; }
  if (!workerSendGate(WORKER, model, topic, "implement turn-send", "turn")) return 1;
  const promptFile = join(art, `${WORKER}_turn_prompt_${round}.md`);
  if (round === 1) atomicWrite(promptFile, composeRound1Prompt({ designPath: join(art, "design.md"), planPath: join(art, "plan.md"), verifyPath: join(art, "verify-report-1.md"), round, testCmd }));
  else { const bundle = join(art, `fix-prompt-${round}.md`); if (!existsSync(bundle)) { log.error(`implement turn-send: fix-prompt-${round}.md not found at ${bundle}; the directive must write it first`); return 1; } atomicWrite(promptFile, composeFixPrompt(round, readFileSync(bundle, "utf8"), join(art, `verify-report-${round}.md`), testCmd)); }
  const offset = d.offsetFor(WORKER, model, topic);             // BEFORE send (deploy_send_dispatch order)
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", WORKER, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`implement turn-send: send failed (rc=${rc}); ${stateFile} kept (rm to retry)`); return 1; }
  log.info(`[turn-send] ${WORKER} round=${round} offset=${offset}`); return 0;
}

// ---- turn-wait (deploy-turn-wait.sh) — rc 0 ALWAYS; TS= carries outcome ----
export interface ImplementWaitDeps { wait(i: string, m: string, t: string, off: number, ev: string[], to: number): Promise<OutboxEvent | null>; multiplier(model: string): string; now(): number; }
const liveWaitDeps: ImplementWaitDeps = { wait: outboxWaitSince, multiplier: agentTimeoutMultiplier, now: () => Math.floor(Date.now() / 1000) };
async function turnWaitRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  if (!topic || !roundStr) { log.error("usage: implement turn-wait <topic> <round>"); return 2; }
  if (!/^[1-9][0-9]*$/.test(roundStr)) { log.error(`implement turn-wait: round must be a positive integer (got: ${roundStr})`); return 1; }
  return turnWaitWith(topic, Number(roundStr), liveWaitDeps);
}
export async function turnWaitWith(topic: string, round: number, d: ImplementWaitDeps): Promise<number> {
  const art = implementArtDir(topic);
  const model = workerModel(art);
  const stateFile = join(art, `turn-${WORKER}-${round}.txt`);
  if (!existsSync(stateFile)) { log.error(`implement turn-wait: ${stateFile} missing — run implement turn-send first`); return 1; }
  const offset = parseLatestOffset(readFileSync(stateFile, "utf8"));
  if (offset === null) { log.error(`implement turn-wait: OFFSET not set in ${stateFile}`); return 1; }
  const timeout = scaledTimeout(IMPLEMENT_TURN_TIMEOUT(), d.multiplier(model));
  log.info(`[turn-wait] ${WORKER} round=${round} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(WORKER, model, topic, offset, TERMINAL_EVENTS, timeout);
  const verifyPath = join(art, `verify-report-${round}.md`);
  const verifyText = readIfExistsOrNull(verifyPath);
  let ts = implementState(ev, verifyText);
  let question: { file: string; body: string; extraLines?: string } | undefined;
  if (ts === "question" && ev) {
    const payload = extractQuestionPayload(ev, d.now());
    if (payload !== null) {
      const objLine = parseQuestionPayload(payload).route === "objection"
        ? `OBJECTIONS=${latestObjections(stateFile) + 1}\n` : "";
      question = { file: join(art, `question-${WORKER}-${round}.txt`), body: payload, extraLines: objLine };
    } else { ts = "failed"; log.warn("[turn-wait] malformed question (no message); downgraded to failed"); }
  }
  recordWaitOutcome(WORKER, model, topic, stateFile, ts, "TS", question);
  writeFileSync(join(art, `turn-${WORKER}-${round}.done`), "");
  log.ok(`[turn-wait] ${WORKER} round=${round} TS=${ts}`); return 0;
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

// ---- baseline tsv/map readers (port of deploy helpers) ----
function branchMapField(map: string, slug: string): string {
  if (!existsSync(map)) return "";
  for (const line of readFileSync(map, "utf8").split("\n")) { const [s, b] = line.split("\t"); if (s === slug) return b ?? ""; }
  return "";
}
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

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
  for (const { slug, cwd } of iterTargets(topic, opts)) {
    if (!slug || !cwd) continue;
    const snap = preSnapshot(runnerFor(cwd), "implement", topic);
    if (snap.state === "not-git") { log.error(`implement pre-snapshot: not a git repository: ${cwd}`); return 2; }
    atomicWrite(join(art, "baselines", `${slug}.tsv`),
      `slug=${slug}\ncwd=${cwd}\nbranch=${snap.branch}\nbaseline_sha=${snap.baseSha}\nstate=${snap.state}\nsnapshot_ts=${isoUtc()}\n`);
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
export async function branchWith(a: { topic: string; noBranch: boolean; branchName?: string }, opts: { home?: string; cwd?: string }, runnerFor: (cwd: string) => Runner): Promise<number> {
  const art = implementArtDir(a.topic, opts);
  if (!existsSync(art)) { log.error(`implement branch: art-dir missing: ${art} (run implement init first)`); return 1; }
  const defaultBranch = a.branchName ?? `feat/implement-${a.topic}`;
  const rows: string[] = [];
  for (const { slug, cwd } of iterTargets(a.topic, opts)) {
    if (!slug || !cwd) continue;
    const r = runnerFor(cwd); let recorded: string;
    if (a.noBranch) { recorded = r.run("git", ["symbolic-ref", "--short", "HEAD"]).stdout.trim() || "(detached)"; log.info(`branch: (--no-branch) staying on ${recorded} in ${cwd}`); }
    else if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${defaultBranch}`]).code === 0) { createOrResumeBranch(r, defaultBranch); log.info(`branch: resumed ${defaultBranch} in ${cwd}`); recorded = defaultBranch; }
    else if (createOrResumeBranch(r, defaultBranch)) { log.info(`branch: created ${defaultBranch} in ${cwd}`); recorded = defaultBranch; }
    else { recorded = r.run("git", ["symbolic-ref", "--short", "HEAD"]).stdout.trim() || "(detached)"; log.warn(`branch: checkout -b failed in ${cwd}; staying on current branch`); }
    rows.push(`${slug}\t${recorded}`);
    const baseline = join(art, "baselines", `${slug}.tsv`);
    if (existsSync(baseline)) { const m = readFileSync(baseline, "utf8").match(/^baseline_sha=(.*)$/m); if (m) atomicWrite(join(art, "branch-base.sha"), m[1] + "\n"); }
  }
  atomicWrite(join(art, "implement-branches.tsv"), rows.length ? rows.join("\n") + "\n" : "");
  log.ok(`implement branch: ${rows.length} target(s) recorded`); return 0;
}

// ---- scope-check (deploy-scope) ----
export interface ScopeDeps { runnerFor(cwd: string): Runner; }
const liveScopeDeps: ScopeDeps = { runnerFor: runnerAt };
async function scopeCheckRun(rest: string[]): Promise<number> { const topic = rest[0]; if (!topic) { log.error("usage: implement scope-check <topic>"); return 2; } return scopeCheckWith(topic, liveScopeDeps); }
/**
 * Scope conformance: collect the diff path set, then match it against the design's Components
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
  const compPaths = extractComponentsPaths(readFileSync(designFile, "utf8"));
  atomicWrite(join(art, "components-paths.txt"), compPaths.length ? compPaths.join("\n") + "\n" : "");
  if (compPaths.length === 0) log.warn("scope conformance: design declared 0 parseable component paths; ALL changed files flagged by default (guard no-op)");
  const oos = matchDiffAgainstComponents(diffPaths, compPaths);
  const oosPath = join(art, "scope-out-of-scope.txt");
  atomicWrite(oosPath, oos.length ? oos.join("\n") + "\n" : "");
  if (oos.length > 0) log.warn(`scope conformance: ${oos.length} out-of-scope path(s) detected`);
  process.stdout.write(`SCOPE_DECLARED=${compPaths.length}\nOOS_COUNT=${oos.length}\nOOS_PATH=${oosPath}\n`); return 0;
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
  for (const t of iterTargets(topic)) {
    if (!t.slug || !t.cwd) continue;
    const baseline = join(art, "baselines", `${t.slug}.tsv`), post = join(art, "posts", `${t.slug}.tsv`);
    if (!existsSync(baseline)) { log.error(`implement summary: baseline missing for slug=${t.slug} (${baseline})`); continue; }
    if (!isDir(t.cwd)) { log.warn(`implement summary: target gone for slug=${t.slug} (cwd=${t.cwd}); omitting block`); continue; }
    const r = d.runnerFor(t.cwd); postSweep(r, topic, baseline, post, d.now());
    process.stdout.write(formatSummaryBlock(r, baseline, post) + "\n\n");
  }
  return 0;
}
function postSweep(r: Runner, topic: string, baseline: string, post: string, ts: string): void {
  const slug = kvField(baseline, "slug"), cwd = kvField(baseline, "cwd"), base = kvField(baseline, "branch");
  const postBranch = r.run("git", ["symbolic-ref", "--short", "HEAD"]).stdout.trim() || "(detached)";
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
// Shared per-target finish body (deploy-finish.sh:1398-1419 / deploy.md:1398-1419). Resolves the
// worker's feat branch + start branch, then delegates the branch action.
function applyFinish(art: string, t: { slug: string; cwd: string }, action: "merge" | "pr" | "keep" | "discard", d: FinishDeps): string {
  const branch = branchMapField(join(art, "implement-branches.tsv"), t.slug);
  const startBranch = kvField(join(art, "baselines", `${t.slug}.tsv`), "branch");
  return finishBranchAction(d.runnerFor(t.cwd), { branch, startBranch, action, hasGh: d.hasGh });
}
export async function finishWith(topic: string, action: "merge" | "pr" | "keep" | "discard", d: FinishDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement finish: art-dir missing: ${art}`); return 1; }
  const results = join(art, "finish-results.tsv"); writeFileSync(results, "");
  let n = 0;
  for (const t of iterTargets(topic)) {
    if (!t.slug || !t.cwd) continue;
    const outcome = applyFinish(art, { slug: t.slug, cwd: t.cwd }, action, d);
    appendFileSync(results, `${t.slug}\t${action}\t${outcome}\n`);
    log.info(`finish: ${t.slug} -> ${action} -> ${outcome}`); n++;
  }
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
