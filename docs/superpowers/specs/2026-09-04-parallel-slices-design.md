# Parallel slices: a detached `/ap:implement` run fans a plan out to N workers — design

**Date:** 2026-09-04
**Version:** three PRs from 0.5.70 (0.5.69 is reserved for the `.ap-provision` PR)
**Scope:** `commands/implement.md` (a new Stage 1P between Stage 1.1 and Stage 2, one Stage 0 strip,
one dispatch refusal, Stage 2/3 reading rules), six new `implement` verbs plus named lead turns and
an `--agent` extension of `turn-send` / `turn-wait`, a third worker role `slice`, one optional
`pane.json` field, per-slice `job status` rows, a slice sweep in `job stop`, and — as its own PR — a
premature-`done` hold in implement's turn wait. **No new operator flag; the job layer's launch surface
is unchanged. Wire protocol untouched.**
**Provenance:** issue #217 (2026-09-03) and its follow-up comment, filed from a 22-hour single-worker
detached run of a 7-work-package design doc. Derived from a read of the shipped code at `363f9d2`
(0.5.68), then challenged by two rounds of adversarial review against that code (2026-09-04: four
lenses, then two on the revised text; 3 blockers, 28 defects and 11 risks upheld and folded in —
the revision notes below say where). One operator direction is settled (2026-09-04): **the operator
does not choose the worker count** — the first draft's `--workers N` flag is gone; the orchestrator
decides the split from the plan, grilling the lead when the check refuses its grouping (D11). Every
other decision in the table is a RECOMMENDATION for the operator to confirm or flip before PR 1
starts.

## Problem

In detached mode `/ap:implement` runs ONE worker (`lead`, src/commands/implement.ts:34) serially
through the whole design doc. For a doc with several mostly file-disjoint work packages, wall-clock
is the SUM of the packages. The run behind #217 (ap 0.5.61, codex worker, `--detached`):

| Phase | Wall time |
|---|---|
| contract negotiation before code (4 objections) | 1.5 h |
| WP1 new gate kind | 2.0 h |
| WP2 shard schema | 1.5 h |
| WP3 generator script + manifest + trainer config | 4.7 h |
| WP4 new training target | 5.5 h |
| WP5 feature planes + model projection | 3.2 h |
| WP6 loss + freeze + schedule | 4 h+ |
| WP7 + self-verify + cross-verify | pending at 22 h |

WP2–WP7 touched mostly disjoint files and WP1 was their prerequisite. Under the design below the
same run is: negotiation folded into a short plan turn, WP1 as a serial prelude (2.0 h), the slices
concurrently (bounded by WP4, 5.5 h), integration, one hub suite run, and one lead turn for whatever
the slices left — roughly 11–13 h against 22 h+. The gain is the sum-to-max collapse of WP2–WP7; the
serial prelude and the integration turn are what keep it from being 6–8 h.

The same run PARKED twice on a second, independent defect: the worker emitted `done` after each
plan task. The turn wait's 20 s quiet window (`AP_TURN_CONFIRM_S`, src/core/wait.ts:91, clamped
5..120) accepted the per-task `done` as the turn's end, `verify-report-1.md` did not exist yet, so
`implementState` (src/core/implementTurn.ts:14) classified `TS=failed`; the one auto-retry re-sent
the round-1 prompt into a worker that was still implementing — the send gate cannot refuse it,
because `done` is a terminal worker state (`TERMINAL_WORKER_STATES`, src/core/ipc.ts) — and the
second such `done` parked the job 24 h in with WP7 still pending. A "single-done contract" reminder
in the retry prompt did not change the worker's habit.

Everything the fan-out needs already exists as a per-agent primitive: `spawn` places a worker in
its own window of a detached session (src/commands/spawn.ts:300), `awaitTurn` waits on ONE agent's
outbox (src/core/wait.ts:296), `workerSendGate` / `recordWaitOutcome` / `resolveModel` are all
agent-keyed, `pickAgents` hands out N distinct call-signs (src/core/agents.ts:55), the phase table's
`waitGateVerb` is a roster-wide barrier, `job start` forks a worktree per run
(src/commands/job.ts:217), and the round-1 prompt already makes the lead write a task-by-task plan
before it implements (src/core/implementTurn.ts:85, PHASE 1). What is missing is the fan-out /
fan-in inside `implement`, whose verbs close over the one constant `WORKER = "lead"`, keep one
`plan.md` / `verify-report-<round>.md` per topic, one `provider.txt`, one `target_cwd.txt`, one
branch (`branchNameFor`, src/core/branchRecord.ts:10) — and a job layer whose worker-death probe
ends the whole job on the FIRST dead worker (src/commands/job.ts:555).

## Goal

1. `/ap:implement <doc> --detached` plans first and, when the plan splits, runs the slices
   concurrently — each slice worker in its own worktree and branch on a file-disjoint set of the
   plan's tasks — then integrates the slices into the run's `feat/implement-<topic>` branch, absorbs
   whatever the slices left in one lead turn, and runs the existing Stage 2 verify → Stage 3 fix
   loop on the integrated tree exactly as today. The operator picks nothing: the lead proposes the
   split in its plan, the job hub decides it, a verb checks it, and a bounded grill turn resolves
   what the check refuses. A slice that fails, dies, or conflicts never ends the job.
2. The attached path is byte-identical to 0.5.68 in every verb, file name, prompt and directive
   step — test-asserted. A detached run whose plan does not split is 0.5.68 plus one plan turn,
   whose `plan.md` the serial round 1 then reuses.
3. A per-task `done` no longer parks a run: implement's turn wait HOLDS a report-less `done` while
   the worker's pane is still active, and the round-1 / fix prompts say in one line where the single
   `done` belongs. No new event name.

## Decisions (recommended — confirm or flip before PR 1)

| # | Decision | Alternative rejected | Why |
|---|---|---|---|
| D1 | **`implement` only.** `quick` is a non-goal for this program. | #217 names both. | `quick` has no plan to slice on; its brief is hub-authored prose and its turn is typically minutes. A parallel `quick` is a second file layout (`roundProtocol` descriptor keyed by round only, src/core/roundProtocol.ts) for a fraction of the benefit. Revisit after a dogfood shows demand. |
| D2 | **Detached only.** Stage 1P is part of every job-hub run; attached runs are untouched. | Attached fan-out with split panes. | The detached session already gives each worker its own window (src/commands/spawn.ts:300); attached placement splits the operator's window and `preflight` caps splits at 4. The unattended run is where the wall-clock matters. |
| D3 | **The lead plans and proposes the split, the hub decides it, a verb checks it, one grill turn resolves refusals.** A short plan-only lead turn writes `plan.md` with machine-readable tasks (files, dependencies) and a `## Slices` proposal. The hub writes the decided grouping to `slice-plan.md`; `implement slice-check` refuses an unassigned task, a cross-slice dependency, a shared file, or too many slices; a refusal earns ONE grill turn in which the lead re-cuts its tasks against the refusal lines. | The hub partitions the design's `## Components` directly; the operator writes `--slices` or `--workers`; `/ap:design` emits a Slices section. | `/ap:design` docs carry a FLAT per-file Components list and no package structure (commands/design.md), so a hub partition of Components is hub-invented grouping — the class of input memory records as the top falsified one. The plan is worker-authored, names files per task and dependencies between tasks, and the serial pipeline already pays for it in round 1; the plan-only turn just moves it before the fan-out. *(Revision: replaces the Components-based partition the first draft had; the draft's "no shared directory prefix" rule would have left almost every real doc with one slice.)* |
| D4 | **One fan-out wave, with an optional serial PRELUDE.** Tasks that other tasks depend on go in the prelude; `lead` implements it first in the run worktree; slices branch from its result. | A dependency DAG / waves. | The evidence run had exactly one prerequisite package; two waves cover it. More is YAGNI until a dogfood shows a plan that needs it. |
| D5 | **One worktree and one branch per slice**, `<root>/.ap/worktrees/<topic>.<agent>` on `feat/implement-<topic>-<agent>`, born at the run branch's HEAD. | N workers in the run worktree with path mandates. | Two `git add -A` sites sweep the whole tree (`preSnapshot`, src/core/gitwork.ts; `postSweep`, src/commands/implement.ts): N agents in one index would commit each other's half-written files. Per-slice trees keep every commit attributable. |
| D6 | **Integration is N merges into `feat/implement-<topic>` by a verb; conflicts are recorded, never resolved by the verb.** | Rebase slices; the hub resolves conflicts itself. | Merges never rewrite worker commits. Resolution is model judgment and belongs in a worker turn (the absorb turn, D8), not in a verb and not in the hub pane. |
| D7 | **Rounds ≥ 2 stay serial and lead-only.** After integration the slice workers are stopped; the fix loop runs in the run worktree with `lead`, exactly as today. | Per-slice fix rounds. | A fix for an integration failure needs the integrated tree, which no slice worktree has. Keeping rounds ≥ 2 untouched keeps the serial path byte-identical and the directive diff small. |
| D8 | **What the slices leave is absorbed in ONE named lead turn before Stage 2**, never in a fix round and never by a park at abandon time. Abandoned tasks, conflicting branches, and out-of-slice changes are that turn's brief. | Absorb into the fix loop; park on any slice failure. | A fix round has no planning phase and a 4 h base budget; a whole package in it overruns and then parks anyway, with the fix budget spent. A park at abandon time throws away N−1 finished slices. One build-shaped turn on the integrated tree, with the plan in hand, is the shape round 1 already has. *(Revision: the draft absorbed into the fix loop.)* |
| D9 | **A dead slice worker is not a job death.** `pane.json` gains an optional `role`; `job wait`'s death probe ignores `role: "slice"`. | Teach `job` about `slices.tsv`. | The probe is per-agent already (src/core/workerLiveness.ts:65); a per-agent field on the record it already reads keeps `job` ignorant of `implement`'s files. |
| D10 | **Premature `done` is held on pane activity, not on outbox silence.** A `done` without the turn's verify report re-arms the wait; the hold ends `failed` only after the worker's pane content has been unchanged for `AP_IMPLEMENT_PREMATURE_DONE_S` (default 1800 s), or on a later terminal event, or at the turn deadline. | Raise `AP_TURN_CONFIRM_S`; a 30-min outbox-quiet window; a plain hold to the deadline; a new `task_done` event. | A 30-min sleep after EVERY `done` slows every turn; outbox silence is normal for a codex worker mid-task (the 32-min single-file change in #217 was silent). A plain hold cannot end early on a stopped worker, because the engine extends a wait 3× while the pane is alive (src/core/ipc.ts, `extendMult`): a worker idling at its prompt would hold 12 h. Pane content is independent of worker discipline, which is what failed. `task_done` is a wire-vocabulary change the frozen protocol exists to avoid; the report IS the completion evidence. |
| D11 | **No operator knob.** The slice count is whatever grouping the hub decides and the check accepts, bounded by a code constant `MAX_SLICES = 6` (src/core/implementSlices.ts); fewer than two slices is the serial path. No flag, no env var, no brief line. | `--workers N` at launch (the first draft); an env ceiling per box. | Operator direction, 2026-09-04: the operator should not be choosing N — the plan knows how the work splits and the orchestrator is the one reading it. The ceiling is a constant because a per-box env var is still the operator choosing; six is where a detached session's windows, the box's codex processes and the disk for seven worktrees stop being free, and it moves by a code change with a dogfood behind it. |
| D12 | **Slices are spawned one at a time, and a slice whose codex spawn dies twice is respawned with claude.** | `Promise.all` over N spawns; abandon on a second spawn death. | `config/contracts.yaml` records the failure mode: many codex workers spawning at once on a loaded box never emit `ready` in time. Sequential spawns are ≤ 170 s each — 17 min worst case for six, against a multi-hour run. The per-slice fallback is the platform's own doctrine (docs/superpowers/specs/2026-08-30-provider-fallback-design.md) applied per worker; `resolveModel` (src/core/ipc.ts:427) already finds a worker's model from its dir, so mixed providers cost the turn verbs nothing. *(Revision: the draft spawned in parallel and abandoned.)* |

## Architecture

### A. Shape of a parallel run

```
job start --command implement ...                     (origin hub; exactly as today)
  worktree  <root>/.ap/worktrees/<topic>              on base/<topic>          (as today)
  session   ap-<topic>: window 0 job hub              (as today)

job hub runs commands/implement.md:
  Stage 0     init --target <worktree>, pre-snapshot, branch feat/implement-<topic>   (as today)
  Stage 1.1   spawn lead in the run worktree                                          (as today)
  Stage 1P    -- new, part of EVERY job-hub run (`ap job mode` prints DETACHED=1) --
    1P.0  plan turn:      `turn-send <topic> plan` -> lead writes plan.md (tasks, files, deps,
                          and a ## Slices proposal)
    1P.1  slice plan:     hub decides the grouping from the proposal, writes $ART/slice-plan.md;
                          `implement slice-check` -> slices.tsv, slice-<agent>.md; a refusal ->
                          ONE grill turn (`turn-send <topic> grill`), lead re-cuts plan.md, re-check;
                          fewer than two slices -> serial round 1 as written
    1P.2  prelude turn:   `turn-send <topic> prelude` -> lead implements the prelude tasks
    1P.3  spawn-slices:   per slice a worktree <root>/.ap/worktrees/<topic>.<agent> on
                          feat/implement-<topic>-<agent> at the run branch's HEAD, a window in
                          ap-<topic>, role=slice; one spawn at a time; codex->claude per slice
    1P.4  dispatch:       `turn-send <topic> 1 --agent <a>` x N; one persistent Monitor per slice
    1P.5  outcomes:       question -> relay + re-arm; failed/timeout -> retry once -> abandon;
                          pane died -> abandon
    1P.6  gate:           `implement slice-gate <topic> 1` green; `job budget-check`
    1P.7  integrate:      `implement integrate <topic> 1` merges each finished slice into
                          feat/implement-<topic>; conflicts recorded; then `stop <agent> <topic>` x N
    1P.8  absorb turn:    only when something was left: `turn-send <topic> absorb` -> lead
                          implements abandoned tasks, merges conflicting branches, applies
                          out-of-slice changes, self-verifies
  Stage 2     verify-tests in the run worktree (authoritative, never skipped after an integrate)
              + read-based cross-verify over the prelude / slice / absorb reports     (amended)
  Stage 3     fix bundle                                                              (as today)
  Stage 1     round 2+ : lead, run worktree                                            (as today)
  Stage 4     scope-check / summary / finish keep / forensics / teardown               (as today)

job stop    sweeps the slice worktrees and merged slice branches, before the run worktree (new arm)
```

The lead's parallel-phase turns are NAMED (`plan`, `grill`, `prelude`, `absorb`), not numbered:
their state files are `turn-lead-plan.txt` etc., their reports `verify-report-<name>.md` (the plan
and grill turns write `plan.md` instead), and they are outside `MAX_ROUNDS`, which keeps counting
the numbered fix rounds exactly as today. `turn-send` / `turn-wait` accept `<round>` as
`[1-9][0-9]*|plan|grill|prelude|absorb` (the named forms lead-only).

### B. The plan turn, the slice plan, and `slice-check`

**1P.0 — the plan turn.** `turn-send <topic> plan` sends `composePlanPrompt` (new, in
src/core/implementTurn.ts): PHASE 1 of the round-1 prompt alone — read the design, write
`plan.md`, emit `done`, implement nothing — with two contracts added so a verb can read the plan
and the hub can decide the split:

```markdown
### T1: <title>
files: src/core/gate.ts, src/core/gateKinds.ts
depends: none
<scope, intended changes, focused verification — free text>
### T2: <title>
files: ...
depends: T1

## Slices
prelude: T1, T2
slice: T3, T5
slice: T4
```

The `## Slices` proposal is the LEAD's view of what can run concurrently: the worker that cut the
tasks knows their coupling best. The prompt says what a good split is — tasks that other tasks
depend on go first, tasks sharing a file go together, a slice is at least a real hour of work (a
ten-minute slice is not worth a worktree and a bootstrap), `prelude: none` when nothing is a
prerequisite, one `slice:` line when nothing splits — and that the hub decides, not the lead.

`turn-wait <topic> plan` classifies `TS=ok` when `plan.md` parses to at least two tasks
(`parsePlanTasks`, new in `src/core/implementSlices.ts`: `^### T(\d+):` headings, one `files:` line
and one `depends:` line each, `depends: none` allowed); anything else is `failed`, with
`PLAN=unparseable` written ahead of the `TS=` line so the hub can tell "no plan" from "a plan the
verb cannot read". `plan.md` is this turn's completion evidence — the file the premature-`done`
hold (J) resolves for it, since the plan turn writes no verify report. Its budget is
`AP_IMPLEMENT_PLAN_TURN_TIMEOUT_S` (default 3600), not the 4 h implement turn budget: a lead that
never plans must not spend the run's budget before the fan-out starts. The RESUME CHECK of the
ordinary round-1 prompt already skips planning when `plan.md` exists, so a run that falls back to
serial after this turn wastes nothing.

`files:` tokens are repo-relative file paths (or directories with a trailing `/`), and
`parsePlanTasks` normalizes nothing: a token that is absolute, carries `*`, `?` or `[`, or fails
`fileShaped` (src/core/implementScope.ts, the gate written after the same failure on design
Components) is refused by `slice-check` as `BADFILE=<Tn>:<tok>` — a glob compared as a literal
would never overlap anything and two slices would edit the same files with the check green. A
`files:` path absent from the run worktree is reported warn-only as `MISSING=<Tn>:<path>`, the way
`lintComponentsPaths` reports an unfound Components path: the task may create it.

**1P.1 — the slice plan.** The hub reads the proposal against the design and DECIDES: it may
merge slices it judges too small or too coupled, move a task into the prelude, or keep the
proposal as is; it never invents tasks or paths. It Writes `$ART/slice-plan.md`, assigning every
task id once:

```markdown
# Slice plan
## prelude
tasks: T1, T2
## slice wp3
tasks: T3, T5
## slice wp4
tasks: T4
```

Rules the directive gives the hub: a task that other tasks depend on goes in the prelude, or in the
same slice as every task that depends on it; tasks whose files overlap go in one slice; the prelude
may be empty (`tasks: none`); at most `MAX_SLICES` (6, a constant) slices; the hub adds no paths and
no prose — the tasks carry their own.

`implement slice-check <topic>` parses both files and prints `KEY=value` lines:

- Refusals (rc 1, nothing written): `SLICES_EXIST` when `$ART/slices.tsv` already holds any row
  whose status is not `planned` — `pickAgents` is random per call, so a re-entered check would
  re-name live workers out of the roster every later verb reads (the same fail-closed re-entry rule
  `turn-send` applies to its state file, src/commands/implement.ts); `PLAN_UNPARSEABLE`;
  `BADFILE=<Tn>:<tok>`; `UNASSIGNED=<Tn>` (a plan task in no
  group) or `DUPLICATE=<Tn>`; `UNKNOWN=<Tn>` (an id not in the plan); `DEP=<Tn>-><Tm>` (a slice
  task depending on a task in another slice, or a prelude task depending on a slice task);
  `OVERLAP=<a>:<b>:<path>` (a file in one slice equals, is under, or contains a file in another —
  the prelude is exempt, it runs first; two files in one directory are NOT an overlap); a slice
  with no tasks; a label that is not a slug of ≤ 16 chars or repeats; `TOO_MANY=<n>`;
  `AGENTS_SHORT=<k>` when `pickAgents(topic, n)` (src/core/agents.ts:55) returns fewer than n.
- Warn-only: `MISSING=<Tn>:<path>` as above.
- On rc 0: `SLICES=<n>`, `PRELUDE=<0|1>`, `AGENTS=<a,b,...>`. Writes `$ART/slices.tsv`
  (`<agent>\t<model>\t<label>\t<status>\t<tasks ,-joined>\t<files ;-joined>`, status `planned`,
  model = `provider.txt`), one `$ART/slice-<agent>.md` per slice (label, its tasks with titles,
  its files as absolute paths under the slice worktree), and `$ART/prelude.txt` (task ids, or
  absent for an empty prelude).
- `SLICES` < 2 → the directive skips the rest of Stage 1P: serial round 1 as written (its RESUME
  CHECK finds `plan.md`), with one hub flag `parallel-degraded: SLICES=<n>` for `/ap:review`.

**The grill turn.** A refusal is usually about the PLAN's cut, not the hub's grouping: two tasks the
hub wants apart share a file, or a task depends on one the hub put in another slice. The hub alone
can only regroup; the lead can re-cut — split a task so the shared file moves to the prelude, fold
two coupled tasks into one, declare a dependency it had left implicit. So on rc 1 the hub composes a
grill: the refusal lines verbatim, what it was trying to group and why, and the instruction to
rewrite `plan.md` (tasks and proposal) so the check can pass; `turn-send <topic> grill @<file>`
sends it (`composeGrillPrompt`, new — the plan prompt's contract plus the hub's text, ending with
"emit done after rewriting plan.md"). `turn-wait <topic> grill` classifies `ok` when `plan.md`
re-parses. The hub then regroups and re-runs `slice-check`. ONE grill per run: a second refusal
takes the serial path with the flag. The grill is a task dispatch to an idle worker over its own
inbox (the one-writer rule holds), the explore precedent being Phase 8c's one drill turn per worker
(commands/explore.md).

`slices.tsv` is the roster every later slice verb reads, the way `list.txt` is for explore
(src/core/roster.ts). Its `status` and `model` columns are the fields that change over the run:
`planned → spawned | failed-spawn → done | abandoned:<reason>`, rewritten atomically by the verb
that changes them (`readSlices` / `writeSlices` in `implementSlices.ts`). *(Revision: the draft
carried no model column, no task ids, and no plan parser.)*

### C. Slice worktrees and branches

`<root>/.ap/worktrees/<topic>.<agent>` on `feat/implement-<topic>-<agent>`, created by
`spawn-slices` with a `Runner` bound to the MAIN checkout root (`repoRoot()` after
`withMainCheckout`), `git worktree add -b <branch> <path> <sha>` where `<sha>` is `HEAD` of the run
worktree (read through a second runner bound to `target_cwd.txt`). The two trees share one ref
store, so either cwd would work for the `add`; the root is chosen because the provisioning helper
below is provenance-gated on it.

Why that path shape, checked against the worktree algebra in src/core/job.ts (all four points
upheld by the adversarial review):

- `worktreeProvenanced(path, root)` (src/core/job.ts:78) holds — the path is under
  `<root>/.ap/worktrees/` — so `job stop` may remove it, and `pinReport`
  (src/core/provision.ts:205) applies the same PYTHONPATH pin a run worktree gets, provided the
  helper is called with the MAIN root as `root` and the slice path as `target` (`spawn` derives the
  pane's own pin the same way, src/commands/spawn.ts:267).
- `mainCheckoutRoot(path)` (src/core/job.ts:101) is `dirname^3` gated on provenance, so any ap verb
  that ever ran inside a slice worktree re-roots to the main state tree. None does: workers never
  run verbs, and the hub runs them from its own cwd.
- `worktreeTopic(path)` (src/core/job.ts:110) returns `""` — the dot fails `validateSlug` — so a
  slice worktree is never mistaken for a run worktree by the orphan-state refusal, and
  `keepOnBranch` (src/core/job.ts:132) compares only the recorded RUN worktree.
- No code enumerates `.ap/worktrees/*` today; `sweepSliceWorktrees` (I) is the first, and it
  matches `<topic>.` by prefix.

Provisioning: the post-`worktree add` steps of `startWorktree` (src/commands/job.ts:217 — the
node_modules `cp -al` chain, the shadow/pin report, and whatever the `.ap-provision` PR adds) are
extracted into one exported helper `provisionWorktree(root, worktree, r, envDeps)` that
`startWorktree` and `spawn-slices` both call with the MAIN root, so a slice tree is provisioned
exactly like the run tree and PR B's behaviour reaches slices without a second implementation.

Branch: `feat/implement-<topic>-<agent>` is spelled once, in `sliceBranchFor(topic, agent)` beside
`branchNameFor` (src/core/branchRecord.ts:10). Git refuses `feat/implement-x` and
`feat/implement-x/y` in one ref store, hence the hyphen. `spawn-slices` refuses (rc 1, remedy
named, nothing spawned) when a `planned` row's worktree path or branch already exists — the
fail-closed posture `startWorktree` takes for `base/<topic>`. Under `--retry`, a `failed-spawn`
row's tree and branch were created by this run's first pass and are REUSED, not refused: the
worktree exists and the branch still points at the fork sha, or the verb refuses that row with
`SLICE_TREE_MOVED=<agent>`. A `failed-spawn` row may also have left a WORKER DIR behind — only the
bootstrap arm of `spawn` FAILED-archives it, the stamp arm returns before that
(src/commands/spawn.ts) — and `agentInUse` would then refuse the re-spawn; so before re-spawning a
row `spawn-slices` runs the per-agent teardown (`stop <agent> <topic>`) when that dir exists.

### D. Spawning slices — role `slice`, one window each, one at a time

`implement spawn-slices <topic> [--retry]`:

1. Reads `slices.tsv`, `target_cwd.txt`, and the job record (`session`, `worktree`). Refuses rc 2
   without a job record, or with a `--no-worktree` record (`worktree: ""`): slices are
   detached-only (D2) and branch from a run worktree, never from the operator's live checkout.
   Reads `HEAD` in the run worktree; refuses rc 1 with `DIRTY=<path>` lines when that tree has
   MODIFIED TRACKED files (`git status --porcelain -z --untracked-files=no` non-empty — untracked
   suite byproducts do not block a `worktree add`; `-z` because the tree's porcelain rule requires
   it, src/commands/job.ts, and `dirtyPaths` moves beside `classifyDirty` in src/core/gitwork.ts so
   both verbs split it one way).
2. For every row with status `planned` (or `failed-spawn` under `--retry`), ONE AT A TIME
   (D12): create or reuse the worktree and branch (C), provision it, then
   `spawn <agent> <model> <topic> --session <session> --role slice --cwd <slice worktree>`, no
   initial prompt (the task arrives by `turn-send`). Each `spawn` call is wrapped: a throw (the
   `spawn_error` rethrow, src/commands/spawn.ts) records that row `failed-spawn` and the loop
   continues. The verb branches on `spawn`'s RETURN CODE, so the bootstrap arm of `spawn` (the
   `pane_dead` / `timeout` / `error_event` classification, src/commands/spawn.ts) returns **rc 3**
   for the two cold-start reasons instead of 1 — the `SPAWN_FAILED reason=` stdout line is a
   directive contract a Bash step greps, invisible to an in-process caller, and every existing
   caller tests zero-vs-non-zero only (`spawnTally`, `job start`), so nothing moves. rc 3 earns the
   same spawn ONE retry; a second rc 3 while `model` is `codex` respawns the row with `claude`,
   rewrites the row's `model`, and files a flag `slice-provider-fallback: <agent> codex->claude`;
   any other rc, or a claude rc 3 twice, records `failed-spawn`.
3. Records each row's status (`spawned` / `failed-spawn`), prints `SPAWNED=<n>`,
   `FALLBACK=<agent,...>`, `FAILED=<agent,...>`, and returns the `spawnTally` codes (0 all / 1
   partial / 2 none). rc 2 — no row reached `spawned` — is the directive's cue to take the serial
   path (K 1P.3), never to absorb a whole plan.

`--role slice`: `WorkerRole` (src/core/ipc.ts:108) gains `"slice"`; `IDENTITY_BLOCKS`
(src/core/ipc.ts:116) gains a row whose `intro` and `signoff` are the worker's and whose
`role_block` is the worker's block plus one paragraph: *"You are one of several slice workers on this
topic. Each of you works in your own git worktree on your own branch; your inbox task names the
plan tasks and the files you own. Never create, edit, or delete a file outside those paths — if your
tasks genuinely need a change elsewhere, record it under `## Out-of-slice changes needed` in your
verify report (file, line, the exact change) and continue; the Hub carries it to the worker that
owns that path."* The spawn gate at src/commands/spawn.ts:228 admits the value; `paneMetaWrite`
(src/core/ipc.ts:383) records `role` only when it is `"slice"` — the job hub's own pane record
stays as it is — an ADDED optional field, absent on every record written today, so every existing
reader (`paneMetaReadForDir`, src/core/ipc.ts:400) parses unchanged. `WorkerRow.role` is read by a local helper the way `spawnedAtOf` reads
`spawned_at` (src/core/workerLiveness.ts:23-33), so `PaneMeta`'s pinned shape is not widened.

The run's `provider.txt` is untouched by a slice fallback; it still names the lead's provider, and
the slice turn verbs resolve each slice's model with `resolveModel(agent, topic)`
(src/core/ipc.ts:427) — `assertLeadMatches` (src/commands/implement.ts:48) stays a lead-only check.

### E. Dispatch, wait, and the gate — per slice

`turn-send <topic> 1 --agent <agent>` and `turn-wait <topic> 1 --agent <agent>`: `WORKER`
(src/commands/implement.ts:34) becomes the default of an `agent` parameter threaded through
`turnSendWith` (:243) and `turnWaitWith` (:274). Every state-file template already interpolates it
(`turn-<agent>-<round>.txt`, `question-<agent>-<round>.txt`, `<agent>_turn_prompt_<round>.md`,
`turn-<agent>-<round>.done`), so the lead's files keep their 0.5.68 names.

Per-slice deliverables get an agent segment for slices only: `verify-report-<agent>-1.md`,
`test-output-<agent>-1.log`, `worker-test-duration-<agent>-1.txt`. `composeRound1Prompt` DERIVES the
last two from `dirname(verifyPath)` and the round (src/core/implementTurn.ts:88-89), so the slice
composer `composeSliceRound1Prompt` (new) takes `testLog` and `durationLog` as explicit arguments;
the lead's composers keep their derivation. No slice ever writes `worker-test-duration-1.txt`, the
file Stage 2's skip rule reads (H). *(Revision: the draft assumed the composer took every path.)*

The slice prompt is the round-1 prompt with: a SLICE block at the top (label; its tasks quoted from
`plan.md` by id and title; the owned files as absolute paths under the slice worktree; the
peers-in-parallel sentence and the out-of-slice rule from D); PHASE 1 replaced by *"`plan.md` is
already written; your tasks are the ones named above — do not re-plan, do not touch other tasks"*;
PHASE 2's suite rule softened to *"run the suite (`<testCmd>` as detected in your worktree);
failures in tests you did not touch that name files outside your slice are not yours to fix — list
them in the report"*; the single-`done` line from J; `BRANCH_DISCIPLINE` and `blockers` unchanged.
`testCmd` is `detectTestCommand(<slice worktree>)` — the same repo, so the same answer as the run
tree, stated so the composer reads the tree it names.

The prelude prompt (`turn-send <topic> prelude`, lead only) is the round-1 prompt with PHASE 1
replaced by *"`plan.md` is written. Your scope is ONLY tasks <prelude ids>; the rest will be
implemented by parallel slice workers after you emit done"* AND PHASE 2's first sentence replaced
by *"Walk ONLY tasks <prelude ids> of `plan.md` task-by-task"* — the shipped PHASE 2 says "walk
`plan.md` task-by-task" (src/core/implementTurn.ts), which left untouched would have the lead
implement the whole plan serially. It reports to `verify-report-prelude.md`, with log and
duration files named for the stage. The absorb prompt is in G.

`implement slice-gate <topic> 1` is the barrier, the shape of `waitGateVerb`
(src/core/phaseTable.ts) over `slices.tsv`: one line per row, `<agent>\t<label>\t<ok|failed|timeout|question|held|pending|abandoned>`
— `held` when the state file's last line is a `PD=` (a premature-`done` hold in progress, J), from the
last `TS=` otherwise, or the row's `abandoned` status; rc 0 iff every non-abandoned row is `ok` AND
at least one such row exists (a gate over zero live slices is rc 1, never vacuously green). Pure
over files; it blocks nothing — the Monitors do the waiting. A `held` or `pending` row with a live
Monitor is expected, not a watcher failure.

Each slice gets its own persistent Monitor, Stage 1's block reading `turn-<agent>-1.txt`; one
Monitor per worker is the precedent autoresearch sets (commands/autoresearch.md). The
`turn-confirm-*` flags name the MODEL today (src/core/wait.ts:229); with N workers on one provider
they no longer identify the worker, so `turnWaitWith`'s `onFlag` prefixes the agent — a flag-text
change only.

### F. Slice failure — retry once, then abandon; the absorb turn carries it

Per slice, from its Monitor's `TS=`:

- `question` — Stage 1's ROUTE handling (`verify` against the SLICE worktree, `escalate` parks,
  `objection` adjudicates), reply with `send --from hub <agent> <topic> @<file>`, re-arm that slice's
  Monitor. Two rules the fan-out adds: the objection *Revise* arm edits ONLY that slice's
  `slice-<agent>.md` while slices are live — `$ART/design.md` and `plan.md` are read by N workers
  and are not edited until after 1P.7; and a slice objecting that its tasks are not implementable
  standalone is the designed check on a bad grouping — the hub `abandon-slice`s it (absorbed in
  1P.8) rather than overriding.
- `failed` / `timeout` — retry once: `rm` that slice's three round files, `reset-status <topic>
  <agent>` (a timed-out worker is left non-idle, src/commands/implement.ts), `turn-send ...
  --agent`, re-arm. A second failure → `implement abandon-slice <topic> <agent> turn-failed`.
- `PANE=died` recorded ahead of `TS=failed` — `turn-wait` writes it through `recordWaitOutcome`'s
  lead-line parameter (src/core/wait.ts:59) when the engine's synthetic `pane-died` error is the
  event (src/core/ipc.ts, `PANE_DIED_NOTE`), because nothing else carries that note out of the
  process → `abandon-slice ... pane-died`, no retry. *(Revision: the draft read the note "from the
  outbox tail", where it never is.)*
- `unreachable` or a dead Monitor — a WATCHER failure, as today: probe `status.json` and
  `list <topic>`'s LIVENESS for that agent, re-arm if alive.

**Parking with N Monitors armed.** A park is a wait on the hub's inbox (commands/implement.md:108);
a slice Monitor firing during it is handled by the arm above and the hub returns to waiting — the
park is not "resumed" by a Monitor, only by the relay. `slice-gate` is the ground truth of slice
states, never the hub's memory of which notifications it saw.

`implement abandon-slice <topic> <agent> <reason>` (closed reason set:
`spawn-failed|turn-failed|pane-died|objection`): sets the row's status to `abandoned:<reason>`, runs
the per-agent teardown (`stop <agent> <topic>`, archives the worker dir) when the row was spawned,
files one hub flag, prints `ABANDONED=<agent> REASON=<reason>`. The worktree and branch are left for
the sweep (I); anything committed on the branch survives and `integrate` still merges it if it has
commits — an abandoned slice's partial work is not thrown away.

### G. Integration and the absorb turn

`implement integrate <topic> <round>`, through a `Runner` bound to `target_cwd.txt`, on
`feat/implement-<topic>`:

1. Preconditions, rc 1 with the reason named: `currentBranch` is not `branchNameFor("implement",
   topic)` (`implement branch` can leave the tree on `base/<topic>` and record it,
   src/commands/implement.ts; the platform's own merge sites guard the same hazard with `onBase`,
   src/core/gitwork.ts); modified TRACKED files (`--untracked-files=no`). *(Revision: both were
   assumed in the draft.)*
2. For each row in `slices.tsv` order whose branch exists (`show-ref --verify`; a missing branch —
   a `spawn-failed` row that never got one — records `skipped:no-branch`): `git rev-list --count
   HEAD..<branch>` — `0` records `empty` and skips the merge (`git merge` of an already-reachable
   branch exits 0 with "Already up to date", indistinguishable by rc from a real merge, and the run
   branch has MOVED after the first merge so no recorded fork sha would do). Otherwise
   `git merge --no-ff --no-edit -m "merge: slice <label> (<agent>)" <branch>`; rc ≠ 0 →
   `git merge --abort`, record `conflict`, then re-probe tracked cleanliness: still dirty → the loop
   STOPS, the remaining rows record `skipped:tree-dirty`, and the verb returns rc 1 — a tree the abort
   could not restore must never reach Stage 2's suite run or Stage 4's `postSweep`, which commits
   whatever it finds (src/commands/implement.ts). *(Revision: the draft's loop continued.)*
3. Writes `$ART/integrate-<round>.tsv` (`<agent>\t<label>\t<merged|conflict|empty|skipped:<why>>`),
   prints `MERGED=<n>`, `CONFLICT=<agent,...>`, `EMPTY=<agent,...>`, `SKIPPED=<agent,...>`, rc 0 when
   it ran to the end whatever the outcomes — a report, not a gate, the `scope-check` discipline
   (src/commands/implement.ts:417).

Then the directive runs `stop <agent> <topic>` for every spawned row (D7).

**1P.8 — the absorb turn**, taken only when `slices.tsv` has an `abandoned` row, or
`integrate-1.tsv` has a `conflict` / `empty` / `skipped` row, or the report of ANY spawned slice
(merged, conflicted or abandoned — a conflicted slice's request is exactly the one the turn is
about to merge by hand) has a non-empty `## Out-of-slice changes needed`. `turn-send <topic>
absorb` sends `composeAbsorbPrompt` (new): the round-1 prompt's PHASE 2/3 shape, with the design
and plan paths interpolated, over an ISSUES block `absorbIssues` assembles from those files —

```markdown
- [slice] tasks T4 (slice wp4) were not implemented (<reason>): implement them per plan.md
- [integration] feat/implement-<topic>-<agent> (slice <label>) conflicts with this branch —
  run `git merge feat/implement-<topic>-<agent>`, resolve keeping both intents, commit
- [spec-gap] <file:line> — out-of-slice change requested by slice <label>: <the report's text>
```

— reporting to `verify-report-absorb.md`. `BRANCH_DISCIPLINE` forbids checkout/switch/branch, not
merge (src/core/implementTurn.ts), so the lead may merge a slice branch into the branch it is on.
The turn's failure handling is Stage 1's (retry once, then PARK): a run whose slices left more than
one lead turn can carry parks with the N−1 merged slices already on the branch, which is the
outcome D8 chooses over parking at abandon time. `composeFixPrompt` is NOT taught the two new tags:
they never reach a fix round.

### H. Stage 2, 3 and 4 after a fan-out

Stage 2 Step A (`verify-tests`, src/commands/implement.ts:471) runs in the run worktree — the
integrated tree — and stays authoritative. Its skip rule cannot fire on the fan-out path without
any new code: it reads `worker-test-duration-1.txt`, and no turn of a fanned-out run writes that
name (slices write the per-agent file, the prelude and absorb turns write stage-named ones), so
`shouldSkipVerify(null, ...)` is already false (src/core/implementVerifyTests.ts). *(Revision: the
draft added an unreachable rule here.)*

Step B: for a fanned-out round 1 the per-agent and stage-named reports REPLACE
`$ART/verify-report-<ROUND>.md` everywhere Stage 2 names it — the worker-self-verify read
(commands/implement.md, Step B's file list) and the new-gate cross-check that looks for `MUTATION:`
lines in that file (its `NEW_GATES= MUTATION_LINES=` paragraph) both iterate `verify-report-<agent>-1.md`
for every merged slice plus `verify-report-prelude.md` / `verify-report-absorb.md` when those turns
ran; pointed at the absent round file, the mutation gate would silently count zero over exactly the
slices' work. Step B also reads `slices.tsv` and `integrate-1.tsv`. Its verdict is judgment, as
today: the absorb turn has already made the tree complete, so there is no "FAIL by rule" — the
cross-verify doc pastes the `integrate` lines and the slice verdicts verbatim and reasons from the
hub's own suite run. Stage 3 and the numbered rounds are unchanged.

Stage 4 is unchanged: `scope-check` diffs `branch-base.sha..HEAD` (a tree-to-tree diff, so every
slice file appears whichever merge commit brought it), `summary`, `finish keep`, `forensics`,
teardown as written. Slice workers are already stopped; `job stop` sweeps their trees (I).

### I. The job layer

- `job start`, `job mode`, the job record and the brief are UNCHANGED: there is no flag to
  record, and `DETACHED=1` is the only signal Stage 1P needs (D11). A `--no-worktree` job still
  reaches Stage 1P; `spawn-slices` refuses it (D step 1), so such a run plans and then takes the
  serial path — the plan turn is its only cost.
- `job status` (src/commands/job.ts:570): every worker row already prints from `scanTopicWorkers`
  (src/core/workerLiveness.ts:65); with `WorkerRow.role` the row reads `WORKER=<name> <verdict>
  role=slice`. When `$ART/slices.tsv` exists the status also prints one `SLICE=<agent> <model>
  <label> <status>` line per row — read-only and absence-tolerant, the shape `providerFallbackLine`
  already uses for `provider-fallback.txt` (src/commands/job.ts).
- `job wait`'s `workerDeathProbe` (src/commands/job.ts:555): `.find((w) => w.dead)` becomes
  `.find((w) => w.dead && w.role !== "slice")` — the single consumer of `dead` in the tree. The
  origin's Monitor loop and its `JS=worker-dead` arm are untouched; they now fire only for `lead`.
- `job stop` (src/commands/job.ts:740): `sweepSliceWorktrees` runs BEFORE `sweepWorktree` (:314),
  because the run-worktree sweep is an early-returning guard and a KEPT run tree is exactly when slice
  trees also need sweeping; both results join one keep decision, and `keepRecord`'s single reason
  string names both when both failed (`"the worktree and 2 slice worktrees were not swept"`). Trees
  are enumerated from disk — every `<root>/.ap/worktrees/<topic>.*` entry (provenance by
  construction) — and branches from the ref store (`git for-each-ref refs/heads/feat/implement-<topic>-`),
  never from `$ART/slices.tsv`, which Stage 4's archive may already have moved. Per tree: clean →
  removed and pruned; dirty → KEPT and named and its branch arm skipped (the tree still has the
  branch checked out, so git would refuse the delete — commands/job.md documents the same refusal for
  the run's branches). Per remaining branch: `git merge-base --is-ancestor <branch>
  feat/implement-<topic>` exit 0 → `git branch -D`, its rc checked and a failed delete named with the
  by-hand line, the shape `sweepBaseBranch` uses; otherwise KEPT and named — an unmerged slice
  branch is somebody's commits. *(Revision: ordering, the branch-arm interaction, `--is-ancestor` in
  place of parsing `--merged`, the enumeration sources.)*
- `commands/job.md`: the "a live run PINS its branches" paragraph gains the N slice branches a kept
  slice tree pins; `status` documents `role=slice` and `SLICE=`; `stop` documents the slice sweep.
  The sentence "Never respawn a worker into a running job: a second worker under one hub corrupts
  the run" (commands/job.md; its twin in commands/implement.md's `JS=worker-dead` arm) is amended to
  "a second worker on the SAME agent under one hub corrupts the run" — the one-writer rule it
  encodes is per agent inbox, which Stage 1P respects.

### J. Premature `done` — the hold (PR 1, independent of slices)

In `turnWaitWith` (src/commands/implement.ts:274), after `awaitTurn` returns: when the event is
`done` and the turn's COMPLETION EVIDENCE is absent or empty (today's `failed`), the verb instead
holds. The evidence is per turn, not per round token: `plan.md` for the `plan` and `grill` turns
(which write no report — keying the hold on `verify-report-plan.md` would hold every healthy plan
turn for 30 min and then fail it, the blocker both second-pass reviews found),
`verify-report-<name>.md` for `prelude` / `absorb` and the numbered rounds, the per-agent report
for a slice; the same resolver `turn-wait` uses for `TS=ok`. Then:

1. flags `premature-done: <agent> <round> — holding` ONCE per turn (later holds only append
   lines; a 12-task worker must not file 12 issues), appends `OFFSET=<outbox size now>\nPD=<n>\n`
   to the state file with a direct `appendFileSync` — NOT `recordWaitOutcome`, whose `OFFSET=` arm
   always writes a terminal `<KEY>=` line beside it (src/core/wait.ts:66-72). The direct append is
   what `slice-gate` reads as `held`, and what guarantees a hub killed mid-hold leaves no false
   terminal `TS=` (the Monitor reads the file only after the verb exits, so a killed hub surfaces as
   `TS=unreachable`, the watcher-failure arm). A `question` arriving on a re-armed leg goes through
   `recordWaitOutcome`'s question arm as today; its own `OFFSET=` lands after the hold's and
   `parseLatestOffset` is latest-wins, so the interaction is benign. And
2. re-arms `awaitTurn` from that offset. The seam is the dep bag it already takes:
   `ImplementWaitDeps.wait` (src/commands/implement.ts) is threaded into `TurnDeps.wait`, so the hold
   binds, for its re-arms only, a wait that calls `outboxWaitSince` (src/core/ipc.ts) with
   `extendMult: 1` and the pane probe as `onPoll` — the hook `job wait`'s death probe rides
   (src/commands/job.ts). `src/core/wait.ts` is not edited; `TurnDeps` gains no field. *(Revision: the
   draft named a `TurnDeps.onPoll` that does not exist and `boundWait` drops the hook.)*
   `timeoutS` is the remaining turn deadline, and with `extendMult: 1` that IS the bound — the
   default `AP_WAIT_EXTEND_MULT=3` would otherwise stretch a held leg to 12 h.
3. The probe is one closure per `turnWaitWith` call, shared by every re-arm: every 15 engine ticks
   it hashes `capturePane(pane)` (src/core/tmux.ts:366, already exported; it returns `""` on any
   tmux error, so a vanished pane hashes stable and reaches `pane-idle` rather than throwing), and
   returns a synthetic in-process `{event:"error", note:"pane-idle"}` once the hash has been
   unchanged for `AP_IMPLEMENT_PREMATURE_DONE_S` seconds (default 1800). The env reader is the
   `turnConfirmS` shape (src/core/wait.ts:91) that honours an explicit `0`, NOT `envNum`, whose
   `Number(x) || def` turns `0` into the default; `0` disables the hold and restores today's
   `failed`. An unverifiable pane record (`paneMetaRead` null or an empty nonce) means NO hold:
   today's `failed` at once — the platform's rule is that unverifiable is not evidence to act on,
   and the existing gate tests/implement-turn-cmd.test.ts seeds no `pane.json` and pins
   `done + missing report → TS=failed`; it stays green as written. *(Revision: the draft degraded to
   a plain wait there, which would have burned a broken worker's whole remaining budget.)*
4. The re-armed wait's outcome is classified as today: `done` + report → `ok`; `done` + no report →
   step 1 again; `error` (including `pane-idle` and `pane-died`) → `failed`; `question` →
   `question`; null → `timeout`.

`pane-idle` is IN-PROCESS ONLY, never appended to any outbox — the discipline `WORKER_DEAD_EVENT`
(src/core/job.ts:277) states; forensics scrapes outbox files only, so it can never be mistaken for a
worker's error. The confirm layer's `AP_TURN_CONFIRM_S=0` switch does NOT disable the hold (they are
different layers with different switches); the sentence in commands/implement.md that promises `0`
restores pre-confirm behaviour is amended in PR 1 to say so. A hold cannot outlive the turn
deadline, so `job budget-check` at the next round boundary still bounds the run.

Prompt line, added to `composeRound1Prompt` and `composeFixPrompt` (src/core/implementTurn.ts:85,
:149) directly under "This is a single-turn workflow": *"Emit `done` exactly ONCE, after the verify
report is written. Per-task completions are `progress` events (`{"event":"progress","note":"task N
committed: ..."}`), never `done`."* A `progress` line is never terminal for any wait
(`TERMINAL_EVENTS`, src/core/ipc.ts:225), so the habit becomes harmless the moment the worker
follows the line; the hold covers the worker that does not.

`quick` keeps today's behaviour: it has no report to distinguish a per-task `done` from the turn's
end (D1).

### K. The directive (commands/implement.md)

**Dispatch (`## DETACHED MODE`, :20), the launch path (:30) and Stage 0 (:164) are untouched**:
there is no flag to strip, pass, or refuse. *(Revision: the first draft carried a `--workers`
flag through all three; the operator's direction removed it.)*

**Run path (:108).** The table gains one row: Stage 1P is part of every job-hub run — the
`DETACHED=1` that put you on this path is its only signal.

**`## Stage 1P — parallel slices (every job-hub run)`**, inserted after Stage 1.1 (:255):

Stage 1P opens with Stage 1's `Initialize once` line (`ROUND=1`, `RETRY=0`,
`MAX_ROUNDS=${MAX_ROUNDS_OVERRIDE:-5}`), because a fanned-out run reaches Stage 2 without ever
entering Stage 1, and Stage 2/3 branch on `ROUND` and `MAX_ROUNDS`. Each named turn carries its OWN
retry counter (`RETRY_PLAN`, `RETRY_GRILL`, `RETRY_PRELUDE`, `RETRY_ABSORB`); Stage 1's `RETRY` is
the numbered rounds' alone. "Stage 1's retry arm" below means that arm with the named counter.

- **1P.0 Plan turn.** `$CS implement turn-send <TOPIC> plan`, Stage 1's Monitor block with
  `turn-wait "$TOPIC" plan` and `F="$ART/turn-lead-plan.txt"`. `TS=ok` → 1P.1. `failed`/`timeout` →
  Stage 1's retry once; a second failure → `flag` and the serial path (rm the round files; the
  round-1 prompt's RESUME CHECK reuses any `plan.md` that exists).
- **1P.1 Slice plan.** Read `plan.md`'s `## Slices` proposal against the design, decide the
  grouping, Write `$ART/slice-plan.md` under B's rules; `$CS implement slice-check <TOPIC>`. rc 1 →
  ONE grill turn: Write the grill text (the refusal lines verbatim, the grouping you wanted and why,
  "rewrite plan.md so the check passes"), `turn-send <TOPIC> grill @<file>`, Stage 1's Monitor on
  `turn-lead-grill.txt`, `TS=ok` → regroup from the new proposal, re-run `slice-check`; rc 1 again,
  or a grill turn that fails twice → `flag` and the serial path. `SLICES` < 2 → the serial path.
  Read `PRELUDE=` and `AGENTS=`.
- **1P.2 Prelude.** `PRELUDE=1` → `turn-send <TOPIC> prelude`, Stage 1's Monitor on
  `turn-lead-prelude.txt`; `TS=ok` continues; the failed/timeout arm is Stage 1's (retry once, then
  PARK). `PRELUDE=0` → skip; the lead idles.
- **1P.3 Spawn.** `$CS implement spawn-slices <TOPIC>` with `timeout: 600000` (spawns are
  sequential; six bootstraps at the 170 s floor is 17 min). rc 1 with `DIRTY=` lines → commit the
  named files on the run branch once (`git -C <TARGET_CWD> add -u && git commit -m "chore: prelude
  leftovers for <TOPIC>"`), retry once; a second `DIRTY=` → PARK. `FAILED=` non-empty →
  `spawn-slices <TOPIC> --retry` ONCE; rows still failed → `abandon-slice <TOPIC> <agent>
  spawn-failed` each. **rc 2 after the retry (no row reached `spawned`)** → `flag
  parallel-degraded: no slice spawned` and the serial path (Stage 1 round 1; `plan.md` exists), the
  same fallback 1P.1 takes for `SLICES` < 2 — never the absorb turn over a whole plan.
- **1P.4 Dispatch.** For every `spawned` row, `$CS implement turn-send <TOPIC> 1 --agent <agent>`
  — all N in one message. A "not idle" refusal follows the run-path table (wait 60 s, retry,
  `reset-status <TOPIC> <agent>`, retry, then `abandon-slice ... turn-failed`). Arm one persistent
  Monitor per slice: Stage 1's block with `turn-wait "$TOPIC" 1 --agent <agent>` and
  `F="$ART/turn-<agent>-1.txt"`, description `implement slice <agent> <TOPIC>`.
- **1P.5 Outcomes.** As each Monitor fires, take F's arm for that slice.
- **1P.6 Gate.** `$CS implement slice-gate <TOPIC> 1` — rc 0 continues; a `held` row is a hold in
  progress (wait for its Monitor); a `pending` row whose Monitor is gone is the `unreachable` arm.
  Then `$CS job budget-check <TOPIC>` as its own command (exhausted → RESUME.md pastes the gate's
  lines, PARK).
- **1P.7 Integrate.** `$CS implement integrate <TOPIC> 1`. rc 1 with a branch or `DIRTY=` reason →
  the 1P.3 remedy once, then PARK; rc 1 with `skipped:tree-dirty` rows → PARK naming the run
  worktree (a tree the abort could not restore needs eyes). Paste `MERGED=` / `CONFLICT=` /
  `EMPTY=` / `SKIPPED=` verbatim into the cross-verify doc. Then `$CS stop <agent> <TOPIC>` for
  every spawned row.
- **1P.8 Absorb.** When G's condition holds: `turn-send <TOPIC> absorb`, Stage 1's Monitor on
  `turn-lead-absorb.txt`, Stage 1's failure arm. Then Stage 2 with `ROUND=1`.

Stage 2 (:424) Step B gains H's paragraph; Stage 4's teardown row is unchanged (`stop lead
<TOPIC>`; slices are already stopped). The progress-tracking todo list gains `parallel slices` as
one rolling item. The `JS=worker-dead` arm's "second worker under one hub" sentence is amended per I.

## Components

| Path | Change |
|---|---|
| `src/core/implementSlices.ts` | new: `MAX_SLICES = 6`, `parsePlanTasks` (tasks + the `## Slices` proposal), `parseSlicePlan`, `checkSlicePlan` (assignment / dependency / overlap / cap / agents), `readSlices` / `writeSlices` (`slices.tsv`), `sliceWorktreePathFor`, `sliceBranchFor`, `ABANDON_REASONS`, `absorbIssues` (the ISSUES block from slices.tsv + integrate tsv + reports) |
| `src/core/implementHold.ts` | new (PR 1): the premature-`done` hold loop, the pane-idle probe closure, the `OFFSET=`/`PD=` writer |
| `src/commands/implement.ts` | `WORKER` → default of an `agent` parameter in `turnSendWith` / `turnWaitWith` (`--agent`); named rounds `plan|grill|prelude|absorb` with the plan and grill turns' own budget; per-turn completion-evidence resolver; `PANE=died` lead line; the hold call (PR 1); new verbs `slice-check`, `spawn-slices`, `abandon-slice`, `slice-gate`, `integrate` |
| `src/commands/spawn.ts` | `--role slice` admitted; `role` passed to `paneMetaWrite` for slices only; the bootstrap arm returns rc 3 for `pane_dead` / `timeout` |
| `src/core/gitwork.ts` | `dirtyPaths` moved here beside `classifyDirty` (from src/commands/job.ts) for the two tracked-dirty preconditions |
| `src/core/implementTurn.ts` | `composePlanPrompt` (task contract + `## Slices` proposal), `composeGrillPrompt`, `composeSliceRound1Prompt` (explicit log paths), `composePreludePrompt`, `composeAbsorbPrompt`; the single-`done` line in `composeRound1Prompt` and `composeFixPrompt` (PR 1) |
| `src/core/ipc.ts` | `WorkerRole` + `"slice"`; `IDENTITY_BLOCKS.slice`; `paneMetaWrite` optional `role` |
| `src/core/workerLiveness.ts` | `WorkerRow.role`, read by a local helper beside `spawnedAtOf` |
| `src/commands/job.ts` | `workerDeathProbe` skips slices; `statusRun` role suffix + `SLICE=` lines; `sweepSliceWorktrees` before `sweepWorktree` in `stopJobRun`, joined keep reason; `provisionWorktree` extracted from `startWorktree`. `startRun`, `modeRun`, the record and the brief untouched |
| `commands/implement.md` | dispatch refusal; Stage 0 strip; launch-path flag; run-path row; Stage 1P; Stage 2 paragraph; the amended "second worker" sentence; the amended `AP_TURN_CONFIRM_S=0` sentence (PR 1) |
| `commands/job.md` | `status` / `stop` documentation; the pinned-branches paragraph; the amended "second worker" sentence |
| `package.json` | version bump per PR |
| `.claude-plugin/plugin.json` | version bump per PR |
| `.claude-plugin/marketplace.json` | version bump per PR |
| `tests/implement-slices.test.ts` | new: plan parsing (tasks and the `## Slices` proposal; `PLAN_UNPARSEABLE`, `BADFILE`, `MISSING`), `SLICES_EXIST` re-entry refusal, assignment / duplicate / unknown / dependency refusals, overlap (equals / under / contains; same-directory siblings pass), the `MAX_SLICES` cap, `AGENTS_SHORT`, `slices.tsv` round-trip, `absorbIssues` over every spawned row |
| `tests/implement-integrate.test.ts` | new: branch precondition, tracked-dirty precondition (`-z`), `no-branch` / `empty` / `merged` / `conflict` / `tree-dirty` stop arms over a fake `Runner` |
| `tests/implement-spawn-slices.test.ts` | new: worktree+branch arg arrays with the root-bound runner, refusal on existing path/branch for `planned` rows, reuse and worker-dir teardown under `--retry`, sequential order, a throwing spawn recorded and skipped, rc 3 retry then codex→claude fallback and its flag, status and model transitions, tally incl. rc 2 |
| `tests/spawn.test.ts` | `--role slice` accepted; `pane.json` `role` present only for slices; bootstrap `pane_dead` / `timeout` return rc 3, `error_event` rc 1 |
| `tests/implement-turn-agent.test.ts` | new: `--agent` keys every state file and the per-agent report/log paths; `plan|grill|prelude|absorb` state files, the plan/grill budget, and `plan.md` as the plan and grill turns' evidence; the grill prompt carries the refusal lines verbatim; the prelude prompt's PHASE 1 and PHASE 2 scoping; the lead's paths and prompt text byte-identical without `--agent` (fixture captured at 0.5.68); `PANE=died` line; slice-gate `held` and its zero-row rc 1 |
| `tests/implement-premature-done.test.ts` | new (PR 1): held `done` → later `done`+report = `ok`; the `plan` turn's `done` with `plan.md` present is `ok` and never held; pane-idle → `failed`; deadline → `timeout`; `AP_IMPLEMENT_PREMATURE_DONE_S=0` restores today's `failed`; one flag per turn; `OFFSET=`/`PD=` lines and no `TS=` while held; unverifiable pane → `failed` at once (tests/implement-turn-cmd.test.ts's existing gate stays green) |
| `tests/job-cmd.test.ts` | dead slice ignored by the probe, dead lead not; `SLICE=` rows; slice sweep arms incl. the KEPT-tree branch skip and the failed `-D`; `job start` / `job mode` / the brief unchanged (`toEqual` against the 0.5.68 shapes) |
| `tests/job-hub-template.test.ts` | the slice identity block rendered |
| `tests/implement-parallel-directive.test.ts` | new: Stage 1P present with its nine steps and the one-grill rule; the per-slice Monitor block; no `--workers` token anywhere in either directive; the amended sentences in both directives |

## Testing

- Every new verb is a pure function over injected deps plus a thin CLI adapter, tested with
  `freshHome()` (tests/helpers/tmpHome.ts) and a fake `Runner`; tmux only as arg arrays; no pane is
  ever spawned. Directive text is pinned the way tests/job-cmd.test.ts pins the Monitor loop.
- **Attached byte-identity**: `turn-send` / `turn-wait` without `--agent` and with a numbered
  round produce the 0.5.68 file names and prompt text (fixture); the job layer's launch surface is
  asserted unchanged by the existing `job-cmd` / `job` tests plus a `toEqual` on the record's key set
  (the record itself carries a random agent and timestamps, so it is compared by keys, not bytes).
- **Mutation evidence per gate** (memory: verify gates by mutation): each new test's PR body carries
  a `MUTATION:` line — remove the `role !== "slice"` guard and show the probe test go red; swap
  `--no-ff` for `--ff` and show the integrate arg test go red; drop the containment clause of the
  overlap rule and show the `OVERLAP=` test go red; drop the `rev-list --count` probe and show the
  `empty` test go red; reorder the sweeps and show the KEPT-run-tree test go red.
- Full gate before each merge: `npm run typecheck && npm run lint && npm run test && npm run build`,
  `dist/ap.cjs` rebuilt and committed, versions equal in the three manifests, the logging `gh` shim
  on PATH showing zero calls.
- **Dogfood** (before PR 3 merges): one detached implement of a design doc whose plan yields a
  prelude and ≥ 3 file-disjoint slices, on a box with codex. Recorded: the plan turn's duration,
  the lead's `## Slices` proposal against the hub's decided grouping, whether a grill turn ran and
  what it changed, per-slice wall time, `integrate-1.tsv`, whether the absorb turn ran and why,
  whether Stage 2 ran on the integrated tree, the sweep's result, one held `done` if any occurred,
  and every flag. A second, smaller detached run on a doc that does NOT split, recording only the
  plan turn's cost.

## Success Criteria

1. A detached implement on a doc whose plan splits into a prelude and 3 slices runs the 3 slices
   concurrently with no operator input beyond `--detached` (three windows in `ap-<topic>`, three
   `turn-<agent>-1.txt` files armed within one minute of each other), integrates them into
   `feat/implement-<topic>`, and reaches Stage 2 on the integrated tree; wall-clock is below the sum
   of the slice turns.
2. Attached: every verb, file, prompt and directive step is as in 0.5.68 (test-asserted). Detached
   on a plan that does not split: 0.5.68 plus one plan turn, and the serial round 1 reuses its
   `plan.md` (no second planning phase in the worker's transcript).
3. A slice whose spawn or turn fails twice, whose pane dies, or whose merge conflicts never ends the
   job; the run reaches Stage 2 with that slice recorded, its `[slice]` / `[integration]` item
   carried by the absorb turn; `job wait` at the origin never reports `JS=worker-dead` for a slice.
4. `job stop` after a completed run leaves no `<topic>.<agent>` worktree and no merged slice branch,
   including when the run worktree itself is KEPT; an unmerged slice branch survives and is named.
5. A worker that emits `done` after each task, then keeps working, completes its turn `TS=ok` on the
   final `done` with the report present; no park, no retry into a working worker. A worker that
   emits a report-less `done` and stops is `TS=failed` within `AP_IMPLEMENT_PREMATURE_DONE_S` of its
   pane going idle.
6. No new outbox event name; `pane.json`'s new field is absent on every non-slice record.

## Non-goals

- `quick` (D1); attached fan-out (D2); dependency waves beyond one prelude (D4); per-slice fix
  rounds (D7); an operator-chosen worker count, or more than `MAX_SLICES` (D11).
- A `task_done` wire event and a raised `AP_TURN_CONFIRM_S` default (D10). The `job report` verb
  #217 mentions in passing is a separate, unrelated ask.
- Automatic grouping without a hub (a pure-verb partition of the plan by file overlap): the verb
  checks, the hub groups; a mechanical grouping has no notion of which tasks belong together.
- Sharing a slice worktree's build products with the run tree; the hub's Stage 2 run builds what it
  needs, as today.
- Any change to `composeFixPrompt`'s ROUTING: the two new tags are consumed by the absorb turn only.

## PR split

1. **PR 1 — premature `done` hold** (J): `implementHold.ts`, the `turnWaitWith` call, the
   composers' single-`done` line, the two directive sentences, tests. Independently valuable; ships
   first; closes the evidence run's failure class for serial runs too. In PR 1 the completion
   evidence is `verify-report-<round>.md` alone; the per-turn resolver arrives with the named turns
   in PR 2.
2. **PR 2 — slice mechanics, dark**: `implementSlices.ts`, the five verbs, `--agent` and the named
   rounds, the four composers, role `slice`, the `pane.json` field, the job-layer changes (I), the
   `verify-tests` rule, tests. No directive change: the verbs are reachable but unused until PR 3,
   the pattern the detached-job program used.
3. **PR 3 — directive + release**: Stage 1P and the amended sections of both directives,
   directive-pin tests, the dogfood record appended to this spec as an amendment, version bump.

Serial merging, forced by the committed `dist/ap.cjs`.

## Frozen-protocol confirmation

Event names `ready/ack/progress/done/error/question`, `END_OF_INSTRUCTION`, the JSON fields, the
`contracts.yaml` keys, and every state FILENAME are unchanged. `pane-idle` (J) joins `pane-died` and
`worker-dead` as an in-process verdict never written to an outbox. `pane.json` gains an OPTIONAL
field, absent on every record written today — the file's name and its five existing keys are as they
were. `IDENTITY_BLOCKS` gains a role; `config/prompt-templates/identity.md` is not edited. The
stale-token gate (tests/stale-tokens.test.ts) matches none of the new names.

## Risks and open questions

- **Grouping quality.** The plan is worker-authored, but the grouping of its tasks is the hub's.
  Three checks stand between it and a bad run: `slice-check`'s dependency / overlap / assignment
  refusals, the slice worker's objection route (F), and Stage 2's verify on the integrated tree. If
  the dogfood shows plans that do not split (many tasks touching one shared file), the plan prompt
  is the knob — ask the lead to keep shared-file edits in one task — before any smarter verb.
- **Pane-content probe false positives** (J). A TUI that repaints while idle never goes idle (the
  hold then ends at the remaining turn deadline — bounded, with `extendMult: 1`); a TUI static during
  a long silent compile could read idle before `AP_IMPLEMENT_PREMATURE_DONE_S` (a codex pane shows an
  elapsed counter while a command runs, so this is expected to be rare; the env var is the knob).
- **Box load.** N concurrent codex TUIs plus N slice suites, with N decided by the hub up to
  `MAX_SLICES`. The hub's "a slice is at least a real hour of work" rule and the constant are the
  only bounds; sequential spawns (D12) keep bootstrap off the loaded path. If a dogfood shows six
  is too many for a box, the constant moves.
- **Every detached run pays a plan turn** (the plan-only turn plus the hub's grouping), even one
  whose plan does not split. The `plan.md` is reused by the serial round 1, so the cost is the
  turn's overhead, expected at 15–30 min; the second dogfood run measures it. If it proves too high
  for small docs, the knob is a hub judgment step before 1P.0 ("does this design have more than one
  package at all?"), not an operator flag.
- **Slice suites are partial.** A slice worktree lacks the other slices, so a design-level test that
  spans packages cannot pass there; the prompt says to list, not fix, such failures. The hub's
  Stage 2 run on the integrated tree is the only complete run.
- **Disk.** Six slices is seven worktrees and seven hardlink clones of `node_modules` per topic
  until `job stop`; the sweep is the only reclaimer, which is why I orders it to run on every ending.
- **Forensics volume.** The wind-down scrape walks every worker dir under the topic
  (src/core/forensics.ts), so a 6-slice run files every slice's `error` / `question` lines and
  `FLAG:` notes as comments on the ONE run issue. That is the intended shape — one issue per run,
  the slices are its workers — and no per-agent cap is set; if a dogfood shows it drowning the
  issue, a cap is a `scrapeArtDir` change, not a slice change.
- **Open to the operator:** D1 (`quick` out), D3 (plan turn with the lead's proposal and one
  grill, vs. a Components partition), D7 (lead-only fix loop), D10 (pane probe vs. a plain hold —
  the review upheld the probe), D12 (sequential spawns), the value of `MAX_SLICES` (six), and whether
  the lead should be spawned lazily when `PRELUDE=0` (this spec spawns it at Stage 1.1 as today: an
  idle pane is free, and the provider-fallback canary is worth more than the window). D11 itself —
  no operator knob — is settled.
