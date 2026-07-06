// src/core/waitLive.ts — the live wiring of outboxWaitSince's pane-liveness escape hatch.
// Kept out of ipc.ts so ipc stays free of the tmux/execa dependency (outboxWaitSince takes the
// probe as an injected function; this is the one place that binds it to the real tmux probe).
import { outboxWaitSince, paneMetaRead, type OutboxEvent } from "./ipc.js";
import { paneAlive } from "./tmux.js";

/** Drop-in replacement for the wait verbs' live `outboxWaitSince` call: identical signature, but with
 *  a pane-liveness escape hatch wired in. Reads the worker's pane id from pane.json once at wait
 *  start; if pane.json is absent the id is null and the wait degrades to the plain outbox-only poll
 *  (no behavior change). When the pane later vanishes with no terminal event, the wait returns a
 *  synthetic `error` event so the turn fails fast instead of blocking out the full turn budget. */
export function liveOutboxWait(
  i: string, m: string, t: string, offset: number, events: string[], timeoutSec: number,
): Promise<OutboxEvent | null> {
  return outboxWaitSince(i, m, t, offset, events, timeoutSec, { paneAlive, paneId: paneMetaRead(i, m, t) });
}
