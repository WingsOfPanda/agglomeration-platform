// src/core/phaseTable.ts — the worker-phase table for /ap:explore and /ap:design.
//
// A phase IS data: a state-file prefix, a status key, a timeout budget, an artifact path, a
// wait-outcome classifier, and (from openq onward) a dispatch-safety guard. It used to be encoded
// as ~50 lines of hand-copied control flow per phase — nine copies of one send/wait skeleton — so
// every wait-protocol change (the 0.5.5 liveness extension) had to be applied nine times, and the
// 0.5.5 VS-gap bug was exactly one missed slot in one hand-written copy. Here each phase is one
// PHASES row and the skeletons exist once: dispatchPrompt (the send tail), phaseWait (the whole
// wait body), waitGateVerb (the gate read-out), triad (the 3-positional arg parse).
//
// Byte-for-byte fidelity is the contract. Every log line, state-file write and rc below is the
// literal text the copied bodies emitted; the only per-phase variation is a row slot. What is NOT
// shared stays in commands/*.ts: each phase's prompt composer (it sits with its parser by design),
// its own preconditions, and each verb's arg-validation wording.
//
// TWO guard encodings, deliberately not unified. `anyPriorUnsafe` (the ternary at openq /
// crossverify / adversary) reports the first unsafe tag anywhere in its chain; `latestNonSkipped-
// Unsafe` (the walk at rebuttal / gap / signoff) consults ONLY the latest non-skipped tag, so a
// clean later phase clears an older failure. On pipeline-reachable state they agree; on inputs the
// pipeline cannot produce (VS=ok alongside QS=timeout) they disagree, and each site keeps the
// answer it has always given. Merging them would be a behavior change and needs its own spec.
//
// Chain ORDER is load-bearing too: it decides which `KEY=value` the skip warning names when more
// than one earlier phase is unsafe. crossverify checks FS before QS (earliest first) while
// adversary checks VS, QS, FS (latest first) — both are transcribed from the shipped source, not
// derived from table order.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import { atomicWrite } from "./atomic.js";
import { readIfExists as readIf, readIfExistsOrNull } from "./fsread.js";
import { designArtDir } from "./design.js";
import { parseListFile, lastTag } from "./roster.js";
import { exploreArtDir } from "./explore.js";
import { workerDir } from "./paths.js";
import { consultTimeout, agentTimeoutMultiplier, type ConsultKind } from "./contracts.js";
import { outboxOffset, outboxPath, TERMINAL_EVENTS, type OutboxEvent } from "./ipc.js";
import { liveOutboxWait } from "./waitLive.js";
import {
  parseLatestOffset, scaledTimeout, researchState, verifyState, gateState, gateAnomalies, recordWaitOutcome,
} from "./designTurn.js";
import { run as sendRun } from "../commands/send.js";

/** The frozen state-file status keys, declared ONCE (designTurn's gate signatures import it):
 *  FS research, QS explore's open-questions relay, VS explore's cross-verify + design's verify,
 *  AS explore's adversary, RS explore's rebuttal, GS explore's gap round, SS explore's sign-off. */
export type PhaseKey = "FS" | "QS" | "VS" | "AS" | "RS" | "GS" | "SS";

/** Dispatch-safety guard: never send to a worker whose previous phase ended timeout/failed — it may
 *  still be busy, and a send would clobber the inbox task it is working on. */
export interface PhaseGuard {
  /** Which predicate this site uses; see the header for why both survive. */
  kind: "any" | "latest";
  /** The noun the skip warning uses: "research" (openq, whose chain is one phase long),
   *  "previous phase" (the ternary sites), "latest phase" (the walk sites). */
  noun: string;
  /** Earlier phases to consult, in the order the shipped source consulted them. */
  chain: PhaseKey[];
}

export interface PhaseRow {
  /** Verb stem AND filename stem: verbs are `<phase>-send`/`<phase>-wait`, state file is
   *  `<phase>-<agent>.txt`, completion marker `<phase>-<agent>.done`. */
  phase: string;
  /** Frozen status key written into the state file and read by the wait gate. */
  key: PhaseKey;
  /** Owning command — the first word of every log label this row produces. */
  cmd: "explore" | "design";
  artDir(topic: string): string;
  /** contracts.yaml consult-timeout key. NOTE crossverify's is "verify", not "crossverify":
   *  explore's peer cross-verification reuses design's verify budget. */
  timeoutKind: ConsultKind;
  /** The phase output whose presence/emptiness the classifier reads. explore keeps these art-dir
   *  flat (`<phase>-<agent>.md`); design writes them into the per-worker dir. */
  artifactFor(art: string, agent: string, provider: string, topic: string): string;
  /** Wait-outcome classifier: researchState (findings health) for research, verifyState
   *  (done -> ok iff the artifact is non-empty) for every later phase. */
  stateFn(ev: OutboxEvent | null, text: string | null): string;
  /** Whether the wait honours a `<key>=skipped` fast-path. Research never skips — nothing precedes
   *  it — so its wait reads the offset unconditionally, exactly as its hand-written body did. */
  skippable: boolean;
  guard?: PhaseGuard;
}

/** explore's seven worker phases in pipeline order. */
export const PHASES: PhaseRow[] = [
  {
    phase: "research", key: "FS", cmd: "explore", artDir: exploreArtDir, timeoutKind: "research",
    artifactFor: (art, agent) => join(art, `findings-${agent}.md`), stateFn: researchState, skippable: false,
  },
  {
    phase: "openq", key: "QS", cmd: "explore", artDir: exploreArtDir, timeoutKind: "openq",
    artifactFor: (art, agent) => join(art, `openq-${agent}.md`), stateFn: verifyState, skippable: true,
    guard: { kind: "any", noun: "research", chain: ["FS"] },
  },
  {
    phase: "crossverify", key: "VS", cmd: "explore", artDir: exploreArtDir, timeoutKind: "verify",
    artifactFor: (art, agent) => join(art, `crossverify-${agent}.md`), stateFn: verifyState, skippable: true,
    guard: { kind: "any", noun: "previous phase", chain: ["FS", "QS"] },
  },
  {
    phase: "adversary", key: "AS", cmd: "explore", artDir: exploreArtDir, timeoutKind: "adversary",
    artifactFor: (art, agent) => join(art, `adversary-${agent}.md`), stateFn: verifyState, skippable: true,
    guard: { kind: "any", noun: "previous phase", chain: ["VS", "QS", "FS"] },
  },
  {
    phase: "rebuttal", key: "RS", cmd: "explore", artDir: exploreArtDir, timeoutKind: "rebuttal",
    artifactFor: (art, agent) => join(art, `rebuttal-${agent}.md`), stateFn: verifyState, skippable: true,
    guard: { kind: "latest", noun: "latest phase", chain: ["AS", "VS", "QS", "FS"] },
  },
  {
    phase: "gap", key: "GS", cmd: "explore", artDir: exploreArtDir, timeoutKind: "gap",
    artifactFor: (art, agent) => join(art, `gap-${agent}.md`), stateFn: verifyState, skippable: true,
    guard: { kind: "latest", noun: "latest phase", chain: ["RS", "AS", "VS", "QS", "FS"] },
  },
  {
    phase: "signoff", key: "SS", cmd: "explore", artDir: exploreArtDir, timeoutKind: "signoff",
    artifactFor: (art, agent) => join(art, `signoff-${agent}.md`), stateFn: verifyState, skippable: true,
    guard: { kind: "latest", noun: "latest phase", chain: ["GS", "RS", "AS", "VS", "QS", "FS"] },
  },
];

/** design's two worker phases. No guards: design's escalation dispatches both phases behind its own
 *  wait gate, so there is no per-agent previous-phase state to consult at send time. */
export const DESIGN_PHASES: PhaseRow[] = [
  {
    phase: "research", key: "FS", cmd: "design", artDir: designArtDir, timeoutKind: "research",
    artifactFor: (_art, agent, provider, topic) => join(workerDir(agent, provider, topic), "findings.md"),
    stateFn: researchState, skippable: false,
  },
  {
    phase: "verify", key: "VS", cmd: "design", artDir: designArtDir, timeoutKind: "verify",
    artifactFor: (_art, agent, provider, topic) => join(workerDir(agent, provider, topic), "verify.md"),
    stateFn: verifyState, skippable: true,
  },
];

/** Which explore state file carries a given key — the guards' chain entries are keys, the files are
 *  named by phase. Derived from PHASES so the phase list stays stated once. */
const EXPLORE_PHASE_BY_KEY: Record<PhaseKey, string> =
  Object.fromEntries(PHASES.map((p) => [p.key, p.phase])) as Record<PhaseKey, string>;

/** A worker's LAST `<key>=` value in the explore state file that owns that key; null when the phase
 *  never ran (missing file reads as ""). */
function exploreTag(art: string, agent: string, key: PhaseKey): string | null {
  return lastTag(readIf(join(art, `${EXPLORE_PHASE_BY_KEY[key]}-${agent}.txt`)), key);
}

/** Ternary encoding (openq / crossverify / adversary). The FIRST key in `chain` whose tag is
 *  timeout|failed wins whatever the later keys say — a clean later phase does NOT clear an earlier
 *  failure. Returns the `KEY=value` the warning names, or null when dispatch is safe. */
export function anyPriorUnsafe(art: string, agent: string, chain: PhaseKey[]): string | null {
  for (const key of chain) {
    const tag = exploreTag(art, agent, key);
    if (tag === "timeout" || tag === "failed") return `${key}=${tag}`;
  }
  return null;
}

/** Walk encoding (rebuttal / gap / signoff). Only the LATEST non-skipped tag decides: an
 *  `AS=skipped` produced by the adversary guard must fall through to the state that caused it —
 *  checking AS alone would clobber a worker still mid-crossverify — and a clean later phase DOES
 *  clear an older failure. Returns the `KEY=value` the warning names, or null when safe. */
export function latestNonSkippedUnsafe(art: string, agent: string, chain: PhaseKey[]): string | null {
  const tags = chain.map((key) => [key, exploreTag(art, agent, key)] as const);
  const latest = tags.find(([, v]) => v !== null && v !== "skipped");
  if (latest && (latest[1] === "timeout" || latest[1] === "failed")) return `${latest[0]}=${latest[1]}`;
  return null;
}

/** The guard's write+warn tail. On an unsafe chain the phase records `<key>=skipped` (so the paired
 *  wait short-circuits instead of hanging) and warns; the caller then returns 0 WITHOUT sending.
 *  Rows without a guard always return false. */
export function guardSkipped(row: PhaseRow, art: string, agent: string, stateFile: string): boolean {
  const g = row.guard;
  if (!g) return false;
  const unsafe = g.kind === "any"
    ? anyPriorUnsafe(art, agent, g.chain)
    : latestNonSkippedUnsafe(art, agent, g.chain);
  if (!unsafe) return false;
  atomicWrite(stateFile, `${row.key}=skipped\n`);
  log.warn(`${row.cmd} ${row.phase}-send: ${agent} skipped — ${g.noun} ended ${unsafe} (worker may still be busy; sending would clobber its inbox)`);
  return true;
}

/** A non-guard skip (no work routed to this worker, empty scope, trigger not fired): record
 *  `<key>=skipped` and report it as success — the phase is a no-op for this worker, not a failure. */
export function skipDispatch(row: PhaseRow, agent: string, stateFile: string, reason: string): number {
  atomicWrite(stateFile, `${row.key}=skipped\n`);
  log.ok(`${row.cmd} ${row.phase}-send: ${agent} ${row.key}=skipped (${reason})`);
  return 0;
}

export interface SendDeps {
  offsetFor(agent: string, model: string, topic: string): number;
  send(args: string[]): Promise<number>;
}

export interface WaitDeps {
  wait(agent: string, model: string, topic: string, offset: number, events: string[], timeoutSec: number): Promise<OutboxEvent | null>;
  multiplier(provider: string): string;
}

export const liveSendDeps: SendDeps = {
  offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)),
  send: sendRun,
};

export const liveWaitDeps: WaitDeps = {
  wait: liveOutboxWait,
  multiplier: agentTimeoutMultiplier,
};

/** The send tail every dispatching phase ends with. The outbox offset is captured BEFORE the send
 *  and written first, so a crash between write and send leaves a state file the retry can see — the
 *  "kept (rm to redo)" contract: a failed send never silently rearms, the operator removes the state
 *  file to redo the phase. */
export async function dispatchPrompt(
  row: PhaseRow,
  ctx: { topic: string; agent: string; provider: string; stateFile: string; promptFile: string },
  d: SendDeps,
): Promise<number> {
  const { topic, agent, provider, stateFile, promptFile } = ctx;
  const label = `${row.cmd} ${row.phase}-send`;
  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`${label}: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`${label}: ${agent} offset=${offset}`);
  return 0;
}

/** The whole wait body, identical for all nine phases: skipped fast-path, latest-offset read,
 *  provider-scaled timeout, the outbox wait, classify, record the outcome (a question re-arms the
 *  offset instead of terminating), drop the `.done` marker the wait gate reads, log. */
export async function phaseWait(
  row: PhaseRow, topic: string, agent: string, provider: string, d: WaitDeps,
): Promise<number> {
  const art = row.artDir(topic);
  const stateFile = join(art, `${row.phase}-${agent}.txt`);
  const label = `${row.cmd} ${row.phase}-wait`;
  if (!existsSync(stateFile)) { log.error(`${label}: ${stateFile} missing (run ${row.cmd} ${row.phase}-send first)`); return 1; }
  const text = readFileSync(stateFile, "utf8");
  if (row.skippable && lastTag(text, row.key) === "skipped") { // nothing was sent — mark and return
    writeFileSync(join(art, `${row.phase}-${agent}.done`), "");
    log.ok(`${label}: ${agent} ${row.key}=skipped (already)`);
    return 0;
  }
  const offset = parseLatestOffset(text);
  if (offset === null) { log.error(`${label}: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout(row.timeoutKind), d.multiplier(provider));
  log.info(`${label}: ${agent} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(agent, provider, topic, offset, TERMINAL_EVENTS, timeout);

  const state = row.stateFn(ev, readIfExistsOrNull(row.artifactFor(art, agent, provider, topic)));
  recordWaitOutcome(agent, provider, topic, stateFile, state, row.key,
    ev ? { file: join(art, `question-${agent}.txt`), body: JSON.stringify(ev) + "\n" } : undefined);
  writeFileSync(join(art, `${row.phase}-${agent}.done`), "");
  log.ok(`${label}: ${agent} ${row.key}=${state}`);
  return 0;
}

/** The wait-gate read-out, shared by explore's and design's `wait-gate` verb: one `<agent>\t<status>`
 *  stdout line per worker, a stderr warning for each terminal-but-anomalous worker, rc 0 only when
 *  every worker is terminal. `label` is the command name — each verb keeps its own arg validation,
 *  whose usage/error wording differs per command. */
export function waitGateVerb(label: string, art: string, phase: string, key: PhaseKey): number {
  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error(`${label} wait-gate: list.txt missing at ${art}`); return 2; }
  const rows = parseListFile(readFileSync(listPath, "utf8"));
  if (rows.length === 0) { log.error(`${label} wait-gate: list.txt has no workers`); return 2; }
  const workers = rows.map((r) => ({
    agent: r.agent,
    doneExists: existsSync(join(art, `${phase}-${r.agent}.done`)),
    stateText: readIfExistsOrNull(join(art, `${phase}-${r.agent}.txt`)),
  }));
  const states = gateState(workers, key);
  for (const s of states) process.stdout.write(`${s.agent}\t${s.status}\n`);
  for (const a of gateAnomalies(workers, key)) {
    log.warn(`${label} wait-gate: ${a.agent} is terminal via ${key}=${a.value} — its ${phase} artifact may be missing`);
  }
  return states.every((s) => s.status === "terminal") ? 0 : 1;
}

/** The `<topic> <agent> <provider>` arg-parse wrapper the eighteen send/wait verbs share. `usageLabel`
 *  is the full verb name ("explore gap-send"), so the usage line stays byte-identical per verb. */
export function triad<D>(
  usageLabel: string,
  fn: (topic: string, agent: string, provider: string, d: D) => Promise<number>,
  deps: D,
): (rest: string[]) => Promise<number> {
  return async (rest: string[]): Promise<number> => {
    const [topic, agent, provider] = rest;
    if (!topic || !agent || !provider) { log.error(`usage: ${usageLabel} <topic> <agent> <provider>`); return 2; }
    return fn(topic, agent, provider, deps);
  };
}
