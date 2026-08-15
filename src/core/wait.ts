// src/core/wait.ts — the wait module: the state-file micro-protocol every wait verb reads and
// writes, plus the timer the wait loops sleep on.
//
// These pieces lived in designTurn.ts, whose name says "design" while implement, quick, bridge and
// phaseTable were four non-design families depending on it, and in artifact.ts, which turn.ts
// imported purely to borrow a timer. Neither module owned them; this one does.
//
// TOLERANCE CONSTANTS — the shared vocabulary. Five numbers bound how long the platform second-
// guesses a worker before it accepts what it holds. They stay in the module that owns the loop
// reading them; this table is the one place they are named together:
//
//   MAX_VETOES          2  vetoed confirmation windows before a turn wait accepts its armed
//                          terminal event anyway (a pane still writing is chatty or stuck)   turn.ts
//   REARM_FLOOR_WINDOWS 3  confirmation windows the re-arm is guaranteed past the FIRST leg's
//                          end, so a liveness-extended leg still gets a real confirmation     turn.ts
//   QUIESCENT_POLLS     5  consecutive equal-size artifact polls (~10s) that count as
//                          "finished writing" without the sentinel                       artifact.ts
//   NO_GROWTH_STRIKES   3  backstop refusals with no growth before it degrades to the drop
//                          path                                                          artifact.ts
//   MAX_REFUSALS        6  absolute backstop refusal cap, so a drip-feeding worker cannot hold
//                          a run open forever                                            artifact.ts
import { appendFileSync } from "node:fs";
import { outboxOffset, outboxPath } from "./ipc.js";
import { atomicWrite } from "./atomic.js";

/** The LAST `<KEY>=<n>` integer line in a state file's contents (latest-line-wins). The question
 *  re-arm appends a second keyed line (bumped past the question event), so the re-armed read must
 *  resume from the latest. null if absent/unparseable. */
export function lastKeyedNumber(text: string, key: string): number | null {
  const ms = [...text.matchAll(new RegExp(`^${key}=(\\d+)\\s*$`, "gm"))];
  return ms.length ? Number(ms[ms.length - 1][1]) : null;
}

/** The LAST `OFFSET=<n>` line — the re-armed wait resumes from the latest. */
export function parseLatestOffset(stateText: string): number | null {
  return lastKeyedNumber(stateText, "OFFSET");
}

/** Shared wait-verb tail — the WAIT side's single writer of the `OFFSET=` / `<KEY>=` state-file
 *  micro-protocol (parseLatestOffset / lastKeyedNumber here, designTurn's gateState, are its
 *  readers). The send verbs write the phase's FIRST `OFFSET=` line themselves before dispatching;
 *  that is a different verb and stays theirs. A captured question writes the question payload file,
 *  then re-arms the state file with the outbox offset bumped PAST the handled question event (plus
 *  any caller extra lines, e.g. implement's `OBJECTIONS=` counter) so a same-round re-arm does not
 *  re-read it. Every other outcome appends the terminal `<key>=<state>` line (latest-line-wins).
 *  Callers add their own `.done` marker / logging.
 *
 *  `lead` is one extra `<KEY>=<value>` line written AHEAD of the terminal line in the same append
 *  (phaseWait's `AC=` artifact verdict). Ahead, so the phase key stays the file's LAST line — the
 *  directives' `grep '^FS=' | tail -1` idiom and the "last line shows FS=question" prose both hold. */
export function recordWaitOutcome(
  agent: string, model: string, topic: string, stateFile: string,
  state: string, key: string,
  question?: { file: string; body: string; extraLines?: string },
  lead?: string,
): void {
  const head = lead ? `${lead}\n` : "";
  if (state === "question" && question) {
    atomicWrite(question.file, question.body);
    const bumped = outboxOffset(outboxPath(agent, model, topic));
    appendFileSync(stateFile, `${head}OFFSET=${bumped}\n${key}=question\n${question.extraLines ?? ""}`);
  } else {
    appendFileSync(stateFile, `${head}${key}=${state}\n`);
  }
}

/** Apply a provider's timeout_multiplier to a base timeout, ported from the consult_wait loop's
 *  `printf "%d", b*m + 0.5` (round-half-up to an integer second). Bad/<=0 multiplier -> identity. */
export function scaledTimeout(baseSec: number, multiplier: string): number {
  const m = Number(multiplier);
  return Math.floor(baseSec * (Number.isFinite(m) && m > 0 ? m : 1) + 0.5);
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
