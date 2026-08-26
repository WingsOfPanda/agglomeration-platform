# Bootstrap death detection: a killed spawn is never silent (rev 2 — after adversarial review)

Date: 2026-08-26. Source: GitHub issue #157 (`the-v4-overfit-rerun`, xjp, 2026-08-25): a detached
`/ap:quick` burned 10.5h of a 14h budget with zero work product while every status surface read
`LIVENESS=alive HUB_STATE=working PARKED=no`.

Rev 2 closes four adversarial-review findings, each verified against the code before revising:
(1) rev 1's L1 archived a worker while leaving its pane running, and used a state (`failed`) that is
not in the vocabulary; (2) rev 1's classifier bullets overlapped, and a single empty tmux snapshot
would have read as terminal; (3) `job wait` blocks on the HUB outbox for up to 3h and would not see a
worker die mid-wait; (4) `JS=worker-dead` would have fallen into the canonical loop's catch-all and
produced two `JS=` lines.

## Problem — proven from the job hub's own transcript, not inferred

```
15:03:31  Bash: $CS spawn delta codex the-v4-overfit-rerun --cwd <wt>; echo "rc=$?"    (no timeout param)
15:05:33  Exit code 143 / Command timed out after 2m 0s / … waiting for {ready,error} in outbox (timeout 150s)
15:05:47  Bash (background): until grep -q '"event":"ready"' …/delta-codex/outbox.jsonl; do sleep 3; done
15:05:52  progress event: "worker delta (codex) spawned in pane, awaiting ready"
          — exactly ONE further tool call in the next 10.5 hours
```

Exit 143 is SIGTERM from the hub's default 2-minute Bash tool timeout. It fired 30s BEFORE spawn's own
150s codex `ready` deadline (`src/commands/spawn.ts` blocks on `outboxWait(..., ["ready","error"],
readyTimeout)` and, on timeout, captures the pane, kills it, writes `error`/`bootstrap-failed`, and
FAILED-archives). So none of that ran: no FAILED-archive, no `command:spawn` forensics, `status.json`
frozen at the spawn seed (`last_event: spawn`), outbox empty. The hub misreported a killed spawn as
"spawned" and parked on an unbounded loop.

The issue's framing is wrong on mechanism: spawn DOES have a bootstrap deadline; it was preempted by a
shorter external one it cannot survive, because ap installs no SIGTERM handler anywhere
(`grep -rn "process.on(" src/` is empty).

It is structural, not transient. A caller must outlast `bootstrap_sleep_s + ready_timeout_s`: codex
20+150 = 170s, claude 12+150 = 162s (`config/contracts.yaml`). The 120s Bash default ALWAYS loses.

It is a repeat. The same mechanism was recorded on 2026-08-06 (`land-the-two-clock-r`, same box) as
"always pass ≥300s" — guidance that never became directive text or code.

## Goal

A worker that dies, or a spawn that is killed, before `ready` becomes a loud, terminal, attributable
event within minutes — never a 10-hour "working" — and a healthy run is never declared dead by a
transient tmux read.

## Architecture — three layers; any one would have saved the run

### L1. `spawn` fails closed on SIGTERM — by running the SAME path a timeout runs (S)

Install a SIGTERM handler for the duration of the ready-wait. On SIGTERM it runs the existing
bootstrap-failure sequence (`spawn.ts:232-250`) with `reason=killed` — a new reason value beside
`timeout`/`error_event` — in this order, cheapest-and-most-valuable first because the harness may
escalate to SIGKILL after an unknown grace:

1. `writeWorkerStatus(agent, model, topic, "error", "spawn-killed")` — ONE atomic rename. This alone
   moves the worker out of the `last_event: spawn` seed state, so L2 reads it as terminal even if
   nothing below completes. `error` is the existing terminal state; `failed` does not exist
   (`ipc.ts:23`, `TERMINAL_WORKER_STATES`).
2. `killNow(pane)` — this call created the pane, so the id cannot be stale (the same justification the
   timeout path already carries at `spawn.ts:245`). **The pane is never left running behind an
   archived record**: `stateArchive` moves the whole worker dir, `pane.json` included, out of the
   topic, and `stop`/`job stop`/`ap list` discover ownership from active topic dirs — an archived
   live pane is unreachable by every supported teardown.
3. `capturePane` scrollback + `captureFailure` + `captureSpawnFailure` forensics (`reason=killed`).
4. `stateArchive(..., "FAILED")`, then `process.exit(143)` (preserve the caller-visible signal code).

Also pass `WaitLivenessOpts` (`ipc.ts:251`) to spawn's ready-wait with the worker's own pane id +
nonce, so a pane that dies at t=10s ends the wait at the next liveness poll with `reason=pane_dead`,
not at 150s.

Not done: catching SIGKILL (impossible — step 1's single rename is the mitigation), or making spawn
return early and background the wait (its blocking contract is what every directive branches on).

### L2. Worker liveness from records the platform already holds (M)

**One ordered, exhaustive classifier** — `classifyWorkerLiveness(rec, status, outboxLen, snapshot,
misses, now)` in `src/core/job.ts`, evaluated top-down, first match wins:

| # | Condition | Verdict | Terminal? |
|---|---|---|---|
| 1 | `status.state` is terminal (`done`/`complete`/`error`) | `terminal` | — (already over) |
| 2 | `status.last_event == "spawn"` AND outbox empty AND `now - spawned_at > bootstrap_sleep_s + ready_timeout_s(model) + 60s` | `bootstrap-dead` | **yes** |
| 3 | pane present with the recorded nonce | `alive` | no |
| 4 | nonce not verifiable (pre-nonce record) | `unknown` | no |
| 5 | pane absent/foreign, consecutive misses `< 3` | `pane-missing (n/3)` | no |
| 6 | pane absent/foreign, consecutive misses `≥ 3` | `pane-dead` | **yes** |

Rule 2 precedes rule 3 on purpose: an expired seed with a LIVE pane is the killed-parent case
(spawn SIGTERMed before the seed could be stamped — exactly #157 if L1 is ever bypassed), and it is
dead by contract regardless of what the pane shows. The threshold is per-model from `contracts.yaml`,
not a constant: it is the deadline spawn itself would have applied.

Rules 5→6 are the answer to the empty-snapshot hazard. `livePaneNonces()` returns an empty map on ANY
tmux error (`tmux.ts:263-267`), which is correctly fail-closed for ownership — nothing gets killed or
nudged — but would be fail-OPEN for termination if a single miss were terminal: one tmux hiccup would
end a healthy run. So a miss is only terminal when it persists across three consecutive rescans, and
ANY hit resets the count. The counter lives in `_job/worker-liveness.json` (`{ "<agent>-<model>":
{misses, last_seen} }`), atomically written, owned by `job` — a layer records its own verdict. A
snapshot that is empty while the HUB's own pane is also missing is a whole-tmux outage, counted as a
miss for every worker the same way; three of those in a row IS a dead run.

**Surfaces:** `job status` prints one `WORKER=<agent>-<model> <verdict>` line per worker dir under the
topic (hub excluded); `ap list` gets the same column.

**`job wait` rescans INSIDE the wait, not before it.** `liveOutboxWait` already polls the hub pane
every 15s through `WaitLivenessOpts.paneAlive`; `job wait` supplies a composite probe that also runs
the worker classifier on each poll. When any worker reaches a terminal verdict mid-wait, the wait
returns a synthetic event and `job wait` prints exactly one line:

```
JS=worker-dead WORKER=<agent>-<model> VERDICT=<bootstrap-dead|pane-dead>
```

Bound on detection latency: `bootstrap-dead` fires at the per-model deadline (+60s) regardless of
polling; `pane-dead` fires at 3 misses × 15s cadence ≈ 45–60s after the pane actually vanishes.
Neither depends on the 3600s×3 hub budget.

Not done: auto-respawn (a second hub waking onto a live worker corrupts the run — existing rule), or
`job status` killing anything.

### L2b. The `JS=worker-dead` consumer contract — frozen before implementation

`JS=worker-dead` is **terminal for the origin loop**, handled like `question`: rc 0, print `$OUT`,
exit the loop. It gets its own `case` arm in BOTH canonical loops (`commands/quick.md`,
`commands/implement.md`) — never the catch-all, which prepends `JS=unreachable` and would yield two
`JS=` lines. Handling prose, both directives: *the job hub is alive but its worker is gone; the run
cannot progress. Do not re-arm. `job stop <TOPIC>` (L1's kill already ran for the spawn-killed case;
`stop` tears down the rest), then relaunch the same brief as a new job, or attach to investigate.*

The producer/consumer contract tests in `tests/job-cmd.test.ts` (the "exactly one `JS=` line" suite at
:126) gain the `worker-dead` row on both sides: the verb emits exactly one line, and the loop text in
each directive carries an explicit `*"JS=worker-dead"*` arm.

### L3. Directive (XS)

`commands/quick.md`, `commands/implement.md`, `config/prompt-templates/job-hub.md` (its existing
"Backgrounding" section): the spawn Bash call MUST carry `timeout: 300000` (≥ the largest
`bootstrap_sleep_s + ready_timeout_s` with margin); NEVER append `; echo "rc=$?"` (it masks the rc the
very next directive line branches on — both the failed run and its relaunch did this); NEVER an
unbounded `until … sleep` loop — the bounded verbs (`turn-wait`, `job wait`) are the only waits. A
contract test asserts each directive carries the timeout sentence; mutation: delete it -> red.

## Testing

- **L1 (fake runner + fake clock):** deliver SIGTERM mid-wait → in order: `status.json` state `error`
  / `spawn-killed`; `killNow` invoked with the created pane id; forensics file with `reason=killed`;
  FAILED archive dir exists; exit 143. Then `job status` on that topic shows the worker as `terminal`
  and `job stop` finds nothing dangling. Mutations: drop the handler → red; reorder status after
  archive → the "status first" assertion red; skip `killNow` → the `job stop`-finds-nothing assertion
  red. Pane-dead during the ready-wait ends at the liveness poll with `reason=pane_dead`. Mutation:
  drop the liveness opts → the wait runs the full timeout → red (fake clock).
- **L2 classifier (pure, table-driven):** one row per verdict, plus the three adversarial cases:
  live pane + expired seed → `bootstrap-dead` (rule 2 wins); absent pane + expired seed →
  `bootstrap-dead` (not `pane-dead`); ONE empty snapshot then recovery → `pane-missing (1/3)` then
  `alive`, never terminal. Mutation: swap rules 2 and 3 → the live-expired row red; make one miss
  terminal → the recovery row red.
- **L2 `job wait` (fake clock):** worker alive at call time, dies mid-wait → exactly one
  `JS=worker-dead …` line, returned within `3 × cadence` of the transition, not at the 3600s budget.
  Mutation: check only before the wait → red. The field case reproduced from the ARCHIVED records
  (`pane.json` spawned_at 15:03:33, seed status, empty outbox, snapshot without %89) →
  `bootstrap-dead`.
- **L2b:** `tests/job-cmd.test.ts` exactly-one-`JS=` suite gains `worker-dead`; a directive-contract
  test asserts both canonical loops carry the `worker-dead` arm. Mutation: delete the arm → red.
- **L3:** directive-contract tests (the existing pattern in `tests/implement-verify-tests.test.ts`).
- **Non-regression:** a healthy run's `job status` gains lines, changes none; the `JS=` invariant
  (exactly one line) holds for every existing outcome.

## Resolved questions (were open in rev 1)

1. SIGTERM grace: unknown and unprovable from a unit test, so L1 is ordered to survive a short one —
   the single atomic status rename first.
2. Threshold: per-model from `contracts.yaml`; it is spawn's own deadline, so there is one definition.
3. `JS=worker-dead` is terminal, rc 0, own loop arm, one line — decided above.
