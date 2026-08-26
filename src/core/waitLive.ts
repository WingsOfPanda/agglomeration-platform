// src/core/waitLive.ts — the live wiring of outboxWaitSince's pane-liveness escape hatch.
// Kept out of ipc.ts so ipc stays free of the tmux/execa dependency (outboxWaitSince takes the
// probe as an injected function; this is the one place that binds it to the real tmux probe).
import { outboxWaitSince, paneMetaRead, type Clock, type OutboxEvent } from "./ipc.js";
import { paneOwned } from "./tmux.js";
import { envNum } from "./env.js";

/** Drop-in replacement for the wait verbs' live `outboxWaitSince` call: identical signature, but with
 *  a pane-liveness escape hatch wired in. Reads the worker's pane id from pane.json once at wait
 *  start; if pane.json is absent — or records no ownership nonce — the id is null and the wait
 *  degrades to the plain outbox-only poll (no behavior change). When the pane later vanishes with
 *  no terminal event, the wait returns a
 *  synthetic `error` event so the turn fails fast instead of blocking out the full turn budget.
 *  Conversely, a pane not confirmed dead at budget expiry extends the wait up to
 *  AP_WAIT_EXTEND_MULT x the budget — a live worker outrunning its budget is mid-turn, not dead.
 *  Knob semantics: default 3; set 1 to DISABLE (envNum's `|| def` means 0/unset also fall back
 *  to 3, so 1 is the only off-switch); clamped to <=10 so a typo cannot yield a multi-day wait. */
/** `onPoll` (last, optional) is forwarded straight into the wait's existing per-`everyS` poll — the
 *  seam `job wait` uses to run its worker classifier at the pane probe's cadence. Omitted by every
 *  other caller, and omitted it changes nothing: the wait is the wait it always was. */
export function liveOutboxWait(
  i: string, m: string, t: string, offset: number, events: string[], timeoutSec: number, clock?: Clock,
  onPoll?: () => Promise<OutboxEvent | null>,
): Promise<OutboxEvent | null> {
  // The probe is ownership-checked, not id-only: a pane id recorded before a tmux server restart
  // can name a stranger's pane, and reading that as "the worker is alive" would extend the wait
  // instead of failing fast. A pane.json with no nonce disables the check exactly as an ABSENT one
  // does (paneId null -> plain outbox-only poll): the probe could only ever answer false for it, and
  // "unverifiable" is not "dead" — enabling it would fabricate a pane-died error ~30s into every
  // wait on a live pre-0.5.30 worker.
  const owner = paneMetaRead(i, m, t);
  return outboxWaitSince(i, m, t, offset, events, timeoutSec, {
    paneAlive: (p) => paneOwned(p, owner?.nonce ?? ""),
    paneId: owner?.nonce ? owner.paneId : null,
    extendMult: envNum("AP_WAIT_EXTEND_MULT", 3),
    onPoll,
  }, clock);
}
