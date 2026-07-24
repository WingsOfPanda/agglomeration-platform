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
high-level stages, marking each `in_progress` on entry and `completed` on exit:

- **fast-path:** `draft sections`, `assemble+audit`, `export+present`.
- **escalation:** `spawn ensemble`, `research`, `diff`, `cross-verify`, `adjudicate`,
  `design walk`, `assemble+audit`, `drilldown` (optional), `teardown+archive`, `export+present`.

## Flagging suspicions

At any point in the run, if something looks weird, surprising, or suspicious — even a likely false
alarm — record it: `$CS design flag <TOPIC> "<what looked off>"`. It writes straight to the review
feed (survives teardown and aborts) and costs nothing, so prefer over-recording. Review later with
`/ap:review`.

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
   WebSearch + any `mcp__tavily`/`mcp__anysearch` per the user's triple-search rule; `mcp__context7`
   for library docs; `mcp__codegraph` for code intelligence), then
   run the **4-signal complexity check** — escalate if **any one** fires (favor rigor):
   - **Conflicting evidence** — sources disagreed on a key claim.
   - **Significant assumptions** — you had to assume facts not in evidence.
   - **High-stakes** — architecture / security / irreversibility / production data.
   - **Subjective tradeoffs** — no objective right answer (A vs B, should-we-adopt-X).
   If any fires → **escalate**, Path label = `escalated-from-signals`.
3. None fire → **fast-path**, Path label = `fast`.

> **Routing → next stage.** After Stage 1 decides:
> - **fast-path** (`Path: fast`) → **Stage 2** (Hub quick, unchanged).
> - **escalate** (`escalated-from-flag` / `escalated-from-signals`) → **Stage 3** (the ensemble
>   pipeline below — research → diff → cross-verify → adjudicate → design walk).

## Stage 2 — fast-path (Hub quick)

You have already researched the topic in Stage 1 (or research it now if you arrived via the flag).
Draft the **6 deploy-schema sections** to `$ART/design-doc/.draft/<section>.md` using the **Write
tool** (atomic single-shot writes), one file per section:

- `.draft/problem.md` → `## Problem` + 1-3 sentences on the current state.
- `.draft/goal.md` → `## Goal` + 1 paragraph on the end state. *(audit-required — never empty)*
- `.draft/architecture.md` → `## Architecture` + the recommended approach (the bulk). *(required)*
- `.draft/components.md` → `## Components` + bullets of files/functions/classes touched. **Lead each
  bullet with the file path** (`` - `src/x/foo.ts` — <what changes> ``) so `implement`'s scope-check
  can read it; a bullet that names only a function/class with no path contributes nothing to scope.
- `.draft/testing.md` → `## Testing` + bullets of test coverage. *(required)*
- `.draft/success-criteria.md` → `## Success Criteria` + measurable bullets. *(required)*

Each section body should cite sources inline where applicable (`path/to/file:line`, URLs, runtime
observations). Audit-required sections must NOT be empty; if a section truly doesn't apply, still
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
  [ -n "$PROV" ] && [ -n "$INST" ] && $CS design research-send <TOPIC> "$INST" "$PROV"
done
```

Each `research-send` composes the findings prompt, captures the pre-send outbox `OFFSET=` into
`$ART/research-<agent>.txt`, and nudges the worker. (rc 1 = state file already exists — `rm` it to redo.)

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
     the topic + findings (Hub self-answers).
  3. **Write** the reply to a temp file **beginning with a line `ANSWER: <your answer>`** (the worker's
     skill-hint reads the line starting `ANSWER: `), then `$CS send --from hub <INST> <TOPIC> @<reply-file>`.
  4. `rm -f $ART/research-<INST>.done` and **re-arm** the background `$CS design research-wait <TOPIC>
     <INST> <PROV>`. (The wait resumes past the question — it never re-sends the research prompt.)
- **`FS=failed` / `FS=timeout`** — the worker produced no usable findings; drop it.

You launched **N** background waits — expect **N** completion notifications, one per worker. On each,
read that worker's last `FS=` line and handle it (relaying any `FS=question` via the loop above, which
re-arms that worker). **Do not proceed until `$CS design wait-gate <TOPIC> research` exits 0** — it
prints `<INST>\t<terminal|question|pending>` for every worker and returns 0 only when all are
`terminal`. rc 1 means at least one worker is still `pending` (researching) or `question` (needs a
relay): keep handling notifications / relay, then re-run the gate. Only on rc 0 proceed. Then build the **diff
list** = workers whose `findings.md` exists (`FS` ∈ {ok, empty, malformed}). If **<2** workers have
findings → abort (run `/ap:stop <agent> <TOPIC>` for each ready worker, tell the user the
ensemble could not produce 2 sets of findings, stop). If some workers were dropped, **rewrite
`$ART/list.txt`** to the diff list before Stage 6.

## Stage 6 — N-way diff

`$CS design diff <TOPIC>` — N-way Venn bucketing over the workers' `findings.md`. It writes `$ART/diff.md`
plus the bucket files (`<inst>_only_items.txt` for N=2; `consensus.txt` + `<a>+<b>_only.txt` + singles
for N=3). rc 1 = `diff.md` already exists (`rm` to retry) or a `findings.md` is missing.

## Stage 7 — cross-verify dispatch (per worker)

Read the diff list (`$ART/list.txt`) and dispatch each worker's verify turn:

```bash
grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
  [ -n "$PROV" ] && [ -n "$INST" ] && $CS design verify-send <TOPIC> "$INST" "$PROV"
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
   under `## Contested`. **Done only when no `- PENDING:` line remains** (`synthesize` refuses otherwise).
   You may also lead claim lines with a steer-tag — `- [Goal] …`, `- [Architecture] …`,
   `- [Components] …`, `- [Testing] …`, `- [Success Criteria] …` — to route them into the matching
   synthesize seed.

## Stage 10 — interactive per-section design walk

1. Seed the drafts: `$CS design synthesize <TOPIC>` (refuses while any `- PENDING:` remains, or if
   `adjudicated.md` is missing). Writes the 6 `.draft/<section>.md`.
2. Resume check: `$CS design walk-state <TOPIC>` prints `<section>\t<approved|skipped>` for drafts
   already settled — skip those on re-entry.
3. **Walk the 6 sections in order** (problem, goal, architecture, components, testing, success-criteria).
   For each: **Read** `$ART/design-doc/.draft/<section>.md` (the seed) + `$ART/adjudicated.md` + the
   workers' `findings.md`; **draft** the section and **Write** it to that `.draft/<section>.md` path;
   present it in chat; then **AskUserQuestion**: Approve / Revise / Skip.
   - **Approve** → keep, next section.
   - **Revise** → take free-form direction via a follow-up, re-draft, re-present (cap 4 revises; after
     the cap, force-approve the current draft and move on).
   - **Skip** → Write `_(skipped)_` as the whole body. **Skip is NOT offered for the four
     audit-required sections** (goal, architecture, testing, success-criteria) — they must be drafted.

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
4. **Read back** `$ART/drilldowns/_scratch/drilldown-<section-slug>-*.md` and summarize. On **rc 1**
   (all empty/timeout) → AskUserQuestion **Retry / Different aspect / Skip**. Then "Drill another
   aspect?" — loop or proceed.

The drill files stay in `_design/drilldowns/_scratch/` (out of `design-doc/`) and ride along into the
archive (Stage 14). Re-drilling the same section auto-suffixes `-2`, `-3`, ….

## Stage 13a — forensics capture + Hub reflection

`FORENSICS=$($CS design forensics <TOPIC>)` (best-effort; prints a path only if mechanical signals were
found, else empty — never blocks). If `FORENSICS` is non-empty: tell the user "forensics captured:
$FORENSICS", then **Read** it and **append** a `## Hub reflection` section (3–5 interpretive bullets:
what's surprising, repeat-vs-first-time patterns, the suggested next action — a memory worth saving, a
spec topic, a patch, or a one-off) via the Write/Edit tool. **Idempotent:** skip the append if the file
already contains the exact header `## Hub reflection`. The forensics file lives under
`~/.ap/forensics/<date>/` — OUTSIDE the topic state — so it survives teardown + archive.

## Stage 13b — teardown (DONE banner)

Tear down all live workers in one shared banner: read the list agents from `$ART/list.txt` and
run `$CS stop --pairs <TOPIC> <agent…>` (one 9s graceful DONE-banner batch, then hard-kill +
per-worker archive). Per-worker failures are tolerated. (Equivalent fallback: `$CS stop <agent>
<TOPIC>` per worker.) Fast-path: no workers → skip.

## Stage 14 — archive

`$CS design archive <TOPIC>` → `archiveTopic(topic,'design')`: stamps every worker `status.json` to
`state=archived`, moves the whole `_design/` dir (including `drilldowns/`) to
`~/.ap/archive/<repo-hash>/<TOPIC>/_design-<ts>`, and rmdirs the topic. The forensics file from
Stage 13a is untouched (it lives outside the state tree). Fast-path: skip (nothing beyond the doc).

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
