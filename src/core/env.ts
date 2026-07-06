// src/core/env.ts — shared env-var numeric parsing for the command timeout/budget family.

/** Numeric env override with `Number(x) || def` semantics: unset, empty, non-numeric, and 0 all
 *  fall back to `def` (a 0 timeout/budget is never meaningful here). Sites that must honor an
 *  explicit 0 (e.g. autoresearch's `?? default` thresholds) intentionally do NOT use this. */
export function envNum(name: string, def: number): number {
  return Number(process.env[name]) || def;
}

/** Default worker turn/round wall-clock budget (4h), shared by the single-worker
 *  turn verbs (quick / bridge / implement). */
export const DEFAULT_TURN_BUDGET_S = 14400;
