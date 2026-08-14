# Turn-wait terminal confirmation — design

**Date:** 2026-08-14 · **Origin:** the `central-inference-se` implement run (first ≥0.5.12
dogfood, local box): `turn-wait` classified `TS=failed` TWICE while the pane was actively working
— codex's internal multi-agent mode emitted premature terminal-looking events mid-turn; real
commits landed both times; the hub fell back to hand supervision (~4 round-trips). A second,
latent defect in the same machinery: `lastMatch` scans events in ARGUMENT order, so a `done`
anywhere in the scanned region beats a LATER `error` — a worker that emits done-then-error
classifies `ok` today. · **Scope:** one PR (0.5.15).

## Problem

The three round-based turn-waits (implement `turn-wait`, quick `turn-wait`, bridge `round-wait`)
consume the FIRST terminal event the outbox wait matches and classify immediately
(`classifyTurn`, `src/core/turn.ts:45-50`) — no confirmation, no liveness cross-check, and no
record of where in the file the event sat. Two consequences, both observed or reproduced:

1. **Premature terminal**: a worker (codex internal-agents mode) emits `done`/`error` mid-turn and
   keeps working; the wait classifies a live turn as ended. The artifact-grace layer does not
   apply — these waits are round-based, not artifact-backed phase waits.
2. **done-then-error**: `lastMatch` (`src/core/ipc.ts:164-176`) returns events by argument-order
   precedence (`["done","error","question"]`), deliberately ported byte-for-byte — so a later
   `error` can never override an earlier `done` within one scan.

Phase waits, spawn's ready/error wait, and every other `lastMatch` consumer are NOT in scope —
their semantics stay byte-identical.

## Goal

A terminal event ends a turn only after the outbox goes quiet; continued activity vetoes the
premature classification (bounded), the wait re-arms for the turn's real end, and the final
verdict is the LATEST terminal event in FILE order — closing both shapes with one mechanism and
zero changes to the frozen wire protocol or any existing wait's matcher.

## Architecture

**New ipc reader (no second parser).** `outboxEventsSince(i, m, t, offset): OutboxEvent[]` —
exported from `src/core/ipc.ts`, reusing the private `readFrom` + `parseEvent` (skip non-JSON),
returning ALL events in the region in file order. This is the confirmation layer's only evidence
source: outbox bytes. No pane-content parsing, no status.json reads.

**The wrapper.** `waitTurnConfirmed(i, m, t, offset, timeoutS, d)` in `src/core/turn.ts`, where
`d` carries the existing injected `wait` plus an injectable `sleep`. The three turn-wait verbs
call it in place of their direct `d.wait(..., TERMINAL_EVENTS, ...)` call. Behavior:

1. **First leg unchanged**: `d.wait(i, m, t, offset, TERMINAL_EVENTS, timeoutS)` — including
   `liveOutboxWait`'s pane-liveness extension. `null` → return null (timeout path unchanged).
2. **Armed event**: the LATEST `done`/`error`/`question` in FILE order across
   `outboxEventsSince(offset)` (the wait's own pick only as a fallback when the region holds no
   readable terminal) — the one deliberate divergence from `lastMatch`'s argument-order precedence,
   confined to this wrapper.
3. **Question short-circuit**: an armed `question` returns IMMEDIATELY — no window, no veto, ever,
   and the same check applies to every re-armed event. A worker that stopped to ask cannot emit
   another terminal on its own, so confirming it would deadlock the hub (which relays the answer)
   against the worker (which waits for it).
4. **Confirmation window**: capture the outbox size `S0`; sleep `AP_TURN_CONFIRM_S` seconds
   (default 20; `0` disables the whole layer — behavior byte-identical to 0.5.14; clamp 5..120 for
   nonzero values, same envNum-avoidance as `AP_ARTIFACT_GRACE_S` so an explicit 0 is honored);
   re-read. Not GROWN (a shrink is not activity) → **confirmed**, accept the armed event.
5. **Veto + re-arm**: grew → record a hub flag
   (`turn-confirm-veto: <provider> premature <event> — outbox still active`) and re-arm as a SHORT
   wait through the same injected wait: `d.wait(i, m, t, S0, TERMINAL_EVENTS, confirmS)`. `S0` is
   past the armed event so it cannot re-match, and routing through `d.wait` keeps pane-liveness
   fail-fast (a synthetic `pane-died` error counts as a new terminal → classified `failed`, the
   0.5.14 behavior class). Outcomes:
   - a new terminal (synthetic included) → recompute the armed event (file order over the region
     past `S0`, falling back to the returned event), re-apply the question short-circuit, window
     again;
   - `null` **and** the outbox stopped growing → quiescent: the burst was trailing noise, accept the
     armed event (this is what keeps a real `done` + one trailing `progress` from sitting out the
     4h budget);
   - `null` but still growing → repeat the short wait, no veto counted, until the deadline.
6. **Bounds** (the layer must never become the thing that hangs a run): at most **2 vetoes**, so at
   most 3 window sleeps; the re-arm's short waits run until
   `max(wait-start + timeoutS, first-leg-end + 3 windows)` — the floor exists because a
   liveness-extended first leg can spend the whole base budget, which would otherwise make the
   confirmation expire on arrival and its veto flag a lie. Cap or deadline → accept the armed event
   and record its own distinct flag (`turn-confirm-cap: <provider> still writing after N windows —
   accepting <event>` / `turn-confirm-deadline: <provider> re-arm expired — accepting <event>`), so
   /ap:review can see WHY a turn was accepted unconfirmed.

The accepted event feeds the existing per-verb pipeline untouched: `classifyTurn` for quick/bridge,
`implementState` (the verify-report gate — a confirmed `done` with no passing report is still
`TS=failed`) for implement, question payload capture + `recordWaitOutcome` exactly as today.

**Question events**: `question`-then-`done`/`error` resolves to the later event exactly as 0.5.14
already did (argument-order precedence picked `done` there too). The REAL behavior flips are the
mirror cases: `done`-then-`question` and `error`-then-`question` now resolve to the **question**,
where 0.5.14 returned the earlier `done`/`error`. That is deliberate — the worker's last word is its
current state: it stopped to ask, and the hub must relay rather than close the turn. Noted in the
directives.

**What does NOT change**: `lastMatch`, `TERMINAL_EVENTS`, `outboxWaitSince` semantics, spawn's
ready/error wait, all phase waits, the artifact-completeness layer, event names/fields (frozen),
state-file formats (`TS=`/question files byte-identical).

## Components

- `src/core/ipc.ts` — `outboxEventsSince` export (readFrom + parseEvent reuse).
- `src/core/turn.ts` — `waitTurnConfirmed` + `AP_TURN_CONFIRM_S` read + veto cap / re-arm floor
  constants + latest-terminal-in-file-order selection; doc comment carries the divergence
  rationale and the loop's real bounds.
- `src/commands/implement.ts`, `src/commands/quick.ts`, `src/commands/bridge.ts` — the three
  turn-wait verbs call the wrapper; forensics flag on veto/cap/deadline (`recordHubFlag`,
  command-appropriate).
- `commands/implement.md` / `quick.md` / `bridge.md` — one note each: waits confirm terminal
  events against continued outbox activity (`AP_TURN_CONFIRM_S`, 0 disables); a veto records a
  `turn-confirm-veto` flag for /ap:review; the file-order verdict (incl. the question flips);
  implement's also restates that a confirmed `done` still gates on `verify-report-<ROUND>.md`.
- `README.md` — `AP_TURN_CONFIRM_S` row in the knobs table, the `turn-confirm-*` flags in
  "Reading a stuck or surprising run", refreshed test count.
- `commands/explore.md` operator note NOT needed (phase waits unaffected).
- `tests/` — see Testing. Version 0.5.14 → 0.5.15 (three manifests) + rebuilt committed dist.

## Testing

Fake deps (injected wait/sleep/clock, real temp outbox files under freshHome):
- Quiet window → armed event accepted; classification identical to today for done/error/question.
- Premature done: done + trailing progress within the window → veto flagged (by PROVIDER), re-arm
  finds the later real done → ok; with a later error instead → failed; the re-arm's `d.wait` call is
  pinned to `(offset=S0, timeout=confirmS)` so pane-liveness routing cannot be dropped, and a
  synthetic `pane-died` error from it becomes the verdict.
- Real done + ONE trailing progress → accepted after exactly one short re-arm wait (the
  stall-the-whole-budget regression), pinned by wait/sleep call counts.
- Armed question (with trailing bytes) → returned with ZERO windows and zero re-arms (the hub↔worker
  deadlock regression); done-then-question and error-then-question → question; question-then-done →
  done (unchanged from 0.5.14).
- done-then-error already in the region at first match → error wins (file order) even with
  `AP_TURN_CONFIRM_S=0`? NO — with the layer disabled behavior must be byte-identical to 0.5.14
  (done wins); the file-order rule applies only when the layer runs. Pin BOTH.
- Veto cap: a worker writing through every window → 2 veto flags + a `turn-confirm-cap` flag,
  bounded BY ASSERTION on the window/wait counts. Deadline (virtual clock, non-zero timeoutS):
  chatty with no new terminal → accepted with a `turn-confirm-deadline` flag at exactly the
  expected round count. Liveness-extended first leg → the re-arm still runs (floor formula).
- `AP_TURN_CONFIRM_S=0` → wrapper returns the first event untouched, zero sleeps, zero extra
  reads (byte-identical legacy pin); clamp pins (4→5, 500→120, garbage→default 20).
- All three verbs wired: per-verb pins (mutation-resistant: removing the wrapper from any one verb
  must fail its pin) AND per-verb veto-flag pins (removing that verb's `onVeto` must fail).
- `outboxEventsSince`: file-order, non-JSON skipped, offset semantics (mid-file), shrink-safe.
- E2E through the built dist: a real outbox replaying the codex shape (done → progress → commits
  → done) against `quick turn-wait` classifies ok exactly once, with one veto flag recorded. The
  bursts are anchored on the child's own "wait started" stderr line (not wall-clock guesswork), and
  a `beforeAll` guard fails with "run `npm run build` first" if the bundle predates the layer.

## Success Criteria

- Replaying the field shape (premature done/failed + continued activity + late real completion)
  classifies the turn by its REAL end, with one forensics flag per veto — no hand supervision.
- A done-then-error worker classifies failed (layer on).
- A worker that really finished (done + one trailing line) is accepted within ~2 windows, and a
  worker that asked a question is never held: neither shape can stall or deadlock a run.
- `AP_TURN_CONFIRM_S=0` restores 0.5.14 behavior byte-for-byte.
- Full gate green; dist rebuilt+committed; E2E evidence through the real CLI before merge.
