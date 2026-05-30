# consort `rehearsal` — design

**Status:** approved (brainstorm 2026-05-30)
**Ports:** clone-wars `deep-research` (`lib/deep-research.sh` ~1.7k LOC, `commands/deep-research.md` ~45KB,
14 `bin/deep-research-*.sh` scripts). This is the largest command in the suite.
**Supersedes for rehearsal:** the phase-guard "OUT OF SCOPE" entry in `CLAUDE.md`.

> Grounding note: this doc references clone-wars terms (`deep-research`, `trooper`, `commander`, `Yoda`)
> only for traceability. The stale-token gate scans `src`/`config`/`commands`/`hooks`/`.claude-plugin`,
> **not** `docs/`, so those terms are allowed here. Shipped code must use the rebrand (§1).

---

## 1. What it is

`rehearsal` is an AIDE-style executable autoresearch harness. The user gives a **measurable objective**
("get >0.99 MNIST accuracy under 100k params"). The conductor (the Maestro — the Claude session) acts as
a **research advisor**: it locks a metric with the user, runs a SOTA web sweep, spawns **2–3 persistent
codex parts** (PhD-student executors) **once**, then adaptively dispatches single-config **experiments**
to them across a long-running session. Each part writes + executes scratch code, measures the metric, and
emits a `result.json`. The advisor scores results into a rolling `scoreboard.md`, checks completion signals
(floor / target / K-corroboration / plateau) each turn, and keeps dispatching until a stop condition fires.
On stop it synthesizes a cited **landscape doc** + a **`score-handoff.md`** brief, tears down the panes, and
archives everything. It is strictly **explore-only**: it never touches the user's real source — promotion to
real code is `perform`'s job.

**Faithful to *actual* behavior, not dead code.** clone-wars shipped a separate `deep-research-resume.md`
resume directive + a session-scoped `active-<sid>.txt` marker + a UserPromptSubmit hook that re-injected it.
That mechanism was never used in practice. **We do not port it.** The multi-turn loop is driven **inline**
exactly the way the already-shipped `score` and `perform` commands drive their notification loops: per-part
Monitor `<task-notification>`s + the conductor's in-session context + a durable `session-summary.md` on disk.
`hook.ts` stays a no-op; there is no active-marker lifecycle.

The only structural difference from score/perform: their inline loop waits for a **bounded** set of
completions (N parts × one task) then proceeds; rehearsal's loop is **unbounded** — it keeps dispatching new
experiments to persistent parts and ends each turn, getting re-woken by the next Monitor notification, until
a stop condition fires.

---

## 2. Rebrand mappings (rehearsal-specific)

| clone-wars | consort |
|---|---|
| `deep-research` (command) | `rehearsal` |
| `deep-research-resume.md` | **dropped** (loop is inline in `rehearsal.md`) |
| `_deep-research/` (state/art dir) | `_rehearsal/` |
| `troopers/<cmdr>/`, `troopers.txt`, `troopers-preflight.txt` | `parts/<instrument>/`, `parts.txt`, `parts-preflight.txt` |
| commander pool (hardcoded codex `rex keeli colt …`) | `pickInstruments(topic, N)` → spawn each as `codex` |
| "trooper (PhD student)" | "part" (keep the PhD-student flavor) |
| Master Yoda / Yoda / `From: master-yoda` | Maestro / `From: maestro` |
| "## Yoda reflection" (forensics) | "## Maestro reflection" |
| `consult-handoff.md` | `score-handoff.md` (hands off to the design command; consult→score) |
| `deep-research-<date>-<slug>.md` | `rehearsal-<date>-<slug>.md` (landscape doc) |
| `fresh-trooper` | `fresh-part` |
| `cw_*` fns / `.clone-wars/` / `~/.clone-wars/archive` | dropped / `.consort/` / consort archive |
| teardown banner "MISSION ACCOMPLISHED" | "FINE" |

**FROZEN — preserve byte-identical** (the wire contract with the codex parts):
- `result.json` flat schema: `branch_id`, `approach_label`, `metric_name`, `metric_value`, `status`,
  `runtime_s`, `log_paths`, `checkpoint_path`, `notes`, `self_reported_count`, `self_reported_ratio`,
  `self_reported_notes`.
- outbox events `ready` / `ack` / `progress` / `done` / `error` / `question`; sentinel `END_OF_INSTRUCTION`.
- `inbox.md` format; the experiment prompt-template structure; status filenames; `CLAUDE_CODE_SESSION_ID`.
- `contracts.yaml` keys (no change — reuses the 1800s per-experiment cap).

---

## 3. Reuse wins (no new infrastructure)

- **Roster pick** = existing `core/instruments.ts::pickInstruments(topic, N)` → spawn each picked instrument
  with provider `codex`. clone-wars hardcoded a codex commander pool; consort assigns provider at spawn, so
  N distinct instruments spawned as codex is the faithful equivalent.
- **Forensics** = existing `core/forensics.ts::captureArtDir({artDir, command: "rehearsal"})`. `command` is a
  free string (no enum gate). `scrapeArtDir` already covers rehearsal's real signals — `spawn-results.tsv`
  rc≠0, per-part `outbox.jsonl` error/question, `status.json` errors, `session-summary.md` log errors. The
  score-specific `design-doc/audit.log` path simply reads null and is skipped.
- **Per-experiment timeout cap** = existing `core/contracts.ts` fallback (1800s, env-overridable). No
  `contracts.yaml` change.
- **Spawn / send / collect / tmux / ipc / paths / atomic / preflight** primitives reused as-is. The
  persistent-part dispatch (`send @inbox` to a live pane across experiments; read NEW outbox events since the
  last experiment) uses the existing IPC + offset mechanics.
- **`hook.ts`** stays a no-op (unchanged).

---

## 4. Module structure

**`src/core/` (pure logic — the Phase-A test surface):**
- `rehearsal.ts` — orchestration types + the `_rehearsal/` art-dir path layout
  (`parts/<instrument>/experiments/<exp-id>/{code/,prompt.md,result.json,stdout.log,stderr.log,audit.json}`)
  + state scaffolding helpers.
- `rehearsalMetric.ts` — metric heuristic extraction (canonical vocab, whole-word, first-by-position wins),
  `metric.md` format/parse, SOTA block format.
- `rehearsalResult.ts` — `result.json` validation, scoreboard render/sort, `results.tsv`, `normalize_result`.
- `rehearsalComplete.ts` — `check_completion` (floor / target / K-streak / plateau).
- `rehearsalConsensus.ts` — per-field ε triangulation → `consensus.md`.
- `rehearsalState.ts` — per-part `state.txt` KV read/write/reconcile + structured `halt.flag` read/write.

**`src/commands/rehearsal.ts`** — verb router dispatched by `rehearsal <verb>`:
`init`, `experiment-send`, `score`, `monitor`, `finalize`, `refine`, `fresh-part`, `abort`,
`handoff-extract`, `teardown`. Registered in `src/consort.ts` (destructured import + handler map).

**`commands/rehearsal.md`** — the single directive (Phases 0–7 + the inline loop). **No `rehearsal-resume.md`.**

**`config/prompt-templates/rehearsal/experiment.md`** — the experiment prompt template (rebranded;
`result.json` contract frozen).

---

## 5. Stage sequence (`commands/rehearsal.md`)

- **Phase 0 — Args + init.** args-file fence (per `commands/list.md` shape) → `rehearsal init <args>` → topic
  slug; cache `topic.txt` / `art-dir.txt`. Non-interactive flags `--time-budget` / `--metric` / `--slug` /
  `--seed-from`.
- **Phase 1 — Metric discussion.** Seed from init's `metric.txt` heuristic; optional triple-search
  (WebSearch + Tavily + AnySearch) for novel topics. **3 unconditional AskUserQuestions** — they fire regardless of autonomous-mode / `/loop` /
  "don't stop for questions" hints, and are skipped **only** if `metric.md` already exists (pre-written by
  `--metric=`). Produces `metric.md`: `primary_metric`, `direction` (maximize|minimize), `min_acceptable`
  (floor), `target` (aspirational), `K_corroboration` (default 1), `hard_constraints`, `notes`; defaults
  `plateau_window=5`, `plateau_threshold=0.01`. The Cancel branch → teardown + exit.
- **Phase 1.5 — SOTA sweep.** One **triple-search** round (WebSearch + Tavily + AnySearch, per the
  machine-wide search policy) → curate ≤7 references (one row per approach family) → `sota.md` (write-once).
- **Phase 2 — Preflight (roster + time limit).** Maestro silently picks **N=2 (default) or 3** (rubric:
  single-optimum + tight-constraint → 2; multi-goal / broad-survey → 3; diversity bias: different pipeline
  per part). **Unconditional time-budget AskUserQuestion** (skipped only if `time-budget.txt` pre-written) →
  encodes `none` | `14400` | `43200` | custom×3600 into `time-budget.txt` + `session-start.txt`.
  `pickInstruments(topic, N)` → roster.
- **Phase 3a — Preflight pane allocation.** Write `parts-preflight.txt` (`codex\t<instrument>`); allocate N
  panes off the Maestro pane, `main-vertical` layout → `preflight-panes.txt`. Retry-once; second failure →
  archive + exit.
- **Phase 3b — Batch dispatch.** Fork N parallel `spawn <instrument> codex <topic> --target-pane <pane>` →
  `spawn-results.tsv` (rc 0 all-ok / 1 partial / 2 all-failed). Stage 1: any failure + retry==0 → teardown,
  retry 3a. Stage 2: failure + retry==1 → force-abort if `<2` succeeded (min N=2), else AskUserQuestion
  "Proceed degraded / Abort".
- **Phase 4 — Initial dispatch + start loop.** Seed `parts.txt` (atomic, 1-col), `mkdir
  parts/<instrument>/experiments`, init liveness cursor, write `state.txt` (`exp_counter=0 phase=idle …`).
  Start **one persistent Monitor task per part** (`rehearsal monitor`) → `monitor-tasks.txt`. Write initial
  `session-summary.md`; Maestro appends `## Current direction` + `## Recent decisions`. First dispatch round:
  parallel `rehearsal experiment-send <topic> <instrument> exp-001 <approach> <direction>` (one per part, one
  message). Render status brief. **End the turn.**

### The inline loop (in `rehearsal.md`, on each part-completion notification or user message)
1. **Read state baseline** — `scoreboard.md`, per-part `state.txt`, `halt.flag` existence, time-budget,
   queued notifications.
2. **Hard-cap check** — `halt.flag` exists OR time-budget elapsed → `rehearsal finalize` + TaskStop monitors
   + jump to Phase 5.
3. **Process queued notifications** by event type: `done`/`error` → `rehearsal score`; `question` → mark
   blocked; `stale` → probe; `stuck` → judgment; `heartbeat` → bump ts. Render the status brief **once** if a
   score ran.
4. **Completion check** — `rehearsal` completion math → apply the §6 decision policy. If stop → touch
   `halt.flag`, jump to Step 2.
5. **Dispatch round** — for each `phase=idle` part with no `halt.flag`: run the Lane-D abandon check first;
   else compose a ~50-token direction and dispatch the next `exp-NNN`. **Never stop the loop here.**
6. **Handle user message** — halt / change-direction / extend-budget / conversational.
7. **Re-render `session-summary.md`.**
8. **End the turn.**

- **Phase 5 — Synthesis.** Maestro writes `rehearsal-<date>-<slug>.md` — required sections: Experiment-log
  table, Winner, Why-we-stopped, Branches-preserved, Suggested-next. Consumes `session-summary.md` +
  `scoreboard.md`.
- **Phase 6 — Teardown + archive.** `captureArtDir({artDir, command:"rehearsal"})` (best-effort) **before**
  the panes teardown; Maestro appends a `## Maestro reflection` section (3–5 bullets). Batched teardown
  (one "FINE" banner). `rehearsal teardown` archives the topic dir; `$ART_DIR` rebinds to the archive path.
- **Phase 6b/6c — Handoff.** `rehearsal handoff-extract` → `handoff-data.kv`; Maestro composes
  `score-handoff.md` (absolute paths).
- **Phase 7 — Present.** Archived landscape-doc path, winner code dir, the Suggested-next line, a one-line
  outcome.

---

## 6. Decision policy + stop conditions

**Advisor = the Maestro conductor** (the Claude session itself; there is no separate judge model). It owns:
metric selection (Phase 1, interactive), roster size N + per-part approach diversity (Phase 2, silent),
dispatch (Step 5: what approach + ~1–2 sentence direction each idle part gets next — "direction, not plan";
continuity lives in `session-summary.md`), stop (Steps 2 + 4), and lane abandonment / intervention.

**Decision policy (prose, faithfully reproduced):**
- **Hard rule:** `floor_met=no` + no cap → **keep going**.
- **Soft rules** (Maestro judgment, default-stop with override allowed): `floor + target + K` all satisfied →
  **default stop**; `floor + plateau + no-target` → **default stop**.
- **Lane-D abandon** (per part, not session): ≥3 ok experiments AND none of the last 3 ≥ `min_acceptable` AND
  best ≥ 5×`plateau_threshold` below the leader → retire the lane.
- Convergence uses `consensus.md`'s `## Contested` section for asymmetric framing.

**All stop conditions:** (1) user halt phrase (negation-guarded) → structured `halt.flag`; (2) advisor stop
decision → `halt.flag` with reason; (3) time-budget hit (`none` → never); (4) completion-check stop;
(5) `rehearsal abort`; (6) spawn/preflight unrecoverable, or `<2` parts succeeded (min N=2) → archive + exit;
(7) per-part lane abandonment.

---

## 7. Semantic core formats (frozen / exhaustively tested in Phase A)

**`result.json`** (FROZEN flat schema):
```json
{ "branch_id": "...", "approach_label": "...", "metric_name": "...",
  "metric_value": <num|null>, "status": "ok"|"fail"|"timeout"|"cost_blown",
  "runtime_s": <num>, "log_paths": ["./stdout.log", "./stderr.log"],
  "checkpoint_path": <abs|null>, "notes": "<=500 chars>",
  "self_reported_count": <num>, "self_reported_ratio": <num>, "self_reported_notes": "..." }
```
**Validation:** `metric_name` MUST equal `metric.md`'s `primary_metric`; `metric_value` non-null **iff**
`status=ok`; `log_paths` must exist on disk. A failed validation writes a `result-validation.txt` rejection
sidecar next to the file and does **not** crash the loop.

**`scoreboard.md`** — 8-col `| Rank | Experiment | Instrument | Metric | Status | Runtime | Approach |
metric_name |`. OK rows sorted **metric desc → runtime asc → exp-id**; fail/partial grouped at the bottom
with a `~` rank prefix. Also writes `results.tsv` (atomic, header-once). After scoring, `phase` is cleared to
`idle` **only** for parts whose `current_exp_id` has a `result.json` on disk (race guard). `normalize_result`:
`status=ok` + null metric → partial; `status=fail` + a `self_reported_ratio` → partial.

**`check_completion`** → `floor_met=yes|no  target_met=yes|no  K_so_far=<int>  K_required=<int>
plateau=yes|no`:
- **floor / target:** any ok-row metric satisfying `min_op min_val` / `tgt_op tgt_val` (ops `>= <= > < ==`).
- **K_so_far:** the longest streak of consecutive, strictly-improving, at-target experiments by a **single
  part** (per-part monotonic chain; Δ=0 or a `fail` in the middle breaks the chain; capped at `K_required`
  for display). Rows considered in `(instrument, exp-id)` order.
- **plateau:** the last `plateau_window` ok-row metrics have `max − min < plateau_threshold`.
- Rows filtered by `metric_name == primary_metric`.

**`consensus.md`** — per-field agreement across each part's **latest ok** `result.json`, over fields
`branch_id approach_label metric_name metric_value status runtime_s notes` → `## Agreed` (all present values
match; numeric uses ε, default 0.01) / `## Contested` (any disagreement or any part missing the field) /
`## All-missing`. Advisory only; does **not** gate stop.

**`state.txt`** (per part) — KV `exp_counter phase current_exp_id last_event_ts last_event probe_sent_ts`
(+ optional `lane_abandon_reason` / `lane_abandon_ts`); `phase ∈ idle | working | stale | stuck | blocked |
failed | complete | incomplete | abandoned`. KV uses newline-escaping. `reconcile` re-derives a part's state
from the outbox tail (catches a `done`/`error` that arrived after the last handler; error wins over done).

**`halt.flag`** — structured KV: required `halted_by` / `halted_at` / `reason`; optional `target_met`
`floor_met` `k_so_far` `k_required` `plateau` `plateau_observed_n` `final_leader` `final_leader_metric`
`architectures_corroborated`. The reader tolerates legacy free-form prose
(`format = structured | prose | missing`).

---

## 8. The four phases (one spec, perform-style A–D, one branch)

**Phase A — Pure semantics (zero IPC).** The six `core/rehearsal*.ts` modules above, with exhaustive vitest
coverage. Highest-value, error-prone math locked first.

**Phase B — Front half.** `rehearsal.ts::init` (slug derivation, **codex availability gate**, hardware probe
best-effort, file scaffolding, metric heuristic seed, flag parsing) + `rehearsal.md` Phases 0/1/1.5/2/3a/3b
(args fence, 3 metric AskUserQuestions, triple-search SOTA, `pickInstruments` roster, time-budget
AskUserQuestion, preflight pane alloc, batch-spawn persistent codex parts). Dogfood checkpoint: init + metric
+ spawn.

**Phase C — Experiment loop (the heart).** `rehearsal.ts::experiment-send` (validate `exp-NNN`, refuse if
`phase≠idle`, create `experiments/<exp-id>/code/`, render `config/prompt-templates/rehearsal/experiment.md`
with inlined metric + hardware + SOTA + peers blocks + optional task context, write `inbox.md` +
`END_OF_INSTRUCTION`, `state→working` + `exp_counter+1`, nudge `send @inbox`), `::score` (validate all
`result.json`, write scoreboard + `results.tsv`, clear `phase→idle` per race guard), `::monitor` (liveness
state machine: byte-cursor + line-number rescan dedup + phase-aware stale/stuck emission + cursor
persistence). `rehearsal.md` Phase 4 + the inline loop (Steps 1–8) + the §6 decision policy. Dogfood
checkpoint: simulated parts → a few rounds → score → completion → stop.

**Phase D — Tail + interventions + full dogfood.** `rehearsal.ts::finalize` (reconcile from outbox tail,
normalize results, prune intermediate `*.pt` checkpoints keeping `checkpoint_path`, link pane outbox/inbox
into the tree, size/audit warnings → `warnings.txt`, re-render `session-summary.md` with a `## Halt`
section), `::refine` (write `refine-N.md` into the live branch dir + nudge; no state change), `::fresh-part`
(teardown + respawn same instrument + topic, reset `phase=idle current_exp_id=` but **preserve
`exp_counter`**; refuse if `phase=working`), `::abort` (`halt.flag` + finalize + teardown), `::handoff-extract`
(`handoff-data.kv`: `winner_instrument/exp/approach/metric/checkpoint/notes/code_dir`, `runner_up_1..3`;
no-winner → `mode=rehearsal-no-winner`), `::teardown` (kill preflight orphans, sweep `shared/*.tmp`/`*.lock`,
create the relative `winner` symlink → top-1 ok `code/`, stamp terminal status, `mv` the topic dir to the
consort archive). `rehearsal.md` Phases 5/6/6b/6c/7. Full simulated-parts dogfood; `CLAUDE.md` phase-guard
update (rehearsal shipped → **prelude becomes the only out-of-scope command**); `DOGFOOD.md` entry; dist
rebuild.

---

## 9. Error handling

- Errors to **stderr**, never the outbox.
- **Atomic writes** for `scoreboard.md` / `state.txt` / `halt.flag` / `session-summary.md` / `parts.txt` /
  `results.tsv` (tmp-in-same-dir + rename).
- `result.json` validation rejects via sidecar without crashing the loop.
- Spawn **retry-once**, then degraded-≥2 AskUserQuestion; preflight retry-once then archive + exit.
- **Best-effort / never fatal:** forensics capture, hardware probe + diff, checkpoint prune, size/audit
  warnings, lib-seed copy.
- Non-JSON outbox lines are skipped.

---

## 10. Testing strategy

- **Phase A** carries the bulk of coverage: `check_completion` (floor/target compares, the per-part
  monotonic K-streak walk incl. Δ=0 and mid-chain-fail breaks, plateau over window), scoreboard
  sort + validation (metric_name enforcement, status/metric_value joint validity, `normalize_result`
  transitions), consensus (per-field, ε-aware, latest-ok-per-part, three buckets), `state.txt`
  read/write/reconcile, structured `halt.flag` read/write incl. legacy-prose tolerance, metric heuristic
  extraction.
- **tmux/IPC code:** tested as **pure arg-array builders**; never spawn real panes in unit tests.
- **Integration:** a **simulated-parts dogfood** (codex directory-trust blocks autonomous live spawns, so
  parts are simulated). A script seeds `_rehearsal/` state + `metric.md` / `sota.md`, simulates N parts
  (writes `result.json` files + emits outbox `done`/`error`/`question`), and drives the loop via the real
  CLI verbs across turns: **init → dispatch → score (scoreboard sort) → completion math (floor → then
  target+K stop, and a separate plateau-stop run) → consensus → finalize (reconcile/normalize) → synthesize
  landscape doc → teardown + archive + forensics + Maestro reflection → handoff-extract → `score-handoff.md`**.

---

## 11. Acceptance

- All core unit tests green; `npm run typecheck` reports 0; `npm run lint` clean.
- The **stale-token gate** stays green (no `clone-wars` / `cw_` / `master-yoda` / `MISSION ACCOMPLISHED` /
  `@cw_` / `trooper` / `commander` in shipped `src` / `config` / `commands` / `hooks` / `.claude-plugin`,
  comments included). JSDoc cites the prior plugin as `deep-research-*.sh`.
- `dist/consort.cjs` rebuilt and deterministic (no diff on re-build); the `rehearsal` verbs dispatch from it.
- Every dogfood scenario passes; the landscape doc + `score-handoff.md` are written with absolute paths.
- `CLAUDE.md` phase guard updated: rehearsal moved to Shipped; **prelude is the only remaining out-of-scope
  command**.

---

## 12. Out of scope / explicit non-goals

- **No `rehearsal-resume.md`**, no active-`<sid>`.txt marker, no UserPromptSubmit hook revival (§1). The loop
  is inline.
- **No `contracts.yaml` change** — reuses the 1800s per-experiment safety cap (env-overridable).
- `--seed-from` accepts a prelude landscape doc, but **prelude does not exist yet**, so that input is
  optional/absent for now; the flag is wired but not exercised by the dogfood.
- Promotion of a winning experiment into real source is **`perform`'s** job, not rehearsal's (explore-only).
- `prelude` (meditate) remains out of scope until its own brainstorm → spec.
