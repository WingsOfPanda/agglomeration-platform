// src/core/implementHold.ts — the premature-`done` HOLD for implement's turn wait
// (2026-09-04-parallel-slices-design.md, J).
//
// A worker that emits `done` after every plan task ended its turn at the FIRST one: the verify
// report did not exist yet, so the turn classified `failed` and the retry re-sent round 1 into a
// worker that was still implementing. The hold keeps that turn open — a report-less `done` re-arms
// the wait instead of ending it — and ends `failed` only once the worker's PANE has stopped
// changing, which is independent of the worker discipline that failed.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  outboxOffset, outboxPath, outboxWaitSince,
  type Clock, type OutboxEvent, type PaneOwner, type WaitLivenessOpts,
} from "./ipc.js";
import { awaitTurn, type WaitFn } from "./wait.js";
import { paneOwned } from "./tmux.js";
import { readIfExistsOrNull } from "./fsread.js";
import { isoUtc } from "./archive.js";

/** Seconds of UNCHANGED pane content that end a hold as `failed`. `AP_IMPLEMENT_PREMATURE_DONE_S`
 *  overrides; 0 (or any value <= 0) DISABLES the hold and restores today's `failed`, so — like
 *  wait.ts's `turnConfirmS` and unlike env.ts's `envNum` — this honours an explicit 0. A
 *  non-numeric value falls back to the default. Separate layer from `AP_TURN_CONFIRM_S`, separate
 *  switch: the confirmation window watches the OUTBOX, this watches the PANE. */
const PREMATURE_DONE_DEFAULT_S = 1800;
export function prematureDoneS(): number {
  const raw = process.env.AP_IMPLEMENT_PREMATURE_DONE_S;
  const n = raw === undefined || raw.trim() === "" ? PREMATURE_DONE_DEFAULT_S : Number(raw);
  if (!Number.isFinite(n)) return PREMATURE_DONE_DEFAULT_S;
  return n <= 0 ? 0 : n;
}

/** ONE closure per turn, shared by every re-arm of that turn, run as the wait's `onPoll` hook: it
 *  hashes the pane's content and returns a synthetic `error` once the hash has been unchanged for
 *  `idleS` seconds. The first call only records the baseline. `capturePane` returns "" on any tmux
 *  error, so a vanished pane hashes stable and reaches `pane-idle` rather than throwing.
 *
 *  The event is IN-PROCESS ONLY and is never appended to any outbox — the discipline
 *  `WORKER_DEAD_EVENT` (src/core/job.ts) states: the frozen event names are what a WORKER writes,
 *  this is what a verb DECIDES, and forensics scrapes outbox files only. */
export function paneIdleProbe(
  d: { capture: () => Promise<string>; now: () => number; idleS: number },
): () => Promise<OutboxEvent | null> {
  let hash = "";
  let since = 0;
  return async () => {
    const h = createHash("sha256").update(await d.capture()).digest("hex");
    const t = d.now();
    if (h !== hash) { hash = h; since = t; return null; }
    return t - since >= d.idleS * 1000 ? { event: "error", note: "pane-idle", ts: isoUtc() } : null;
  };
}

/** One re-armed leg of a held turn. It takes only the budget: the offset it resumes from is the
 *  `OFFSET=` line the hold appended to the state file, which `awaitTurn` resolves itself. */
export type RearmFn = (timeoutS: number) => Promise<OutboxEvent | null>;

export interface HoldCtx {
  agent: string; model: string; topic: string;
  /** The turn's state file: where the hold's `OFFSET=` / `PD=` lines go. */
  stateFile: string;
  round: number | string;
}

export interface HoldDeps {
  /** The turn's completion evidence — a `done` without it is what gets held. */
  evidencePath: string;
  /** Wait start + the turn budget: a hold can never outlive the turn deadline. */
  deadlineMs: number;
  now: () => number;
  rearm: RearmFn;
  onFlag(note: string): void;
}

/** The liveness opts EVERY re-armed leg runs on. Its own function because both of its properties
 *  are load-bearing and otherwise unpinnable: `extendMult: 1` makes the turn deadline the leg's only
 *  bound (the default `AP_WAIT_EXTEND_MULT=3` would stretch a held leg to 12h), and the pane-idle
 *  probe on `onPoll` is the only thing that can end a hold before that deadline. `paneAlive` closes
 *  over the RECORDED nonce, so a pane id tmux has since handed to another program cannot read as
 *  "the worker is alive". */
export function holdWaitOpts(pane: PaneOwner, probe: () => Promise<OutboxEvent | null>): WaitLivenessOpts {
  return { paneAlive: (p) => paneOwned(p, pane.nonce), paneId: pane.paneId, extendMult: 1, onPoll: probe };
}

export interface LiveRearmDeps {
  pane: PaneOwner;
  probe: () => Promise<OutboxEvent | null>;
  clock: Clock;
  onFlag(note: string): void;
  /** The leg's own wait. Left unset by the live verb — the default IS `outboxWaitSince` on
   *  `holdWaitOpts`; tests bind one to drive the leg without a tmux server. */
  wait?: WaitFn;
}

/** The hold's re-arm (J step 2): `awaitTurn` again, from the `OFFSET=` line the hold just appended.
 *  Going back through awaitTurn rather than calling the matcher directly is what gives a re-armed
 *  leg the two things the first leg has. It resolves its terminal event in FILE order, so a
 *  `question` that lands after a report-less `done` in one poll region is relayed as a question
 *  (J step 4) instead of being swallowed by `lastMatch`'s frozen argument-order precedence — the
 *  worker would otherwise sit blocked on an unrelayed question until the pane went idle. And it
 *  keeps the confirmation window, so the leg that finally carries the report is held to the same
 *  still-writing veto the first one was. */
export function liveRearm(ctx: HoldCtx, d: LiveRearmDeps): RearmFn {
  const wait: WaitFn = d.wait
    ?? ((i, m, t, off, ev, to) => outboxWaitSince(i, m, t, off, ev, to, holdWaitOpts(d.pane, d.probe), d.clock));
  return async (timeoutS) => {
    const r = await awaitTurn(
      { agent: ctx.agent, model: ctx.model, topic: ctx.topic, stateFile: ctx.stateFile, timeoutS, label: "[turn-wait]", policy: { confirm: true } },
      { wait, clock: d.clock, onFlag: d.onFlag },
    );
    return "missingOffset" in r ? null : r.event;   // the hold wrote the OFFSET= line it reads
  };
}

/** Spec J's completion evidence: present AND non-empty. A worker that `touch`es its report before
 *  writing it has not finished the turn — the half-written-artifact race this repo has been bitten
 *  by before. */
function hasEvidence(path: string): boolean {
  const t = readIfExistsOrNull(path);
  return t !== null && t.length > 0;
}

/** Hold a report-less `done`, re-arming until the worker's real ending. Every other event (and a
 *  `done` whose report is there) is returned untouched, so a turn that never holds is the turn it
 *  was in 0.5.68.
 *
 *  The `OFFSET=`/`PD=` pair is appended DIRECTLY, not through `recordWaitOutcome`, whose `OFFSET=`
 *  arm always writes a terminal `<KEY>=` line beside it: a hub killed mid-hold must leave no false
 *  terminal `TS=` (the Monitor reads the file only after the verb exits, so a killed hub surfaces as
 *  `TS=unreachable`, the watcher-failure arm). The flag fires ONCE per turn — a 12-task worker must
 *  not file 12 issues — while the `PD=` lines count every hold. */
export async function holdPrematureDone(
  ev: OutboxEvent | null, ctx: HoldCtx, d: HoldDeps,
): Promise<OutboxEvent | null> {
  let cur = ev;
  let holds = 0;
  while (cur !== null && cur.event === "done" && !hasEvidence(d.evidencePath)) {
    const remainingS = Math.floor((d.deadlineMs - d.now()) / 1000);
    if (remainingS <= 0) return cur;   // the turn deadline bounds the hold
    const offset = outboxOffset(outboxPath(ctx.agent, ctx.model, ctx.topic));
    holds++;
    if (holds === 1) d.onFlag(`premature-done: ${ctx.agent} ${ctx.round} — holding`);
    appendFileSync(ctx.stateFile, `OFFSET=${offset}\nPD=${holds}\n`);
    cur = await d.rearm(remainingS);
  }
  return cur;
}
