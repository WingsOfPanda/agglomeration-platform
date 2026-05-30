// src/commands/perform.ts — single-repo command path for /consort:perform.
// Byte-faithful port of the prior bash plugin's deploy verb set; WIRES the Phase-A core modules.
// Rebrand: _deploy/->_perform/, feat/deploy-->feat/perform-, conductor sender->From: maestro.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { repoRoot } from "../core/paths.js";
import { auditDoc } from "../core/audit.js";
import {
  parsePerformArgs, deriveTopicFromPath, resolveTarget, detectProvider,
  performArtDir, PerformArgError, PerformResolveError, ProviderError,
} from "../core/perform.js";
import { performState, composeRound1Prompt, composeFixPrompt } from "../core/performTurn.js";
import { extractQuestionPayload } from "../core/performQuestions.js";
import { outboxOffset, outboxPath, outboxWaitSince, statusPath, type OutboxEvent } from "../core/ipc.js";
import { instrumentTimeoutMultiplier } from "../core/contracts.js";
import { scaledTimeout, parseLatestOffset } from "../core/scoreTurn.js";
import { run as sendRun } from "./send.js";

const PART = "cody";
const PERFORM_TURN_TIMEOUT = (): number => Number(process.env.CONSORT_PERFORM_TURN_TIMEOUT_S) || 14400;

/** model for the cody part = the resolved provider (codex|claude). Reads provider.txt; default codex. */
function partModel(art: string): string {
  const p = join(art, "provider.txt");
  return existsSync(p) ? (readFileSync(p, "utf8").trim() || "codex") : "codex";
}
/** Multi-repo iff the PLURAL Target header + an Execution DAG are both present (deploy-init.sh:87). */
function detectRouting(docText: string): "single" | "multi" {
  return /^\*\*Target Sub-Project\(s\):\*\*/m.test(docText) && /^## Execution DAG[ \t]*$/m.test(docText) ? "multi" : "single";
}
function usage(): number {
  log.error("usage: perform <init|pre-snapshot|branch|turn-send|turn-wait|scope-check|summary|finish|forensics|archive> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0]; const rest = args.slice(1);
  switch (verb) {
    case "init":      return initRun(applyArgsFile(rest));
    case "turn-send": return turnSendRun(rest);
    case "turn-wait": return turnWaitRun(rest);
    default:          return usage();
  }
}

// ---- init (deploy-init.sh + deploy.md Step 0 audit, folded in) ----
export interface PerformInitDeps { repoRoot(): string; }
const liveInitDeps: PerformInitDeps = { repoRoot };
async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, liveInitDeps); }

export async function initWith(tokens: string[], d: PerformInitDeps): Promise<number> {
  let parsed; try { parsed = parsePerformArgs(tokens); }
  catch (e) { if (e instanceof PerformArgError) { log.error(e.message); return e.code; } throw e; }
  const designPath = parsed.rest.trim();
  if (!designPath || designPath.includes(" ")) { log.error("perform init: exactly one design-doc path is required"); return 2; }
  if (!existsSync(designPath)) { log.error(`perform init: design doc unreadable: ${designPath}`); return 1; }
  const text = readFileSync(designPath, "utf8");
  const topic = parsed.topic || deriveTopicFromPath(designPath);
  if (!topic) { log.error("perform init: could not derive topic; pass --topic <slug>"); return 1; }

  const ad = auditDoc(text);
  if (ad.verdict === "FAIL") { for (const i of ad.issues) process.stderr.write(`ISSUE=${i}\n`); log.error(`perform init: audit FAILED on ${designPath}`); return 1; }

  const art = performArtDir(topic);
  if (existsSync(art)) { log.error(`perform init: topic already in flight: ${art} (run /consort:coda or pick a different --topic)`); return 2; }

  let targetCwd: string;
  try { targetCwd = resolveTarget(designPath, d.repoRoot()); }
  catch (e) { if (e instanceof PerformResolveError) { log.error(e.message); return e.code; } throw e; }

  const routing = parsed.targets.length > 0 ? "multi" : detectRouting(text);
  let provider: string;
  try { provider = detectProvider(targetCwd); }
  catch (e) { if (e instanceof ProviderError) { log.error(e.message); return e.code; } throw e; }

  mkdirSync(art, { recursive: true });
  atomicWrite(join(art, "design.md"), text);
  atomicWrite(join(art, "topic.txt"), topic);                       // NO trailing newline
  atomicWrite(join(art, "target_cwd.txt"), targetCwd + "\n");
  atomicWrite(join(art, "provider.txt"), provider + "\n");
  atomicWrite(join(art, "multi-repo.txt"), (routing === "multi" ? "multi" : "single") + "\n");
  if (routing === "multi") log.warn("perform init: multi-repo routing recorded; multi-repo execution is a later phase (Phase C)");

  log.ok(`perform init: topic=${topic} routing=${routing} provider=${provider}`);
  process.stdout.write(`ART=${art}\nTOPIC=${topic}\nROUTING=${routing}\nPROVIDER=${provider}\nTARGET_CWD=${targetCwd}\n`);
  return 0;
}

// ---- turn-send (deploy-turn-send.sh) — offset-before-send dispatch ----
export interface PerformSendDeps { offsetFor(i: string, m: string, t: string): number; send(args: string[]): Promise<number>; }
const liveSendDeps: PerformSendDeps = { offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)), send: sendRun };
async function turnSendRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  if (!topic || !roundStr) { log.error("usage: perform turn-send <topic> <round>"); return 2; }
  if (!/^[1-9][0-9]*$/.test(roundStr)) { log.error(`perform turn-send: round must be a positive integer (got: ${roundStr})`); return 1; }
  return turnSendWith(topic, Number(roundStr), liveSendDeps);
}
export async function turnSendWith(topic: string, round: number, d: PerformSendDeps): Promise<number> {
  const art = performArtDir(topic);
  if (!existsSync(art)) { log.error(`perform turn-send: ${art} not found — run perform init first`); return 1; }
  const model = partModel(art);
  const stateFile = join(art, `turn-cody-${round}.txt`);
  if (existsSync(stateFile)) { log.error(`perform turn-send: ${stateFile} already exists; rm to retry`); return 1; }
  const outbox = outboxPath(PART, model, topic);
  if (!existsSync(outbox)) { log.error(`perform turn-send: outbox not found at ${outbox} — was cody spawned?`); return 1; }
  const sp = statusPath(PART, model, topic);
  if (existsSync(sp)) { const m = readFileSync(sp, "utf8").match(/"state":"([^"]*)"/); if (m && m[1] && m[1] !== "idle") { log.error(`perform turn-send: part not idle (state=${m[1]}); previous turn still in flight`); return 1; } }
  const promptFile = join(art, `cody_turn_prompt_${round}.md`);
  if (round === 1) atomicWrite(promptFile, composeRound1Prompt({ designPath: join(art, "design.md"), planPath: join(art, "plan.md"), verifyPath: join(art, "verify-report-1.md"), round }));
  else { const bundle = join(art, `fix-prompt-${round}.md`); if (!existsSync(bundle)) { log.error(`perform turn-send: fix-prompt-${round}.md not found at ${bundle}; the directive must write it first`); return 1; } atomicWrite(promptFile, composeFixPrompt(round, readFileSync(bundle, "utf8"), join(art, `verify-report-${round}.md`))); }
  const offset = d.offsetFor(PART, model, topic);             // BEFORE send (deploy_send_dispatch order)
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "maestro", PART, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`perform turn-send: send failed (rc=${rc}); ${stateFile} kept (rm to retry)`); return 1; }
  log.info(`[turn-send] cody round=${round} offset=${offset}`); return 0;
}

// ---- turn-wait (deploy-turn-wait.sh) — rc 0 ALWAYS; TS= carries outcome ----
export interface PerformWaitDeps { wait(i: string, m: string, t: string, off: number, ev: string[], to: number): Promise<OutboxEvent | null>; multiplier(model: string): string; now(): number; }
const liveWaitDeps: PerformWaitDeps = { wait: outboxWaitSince, multiplier: instrumentTimeoutMultiplier, now: () => Math.floor(Date.now() / 1000) };
async function turnWaitRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  if (!topic || !roundStr) { log.error("usage: perform turn-wait <topic> <round>"); return 2; }
  if (!/^[1-9][0-9]*$/.test(roundStr)) { log.error(`perform turn-wait: round must be a positive integer (got: ${roundStr})`); return 1; }
  return turnWaitWith(topic, Number(roundStr), liveWaitDeps);
}
export async function turnWaitWith(topic: string, round: number, d: PerformWaitDeps): Promise<number> {
  const art = performArtDir(topic);
  const model = partModel(art);
  const stateFile = join(art, `turn-cody-${round}.txt`);
  if (!existsSync(stateFile)) { log.error(`perform turn-wait: ${stateFile} missing — run perform turn-send first`); return 1; }
  const offset = parseLatestOffset(readFileSync(stateFile, "utf8"));
  if (offset === null) { log.error(`perform turn-wait: OFFSET not set in ${stateFile}`); return 1; }
  const timeout = scaledTimeout(PERFORM_TURN_TIMEOUT(), d.multiplier(model));
  log.info(`[turn-wait] cody round=${round} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(PART, model, topic, offset, ["done", "error", "question"], timeout);
  const verifyPath = join(art, `verify-report-${round}.md`);
  const verifyText = existsSync(verifyPath) ? readFileSync(verifyPath, "utf8") : null;
  let ts = performState(ev, verifyText);
  if (ts === "question" && ev) {
    const payload = extractQuestionPayload(ev, d.now());
    if (payload !== null) {
      atomicWrite(join(art, `question-cody-${round}.txt`), payload);
      const bumped = outboxOffset(outboxPath(PART, model, topic));
      appendFileSync(stateFile, `OFFSET=${bumped}\nTS=question\n`);
    } else { ts = "failed"; appendFileSync(stateFile, "TS=failed\n"); log.warn("[turn-wait] malformed question (no message); downgraded to failed"); }
  } else appendFileSync(stateFile, `TS=${ts}\n`);
  writeFileSync(join(art, `turn-cody-${round}.done`), "");
  log.ok(`[turn-wait] cody round=${round} TS=${ts}`); return 0;
}
