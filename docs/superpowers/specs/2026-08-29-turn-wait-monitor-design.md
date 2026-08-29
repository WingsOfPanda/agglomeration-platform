# Turn waits are armed as a persistent Monitor — design

**Date:** 2026-08-29
**Issue:** [#161](https://github.com/WingsOfPanda/agglomeration-platform/issues/161)
**Version:** 0.5.55
**Scope:** directive text (`commands/quick.md`, `commands/implement.md`,
`config/prompt-templates/job-hub.md`) + tests. **No `src/` change, no protocol change.**

## Problem

The directives contradicted themselves about how a hub is allowed to wait.

For the **detached launch** path they were explicit. `commands/quick.md:35` and
`commands/implement.md:49`:

> Arm the watch as a persistent **Monitor**, never a plain background shell.

with the rationale spelled out at `commands/implement.md:63-64`:

> Why a Monitor: a background shell dies with this session and has no park/re-arm story, while a
> persistent Monitor is exactly what a monitor-handoff workflow can park before a session restart
> and re-arm after it.

Yet the **in-run turn waits** — the longest waits in the whole pipeline, budget
`AP_IMPLEMENT_TURN_TIMEOUT_S=14400` extended by `AP_WAIT_EXTEND_MULT` (default 3), so up to **12
hours** on one arming — used exactly the forbidden form:

| Site | Pre-0.5.55 text |
|---|---|
| `commands/quick.md:197` | `Bash(command='$CS quick turn-wait <SLUG> 1', run_in_background: true, description='quick await turn 1')` |
| `commands/quick.md:221-223` | question re-arm: "re-arm the background `quick turn-wait <SLUG> 1`" |
| `commands/quick.md:246` | turn-2 fix round: "background `$CS quick turn-wait <SLUG> 2`" |
| `commands/implement.md:282-283` | `Bash(command='$CS implement turn-wait "$TOPIC" "$ROUND"', run_in_background: true, description="hub await lead round=$ROUND")` |
| `commands/implement.md:345` | question re-arm: "re-run the background `turn-wait <TOPIC> <ROUND>`" |
| `config/prompt-templates/job-hub.md:98` | "Dispatch the directive's `*-wait` verbs with `run_in_background: true`" |

**The field failure.** ap 0.5.54, a detached `/ap:quick` run on GPU work, ~11 hours. The background
`turn-wait` task was killed from outside the run **twice**, while the worker was healthy and still
producing. A killed background task is *silent*: it produces no `TS=` line and no verdict, which is
byte-for-byte what a dead worker also produces. `commands/quick.md`'s `TS=failed`/`TS=timeout`
branch retries once and then **aborts the run unattended** —
`$CS quick summary … --aborted build worker-turn-failed` followed by `$CS stop <AGENT> <SLUG>`. Two
watcher kills would therefore have torn down a perfectly healthy 11-hour run, and the operator would
have read "worker turn failed twice" for a worker that never failed at all.

Two defects, then, not one:

1. **The wrong watcher.** The turn wait is the one place where losing the watcher is most expensive,
   and it used the form the same files call unsafe for a *shorter*-lived watch.
2. **A watcher failure was indistinguishable from a worker failure**, and the directive resolved
   that ambiguity in the destructive direction, with no hub judgment required.

## Goal

The in-run turn waits get the same watcher the launch path already mandates, and a dead or killed
watcher can never be read as a worker verdict — mechanically, not by hub judgment.

Non-goals: the `turn-wait` verb itself, its budget, its 0.5.15 turn-confirmation semantics, and the
`TS=` branch meanings are all unchanged. This changes the **arming mechanism** only. The waits in
`design`, `explore` and `bridge` are out of scope.

## Architecture

### 1. The Monitor shape

The turn wait is armed as a persistent Monitor whose command runs the **same bounded verb** and then
derives the outcome from the record that verb wrote:

```
Monitor(persistent: true, description: 'quick turn 1 <SLUG>', command: '
  $CS quick turn-wait <SLUG> 1 >/dev/null 2>&1
  F="<SLUG state>/_quick/execute/turn-1.txt"; TS=
  if [ -f "$F" ]; then while IFS= read -r L; do case "$L" in TS=*) TS=${L#TS=};; esac; done < "$F"; fi
  case "$TS" in
    ok|failed|timeout|question) printf "TS=%s\n" "$TS"; exit 0;;
    *) printf "TS=unreachable\n"; exit 1;;
  esac')
```

`implement` uses the identical shape over `$ART/turn-lead-<ROUND>.txt`. Three properties are
deliberate, and all three are borrowed from the launch-path loop this mirrors:

- **It wraps a bounded verb, not a poll loop.** There is no `until … sleep` anywhere in it — the
  prohibition that `tests/spawn-timeout-directive.test.ts` pins is untouched. The verb owns the
  budget, the liveness extension and the turn-confirmation vetoes exactly as before.
- **Every ending is LOUD.** The `case` is exhaustive: a real verdict exits 0 with its `TS=`, and
  everything else — an empty file, an absent file, a broken node, a shimmed binary, no output at all
  — exits 1 with `TS=unreachable`.
- **It shells out to nothing but `$CS`.** The read-back is pure shell (`while read` + `case`), not
  `grep | tail | cut`. On the box the launch-path fix came from, `grep` resolved through the same
  shimmed binary that had broken; a watch must not depend on one more binary than it has to. The
  last `TS=` line wins, which is the existing "turn-wait *appends* one `TS=` per wait" semantics
  reproduced in the watcher — the prose explaining that is preserved verbatim.

### 2. The watcher-failure rule

Beside each `TS=` branch list, both directives now carry:

> **`TS=unreachable` — or the Monitor task dying/killed with no output:** a wait that dies without a
> `TS=` line is a WATCHER failure, not a worker outcome. Never take the `TS=failed`/`TS=timeout`
> branch on it […] Verify the worker mechanically first — read `<state>/<agent>-<provider>/status.json`
> and run `$CS list <topic>`, whose `LIVENESS` column carries the 0.5.54 worker-liveness verdict (the
> same one `job wait` reports as `WORKER=`). A live/working worker means re-arm the same Monitor and
> keep waiting; only a terminal or dead verdict takes the matching TS branch.

This is the half that is not merely hygiene: it is what turns the field incident from a silent
teardown into a re-arm. It leans on machinery that already shipped — the worker-liveness classifier
from 0.5.54 (`src/core/workerLiveness.ts`, surfaced by `ap list`'s `LIVENESS` column and by `job
wait`'s `WORKER=`/`VERDICT=`) — so the check is mechanical and costs the hub no judgment.

### 3. Why the presence of a `TS=` line is the right discriminator (and no heartbeat is needed)

The tempting fix is a heartbeat: have the wait emit liveness periodically so a hub can tell "watcher
gone" from "worker gone". That is unnecessary, because **the verb already writes its own verdict to
a file, and only the verb writes it.**

- The `TS=` line exists **iff** `turn-wait` reached a decision. It is written by the verb, in the
  run's state dir, and survives the watcher process entirely.
- Therefore "no `TS=` line" is, by construction, a statement about the **watcher**, never about the
  worker: the worker's fate is unreadable from the wait's absence and must be read from the worker's
  own records instead.
- And those records already exist and are already classified. The discriminator needs no new signal,
  no new file, and no new protocol field — which is why this ships as directive text with zero `src`
  change.

A heartbeat would additionally have to be *trusted*, and a heartbeat that stops is exactly as
ambiguous as a wait that stops. The file the verb writes is the only artifact with the right
provenance.

### 4. The job hub's grant

`config/prompt-templates/job-hub.md` grants the detached hub the backgrounding authority an ordinary
worker is denied. That grant is now carved: the **turn** waits run the directive's Monitor block as
written; the other `*-wait` verbs (`research-wait`, `round-wait`, …) may still be backgrounded Bash;
everything else stays foreground. The `run_in_background: true` string stays in the template — it is
still the correct instruction for those other waits, and `tests/job-hub-template.test.ts:44` pins it.

## Components

| File | Change |
|---|---|
| `commands/quick.md` (Stage 1 step 4) | `Bash(… run_in_background: true …)` → `Monitor(persistent: true …)` + the "why not a background Bash" rationale |
| `commands/quick.md` (Stage 1 step 5, `TS=question` bullet) | re-arm the step-4 Monitor, not a background wait |
| `commands/quick.md` (Stage 1 step 5, `TS=failed`/`TS=timeout` bullet) | retry re-arms the step-4 Monitor |
| `commands/quick.md` (Stage 1 step 5, new bullet) | the `TS=unreachable` / watcher-failure rule |
| `commands/quick.md` (Stage 2 step 3) | the round-2 fix wait arms the step-4 Monitor for round 2 |
| `commands/implement.md` (Stage 1 step 2) | `Bash(… run_in_background: true …)` → `Monitor(persistent: true …)` + rationale |
| `commands/implement.md` (Stage 1 step 3, new bullet) | the `TS=unreachable` / watcher-failure rule |
| `commands/implement.md` (Stage 1 step 3, `TS=question` re-arm) | re-arm the step-2 Monitor |
| `config/prompt-templates/job-hub.md` (backgrounding paragraph) | turn waits are Monitors; other `*-wait` verbs may still be backgrounded |
| `tests/turn-wait-monitor.test.ts` (new) | the directive contract, both halves |
| `package.json`, `.claude-plugin/plugin.json` | 0.5.55 |

## Testing

`tests/turn-wait-monitor.test.ts` reads the two directives and the hub template as text and pins:

1. some `Monitor(persistent: true` block in each file **wraps the `turn-wait` verb** (so keeping only
   the launch-path Monitor still fails);
2. **no line** in either file matches both `turn-wait` and `run_in_background`, and the two exact
   pre-0.5.55 arming lines are gone by their literal text;
3. both files carry the Monitor's two `case` arms — the `TS=%s` verdict arm and the
   `TS=unreachable` arm — so the read-back cannot be quietly dropped;
4. both carry the sentence *"a wait that dies without a `TS=` line is a WATCHER failure, not a worker
   outcome"* verbatim **and on one line**, so a re-wrap cannot silently break the contract;
5. the `TS=unreachable` branch names a mechanical worker check (`status.json`) and says
   `re-arm the same Monitor` — a branch that merely exists but tells the hub nothing is not enough;
6. the launch-path rule ("persistent **Monitor**, never a plain background shell") is still present
   in both, since the turn-wait shape is argued from it;
7. `job-hub.md` still grants `run_in_background: true` for the other waits, no longer says
   "Dispatch the directive's `*-wait` verbs with `run_in_background: true`", and points at the
   directive's Monitor block.

Mutation evidence (run for real, both restored):

- **m1** — revert `commands/quick.md` step 4 to the old
  `Bash(… run_in_background: true, description='quick await turn 1')` line →
  3 failures: *"commands/quick.md's turn wait is not armed as a persistent Monitor"*,
  *"commands/quick.md still arms a turn wait with run_in_background: expected [ Array(1) ] to deeply
  equal []"*, *"commands/quick.md's Monitor never derives a TS="*.
- **m2** — delete the watcher-failure sentence from `commands/implement.md` → 2 failures:
  *"commands/implement.md lost the rule that saved the field run"* and
  *"commands/implement.md's unreachable branch names no mechanical worker check"*.

Pre-existing gates that must stay green and did: `tests/job-cmd.test.ts` (the launch-path Monitor
loop, pinned byte-for-byte), `tests/spawn-timeout-directive.test.ts` (the #158 spawn contract —
`timeout: 300000`, no `; echo "rc=$?"`, no unbounded `until … sleep`, `exits **143**`), and
`tests/job-hub-template.test.ts`.

## Success criteria

1. Neither directive arms a turn wait with a background shell; both arm it with a persistent Monitor
   wrapping the same bounded `turn-wait` verb. **Met.**
2. A watcher that dies without a verdict is a documented, named branch (`TS=unreachable`) in both
   directives, and that branch never takes a worker-failure action. **Met.**
3. The branch's remedy is mechanical (`status.json` + `ap list`'s 0.5.54 liveness verdict), not hub
   judgment. **Met.**
4. `turn-wait`'s semantics, budgets, turn-confirmation and `TS=` meanings are unchanged; no `src/`
   change ships with this. **Met.**
5. Full gate green: `typecheck`, `test`, `lint`, `build`. **Met.**
