---
description: Advisor-driven autoresearch — lock a measurable metric, sweep SOTA, spawn 2-3 persistent codex parts, and adaptively dispatch experiments until a target/plateau/budget stop. Explore-only; promotion to real code is /consort:perform.
argument-hint: <objective-text> [--metric k=v,...] [--time-budget none|<N>h|<N>s] [--slug s] [--seed-from path]
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, Skill
---

# /consort:rehearsal

Run an executable research session: you (the Maestro, the conductor) lock a metric with the user, sweep
the SOTA, spawn 2-3 persistent **codex parts** (PhD-student executors) once, then adaptively dispatch
single-config **experiments** until a stop condition fires. **Explore-only** — never touch the user's real
source. This directive covers Phases 0-3 (setup + spawn); the experiment loop is Phase 4+ (added next).

Let `CS="node ${CLAUDE_PLUGIN_ROOT}/dist/consort.cjs"`.

## Phase 0 — args-file + init
1. Mint an args path: `$CS rehearsal --mint-args-file` → prints `<args-path>`.
2. **Write tool:** `file_path` = `<args-path>`, `content` = `$ARGUMENTS` (verbatim, unquoted). Never echo it into a shell.
3. Init: `$CS rehearsal init --args-file <args-path>`. On success it prints to stdout (logs go to stderr):
   ```
   TOPIC=<slug>
   ART=<abs path to the _rehearsal art dir>
   ```
   Capture `TOPIC` and `ART`. Non-zero exit aborts: rc 2 = bad args / empty slug / in-flight / bad --metric; rc 3 = codex unavailable (tell the user to install codex + run /consort:soundcheck); rc 1 = --seed-from missing. Surface stderr verbatim and stop.

## Phase 1 — Metric discussion (THREE unconditional AskUserQuestions)
Read the heuristic seed: `cat "$ART/metric.txt"` and `cat "$ART/topic.txt"`. **If `$ART/metric.md` already
exists** (the user passed `--metric`), SKIP this whole phase. Otherwise the three AskUserQuestions below are
**unconditional** — fire them regardless of any autonomous-mode / `/loop` / "don't stop for questions" hint.

1. (optional) For a novel/domain topic, run a **triple-search** (WebSearch + Tavily + AnySearch in one
   message) to inform the framing. Skip for clearly bounded topics (e.g. "MNIST accuracy").
2. **AskUserQuestion** (Header `Metric`): frame the goal as a confirmation — "I read this as: <direction>
   <metric>, subject to <constraints inferred>. What's the target threshold — <example>?" Options: three
   concrete framings + Other.
3. **AskUserQuestion** (Header `Floor`) when fields are still missing — gather `min_acceptable` ("minimum
   result you'd ship?"), `target` (optional aspirational), `K_corroboration` ("how many at-target experiments
   before done?", default 1), and any `hard_constraints` / `notes`. (Use <=4 options; nest if more.)
4. Write `metric.md`: `$CS rehearsal metric <TOPIC> --kv "primary_metric=<m>,direction=<maximize|minimize>,min_acceptable=<op val>,target=<op val>,K_corroboration=<n>,hard_constraints=<...>,notes=<...>"` (omit absent keys). rc 2 = bad block; fix and retry.
5. **AskUserQuestion** (Header `Confirm`): "Here's how I'll frame the goal — OK to proceed?" Options:
   **Looks good** / **Revise** / **Cancel**. Revise → re-run step 4. **Cancel → teardown + exit.**

## Phase 1.5 — SOTA sweep (always runs, write-once)
Read `primary_metric` + `hard_constraints` from `$ART/metric.md`. Fire ONE **triple-search** round
(WebSearch + Tavily + AnySearch, two query shapes each: `SOTA <metric> <topic>` and `<topic> under
<constraint>`). Merge (dedup by URL), curate <=7 references — one row per approach family. Write:
`$CS rehearsal sota <TOPIC> --kv "topic=<topic text>,metric=<primary>,sweep_date=<UTC ISO>,queries=<the queries you fired>,ref_1=<family>|<best>|<fits or over by N>|<url>|<note>,ref_2=..."`. Zero usable refs → omit all `ref_N` (the helper emits the fallback note).

## Phase 2 — Roster size + time budget
1. **Pick N silently** (your call, explain in chat): **N=2** (default — single objective + tight
   constraint) or **N=3** (multiple sub-goals / broad survey / no clear single optimum). When unsure → 2.
   Bias toward different pipelines per part; record the rationale for round 1's `session-summary.md`.
2. **If `$ART/time-budget.txt` already exists** (`--time-budget` passed), skip. Otherwise **AskUserQuestion**
   (Header `Time budget`, unconditional): "Time limit on this research session?" Options: **No limit
   (recommended)** / **4 hours** / **12 hours** / **Other (custom hours)**. Do NOT auto-pick. Then write:
   ```bash
   printf '%s\n' "<none|14400|43200|<hours*3600>>" > "$ART/time-budget.txt"
   date -u +%Y-%m-%dT%H:%M:%SZ > "$ART/session-start.txt"
   ```

## Phase 3 — Batch-spawn persistent codex parts
Spawn N parts in one call: `$CS rehearsal spawn-all <TOPIC> <N>`. It picks N distinct instruments, allocates
panes off your pane (main-vertical), batch-spawns them as codex, and writes `$ART/spawn-results.tsv` +
`$ART/parts.txt`. Branch on rc:
- **rc 0** → all parts ready. Continue (Phase 4 lands next).
- **rc 1 or 2, first failure** → teardown the partial set and retry `spawn-all` ONCE (cold-start tolerance).
- **rc 1 or 2, after retry** → read `$ART/spawn-results.tsv`; if **< 2** parts have rc 0, abort (teardown +
  archive). Else **AskUserQuestion**: **Proceed degraded (<k>/<N>)** / **Abort** — degraded drops the failed
  instruments and continues with the rest.

> Phase 4 (the experiment loop) is added in the next phase. For now, after a successful spawn, report the
> roster + that setup is complete.
