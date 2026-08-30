// src/core/exploreGrill.ts — frame + grill helpers for /ap:explore Phase 0.5 and Phase 8c
// (2026-08-30 spec). Pure (no fs, no IPC): the directive owns both interviews and their $ART
// records, this module owns only the text that reaches a worker. The drill prompt body carries NO
// done-event line and NO END_OF_INSTRUCTION — `send` -> `inboxWrite` appends exactly one of each
// (same contract as exploreTurn.ts / exploreOpenq.ts).
import { artifactContract } from "./artifact.js";

/** The research-prompt block for a run that answered the frame round. Empty (or whitespace-only)
 *  input returns "" so the prompt stays byte-identical to a run without `frame.md`. */
export function frameBlock(frameText: string): string {
  const t = frameText.trim();
  if (!t) return "";
  return "Framing (user-settled — treat as constraints, do not re-litigate):\n" + t;
}

/** The `- ` bullets of a `grill-facts-<agent>.txt` (the `parseOpenQuestions` shape, minus the
 *  section scan — the file is flat). Missing/empty text or zero bullets → []. */
export function parseFacts(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^- +(.*\S)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** One bounded fact-finding turn over the grill's unresolved facts. The hub cites the answers into
 *  `grill.md`; it never re-gates anything on them. */
export function composeDrillPrompt(topic: string, facts: string[], writeTo: string): string {
  const items = facts.map((f, i) => `F${i + 1}. ${f}`).join("\n");
  return [
    "The run's landscape doc is final and the Hub is now grilling it with the user.",
    "The questions below are FACTS the decision needs and no artifact of this run",
    "answers. Resolve each from evidence: use any tool available in your environment",
    "(files, web search / fetch where present) and cite what you open.",
    "",
    `Topic: ${topic.trim()}`,
    "",
    "Facts to resolve:",
    items,
    "",
    `Output requirements — write to ${writeTo} with this EXACT structure:`,
    "",
    "  ## F1 <question restated>",
    "  <answer, with [citation] anchors>",
    "",
    "  ## F2 <question restated>",
    "  ...",
    "",
    "One section per fact, numbered as above. If a fact cannot be resolved from the",
    "evidence available, write exactly \"cannot resolve, because <reason>\" under its",
    "heading — an honest non-answer is more useful than a guess the user will act on.",
    "This is a fact turn: do not re-argue the landscape doc and do not recommend.",
    "",
    artifactContract(writeTo),
  ].join("\n");
}
