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
// The two depths are joined by ONE marker, not by inference: the wait records its own verdict as an
// `AC=<sentinel|quiescent|expired|unchecked>` line in the same phase state file, and the backstop
// reads it. Nothing else may stand in for it — the first draft inferred acceptance from the phase
// TAG (`FS=ok`), which conflates "the wait accepted the file" with "the file's content classified
// well", and on explore (whose healthy findings classify `empty`) that inference destroyed real
// research. Content classification stays the stateFn's job; acceptance stays the wait's.
//
// This is a LEAF module by design: every phase composer appends artifactContract(...), and the
// composers live in modules core/phaseTable.ts already imports (designTurn). Homing the contract
// here instead of in phaseTable.ts keeps that import graph acyclic — with the cycle, PHASES was
// built while designTurn was still initializing and every row's stateFn came out undefined.
import { rmSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { log } from "./log.js";
import { atomicWrite } from "./atomic.js";
import { readIfExists as readIf, readIfExistsOrNull } from "./fsread.js";
import { lastTag } from "./roster.js";
import { recordHubFlag } from "./forensics.js";

/** The literal last line every worker-authored phase artifact must carry. */
export const END_OF_ARTIFACT = "END_OF_ARTIFACT";

/** State-file key carrying the WAIT's own verdict on the artifact (see `WaitAccept`). Written by
 *  `phaseWait` through `recordWaitOutcome`, read by `artifactBackstop` — the two are one protocol.
 *  Not part of the frozen wire surface: a new key in an existing `<KEY>=<value>` state file. */
export const ARTIFACT_ACCEPT_KEY = "AC";

/** Grace-loop poll cadence in seconds (the spec's "poll every 2 s"). */
const ARTIFACT_POLL_S = 2;

/** Consecutive equal-size polls that count as quiescence: a non-empty artifact that stopped
 *  changing after its `done` event is finished work from a worker that simply never wrote the
 *  sentinel. Accepting it is the amendment that stops soft L1 compliance from destroying real
 *  findings. Raised 2→5 (~10s of stability, not ~4s) on the 2026-07-31 review: a worker that pauses
 *  4s between two writes of one file is ordinary, and a false quiescence hands the hub a partial
 *  artifact — the exact incident this module exists to prevent. */
const QUIESCENT_POLLS = 5;

/** The shortest grace in which quiescence is reachable at all. A grace below it can only ever end
 *  in `expired`, which would drop finished-but-unsentinelled work — so `artifactGraceS` FLOORS a
 *  non-zero override here instead of honouring a value that silently disables one acceptance. */
const MIN_GRACE_S = QUIESCENT_POLLS * ARTIFACT_POLL_S;

/** Refusals with no growth after which the backstop degrades to the drop path. */
const NO_GROWTH_STRIKES = 3;

/** Absolute refusal cap: even a file that grows a byte between every refusal degrades here, so a
 *  drip-feeding (or truncate-and-rewrite) worker can never hold the run open forever. */
const MAX_REFUSALS = 6;

/** Seconds a phase wait gives a missing sentinel to appear before it records `AC=expired`.
 *  `AP_ARTIFACT_GRACE_S` overrides (clamped MIN_GRACE_S..300); 0 (or any value <= 0) DISABLES both
 *  enforcement depths, so unlike env.ts's `envNum` this honours an explicit 0 — a non-numeric value
 *  still falls back to the default. A positive value below MIN_GRACE_S is RAISED to it rather than
 *  honoured: below that floor quiescence cannot be reached and every unsentinelled artifact would
 *  expire, which is the opposite of what a shorter grace asks for. */
export function artifactGraceS(): number {
  const raw = process.env.AP_ARTIFACT_GRACE_S;
  const n = raw === undefined || raw.trim() === "" ? 60 : Number(raw);
  if (!Number.isFinite(n)) return 60;
  if (n <= 0) return 0;
  return Math.min(300, Math.max(MIN_GRACE_S, n));
}

/** Does an artifact carry the completeness sentinel? The LAST non-empty line must EQUAL the
 *  sentinel once trimmed — `endsWith` would let a worker that echoed the contract block ("...the
 *  literal sentinel: END_OF_ARTIFACT") into its output fake completeness — and at least one other
 *  non-empty line must exist, so a sentinel-only file is content-free, not complete. null (absent
 *  file) is never complete. */
export function hasArtifactSentinel(text: string | null): boolean {
  if (text === null) return false;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.length > 1 && lines[lines.length - 1] === END_OF_ARTIFACT;
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
    "waits out a short grace period, and if the file is still empty or still changing at the end of",
    "it, that phase's output is discarded.",
  ].join("\n");
}

/** How a phase wait's grace loop ended: the sentinel landed, the file went quiescent without one
 *  (accepted, but flagged), or grace expired on a file that is empty or still changing. */
export type ArtifactWait = "sentinel" | "quiescent" | "expired";

/** What the WAIT recorded about this artifact, as the state file's `AC=` value. `ArtifactWait`
 *  plus `unchecked` — the `AP_ARTIFACT_GRACE_S=0` escape hatch, where the wait ran but the operator
 *  disabled the check, so the backstop must not second-guess it either (0 disables ENTIRELY).
 *  NO `AC=` line at all means the wait never ran for this phase — the gate-skipping hub. */
export type WaitAccept = ArtifactWait | "unchecked";

/** The `AC=` values that mean THE WAIT ACCEPTED this artifact — one vocabulary, read by every
 *  consumer (the dispatch guard's settled-artifact leg, the handoff's coverage legs, the backstop
 *  below). Exactly ONE consumer diverges, deliberately: `artifactBackstop` additionally counts
 *  `unchecked`, where the operator disabled the grace loop entirely (`AP_ARTIFACT_GRACE_S=0`) and
 *  the backstop must not re-impose a check the operator turned off. The guard and the handoff do
 *  NOT count it — both need positive evidence that a wait judged the file, and `unchecked` is the
 *  absence of one: no evidence is not evidence. */
export const WAIT_ACCEPTED: ReadonlySet<string> = new Set<string>(["sentinel", "quiescent"]);

/** One read per poll: does the artifact carry the sentinel, and how big is it (0 when absent)? */
function probe(path: string): { complete: boolean; size: number } {
  const text = readIfExistsOrNull(path);
  return { complete: hasArtifactSentinel(text), size: text === null ? 0 : Buffer.byteLength(text) };
}

/** Poll `path` every ARTIFACT_POLL_S up to `graceS` seconds. Two acceptances, checked in this order:
 *  the sentinel appears (fast path — the common done-then-write race, absorbed silently), or the file
 *  is non-empty and its size is unchanged across QUIESCENT_POLLS consecutive polls (~10s) — a worker
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
 *  (refuse the whole verb, rc 1 — the hub runs that phase's WAIT verb and retries) or `drop` (treat it as
 *  EMPTY: the worker will never finish, so the pre-existing drop path takes it). */
export type ArtifactVerdict = "complete" | "still-writing" | "drop";

/** Filename prefix of every refusal log belonging to one agent. */
export function strikePrefix(agent: string): string {
  return `stillwriting-${agent}-`;
}

/** The refusal log for ONE agent's ONE artifact. Keyed by the artifact's basename, not by the agent
 *  alone: a worker's findings and its adversary critique are different work with different lifetimes,
 *  and a shared log let strikes accrued on one degrade the other (a run's second artifact could be
 *  dropped on its FIRST refusal). Sanitised because the basename lands in a filename. */
function strikePath(art: string, agent: string, artifact: string): string {
  return join(art, `${strikePrefix(agent)}${basename(artifact).replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
}

/** Append-only refusal log, one `<agent> <size>` line per refusal. Returns BOTH bounds: `strikes`,
 *  the run of refusals since the file last GREW past its high-water mark, and `total`, every refusal
 *  ever recorded for this artifact, which the absolute cap reads. Growth is measured against the MAX
 *  size seen, not the previous one: a worker that truncates and rewrites in place oscillates, and
 *  "bigger than last time" would reset its counter forever. */
function recordStillWriting(art: string, agent: string, artifact: string, size: number): { strikes: number; total: number } {
  const path = strikePath(art, agent, artifact);
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

/** Drop one artifact's refusal log once it is accepted — the next incomplete read starts from zero
 *  instead of inheriting strikes from an already-resolved episode. Also the (re)dispatch reset: a
 *  phase-send that puts the task back in flight invalidates every strike the old episode recorded. */
export function clearArtifactStrikes(art: string, agent: string, artifact: string): void {
  rmSync(strikePath(art, agent, artifact), { force: true });
}

/** Every refusal log of one agent, whatever the artifact — the clean-retry sweep (design's
 *  `offset-reset`), where the agent's whole phase is re-armed rather than one file. */
export function clearAgentStrikes(art: string, agent: string): void {
  let names: string[];
  try { names = readdirSync(art); } catch { return; }
  for (const n of names) if (n.startsWith(strikePrefix(agent))) rmSync(join(art, n), { force: true });
}

/** The backstop the validators run over each artifact they are about to accept. It decides on the
 *  WAIT's recorded verdict (`AC=`), never on the phase tag's content classification — the 2026-07-31
 *  root-cause fix. The first draft accepted on tag `ok`, which is not "the wait accepted it": explore's
 *  own findings are classified `empty` (findingsStatus wants a `## Claims` section, explore's prompt
 *  asks for `## Approaches`, and explore.md says in so many words "do NOT gate on FS=ok"), so every
 *  healthy explore worker that skipped the soft sentinel line was refused and then dropped as empty.
 *
 *  Verdicts, in order:
 *
 *  - sentinel present → `complete` (the contract was honoured).
 *  - `AC=sentinel|quiescent|unchecked` → `complete` REGARDLESS of the sentinel and of the tag. The
 *    wait already accepted this artifact; how its CONTENT classifies is the stateFn's business, not
 *    the backstop's, and re-judging it here would destroy accepted work over a line the worker
 *    merely forgot.
 *  - `AC=expired` → `drop`: the wait held the phase open and the artifact was still empty or still
 *    changing at the cap, so the pre-existing drop path (treat as EMPTY, N-1 continuation) takes it.
 *  - phase tag `failed` → `drop`: an `error` event; that worker will never finish. NOTE a phase tag
 *    of `timeout` no longer drops BY ITSELF — expiry is `AC=expired`, and a bare `<KEY>=timeout`
 *    (the wait saw no terminal event at all) leaves a worker that may still be writing, which is
 *    exactly the refusal case below; a dead worker's missing/empty artifact still drops through the
 *    callers' own missing-or-empty machinery without ever reaching here.
 *  - anything else — no `AC=` line (the gate-skipping hub, the case this backstop exists for), a
 *    `question`, or a still-pending classification → `still-writing`: refuse the whole verb (rc 1)
 *    so the hub runs that phase's wait and retries. Bounded twice: NO_GROWTH_STRIKES refusals with
 *    no growth, or MAX_REFUSALS refusals in total, degrade to the drop path with a forensics flag. */
export function artifactBackstop(opts: {
  label: string; command: "explore" | "design"; topic: string;
  art: string; agent: string; artifact: string;
  /** The phase state file's text ("" when absent) and the phase's status key: the backstop reads
   *  BOTH `AC=` and `<key>=` out of it, so the AC vocabulary lives in exactly one place. */
  stateText: string; key: string;
  /** The artifact bytes the CALLER already read and is about to parse. Passing them closes the
   *  TOCTOU window in which a worker's `mv` lands between the check and the caller's own read. */
  text?: string;
}): ArtifactVerdict {
  const text = opts.text ?? readIf(opts.artifact);
  const accept = lastTag(opts.stateText, ARTIFACT_ACCEPT_KEY);
  if (hasArtifactSentinel(text) || accept === "unchecked" || WAIT_ACCEPTED.has(accept ?? "")) {
    clearArtifactStrikes(opts.art, opts.agent, opts.artifact);
    return "complete";
  }
  if (accept === "expired" || lastTag(opts.stateText, opts.key) === "failed") return "drop";
  const { strikes, total } = recordStillWriting(opts.art, opts.agent, opts.artifact, Buffer.byteLength(text));
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
  log.error(`${opts.label}: ${opts.agent} ${opts.artifact} has no ${END_OF_ARTIFACT} and no ${ARTIFACT_ACCEPT_KEY}= verdict (still writing; strike ${strikes}/${NO_GROWTH_STRIKES}, refusal ${total}/${MAX_REFUSALS}) — run that phase's wait verb, then retry`);
  return "still-writing";
}
