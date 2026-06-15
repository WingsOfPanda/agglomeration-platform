// Pure finalize helpers for /ap:autoresearch. Faithful to the deep-research finalize script.
const HC_RE = /^\s*([a-z_]+)\s*=\s*([0-9]+(?:\.[0-9]+)?)\b/;

/** Phase case-map: working/stale/stuck/blocked->incomplete; idle/complete->complete; else null (no write). */
export function finalizePhase(cur: string): "incomplete" | "complete" | null {
  if (cur === "working" || cur === "stale" || cur === "stuck" || cur === "blocked") return "incomplete";
  if (cur === "idle" || cur === "complete") return "complete";
  return null;
}

/** Extract numeric key=value mandates from the **Hard constraints:** block (until the next blank line). */
export function parseHardConstraints(promptMd: string): { key: string; value: string }[] {
  const lines = promptMd.split("\n");
  const start = lines.findIndex((l) => l.trim() === "**Hard constraints:**");
  if (start < 0) return [];
  const out: { key: string; value: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") break;
    const m = HC_RE.exec(lines[i]);
    if (m) out.push({ key: m[1], value: m[2] });
  }
  return out;
}
