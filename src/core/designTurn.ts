// src/core/designTurn.ts — multi-worker research-phase turn helpers for design.
// Built on the ipc primitives + the classifyTurn *semantics* from turn.ts
// (reused, not bent). The wait machinery every command shares — the `OFFSET=`/`<KEY>=` micro-
// protocol and the provider timeout scaling — lives in core/wait.ts; what is left here is design's.
import { type OutboxEvent } from "./ipc.js";
import { parseClaims } from "./designDiff.js";
import { artifactContract } from "./artifact.js";
import { lastTag } from "./roster.js";
import type { PhaseKey } from "./phaseTable.js";

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

/** Map a research wait outcome to its FS= value, ported from consult_wait (lib/consult-wait.sh):
 *  null (no terminal event before timeout) -> timeout; question -> question;
 *  done -> findingsStatus; any other event (error/unknown) -> failed. */
export function researchState(ev: OutboxEvent | null, findingsText: string | null): FsState {
  if (!ev) return "timeout";
  if (ev.event === "question") return "question";
  if (ev.event === "done") return findingsStatus(findingsText);
  return "failed";
}

const RESEARCH_BLOCKERS =
  "IF YOU ARE BLOCKED:\n" +
  "- If a referenced path, file, command, env var, or assumption is wrong or missing, do NOT guess\n" +
  "  or silently work around it. Append a question event to your outbox and stop:\n" +
  '  {"event":"question","message":"<what you need and why>","ts":"<iso>"}\n' +
  "  The Hub will reply via your inbox, then re-engage you.\n";

/** Research-phase prompt body (port of config/prompt-templates/consult/research.md, rebranded).
 *  NOTE: must NOT include END_OF_INSTRUCTION or the done-event line — inboxWrite() appends the
 *  canonical done instruction and the fence when this becomes the inbox task (cf. composeRound1Prompt). */
export function composeResearchPrompt(topicText: string, findingsPath: string): string {
  const topic = topicText.trim();
  return [
    "Investigate the following topic and produce structured findings.",
    "",
    `Topic: ${topic}`,
    "",
    `Output requirements — write to ${findingsPath} with this EXACT structure:`,
    "",
    `  # Findings: ${topic}`,
    "",
    "  ## Summary",
    "  <2-3 sentence overview, free-form prose>",
    "",
    "  ## Claims",
    "  1. [<source citation>] <one-sentence claim>",
    "  2. [<source citation>] <one-sentence claim>",
    "  ...",
    "",
    "  ## Notes",
    "  <any free-form additions; not parsed>",
    "",
    "Citation format options:",
    "  - <file path>:<line>          e.g. src/auth/store.py:42",
    "  - <file path>:<line-range>    e.g. src/auth/refresh.py:15-30",
    "  - <URL>                       e.g. https://datatracker.ietf.org/doc/html/rfc6749",
    "  - runtime: <command>          e.g. runtime: pytest tests/test_auth.py",
    "",
    "Each claim must have a citation in [brackets]. Claims without citations will be silently",
    "dropped — and if NO claim has a citation, your findings will be flagged as malformed.",
    "",
    "Research methods: use any tool available in your environment. When local repository evidence is",
    "insufficient or the topic references external knowledge (RFCs, standards, library docs, vendor",
    "APIs, recent CVEs, design patterns), you SHOULD use web search / fetch to find authoritative",
    "sources and cite them as URL citations. Prefer primary sources over blog posts. If a tool is",
    "unavailable, fall back to local-only investigation and note the gap as an [unverified] claim.",
    "",
    RESEARCH_BLOCKERS,
    artifactContract(findingsPath),
  ].join("\n");
}

/** Verify wait outcome → VS= value, ported from the consult_wait verify branch (lib/consult-wait.sh):
 *  null → timeout; question → question; done → ok iff verify.md non-empty (the `-s` test) else missing;
 *  any other event → failed. (VS=skipped is written by verify-send on empty scope, not here.) */
export function verifyState(ev: OutboxEvent | null, verifyText: string | null): "ok" | "missing" | "failed" | "timeout" | "question" {
  if (!ev) return "timeout";
  if (ev.event === "question") return "question";
  if (ev.event === "done") return verifyText !== null && verifyText.length > 0 ? "ok" : "missing";
  return "failed";
}

export type GateStatus = "terminal" | "question" | "pending";

/** Per-worker readiness for the research/verify wait gate. `key` is the status-line prefix
 *  (`FS` research, `VS` explore's cross-verify + design's verify, `AS` explore's adversary,
 *  `QS` explore's open-questions relay, `RS` explore's rebuttal, `GS` explore's gap round,
 *  `SS` explore's sign-off).
 *  A worker is `terminal` once its `.done` marker exists and
 *  its LAST `<key>=` line is a non-`question` value; `question` while its last `<key>=` line is
 *  `question` (transient — awaiting a relay+re-arm); otherwise `pending` (still running). Pure:
 *  callers pass the pre-read `.done` existence and `.txt` text so this stays IPC-free and testable. */
export function gateState(
  workers: Array<{ agent: string; doneExists: boolean; stateText: string | null }>,
  key: PhaseKey,
): Array<{ agent: string; status: GateStatus }> {
  return workers.map((p) => {
    const last = lastTag(p.stateText ?? "", key);
    const status: GateStatus =
      last === "question" ? "question"
        : p.doneExists && last !== null ? "terminal"
          : "pending";
    return { agent: p.agent, status };
  });
}

/** Terminal-but-anomalous workers for the wait gate's stderr warning: `.done` exists and the
 *  LAST `<key>=` line is `timeout`, `failed` or `missing` — a state the run treats as terminal even
 *  though the phase artifact is likely missing (the 2026-07-26 review's silent-degrade class).
 *  `missing` is verifyState's answer for a worker that ANSWERED but wrote no artifact; it is the
 *  quietest member of the class (nothing failed, nothing timed out) and was the one that cascaded
 *  unnoticed, so it warns like the other two. Pure, same inputs as gateState; callers render it. */
export function gateAnomalies(
  workers: Array<{ agent: string; doneExists: boolean; stateText: string | null }>,
  key: PhaseKey,
): Array<{ agent: string; value: string }> {
  const out: Array<{ agent: string; value: string }> = [];
  for (const p of workers) {
    if (!p.doneExists) continue;
    const last = lastTag(p.stateText ?? "", key);
    if (last === "timeout" || last === "failed" || last === "missing") out.push({ agent: p.agent, value: last });
  }
  return out;
}

/** Verify-phase prompt body (port of config/prompt-templates/consult/verify.md, rebranded).
 *  Numbers the items (nl -ba -w1 -s'. '). No END_OF_INSTRUCTION/done-line — inboxWrite appends them. */
export function composeVerifyPrompt(itemsText: string, verifyPath: string): string {
  const items = itemsText.split("\n").filter((l) => l.length > 0).map((l, i) => `${i + 1}. ${l}`).join("\n");
  return [
    "You researched a topic in your previous turn. Below are claims the OTHER researchers raised that",
    "you did not. For EACH item, do ONE of:",
    "",
    "  AGREE     — confirm with your own evidence (cite a file/line/source)",
    "  DISPUTE   — explain why it's wrong, with counter-evidence",
    "  UNCERTAIN — you cannot tell from available evidence; say so",
    "",
    "Items to verify:",
    items,
    "",
    `Write your verdicts to ${verifyPath} in this exact format:`,
    "",
    "  # Verify",
    "  ## Verdicts",
    "  1. <TAG> <original [citation] and text>",
    "     <one-line evidence>",
    "  2. ...",
    "",
    "Where <TAG> is one of: AGREE / DISPUTE / UNCERTAIN.",
    "",
    "Verification methods: use any tool in your environment. WebSearch / fetch are authorized when an",
    "item cites a URL, references external standards/docs, or makes a claim local repo evidence cannot",
    "resolve. For URL-cited items, fetching the source is the default. For file-cited items prefer the",
    "local file. If a tool is unavailable, mark the item UNCERTAIN and note the gap — never fabricate.",
    "",
    RESEARCH_BLOCKERS,
    artifactContract(verifyPath),
  ].join("\n");
}

/** Drilldown wait outcome → state (port of consult-drilldown.sh await_drill): a terminal done|error
 *  event with a NON-EMPTY drill file → ok; terminal with an empty/absent file → missing (NOT success);
 *  no terminal event before timeout → timeout. Drilldown does not relay questions. */
export function drilldownState(ev: OutboxEvent | null, fileText: string | null): "ok" | "missing" | "timeout" {
  if (!ev) return "timeout";
  return fileText !== null && fileText.length > 0 ? "ok" : "missing";
}

/** Drilldown prompt body (port of config/prompt-templates/consult/drilldown.md, rebranded). No
 *  END_OF_INSTRUCTION/done-line — inboxWrite appends them. */
export function composeDrilldownPrompt(opts: { section: string; designDocPath: string; focus: string; outPath: string }): string {
  const focus = opts.focus.trim() || `Provide more depth, citations, and concrete trade-offs for the ${opts.section} section.`;
  return [
    `You are drilling deeper into the **${opts.section}** section of a design doc derived from the`,
    "investigation you just completed.",
    "",
    `Read the design doc you produced: ${opts.designDocPath}`,
    "",
    `Focus: ${focus}`,
    "",
    "Write your expanded notes (with [citation] anchors) to:",
    `  ${opts.outPath}`,
    "",
    artifactContract(opts.outPath),
  ].join("\n");
}
