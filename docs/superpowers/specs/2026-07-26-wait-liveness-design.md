# Wait-liveness: stop declaring live workers dead — design

Date: 2026-07-26
Status: approved (user: "do the wait-liveness spec first, small PR"), from the 2026-07-26
/ap:review over 85 forensics files.

## Problem

The consult wait verbs (explore/design research/openq/crossverify/adversary/rebuttal/gap/signoff)
expire fixed budgets (300–900s via `consultTimeout` × provider multiplier) while the worker's
pane is alive and mid-turn. Across the reviewed window (~23 files, 12 topics, both boxes),
**not one recorded wait timeout was a real worker failure** — 16-minute codex turns and
ultracode claude turns simply outran the budget. The damage compounds in three stages:

1. The wait writes `<KEY>=timeout` + the `.done` sentinel and returns rc 0 — timeout is
   indistinguishable from death.
2. `wait-gate` counts timeout as `terminal` and returns rc 0 with no artifact on disk — the
   directive proceeds, silently missing a findings/verdict file.
3. The downstream send guards soft-skip the "timed-out" worker — but the guard chains have
   gaps: `adversary-send` checks FS/QS but not VS, `gap-send` walks RS→AS→FS (no VS/QS),
   `signoff-send` walks GS→RS→AS→QS→FS (no VS). A worker whose *crossverify* turn "timed out"
   (i.e. is still running) can be sent an adversary prompt that clobbers its in-flight inbox —
   and on 2026-07-26 both workers hit `QS=timeout`, so crossverify AND adversary soft-skipped
   in cascade while the run reported success: a full adversarial explore silently degraded to
   an unverified single-pass survey.

The infrastructure for the fix already exists: `outboxWaitSince` (src/core/ipc.ts) has an
injected pane-liveness probe (`WaitLivenessOpts`) used today only to fail FAST when the pane
died. The inverse signal — pane alive at budget expiry — is currently discarded.

## Goal

A wait budget expiring while the worker's pane is alive extends the wait (bounded) instead of
declaring timeout; the guard chains have no gaps; a wait-gate that passes on a timeout/failed
terminal state says so loudly. Net effect: `<KEY>=timeout` regains its meaning ("the worker is
gone or truly stuck"), and the adversary/sign-off phases — which the same review proved are
load-bearing against hub errors — can no longer be silently skipped by a false timeout.

## Architecture

Three surgical changes, no protocol or state-file format changes:

1. **Liveness-extended wait (core).** `WaitLivenessOpts` gains `extendMult?: number`
   (default 1 = off at the core, so every existing `outboxWaitSince` caller and test is
   byte-identical; the live wiring passes 3). `outboxWaitSince` keeps polling past `timeoutSec` — up to
   `timeoutSec × extendMult` — as long as liveness opts with a pane id are present; the
   existing two-consecutive-dead-polls check keeps governing during the extension (pane death
   still returns the synthetic `error` fast). At base-budget expiry it logs one
   `log.warn` ("budget elapsed with pane alive — extending"). Hard cap → `null` (true
   timeout, now meaning: pane alive but `extendMult ×` budget exceeded — genuinely stuck).
   Without liveness opts / pane id the behavior is byte-identical to today.
   `liveOutboxWait` (src/core/waitLive.ts) wires `extendMult: envNum("AP_WAIT_EXTEND_MULT", 3)`
   — `AP_WAIT_EXTEND_MULT=1` disables extension (envNum's `|| def` semantics mean `0` also
   falls back to the default; 1 is the documented off-switch), and the multiplier is clamped
   to ≤10 so a typo cannot yield a multi-day wait. The extension applies to every
   `liveOutboxWait` caller (explore/design consult waits AND quick/bridge/implement turn
   waits) — uniform on purpose: a live worker is a live worker; the env knob tunes it. Stated
   consequence for the turn verbs: `AP_IMPLEMENT_TURN_TIMEOUT_S` becomes the BASE of the cap,
   so the 4h default can run to 12h while the pane stays alive (documented in
   commands/implement.md). Out of scope, named deliberately: autoresearch's experiment monitor
   runs its own pane-check loop and gets no extension — its false timeouts are a separate fix.

2. **Close the guard-chain gaps (explore.ts).** Latest-phase-first ordering is
   FS → QS → VS → AS → RS → GS: `adversary-send`'s unsafe check becomes VS → QS → FS;
   `rebuttal-send` gains the walk AS → VS → QS → FS (an `AS=skipped` produced by the new
   adversary VS guard must fall through to the state that caused it — the review's repro showed
   checking AS alone would clobber a worker still mid-crossverify); `gap-send`'s walk becomes
   RS → AS → VS → QS → FS; `signoff-send`'s walk becomes GS → RS → AS → VS → QS → FS.
   `skipped` continues to pass (only `timeout`/`failed` block); openq-send (FS) and
   crossverify-send (FS, QS) are already correct for their positions.

3. **Loud wait-gate (both commands).** New pure helper `gateAnomalies(workers, key)` in
   src/core/designTurn.ts returns terminal workers whose last `<KEY>=` is `timeout`/`failed`;
   `explore wait-gate` and `design wait-gate` log one `log.warn` per anomaly ("terminal via
   `<KEY>=timeout` — its artifact may be missing; verify before proceeding"). Stdout format
   (`<agent>\t<status>`) and rc semantics unchanged — directives keep parsing exactly what
   they parse today; the warning rides stderr.

Deliberately NOT in this PR (bigger, separate): per-item-count budget scaling, changing
wait-gate rc semantics (directive changes), directive-text updates, the explore classifier
fixes (their own suggested spec).

## Components

- `src/core/ipc.ts` — `WaitLivenessOpts.extendMult`; extension loop + one-time warn in
  `outboxWaitSince`.
- `src/core/waitLive.ts` — wire `extendMult` from `AP_WAIT_EXTEND_MULT` (default 3).
- `src/core/designTurn.ts` — new pure `gateAnomalies()` beside `gateState()`.
- `src/commands/explore.ts` — adversary-send VS guard; gap-send + signoff-send walk VS/QS
  insertions; `exploreWaitGateRun` anomaly warnings.
- `src/commands/design.ts` — `waitGateRun` anomaly warnings.
- `tests/wait-extend.test.ts` — new: extension returns a late event, hard cap, pane-death
  during extension, no-liveness legacy behavior.
- `tests/explore-cmd.test.ts` — new guard cases: VS=timeout soft-skips adversary-send /
  gap-send / signoff-send.
- `tests/design-turn.test.ts` (or the file housing gateState tests) — `gateAnomalies` cases.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` —
  0.5.4 → 0.5.5; `dist/ap.cjs` rebuilt and committed.

## Testing

- `outboxWaitSince` (real fs, fake `paneAlive`, 1-second budgets): (a) no liveness opts →
  null at `timeoutSec` (legacy byte-identical); (b) event appended during the extension window
  → event returned; (c) nothing appended → null at `timeoutSec × extendMult`; (d) pane dies
  during extension → synthetic `error` note=pane-died.
- Guard cases (existing explore-cmd fixture style): `crossverify-<agent>.txt` ending
  `VS=timeout` → `AS=skipped` / `GS=skipped` / `SS=skipped`, no send; `VS=skipped` does not
  block.
- `gateAnomalies`: timeout/failed → reported; ok/missing/skipped/question/pending → not.
- Full gate green: typecheck, lint, suite, build; dist-fresh passes.

## Success Criteria

- A worker outrunning its consult budget with a live pane is waited on (up to the cap) and its
  event is captured — `FS/QS/VS/AS/RS/GS/SS=timeout` no longer appears for merely-slow turns.
- A worker whose latest non-skipped phase state is `timeout`/`failed` can never be sent an
  adversary/gap/signoff prompt.
- `wait-gate` still prints the same stdout and rcs, but every timeout/failed-terminal worker
  produces a stderr warning naming the possibly-missing artifact.
- `AP_WAIT_EXTEND_MULT=1` restores pre-0.5.5 wait behavior exactly.
- Suite green; dist committed.
