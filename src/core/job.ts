// src/core/job.ts — the detached-job record, and the pure predicates every `ap job` verb reads it
// with. The verb (src/commands/job.ts) owns the I/O and the tmux calls; everything decidable from
// values alone lives here so it can be tested without a pane, a server, or a clock.
//
// The governing rule for this module is the one the platform learned the hard way: a layer records
// its OWN verdict and consumes other layers' recorded verdicts — it never infers one. So the job
// record says what was LAUNCHED and nothing else; liveness comes from the pane nonce, progress from
// the outbox, and the hub's own state from its status.json. Four independent reads, no inference.

import { join } from "node:path";
import { jobDir } from "./paths.js";
import { ownsPane, verifiableNonce } from "./tmux.js";
import { deriveTopicFromPath } from "./implement.js";
import type { OutboxEvent, PaneOwner } from "./ipc.js";

export const JOB_COMMANDS = ["implement", "quick"] as const;
export type JobCommand = (typeof JOB_COMMANDS)[number];
export function isJobCommand(s: string): s is JobCommand {
  return (JOB_COMMANDS as readonly string[]).includes(s);
}

export interface JobRecord {
  command: JobCommand;
  topic: string;
  session: string;
  hub: { agent: string; model: string };
  provider: string;
  finish: string;
  budget_hours: number;
  max_rounds: number;
  args_file: string;
  started: string;   // ISO-8601 UTC
}

export function jobPath(topic: string): string { return join(jobDir(topic), "job.json"); }
/** Byte offset into the hub's outbox that the origin hub has already consumed. `job wait` resumes
 *  from it; `job relay` bumps it past the question it just answered, so the next wait does not
 *  re-report a question that has been dealt with. */
export function jobCursorPath(topic: string): string { return join(jobDir(topic), "cursor.txt"); }

export function formatJob(j: JobRecord): string { return JSON.stringify(j) + "\n"; }

/** Parse a job.json. Returns null rather than throwing for every unusable shape — a torn or hand-
 *  edited record must read as "no job here", never as a half-populated one a verb would act on. */
export function parseJob(text: string): JobRecord | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const hub = o.hub as { agent?: unknown; model?: unknown } | undefined;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
  if (typeof o.command !== "string" || !isJobCommand(o.command)) return null;
  if (!str(o.topic) || !str(o.session) || !str(o.started)) return null;
  if (!hub || !str(hub.agent) || !str(hub.model)) return null;
  return {
    command: o.command,
    topic: str(o.topic),
    session: str(o.session),
    hub: { agent: str(hub.agent), model: str(hub.model) },
    provider: str(o.provider),
    finish: str(o.finish) || "keep",
    budget_hours: num(o.budget_hours, 0),
    max_rounds: num(o.max_rounds, 0),
    args_file: str(o.args_file),
    started: str(o.started),
  };
}

// ---------- liveness ----------

export type JobLiveness = "alive" | "dead" | "unknown";

/** Three-valued on purpose. `ownsPane` collapses two very different situations into false: a nonce
 *  that is not platform-minted (no tmux answer could ever settle it) and a verifiable nonce whose
 *  pane is gone or now belongs to someone else. Only the second is evidence of death; reporting the
 *  first as `dead` is what the 0.5.30 fix forbade, and here it would tell an operator their job had
 *  died when it is running fine. */
export function classifyJobLiveness(live: Map<string, string>, owner: PaneOwner | null): JobLiveness {
  if (!owner || !owner.paneId) return "unknown";
  if (ownsPane(live, owner.paneId, owner.nonce)) return "alive";
  return verifiableNonce(owner.nonce) ? "dead" : "unknown";
}

// ---------- budget ----------

/** Elapsed hours since `startedIso`, or null when that timestamp is unparseable. */
export function elapsedHours(startedIso: string, nowMs: number): number | null {
  const t = Date.parse(startedIso);
  return Number.isFinite(t) ? (nowMs - t) / 3_600_000 : null;
}

/** Fail-closed toward PARKING, never toward running forever: an unparseable start time or a budget
 *  that is not a positive number reads as exhausted, so the job stops and asks rather than burning
 *  an unbounded number of hours on a record nobody can interpret. Exactly-at-N-hours is still
 *  within budget; the comparison is strict. */
export function budgetExceeded(startedIso: string, hours: number, nowMs: number): boolean {
  const t = Date.parse(startedIso);
  if (!Number.isFinite(t)) return true;
  if (!Number.isFinite(hours) || hours <= 0) return true;
  return nowMs - t > hours * 3_600_000;
}

// ---------- teardown ----------

/** May the whole session be killed? Only when it holds at least one pane AND every pane in it is
 *  one ap has proven is its own. An empty list is "nothing to kill" (false), not "safe to kill":
 *  sessionPaneIds returns empty for a vanished session and for any tmux error alike, and those must
 *  not authorize a kill. In practice this is a safety net rather than the normal path — teardown
 *  kills each worker pane individually, and tmux destroys a session when its last window closes. */
export function sessionKillable(sessionPanes: string[], owned: Set<string>): boolean {
  return sessionPanes.length > 0 && sessionPanes.every((p) => owned.has(p));
}

// ---------- progress ----------

export interface JobProgress { last: OutboxEvent | null; parked: OutboxEvent | null; }

/** A question is PARKED only while it is the newest event. Anything the hub emitted afterwards —
 *  an ack of the relayed answer, more progress, a terminal event — means the question was answered
 *  and the run moved on, so reporting it as still-parked would send the operator to answer it twice. */
export function jobProgress(events: OutboxEvent[]): JobProgress {
  const last = events.length ? events[events.length - 1] : null;
  return { last, parked: last && last.event === "question" ? last : null };
}

// ---------- launch-time gates ----------

/** The only finish action a detached run accepts. Merging, pushing, or opening a PR while nobody is
 *  watching is the one thing detachment must not buy: the run ends on its branch and the operator
 *  takes it from there. */
export function finishAllowedDetached(action: string): boolean { return action === "keep"; }

/** Drop flag tokens (and the value of each flag named in `valueFlags`) so what remains is the free
 *  text a slug can be derived from. */
export function stripFlags(text: string, valueFlags: Set<string>): string {
  const toks = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith("--")) { if (valueFlags.has(t)) i++; continue; }
    out.push(t);
  }
  return out.join(" ");
}

/** The topic an `implement` args file resolves to — the same answer `implement init` will reach, so
 *  the job record and the run it launches cannot disagree about which topic they are. An explicit
 *  `--topic` wins, exactly as it does in init; otherwise it derives from the design-doc positional. */
export function topicFromImplementArgs(text: string): string {
  const toks = text.split(/\s+/).filter(Boolean);
  const i = toks.indexOf("--topic");
  if (i >= 0 && toks[i + 1]) return toks[i + 1];
  const eq = toks.find((t) => t.startsWith("--topic="));
  if (eq) return eq.slice("--topic=".length);
  const doc = toks.find((t) => !t.startsWith("-") && t.endsWith(".md"));
  return doc ? deriveTopicFromPath(doc) : "";
}

// ---------- the job hub's brief ----------

/** The inbox task the job hub receives. It names the directive to run, the mechanical detached-mode
 *  signal, and the parameters that are NOT the hub's to change. Pure, so its wording is testable. */
export function jobBrief(j: JobRecord): string {
  return [
    `You are the job hub for a DETACHED /ap:${j.command} run on topic \`${j.topic}\`.`,
    ``,
    `Invoke the \`ap:${j.command}\` skill — the Skill tool, skill name "ap:${j.command}" — passing the`,
    `arguments recorded for this run. Read them from:`,
    ``,
    `    ${j.args_file}`,
    ``,
    `Pass that file's contents verbatim as the command's arguments.`,
    ``,
    `DETACHED MODE is in force. That directive has a "## DETACHED MODE" section: read it BEFORE`,
    `Stage 0 and follow it wherever it redefines a gate. The mechanical check is:`,
    ``,
    `    ap job mode ${j.topic}          -> prints DETACHED=1 and exits 0`,
    ``,
    `Run parameters. These are settled and are NOT yours to change:`,
    `    provider    ${j.provider || "(directive default)"}`,
    `    finish      ${j.finish} — never merge, never push, never open a PR`,
    `    max rounds  ${j.max_rounds}`,
    `    budget      ${j.budget_hours}h — check at EVERY round boundary with:`,
    `                    ap job budget-check ${j.topic}`,
    `                exit 1 means exhausted: write RESUME.md, park a question, stop.`,
    ``,
    `No operator is watching this run. Never call AskUserQuestion. Wherever the directive says to ask`,
    `the user, PARK instead — append a question event to your outbox, set your status to idle, and`,
    `wait for your inbox. Your identity file gives the exact shape. Parking costs nothing; guessing a`,
    `gate's answer, or discarding finished work because a gate went unanswered, are both failures.`,
  ].join("\n");
}
