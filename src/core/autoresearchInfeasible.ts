// INFEASIBLE-vs-REFUTED classification for /ap:autoresearch (research-validity A2).
// A result is INFEASIBLE ("couldn't be validly executed") iff its A1 verdict is `mismatch` OR its A3
// sanity flags include a core-unambiguous invalidating flag. ceiling-exceeded /
// integrity-attestation-incomplete stay advisory (do NOT make a result infeasible). Pure.

export const INFEASIBLE_FLAGS = ["under-run", "log-contradiction", "audit-knob-drift"] as const;

/** Returns the trigger reason (verdict or flag name) when infeasible, else null. */
export function classifyInfeasible(verdict: string | undefined, flags: string[]): string | null {
  if (verdict === "mismatch") return "mismatch";
  for (const f of flags) {
    if ((INFEASIBLE_FLAGS as readonly string[]).includes(f)) return f;
  }
  return null;
}

/** Parse verification.tsv into agent/exp -> latest verdict (last write wins). */
export function parseVerdicts(tsv: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of tsv.split("\n")) {
    if (!line || line.startsWith("exp_id\t")) continue;
    const c = line.split("\t");          // exp_id, agent, verdict, ...
    if (c[0] && c[1] && c[2]) out[`${c[1]}/${c[0]}`] = c[2];
  }
  return out;
}
