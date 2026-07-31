# Artifact completeness — sentinel-gated waits, still-writing refusals, busy-gated sends

**Date:** 2026-07-31 · **Type:** behavior change (new enforcement; frozen wire surface untouched)
· **Origin:** live incident — hub read a half-written `findings-<agent>.md` from a mid-turn
worker, then a next-phase send reached the still-busy worker's inbox. Grilled 2026-07-31; builds
on the phase-table refactor (2026-07-31-phase-table-refactor-design.md) and STACKS on that PR.

## Problem

The pipeline gates phases on each worker's terminal OUTBOX event, not on artifact content. Two
enforcement gaps let a half-written artifact into synthesis and a send onto a busy worker:

1. A worker can emit `done` before its artifact file is fully written (order violation ap never
   states as a contract). Then `FS=ok`, wait-gate legitimately passes, the hub reads a partial
   file, AND the next phase-send's tag guards pass — the inbox is rewritten under a mid-turn
   worker, which ignores or clobbers the nudge.
2. A gate-skipping hub (our top recorded error source) can read findings after the FIRST
   completion notification; the validators (`survivors`, `synth-preliminary`) check only
   missing-or-empty, so a half-written file passes every machine check that exists.

`gateState` itself is per-worker sound — one worker's done can never satisfy the gate for all —
so the fix belongs in artifact completeness and send busyness, not in the gate.

## Goal

The hub cannot consume a partial artifact and cannot dispatch onto a busy worker, enforced by
verbs (machine checks), with prose only narrating. Waiting happens where waiting already lives
(the wait verb); validators are loud backstops; drops remain bounded and forensics-flagged.

## Architecture

Three independent layers (decided in the grilling, most-specific first):

**L1 — worker-side atomic visibility.** Per-phase composer prompts gain a shared contract block:
write the artifact to `<name>.tmp` in the same directory, `mv` it to the final name, and only
then emit the `done` event; the artifact's LAST line must be the literal sentinel
`END_OF_ARTIFACT`. The shared `inboxWrite` done-instruction is untouched (its blast radius spans
quick/bridge/implement/autoresearch). Compliance is soft; L2 makes violations detectable.
The research phase writes TWO files, so its contract block also names `selfassess-<agent>.md` — the
same tmp-write/sentinel/`mv` sequence. No verb checks the self-assessment's sentinel: it is
hub-side accountability material, advisory by design, and gating on it would refuse a run over a
file no phase consumes.

**L2 — sentinel enforcement, uniform, at two depths.** Scope: every worker-authored per-phase
artifact in the PHASES/DESIGN_PHASES tables (explore's 7 + design's 2), via `artifactFor`.

*Amended after adversarial review 2026-07-31: quiescence acceptance; ok-tag passes; drop
restricted to timeout/failed.* The review's finding: L1 compliance is soft (no worker is obliged
to write the sentinel), so a first draft that both TIMED OUT the wait and let a validator DROP the
file turned one missing line into destroyed research. Enforcement now degrades toward keeping
work, and loses only what it can prove is unfinished.

- *Primary — `phaseWait` grace:* on receiving the `done` event, poll the artifact every 2 s up to a
  60 s grace (`AP_ARTIFACT_GRACE_S`, clamp 0..300; 0 disables). Two acceptances:
  - *fast path* — the artifact ends with `END_OF_ARTIFACT` (trailing whitespace tolerated);
  - *quiescence* — the artifact is non-empty AND its size is unchanged across ≥2 consecutive polls
    (~4 s): a worker that finished writing but skipped the sentinel line.

  Either way the phase proceeds exactly as today (the row's `stateFn` classifies). A quiescence
  acceptance additionally records the forensics flag `artifact-quiescent-no-sentinel: <agent>
  <artifact>` — the soft-compliance signal /ap:review needs — and the run continues.
  Grace expiry (artifact empty, or still changing at the cap) → record the phase key = `timeout`
  (EXISTING tag vocabulary — downstream guards, survivors and forensics already know what timeout
  means) plus the `artifact-incomplete:` forensics flag naming it. Non-done terminal events
  (error/question) bypass the check entirely — unchanged paths.
- *Backstop — validators:* explore's `survivors`, `synth-preliminary`, `diff` and `openq-collate`,
  and design's `diff` and `adjudicate`, check the sentinel on every worker artifact they are about
  to accept. Verdicts by that worker's phase tag:
  - tag `ok` → **PASS regardless of the sentinel.** The wait already accepted this artifact (via
    sentinel or quiescence) and wrote `ok`; re-judging it here would destroy accepted work over a
    line the worker merely forgot.
  - tag unset / `question` / any still-pending classification → refuse: stderr
    `STILL_WRITING=<agent>` + rc 1. This is the case the backstop exists for — the gate-skipping
    hub reading findings before the wait ever classified them.
  - tag `timeout` / `failed` → treat as EMPTY (existing drop path, N-1 continuation) — no retry
    loop for a worker that will never finish.

  Bounded self-degrade on the refusal path: the refusing verb appends `<agent> <file-size>` to
  `_explore/stillwriting-<agent>.txt`; it degrades to the drop path with a forensics flag on the
  3rd refusal with no GROWTH since the previous one (a shrink or an oscillation is not progress
  and does NOT reset the counter — only `size > last` does), and unconditionally at 6 refusals
  however much the file grew. An accepted verdict deletes the file; so does `design offset-reset`
  for that agent, in both modes (`--keep-findings` included).

**L3 — busy-gate in `dispatchPrompt`.** Before writing the state file and sending, read the
worker's `status.json` via the existing `workerBusyState` (regex read, whitespace-tolerant since
this spec). Busy → stderr `<label>: worker <agent> busy (state=<state>) — not sending; re-run
wait-gate and retry (status: <path>)` and return **rc 3** — distinct from rc 1 (state file exists /
send failed) and rc 2 (usage) so the directive branches without parsing stderr — with **no state
file** written (no `OFFSET=`, no `<KEY>=skipped`, so the phase stays runnable; the phase prompt file
was written earlier and is idempotent). Absent/unreadable status or `idle` → proceed (no worse than
today). Covers design's sends by construction. No new reset verb: the busy branch in the directives
reuses `implement reset-status <topic> <agent>`, which is command-agnostic (it resolves the worker
from the topic dir).

Readers tolerate the trailing sentinel: section parsers scan `##` headings and ignore a bare
trailing line; the hub's digests may carry it harmlessly. The sentinel is NOT part of the frozen
wire protocol (no event/field/filename renamed; new literal only).

## Components

- `src/core/artifact.ts` (leaf module — homing it here keeps the composer import graph acyclic) —
  `END_OF_ARTIFACT`; `artifactComplete(path)`; `awaitArtifact` (sentinel/quiescent/expired);
  `artifactBackstop` + the strike machinery; `artifactContract(finalPath, alsoPaths)`.
- `src/core/phaseTable.ts` — grace loop in `phaseWait` (injectable sleep for tests); busy-gate in
  `dispatchPrompt` (injectable `busyState` dep defaulting to `workerBusyState`).
- `src/core/ipc.ts` — `workerBusyState`'s regex becomes whitespace-tolerant
  (`/"state"\s*:\s*"([^"]*)"/`); deliberately tightens implement's `workerSendGate` too.
- `src/core/exploreTurn.ts`, `src/core/exploreOpenq.ts`, `src/core/exploreRebuttal.ts`,
  `src/core/designTurn.ts` — each phase composer appends `artifactContract(...)` for its
  artifact (research also names its `selfassess-<agent>.md`).
- `src/commands/explore.ts` — backstop in `survivors`, `synth-preliminary`, `diff` and
  `openq-collate`; `verdict-tally` warns when EVERY worker's adversary round was skipped.
- `src/commands/design.ts` — backstop in `diff` and `adjudicate`; `offset-reset` clears that
  agent's `stillwriting-<agent>.txt` in both modes.
- `commands/explore.md` + `commands/design.md` — the never-read-before-the-gate paragraph
  (`STILL_WRITING=<agent>` rc 1 → re-run wait-gate and retry; the verb self-bounds); the busy
  branch at each dispatch step (rc 3 → wait-60s-retry / `implement reset-status` / abort);
  `|| echo "SEND_FAILED=$INST"` in explore's dispatch loops; strip the trailing sentinel when
  quoting worker text into the draft and final docs.
- `config/contracts.yaml` — comment-only note for `AP_ARTIFACT_GRACE_S` next to the consult
  block (env knob, not a contracts key).

## Testing

- phaseWait: sentinel present at done → ok (unchanged); appears mid-grace → ok after polls;
  non-empty and stable → ok + `artifact-quiescent-no-sentinel` flag; still growing at the cap →
  key=timeout + `artifact-incomplete` flag; empty → key=timeout; error/question events bypass;
  AP_ARTIFACT_GRACE_S=0 disables; clamp.
- dispatchPrompt: busy → rc 3, no state file, no send call, exact stderr; idle/absent/unreadable
  status → dispatch unchanged; spaced `"state" : "working"` JSON reads as busy; design rows
  inherit the gate (one design-side test).
- Validators: tag `ok` + no sentinel → pass (accepted work is never destroyed); unset tag + no
  sentinel → rc 1 STILL_WRITING; FS=timeout + no sentinel → drop-as-empty (existing N-1 path);
  sentinel present → pass; degrade after 3 no-growth refusals; a shrink/oscillation does NOT
  reset; the 6-refusal cap degrades even under growth; an accepted verdict clears the strike file.
- Composers: each phase prompt contains the contract block with the right final path; research
  also names its self-assessment file.
- Full gate: typecheck, lint, vitest, fresh dist committed; stale-tokens passes.

## Success Criteria

- A findings file lacking `END_OF_ARTIFACT` can no longer reach synthesis while the wait never
  classified its worker — the run refuses loudly instead (verified by tests simulating the
  incident) — and an artifact the wait DID accept is never dropped for the missing line.
- A send to a worker whose `status.json` says non-idle is refused with rc 3 and no state file.
- The done-then-write worker race is absorbed silently in ≤60 s in the common case (grace test).
- No hangs: every refusal path is bounded (grace clamp; 3-strike no-growth degrade; 6-refusal
  absolute cap) and ends in the pre-existing drop machinery, flagged.
- Frozen surface untouched; suite green; dogfood on the next real /ap:explore run.
