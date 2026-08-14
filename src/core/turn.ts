// src/core/turn.ts
import { outboxEventsSince, outboxOffset, outboxPath, TERMINAL_EVENTS, type OutboxEvent } from "./ipc.js";
import { realSleep } from "./artifact.js";

export const BRANCH_DISCIPLINE =
  "BRANCH DISCIPLINE (hard rule):\n" +
  "- You are already on the correct branch. Do NOT run `git checkout`, `git switch`,\n" +
  "  or `git branch`, and do NOT create new branches.\n" +
  "- If the work genuinely needs a different branch, do NOT switch; instead emit\n" +
  '  {"event":"error","reason":"branch-discipline: needed a different branch"} and stop.\n';

export const BLOCKERS =
  "IF YOU ARE BLOCKED:\n" +
  "- If a path, file, command, or assumption is wrong or missing, do NOT guess or invent a\n" +
  "  workaround. Append a question event to your outbox and stop:\n" +
  '  {"event":"question","message":"<what you need and why>","ts":"<iso>"}\n' +
  "  The conductor will reply via your inbox, then re-engage you.\n";

/** Round-1 prompt body (the IMPLEMENT instructions + the inlined brief). NOTE: must NOT include
 *  END_OF_INSTRUCTION or the done-event line — inboxWrite() appends the canonical done instruction
 *  and the END_OF_INSTRUCTION fence when this becomes the inbox task. */
export function composeRound1Prompt(briefText: string, branch: string): string {
  return [
    `You are implementing a single, self-contained change on the branch \`${branch}\` of this repository.`,
    "",
    "This is one autonomous turn: read the task, implement it, commit your work, then report.",
    "",
    "THE TASK:",
    "",
    briefText.trim(),
    "",
    "INSTRUCTIONS:",
    `- Implement the change directly in this repository's working tree (you are on \`${branch}\`).`,
    "- Commit per logical change with Conventional Commits messages.",
    "- If the repository has a test suite, run it and make your change pass it.",
    "- When the implementation is complete and committed, emit the done event (see below).",
    "",
    BRANCH_DISCIPLINE,
    BLOCKERS,
  ].join("\n");
}

export type TurnStatus = "ok" | "failed" | "question" | "timeout";

/** done → ok; question → question; null (no event before timeout) → timeout; everything else (error, unknown) → failed. */
export function classifyTurn(ev: OutboxEvent | null): TurnStatus {
  if (!ev) return "timeout";
  if (ev.event === "done") return "ok";
  if (ev.event === "question") return "question";
  return "failed";
}

/** Seconds of outbox QUIET that confirm a terminal event ended the turn. `AP_TURN_CONFIRM_S`
 *  overrides (clamped 5..120); 0 (or any value <= 0) DISABLES the confirmation layer entirely, so
 *  unlike env.ts's `envNum` this honours an explicit 0 — same reasoning (and same shape) as
 *  artifact.ts's `artifactGraceS`. A non-numeric value falls back to the default. */
const TURN_CONFIRM_DEFAULT_S = 20;
export function turnConfirmS(): number {
  const raw = process.env.AP_TURN_CONFIRM_S;
  const n = raw === undefined || raw.trim() === "" ? TURN_CONFIRM_DEFAULT_S : Number(raw);
  if (!Number.isFinite(n)) return TURN_CONFIRM_DEFAULT_S;
  if (n <= 0) return 0;
  return Math.min(120, Math.max(5, n));
}

/** Windows a turn may have VETOED before the layer stops second-guessing the worker and accepts
 *  what it holds: a pane still writing after that many confirmations is chatty or stuck, and either
 *  way the hub is better served by a verdict than by a wait that never ends. */
const MAX_VETOES = 2;

/** Confirmation windows the re-arm phase is guaranteed past the FIRST leg's end, even when that leg
 *  blew the base budget (liveness extension runs it up to 3x). Without this floor the deadline
 *  computed from wait-START is already spent when the confirmation begins, so the layer would flag a
 *  veto and then immediately give up on it — a misleading flag and no confirmation at all. */
const REARM_FLOOR_WINDOWS = 3;

export interface TurnConfirmDeps {
  wait(i: string, m: string, t: string, off: number, ev: string[], to: number): Promise<OutboxEvent | null>;
  /** Injected for tests; the live verbs leave it unset and get real sleeps. */
  sleep?(ms: number): Promise<void>;
  /** Injected for tests (a virtual clock); the live verbs leave it unset and get Date.now. */
  nowMs?(): number;
  /** Called with each confirmation-layer forensics note (veto / cap / deadline); the verbs bind it
   *  to recordHubFlag. */
  onVeto?(note: string): void;
}

/** The LAST terminal event in file order, or null when the region holds none. */
function latestTerminal(events: OutboxEvent[]): OutboxEvent | null {
  for (let k = events.length - 1; k >= 0; k--) if (TERMINAL_EVENTS.includes(events[k].event)) return events[k];
  return null;
}

/** The round-based turn/round waits' terminal event, CONFIRMED against continued outbox activity.
 *
 *  A worker (codex's internal-agents mode, observed) can emit `done`/`error` mid-turn and keep
 *  working; the bare wait classified those live turns as ended. So: take the first terminal event
 *  exactly as today (the injected wait, pane-liveness extension included), re-derive the armed event
 *  as the LATEST terminal in FILE order, then hold the verdict for one quiet window
 *  (`AP_TURN_CONFIRM_S`). An outbox that GREW during the window vetoes the classification and the
 *  wrapper re-arms — as a SHORT `d.wait` from the window's start offset, so pane-liveness still fails
 *  fast and the armed event cannot re-match itself. A re-arm that finds nothing while the outbox also
 *  stopped growing means the burst was trailing noise: accept what is armed rather than sit out the
 *  turn budget.
 *
 *  Bounds (the layer must never become the thing that hangs a run): at most MAX_VETOES vetoed
 *  windows, so at most MAX_VETOES+1 window sleeps of `AP_TURN_CONFIRM_S`; the re-arm's short waits
 *  run until `max(wait-start + timeoutS, first-leg-end + REARM_FLOOR_WINDOWS windows)`. Hitting the
 *  cap or the deadline accepts the armed event and records its own distinct flag, so /ap:review sees
 *  WHY a turn was accepted unconfirmed.
 *
 *  A `question` is never confirmed: the worker has STOPPED to ask, so it cannot emit another terminal
 *  on its own, and waiting out its outbox would deadlock the hub (which relays the answer) against
 *  the worker (which waits for it). It short-circuits — on the first armed event and after every
 *  re-arm.
 *
 *  The verdict is the LATEST terminal event in FILE order — the one deliberate divergence from
 *  `lastMatch`'s frozen argument-order precedence (where a `done` anywhere beats a LATER `error`),
 *  confined to this wrapper: every other consumer of that matcher, and every other wait, is
 *  untouched. `AP_TURN_CONFIRM_S=0` returns the first event with zero extra reads or sleeps, i.e.
 *  byte-identical 0.5.14 behavior. The chosen event feeds each verb's existing classification,
 *  question-payload and state-write pipeline unchanged. */
export async function waitTurnConfirmed(
  i: string, m: string, t: string, offset: number, timeoutS: number, d: TurnConfirmDeps,
): Promise<OutboxEvent | null> {
  const now = d.nowMs ?? (() => Date.now());
  const startMs = now();
  const first = await d.wait(i, m, t, offset, TERMINAL_EVENTS, timeoutS);
  const confirmS = turnConfirmS();
  if (!first || confirmS === 0) return first;
  const legEndMs = now();
  const path = outboxPath(i, m, t);
  const sleep = d.sleep ?? realSleep;
  const windowMs = confirmS * 1000;
  const deadlineMs = Math.max(startMs + timeoutS * 1000, legEndMs + REARM_FLOOR_WINDOWS * windowMs);
  let armed = latestTerminal(outboxEventsSince(i, m, t, offset)) ?? first;
  let vetoes = 0;
  for (;;) {
    if (armed.event === "question") return armed;   // a stopped worker cannot confirm anything
    const s0 = outboxOffset(path);
    await sleep(windowMs);
    if (outboxOffset(path) <= s0) return armed;     // no GROWTH (a shrink is not activity)
    if (vetoes >= MAX_VETOES) {
      d.onVeto?.(`turn-confirm-cap: ${m} still writing after ${vetoes + 1} windows — accepting ${armed.event}`);
      return armed;
    }
    d.onVeto?.(`turn-confirm-veto: ${m} premature ${armed.event} — outbox still active`);
    vetoes++;
    let next: OutboxEvent | null = null;
    while (!next) {
      const before = outboxOffset(path);
      next = await d.wait(i, m, t, s0, TERMINAL_EVENTS, confirmS);
      if (next) break;
      if (outboxOffset(path) <= before) return armed;   // quiescent: the burst was trailing noise
      if (now() >= deadlineMs) {
        d.onVeto?.(`turn-confirm-deadline: ${m} re-arm expired — accepting ${armed.event}`);
        return armed;
      }
    }
    // A synthetic event (liveOutboxWait's pane-died error) is not in the file: fall back to it.
    armed = latestTerminal(outboxEventsSince(i, m, t, s0)) ?? next;
  }
}

/** Fix-round prompt body (round >= 2). Same fence note as composeRound1Prompt. */
export function composeFixPrompt(issuesText: string, round: number): string {
  return [
    `You are entering ROUND ${round} of /ap:quick (fix loop), still on the same branch.`,
    "",
    "This is one autonomous turn: fix each issue below, commit per fix, re-run the tests, then report.",
    "",
    "ISSUES TO ADDRESS:",
    "",
    issuesText.trim(),
    "",
    "INSTRUCTIONS:",
    "- Fix each issue above. Commit per fix with Conventional Commits messages.",
    "- Re-run the repository's test suite and confirm it passes.",
    "- When all issues are addressed and committed, emit the done event (see below).",
    "",
    BRANCH_DISCIPLINE,
    BLOCKERS,
  ].join("\n");
}
