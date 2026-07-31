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

*Amended again after the xhigh code review of the merged PR (same day) — the `AC=` marker.* The
"ok-tag passes" rule above was WRONG and shipped a worse bug than the one it fixed: a phase tag is a
CONTENT classification, not an acceptance. explore's research prompt asks for `## Approaches` while
`findingsStatus` counts claims under `## Claims`, so healthy explore findings classify `FS=empty`
(explore.md says in so many words "do NOT gate on `FS=ok`") — meaning every explore worker that
skipped the soft sentinel line was refused three times and then destroyed as empty. Two more
consequences of the same conflation: grace expiry forcing `<KEY>=timeout` made #105's dispatch
guards treat the worker as unsafe and cascade-skip all its later phases, and `timeout` as a drop
trigger discarded complete-but-slow work. The fix is one marker: **the wait records its own verdict,
the backstop reads it, and neither infers anything from the other's field.**

- *Primary — `phaseWait` grace:* on receiving the `done` event, poll the artifact every 2 s up to a
  60 s grace (`AP_ARTIFACT_GRACE_S`; 0 disables BOTH depths, a positive value is clamped to
  10..300 — see the floor below). Two acceptances:
  - *fast path* — the artifact's LAST non-empty line, trimmed, EQUALS `END_OF_ARTIFACT`, and it is
    not the file's only content (equality, not `endsWith`: a worker that echoed the contract block
    would otherwise fake completeness, and a sentinel-only file has no content to accept);
  - *quiescence* — the artifact is non-empty AND its size is unchanged across ≥5 consecutive polls
    (~10 s): a worker that finished writing but skipped the sentinel line. 5, not 2 — a 4 s pause
    between two writes of one file is ordinary, and a false quiescence hands the hub the partial
    artifact this whole spec exists to stop.

  The wait then writes ONE extra line into the same phase state file, ahead of the terminal
  `<KEY>=` line (so the phase key stays last, as the directives' `grep '^FS=' | tail -1` expects):
  `AC=sentinel`, `AC=quiescent`, `AC=expired`, or `AC=unchecked` (grace disabled). Non-done
  terminal events (error/question) write NO `AC=` line — nothing was accepted, and that is
  distinguishable from "the wait never ran". The row's `stateFn` classifies the phase key in EVERY
  case including expiry: the key is content, `AC=` is acceptance. A quiescence acceptance records
  the forensics flag `artifact-quiescent-no-sentinel: <agent> <artifact>`; expiry records
  `artifact-incomplete:` — both for /ap:review, neither blocking.

  *Grace floor:* quiescence needs `QUIESCENT_POLLS * ARTIFACT_POLL_S` = 10 s. A positive
  `AP_ARTIFACT_GRACE_S` below that is RAISED to it, because under the floor the only reachable
  outcome is `expired` — "shorter grace" would silently mean "destroy every unsentinelled
  artifact". 0 still disables outright.
- *Backstop — validators:* explore's `survivors`, `synth-preliminary`, `diff`, `openq-collate`,
  `rebuttal-send`, `verdict-tally` and `synth-final`, and design's `diff` and `adjudicate`, check
  every worker artifact they are about to accept. Each passes the state file's TEXT plus the phase
  key (the backstop extracts both `AC=` and `<key>=`, so the AC vocabulary lives in one place) and,
  where it has already read the artifact, the BYTES it is about to parse — judging the same bytes
  the caller uses closes the TOCTOU window where a worker's `mv` lands between check and use.
  Verdicts, in order:
  - sentinel present → pass.
  - `AC=sentinel` / `AC=quiescent` / `AC=unchecked` → **PASS regardless of the sentinel and of the
    phase tag.** The wait already accepted this artifact; how its content classifies is the
    `stateFn`'s business, and re-judging it here destroys accepted work over a forgotten line.
  - `AC=expired` → treat as EMPTY (existing drop path, N-1 continuation) — the wait held the phase
    open and the file was still empty or still changing at the cap.
  - phase tag `failed` (an `error` event) → same drop path; no retry loop for a worker that will
    never finish. A phase tag of `timeout` does NOT drop by itself: a wait that saw no terminal
    event leaves a worker that may still be writing, and a dead worker's missing-or-empty artifact
    is already dropped by each caller's own missing-or-empty machinery before the backstop runs.
  - no `AC=` line at all (the gate-skipping hub, the case this backstop exists for), `question`, or
    a still-pending classification → refuse: stderr `STILL_WRITING=<agent>` + rc 1.

  Recovery for BOTH the refusal and the expiry is the same one verb: re-run that phase's `*-wait`.
  It resumes from the recorded `OFFSET=`, re-reads the same terminal event, and appends a fresh
  `AC=` line (latest-line-wins), so a worker whose file finished after the grace cap is rescued
  rather than lost. `wait-gate` cannot do this — it only reads state back — which is why the
  directives now name the wait verb instead.

  Bounded self-degrade on the refusal path: the refusing verb appends `<agent> <file-size>` to
  `_explore/stillwriting-<agent>-<artifact-basename>.txt` — per ARTIFACT, not per agent, so strikes
  accrued on a worker's findings can never degrade its adversary critique on that file's FIRST
  refusal. It degrades to the drop path with a forensics flag on the 3rd refusal with no GROWTH
  since the high-water mark (a shrink or an oscillation is not progress), and unconditionally at 6
  refusals however much the file grew. An accepted verdict deletes that file; so does a (re)dispatch
  of the phase (`dispatchPrompt`, the `rm`-to-retry contract) and `design offset-reset` for that
  agent, in both modes (`--keep-findings` included), which sweeps the agent's whole strike set.

**L3 — busy-gate in `dispatchPrompt`.** Before writing the state file and sending, read the
worker's `status.json` via the existing `workerBusyState` (regex read, whitespace-tolerant since
this spec). Busy → stderr `<label>: worker <agent> busy (state=<state>) — not sending; re-run
wait-gate and retry (status: <path>)` and return **rc 3** — distinct from rc 1 (state file exists /
send failed) and rc 2 (usage) so the directive branches without parsing stderr — with **no state
file** written (no `OFFSET=`, no `<KEY>=skipped`, so the phase stays runnable; the phase prompt file
was written earlier and is idempotent). Covers design's sends by construction. No new reset verb:
the busy branch in the directives reuses `implement reset-status <topic> <agent>`, which is
command-agnostic (it resolves the worker from the topic dir).

*Amended by the same review.* "Not `idle` = busy" was too broad. The identity template mandates
`idle` after a terminal event but lets a worker write `{"state": "<state>"}` freely after EVERY
event, and real workers echo their last event there — so `done`, `complete`, `error` and `ready`
(post-spawn, pre-inbox) were all read as busy and refused sends to workers that were plainly
waiting. `workerBusyState` now treats `idle`, `done`, `complete`, `error`, `ready` (case- and
whitespace-insensitive) and an absent/empty state as NOT busy; every other value, known or not,
still blocks — the conservative answer for an uninterpretable state is "do not clobber it". This
loosens implement's `workerSendGate` in the same way, as the tightening did.

`design drilldown` — the one dispatch path outside `dispatchPrompt`, an optional extra turn fired
while the workers are still live, hence the likeliest inbox clobber of all — runs the same
`workerBusyState` check before its send and counts a busy worker as producing no notes. Its prompt
also carries the L1 contract for its out file, which it previously lacked.

Readers tolerate the trailing sentinel: section parsers scan `##` headings and ignore a bare
trailing line; the hub's digests may carry it harmlessly. The sentinel is NOT part of the frozen
wire protocol (no event/field/filename renamed; new literal only).

## Components

- `src/core/artifact.ts` (leaf module — homing it here keeps the composer import graph acyclic) —
  `END_OF_ARTIFACT`; `ARTIFACT_ACCEPT_KEY` (`AC`) + the `WaitAccept` vocabulary;
  `hasArtifactSentinel` (last-non-empty-line equality + content required); `artifactComplete(path)`;
  `artifactGraceS` (0 disables, else clamped to the 10 s quiescence floor..300); `awaitArtifact`
  (sentinel/quiescent/expired); `artifactBackstop` + the per-artifact strike machinery
  (`clearArtifactStrikes` / `clearAgentStrikes`); `artifactContract(finalPath, alsoPaths)`.
- `src/core/phaseTable.ts` — grace loop in `phaseWait` (injectable sleep for tests) writing the
  `AC=` line through `recordWaitOutcome`, with the phase key always classified by `stateFn`;
  busy-gate in `dispatchPrompt` (injectable `busyState` dep defaulting to `workerBusyState`), which
  also clears that artifact's strikes on a successful (re)dispatch.
- `src/core/designTurn.ts` — `recordWaitOutcome` gains one optional `lead` line, written ahead of
  the terminal `<KEY>=` line in the same append (single writer, no second file format);
  `composeDrilldownPrompt` gains the L1 contract for its out path.
- `src/core/ipc.ts` — `workerBusyState`'s regex becomes whitespace-tolerant
  (`/"state"\s*:\s*"([^"]*)"/`) and its terminal-state set (`idle`/`done`/`complete`/`error`/
  `ready`/empty) is no longer just `idle`; both changes reach implement's `workerSendGate` too.
- `src/core/exploreTurn.ts`, `src/core/exploreOpenq.ts`, `src/core/exploreRebuttal.ts`,
  `src/core/designTurn.ts` — each phase composer appends `artifactContract(...)` for its
  artifact (research also names its `selfassess-<agent>.md`).
- `src/commands/explore.ts` — backstop in `survivors`, `synth-preliminary`, `diff`, `openq-collate`
  and (over `adversary-<agent>.md`) `rebuttal-send`, `verdict-tally`, `synth-final`;
  `verdict-tally` also warns when EVERY worker's adversary round was skipped.
- `src/commands/design.ts` — backstop in `diff` and `adjudicate`; busy-gate + contract in
  `drilldown`; `offset-reset` sweeps that agent's `stillwriting-<agent>-*.txt` in both modes.
- `commands/explore.md` + `commands/design.md` — the never-read-before-the-gate paragraph (the
  `AC=` vocabulary; `STILL_WRITING=<agent>` rc 1 → run that phase's **wait** verb, which is what
  classifies — `wait-gate` is read-only and cannot fix it — then retry; the verb self-bounds); the
  busy branch at each dispatch step (rc 3 → wait-60s-retry / `implement reset-status` / abort);
  `|| echo "SEND_FAILED=$INST rc=$?"` in BOTH commands' dispatch loops, with the read-the-stdout
  paragraph; strip the trailing sentinel when quoting worker text into the draft and final docs.
- `config/contracts.yaml` — comment-only note for `AP_ARTIFACT_GRACE_S` next to the consult
  block (env knob, not a contracts key).

## Testing

- phaseWait: sentinel present at done → `AC=sentinel` + key=ok (no polling); appears mid-grace →
  accepted after polls; non-empty and stable → `AC=quiescent` + `artifact-quiescent-no-sentinel`
  flag; still growing at the cap → `AC=expired` with the key's NATURAL classification +
  `artifact-incomplete` flag; empty → `AC=expired`; expiry does NOT make `anyPriorUnsafe` skip the
  later phases; error/question events write NO `AC=`; AP_ARTIFACT_GRACE_S=0 → `AC=unchecked`;
  floor/clamp.
- dispatchPrompt: busy → rc 3, no state file, no send call, exact stderr; idle/absent/unreadable
  status → dispatch unchanged; spaced `"state" : "working"` JSON reads as busy; the terminal set
  (`done`/`ready`/`complete`/`error`/blank/cased/padded) dispatches while an unknown state blocks;
  design rows inherit the gate; a (re)dispatch clears that artifact's strikes.
- Validators: **healthy explore findings (`FS=empty`, no sentinel, `AC=quiescent`) SURVIVE** — the
  regression test for the whole amendment, built from a real `## Approaches` findings fixture; a
  slow writer accepted by the wait survives validation; `FS=ok` WITHOUT an `AC=` line still refuses
  (the tag is not a verdict); unset state → rc 1 STILL_WRITING; `AC=expired` → drop-as-empty
  (existing N-1 path); `FS=timeout` with an empty artifact still drops via missing-or-empty;
  `FS=failed` drops; sentinel present → pass; strikes are per artifact (one agent's two files never
  share a counter); degrade after 3 no-growth refusals; a shrink/oscillation does NOT reset; the
  6-refusal cap degrades even under growth; an accepted verdict clears the strike file; the
  adversary consumers (`rebuttal-send`, `verdict-tally`, `synth-final`) refuse / drop / accept on
  the same rules.
- Sentinel: an echoed contract line does not satisfy it (equality, not `endsWith`); a sentinel-only
  file is not complete.
- Composers: each phase prompt (drilldown included) contains the contract block with the right
  final path; research also names its self-assessment file.
- Full gate: typecheck, lint, vitest, fresh dist committed; stale-tokens passes.

## Success Criteria

- A findings file lacking `END_OF_ARTIFACT` can no longer reach synthesis while the wait never
  classified its worker — the run refuses loudly instead (verified by tests simulating the
  incident) — and an artifact the wait DID accept is never dropped for the missing line, whatever
  its content classification says.
- One expired or skipped optional artifact never cascade-skips a worker's remaining phases.
- A send to a worker whose `status.json` says genuinely in-flight is refused with rc 3 and no state
  file; a worker sitting at a terminal state is not refused.
- The done-then-write worker race is absorbed silently in ≤60 s in the common case (grace test).
- No hangs: every refusal path is bounded (grace clamp; 3-strike no-growth degrade; 6-refusal
  absolute cap) and ends in the pre-existing drop machinery, flagged.
- Frozen surface untouched; suite green; dogfood on the next real /ap:explore run.
