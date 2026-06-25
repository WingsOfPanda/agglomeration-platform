// Finalist selection + reliability-aware winner pick for /ap:autoresearch (capability C).
// Pure core: no fs / clock / IO, deterministic tie-breaks.
//
// Mirrors buildScoreboard (autoresearchResult.ts): the REAL ScoreRow carries `metric`
// and `runtime` as STRINGS (parseFloat-ed for sorting). A non-numeric metric ('n/a',
// '', etc.) and any row routed to the x-rank group (infeasibleReason set) or a non-ok
// status is excluded from the ranked finalist set, same as the scoreboard's ranked group.

import type { ScoreRow } from "./autoresearchResult.js";

export type Direction = "maximize" | "minimize";

/** Optional numeric signals a caller may attach to a ScoreRow for winner selection. */
export interface ScoreRowWithSignals extends ScoreRow {
  /** Held-out / re-derived metric on an independent split. Higher (or lower for minimize) = more trustworthy. */
  heldOut?: number;
  /** Aggregate reliability score in the objective's direction. */
  reliability?: number;
}

/** Direction-aware compare: returns a value whose sign sorts best-first. */
function cmp(a: number, b: number, direction: Direction): number {
  return direction === "minimize" ? a - b : b - a;
}

function finiteNum(v: unknown): number | undefined {
  // Treat empty / whitespace-only strings as non-numeric (Number('') is 0, which we don't want
  // to count as a real metric). 'n/a' and other non-numeric strings already parse to NaN.
  if (typeof v === "string" && v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Top-k feasible ok rows in direction order.
 *  Filters to status==='ok', no infeasibleReason (x-rank rows excluded), and a finite parsed
 *  metric (non-numeric 'n/a'/'' rows excluded). Sorts on the PARSED metric number (direction-aware),
 *  tie-breaking on parsed runtime ascending then expId.localeCompare. k is clamped to >= 1. */
export function selectFinalists<T extends ScoreRow>(rows: T[], k: number, direction: Direction): T[] {
  return rows
    .filter((r) => r.status === "ok" && !r.infeasibleReason && finiteNum(r.metric) !== undefined)
    .sort(
      (a, b) =>
        cmp(Number(a.metric), Number(b.metric), direction) ||
        (Number(a.runtime) || 0) - (Number(b.runtime) || 0) ||
        a.expId.localeCompare(b.expId),
    )
    .slice(0, Math.max(1, k));
}

/** Pick the winner among finalists using a reliability signal (held-out or reliability).
 *  Prefers the best signal value in the objective's direction. When no finalist carries a finite
 *  signal value, degrade to the rank-1 finalist (already best by metric) and flag degraded=true.
 *  Empty finalists -> { winner: null, degraded: true }. */
export function pickWinner<T extends ScoreRowWithSignals>(
  finalists: T[],
  signal: "held-out" | "reliability",
  direction: Direction,
): { winner: T | null; degraded: boolean } {
  if (finalists.length === 0) return { winner: null, degraded: true };
  const field: keyof ScoreRowWithSignals = signal === "held-out" ? "heldOut" : "reliability";
  const withSignal = finalists.filter((r) => finiteNum(r[field]) !== undefined);
  if (withSignal.length === 0) return { winner: finalists[0], degraded: true };
  const best = [...withSignal].sort(
    (a, b) =>
      cmp(Number(a[field]), Number(b[field]), direction) ||
      a.expId.localeCompare(b.expId),
  )[0];
  return { winner: best, degraded: false };
}
