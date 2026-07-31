// src/core/artifact.ts — artifact completeness for the worker-phase artifacts (2026-07-31 spec).
//
// A worker may emit `done` BEFORE its artifact file is fully written; the wait then passed, the hub
// read a half-written findings file, and the next phase-send landed in a still-busy worker's inbox.
// The fix is a one-line contract the composers state (write to `<name>.tmp`, `mv` it into place,
// LAST line is the sentinel, only THEN emit the terminal event) plus two enforcement depths:
// phaseWait's grace loop (primary, via awaitArtifact) and the commands' validators (backstop, via
// artifactBackstop). The sentinel is NOT part of the frozen wire protocol — no event, field or
// filename changed; it is a new literal only.
//
// This is a LEAF module by design: every phase composer appends artifactContract(...), and the
// composers live in modules core/phaseTable.ts already imports (designTurn). Homing the contract
// here instead of in phaseTable.ts keeps that import graph acyclic — with the cycle, PHASES was
// built while designTurn was still initializing and every row's stateFn came out undefined.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import { atomicWrite } from "./atomic.js";
import { readIfExists as readIf, readIfExistsOrNull } from "./fsread.js";
import { recordHubFlag } from "./forensics.js";

/** The literal last line every worker-authored phase artifact must carry. */
export const END_OF_ARTIFACT = "END_OF_ARTIFACT";

/** Grace-loop poll cadence in seconds (the spec's "poll every 2 s"). */
const ARTIFACT_POLL_S = 2;

/** Consecutive equal-size polls (~4s at the cadence above) that count as quiescence: a non-empty
 *  artifact that stopped changing after its `done` event is finished work from a worker that simply
 *  never wrote the sentinel. Accepting it is the amendment that stops soft L1 compliance from
 *  destroying real findings. */
const QUIESCENT_POLLS = 2;

/** Refusals with no growth after which the backstop degrades to the drop path. */
const NO_GROWTH_STRIKES = 3;

/** Absolute refusal cap: even a file that grows a byte between every refusal degrades here, so a
 *  drip-feeding (or truncate-and-rewrite) worker can never hold the run open forever. */
const MAX_REFUSALS = 6;

/** Seconds a phase wait gives a missing sentinel to appear before classifying the phase as timeout.
 *  `AP_ARTIFACT_GRACE_S` overrides (clamped 0..300); 0 DISABLES the check, so unlike env.ts's
 *  `envNum` this honours an explicit 0 — a non-numeric value still falls back to the default. */
export function artifactGraceS(): number {
  const raw = process.env.AP_ARTIFACT_GRACE_S;
  const n = raw === undefined || raw.trim() === "" ? 60 : Number(raw);
  return Number.isFinite(n) ? Math.min(300, Math.max(0, n)) : 60;
}

/** Does an artifact's text end with the completeness sentinel? Trailing whitespace/newlines are
 *  tolerated (a worker's shell or editor may add either); null (absent file) is never complete. */
export function hasArtifactSentinel(text: string | null): boolean {
  return text !== null && text.trimEnd().endsWith(END_OF_ARTIFACT);
}

/** hasArtifactSentinel by path — an absent artifact reads as incomplete, not as complete. */
export function artifactComplete(path: string): boolean {
  return hasArtifactSentinel(readIfExistsOrNull(path));
}

/** The shared contract block every phase composer appends, naming ITS artifact's final path.
 *  `alsoPaths` names any SECONDARY file of the same turn (the research phase's self-assessment) that
 *  must follow the same sequence. Carries no done-event line and no END_OF_INSTRUCTION — `send` ->
 *  `inboxWrite` still owns both. */
export function artifactContract(finalPath: string, alsoPaths: string[] = []): string {
  return [
    "Artifact completeness contract — the Hub reads this file only once it is COMPLETE:",
    `  1. Write your output to ${finalPath}.tmp (same directory), never straight to the final path.`,
    `  2. Make the LAST line of that file the literal sentinel: ${END_OF_ARTIFACT}`,
    `  3. Rename it into place: mv ${finalPath}.tmp ${finalPath}`,
    ...alsoPaths.map((p) => `  3b. Same three steps for ${p}: write ${p}.tmp with ${END_OF_ARTIFACT} as its last line, then mv ${p}.tmp ${p}`),
    "  4. ONLY THEN append your terminal event to your outbox.",
    `A file whose last line is not ${END_OF_ARTIFACT} is treated as still being written: the Hub`,
    "waits out a short grace period and then records the phase as timed out.",
  ].join("\n");
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** How a phase wait's grace loop ended: the sentinel landed, the file went quiescent without one
 *  (accepted, but flagged), or grace expired on a file that is empty or still changing. */
export type ArtifactWait = "sentinel" | "quiescent" | "expired";

/** One read per poll: does the artifact carry the sentinel, and how big is it (0 when absent)? */
function probe(path: string): { complete: boolean; size: number } {
  const text = readIfExistsOrNull(path);
  return { complete: hasArtifactSentinel(text), size: text === null ? 0 : Buffer.byteLength(text) };
}

/** Poll `path` every ARTIFACT_POLL_S up to `graceS` seconds. Two acceptances, checked in this order:
 *  the sentinel appears (fast path — the common done-then-write race, absorbed silently), or the file
 *  is non-empty and its size is unchanged across QUIESCENT_POLLS consecutive polls (~4s) — a worker
 *  that finished writing but skipped the sentinel line. Only an empty artifact, or one still changing
 *  when the grace cap arrives, expires. */
export async function awaitArtifact(path: string, graceS: number, sleep: (ms: number) => Promise<void>): Promise<ArtifactWait> {
  const first = probe(path);
  if (first.complete) return "sentinel";
  let last = first.size;
  let stable = 0;
  for (let waited = 0; waited < graceS; waited += ARTIFACT_POLL_S) {
    await sleep(ARTIFACT_POLL_S * 1000);
    const now = probe(path);
    if (now.complete) return "sentinel";
    stable = now.size > 0 && now.size === last ? stable + 1 : 0;
    last = now.size;
    if (stable >= QUIESCENT_POLLS) return "quiescent";
  }
  return "expired";
}

/** The validators' verdict on one worker's artifact: `complete` (accept it), `still-writing`
 *  (refuse the whole verb, rc 1 — the hub re-runs the wait-gate and retries) or `drop` (treat it as
 *  EMPTY: the worker will never finish, so the pre-existing drop path takes it). */
export type ArtifactVerdict = "complete" | "still-writing" | "drop";

/** Append-only refusal log, one `<agent> <size>` line per refusal. Returns BOTH bounds: `strikes`,
 *  the run of refusals since the file last GREW past its high-water mark, and `total`, every refusal
 *  ever recorded for this agent, which the absolute cap reads. Growth is measured against the MAX
 *  size seen, not the previous one: a worker that truncates and rewrites in place oscillates, and
 *  "bigger than last time" would reset its counter forever. */
function recordStillWriting(art: string, agent: string, size: number): { strikes: number; total: number } {
  const path = join(art, `stillwriting-${agent}.txt`);
  const prev = readIf(path).split("\n").filter((l) => l.length > 0).map((l) => Number(l.split(/\s+/)[1]));
  const sizes = [...prev, size];
  atomicWrite(path, sizes.map((s) => `${agent} ${s}`).join("\n") + "\n");
  let strikes = 1;
  let high = sizes[0];
  for (let i = 1; i < sizes.length; i++) {
    strikes = sizes[i] > high ? 1 : strikes + 1;
    high = Math.max(high, sizes[i]);
  }
  return { strikes, total: sizes.length };
}

/** Drop the refusal log once the artifact is accepted — the next incomplete read starts from zero
 *  instead of inheriting strikes from an already-resolved episode. */
function clearStillWriting(art: string, agent: string): void {
  rmSync(join(art, `stillwriting-${agent}.txt`), { force: true });
}

/** The backstop the validators run over each artifact they are about to accept. Verdicts, in order:
 *
 *  - sentinel present → `complete` (the contract was honoured).
 *  - phase tag `ok` → `complete` REGARDLESS of the sentinel. The wait already accepted this artifact
 *    (sentinel or quiescence) and wrote `ok`; re-judging it here would destroy accepted work over a
 *    line the worker merely forgot. Amended 2026-07-31 after the adversarial review.
 *  - phase tag `timeout`/`failed` → `drop`: that worker will never finish, so the pre-existing
 *    drop path (treat as EMPTY, N-1 continuation) takes it. No retry loop.
 *  - anything else — tag unset (the gate-skipping hub, the case this backstop exists for),
 *    `question`, or a still-pending classification → `still-writing`: refuse the whole verb (rc 1)
 *    so the hub re-runs the wait-gate and retries. Bounded twice: NO_GROWTH_STRIKES refusals with
 *    no growth, or MAX_REFUSALS refusals in total, degrade to the drop path with a forensics flag. */
export function artifactBackstop(opts: {
  label: string; command: "explore" | "design"; topic: string;
  art: string; agent: string; artifact: string; tag: string | null;
}): ArtifactVerdict {
  const text = readIf(opts.artifact);
  if (hasArtifactSentinel(text) || opts.tag === "ok") { clearStillWriting(opts.art, opts.agent); return "complete"; }
  if (opts.tag === "timeout" || opts.tag === "failed") return "drop";
  const { strikes, total } = recordStillWriting(opts.art, opts.agent, Buffer.byteLength(text));
  if (strikes >= NO_GROWTH_STRIKES || total >= MAX_REFUSALS) {
    const reason = strikes >= NO_GROWTH_STRIKES
      ? `${strikes} refusals with no growth`
      : `${total} refusals (cap ${MAX_REFUSALS})`;
    log.warn(`${opts.label}: ${opts.agent} still has no ${END_OF_ARTIFACT} after ${reason} — dropping as empty`);
    recordHubFlag({
      command: opts.command, topic: opts.topic,
      note: `artifact-incomplete: ${opts.agent} ${opts.artifact} dropped as empty after ${reason}`,
    });
    return "drop";
  }
  process.stderr.write(`STILL_WRITING=${opts.agent}\n`);
  log.error(`${opts.label}: ${opts.agent} ${opts.artifact} has no ${END_OF_ARTIFACT} (still writing; strike ${strikes}/${NO_GROWTH_STRIKES}, refusal ${total}/${MAX_REFUSALS}) — re-run the wait-gate, then retry`);
  return "still-writing";
}
