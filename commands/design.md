---
description: Cross-verified multi-model research synthesized into a deploy-audit-passing design doc — Hub fast-path or escalate to a 2-3 worker ensemble
argument-hint: [--ensemble] <topic — what to research / design>
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, Skill, TodoWrite
---

# /ap:design

Run a cross-verified multi-model investigation on `$ARGUMENTS` and produce a single
deploy-schema design doc (Problem / Goal / Architecture / Components / Testing / Success
Criteria) that passes the deploy-audit gate — the artifact `/ap:implement` will consume.

Let `CS="node ${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs"`.

> **Claude** workers' task nudges carry the `ultracode` keyword by default — each dispatched turn
> opts into Claude Code's multi-agent Workflow orchestration (deeper work, more tokens; a harmless
> no-op without the Workflows feature). For a lean run, prefix every worker dispatch with
> `AP_ULTRACODE=0`.

## Progress tracking

Maintain a **TodoWrite** list so the user can see where the run is. Seed it after Stage 0 `init`
with a single `route` item; once Stage 1 decides the path, replace it with the path-appropriate
high-level stages:

- **fast-path:** `draft sections`, `assemble+audit`, `export+present`.
- **escalation:** `spawn ensemble`, `research`, `diff`, `cross-verify`, `adjudicate`,
  `design walk`, `assemble+audit`, `drilldown` (optional), `teardown+archive`, `export+present`.

## Flagging suspicions

At any point in the run, if something looks weird, surprising, or suspicious — even a likely false
alarm — record it: `$CS design flag <TOPIC> "<what looked off>"`. It becomes a comment on this run's
GitHub issue on the ap tracker (opening that issue if it is the run's first record), or a local queue
record when `gh` is unavailable, offline, or before this machine has answered the consent question —
queued records are flushed by the next successful filing or by `/ap:review`. Flags never ask for
consent, never block, and cost nothing, so prefer over-recording. Review later with `/ap:review`.

## Hub-side delegation

Three rules for the hub's own work on the escalation path (Stages 3-15), when your operator-level
model instructions (the AGENTS.md or CLAUDE.md your session loads for every repository, never a file
inside a repository) define an orchestrator/executor split. The fast path's two sentences (Stage 1
step 2, Stage 2) already cover the path where you research and draft alone.

- **Reading is delegable after the gate; the verbs are yours.** Subagents with an explicit cheaper
  model may read this run's artifacts — `findings.md`, `verify.md`, `diff.md`, `adjudicated.md`, the
  drill files — and enumerate or digest them, only after that phase's `wait-gate` has exited 0: the
  artifact gate binds whoever opens the file. Every `$CS` verb is keyed to YOUR cwd and writes this
  run's state: run them yourself; a subagent reports, you record and flag.
- **Driving the workers is your own turn.** `spawn-all`, every `*-send` and `*-wait`, `wait-gate`,
  the background waits and their completion notifications, the rc-3 AskUserQuestion, the `question`
  relays, the drilldown dispatch, `walk-approve` and every AskUserQuestion of the walk are never
  delegated: a subagent cannot ask the user, cannot relay, and its backgrounded waits die with it.
- **Your attestation is faithful representation.** Every claim, hedge, CONTESTED marker and citation
  you carry into a `PENDING` verdict, a relayed `ANSWER:`, a walked section, the drilldown summary or
  the reflection was read by you in the worker artifact or the cited source itself, in this turn; a
  subagent may enumerate which artifacts to open or digest them, never supply a claim, a verdict or
  a citation.

## Stage 0 — args-file + init

1. Mint an args path: `$CS design --mint-args-file` → prints `<args-path>`.
2. **Write tool:** `file_path` = `<args-path>`, `content` = `$ARGUMENTS` (verbatim, unquoted).
3. Init: `$CS design init --args-file <args-path>`. On success it prints to stdout:
   ```
   TOPIC=<slug>
   N=<2|3>
   ENSEMBLE=<yes|no>
   ART=<abs path to the _design art dir>
   PART=<agent>:<provider>   (one per worker)
   ```
   Non-zero aborts: rc 1 = empty topic OR fewer than 2 validated providers (redirect: just ask
   Claude directly — no orchestration needed); rc 2 = topic already in flight. Capture `TOPIC`/`N`/
   `ENSEMBLE`/`ART` for later stages — later stages read/write files under `$ART` and pass
   `<TOPIC>` to every subcommand.

## Stage 1 — routing

Decide fast-path vs escalation, in order:

1. `ENSEMBLE=yes` → **escalate**. Path label = `escalated-from-flag`.
2. Otherwise, run a **time-boxed quick research pass** on the topic (Read/Grep/Bash for repo code;
   WebSearch, plus whatever library-docs and code-intelligence tools this session has), then
   run the **4-signal complexity check** — escalate if **any one** fires (favor rigor):
   - **Conflicting evidence** — sources disagreed on a key claim.
   - **Significant assumptions** — you had to assume facts not in evidence.
   - **High-stakes** — architecture / security / irreversibility / production data.
   - **Subjective tradeoffs** — no objective right answer (A vs B, should-we-adopt-X).
   If any fires → **escalate**, Path label = `escalated-from-signals`.
   The research pass is grind: apply your own orchestrator/executor split — dispatch the searches
   and repo sweeps to subagents with an explicit cheaper model; the 4-signal check and the route
   decision stay with you.
3. None fire → **fast-path**, Path label = `fast`.

> **Routing → next stage.** After Stage 1 decides:
> - **fast-path** (`Path: fast`) → **Stage 2** (Hub quick, unchanged).
> - **escalate** (`escalated-from-flag` / `escalated-from-signals`) → **Stage 3** (the ensemble
>   pipeline below — research → diff → cross-verify → adjudicate → design walk).

## Stage 2 — fast-path (Hub quick)

You have already researched the topic in Stage 1 (or research it now if you arrived via the flag).
Draft the **6 deploy-schema sections** to `$ART/design-doc/.draft/<section>.md` using the **Write
tool** (atomic single-shot writes), one file per section:

- `.draft/problem.md` → `## Problem` + the current state: what is broken or missing today.
- `.draft/goal.md` → `## Goal` + the end state this work is aiming at. *(audit-required — never empty)*
- `.draft/architecture.md` → `## Architecture` + the recommended approach (the bulk). *(required)*
- `.draft/components.md` → `## Components` + bullets of files/functions/classes touched. **Lead each
  bullet with the file path** (`` - `src/x/foo.ts` — <what changes> ``) so `implement`'s scope-check
  can read it; a bullet that names only a function/class with no path contributes nothing to scope.
  **Every path you cite must exist in the target checkout — stat it before you cite it** (a phantom
  path costs the implementing worker a whole question round). A path that deliberately lives
  somewhere other than this checkout (a box-local config, a sibling repo) is tagged **`[on-box]`** on
  the same line — `` - `~/.ap/contracts.yaml` [on-box] — read at spawn time `` — which exempts that
  line from the path check; `assemble` warns (never fails) on every unmarked path it cannot find.
- `.draft/testing.md` → `## Testing` + bullets of test coverage. *(required)* **Lead each bullet with
  the test file path** (`` - `tests/foo.test.ts` — <what it asserts> ``), the same rule
  `.draft/components.md` carries above: `implement`'s scope-check counts Testing paths as declared
  scope, so a bullet naming only a behavior ("loss-contract gate enrollment") contributes nothing and
  the files it covers surface as out-of-scope at Stage 4. `implement audit` warns `<n> of <m> Testing
  bullets declare no path`, so the gap is visible before a worker is spawned.
- `.draft/success-criteria.md` → `## Success Criteria` + measurable bullets. *(required)*

Each section body should cite sources inline where applicable (`path/to/file:line`, URLs, runtime
observations). Every `path:line`, URL or runtime observation the doc cites, you opened or observed
yourself; a subagent may enumerate what to open, never originate a citation. Audit-required sections
must NOT be empty; if a section truly doesn't apply, still
emit the heading + a one-line explanation (never `_(skipped)_` on the four required ones).

Then assemble + audit: `$CS design assemble <TOPIC>`.
- **rc 0** → it prints the design-doc path. Run `EXPORTED=$($CS design export-doc <TOPIC> | sed -n
  's/^EXPORTED=//p')` to copy the doc into `docs/ap/specs/` (a non-zero `export-doc` is
  non-fatal — just skip the exported path). **Read and present** the doc to the user, state its
  location clearly — **`$EXPORTED` (docs/ap/specs/) as the primary, discoverable path**, with
  the `_design/design-doc/` path as the source — then point at the next step:
  `/ap:implement $EXPORTED`.
- **rc 1** (audit FAIL) → it printed `ISSUE=<code>` lines to stderr. Map each to its section
  (`no_goal_section`→goal, `no_arch_section`→architecture, `no_testing_section`→testing,
  `no_success_section`→success-criteria, `tbd_marker`/`todo_marker`/`fill_in_later_marker`/
  `to_be_determined_marker`→the section you left a marker in, `unresolved_placeholder`→architecture),
  **re-draft** the offending `.draft/<section>.md` (Write tool), and **re-run `$CS design assemble
  <TOPIC>` once**. If it FAILs again → surface the remaining ISSUE list to the user and stop.

## Stage 3 — escalation: preflight + batch-spawn

> Reached on **any** escalation. Stages 3–9 spawn the ensemble + research + diff + cross-verify +
> adjudicate; the design walk (Stage 10) then produces the doc.

Spawn the ensemble in one call: `$CS design spawn-all <TOPIC>`. It preflights N panes, spawns every
worker in parallel (`--target-pane`, `--cwd <repo>`), and writes `$ART/spawn-results.tsv` (TSV
`<agent>\t<provider>\t<rc>\t<reason>`). Branch on its rc:

- **rc 0** — all N workers ready → Stage 4.
- **rc 1** (partial) — read `$ART/spawn-results.tsv`; the rows with `rc==0` are the survivors. If
  **≥2 survive**, **rewrite `$ART/list.txt`** to only the survivor rows (TSV `<provider>\t<agent>`,
  one per line) and proceed degraded to Stage 4. If **<2 survive**, abort: run `/ap:stop
  <agent> <TOPIC>` for any ready worker, tell the user the ensemble could not reach 2 workers, and stop.
- **rc 2** (all failed) — retry once: `rm -f $ART/preflight-panes.txt $ART/spawn-results.tsv` and re-run
  `$CS design spawn-all <TOPIC>`. If it still returns rc 2, abort (redirect: "just ask Claude directly")
  and stop.

## Stage 4 — research dispatch (per worker)

Read the (possibly rewritten) list and send a research turn to each worker:

```bash
grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
  [ -n "$PROV" ] && [ -n "$INST" ] && { $CS design research-send <TOPIC> "$INST" "$PROV" || echo "SEND_FAILED=$INST rc=$?"; }
done
```

Each `research-send` composes the findings prompt, captures the pre-send outbox `OFFSET=` into
`$ART/research-<agent>.txt`, and nudges the worker.

**Non-zero rc from ANY `*-send` verb in this command** (this stage and Stage 7's verify dispatch):

- **rc 1** = the state file already exists (`rm` it to redo) or the send itself failed — in the
  latter case the state file is deliberately KEPT, so `rm` it before retrying.
- **rc 3** = **busy**: that worker's `status.json` state is not `idle`, so the send was refused and
  **nothing was written** — the stage stays runnable for that worker. **AskUserQuestion** ("Wait 60s
  and retry / Force-retry / Abort"):
  - *Wait 60s and retry* — `sleep 60`, then re-run the same `*-send` for that worker.
  - *Force-retry* — `$CS implement reset-status <TOPIC> <INST>` (atomically resets that worker to
    `idle`; the verb lives under `implement` but resolves the worker from the topic dir, so it works
    for design's workers too), then re-run the same `*-send`.
  - *Abort* — `/ap:stop <TOPIC>` for the ready workers, then stop.
- **rc 2** = usage error (a missing `<INST>`/`<PROV>` argument) — fix the call.

The `while` loops swallow each verb's rc, so both of them end their send with
`|| echo "SEND_FAILED=$INST rc=$?"`. **Read the loop's stdout**: any `SEND_FAILED=<INST> rc=<n>`
line means that worker was NOT dispatched — handle it per the rc list above before moving to the
stage's wait step, or that worker's wait will block on an event no one asked for.

## Stage 5 — research wait + question relay (per worker)

For **each** worker, await its research turn **in the background** (one call per worker):

```
Bash(command='$CS design research-wait <TOPIC> <INST> <PROV>', run_in_background: true,
     description='design research-wait <INST>')
```

On each completion notification, read that worker's **last** `FS=` line —
`FS=$(grep '^FS=' "$ART/research-<INST>.txt" | tail -1 | cut -d= -f2)` (`research-wait` *appends* one
`FS=` line per wait, so after a question→re-arm cycle the file holds e.g. `FS=question` then `FS=ok`;
the last line is the current outcome). Branch:

- **`FS=ok` / `FS=empty` / `FS=malformed`** — terminal; the worker's `findings.md` exists.
- **`FS=question`** — run the **classify + relay** (the design escalation; distinct from quick's never-ask):
  1. Read `$ART/question-<INST>.txt` (the captured question JSON — `message`, optional `options`) and
     the worker's `findings.md`.
  2. **Classify** the question against the findings: is it a **critical** decision only the user can
     make (high-stakes, irreversibility, a subjective product/architecture tradeoff)? → use
     **AskUserQuestion** to get the answer. Otherwise it is **non-critical** → answer it yourself from
     the topic + findings (Hub self-answers). The answer's every path, number and fact you read in
     this run's artifacts yourself in this turn; a subagent may digest the findings, never supply
     the answer.
  3. **Write** the reply to a temp file **beginning with a line `ANSWER: <your answer>`** (the worker's
     skill-hint reads the line starting `ANSWER: `), then `$CS send --from hub <INST> <TOPIC> @<reply-file>`.
  4. `rm -f $ART/research-<INST>.done` and **re-arm** the background `$CS design research-wait <TOPIC>
     <INST> <PROV>`. (The wait resumes past the question — it never re-sends the research prompt.)
- **`FS=failed` / `FS=timeout`** — the worker produced no usable findings; drop it.

You launched **N** background waits — expect **N** completion notifications, one per worker. These
waits, the gate below and the relay are your own turn — the `## Hub-side delegation` rules apply
here. On each, read that worker's last `FS=` line and handle it (relaying any `FS=question` via the
loop above, which re-arms that worker). **Do not proceed until
`$CS design wait-gate <TOPIC> research` exits 0** — it prints `<INST>\t<terminal|question|pending>`
for every worker and returns 0 only when all are `terminal`. rc 1 means at least one worker is still
`pending` (researching) or `question` (needs a relay): keep handling notifications / relay, then
re-run the gate. Only on rc 0 proceed. Then build the **diff list** = workers whose `findings.md`
exists (`FS` ∈ {ok, empty, malformed}). If **<2** workers have findings → abort (run
`/ap:stop <agent> <TOPIC>` for each ready worker, tell the user the ensemble could not produce 2
sets of findings, stop). If some workers were dropped, **rewrite `$ART/list.txt`** to the diff list
before Stage 6.

**Never read a worker's `findings.md` before this gate exits 0.** Each wait holds its worker open
until that phase's artifact ends with the literal `END_OF_ARTIFACT` line (grace `AP_ARTIFACT_GRACE_S`,
default 60s, floored at 10s; 0 disables the check entirely). It then records its own verdict as an
`AC=` line in that phase's state file: `AC=sentinel` (the line landed), `AC=quiescent` (no line, but
the file stopped growing — accepted anyway and flagged for `/ap:review`), or `AC=expired` (still
empty or still changing at the cap — flagged, and the validators discard that artifact). `AC=` is
about the FILE; the `FS=`/`VS=` value beside it stays a content classification, unchanged by expiry.

If `design diff` (or, for `verify.md`, `design adjudicate`) exits 1 printing `STILL_WRITING=<INST>`
on stderr, that phase's wait never ran for that worker (no `AC=` line) and its file is still being
written. **The recovery is to run the missing wait** — `$CS design research-wait <TOPIC> <INST>
<PROV>` (or `verify-wait`), which is what classifies — then re-run the verb; `wait-gate` alone
cannot fix it, it only reads state back. Re-running a wait is always safe and re-judges the artifact
(it resumes from the recorded `OFFSET=`, re-reads the same terminal event, and appends a fresh `AC=`
line), so it is also how you rescue an `AC=expired` worker whose file has since finished.
`design offset-reset <TOPIC> <INST> <phase>` re-arms the phase and clears that agent's strikes. What
happens to `$ART/<phase>-<INST>.txt` depends on the mode, and the `[ OK ]` line tells you which:
with **`--keep-findings`** the file is reduced to its last `OFFSET=` line (log suffix `state file
kept at OFFSET=<n>; re-arm the wait, or rm it to re-send`) — the worker's artifact survives, so
re-running the WAIT resumes from that offset and re-judges it, which is the recovery for a reset
landing on a still-busy worker; a re-SEND still needs the file removed first. Without the flag (the
full cascade) the file is **deleted** as before — the findings it pointed at are gone, so re-SEND is
the only move. A file that never carried an `OFFSET=` (nothing was ever sent) is deleted in both
modes, and no `state file kept` suffix is printed. The verb
self-bounds — three refusals with no growth
in between (or six refusals however much it grew) and it treats that worker as empty. When you quote
a worker's `findings.md`/`verify.md` into any doc, strip the trailing `END_OF_ARTIFACT` line.

## Stage 6 — N-way diff

`$CS design diff <TOPIC>` — N-way Venn bucketing over the workers' `findings.md`. It writes `$ART/diff.md`
plus the bucket files (`<inst>_only_items.txt` for N=2; `consensus.txt` + `<a>+<b>_only.txt` + singles
for N=3). rc 1 = `diff.md` already exists (`rm` to retry) or a `findings.md` is missing.

## Stage 7 — cross-verify dispatch (per worker)

Read the diff list (`$ART/list.txt`) and dispatch each worker's verify turn:

```bash
grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
  [ -n "$PROV" ] && [ -n "$INST" ] && { $CS design verify-send <TOPIC> "$INST" "$PROV" || echo "SEND_FAILED=$INST rc=$?"; }
done
```

`verify-send` computes each worker's scope (the bucket files where it is NOT a member), writes
`verify-claims-<inst>.txt`, and either sends the verify prompt (`OFFSET=` captured) or writes
`VS=skipped` when there's nothing for that worker to verify (no send).

## Stage 8 — cross-verify wait + question relay (per worker)

For each worker, background `$CS design verify-wait <TOPIC> <INST> <PROV>`. On each completion, read the
**last** `VS=` line (`grep '^VS=' "$ART/verify-<INST>.txt" | tail -1 | cut -d= -f2`):
- **`VS=ok` / `VS=skipped` / `VS=missing`** — terminal.
- **`VS=question`** — same classify+relay as Stage 5 (read `$ART/question-<INST>.txt` + the worker's
  `verify.md`; AskUserQuestion if critical else self-answer; write the reply file **beginning with a
  line `ANSWER: <your answer>`**, then `$CS send --from hub <INST> <TOPIC> @<reply>`; `rm -f
  $ART/verify-<INST>.done`; re-arm the background `verify-wait`).
- **`VS=failed` / `VS=timeout`** — record; the rival's claims this worker would have verified surface
  unresolved (N=2: a `## Not-verified` section; N≥3: they fall through the `UNCERTAIN` tier into
  PENDING/Contested) — either way Hub resolves them in Stage 9.
Expect **N** completion notifications (one per worker); handle each, relaying any `VS=question`. **Do
not proceed until `$CS design wait-gate <TOPIC> verify` exits 0** — it prints
`<INST>\t<terminal|question|pending>` per worker; rc 1 means some worker is still `pending`/`question`,
so keep handling / relay and re-run. Only on rc 0 continue.

## Stage 9 — adjudicate + resolve PENDING

1. `$CS design adjudicate <TOPIC>` → writes `$ART/adjudicated-draft.md` (5-tier for N≥3, 4-section for N=2).
2. `cp "$ART/adjudicated-draft.md" "$ART/adjudicated.md"`.
3. **Read** `$ART/adjudicated.md`. For **every** `- PENDING:` line: read the cited source, decide, and
   **Edit** the line in place — rewrite the `PENDING` prefix to `CONFIRMED`/`REFUTED`, or move the item
   under `## Contested`. The cited source behind every `PENDING` you resolve you opened yourself in
   this turn, and the verdict is yours; a subagent may list the `PENDING` lines or enumerate the
   sources to open, never supply the verdict. **Done only when no `- PENDING:` line remains**
   (`synthesize` refuses otherwise). You may also lead claim lines with a steer-tag —
   `- [Problem] …`, `- [Goal] …`, `- [Architecture] …`, `- [Components] …`, `- [Testing] …`,
   `- [Success Criteria] …` — to route them into the matching synthesize seed. First tag wins, so
   each line seeds at most one section; an untagged line seeds nothing (except the `testing`
   "contains test" heuristic), and a section with no tagged lines gets the placeholder for you to
   draft from.

## Stage 10 — interactive per-section design walk

1. Seed the drafts: `$CS design synthesize <TOPIC>` (refuses while any `- PENDING:` remains, or if
   `adjudicated.md` is missing). Writes the 6 `.draft/<section>.md`.
2. Resume check: `$CS design walk-state <TOPIC>` prints `<section>\t<approved|skipped>` for the
   sections the walk itself already settled (step 3 records them). A seeded or hand-written draft
   counts for nothing here — only a recorded verdict does. Skip exactly the sections it lists; walk
   every other one, including any whose draft already looks finished.
3. **Walk the 6 sections in order** (problem, goal, architecture, components, testing, success-criteria).
   For each: **Read** `$ART/design-doc/.draft/<section>.md` (the seed) + `$ART/adjudicated.md` + the
   workers' `findings.md`; **draft** the section and **Write** it to that `.draft/<section>.md` path;
   present it in chat; then **AskUserQuestion**: Approve / Revise / Skip. Reading the seed,
   `adjudicated.md` and the findings is delegable; the draft is yours, and every claim, hedge and
   citation in it you read in those files yourself in this turn — a subagent may digest, never
   supply a claim or a citation. Record the outcome of every settled section with
   `$CS design walk-approve <TOPIC> <section> <approved|skipped>` — unrecorded means unwalked, and a
   re-entry will walk it again.
   - **Approve** → `$CS design walk-approve <TOPIC> <section> approved`, next section.
   - **Revise** → take free-form direction via a follow-up, re-draft, re-present (cap 4 revises; after
     the cap, force-approve the current draft — record it `approved` — and move on).
   - **Skip** → Write `_(skipped)_` as the whole body, then `$CS design walk-approve <TOPIC>
     <section> skipped`. **Skip is NOT offered for the four audit-required sections** (goal,
     architecture, testing, success-criteria) — they must be drafted.
   - **components**, additionally: lead each bullet with the file path, and **stat every path before
     you cite it — it must exist in the target checkout** (a phantom path costs the implementing
     worker a whole question round). The stat sweep may be a subagent's; the path you cite you
     stat'd yourself in this turn. A path that deliberately lives elsewhere (a box-local config, a
     sibling repo) is tagged **`[on-box]`** on the same line, which exempts that line from the path
     check; Stage 11's `assemble` warns (never fails) on every unmarked path it cannot find.

## Stage 11 — assemble + deploy-audit gate (retry loop)

`$CS design assemble <TOPIC>`.
- **rc 0** → it prints the design-doc path. Immediately run `EXPORTED=$($CS design export-doc <TOPIC>
  | sed -n 's/^EXPORTED=//p')` to copy the doc into `docs/ap/specs/` **before** teardown/
  archive (Stages 13b/14) so the `_design` source still exists (a non-zero `export-doc` is non-fatal).
  **Read and present** the doc, then continue to Stage 12 (Phase F). Carry `$EXPORTED` to Stage 15.
- **rc 1** (audit FAIL) → it printed paired `ISSUE=<code>` + `SECTION=<mapped>` lines to stderr. For
  each `SECTION=`:
  - a **section name** (problem/goal/architecture/components/testing/success-criteria) → re-walk that
    one section (Stage 10 for it), then re-assemble.
  - `ASK` (a TBD/TODO/fill-in marker) → AskUserQuestion which section carries the marker, re-walk it.
  - empty (unknown code) → surface the raw `ISSUE=` and stop.
  Re-assemble after each fix; loop until rc 0 (bound to a few attempts per section, then surface the
  remaining ISSUEs and stop).

## Stage 12 — drilldown (optional; workers still live)

(Fast-path: no workers → skip Stages 12–14 entirely; go to Stage 15.) Derive the design-doc path
(`$ART/design-doc/<date>-<TOPIC>-design.md`, also printed by `assemble`; missing → tell the user and
skip drilldown). **AskUserQuestion**: "Any aspect to drill deeper before tearing down? (workers still
live)" — **Yes, drill** / **No, proceed to teardown**. While Yes, per round:
1. Free-form: **drill subject** (a section/topic) → SECTION; **focus angle** (e.g. "the tradeoffs feel
   hand-wavy") → FOCUS.
2. **AskUserQuestion which worker(s)** — an N-aware option set from `$ART/list.txt`: N=2 → the 2 workers +
   "both (parallel)"; N=3 → the 3 workers + 3 pairs + "all three (parallel)".
3. Dispatch (the CLI caps at 2 workers per call):
   - one or two workers → one call: `$CS design drilldown <TOPIC> "<SECTION>" "$ART/drilldowns" "<FOCUS>"
     <DESIGN_DOC> <i1> <m1> [<i2> <m2>]`.
   - **all three** → **two parallel** `$CS design drilldown …` Bash calls in one message (a K=2 call +
     a K=1 call) sharing `<TOPIC>` + `"$ART/drilldowns"`. Success if ≥1 call returns rc 0.
4. **Read back** `$ART/drilldowns/_scratch/drilldown-<section-slug>-*.md` and summarize. Reading the
   drill files is delegable; the summary you present is your own reading of them in this turn. On
   **rc 1** (all empty/timeout) → AskUserQuestion **Retry / Different aspect / Skip**. Then "Drill
   another aspect?" — loop or proceed.

The drill files stay in `_design/drilldowns/_scratch/` (out of `design-doc/`) and ride along into the
archive (Stage 14). Re-drilling the same section auto-suffixes `-2`, `-3`, ….

## Stage 13a — forensics filing + Hub reflection

`$CS design forensics <TOPIC>` (best-effort; scrapes the run for mechanical signals and files them as
a GitHub issue on the ap tracker — never blocks, never fails the run).

Read the single line `forensics` prints:

- `ISSUE=<url>` — filed on the ap tracker. Tell the user "forensics filed: <url>".
- `QUEUED=<path>` — kept in the local queue (no `gh`, offline, or consent declined); it is flushed by
  the next successful filing or by `/ap:review`. Tell the user forensics were queued.
- `CONSENT=needed` — this machine has never answered the consent question. See below.
- empty — no mechanical signals; nothing was filed.

**Consent — asked once per machine (attached runs only).** On `CONSENT=needed`, call
**AskUserQuestion**. Header `Issues`; question: "ap files run diagnostics as issues on the public
repo github.com/WingsOfPanda/agglomeration-platform — one issue per run with the topic, hostname,
username, paths, worker output and hub notes, for every repo you run ap in from this machine.
Allow?"; options `Allow (recommended for the team)` / `Never on this machine` / `Not now`.
Allow → `$CS review consent yes`, then `$CS review flush`. Never → `$CS review consent no`.
Not now → nothing (the record stays queued; you are asked again next run). Mid-run flags never
ask, and a detached run never asks — it queues.

Then **reflect**, whenever this run has a record — after `ISSUE=`, after `QUEUED=`, and after the
Allow → `$CS review flush` branch (that flush files the run and writes its record): Write 3-5 interpretive
bullets to a temp file and run `$CS design reflect <TOPIC> @<file>`. Write for a teammate who will
debug this from the issue alone: what the findings mean, what the hub did, what you would try first.
It posts them as the run issue's reflection comment. The bullets are yours — a subagent may digest
the run's records, never write them — and `reflect` runs once, from you. Once per run — a second
`reflect` is refused (rc 1); with no run record it prints `NO_RUN_ISSUE` and does nothing.

## Stage 13b — teardown (DONE banner)

Tear down all live workers in one shared banner: read the list agents from `$ART/list.txt` and
run `$CS stop --pairs <TOPIC> <agent…>` (one 9s graceful DONE-banner batch, then hard-kill +
per-worker archive). Per-worker failures are tolerated. (Equivalent fallback: `$CS stop <agent>
<TOPIC>` per worker.) Fast-path: no workers → skip.

## Stage 14 — archive

`$CS design archive <TOPIC>` → `archiveTopic(topic,'design')`: stamps every worker `status.json` to
`state=archived`, moves the whole `_design/` dir (including `drilldowns/`) to
`~/.ap/archive/<repo-hash>/<TOPIC>/_design-<ts>`, and rmdirs the topic. Stage 13a's issue lives on
GitHub, so archiving cannot lose it. Fast-path: skip (nothing beyond the doc).

## Stage 15 — present + implement handoff

**Read and present** the final design-doc. State its location clearly: **`$EXPORTED`
(`docs/ap/specs/`) is the primary, discoverable copy** (exported in Stage 11, survives
teardown/archive); the source `_design`/archive copy (`$ART/design-doc/<date>-<TOPIC>-design.md`, or
the archived path after Stage 14) is noted as provenance. Then point the user at the next step:
`/ap:implement $EXPORTED` — the deploy-audit gate already guarantees the doc is implement-ready.
This is the end of `design`.

## Notes

- Fast-path spawns no workers and writes no working artifacts beyond `topic.txt`, `.draft/*.md`, the
  assembled `design-doc/<date>-<slug>-design.md`, and `audit.log`. No teardown needed.
- Escalation runs Stages 3–11 (spawn-all → research → diff → cross-verify → adjudicate → synthesize →
  design walk → deploy-audit gate), then the wind-down (Stages 12–15: drilldown → forensics + Hub
  reflection → `stop` teardown → archive → present + implement handoff).
