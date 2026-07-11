# Autoresearch campaign spine, phase A (from the adversary-tested explore handoff at /home/liupan/.ap/archive/b1eff9a5d0583c3642d98b5509b25f6d467600d8232aa6b20b7955db59c5ff29/make-ap-autoresearch/_explore-20260711T012250Z/design-handoff.md — read it plus the landscape doc it names as the research base): a durable, task-keyed, controller-generation-keyed campaign event ledger with an idempotent `resume` re-entry verb designed for scheduler-owned short cycles (restart IS the loop; event-triggered re-entry, not polling), closing the enumerated replay hazards (dispatch inboxWrite-before-state window, unreconstructible exp_counter, un-keyed completion events) with crash-injection tests as acceptance criteria; plus the three cheap verified wirings — negative-lesson mapping (one-line lessonVerdictOf change), governed corpus bridge for ~/.ap/archive + ~/.ap/forensics into advisor context, and operator-set enrichment (ablate/replicate/literature-refresh, already reserved in the lesson enum). Explicitly OUT of scope (successor specs per the handoff constraints): campaign-local evidence tier + typed child-question recursion DAG, metric epochs (no authorization mechanism yet — run-boundary --seed-from chaining stays the answer), reliability-winner wiring (blocked on a validated signal producer), autonomous online re-grounding (blocked on a literature gate). Constraints: fully autonomous per-trial loop; frozen wire protocol untouched; plateau-chronology repair lands WITH the ledger (needs globally sequenced completions); the fresh-worker verb is the existing respawn primitive (gap is adoption/leasing); tests pure with fresh AP_HOME; dist rebuilt + committed.

## Problem

`/ap:autoresearch` cannot survive a hub restart: the campaign loop lives in the hub's context, `init`
refuses an in-flight topic (src/commands/autoresearch.ts:141-143), no resume verb exists in the
dispatcher, and the submit hook is a no-op reserved for exactly this (src/commands/hook.ts:1-2).
Worse, the on-disk state is not replay-safe even if a resume path existed — the adversary-tested
explore run (archived handoff: /home/liupan/.ap/archive/b1eff9a5d0583c3642d98b5509b25f6d467600d8232aa6b20b7955db59c5ff29/make-ap-autoresearch/_explore-20260711T012250Z/design-handoff.md)
enumerated the concrete hazards: dispatch writes the worker inbox BEFORE the `state.txt` transition
(src/commands/autoresearch.ts:656-659 — a crash between them double-delivers on replay), the
`exp_counter` lives only in that same late state write (src/core/autoresearchExperiment.ts:117-124),
and completion reconciliation scans an outbox tail for ANY `done`/`error` with no tie to a specific
experiment (src/core/autoresearchState.ts:38-51). Separately, three cheap verified wirings sit
unused: the finalizer maps only positive A1/C1 verdicts although `"negative"` lessons are
single-run-promotable (src/core/autoresearchLessonMap.ts:43-47 vs src/core/autoresearchMemory.ts:357-360),
the durable `~/.ap/archive` + `~/.ap/forensics` corpus is never queried by dispatch, and the
`ablate`/`replicate` operators are reserved in the lesson enum (src/core/autoresearchMemory.ts:36)
but absent from the dispatch vocabulary.

## Goal

After this change an autoresearch campaign is durable: every dispatch, delivery, completion, budget
debit, and stop decision is an event in an append-only, task-keyed, controller-generation-keyed
campaign ledger, the dispatch path is replay-safe (intent recorded before any effect; delivery
recorded with the worker's outbox offset so completions are scoped to their experiment without
touching the frozen wire protocol), and an idempotent `autoresearch resume <topic>` verb re-enters
any interrupted campaign — acquiring a fenced controller generation, replaying the ledger,
reconciling every worker from its dispatch-time outbox offset, respawning dead panes via the
existing `fresh-worker` primitive, and telling the directive which Monitors to re-seed. This is the
substrate the explore run's operating-model decision requires: it makes restart safe TODAY as the
crash-recovery path, and it is deliberately shaped so the successor spec can flip the directive to
scheduler-owned short cycles (where every cycle enters through `resume`) without reworking the
ledger. The plateau-chronology limitation is repaired as a rider — the ledger finally provides the
globally sequenced completion order `checkPlateau` lacks. The three cheap wirings land alongside:
negative lessons (one mapping change), a governed read-only corpus digest of prior campaigns into
advisor context, and the `ablate`/`replicate` dispatch operators. Explicitly OUT of scope, per the
handoff's own constraints: the campaign-local evidence tier and child-question recursion DAG
(successor spec), metric epochs (no authorization mechanism — `--seed-from` run-boundary chaining
stays the answer), reliability-winner wiring (blocked on a validated signal producer),
autonomous online re-grounding and the `literature-refresh` operator (blocked on a literature gate).
The fully-autonomous per-trial loop and the frozen wire protocol are untouched.

## Architecture

Four parts: the ledger (foundation), the resume verb (consumer), the plateau-chronology rider, and
the three cheap wirings. Everything is additive — new files follow existing conventions, no frozen
event names / sentinel / state filenames / contracts.yaml keys change, and old campaigns without a
ledger keep today's behavior (every new consumer falls back when `campaign-ledger.jsonl` is absent).

### 1. Campaign event ledger

New pure module `src/core/autoresearchLedger.ts` + the file `$ART/campaign-ledger.jsonl`
(append-only JSONL; single-line `appendFileSync` writes, the same durability idiom as
`recordWaitOutcome`'s state appends in src/core/designTurn.ts:56-68):

- Event shape: `{ seq, gen, ts, kind, agent?, exp_id?, data? }`. `seq` is a monotonically
  increasing integer (last seq + 1 at append); `gen` is the controller generation (below);
  `kind` is a NEW enum, deliberately outside the frozen wire vocabulary:
  `campaign-init | dispatch-intent | dispatch-delivered | result-recorded | verify-recorded |
  budget-debit | stop-decision | resume | fresh-worker-respawn | interrupted`.
- Module API (pure; CLI does the I/O like every other core module):
  `appendEvent(prevText, event)` → the new line to append (validates seq/gen monotonicity),
  `replayLedger(text)` → `{ lastSeq, gen, intents: Map<exp_id, {agent, delivered, outboxOffset?}>,
  completionOrder: exp_id[], counters: Map<agent, number> }` — the reducer every consumer shares,
  `parseLedger(text)` (tolerant line parse, skips malformed).
- **Controller lease + fencing:** `$ART/controller.gen` holds the current generation KV
  (`gen=<n>`, `acquired_ts=`, `holder=`), written via `atomicWrite`. `resume` increments it;
  `campaign-init` (written by `init`) starts it at 1. Every appended event carries the writer's
  gen; `replayLedger` exposes the highest `resume`/`campaign-init` gen, and dispatch verbs re-read
  `controller.gen` before sending — a writer holding a stale gen refuses with rc 3 (a loud error,
  never a silent clobber). This is the fencing the explore handoff's Temporal-style design calls for.

### 2. Replay-safe dispatch (closing the enumerated hazards)

`experiment-send` (src/commands/autoresearch.ts:640-670) changes its effect order:

1. Append `dispatch-intent { agent, exp_id, gen }` — BEFORE any effect. The exp_id is minted as
   today (worker `exp_counter` + 1) but the intent is now the durable record;
   `replayLedger().counters` takes `max(state.txt exp_counter, highest intent number per agent)`,
   which makes the counter reconstructible (hazard 2 closed).
2. Write `prompt.md`, then `inboxWrite`, then the `state.txt` transition — exactly today's calls.
3. Append `dispatch-delivered { agent, exp_id, outboxOffset }` where `outboxOffset` is
   `outboxOffset(outboxPath(agent, ...))` captured immediately before the inbox write — the same
   offset idiom design/explore already use. Because completions are now scoped "events after THIS
   dispatch's offset", the un-keyed `done`/`error` hazard is closed WITHOUT adding any field to the
   frozen wire events (hazard 3): `reconcileFromOutbox` gains an optional pre-sliced tail — the
   caller slices the outbox from the recorded offset (a new
   `reconcileFromOutboxSince(outboxText, offset, doneResultExists)` wrapper in
   src/core/autoresearchState.ts keeps the existing function byte-identical for old callers).
4. An intent WITHOUT a matching delivered event is the crash signature of the old
   inboxWrite-before-state window (hazard 1): resume resolves it deterministically — if the
   worker's outbox since the intent shows `ack`/`done` for work it accepted, treat as delivered
   (append the missing `dispatch-delivered` with the reconstructed offset); else if the worker is
   not `phase=working`, RE-DISPATCH THE SAME `exp_id` (the idempotency key is `(topic, agent,
   exp_id)`; never mint a new id for an unresolved intent).

The monitor/score path appends `result-recorded { agent, exp_id, seq }` when it observes
`result.json` for an experiment (wired where `computeScore`'s caller already walks results —
best-effort, and `resume` backfills missing `result-recorded` events during replay by walking
branch dirs, so the ledger converges even if a monitor died mid-campaign).

### 3. `resume <topic>` — idempotent re-entry

New verb in the dispatcher switch (src/commands/autoresearch.ts:1993-2020 region), DI-injected like
`freshWorkerWith`:

1. Refuse if no art dir / no ledger (`rc 1` — nothing to resume; `init` remains the creation path
   and keeps refusing in-flight topics: the two verbs partition the lifecycle).
2. Acquire the lease: read `controller.gen`, increment, `atomicWrite`, append
   `resume { gen }`. Idempotent: running resume twice simply takes another generation; stale
   holders are fenced by §1.
3. Replay: `replayLedger` + per-worker reconciliation — read `workers.txt`, for each worker read
   `state.txt`, pane liveness (`paneMetaRead` + `paneAlive`), and the outbox since the last
   `dispatch-delivered.outboxOffset`; apply `reconcileFromOutboxSince` (error → failed; done +
   result.json → idle; done without result → no write, exactly today's rule). Backfill
   `result-recorded` events for any result.json not yet in the ledger.
4. Unresolved intents: resolve per §2.4 (append `dispatch-delivered` or re-dispatch same exp_id —
   re-dispatch happens by PRINTING a `REDISPATCH=<agent>:<exp_id>` line for the directive to act
   on, keeping the verb side-effect-bounded).
5. Dead panes: `phase != working` → invoke the existing `fresh-worker` respawn path
   (src/commands/autoresearch.ts:1725-1763; it already preserves `exp_counter` and refuses
   mid-experiment); `phase = working` + dead pane → append `interrupted { agent, exp_id }`, reset
   the worker state to idle (the experiment's intent stays unresolved → re-dispatch rule applies).
6. Output (stdout, machine-parsed): `GEN=<n>`, one `WORKER=<agent>:<phase>:<pane-alive>` per row,
   `REDISPATCH=` lines, `MONITOR=<agent>` lines (the directive re-seeds one harness Monitor task
   per line — verbs cannot create harness tasks), `LAST_SEQ=<n>`.

**Directive (commands/autoresearch.md):** Step 0 gains the re-entry branch — art dir exists with a
ledger → run `resume`, re-seed the printed Monitors, act on `REDISPATCH=` lines, and continue the
loop from Step 5; `init`'s in-flight refusal message now points at `resume`. The loop body is
otherwise unchanged in this phase: full scheduler-owned cycling (each loop iteration a fresh
process entering through resume, event-triggered re-entry wiring) is the successor spec — this
phase ships the substrate that makes it a directive-only change later, per the handoff's
operating-model decision.

### 4. Plateau-chronology rider

`checkPlateau`'s window currently slices the best-metric-first scoreboard
(src/core/autoresearchComplete.ts:93-98) — ranked rows, not recent ones (bounded today by the
conjunctive B1 gate, adjudicated 2026-07-06). With the ledger, chronology exists:
`replayLedger().completionOrder` is the globally sequenced completion list. `checkPlateau` gains an
optional `completionOrder?: string[]` parameter — when present, the plateau window is the metrics
of the LAST N exp_ids in completion order; when absent (old campaigns, no ledger), behavior is
byte-identical to today. The B1 conjuncts (`familiesActive >= minFamilies`,
`familiesImproving === 0`) are untouched.

### 5. Cheap verified wirings

- **Negative lessons** (one mapping): `lessonVerdictOf` (src/core/autoresearchLessonMap.ts:43-47)
  additionally returns `"negative"` for `a1 === "mismatch"` or `c1 === "not-reproduced"`.
  `"negative"` is already a first-class `LessonVerdict` (src/core/autoresearchMemory.ts:15) and is
  single-run-promotable by design (`promotable`, src/core/autoresearchMemory.ts:357-360). A1
  `infeasible`/`unverified` still map to null — INFEASIBLE is "couldn't execute", not evidence
  (the repo's own doctrine, commands/autoresearch.md:316-325).
- **Corpus digest** (read-only, governed): new pure module `src/core/autoresearchCorpus.ts` —
  `buildCorpusDigest(entries, opts)` renders a capped (default 5), DATA-ONLY block of prior
  same-metric-family campaign outcomes: one line per archived campaign (topic slug, final leader
  metric, verified-lesson count, halt reason), each line passed through the same
  injection-denylist scrub the lesson path applies (reuse the scrub from
  src/core/autoresearchMemory.ts:77-115); plus a new hub verb `corpus-digest <topic>` that walks
  `~/.ap/archive/<repo-hash>/` + `~/.ap/forensics/` for autoresearch artifacts, builds entries,
  prints the block to stdout, and writes `$ART/corpus-digest.md`. The directive's Step 5 advisor
  context includes that block alongside `memory-retrieve` output. Strictly read-only: nothing under
  `~/.ap/archive` or `~/.ap/forensics` is ever written by this path, and the digest never feeds a
  gate — it is advisor context, exactly like lessons.
- **Operators** (`ablate`, `replicate`): `experiment-send` gains an optional `--operator
  <draft|improve|ablate|replicate>` flag (default preserves today's behavior), recorded in the
  dispatch-intent event, the branch dir (`operator.txt`), and the finalize-time lesson draft's
  `operator` field (values already reserved, src/core/autoresearchMemory.ts:36). The directive's
  Step 5 dispatch menu defines the two new operators: **Ablate** — remove/disable exactly one
  component of the current leader config to attribute its contribution (single-variable, like
  Improve but subtractive); **Replicate** — re-run a leader config unchanged with a different seed
  to produce reliability evidence (feeds the future reliability-winner spec; distinct from A1,
  which re-runs to VERIFY a reported number, not to sample variance). `literature-refresh` remains
  reserved and unwired (blocked on the literature gate, out of scope).

### Invariants

- Frozen wire protocol untouched: no new outbox event names, no new fields on wire events, no
  state-filename renames; ledger event kinds are a new, non-wire vocabulary; `campaign-ledger.jsonl`,
  `controller.gen`, `corpus-digest.md`, `operator.txt` are new files.
- Old campaigns (no ledger) run exactly as today: every consumer (checkPlateau, reconcile wrapper,
  resume) is fallback-guarded.
- Fully-autonomous per-trial loop preserved: resume/redispatch decisions are mechanical rules, not
  user prompts.
- Errors to stderr; stdout stays machine-parsed (`GEN=`/`WORKER=`/`REDISPATCH=`/`MONITOR=`/`LAST_SEQ=`).
- `dist/ap.cjs` rebuilt (`npm run build`) and committed — stale-dist CI gate green.

## Components

- `src/core/autoresearchLedger.ts` — NEW pure module: event types
  (`campaign-init|dispatch-intent|dispatch-delivered|result-recorded|verify-recorded|budget-debit|stop-decision|resume|fresh-worker-respawn|interrupted`),
  `appendEvent(prevText, event)` (seq/gen monotonicity validation), `parseLedger(text)` (tolerant),
  `replayLedger(text)` → `{ lastSeq, gen, intents, completionOrder, counters }`, and
  `readGen(text)`/`renderGen(kv)` for `controller.gen`.
- `src/commands/autoresearch.ts` — `experiment-send` effect order per Architecture §2
  (intent append → prompt/inbox/state → delivered append with pre-captured outbox offset; stale-gen
  refusal rc 3; optional `--operator` flag recorded in intent + `operator.txt`); NEW `resume` verb
  (DI-injected `resumeWith`: lease bump, replay, per-worker reconcile from recorded offsets,
  result-recorded backfill, unresolved-intent resolution printing `REDISPATCH=`, dead-pane handling
  via the existing fresh-worker path, `GEN=/WORKER=/MONITOR=/LAST_SEQ=` stdout); NEW `corpus-digest`
  verb (walks `~/.ap/archive/<repo-hash>/` + `~/.ap/forensics/` read-only, builds entries, writes
  `$ART/corpus-digest.md`, prints the block); dispatcher switch + usage extended; `init` writes the
  `campaign-init` ledger event + `controller.gen` (gen=1) and its in-flight error message points at
  `resume`.
- `src/core/autoresearchState.ts` — NEW `reconcileFromOutboxSince(outboxText, offset,
  doneResultExists)` wrapper (slices then delegates); existing `reconcileFromOutbox` byte-identical.
- `src/core/autoresearchExperiment.ts` — `buildDispatchState` unchanged; export a
  `nextExpId(stateText, ledgerCounters)` helper that takes `max(state exp_counter, ledger intent
  max)` so the counter is reconstructible.
- `src/core/autoresearchComplete.ts` — `checkPlateau` gains optional `completionOrder?: string[]`;
  when present the plateau window is the last-N metrics in completion order; conjunctive B1 gate
  and all thresholds unchanged; absent → byte-identical behavior.
- `src/core/autoresearchLessonMap.ts` — `lessonVerdictOf` additionally maps `a1 === "mismatch"` or
  `c1 === "not-reproduced"` → `"negative"`; `infeasible`/`unverified`/absent still → null.
- `src/core/autoresearchCorpus.ts` — NEW pure module: `CorpusEntry` type,
  `buildCorpusDigest(entries, { cap = 5 })` (data-only lines, injection-denylist scrub reused from
  the memory path, same-metric-family filter).
- `commands/autoresearch.md` — Step 0 re-entry branch (art dir + ledger present → `resume`, re-seed
  printed `MONITOR=` rows as harness Monitor tasks, act on `REDISPATCH=` rows, continue at Step 5);
  Step 5 advisor context adds the `corpus-digest` block; Step 5 dispatch menu adds the Ablate and
  Replicate operator definitions (with the A1-vs-Replicate distinction); a note that
  `literature-refresh` stays reserved pending the literature gate; successor-spec pointer for
  scheduler-owned cycling.
- `src/commands/hook.ts` — comment updated only (the no-op stays; its reservation note now points
  at the shipped `resume` verb).
- `tests/autoresearch-ledger.test.ts` — NEW: appendEvent monotonicity, parseLedger tolerance,
  replayLedger reducer (intents/delivered pairing, completionOrder, counter max rule), gen
  read/render round-trip.
- `tests/autoresearch-resume.test.ts` — NEW: the crash-injection matrix (see Testing) driven
  through `resumeWith` with DI spies.
- `tests/autoresearch-cmd.test.ts` / existing autoresearch test files — extended: experiment-send
  effect order (ledger intent exists even when a DI-injected inboxWrite throws), stale-gen rc 3,
  `--operator` recording; corpus-digest verb (seeded fake archive/forensics trees → expected block,
  cap, scrub); checkPlateau with/without completionOrder; lessonVerdictOf negative rows.
- `dist/ap.cjs` — rebuilt via `npm run build` and committed (stale-dist CI gate).

## Testing

Pure unit tests only, fresh `AP_HOME` per test (tests/helpers/tmpHome.ts); no live panes, no tmux.
**Crash-injection is the acceptance criterion** for the ledger + resume (the handoff's explicit
requirement): every write/effect boundary in the dispatch path gets a test that kills the sequence
at that point (DI-injected step that throws) and asserts `resumeWith` recovers to a safe state.

- `tests/autoresearch-ledger.test.ts` —
  - appendEvent: seq strictly increments; stale gen rejected; malformed prev lines tolerated.
  - replayLedger: intent+delivered pairing; intent-without-delivered surfaces in `intents` as
    undelivered; completionOrder reflects result-recorded seq order; counters = max(state, intents)
    rule via `nextExpId`.
- `tests/autoresearch-resume.test.ts` — the crash matrix, each case seeding an art dir + ledger +
  worker state mid-crash, then asserting the resume outcome:
  1. Crash AFTER `dispatch-intent`, BEFORE inbox write → resume prints `REDISPATCH=<agent>:<exp_id>`
     with the SAME exp_id; no new id minted; counter unchanged after replay.
  2. Crash AFTER inbox write, BEFORE state.txt (the historical hazard window) → worker outbox shows
     `ack` → resume appends the missing `dispatch-delivered` and does NOT redispatch.
  3. Crash AFTER delivery, worker finished while hub was dead (outbox `done` + result.json since
     the recorded offset) → resume backfills `result-recorded`, state reconciles to idle.
  4. Same as (3) but `done` WITHOUT result.json → no state write (today's reconcile rule held).
  5. An OLD `done` event BEFORE the recorded dispatch offset + no new events → NOT treated as this
     experiment's completion (the un-keyed-completion hazard, now closed by offset scoping).
  6. Dead pane + `phase=working` → `interrupted` appended, state reset idle, intent unresolved →
     `REDISPATCH=` printed.
  7. Double resume → gen increments twice, second replay is a no-op on state (idempotence).
  8. Stale-gen dispatch: `experiment-send` under gen 1 after a resume bumped to gen 2 → rc 3,
     no inbox write (DI spy not called).
- experiment-send effect order (extended in the existing cmd suite): DI-injected inboxWrite that
  throws → ledger contains the intent, no delivered event, state.txt untouched; happy path →
  intent.seq < delivered.seq and delivered.outboxOffset equals the pre-send offset.
- checkPlateau rider: same scoreboard, shuffled completionOrder → window follows completion order;
  `completionOrder` absent → result byte-identical to today's (regression pin over existing fixtures);
  B1 conjuncts still veto plateau while a family improves.
- lessonVerdictOf: (`mismatch`, —) → `negative`; (—, `not-reproduced`) → `negative`;
  (`infeasible`, —) → null; (`unverified`, —) → null; positives unchanged; and an integration
  assertion that a `negative` lesson is `promotable` on a single run (existing memory tests extended).
- corpus-digest: seeded fake `~/.ap/archive/<hash>/<topic>/` + forensics trees → block contains one
  data-only line per campaign, cap enforced, injection-denylist strings scrubbed, different
  metric-family entries excluded; verb writes `$ART/corpus-digest.md` and never writes under the
  corpus roots (spy on write paths).
- Operators: `--operator ablate` recorded in intent + `operator.txt` + lesson draft; invalid
  operator → rc 2; default (no flag) byte-identical to today.
- `tests/stale-tokens.test.ts` green; full gate before PR:
  `npm run typecheck && npm run lint && npm run test && npm run build` with the refreshed
  `dist/ap.cjs` committed (CI stale-dist byte-compare green).
- Live dogfood (post-merge, user-driven): start a small autoresearch campaign, kill the hub
  mid-experiment, `resume` from a fresh session, and confirm the campaign completes with the ledger
  showing the interruption and recovery events.

## Success Criteria

- Full gate green (`typecheck`/`lint`/`test`/`build`) with the new suites; CI stale-dist
  byte-compare passes on the committed `dist/ap.cjs`.
- The crash-injection matrix (all 8 cases in Testing) passes — this is the acceptance bar the
  explore adversary set: no case double-delivers an experiment, loses an exp_counter value, or
  claims an old `done` event for a new experiment.
- `resume` is idempotent and fenced: double-resume is a state no-op with a gen bump; a stale-gen
  `experiment-send` refuses with rc 3 and provably sends nothing (DI spy).
- Replay-safety is structural, not procedural: the ONLY dispatch path writes intent-before-effect
  and delivered-with-offset (grep: no `inboxWrite` call in the autoresearch dispatch path outside
  the ledgered sequence).
- Old campaigns unaffected: with no `campaign-ledger.jsonl`, `checkPlateau`, reconciliation, and
  the directive loop behave byte-identically (pinned by regression tests over existing fixtures).
- `lessonVerdictOf("mismatch", undefined)` and `lessonVerdictOf(undefined, "not-reproduced")`
  return `"negative"`, and such lessons are promotable on a single run; INFEASIBLE still yields no
  lesson.
- `corpus-digest` output is data-only (scrubbed), capped, same-metric-family filtered, and the verb
  performs zero writes under `~/.ap/archive` / `~/.ap/forensics` (write-path spy).
- The dispatch vocabulary accepts `--operator ablate|replicate` end-to-end (intent event →
  `operator.txt` → finalize lesson draft), while `literature-refresh` remains rejected/unwired.
- Frozen-protocol audit: no changes to wire event names, `END_OF_INSTRUCTION`, existing state
  filenames, or `contracts.yaml`; new files only (`campaign-ledger.jsonl`, `controller.gen`,
  `corpus-digest.md`, `operator.txt`); `tests/stale-tokens.test.ts` green.
- The directive's Step 0 re-entry branch is present and the loop body is otherwise unchanged
  (scheduler-owned cycling remains a documented successor spec, not partially shipped).

