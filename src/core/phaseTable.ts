// src/core/phaseTable.ts — the worker-phase table for /ap:explore and /ap:design.
//
// A phase IS data: a state-file prefix, a status key, a timeout budget, an artifact path, a
// wait-outcome classifier, and (from openq onward) a dispatch-safety guard. It used to be encoded
// as ~50 lines of hand-copied control flow per phase — nine copies of one send/wait skeleton — so
// every wait-protocol change (the 0.5.5 liveness extension) had to be applied nine times, and the
// 0.5.5 VS-gap bug was exactly one missed slot in one hand-written copy. Here each phase is one
// PHASES row and the skeletons exist once: phaseSend (the send head) and dispatchPrompt (its tail),
// phaseWait (the whole wait body), surveyPhaseArtifact (the read every validator does before
// consuming a phase artifact), waitGateVerb (the gate read-out), rowFor (the phase map every verb
// that takes a phase as an argument resolves through), triad (the 3-positional arg parse).
//
// Byte-for-byte fidelity is the contract. Every log line, state-file write and rc below is the
// literal text the copied bodies emitted; the only per-phase variation is a row slot. What is NOT
// shared stays in commands/*.ts: each phase's prompt composer (it sits with its parser by design),
// its own preconditions, and each verb's arg-validation wording.
//
// A guard's chain verdict is a PRESUMPTION: it says "the worker may still be busy", inferred from
// history alone, and one expired wait used to end a worker's entire run that way. It is overridable
// — but ONLY by positive evidence that the worker is free (the 2026-08-08 lockout spec): the worker
// reported an idle status ITSELF (the spawn seed does not count), a terminal event landed past the
// failing phase's offset, that phase's artifact is settled, and its pane is alive. Silence is never
// evidence, and the rc-3 busy-gate downstream is NOT the backstop for this — it re-reads the same
// file through the same seam. Every layer records its own verdict and consumes other layers'
// recorded verdicts; none infers another's. The probe wraps the two encodings' shared consumer;
// neither encoding changes, and they stay unmerged.
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
import { assertSlug } from "./slug.js";
import { consultTimeout, agentTimeoutMultiplier, type ConsultKind } from "./contracts.js";
import {
  outboxOffset, outboxPath, outboxTerminalSince, paneMetaRead, statusPath, workerBusyState,
  workerStatusReport, type Clock, type OutboxEvent,
} from "./ipc.js";
import { paneOwned } from "./tmux.js";
import { recordHubFlag } from "./forensics.js";
import {
  ARTIFACT_ACCEPT_KEY, END_OF_ARTIFACT, WAIT_ACCEPTED, artifactBackstop,
  clearArtifactStrikes, hasArtifactSentinel, type ArtifactVerdict,
} from "./artifact.js";
import { researchState, verifyState, gateState, gateAnomalies } from "./designTurn.js";
import { awaitTurn, parseLatestOffset, recordWaitOutcome, scaledTimeout, type WaitFn } from "./wait.js";
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
  /** The exists-precondition's tail, after `${stateFile} `. Seven phases say `rm to retry`; the two
   *  one-turn-cap phases each name their own cap in their own words, so it is a string, not a flag. */
  retryNote?: string;
  guard?: PhaseGuard;
}

/** The default exists-precondition tail: a state file already there means the phase ran, and the
 *  documented recovery is to remove it. */
const RETRY_NOTE = "exists; rm to retry";

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
    retryNote: "exists — one rebuttal round per worker (the one-turn cap)",
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
    retryNote: "exists — one sign-off turn per worker (the one-turn cap)",
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

/** Which explore row owns a given key — the guards' chain entries are keys, while the files and the
 *  artifact paths hang off the row. Derived from PHASES so the phase list stays stated once. */
const EXPLORE_ROW_BY_KEY: Record<PhaseKey, PhaseRow> =
  Object.fromEntries(PHASES.map((p) => [p.key, p])) as Record<PhaseKey, PhaseRow>;

/** A worker's LAST `<key>=` value in the explore state file that owns that key; null when the phase
 *  never ran (missing file reads as ""). */
function exploreTag(art: string, agent: string, key: PhaseKey): string | null {
  return lastTag(readIf(join(art, `${EXPLORE_ROW_BY_KEY[key].phase}-${agent}.txt`)), key);
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

/** The seams the guard's evidence probes read through: the two ids they need (the agent is already
 *  a guard arg), plus the probes themselves — the frozen `workerBusyState` and the real tmux
 *  `paneOwned` by default. The send verbs pass their own `SendDeps` probes through, so the guard and
 *  dispatchPrompt's busy-gate answer from ONE seam. Omit the whole object for the history-only
 *  guard. */
export interface GuardLive {
  topic: string;
  provider: string;
  busyState?(agent: string, model: string, topic: string): string | null;
  paneOwned?(pane: string, nonce: string): Promise<boolean>;
}

/** The GuardLive a send verb hands `guardSkipped`: the phase's two ids plus its OWN probes, so the
 *  guard's evidence and dispatchPrompt's busy-gate read through one seam. Spelled here once — every
 *  send site built the same literal by hand. */
export function guardLive(topic: string, provider: string, d: SendDeps): GuardLive {
  return { topic, provider, busyState: d.busyState, paneOwned: d.paneOwned };
}

/** The evidence quadruple, in the order it is probed. All four must hold to override a skip; the
 *  first that fails becomes the reason the warning names. Every leg answers a question the chain
 *  tag CANNOT: the tag only says a wait expired. */
async function overrideEvidence(
  row: PhaseRow, art: string, agent: string, unsafe: string, live: GuardLive,
): Promise<string | null> {
  const { topic, provider } = live;
  const failKey = unsafe.split("=")[0] as PhaseKey;
  const failRow = EXPLORE_ROW_BY_KEY[failKey];
  // (a) The worker SAID it is idle. An absent status, or the spawn seed (`last_event: "spawn"`,
  // written by the platform before the worker ever reported), is silence — never evidence.
  const report = workerStatusReport(agent, provider, topic);
  if (report !== "reported") {
    return report === "seed" ? "status.json is still the spawn seed (worker never reported)" : "no status.json from the worker";
  }
  const busy = (live.busyState ?? workerBusyState)(agent, provider, topic);
  if (busy) return `live state=${busy}`;

  // (b) The turn that produced the unsafe tag actually ENDED. A wait expiry proves only that the
  // HUB stopped listening; the worker's own outbox is what says the turn is over.
  const failPhase = failRow.phase;
  const failState = readIf(join(art, `${failPhase}-${agent}.txt`));
  const offset = parseLatestOffset(failState);
  if (offset === null) return `no OFFSET recorded for ${failPhase} (cannot tell whether that turn ended)`;
  if (!outboxTerminalSince(agent, provider, topic, offset)) {
    return `no terminal outbox event since ${failPhase} OFFSET=${offset} (turn may still be running)`;
  }

  // (c) The failing phase's artifact is SETTLED — absent, empty, sentinel-terminated, or already
  // given an AC= verdict by its wait. A present-but-growing file is the 0.5.8 late-done race: the
  // worker is still writing, and a send would land mid-write.
  const artifact = failRow.artifactFor(art, agent, provider, topic);
  const text = readIfExistsOrNull(artifact);
  const settled = text === null || text.trim() === "" || hasArtifactSentinel(text)
    || WAIT_ACCEPTED.has(lastTag(failState, ARTIFACT_ACCEPT_KEY) ?? "");
  if (!settled) return `${artifact} has no ${END_OF_ARTIFACT} and no ${ARTIFACT_ACCEPT_KEY}= verdict (still being written)`;

  // (d) The pane is ALIVE. A dead worker is idle in the most literal sense and would pass every
  // check above, but dispatching to it turns a clean `<KEY>=skipped` rc-0 walk into a send failure
  // per remaining phase ("state file kept"), which is strictly worse for the operator.
  const owner = paneMetaRead(agent, provider, topic);
  if (!owner) return "no pane.json (cannot confirm the pane is alive)";
  // Unverifiable is its own answer, distinct from confirmed-gone: the override still fails closed
  // (silence is never evidence), but the operator must be able to tell "we could not check" from
  // "we checked and the pane is gone".
  if (!owner.nonce) return "pane.json predates ownership nonces (cannot confirm the pane)";
  let alive = false;
  try { alive = await (live.paneOwned ?? paneOwned)(owner.paneId, owner.nonce); } catch { alive = false; }
  if (!alive) return `pane ${owner.paneId} is gone or is not ours`;
  return null;
}

/** The guard's write+warn tail. On an unsafe chain the phase records `<key>=skipped` (so the paired
 *  wait short-circuits instead of hanging) and warns; the caller then returns 0 WITHOUT sending.
 *  Rows without a guard always return false.
 *
 *  With `live`, the chain verdict is only a presumption, and POSITIVE EVIDENCE that the worker is
 *  free overrides it: the worker reported an idle status itself, a terminal event landed past the
 *  failing phase's offset, that phase's artifact is settled, and the pane is alive. All four, or the
 *  skip stands — the override must never be inferred from silence (an absent or seeded status.json,
 *  an expired wait, a file that merely looks finished). When it does fire, dispatch proceeds and a
 *  `guard-override-idle` hub flag records it for /ap:review.
 *
 *  dispatchPrompt's rc-3 busy-gate re-runs afterwards, but it is NOT what makes this safe: it reads
 *  the same file through the same seam a moment later. The safety is the evidence quadruple. */
export async function guardSkipped(row: PhaseRow, art: string, agent: string, stateFile: string, live?: GuardLive): Promise<boolean> {
  const g = row.guard;
  if (!g) return false;
  const unsafe = g.kind === "any"
    ? anyPriorUnsafe(art, agent, g.chain)
    : latestNonSkippedUnsafe(art, agent, g.chain);
  if (!unsafe) return false;
  const label = `${row.cmd} ${row.phase}-send`;
  const why = live ? await overrideEvidence(row, art, agent, unsafe, live) : "no live probe";
  if (live && why === null) {
    log.warn(`${label}: ${agent} guard override — ${g.noun} ended ${unsafe} but the worker is verifiably free (reported idle, turn ended, artifact settled, pane alive); dispatching`);
    recordHubFlag({ command: row.cmd, topic: live.topic, note: `guard-override-idle: ${agent} ${row.phase} chain=${unsafe}` });
    return false;
  }
  atomicWrite(stateFile, `${row.key}=skipped\n`);
  log.warn(`${label}: ${agent} skipped — ${g.noun} ended ${unsafe} (worker may still be busy; sending would clobber its inbox${live ? `; ${why}` : ""})`);
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
  /** The worker's non-idle status.json state, or null when idle/absent/unreadable. Optional: the
   *  live `workerBusyState` (the frozen regex read) is the default, injected only by tests. Shared
   *  seam: the send verbs hand it to `guardSkipped` too, so the guard's evidence probe and this
   *  module's rc-3 busy-gate can never answer differently. */
  busyState?(agent: string, model: string, topic: string): string | null;
  /** tmux pane-ownership probe for the guard's fourth evidence leg (dispatchPrompt itself never
   *  probes panes). Takes the recorded nonce as well as the id: a reused id must not read as "the
   *  worker's pane is alive". Defaults to the real `paneOwned`; injected only by tests. */
  paneOwned?(pane: string, nonce: string): Promise<boolean>;
}

export interface WaitDeps {
  /** Left unset by the live verbs: awaitTurn's default is the live wait on this bag's clock. */
  wait?: WaitFn;
  multiplier(provider: string): string;
  /** The wait's time source — the engine's poll and the artifact grace loop both run on it;
   *  injected so tests do not sleep for real. */
  clock?: Clock;
}

export const liveSendDeps: SendDeps = {
  offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)),
  send: sendRun,
  busyState: workerBusyState,
  paneOwned,
};

export const liveWaitDeps: WaitDeps = {
  multiplier: agentTimeoutMultiplier,
};

/** The row-derived paths a phase's own preconditions and composer work from. Everything here is
 *  `join`ed from the row and the ids — a send verb never spells a phase path itself. */
export interface PhaseSendIO {
  art: string;
  stateFile: string;
  artifact: string;
  promptFile: string;
}

/** What a phase's preconditions decided: the composed prompt, a `<key>=skipped` no-op with its
 *  reason, or a refusal whose rc the verb chose (its own log.error is already out). */
export type PhasePrep = { prompt: string } | { skip: string } | { fail: number };

/** The two per-verb slots of the send skeleton. `prepare` is the real work — this phase's own
 *  preconditions, any side-effect write of its inputs, and its composer. `preGuard` exists for the
 *  ONE phase (gap) whose trigger check precedes its dispatch guard: both paths end in `GS=skipped`
 *  but they log different text, and the guard's evidence probes must not fire for a round that was
 *  never triggered. A precondition that must precede even the exists-check (adversary's draft,
 *  design verify's art dir) stays in the verb, ahead of its phaseSend call. */
export interface PhaseSendHooks {
  preGuard?(io: PhaseSendIO): { skip: string } | null;
  prepare(io: PhaseSendIO): PhasePrep;
}

/** The send head every dispatching phase opens with, in the shipped order: art dir, state file, the
 *  exists-precondition in the row's own words, the trigger check where a phase has one, the
 *  dispatch guard (a no-op for rows without one), the phase's own preconditions + composer, the
 *  prompt file, and dispatchPrompt's tail. Nine verbs hand-copied this; the only per-verb parts are
 *  the two hooks. */
export async function phaseSend(
  row: PhaseRow,
  ctx: { topic: string; agent: string; provider: string },
  d: SendDeps,
  hooks: PhaseSendHooks,
): Promise<number> {
  const { topic, agent, provider } = ctx;
  const art = row.artDir(topic);
  const stateFile = join(art, `${row.phase}-${agent}.txt`);
  if (existsSync(stateFile)) {
    log.error(`${row.cmd} ${row.phase}-send: ${stateFile} ${row.retryNote ?? RETRY_NOTE}`);
    return 1;
  }
  const io: PhaseSendIO = {
    art, stateFile,
    artifact: row.artifactFor(art, agent, provider, topic),
    promptFile: join(art, `${agent}_${row.phase}_prompt.md`),
  };
  const untriggered = hooks.preGuard?.(io);
  if (untriggered) return skipDispatch(row, agent, stateFile, untriggered.skip);
  if (await guardSkipped(row, art, agent, stateFile, guardLive(topic, provider, d))) return 0;
  const prep = hooks.prepare(io);
  if ("fail" in prep) return prep.fail;
  if ("skip" in prep) return skipDispatch(row, agent, stateFile, prep.skip);
  atomicWrite(io.promptFile, prep.prompt);
  return dispatchPrompt(row, { topic, agent, provider, stateFile, promptFile: io.promptFile }, d);
}

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
  const art = row.artDir(topic);
  const label = `${row.cmd} ${row.phase}-send`;
  // Busy-gate BEFORE the state-file write: a send onto a mid-turn worker rewrites the inbox task it
  // is working on. Refuse with NO state file written (no OFFSET, no `<KEY>=skipped`) so the phase
  // stays runnable. rc 3 — distinct from rc 1 (state file already exists / send failed) and rc 2
  // (usage), so the directive can branch on "busy" without parsing stderr.
  const busy = (d.busyState ?? workerBusyState)(agent, provider, topic);
  if (busy) {
    log.error(`${label}: worker ${agent} busy (state=${busy}) — not sending; re-run wait-gate and retry (status: ${statusPath(agent, provider, topic)})`);
    return 3;
  }
  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "hub", agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`${label}: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  // The documented recovery is `rm` the state file and re-send; that must reset the artifact's
  // refusal strikes too, or a retry inherits an earlier episode's counter and the FIRST refusal of
  // freshly-dispatched work degrades it to the drop path.
  clearArtifactStrikes(art, agent, row.artifactFor(art, agent, provider, topic));
  log.ok(`${label}: ${agent} offset=${offset}`);
  return 0;
}

/** The phase-wait body, identical for all nine phases: skipped fast-path, provider-scaled timeout,
 *  `awaitTurn` under the artifact policy, classify, record the outcome (a question re-arms the
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
  const timeout = scaledTimeout(consultTimeout(row.timeoutKind), d.multiplier(provider));
  const artifact = row.artifactFor(art, agent, provider, topic);
  // The wait itself is awaitTurn's: the offset read, the terminal selection, and the artifact
  // policy — the grace that holds a `done` open until its file is complete, whose verdict comes
  // back for THIS layer to record as its own `AC=` line.
  const r = await awaitTurn({
    agent, model: provider, topic, stateFile, timeoutS: timeout, label,
    policy: { artifact: { path: artifact, key: row.key } },
  }, {
    wait: d.wait, clock: d.clock,
    onArmed: (offset) => { log.info(`${label}: ${agent} offset=${offset} timeout=${timeout}s`); },
    onFlag: (note) => { recordHubFlag({ command: row.cmd, topic, note }); },
  });
  if ("missingOffset" in r) { log.error(`${label}: OFFSET not set in ${stateFile}`); return 1; }
  const { event: ev, accept } = r;

  const state = row.stateFn(ev, readIfExistsOrNull(artifact));
  recordWaitOutcome(agent, provider, topic, stateFile, state, row.key,
    ev ? { file: join(art, `question-${agent}.txt`), body: JSON.stringify(ev) + "\n" } : undefined,
    accept ? `${ARTIFACT_ACCEPT_KEY}=${accept}` : undefined);
  writeFileSync(join(art, `${row.phase}-${agent}.done`), "");
  log.ok(`${label}: ${agent} ${row.key}=${state}`);
  return 0;
}

/** What one worker's phase artifact is worth to a validator: the bytes it may parse, the phase tag
 *  that state file carries, and the backstop's verdict on it. */
export interface PhaseArtifactSurvey {
  text: string;
  tag: string | null;
  verdict: ArtifactVerdict;
}

/** A worker whose phase recorded `<key>=skipped`: nothing was dispatched, so there is nothing to
 *  judge. It carries NO `verdict` and NO `text` on purpose — the only way to reach those is to
 *  narrow this branch away (`if ("skipped" in s) …`), so a site that opts into `skipTag` cannot
 *  quietly treat a skipped worker as a judged one. Its consumers genuinely differ: rebuttal omits
 *  that worker, verdict-tally records `VERDICT=<agent>:skipped`. */
export interface PhaseArtifactSkipped {
  skipped: true;
}

/** The per-site slots; see `surveyPhaseArtifact`. `skipTag` is opt-in and changes the RETURN type. */
interface SurveyCtx {
  topic: string;
  label: string;
  emptyIsComplete: boolean;
}

/** The read every validator does before consuming one worker's phase artifact: derive the state file
 *  and the artifact from the ROW, read both once, and run `artifactBackstop` over them. The bytes
 *  judged are the bytes returned — a `mv` landing between check and use would otherwise hand the
 *  caller exactly the half-written file the check just cleared.
 *
 *  Two per-site slots, both transcribed from the shipped validators:
 *  - `emptyIsComplete` — an absent/empty artifact is that site's PRE-EXISTING no-op path (no questions
 *    to route, VS=skipped, an empty critique), so it never reaches the backstop; the diff/survivor
 *    sites have no such path and judge whatever is there.
 *  - `skipTag` — a `<key>=skipped` phase (the dispatch guard's, or a zero-input skip) is reported as
 *    `skipped` before anything is judged.
 *
 *  ONE worker per call, deliberately: `artifactBackstop` WRITES (strike logs, hub flags, STILL_WRITING
 *  on stderr), and the callers differ in when they stop — six refuse the whole verb at the first
 *  `still-writing` while three finish the roster — so surveying a worker the caller would never have
 *  reached would record strikes the shipped code never recorded. The fan-out stays at the caller. */
export function surveyPhaseArtifact(
  row: PhaseRow, w: { agent: string; provider: string }, ctx: SurveyCtx & { skipTag: true },
): PhaseArtifactSurvey | PhaseArtifactSkipped;
export function surveyPhaseArtifact(
  row: PhaseRow, w: { agent: string; provider: string }, ctx: SurveyCtx,
): PhaseArtifactSurvey;
export function surveyPhaseArtifact(
  row: PhaseRow,
  w: { agent: string; provider: string },
  ctx: SurveyCtx & { skipTag?: boolean },
): PhaseArtifactSurvey | PhaseArtifactSkipped {
  const { topic, label } = ctx;
  const art = row.artDir(topic);
  const stateText = readIf(join(art, `${row.phase}-${w.agent}.txt`));
  const tag = lastTag(stateText, row.key);
  const artifact = row.artifactFor(art, w.agent, w.provider, topic);
  const text = readIf(artifact);
  if (ctx.skipTag && tag === "skipped") return { skipped: true };
  if (ctx.emptyIsComplete && !text.trim()) return { text, tag, verdict: "complete" };
  return {
    text, tag,
    verdict: artifactBackstop({
      label, command: row.cmd, topic, art, agent: w.agent, artifact, text, stateText, key: row.key,
    }),
  };
}

/** The row a command's verb stem names — the phase map stated once, for the verbs that take a phase
 *  as an ARGUMENT (both wait-gates, design's offset-reset) and for the table-driven `-wait` dispatch.
 *  null is the caller's cue to print its own unknown-phase wording. */
export function rowFor(cmd: "explore" | "design", stem: string): PhaseRow | null {
  return (cmd === "explore" ? PHASES : DESIGN_PHASES).find((p) => p.phase === stem) ?? null;
}

/** Every phase stem of one command, in pipeline order — the `<research|openq|...>` alternation both
 *  commands print in their usage and unknown-phase lines. */
export function phaseStems(cmd: "explore" | "design"): string {
  return (cmd === "explore" ? PHASES : DESIGN_PHASES).map((p) => p.phase).join("|");
}

/** The wait-gate read-out, shared by explore's and design's `wait-gate` verb: one `<agent>\t<status>`
 *  stdout line per worker, a stderr warning for each terminal-but-anomalous worker, rc 0 only when
 *  every worker is terminal. Everything it reads hangs off the row; each verb keeps its own arg
 *  validation, whose usage/error wording differs per command. */
export function waitGateVerb(row: PhaseRow, topic: string): number {
  const { cmd: label, phase, key } = row;
  const art = row.artDir(topic);
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
    // The shared arg validation for every design/explore phase verb, so the one gate here covers
    // both skeletons: phaseSend/phaseWait spell the agent into `<phase>-<agent>.txt`,
    // `<agent>_<phase>_prompt.md` and `question-<agent>.txt` inside the already-resolved art dir,
    // ahead of the workerDir reads that would otherwise be the first thing to see it.
    assertSlug("agent", agent);
    return fn(topic, agent, provider, deps);
  };
}
