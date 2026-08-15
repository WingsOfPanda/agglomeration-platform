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
- `designTurn.ts` is imported by design code only.
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
