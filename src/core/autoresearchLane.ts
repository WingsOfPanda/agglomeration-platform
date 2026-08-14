// The per-worker LANE for /ap:autoresearch: one home for <art>/workers/<agent>/state.txt — the
// path, the read, the read-modify-write transition, and the two reconcile flavors. The KV codec
// (parse/render/merge + the reconcile primitives) stays pure in autoresearchState.ts; this file
// owns the disk.
//
// The phase vocabulary these transitions write is CONSUMED elsewhere — pointers only, nothing
// moves: autoresearchFinalize.ts's finalizePhase case-map (wind-down normalization),
// commands/autoresearch.ts's experiment-send dispatch gate (abandoned -> rc 2, non-idle -> rc 1),
// and its fresh-worker `working` respawn refusal (rc 1).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic.js";
import { readOr } from "./fsread.js";
import { workerStateDir, experimentDir } from "./autoresearch.js";
import { parseState, mergeState, reconcileFromOutbox, reconcileFromOutboxSince } from "./autoresearchState.js";
import { finalizePhase } from "./autoresearchFinalize.js";
import { outboxPath, resolveModel } from "./ipc.js";

/** <art>/workers/<agent>/state.txt — the lane's KV file. */
export function lanePath(art: string, agent: string): string {
  return join(workerStateDir(art, agent), "state.txt");
}

/** The lane's current KV; a missing/unreadable state.txt reads as {}. */
export function readLane(art: string, agent: string): Record<string, string> {
  return parseState(readOr(lanePath(art, agent)));
}

/** The lane transition: merge `updates` over what is on disk and rewrite atomically. Touched keys
 *  overwrite; every other key survives. */
export function applyTransition(art: string, agent: string, updates: Record<string, string>): void {
  const p = lanePath(art, agent);
  atomicWrite(p, mergeState(readOr(p), updates));
}

/** finalize's reconcile: replay the PANE outbox tail past the persisted liveness cursor, then apply
 *  the wind-down phase case-map. The tail slice is hand-rolled (Buffer.subarray at the cursor) and
 *  deliberately NOT reconcileFromOutboxSince — see reconcileLaneAtResume, which additionally guards
 *  a SHRUNK outbox (an offset past EOF re-reads from byte 0). Here an offset past EOF yields an
 *  EMPTY tail and no reconcile write; finalize runs once at wind-down, so the divergence is known
 *  and deliberately left as-is. */
export function reconcileLaneAtFinalize(art: string, agent: string, topic: string): void {
  const stateTxt = lanePath(art, agent);
  if (!existsSync(stateTxt)) return;

  // (a) reconcile: replay the PANE outbox tail past the liveness cursor.
  const cursorRaw = readOr(join(workerStateDir(art, agent), "liveness-cursor.txt"));
  const offset = Number.parseInt(cursorRaw.trim(), 10) || 0;
  const model = resolveModel(agent, topic);
  const ob = model ? outboxPath(agent, model, topic) : "";
  let tail = "";
  if (ob && existsSync(ob)) {
    try { tail = readFileSync(ob).subarray(offset).toString("utf8"); } catch { tail = ""; }
  }
  const curExp = readLane(art, agent).current_exp_id ?? "";
  const doneResultExists = !!curExp && existsSync(join(experimentDir(art, agent, curExp), "result.json"));
  const recon = reconcileFromOutbox(tail, doneResultExists);
  if (recon === "failed" || recon === "idle") applyTransition(art, agent, { phase: recon });

  // (b) phase case-map.
  const np = finalizePhase(readLane(art, agent).phase ?? "");
  if (np) applyTransition(art, agent, { phase: np });
}

/** resume's reconcile: the offset-scoped, SHRINK-GUARDED replay from a ledger-recorded delivery
 *  offset. Unlike reconcileLaneAtFinalize, an offset past EOF here means a crash/rotation RECREATED
 *  the outbox, so the whole file is re-read from byte 0 (finalize's hand-rolled slice yields an
 *  empty tail instead). `expId` is the experiment whose result.json decides a `done`: resume's
 *  pass 1 passes the lane's own current_exp_id, pass 2 the unresolved intent's — hence a parameter
 *  rather than the internal derivation finalize does. */
export function reconcileLaneAtResume(art: string, agent: string, outboxText: string, offset: number, expId: string): void {
  const doneResultExists = !!expId && existsSync(join(experimentDir(art, agent, expId), "result.json"));
  const recon = reconcileFromOutboxSince(outboxText, offset, doneResultExists);
  if (recon === "failed" || recon === "idle") applyTransition(art, agent, { phase: recon });
}
