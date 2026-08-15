// src/core/wait.ts — the wait module: the state-file micro-protocol every wait verb reads and
// writes, plus the timer the wait loops sleep on.
//
// These pieces lived in designTurn.ts, whose name says "design" while implement, quick, bridge and
// phaseTable were four non-design families depending on it, and in artifact.ts, which turn.ts
// imported purely to borrow a timer. Neither module owned them; this one does.
//
// TOLERANCE CONSTANTS — the shared vocabulary. Five numbers bound how long the platform second-
// guesses a worker before it accepts what it holds. They stay in the module that owns the loop
// reading them; this table is the one place they are named together:
//
//   MAX_VETOES          2  vetoed confirmation windows before a turn wait accepts its armed
//                          terminal event anyway (a pane still writing is chatty or stuck)   wait.ts
//   REARM_FLOOR_WINDOWS 3  confirmation windows the re-arm is guaranteed past the FIRST leg's
//                          end, so a liveness-extended leg still gets a real confirmation     wait.ts
//   QUIESCENT_POLLS     5  consecutive equal-size artifact polls (~10s) that count as
//                          "finished writing" without the sentinel                       artifact.ts
//   NO_GROWTH_STRIKES   3  backstop refusals with no growth before it degrades to the drop
//                          path                                                          artifact.ts
//   MAX_REFUSALS        6  absolute backstop refusal cap, so a drip-feeding worker cannot hold
//                          a run open forever                                            artifact.ts
import { appendFileSync, readFileSync } from "node:fs";
import {
  outboxEventsSince, outboxOffset, outboxPath, realClock, TERMINAL_EVENTS,
  type Clock, type OutboxEvent,
} from "./ipc.js";
import { liveOutboxWait } from "./waitLive.js";
import { atomicWrite } from "./atomic.js";
import { log } from "./log.js";
import {
  ARTIFACT_ACCEPT_KEY, END_OF_ARTIFACT, artifactGraceS, awaitArtifact, type WaitAccept,
} from "./artifact.js";

/** The LAST `<KEY>=<n>` integer line in a state file's contents (latest-line-wins). The question
 *  re-arm appends a second keyed line (bumped past the question event), so the re-armed read must
 *  resume from the latest. null if absent/unparseable. */
export function lastKeyedNumber(text: string, key: string): number | null {
  const ms = [...text.matchAll(new RegExp(`^${key}=(\\d+)\\s*$`, "gm"))];
  return ms.length ? Number(ms[ms.length - 1][1]) : null;
}

/** The LAST `OFFSET=<n>` line — the re-armed wait resumes from the latest. */
export function parseLatestOffset(stateText: string): number | null {
  return lastKeyedNumber(stateText, "OFFSET");
}

/** Shared wait-verb tail — the WAIT side's single writer of the `OFFSET=` / `<KEY>=` state-file
 *  micro-protocol (parseLatestOffset / lastKeyedNumber here, designTurn's gateState, are its
 *  readers). The send verbs write the phase's FIRST `OFFSET=` line themselves before dispatching;
 *  that is a different verb and stays theirs. A captured question writes the question payload file,
 *  then re-arms the state file with the outbox offset bumped PAST the handled question event (plus
 *  any caller extra lines, e.g. implement's `OBJECTIONS=` counter) so a same-round re-arm does not
 *  re-read it. Every other outcome appends the terminal `<key>=<state>` line (latest-line-wins).
 *  Callers add their own `.done` marker / logging.
 *
 *  `lead` is one extra `<KEY>=<value>` line written AHEAD of the terminal line in the same append
 *  (phaseWait's `AC=` artifact verdict). Ahead, so the phase key stays the file's LAST line — the
 *  directives' `grep '^FS=' | tail -1` idiom and the "last line shows FS=question" prose both hold. */
export function recordWaitOutcome(
  agent: string, model: string, topic: string, stateFile: string,
  state: string, key: string,
  question?: { file: string; body: string; extraLines?: string },
  lead?: string,
): void {
  const head = lead ? `${lead}\n` : "";
  if (state === "question" && question) {
    atomicWrite(question.file, question.body);
    const bumped = outboxOffset(outboxPath(agent, model, topic));
    appendFileSync(stateFile, `${head}OFFSET=${bumped}\n${key}=question\n${question.extraLines ?? ""}`);
  } else {
    appendFileSync(stateFile, `${head}${key}=${state}\n`);
  }
}

/** Apply a provider's timeout_multiplier to a base timeout, ported from the consult_wait loop's
 *  `printf "%d", b*m + 0.5` (round-half-up to an integer second). Bad/<=0 multiplier -> identity. */
export function scaledTimeout(baseSec: number, multiplier: string): number {
  const m = Number(multiplier);
  return Math.floor(baseSec * (Number.isFinite(m) && m > 0 ? m : 1) + 0.5);
}

// ---------------------------------------------------------------------------------------------
// awaitTurn — the ONE entry point every turn/round/phase wait goes through.
// ---------------------------------------------------------------------------------------------

/** Seconds of outbox QUIET that confirm a terminal event ended the turn. `AP_TURN_CONFIRM_S`
 *  overrides (clamped 5..120); 0 (or any value <= 0) DISABLES the confirmation layer entirely, so
 *  unlike env.ts's `envNum` this honours an explicit 0 — same reasoning (and same shape) as
 *  artifact.ts's `artifactGraceS`. A non-numeric value falls back to the default. */
const TURN_CONFIRM_DEFAULT_S = 20;
export function turnConfirmS(): number {
  const raw = process.env.AP_TURN_CONFIRM_S;
  const n = raw === undefined || raw.trim() === "" ? TURN_CONFIRM_DEFAULT_S : Number(raw);
  if (!Number.isFinite(n)) return TURN_CONFIRM_DEFAULT_S;
  if (n <= 0) return 0;
  return Math.min(120, Math.max(5, n));
}

/** Windows a turn may have VETOED before the layer stops second-guessing the worker and accepts
 *  what it holds: a pane still writing after that many confirmations is chatty or stuck, and either
 *  way the hub is better served by a verdict than by a wait that never ends. */
const MAX_VETOES = 2;

/** Confirmation windows the re-arm phase is guaranteed past the FIRST leg's end, even when that leg
 *  blew the base budget (liveness extension runs it up to 3x). Without this floor the deadline
 *  computed from wait-START is already spent when the confirmation begins, so the layer would flag a
 *  veto and then immediately give up on it — a misleading flag and no confirmation at all. */
const REARM_FLOOR_WINDOWS = 3;

/** The wait every turn/round/phase runs on: the outbox poll, with pane-liveness wired in. */
export type WaitFn =
  (i: string, m: string, t: string, off: number, ev: string[], to: number) => Promise<OutboxEvent | null>;

/** The two protections, as slots. Each is owned by one caller family today; a family gaining the
 *  other's protection is a flag flip here, not a fourth wait wrapper. */
export interface TurnPolicy {
  /** The `AP_TURN_CONFIRM_S` quiet-window layer (quick / bridge / implement turn waits). */
  confirm?: boolean;
  /** The `AP_ARTIFACT_GRACE_S` / `AC=` layer (the nine explore/design phase waits): the artifact
   *  this turn writes, and the phase key whose classification the expiry warning names. */
  artifact?: { path: string; key: string };
}

export interface TurnCtx {
  agent: string;
  model: string;
  topic: string;
  /** The `OFFSET=` source: awaitTurn reads the LATEST line out of it itself. */
  stateFile: string;
  /** Already provider-scaled by the caller (`scaledTimeout`), where its command scales at all. */
  timeoutS: number;
  /** Log prefix for the warnings emitted from in here, e.g. "explore research-wait". */
  label: string;
  policy: TurnPolicy;
}

export interface TurnResult {
  event: OutboxEvent | null;
  /** The artifact verdict, or null when none was reached: no artifact policy, or no `done` event
   *  (nothing was written to accept, so the caller's own classification stands alone). */
  accept: WaitAccept | null;
}

export interface TurnDeps {
  /** The wait itself. Left unset by every live verb — the default IS the live wait, bound to this
   *  bag's clock, so the one `liveOutboxWait` binding in the codebase is here. Tests that script a
   *  wait still override it; a test that omits it AND omits `clock` runs the live engine on the
   *  real one, polling the outbox every second until the budget expires (a hung suite, not a
   *  failure), so leave it unset only with a virtual clock bound or a real budget in mind. */
  wait?: WaitFn;
  /** The one time source this wait runs on: the confirmation window and deadline here, and the
   *  engine's own poll and liveness extension underneath. Tests bind a virtual clock and get both
   *  layers on one timeline; the live verbs leave it unset and get the real one. */
  clock?: Clock;
  /** Called with the resolved offset once, BEFORE the wait starts. Each verb's pre-wait log line
   *  has its own byte-exact wording and must still precede a wait that can run for hours, so the
   *  line stays the caller's while the offset it names is resolved here. */
  onArmed?(offset: number): void;
  /** Every forensics note this wait produces (the confirmation veto/cap/deadline, the artifact
   *  quiescence/expiry); the verbs bind it to `recordHubFlag` with their own command + topic. */
  onFlag?(note: string): void;
}

const clockOf = (d: TurnDeps): Clock => d.clock ?? realClock;

/** The wait a dep bag runs on: the injected one, or the live outbox poll bound to that bag's clock
 *  — the one place `liveOutboxWait` is wired in the codebase. Exported for the one wait that is
 *  NOT a turn wait and so does not go through awaitTurn: design's drilldown, which listens for its
 *  own `["done", "error"]` event list and resolves no state-file offset. */
export function boundWait(d: { wait?: WaitFn; clock?: Clock }): WaitFn {
  return d.wait ?? ((i, m, t, off, ev, to) => liveOutboxWait(i, m, t, off, ev, to, d.clock));
}

/** The LAST terminal event in file order, or null when the region holds none. */
function latestTerminal(events: OutboxEvent[]): OutboxEvent | null {
  for (let k = events.length - 1; k >= 0; k--) if (TERMINAL_EVENTS.includes(events[k].event)) return events[k];
  return null;
}

/** The round-based turn/round waits' terminal event, CONFIRMED against continued outbox activity.
 *
 *  A worker (codex's internal-agents mode, observed) can emit `done`/`error` mid-turn and keep
 *  working; the bare wait classified those live turns as ended. So: take the first terminal event
 *  exactly as today (the injected wait, pane-liveness extension included), re-derive the armed event
 *  as the LATEST terminal in FILE order, then hold the verdict for one quiet window
 *  (`AP_TURN_CONFIRM_S`). An outbox that GREW during the window vetoes the classification and the
 *  wrapper re-arms — as a SHORT `d.wait` from the window's start offset, so pane-liveness still fails
 *  fast and the armed event cannot re-match itself. A re-arm that finds nothing while the outbox also
 *  stopped growing means the burst was trailing noise: accept what is armed rather than sit out the
 *  turn budget.
 *
 *  Bounds (the layer must never become the thing that hangs a run): at most MAX_VETOES vetoed
 *  windows, so at most MAX_VETOES+1 window sleeps of `AP_TURN_CONFIRM_S`; the re-arm's short waits
 *  run until `max(wait-start + timeoutS, first-leg-end + REARM_FLOOR_WINDOWS windows)`. Hitting the
 *  cap or the deadline accepts the armed event and records its own distinct flag, so /ap:review sees
 *  WHY a turn was accepted unconfirmed.
 *
 *  A `question` is never confirmed: the worker has STOPPED to ask, so it cannot emit another terminal
 *  on its own, and waiting out its outbox would deadlock the hub (which relays the answer) against
 *  the worker (which waits for it). It short-circuits — on the first armed event and after every
 *  re-arm.
 *
 *  The verdict is the LATEST terminal event in FILE order — the one deliberate divergence from
 *  `lastMatch`'s frozen argument-order precedence (where a `done` anywhere beats a LATER `error`),
 *  confined to this policy: every other consumer of that matcher, and every other wait, is
 *  untouched. `AP_TURN_CONFIRM_S=0` returns the first event with zero extra reads or sleeps, i.e.
 *  byte-identical 0.5.14 behavior. The chosen event feeds each verb's existing classification,
 *  question-payload and state-write pipeline unchanged. */
async function confirmedTerminal(
  i: string, m: string, t: string, offset: number, timeoutS: number, d: TurnDeps,
): Promise<OutboxEvent | null> {
  const { now } = clockOf(d);
  const startMs = now();
  const first = await boundWait(d)(i, m, t, offset, TERMINAL_EVENTS, timeoutS);
  const confirmS = turnConfirmS();
  if (!first || confirmS === 0) return first;
  const legEndMs = now();
  const path = outboxPath(i, m, t);
  const { sleep } = clockOf(d);
  const windowMs = confirmS * 1000;
  const deadlineMs = Math.max(startMs + timeoutS * 1000, legEndMs + REARM_FLOOR_WINDOWS * windowMs);
  let armed = latestTerminal(outboxEventsSince(i, m, t, offset)) ?? first;
  let vetoes = 0;
  for (;;) {
    if (armed.event === "question") return armed;   // a stopped worker cannot confirm anything
    const s0 = outboxOffset(path);
    await sleep(windowMs);
    if (outboxOffset(path) <= s0) return armed;     // no GROWTH (a shrink is not activity)
    if (vetoes >= MAX_VETOES) {
      d.onFlag?.(`turn-confirm-cap: ${m} still writing after ${vetoes + 1} windows — accepting ${armed.event}`);
      return armed;
    }
    d.onFlag?.(`turn-confirm-veto: ${m} premature ${armed.event} — outbox still active`);
    vetoes++;
    let next: OutboxEvent | null = null;
    while (!next) {
      const before = outboxOffset(path);
      next = await boundWait(d)(i, m, t, s0, TERMINAL_EVENTS, confirmS);
      if (next) break;
      if (outboxOffset(path) <= before) return armed;   // quiescent: the burst was trailing noise
      if (now() >= deadlineMs) {
        d.onFlag?.(`turn-confirm-deadline: ${m} re-arm expired — accepting ${armed.event}`);
        return armed;
      }
    }
    // A synthetic event (liveOutboxWait's pane-died error) is not in the file: fall back to it.
    armed = latestTerminal(outboxEventsSince(i, m, t, s0)) ?? next;
  }
}

/** The artifact policy's grace. A `done` event whose artifact lacks the sentinel is a worker that
 *  emitted done before its file was written: hold the phase open for the grace window, then
 *  classify. Two acceptances (the 2026-07-31 quiescence amendment): the sentinel lands, OR the file
 *  is non-empty and stops changing — finished work from a worker that skipped a soft-compliance
 *  line, accepted exactly like a sentinel but flagged for /ap:review. Only an empty or still-growing
 *  artifact expires. Non-done terminal events (error/question) bypass the check entirely.
 *
 *  The outcome is returned as its OWN verdict for the caller to record as an `AC=` line, never
 *  folded into the phase key. Two reasons, both bugs the first draft shipped: (1) the validators
 *  need "did the wait accept this file?", which `<KEY>=ok` does not answer (explore's healthy
 *  findings classify `empty`); (2) forcing `<KEY>=timeout` on expiry made every later phase's
 *  dispatch guard treat that worker as unsafe and cascade-skip it, so ONE missing optional artifact
 *  silently ended a worker's run. */
async function artifactAccept(
  ctx: TurnCtx, art: { path: string; key: string }, ev: OutboxEvent | null, d: TurnDeps,
): Promise<WaitAccept | null> {
  const { label, agent } = ctx;
  const artifact = art.path;
  const graceS = artifactGraceS();
  const isDone = ev !== null && ev.event === "done";
  const accept: WaitAccept | null = !isDone
    ? null // no done event: nothing was written to accept — the stateFn's answer stands alone
    : graceS > 0 ? await awaitArtifact(artifact, graceS, clockOf(d).sleep) : "unchecked";
  if (accept === "quiescent") {
    log.warn(`${label}: ${agent} ${artifact} has no ${END_OF_ARTIFACT} but stopped growing — accepting it and flagging the missing sentinel`);
    d.onFlag?.(`artifact-quiescent-no-sentinel: ${agent} ${artifact}`);
  }
  if (accept === "expired") {
    log.warn(`${label}: ${agent} ${artifact} has no ${END_OF_ARTIFACT} after ${graceS}s grace — recording ${ARTIFACT_ACCEPT_KEY}=expired (the validators drop this artifact; ${art.key} keeps its own classification so later phases still dispatch)`);
    d.onFlag?.(`artifact-incomplete: ${agent} ${artifact} done-event without ${END_OF_ARTIFACT} after ${graceS}s grace`);
  }
  return accept;
}

/** ONE wait for every worker turn: it owns offset resolution, terminal selection, and BOTH
 *  still-writing probes as policy slots — the quiet-window confirmation that watches OUTBOX growth
 *  and the grace that watches ARTIFACT growth. Before this, the same question ("did the worker
 *  really finish?") was answered by two disjoint probes owned by two disjoint caller sets, and
 *  neither family could use the other's protection.
 *
 *  What stays with the callers is what genuinely differs per caller: the `<KEY>=skipped` fast-path
 *  and the `.done` marker (phase waits), the pre/post log lines, the outcome classifier, the
 *  `recordWaitOutcome` write (a layer records its OWN verdict — that rule is not diluted), the
 *  question-payload capture, and implement's verify-report gate.
 *
 *  A missing `OFFSET=` is REPORTED, not handled: each verb keeps its own error wording and rc. */
export async function awaitTurn(ctx: TurnCtx, d: TurnDeps): Promise<TurnResult | { missingOffset: true }> {
  const { agent, model, topic, timeoutS, policy } = ctx;
  const offset = parseLatestOffset(readFileSync(ctx.stateFile, "utf8"));
  if (offset === null) return { missingOffset: true };
  d.onArmed?.(offset);
  const event = policy.confirm
    ? await confirmedTerminal(agent, model, topic, offset, timeoutS, d)
    : await boundWait(d)(agent, model, topic, offset, TERMINAL_EVENTS, timeoutS);
  return { event, accept: policy.artifact ? await artifactAccept(ctx, policy.artifact, event, d) : null };
}
