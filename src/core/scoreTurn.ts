// src/core/scoreTurn.ts — multi-part research-phase turn helpers for score.
// Built on the ipc primitives + the classifyTurn/parseOffset *semantics* from turn.ts
// (reused, not bent). The verify-phase composer + state machine land in Phase D.
import type { OutboxEvent } from "./ipc.js";
import { parseClaims } from "./scoreDiff.js";

/** Research findings.md health, ported from consult_findings_status (lib/consult.sh).
 *  null (file absent) -> "missing"; >=1 parseable `N. [cite] text` claim -> "ok";
 *  else non-blank lines under `## Claims` -> "malformed"; otherwise -> "empty". */
export function findingsStatus(text: string | null): "ok" | "empty" | "malformed" | "missing" {
  if (text === null) return "missing";
  if (parseClaims(text).length > 0) return "ok";
  let inClaims = false;
  let count = 0;
  for (const line of text.split("\n")) {
    if (/^## Claims/.test(line)) { inClaims = true; continue; }
    if (/^## /.test(line)) { inClaims = false; }
    if (inClaims && line.trim() !== "") count++;
  }
  return count > 0 ? "malformed" : "empty";
}

export type FsState = "ok" | "empty" | "malformed" | "missing" | "failed" | "timeout" | "question";

/** Map a research wait outcome to its FS= value, ported from cw_consult_wait (lib/consult-wait.sh):
 *  null (no terminal event before timeout) -> timeout; question -> question;
 *  done -> findingsStatus; any other event (error/unknown) -> failed. */
export function researchState(ev: OutboxEvent | null, findingsText: string | null): FsState {
  if (!ev) return "timeout";
  if (ev.event === "question") return "question";
  if (ev.event === "done") return findingsStatus(findingsText);
  return "failed";
}

/** The LAST `OFFSET=<n>` line in a state file's contents. The question re-arm appends a second
 *  OFFSET= line (bumped past the question event); the re-armed wait must resume from the latest.
 *  Distinct from turn.ts parseOffset (first match — correct for solo's single-offset file).
 *  null if absent/unparseable. */
export function parseLatestOffset(stateText: string): number | null {
  const ms = [...stateText.matchAll(/^OFFSET=(\d+)\s*$/gm)];
  return ms.length ? Number(ms[ms.length - 1][1]) : null;
}

/** Apply a provider's timeout_multiplier to a base timeout, ported from cw_consult_wait's
 *  `printf "%d", b*m + 0.5` (round-half-up to an integer second). Bad/<=0 multiplier -> identity. */
export function scaledTimeout(baseSec: number, multiplier: string): number {
  const m = Number(multiplier);
  return Math.floor(baseSec * (Number.isFinite(m) && m > 0 ? m : 1) + 0.5);
}
