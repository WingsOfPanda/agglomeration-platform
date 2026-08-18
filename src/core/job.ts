// src/core/job.ts — the detached-job record, and the pure predicates every `ap job` verb reads it
// with. The verb (src/commands/job.ts) owns the I/O and the tmux calls; everything decidable from
// values alone lives here so it can be tested without a pane, a server, or a clock.
//
// The governing rule for this module is the one the platform learned the hard way: a layer records
// its OWN verdict and consumes other layers' recorded verdicts — it never infers one. So the job
// record says what was LAUNCHED and nothing else; liveness comes from the pane nonce, progress from
// the outbox, and the hub's own state from its status.json. Four independent reads, no inference.

import { join, sep } from "node:path";
import { jobDir } from "./paths.js";
import { ownsPane, verifiableNonce } from "./tmux.js";
import { deriveTopicFromPath } from "./implement.js";
import { parseEvent } from "./ipc.js";
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
  /** Absolute path of the isolated worktree the WORKER runs in; "" when `--no-worktree` was given
   *  (and absent entirely in records written before 0.5.36). Both dogfoods checked the run's branch
   *  out in the MAIN checkout, which froze the origin session out of its own repo for the run's
   *  duration — branch checkout and the index are global to a checkout, so "your session is free"
   *  was only ever true of the session, never of the repo. */
  worktree?: string;
  /** The committed HEAD the worktree forked from. `job stop` measures the run branch's commits and
   *  the starting branch's drift against it, which is why it is recorded rather than re-derived. */
  base_sha?: string;
  /** The origin checkout's branch when the run forked; "" for detached or unreadable HEAD. */
  start_branch?: string;
}

export function jobPath(topic: string): string { return join(jobDir(topic), "job.json"); }
/** Where a detached run's worktree lives. Under the REPO root, not the state dir: `cp -al` of
 *  node_modules only works on the same filesystem, and `.ap/` is already git-ignored so the
 *  worktree never shows up as untracked content in the checkout it forked from. `root` is passed in
 *  rather than resolved here — the state dir follows AP_HOME, this must not. */
export function worktreePathFor(root: string, topic: string): string {
  return join(root, ".ap", "worktrees", topic);
}
/** Is `path` a worktree THIS platform could have created under `root`? The same rule pane ownership
 *  follows: teardown removes only what ap can prove is its own, so a hand-edited (or carried-over)
 *  record naming some other checkout is never a path `job stop` will delete. */
export function worktreeProvenanced(path: string, root: string): boolean {
  return path.startsWith(join(root, ".ap", "worktrees") + sep) && path.length > join(root, ".ap", "worktrees").length + sep.length;
}
/** Byte offset into the hub's outbox that the origin hub has already consumed. `job wait` resumes
 *  from it; `job relay` bumps it past the question it just answered, so the next wait does not
 *  re-report a question that has been dealt with. */
export function jobCursorPath(topic: string): string { return join(jobDir(topic), "cursor.txt"); }
/** Pane id -> the ownership nonce that proved it ours, persisted by `job stop` BEFORE teardown
 *  archives the pane.json files that evidence is read from. A teardown that could not finish keeps
 *  this next to the record so the re-run still has proof to act on. */
export function panesEvidencePath(topic: string): string { return join(jobDir(topic), "panes.json"); }

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
    // Soft in BOTH directions: older records lack these keys and must stay readable across an
    // upgrade. `--no-worktree` records the first two empty; detached/unreadable HEAD records the
    // start branch empty. Every consumer tests truthiness, so absent and "" behave alike.
    worktree: str(o.worktree),
    base_sha: str(o.base_sha),
    start_branch: str(o.start_branch),
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

/** May the whole session be killed? Only when it holds at least one pane AND every pane in it still
 *  carries, LIVE, the nonce ap recorded for it. A pane id alone is never proof of ownership (0.5.30):
 *  `recorded` is the evidence persisted before teardown archived the pane.json files it came from,
 *  and `live` is a snapshot taken at kill time, so a `%N` the tmux server recycled carries no
 *  @ap_nonce and fails the check. An empty list is "nothing to kill" (false), not "safe to kill":
 *  sessionPaneIds returns empty for a vanished session and for any tmux error alike, and those must
 *  not authorize a kill. In practice this is a safety net rather than the normal path — teardown
 *  kills each worker pane individually, and tmux destroys a session when its last window closes. */
export function sessionKillable(sessionPanes: string[], recorded: Map<string, string>, live: Map<string, string>): boolean {
  return sessionPanes.length > 0 && sessionPanes.every((p) => ownsPane(live, p, recorded.get(p) ?? ""));
}

/** Fold a fresh ownership snapshot into the evidence a previous `job stop` persisted: `current`
 *  wins per pane id, entries only `prior` knows about survive. A teardown that could not finish
 *  (an unaccounted pane, a kill that did not take) leaves the record in place, and by the time the
 *  operator re-runs `job stop` the workers are archived — their pane.json files gone — so the
 *  persisted evidence is the only thing that can still prove which panes were ours. */
export function mergePaneEvidence(prior: Record<string, string>, current: Map<string, string>): Record<string, string> {
  return { ...prior, ...Object.fromEntries(current) };
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

/** Every typed event in an outbox SNAPSHOT (non-JSON lines skipped, the frozen matching mechanism).
 *  Text rather than a path, so one read serves both the verdict and the byte count taken from it. */
export function parseOutbox(text: string): OutboxEvent[] {
  return text.split("\n").map(parseEvent).filter((e): e is OutboxEvent => e !== null);
}

/** What a relay decides, from ONE read of the hub's outbox: what is parked right now, and the byte
 *  offset that verdict was computed at.
 *
 *  `cursor` is the size of the SNAPSHOT, never a re-stat after the send. The snapshot ends at the
 *  question, so anything the hub appends afterwards — including a terminal event racing the beat
 *  inside a send — stays BEYOND the cursor and the next `job wait` still reports it; a cursor taken
 *  after the send swallowed a `done` that landed mid-send and the wait timed out on a finished job.
 *  The same single read makes a stale or duplicate relay fail its `parked` check: by then the hub's
 *  ack (or its terminal event) is the newest event, so `parked` is null. */
export function relaySnapshot(text: string): { last: OutboxEvent | null; parked: OutboxEvent | null; cursor: number } {
  const { last, parked } = jobProgress(parseOutbox(text));
  return { last, parked, cursor: Buffer.byteLength(text, "utf8") };
}

/** Was the newest question already answered? `cursor` is what a relay recorded (the size of the
 *  snapshot it answered), `size` the outbox's size now. At or past it means the question sits inside
 *  what a relay already consumed, so `job status` must stop reporting PARKED=yes: commands/job.md
 *  tells the origin hub to relay whenever it sees PARKED=yes, and a question that stays parked after
 *  its answer is a directive-level duplicate-relay loop. */
export function questionConsumed(size: number, cursor: number): boolean { return cursor >= size; }

// ---------- launch-time gates ----------

/** The finish actions a detached run accepts. `keep` stays the default — the run ends on its branch
 *  and the operator takes it from there. `pr` is the sanctioned opt-in: a PR is REVIEWABLE, so the
 *  code still reaches a human before it reaches the base branch. `merge` and `discard` stay out for
 *  the reason the multi-hour runs exposed — the hub cross-verifies against the FORK BASE while the
 *  starting branch keeps moving, so a local merge integrates code nobody verified against the
 *  current starting branch, and a discard destroys unattended work. */
export function finishAllowedDetached(action: string): boolean { return action === "keep" || action === "pr"; }

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

/** How the recorded finish action reads in the brief. The two legal actions describe genuinely
 *  different endings, and a brief that promised "never push" under a `pr` run would have the hub
 *  fighting its own finish verb. */
function finishLine(finish: string): string {
  return finish === "pr"
    ? `    finish      pr — at the end, push the branch and open a PR. NEVER merge it yourself.`
    : `    finish      ${finish} — never merge, never push, never open a PR`;
}

/** The worktree paragraph, empty for a `--no-worktree` run (and for a record written before 0.5.36).
 *  The path is the ONE thing the hub cannot derive: the state dir is keyed to the repo root, and
 *  only the WORKER's target moves. */
function worktreeLines(j: JobRecord): string[] {
  if (!j.worktree) return [];
  const target = j.command === "quick"
    ? [`    ap quick init --target ${j.worktree} ...`,
       `    ap quick branch --target ${j.worktree} <SLUG>    <- BOTH verbs, not just init`]
    : [`    ap implement init --target ${j.worktree} ...`,
       `    (every later verb reads target_cwd.txt, so init is the only place it is passed)`];
  return [
    ``,
    `WORKTREE. This run works in an ISOLATED git worktree, not the main checkout:`,
    ``,
    `    ${j.worktree}`,
    ``,
    `Pass it as \`--target\` wherever the directive inits the run:`,
    ``,
    ...target,
    ``,
    `The main checkout belongs to the operator for the whole run — the worker must never check out`,
    `a branch there. Your own state (\`.ap/state/...\`, this record, your inbox/outbox) stays keyed`,
    `to the repo ROOT and is unaffected; only the worker's target moves.`,
  ];
}

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
    ...worktreeLines(j),
    ``,
    `Run parameters. These are settled and are NOT yours to change:`,
    `    provider    ${j.provider || "(directive default)"}`,
    finishLine(j.finish),
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
