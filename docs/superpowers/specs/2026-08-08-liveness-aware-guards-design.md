# Liveness-aware dispatch guards, tunable consult budgets, degraded-run stamp — design

**Date:** 2026-08-08 · **Origin:** the GUARD LOCKOUT forensics flag from a side-lane eval box (2026-07-31
`flashattention-head` explore, ap 0.5.4): every phase wait timed out (450–900s < real turn time),
each `timeout` tag soft-skipped the NEXT phase via the guard chains, and a 2-worker run silently
degraded to "two independent research docs, zero cross-verification" with no degraded-run stamp —
workers were **verifiably idle** at skip time. Related lifetime events: romeo research-wait
timeout with findings already written ("done landed late", 2nd occurrence), bravo openq-wait
double-expiry mid-16-minute codex turn. · **Scope:** one PR.

## Problem

What 0.5.5–0.5.9 already fixed, and what remains:

- **Fixed (0.5.5 #103):** waits extend up to `AP_WAIT_EXTEND_MULT`× (default 3) while the pane is
  alive (`liveOutboxWait`); dead panes fail fast. The lockout ran on 0.5.4, before this.
- **Fixed (0.5.8/0.5.9):** a wait expiry no longer forces `KEY=timeout` over the row's natural
  classification, and artifact acceptance is the wait's own `AC=` verdict.
- **Remaining gap 1 — guards are history-only.** `guardSkipped` (`src/core/phaseTable.ts:179`)
  consults only recorded tags: a `timeout`/`failed` anywhere in the chain skips the send on the
  rationale "the worker may still be busy". It never asks whether the worker IS busy — even when
  the worker finished late and has been sitting idle for an hour, every remaining phase skips.
  One expired wait can still end a worker's entire run.
- **Remaining gap 2 — budgets are not operator-tunable per box.** `consultTimeout` reads
  `contracts.yaml`'s `consult.<kind>_timeout_s`, but that file ships with the plugin and the
  resolvers deliberately prefer the shipped copy (0.3.10) — a per-box edit dies on every update.
  There is no env override, unlike the turn budgets (`AP_QUICK_TURN_TIMEOUT`,
  `AP_IMPLEMENT_TURN_TIMEOUT_S`).
- **Remaining gap 3 — a run that lost all cross-verification looks healthy.** Survivors counts
  findings files; the wait gate reports terminal; only adversary all-skipped gets a loud warn
  (0.5.8 S7). Nothing stamps the HANDOFF, so `/ap:design` consumes an unverified single-pass
  survey as if it were cross-verified — exactly what the standing feedback memory forbids.

## Goal

A skipped phase requires BOTH a bad historical tag AND the absence of POSITIVE evidence that the
worker is free — where "no evidence" and "evidence of idleness" are different answers, and only the
second unlocks a send. Consult budgets get env overrides. A run whose cross-verification collapsed
says so in the artifact that leaves the run (the handoff), machine-written from the verdicts each
layer recorded about itself.

## Architecture

**Standing rule this design is an instance of:** *a layer records its own verdict and consumes other
layers' recorded verdicts — it never infers them.* The 0.5.9 regression (an artifact backstop
inferring acceptance from a content tag) was the last violation; both parts below are the same rule
applied to dispatch and to the handoff.

**1. Evidence-gated override in `guardSkipped`.** The guard's chain verdict becomes a *presumption*,
overridable only by POSITIVE evidence that the worker is free. New signature (now async, for the
pane probe) `guardSkipped(row, art, agent, stateFile, live?: { topic, provider, busyState?,
paneAlive? })` — all six explore call sites `await` it and pass `{ topic, provider, busyState:
d.busyState, paneAlive: d.paneAlive }`, so the guard and `dispatchPrompt`'s rc-3 busy-gate answer
from ONE seam (`SendDeps` gains `paneAlive`; tests inject both). With no `live`, behavior is
byte-identical to 0.5.11.

On an unsafe chain the skip stands UNLESS all four legs hold, probed in this order (the first failure
is the reason the warning names):

- **(a) The worker's own word.** `status.json` exists, is not the platform spawn seed
  (`last_event: "spawn"`, written by `seedWorkerStatus` before the worker ever reports), and the
  injected `busyState` says idle. An absent, unreadable or seeded status is SILENCE, not evidence —
  forensics show four real workers that never maintained status at all.
- **(b) The failing turn ended.** Map the unsafe `KEY` through `EXPLORE_PHASE_BY_KEY` to
  `<phase>-<agent>.txt`, take its last `OFFSET=`, and require a TERMINAL_EVENTS hit past it via a new
  `outboxTerminalSince(i, m, t, offset)` in `ipc.ts` (the same `readFrom`/`lastMatch` machinery the
  wait uses — not a second reader). A wait expiry proves the HUB stopped listening, nothing about the
  worker.
- **(c) The failing artifact is settled.** Absent, empty, `END_OF_ARTIFACT`-terminated, or already
  carrying `AC=sentinel`/`AC=quiescent`. A present-but-unsettled file is the 0.5.8 late-done race:
  the worker is still writing and a send would land mid-write.
- **(d) The pane is alive.** `paneMetaRead` for the id (absent → skip) plus a `paneAlive` probe (a
  throw counts as dead). A dead worker is idle in the most literal sense and passes (a)–(c), but
  dispatching to it turns a clean `<KEY>=skipped` rc-0 walk into one send failure per remaining phase.

When all four hold: `log.warn` the override, `recordHubFlag`
(`guard-override-idle: <agent> <phase> chain=<KEY=value>`), return false so dispatch proceeds.
`dispatchPrompt`'s rc-3 busy-gate is explicitly NOT the backstop here — it re-reads the same file
through the same seam a moment later; the safety is the evidence quadruple. The two guard encodings
(`anyPriorUnsafe` / `latestNonSkippedUnsafe`) are untouched — the probe wraps their verdict at the
one shared consumer, so the unification question stays open and unprejudiced. Design's two phases
have no guards; nothing changes there.

**1b. `gateAnomalies` warns on `missing`.** `missing` is `verifyState`'s answer for a worker that
ANSWERED but wrote no artifact — the quietest member of the silent-degrade class the gate warning
exists for, and the one that cascaded unnoticed. It joins `timeout`/`failed` in the warned set.

**2. Env-tunable consult budgets.** `consultTimeout(kind)` precedence becomes: env
`AP_CONSULT_TIMEOUT_<KIND>` (uppercase kind, seconds, positive-int regex — same validation as the
yaml path) → `contracts.yaml consult.<kind>_timeout_s` → built-in default. Read via the same strict
regex so a typo falls through rather than yielding NaN. Documented in the same block, including the
aliasing operators trip on: explore's crossverify has no kind of its own, so its knob is
`AP_CONSULT_TIMEOUT_VERIFY` and `AP_CONSULT_TIMEOUT_CROSSVERIFY` does not exist. `AP_WAIT_EXTEND_MULT`
and provider `timeout_multiplier` semantics unchanged and compose as today.

**3. Cross-verification coverage stamp, read from recorded verdicts.** `extractHandoffData`
(`src/core/exploreHandoff.ts`) computes per-leg coverage from what each layer RECORDED:

- A leg is **covered** when any worker's `<phase>-<agent>.txt` carries `AC=sentinel|quiescent` — the
  wait's own acceptance. NEVER from `<KEY>=ok`: `explore.md` forbids gating on that value, `VS=ok`
  can sit beside an `AC=expired` artifact the validators dropped, and `verifyState` answers `missing`
  for a worker that replied with nothing.
- A leg is **benign** when the run deliberately closed it with nothing to do: for crossverify, every
  worker has an EXISTING but empty `crossverify-claims-<agent>.txt` (the send verb writes that file
  immediately before its "no peer claims" skip, and the guard path returns BEFORE writing it — which
  is exactly what discriminates a deliberate no-op from a guard skip); for adversary,
  `adversary-skip.txt` records `user_decision: skip` (the 5-signal gate closed the phase).
- Otherwise the leg is **lost**.

Value matrix: both covered → `ok`; adversary benign AND crossverify covered-or-benign →
`gate-skipped`; both lost → `none` (loud `log.warn`); anything else → `partial`. Two additive KV
lines, `cross_verification=` then `cross_verification_detail=crossverify=<...>,adversary=<...>`,
placed before the frozen tail keys `session_path`/`topic_txt_path`/`generated_ts` — this spec is the
documented divergence extending the reconciled-frozen key set.

Both keys are SUPPRESSED for a degraded run (`list.txt` < 2 rows): the DEGRADED stamp already carries
the honest caveat and a solo worker's adversary pass is self-review, not cross-verification. With no
`list.txt` at all they are also suppressed, with a warn — there is no roster to judge coverage
against. The missing-`list.txt` glob fallback of the first draft is REMOVED: it minted phantom agents
out of `adversary-skip.txt`/`crossverify-claims-*` filenames and is unreachable in the shipped flow.

`commands/explore.md` Phase 9c stamps per value: `none` → "zero cross-verification — treat as an
unverified single-pass survey" (the standing memory's wording); `gate-skipped` → the EXISTING milder
"no adversarial review — preserve room for that uncertainty" caveat, never the harsh one; `partial` →
name the held and lost legs from the detail line; `ok` → nothing. Absent keys are not a pass.

## Components

- `src/core/phaseTable.ts` — `guardSkipped` becomes async + evidence-gated; `GuardLive` and the
  `SendDeps.paneAlive` seam; header comment gains the presumption-vs-evidence rule.
- `src/core/ipc.ts` — `workerStatusReport` (absent/seed/reported) and `outboxTerminalSince`.
- `src/commands/explore.ts` — six `await guardSkipped(..., { topic, provider, busyState, paneAlive })`.
- `src/core/designTurn.ts` — `gateAnomalies` warns on `missing` too.
- `src/core/contracts.ts` — `consultTimeout` env-first precedence + doc comment (incl. the
  crossverify→verify aliasing).
- `src/core/exploreHandoff.ts` — verdict-based coverage (`CoverageResult`/`CoverageStamp`/`LegStatus`),
  the two KV lines, degraded + no-roster suppression, loud warns; the glob fallback removed.
- `commands/explore.md` — Phase 9c's four-value stamp rules; Phase 4's evidence-quadruple note and the
  `AP_CONSULT_TIMEOUT_<KIND>` operator paragraph.
- `tests/` — see Testing.
- `package.json` + `dist/ap.cjs` — bump (→ 0.5.12 assuming A and B land first); rebuild + commit.

## Testing

- **Lockout regression (the headline test):** an unsafe chain plus all four evidence legs →
  the guard returns false and dispatch proceeds (prompt written, OFFSET recorded, one
  `guard-override-idle` flag). Parametrized over ALL SIX guarded verbs, not just one — a mutation
  audit removed five of the six call-site wirings and a single-verb suite stayed green.
- **One test per broken leg, per verb:** no status.json / spawn-seeded status / busy / no terminal
  event past the offset / unsettled artifact / no pane.json / dead pane → today's `<KEY>=skipped`,
  no send, no flag, with the reason named on stderr.
- Both guard encodings exercised through the probe (an `any` site and a `latest` site), chain ORDER
  pinned unchanged; the encoding-differentiator test runs BOTH sides against a busy worker so the two
  encodings produce visibly different refusals (guard rc 0 + state write vs busy-gate rc 3 + none).
- `workerStatusReport` (absent/seed/reported) and `outboxTerminalSince` (offset + terminal-only).
- `consultTimeout`: env valid → env wins; env garbage/zero/negative → falls to yaml/default;
  unset → unchanged; each kind's env name derived correctly.
- Handoff coverage: both legs accepted → `ok`; `VS=ok`/`AS=ok` sitting beside `AC=expired` → NOT
  coverage (the anti-inference test); the lockout shape → `none` + both KV lines + loud warn; gate
  `user_decision: skip` with crossverify held → `gate-skipped` and NO harsh warn; empty claims files
  + gate skip → both `benign`; a non-empty claims file whose phase never landed → `lost`, not benign;
  degraded run → NEITHER key; no `list.txt` → neither key + warn; frozen tail order pinned around the
  two new lines.
- `gateAnomalies` reports `missing` alongside `timeout`/`failed`.
- Existing suites (phase-table pins, explore-cmd table tests, artifact-completeness) stay green.

## Success Criteria

- Replaying the side-lane eval box's lockout shape (waits expired, workers verifiably free) on the new code dispatches
  every subsequent phase instead of cascade-skipping, with one `guard-override-idle` forensics flag
  per override — and a worker that is busy, silent, mid-artifact or dead still gets today's skip.
- A run with zero cross-verification produces `cross_verification=none` plus the detail line in
  handoff-data.kv and a loud warn; the directive stamps the caveat. No stamp can be produced by
  inference from a phase key — only from a recorded `AC=` verdict or a recorded deliberate skip.
- An operator can lengthen any consult budget per box with one env var that survives plugin
  updates.
- Full gate green; dist rebuilt + committed.
