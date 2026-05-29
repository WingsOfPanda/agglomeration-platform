export interface Verdict { tag: "AGREE" | "DISPUTE" | "UNCERTAIN"; cite: string; text: string; evidence: string; }

/** Port of cw_consult_parse_verdicts (lib/consult.sh:347): `N. TAG [cite] text` + optional indented
 *  evidence continuation lines, under `## Verdicts`. Only AGREE/DISPUTE/UNCERTAIN accepted. */
export function parseVerdicts(verify: string): Verdict[] {
  const out: Verdict[] = [];
  let inV = false;
  let cur: Verdict | null = null;
  const flush = (): void => { if (cur) { out.push(cur); cur = null; } };
  for (const line of verify.split("\n")) {
    if (/^## Verdicts/.test(line)) { inV = true; continue; }
    if (/^## /.test(line)) { flush(); inV = false; continue; }
    if (inV && /^[0-9]+\. (AGREE|DISPUTE|UNCERTAIN) \[[^\]]+\] /.test(line)) {
      flush();
      const rest = line.replace(/^[0-9]+\. /, "");
      const tag = rest.slice(0, rest.indexOf(" ")) as Verdict["tag"];
      const afterTag = rest.replace(/^[A-Z]+ /, "");
      const m = afterTag.match(/\[[^\]]+\]/)!;
      const cite = m[0].slice(1, -1);
      const text = afterTag.slice((m.index ?? 0) + m[0].length).replace(/^[ \t]+/, "");
      cur = { tag, cite, text, evidence: "" };
      continue;
    }
    if (inV && cur && /^[ \t]+/.test(line)) {
      const ev = line.replace(/^[ \t]+/, "");
      cur.evidence = cur.evidence === "" ? ev : `${cur.evidence} ${ev}`;
      continue;
    }
  }
  flush();
  return out;
}
