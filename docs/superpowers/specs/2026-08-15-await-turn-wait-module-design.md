# One deep wait module: `awaitTurn` + the clock seam — design

**Date:** 2026-08-15 · **Origin:** the four-walk architecture review (walk 3, candidates 1 and 2),
Wave B PR-1 of the deepening program; grilling settled its residence (Q7: a new `core/wait.ts` that
also absorbs the state-file micro-protocol, killing the `designTurn` misnomer without a rename) and
its behavior perimeter (Q9: none). · **Scope:** one PR (0.5.23), THREE ordered commits, all
byte-identical. Zero behavior changes.

> **Field caveat, recorded deliberately.** The 0.5.15 confirmation layer this PR rewrites has NEVER
> run in the field: the installed plugin is 0.5.17 but no `quick`/`implement`/`bridge` run has
> happened since, so `~/.ap/forensics` holds no `turn-confirm-*` evidence either way. The operator
> waived the dogfood gate knowingly. The mitigation is that this PR must preserve the layer
> byte-for-byte — its 0.5.15 suite (tests/turn-confirm.test.ts) is the regression net, and
> `AP_TURN_CONFIRM_S=0` remains the escape hatch that disables the whole layer.

## Problem

There is no wait module — there are SIX wait entry points across five files, and each caller
composes its own:

| entry point | file | who calls it | liveness | confirmation | artifact grace |
|---|---|---|---|---|---|
| `outboxWaitSince` | ipc.ts:216 | (via the two below) | injected opts | no | no |
| `outboxWait` | ipc.ts:244 | spawn ready-wait, collect | no | no | no |
| `liveOutboxWait` | waitLive.ts:17 | every live dep bag | yes | no | no |
| `waitTurnConfirmed` | turn.ts:123 | quick/bridge/implement turn-waits (3) | via injected wait | YES | no |
| `phaseWait` | phaseTable.ts | the 9 explore/design phases | via injected wait | no | YES (`AC=`) |
| `awaitArtifact` | artifact.ts:141 | (inside phaseWait only) | n/a | n/a | the grace itself |

Consequences, all present in the shipped code:

1. **The same question — "did the worker really finish?" — is answered by two disjoint probes owned
   by two disjoint caller sets.** `waitTurnConfirmed` watches OUTBOX byte growth and serves only the
   three single-worker verbs; `awaitArtifact`/`AC=` watches ARTIFACT byte growth and serves only
   phaseWait's nine phases. Neither family can use the other's protection.
2. **Every caller must know the plumbing**: read the latest `OFFSET=` itself, pick which of the
   matcher-bearing functions has liveness wired, pass `TERMINAL_EVENTS` (it is TERMINAL_EVENTS at
   every production turn/phase call site), and decide which protections apply.
3. **The state-file micro-protocol has no owner.** `parseLatestOffset` / `recordWaitOutcome` /
   `scaledTimeout` live in `designTurn.ts` and are imported by implement.ts, quick.ts, bridge.ts and
   phaseTable.ts — four non-design families depending on a module whose name says otherwise; its own
   comment claims it is "the single WRITER of the OFFSET=/<KEY>= micro-protocol" while five files
   write `OFFSET=` by hand.
4. **Two sleep helpers for one concept** (`ipc.ts`'s private 1 s poll sleep; `artifact.ts`'s exported
   `realSleep`, which `turn.ts` imports from the ARTIFACT module purely to get a timer), and **five
   tolerance constants with no shared vocabulary**: `MAX_VETOES`, `REARM_FLOOR_WINDOWS` (turn.ts),
   `QUIESCENT_POLLS`, `NO_GROWTH_STRIKES`, `MAX_REFUSALS` (artifact.ts).
5. **The injected `wait` is a test escape hatch, not a variation point.** All four production
   bindings are `liveOutboxWait`; it exists only because the engine hard-codes its own clock (a
   private `sleep(1000)` in ipc.ts). Because the seam sits ABOVE the engine, command-level tests mock
   away `readFrom`/`lastMatch`/the liveness extension entirely, while the engine's own tests must burn
   real wall-clock (`tests/wait-extend.test.ts` asserts elapsed >= 1900 ms). Worse, the seam silently
   rescales the quantity the layer above reasons about: `turn.ts` computes its re-arm deadline in
   wall-clock ms from `timeoutS`, but the injected wait multiplies that budget by
   `AP_WAIT_EXTEND_MULT` inside `waitLive.ts` — the module that owns the bound cannot see the rescale,
   and no test can observe it because the seam is mocked.

## Goal

ONE entry point owns offset resolution, liveness binding, terminal selection, and BOTH still-writing
probes as policy slots; `ipc.ts` keeps only pure readers; the micro-protocol, the sleep, and the
tolerance vocabulary get a home; the clock is injected at the ENGINE so tests exercise the real
matcher. Every state file, log line, flag, rc and `AC=`/`TS=`/`FS=` byte is unchanged, and
`AP_TURN_CONFIRM_S=0` still restores 0.5.14 behavior byte-for-byte.

## Architecture

### Commit 1 — `src/core/wait.ts` exists and owns the vocabulary (pure moves)

Create `src/core/wait.ts`. MOVE, unchanged in body:

- from `designTurn.ts`: `parseLatestOffset`, `recordWaitOutcome`, `scaledTimeout` (and the private
  `lastKeyedNumber`/`lastKeyedValue` they use — if `lastKeyedValue` has other designTurn callers,
  keep it there and import it, do NOT duplicate);
- from `artifact.ts`: `realSleep` (artifact.ts imports it back from wait.ts, or keeps a local
  binding — whichever leaves both files' other exports untouched);
- the five tolerance constants stay in their current modules for now (they are used where they are);
  wait.ts's header carries the ONE table naming all five, what each bounds, and which module owns it
  — the shared vocabulary the review found missing. Do NOT relocate constants whose module still
  owns the loop that reads them.

`designTurn.ts` keeps ONLY its design-specific pieces (the findings/verify/drilldown classifiers,
the gate readers, the prompt composers) — after this commit its name is honest, with no rename and
no import-compat shims (internal modules; update every importer).

**Nothing else changes in this commit**: no wait function is edited, no caller's control flow moves.

### Commit 2 — `awaitTurn` is the one entry point

In `wait.ts`:

```ts
export interface TurnPolicy {
  confirm?: boolean;                 // the AP_TURN_CONFIRM_S quiet-window layer (turn verbs)
  artifact?: { path: string };       // the AP_ARTIFACT_GRACE_S / AC= layer (phase waits)
}
export interface TurnCtx {
  agent: string; model: string; topic: string;
  stateFile: string;                 // the OFFSET= source; awaitTurn reads the LATEST itself
  timeoutS: number;                  // already provider-scaled by the caller (scaledTimeout)
  label: string;                     // log/flag prefix, e.g. "explore research-wait"
  command: "quick" | "bridge" | "implement" | "explore" | "design";
  policy: TurnPolicy;
}
export interface TurnResult {
  event: OutboxEvent | null;
  accept: WaitAccept | null;         // the artifact verdict (sentinel|quiescent|expired|unchecked), null when no artifact policy
  offset: number;                    // the offset actually waited from — callers log it
}
export async function awaitTurn(ctx: TurnCtx, d: WaitDeps): Promise<TurnResult | { missingOffset: true }>
```

`awaitTurn` owns, in exactly today's order: read the latest `OFFSET=` from `stateFile` (a missing
one is reported to the caller, which keeps its own error wording and rc — do NOT move that message);
call the wait with `TERMINAL_EVENTS` and liveness; when `policy.confirm`, run the 0.5.15 confirmation
loop VERBATIM (armed = latest terminal in file order, question short-circuit, quiet window, veto +
short re-arm through the same wait, MAX_VETOES cap, the `max(start+timeout, legEnd+3 windows)`
deadline floor, all three flag strings); when `policy.artifact`, run the grace exactly as phaseWait
does today — including that it applies ONLY to a `done` event, that `graceS === 0` yields
`"unchecked"`, and the two warning lines plus their `artifact-quiescent-no-sentinel` /
`artifact-incomplete` flags.

Flags emitted from inside go through an injected `onFlag(note)`, bound by callers to
`recordHubFlag({command, topic, note})` — byte-identical notes.

**What stays with the callers** (genuinely per-caller): the `<KEY>=skipped` fast-path and the `.done`
marker (phase waits), the pre/post `log.info`/`log.ok` lines, `stateFn` classification,
`recordWaitOutcome` (the layer records its OWN verdict — that rule is not diluted), the
question-payload capture, and implement's verify-report gate. `phaseWait` becomes a thin body over
`awaitTurn`; the three turn-wait verbs call it directly and `waitTurnConfirmed` disappears as an
export (its body lives inside awaitTurn).

**Not in scope, unchanged:** `lastMatch`'s frozen argument-order precedence and every other consumer
of it; `outboxWait` and spawn's ready-wait; `collect`; the artifact backstop/guard/handoff readers of
`AC=`. The file-order verdict divergence stays confined to the confirm path exactly as 0.5.15 shipped
it.

### Commit 3 — invert the seam: a Clock at the engine

`outboxWaitSince` (ipc.ts) takes `clock?: { now(): number; sleep(ms): Promise<void> }` alongside the
existing liveness opts, defaulting to the real ones; its private 1 s poll and the extension math both
read that clock. `liveOutboxWait` binds the real clock. `awaitTurn` takes the SAME clock and uses it
for the confirmation window and deadline — so the layer that computes the deadline and the layer that
applies `AP_WAIT_EXTEND_MULT` finally share one time source.

Then DELETE the `wait`, `sleep` and `nowMs` fields from the five dep interfaces (quick's
`TurnWaitDeps`, bridge's `TurnWaitDeps`, `ImplementWaitDeps`, phaseTable's `WaitDeps`, turn.ts's
`TurnConfirmDeps` — the last disappears with commit 2). What remains injectable: the clock, the pane
probe, and the genuinely per-command members (`multiplier`, `busyState`, `send`, `offsetFor`).

Tests then drive a VIRTUAL clock over a REAL temp outbox file, so the matcher, the shrink handling
and the liveness extension are exercised by the tests that today mock them away, and
`AP_WAIT_EXTEND_MULT`'s interaction with the deadline becomes assertable for the first time.
`tests/wait-extend.test.ts` stops spending real seconds.

## Components

- `src/core/wait.ts` (new) — micro-protocol + `realSleep` + the constants table + `awaitTurn` +
  `WaitDeps`/`TurnCtx`/`TurnPolicy`/`TurnResult` + the Clock type.
- `src/core/designTurn.ts` — loses the micro-protocol; keeps design-only pieces.
- `src/core/turn.ts` — loses `waitTurnConfirmed`/`TurnConfirmDeps`/the confirm constants; keeps the
  prompt composers, `classifyTurn`, `BRANCH_DISCIPLINE`/`BLOCKERS`.
- `src/core/ipc.ts` — clock parameter on `outboxWaitSince`; pure readers otherwise untouched.
- `src/core/waitLive.ts` — binds the real clock.
- `src/core/artifact.ts` — `realSleep` home change only; grace logic untouched.
- `src/core/phaseTable.ts` — `phaseWait` over `awaitTurn`; `WaitDeps` shrinks.
- `src/commands/{quick,bridge,implement}.ts` — call `awaitTurn`; dep bags shrink.
- `README.md` — the knobs table gains nothing new (names unchanged); one sentence in the
  architecture section that one module owns the wait.
- `tests/` — see Testing. Version 0.5.22 → 0.5.23 (three manifests) + rebuilt committed dist.

## Testing

- **Every existing wait/turn/phase test passes with ZERO assertion edits.** Permitted edits: import
  paths, and dep-factory wiring where a deleted field forces it. Any assertion that must change is a
  STOP-and-report.
- `tests/turn-confirm.test.ts` is the 0.5.15 regression net and must pass unchanged in substance:
  quiet-window accept, done+trailing-progress veto→re-arm, real-done+one-trailing accepted within
  ~2 windows, armed question returns with ZERO windows, done-then-question → question,
  question-then-done → done, the veto cap, the deadline floor with a liveness-extended first leg, and
  `AP_TURN_CONFIRM_S=0` byte-identical legacy behavior with zero sleeps and zero extra reads.
- Artifact-grace tests likewise: sentinel / quiescent (+flag) / expired (+flag) / unchecked, and that
  grace applies only to `done`.
- NEW: one policy-table suite over `awaitTurn` (confirm × artifact × neither), replacing the two
  mock stacks with one harness; a virtual-clock test proving `AP_WAIT_EXTEND_MULT` extends the first
  leg AND that the re-arm deadline floor still leaves room (the interaction that was previously
  unobservable).
- Mutation rule (program-wide): dropping the confirm layer from a turn verb, or the artifact policy
  from a phase wait, must fail a test; swapping the two policies must fail; removing the question
  short-circuit must fail.
- Full gate green; dist rebuilt+committed; an E2E replay of the codex shape (done → progress →
  commits → done) through the built dist classifying `ok` with exactly one veto flag.

## Success Criteria

- `grep -rn "liveOutboxWait\|waitTurnConfirmed" src/` shows the live binding in ONE place and no
  `waitTurnConfirmed` at all; `grep -c "OFFSET=" src/commands/*.ts src/core/*.ts` shows the write in
  the micro-protocol's module only (plus the callers' own `atomicWrite(stateFile, \`OFFSET=\`)` at
  send time, which is a different verb and stays).
- A future "phase waits confirm too" or "implement's verify report gets grace" is a policy-slot flip
  in one file, not a fourth wrapper — demonstrated by a test that flips a slot on a synthetic ctx.
- `designTurn.ts` no longer carries the shared micro-protocol: implement / quick / bridge stop
  importing it entirely. (Amended — see A17: "design code only" was never reachable in this PR.)
- Gate green; 0.5.23; behavior byte-identical, proven by dist-level differential.

## Amendments (recorded during implementation)

Each item is a place the spec's description of the shipped code did not survive contact with it.

**A1 (commit 1) — `realSleep` needs no import-back.** The spec left open whether `artifact.ts`
re-imports `realSleep` from `wait.ts` or keeps a local binding. Neither is needed: `artifact.ts`
never used `realSleep` itself (`awaitArtifact` takes `sleep` as a parameter), so the export simply
moves out and `artifact.ts` gains no import. This is load-bearing beyond tidiness — `wait.ts` must
import `awaitArtifact`/`artifactGraceS` from `artifact.ts` in commit 2, and an import back would be
exactly the module cycle `artifact.ts`'s own header warns about.

**A2 (commit 1) — only `lastKeyedNumber` moves; `lastKeyedValue` stays.** The spec grouped the two
private key readers together. In the shipped source `lastKeyedValue` is used ONLY by designTurn's
own `gateState`/`gateAnomalies` and by nothing that moves, while `lastKeyedNumber` is used by
`parseLatestOffset` AND by implement's `OBJECTIONS=` counter. The conditional the spec wrote for
`lastKeyedValue` therefore fires: it stays in `designTurn.ts`, un-duplicated.

**A3 (commit 2) — `TurnResult.offset` cannot exist; the offset leaves through `onArmed`.** The spec
gave `TurnResult` an `offset` field, "the offset actually waited from — callers log it". All four
call sites log the offset BEFORE the wait (it is the line that tells the operator what the hub is
now blocked on, for up to four hours), so a value returned AFTER the wait cannot feed it, and moving
the line after the wait would reorder it against the engine's own `outbox-wait: ... extending`
warning. `TurnResult` therefore carries no `offset`; `TurnDeps` gains `onArmed(offset)`, called once
between the offset read and the wait. Each verb keeps its own byte-exact wording — the three formats
genuinely differ (`quick turn-wait: round=N offset=…`, `[turn-wait] lead round=N offset=…`,
`explore research-wait: alpha offset=…`), so no single composed line could have replaced them.

**A4 (commit 2) — the artifact slot needs the phase KEY, not just the path.** `phaseWait`'s expiry
warning names the phase key in its own text ("`${row.key}` keeps its own classification so later
phases still dispatch"). `artifact?: { path: string }` cannot reproduce that byte, so the slot is
`artifact?: { path: string; key: string }`.

**A5 (commit 2) — `TurnCtx.command` dropped.** With flags leaving through the injected `onFlag`
(which the callers bind with their own `command` + `topic`), nothing inside `awaitTurn` reads a
command. Keeping the field would have been a second, unread copy of what `onFlag` already carries.

**A6 (commit 2) — the dep bag is `TurnDeps`, not `WaitDeps`.** `phaseTable.ts` already exports a
`WaitDeps` that `tests/helpers/phaseDeps.ts` and the design suites import; a second export under
that name in `wait.ts` would collide for every file importing both.

**A7 (commit 2) — the confirmation body sits in a private `confirmedTerminal`, not inlined.** The
spec said the 0.5.15 body "lives inside awaitTurn". It lives inside `wait.ts` as a private function
`awaitTurn` calls, which is what makes "preserved VERBATIM" checkable by eye: the body is the
0.5.15 body with `d.onVeto` renamed to `d.onFlag` and nothing else touched. It is no longer an
export, which is what the success criterion actually asks.

**A8 (commit 2) — the provider-scaled timeout is now computed before the missing-OFFSET check.**
`awaitTurn` takes `timeoutS` up front and owns the offset read, so `phaseWait` and implement's
turn-wait resolve their timeout one step earlier than the shipped order. Behaviorally invisible:
`consultTimeout`, `agentTimeoutMultiplier` and `envNum` are pure reads with no logging and no
writes, and the missing-OFFSET path still prints the same error and returns the same rc. The only
difference is that a run with no `OFFSET=` now reads `contracts.yaml` before failing.

**A9 (commit 2) — `phaseWait` reads its state file twice.** Once for the `<KEY>=skipped` fast-path
(which must precede the wait and stays with the caller), then once inside `awaitTurn` for the
offset. No output, state byte or rc changes; the alternative was to pass pre-read text in, which
would put offset resolution back with the callers — the thing this PR removes.

**A10 (commit 3) — `wait` becomes OPTIONAL in the dep bags instead of being deleted.** The spec
said to delete it outright. Ten shipped assertions observe the injected wait itself — its arguments
(`explore-cmd`'s per-row "the wait budget is contracts' X timeout, provider-scaled";
`implement-turn-cmd`'s `AP_IMPLEMENT_TURN_TIMEOUT_S=5 -> wait dep receives scaledTimeout(5,'1')`;
`quick-cmd`'s `expect(seen).toEqual([0, N])` for the re-armed offset; `turn-confirm`'s
`expect(w.calls[1]).toEqual({ off: …, to: 20 })`) or its call count (`expect(wait).not
.toHaveBeenCalled()` on the skipped and missing-state-file paths). With the field gone, every one of
them must be rewritten against a virtual clock over a real outbox — the assertion rewrite the PR's
own testing rule makes a STOP condition. Optional achieves what the success criterion actually
asks: all FOUR production `wait: liveOutboxWait` bindings are gone, awaitTurn's default IS the live
wait bound to the bag's clock, and `grep -rn "liveOutboxWait" src/` shows the definition plus ONE
binding. Tests that script a wait keep doing so, unchanged.

**A11 (commit 3) — `sleep` and `nowMs` are deleted, replaced by one `clock?`; implement's `now`
stays.** `ImplementWaitDeps` never had a `nowMs`: its `now()` returns epoch SECONDS and stamps the
question payload's `ASKED_AT=`, which is domain data, not a time source. It stays exactly as it was.

**A12 (commit 3) — the `Clock` type lives in `ipc.ts`, not `wait.ts`.** The Components list homed
it in `wait.ts`, but `wait.ts` imports `ipc.ts`, so `ipc.ts` defaulting its parameter to a
`wait.ts` value would be a runtime import cycle — the failure mode `artifact.ts`'s header already
records. The engine owns the seam it reads, and `wait.ts` imports `Clock`/`realClock` from it.

**A13 (commit 3) — `realSleep` is deleted, not homed.** Commit 1 moved it into `wait.ts` as the
spec asked; once the clock exists, all three of its consumers (turn.ts's window, phaseWait's grace,
`liveWaitDeps.sleep`) read `clock.sleep` instead, leaving it with no callers. Two sleep helpers for
one concept becomes one Clock, which was the point.

**A14 (commit 3) — the engine's extension math stays iteration-counted.** The spec said "its
private 1 s poll and the extension math both read that clock". The budget is a loop counter
(`for (let n = 0; n < capSec; n++)` with a 1 s sleep per turn), not a wall-clock deadline, so making
the cap read `now()` would CHANGE behavior: read time, poll latency and scheduler drift would start
counting against the budget. Only the sleep reads the clock. `now()` is on the interface because
awaitTurn's deadline needs it, and both layers must share one timeline.

**A15 (commit 3) — a FIFTH consumer of the injected wait, absent from the spec's table.** design's
`drilldownWith` calls `d.wait` directly with its OWN event list (`["done", "error"]` — drilldown
relays no questions) and no state-file offset, so it is not a turn wait and cannot route through
`awaitTurn`. It resolves its wait through the exported `boundWait(d)` instead, which is what keeps
the live binding singular; the spec's six-entry-point table missed it because it is a caller of
`outboxWaitSince`-via-deps rather than an entry point of its own.

**A16 (commit 3) — `wait-extend.test.ts` gains a virtual-clock block instead of being converted.**
The spec wanted it to "stop spending real seconds". Three of its five assertions bracket real wall
time (`elapsed >= 1900`, `< 2500`), so converting them is an assertion rewrite — and, more
importantly, that block is now the ONLY thing exercising the DEFAULT clock end to end: a
`realClock.sleep` that resolved immediately would spin every wait at 100% CPU and still pass every
virtual-clock test. The virtual block is added alongside, asserting the same budgets EXACTLY (in
virtual ms) rather than by bracket, plus the new `AP_WAIT_EXTEND_MULT` x deadline-floor interaction.
The file still costs its original ~10 s.

**A17 (success criteria) — "designTurn.ts is imported by design code only" is not reachable here.**
What this PR removes is the MICRO-PROTOCOL dependency: `implement.ts`, `quick.ts` and `bridge.ts`
no longer import `designTurn` at all. Two importers remain and are both pre-existing and
design-domain: `explore.ts` (which reuses design's `composeVerifyPrompt` for its own cross-verify
phase) and `phaseTable.ts` (which reads design's `researchState`/`verifyState` classifiers as row
slots for BOTH commands). Moving those is a different refactor with its own behavior surface, and
nothing in this PR touched them. The criterion is amended to the achieved, checkable form above.

**A18 (fix round) — the new default wiring needed its own pin.** Commit 3 replaced four point-free
`wait: liveOutboxWait` dep-bag literals with one hand-written lambda inside `boundWait`. That trades
a binding where an argument bug was structurally impossible for one where it is merely unlikely, and
the suite did not cover it: replacing the default with a thrower, or transposing its agent/model
arguments, both left the whole suite green, as did dropping the clock hand-off. `tests/wait-policy
.test.ts` now calls `awaitTurn` with `wait` UNSET and only a virtual clock bound, over a real temp
outbox whose `done` is scheduled in virtual time — one test that fails if the default is missing, if
the ids are transposed (it reads a directory that does not exist), or if the clock is not passed
down (the engine falls back to the real one and the scheduled event never fires).
