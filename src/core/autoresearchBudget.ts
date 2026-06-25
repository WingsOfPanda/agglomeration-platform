// Adaptive marginal-gain stop for autoresearch.
//
// Composes with (does not replace) the existing autoresearch stop conditions
// (target reached / hard budget exhausted / plateau). This one fires when the
// recent return on spend has collapsed: over a trailing window of dispatch
// steps, the positive marginal metric gain earned per unit cost has fallen
// below `threshold`.
//
// Pure: no fs / clock / IO. Deterministic.

export function marginalGainStop(
  history: { metric: number; cost: number }[],
  threshold: number,
  window: number,
  direction: 'maximize' | 'minimize',
): boolean {
  // Never fire before the window is full: we need `window` marginal steps,
  // which requires window + 1 observations.
  if (history.length < window + 1) return false;

  const tail = history.slice(-(window + 1));
  let gain = 0;
  let cost = 0;
  for (let i = 1; i < tail.length; i++) {
    const d =
      direction === 'minimize'
        ? tail[i - 1].metric - tail[i].metric
        : tail[i].metric - tail[i - 1].metric;
    gain += Math.max(0, d);
    cost += tail[i].cost;
  }
  return cost > 0 && gain / cost < threshold;
}
