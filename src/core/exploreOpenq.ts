// src/core/exploreOpenq.ts — open-questions peer-relay helpers for /ap:explore Phase 4b.
// Pure (no fs, no IPC). After the research wait-gate is green, each worker's unresolved
// `## Open questions` bullets are round-robin routed to a DIFFERENT worker for one bounded
// answer turn; answers feed the hub's preliminary synthesis. The prompt body carries NO
// done-event line and NO END_OF_INSTRUCTION — `send` → `inboxWrite` appends exactly one of
// each (same contract as exploreTurn.ts).
import type { ListRow } from "./design.js";

export interface OpenqAssignment { from: string; question: string }

/** The `- ` bullets under `## Open questions` until the next `## ` heading. Tolerant:
 *  missing section, zero bullets, or empty text → []. Non-bullet lines are ignored. */
export function parseOpenQuestions(findingsText: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of findingsText.split("\n")) {
    if (/^## Open questions\s*$/i.test(line)) { inSection = true; continue; }
    if (/^## /.test(line)) { inSection = false; continue; }
    if (!inSection) continue;
    const m = line.match(/^- +(.*\S)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Round-robin each agent's questions to the NEXT row in list order (wrap-around): N=2 swaps,
 *  N=3 rotates a→b→c→a. A worker never receives its own questions; a worker with zero questions
 *  of its own still receives its peer's. Agents with no entry (or []) contribute nothing. */
export function assignOpenQuestions(
  rows: ListRow[], questionsByAgent: Map<string, string[]>,
): Map<string, OpenqAssignment[]> {
  const out = new Map<string, OpenqAssignment[]>();
  if (rows.length < 2) return out;
  rows.forEach((row, i) => {
    const qs = questionsByAgent.get(row.agent) ?? [];
    if (qs.length === 0) return;
    const target = rows[(i + 1) % rows.length].agent;
    const list = out.get(target) ?? [];
    for (const q of qs) list.push({ from: row.agent, question: q });
    out.set(target, list);
  });
  return out;
}

/** `openq-claims-<agent>.txt` body: one `from\tquestion` line per assignment (list.txt's TSV
 *  convention). parseOpenqClaims is the inverse; lines without a tab are dropped. */
export function formatOpenqClaims(list: OpenqAssignment[]): string {
  return list.map((a) => `${a.from}\t${a.question}`).join("\n") + "\n";
}
export function parseOpenqClaims(text: string): OpenqAssignment[] {
  const out: OpenqAssignment[] = [];
  for (const line of text.split("\n")) {
    const i = line.indexOf("\t");
    if (i <= 0) continue;
    out.push({ from: line.slice(0, i), question: line.slice(i + 1) });
  }
  return out;
}

/** One bounded answer turn over a peer's unresolved questions. */
export function composeOpenqPrompt(assignments: OpenqAssignment[], answersPath: string): string {
  const items = assignments.map((a, i) => `${i + 1}. (from ${a.from}) ${a.question}`).join("\n");
  return [
    "Your fellow workers could not resolve the questions below during their research",
    "turn. Answer each one from your own investigation: use any tool available in",
    "your environment (files, web search / fetch where present) and cite sources.",
    "",
    "Questions:",
    items,
    "",
    `Output requirements — write to ${answersPath} with this EXACT structure:`,
    "",
    "  ## Q1 <question restated>",
    "  <answer, with [citation] anchors>",
    "",
    "  ## Q2 <question restated>",
    "  ...",
    "",
    "If you cannot answer one, say so explicitly under its heading — do not pad.",
    "An honest \"cannot resolve, because <reason>\" is more useful than a weak guess.",
  ].join("\n");
}
