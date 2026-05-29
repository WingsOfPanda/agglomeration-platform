---
description: Cross-verified multi-model research synthesized into a deploy-audit-passing design doc — Maestro fast-path or escalate to a 2-3 part ensemble
argument-hint: [--ensemble] [--targets a,b,c] <topic — what to research / design>
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, Skill
---

# /consort:score

Run a cross-verified multi-model investigation on `$ARGUMENTS` and produce a single
deploy-schema design doc (Problem / Goal / Architecture / Components / Testing / Success
Criteria) that passes the deploy-audit gate — the artifact `/consort:perform` will consume.

Let `CS="node ${CLAUDE_PLUGIN_ROOT}/dist/consort.cjs"`.

## Stage 0 — args-file + init

1. Mint an args path: `$CS score --mint-args-file` → prints `<args-path>`.
2. **Write tool:** `file_path` = `<args-path>`, `content` = `$ARGUMENTS` (verbatim, unquoted).
3. Init: `$CS score init --args-file <args-path>`. On success it prints to stdout:
   ```
   TOPIC=<slug>
   N=<2|3>
   ENSEMBLE=<yes|no>
   MODE=<single|single-sub|multi>
   ART=<abs path to the _score art dir>
   PART=<instrument>:<provider>   (one per part)
   ```
   `MODE` reflects `--targets`: `single` (none passed), `single-sub` (one), or `multi` (two or more).
   Non-zero aborts: rc 1 = empty topic OR fewer than 2 validated providers (redirect: just ask
   Claude directly — no orchestration needed); rc 2 = topic already in flight. Capture `TOPIC`/`N`/
   `ENSEMBLE`/`MODE`/`ART` for later stages — later stages read/write files under `$ART` and pass
   `<TOPIC>` to every subcommand.

## Stage 1 — routing

Decide fast-path vs escalation, in order:

1. `ENSEMBLE=yes` → **escalate**. Path label = `escalated-from-flag`.
2. Otherwise, run a **time-boxed solo research pass** on the topic (Read/Grep/Bash for repo code;
   WebSearch + any `mcp__tavily`/`mcp__anysearch` per the user's triple-search rule; `mcp__context7`
   for library docs; `mcp__codegraph` for code intelligence; relevant `superpowers:*` skills), then
   run the **4-signal complexity check** — escalate if **any one** fires (favor rigor):
   - **Conflicting evidence** — sources disagreed on a key claim.
   - **Significant assumptions** — you had to assume facts not in evidence.
   - **High-stakes** — architecture / security / irreversibility / production data.
   - **Subjective tradeoffs** — no objective right answer (A vs B, should-we-adopt-X).
   If any fires → **escalate**, Path label = `escalated-from-signals`.
3. None fire → **fast-path**, Path label = `fast`.

> **Routing → next stage.** After Stage 1 decides:
> - **fast-path** (`Path: fast`) → **Stage 2** (Maestro solo, unchanged).
> - **escalate** (`escalated-from-flag` / `escalated-from-signals`) **and `MODE=single`** → **Stage 3**
>   (the ensemble pipeline below — research → diff; Phase C ends at the diff).
> - **escalate and `MODE` is `multi` / `single-sub`** (i.e. `--targets` was passed): proceed into the
>   **multi-repo ensemble** — Stages 3–9 run unchanged (research → diff → cross-verify → adjudicate);
>   then Stage 10 honors the `--targets` short-circuit (targets already materialized by `init`) and
>   Stage 11 walks the 8 sections. `--targets` is itself the escalation signal — skip the fast-path
>   4-signal check.

## Stage 2 — fast-path (Maestro solo)

You have already researched the topic in Stage 1 (or research it now if you arrived via the flag).
Draft the **6 deploy-schema sections** to `$ART/design-doc/.draft/<section>.md` using the **Write
tool** (atomic single-shot writes), one file per section:

- `.draft/problem.md` → `## Problem` + 1-3 sentences on the current state.
- `.draft/goal.md` → `## Goal` + 1 paragraph on the end state. *(audit-required — never empty)*
- `.draft/architecture.md` → `## Architecture` + the recommended approach (the bulk). *(required)*
- `.draft/components.md` → `## Components` + bullets of files/functions/classes touched.
- `.draft/testing.md` → `## Testing` + bullets of test coverage. *(required)*
- `.draft/success-criteria.md` → `## Success Criteria` + measurable bullets. *(required)*

Each section body should cite sources inline where applicable (`path/to/file:line`, URLs, runtime
observations). Audit-required sections must NOT be empty; if a section truly doesn't apply, still
emit the heading + a one-line explanation (never `_(skipped)_` on the four required ones).

Then assemble + audit: `$CS score assemble <TOPIC>`.
- **rc 0** → it prints the design-doc path. **Read and present** the doc to the user, then point at
  the next step: `/consort:perform <path>` (once perform ships).
- **rc 1** (audit FAIL) → it printed `ISSUE=<code>` lines to stderr. Map each to its section
  (`no_goal_section`→goal, `no_arch_section`→architecture, `no_testing_section`→testing,
  `no_success_section`→success-criteria, `tbd_marker`/`todo_marker`/`fill_in_later_marker`/
  `to_be_determined_marker`→the section you left a marker in, `unresolved_placeholder`→architecture),
  **re-draft** the offending `.draft/<section>.md` (Write tool), and **re-run `$CS score assemble
  <TOPIC>` once**. If it FAILs again → surface the remaining ISSUE list to the user and stop.

## Stage 3 — escalation: preflight + batch-spawn (single-repo)

> Reached only when Stage 1 chose **escalate** and `MODE=single`.

Spawn the ensemble in one call: `$CS score spawn-all <TOPIC>`. It preflights N panes, spawns every
part in parallel (`--target-pane`, `--cwd <repo>`), and writes `$ART/spawn-results.tsv` (TSV
`<instrument>\t<provider>\t<rc>\t<reason>`). Branch on its rc:

- **rc 0** — all N parts ready → Stage 4.
- **rc 1** (partial) — read `$ART/spawn-results.tsv`; the rows with `rc==0` are the survivors. If
  **≥2 survive**, **rewrite `$ART/roster.txt`** to only the survivor rows (TSV `<provider>\t<instrument>`,
  one per line) and proceed degraded to Stage 4. If **<2 survive**, abort: run `/consort:coda
  <instrument> <TOPIC>` for any ready part, tell the user the ensemble could not reach 2 parts, and stop.
- **rc 2** (all failed) — retry once: `rm -f $ART/preflight-panes.txt $ART/spawn-results.tsv` and re-run
  `$CS score spawn-all <TOPIC>`. If it still returns rc 2, abort (redirect: "just ask Claude directly")
  and stop.

## Stage 4 — research dispatch (per part)

Read the (possibly rewritten) roster and send a research turn to each part:

```bash
grep -v '^#' "$ART/roster.txt" | while IFS=$'\t' read -r PROV INST; do
  [ -n "$PROV" ] && [ -n "$INST" ] && $CS score research-send <TOPIC> "$INST" "$PROV"
done
```

Each `research-send` composes the findings prompt, captures the pre-send outbox `OFFSET=` into
`$ART/research-<instrument>.txt`, and nudges the part. (rc 1 = state file already exists — `rm` it to redo.)

## Stage 5 — research wait + question relay (per part)

For **each** part, await its research turn **in the background** (one call per part):

```
Bash(command='$CS score research-wait <TOPIC> <INST> <PROV>', run_in_background: true,
     description='score research-wait <INST>')
```

On each completion notification, read that part's **last** `FS=` line —
`FS=$(grep '^FS=' "$ART/research-<INST>.txt" | tail -1 | cut -d= -f2)` (`research-wait` *appends* one
`FS=` line per wait, so after a question→re-arm cycle the file holds e.g. `FS=question` then `FS=ok`;
the last line is the current outcome). Branch:

- **`FS=ok` / `FS=empty` / `FS=malformed`** — terminal; the part's `findings.md` exists.
- **`FS=question`** — run the **classify + relay** (the score escalation; distinct from solo's never-ask):
  1. Read `$ART/question-<INST>.txt` (the captured question JSON — `message`, optional `options`) and
     the part's `findings.md`.
  2. **Classify** the question against the findings: is it a **critical** decision only the user can
     make (high-stakes, irreversibility, a subjective product/architecture tradeoff)? → use
     **AskUserQuestion** to get the answer. Otherwise it is **non-critical** → answer it yourself from
     the topic + findings (Maestro self-answers).
  3. **Write** the reply to a temp file, then `$CS send --from maestro <INST> <TOPIC> @<reply-file>`.
  4. `rm -f $ART/research-<INST>.done` and **re-arm** the background `$CS score research-wait <TOPIC>
     <INST> <PROV>`. (The wait resumes past the question — it never re-sends the research prompt.)
- **`FS=failed` / `FS=timeout`** — the part produced no usable findings; drop it.

**Proceed only when every part is terminal** (no `FS=question` outstanding). Then build the **diff
roster** = parts whose `findings.md` exists (`FS` ∈ {ok, empty, malformed}). If **<2** parts have
findings → abort (run `/consort:coda <instrument> <TOPIC>` for each ready part, tell the user the
ensemble could not produce 2 sets of findings, stop). If some parts were dropped, **rewrite
`$ART/roster.txt`** to the diff roster before Stage 6.

## Stage 6 — N-way diff

`$CS score diff <TOPIC>` — N-way Venn bucketing over the parts' `findings.md`. It writes `$ART/diff.md`
plus the bucket files (`<inst>_only_items.txt` for N=2; `consensus.txt` + `<a>+<b>_only.txt` + singles
for N=3). rc 1 = `diff.md` already exists (`rm` to retry) or a `findings.md` is missing.

## Stage 7 — cross-verify dispatch (per part)

Read the diff roster (`$ART/roster.txt`) and dispatch each part's verify turn:

```bash
grep -v '^#' "$ART/roster.txt" | while IFS=$'\t' read -r PROV INST; do
  [ -n "$PROV" ] && [ -n "$INST" ] && $CS score verify-send <TOPIC> "$INST" "$PROV"
done
```

`verify-send` computes each part's scope (the bucket files where it is NOT a member), writes
`verify-claims-<inst>.txt`, and either sends the verify prompt (`OFFSET=` captured) or writes
`VS=skipped` when there's nothing for that part to verify (no send).

## Stage 8 — cross-verify wait + question relay (per part)

For each part, background `$CS score verify-wait <TOPIC> <INST> <PROV>`. On each completion, read the
**last** `VS=` line (`grep '^VS=' "$ART/verify-<INST>.txt" | tail -1 | cut -d= -f2`):
- **`VS=ok` / `VS=skipped` / `VS=missing`** — terminal.
- **`VS=question`** — same classify+relay as Stage 5 (read `$ART/question-<INST>.txt` + the part's
  `verify.md`; AskUserQuestion if critical else self-answer; `$CS send --from maestro <INST> <TOPIC>
  @<reply>`; `rm -f $ART/verify-<INST>.done`; re-arm the background `verify-wait`).
- **`VS=failed` / `VS=timeout`** — record; the rival's claims this part would have verified are marked
  `Not-verified` by adjudicate.
Proceed when every part is terminal (no `VS=question` outstanding).

## Stage 9 — adjudicate + resolve PENDING

1. `$CS score adjudicate <TOPIC>` → writes `$ART/adjudicated-draft.md` (5-tier for N≥3, 4-section for N=2).
2. `cp "$ART/adjudicated-draft.md" "$ART/adjudicated.md"`.
3. **Read** `$ART/adjudicated.md`. For **every** `- PENDING:` line: read the cited source, decide, and
   **Edit** the line in place — rewrite the `PENDING` prefix to `CONFIRMED`/`REFUTED`, or move the item
   under `## Contested`. **Done only when no `- PENDING:` line remains** (`synthesize` refuses otherwise).
   You may also lead claim lines with a steer-tag — `- [Goal] …`, `- [Architecture] …`,
   `- [Components] …`, `- [Testing] …`, `- [Success Criteria] …` — to route them into the matching
   synthesize seed.

## Stage 10 — multi-repo detection

If `--targets` was passed, `$ART/multi-repo.txt` + `$ART/targets.txt` already exist (written by `init`
after validation) — **skip detection** and go to Stage 11.

Otherwise auto-detect: `$CS score detect-multi-repo <TOPIC> --cwd <HUB>` (HUB = the workspace dir whose
first-level subdirs are the candidate sub-projects; default is the conductor's cwd). It prints
`<slug>\t<abs-marker>` per sibling dir (with `CLAUDE.md`/`AGENTS.md`) whose slug case-insensitively
substring-matches `adjudicated.md`. Count the hit lines and branch:

- **0 hits** → single-repo. Write `single` to `$ART/multi-repo.txt` (no `targets.txt`, no prompt).
  Continue to Stage 11 (6-section walk).
- **1 hit** → **AskUserQuestion** (Header `Target`): "Topic targets sub-project `<slug>` (detected from
  sibling repos). Use it as the single sub-repo target, or treat as hub-level work?" — options
  **Use `<slug>`** / **Treat as hub-level**.
  - Use `<slug>` → write that hit's `<slug>\t<marker>` row to `$ART/targets.txt` (TSV) + `single-sub`
    to `$ART/multi-repo.txt`.
  - Treat as hub-level → `single` to `$ART/multi-repo.txt`, no `targets.txt`.
- **2+ hits** → **AskUserQuestion**: "Detected multi-repo candidates: `<slug list>`. Use these as
  targets, edit, or proceed single-repo?" — options **Use auto-detected list** / **Edit list** /
  **Proceed single-repo**.
  - Use list → write all hit rows (TSV) to `targets.txt` + `multi` to `multi-repo.txt`.
  - Edit list → free-form follow-up for a comma-separated slug list; **re-validate** each (must be a
    real sibling dir with a marker — same checks `init --targets` runs) and re-prompt on rejection;
    then **N≥2 edited slugs → `multi`, exactly 1 → `single-sub`** (an edit-down-to-1 is single-sub, NOT
    multi). Write `targets.txt` (TSV `<slug>\t<marker>`) accordingly.
  - Proceed single-repo → `single`, no `targets.txt`.

`targets.txt` rows are TSV `<slug>\t<abs-marker>` (the shape `detect-multi-repo`/`init` emit); a leading
`# generated …` comment line is optional (readers strip it). After this stage, `multi-repo.txt` ∈
{single, single-sub, multi}.

## Stage 11 — interactive per-section design walk

1. Seed the drafts: `$CS score synthesize <TOPIC>` (refuses while any `- PENDING:` remains, or if
   `adjudicated.md` is missing). Writes the 6 `.draft/<section>.md`.
2. Resume check: `$CS score walk-state <TOPIC>` prints `<section>\t<approved|skipped>` for drafts
   already settled — skip those on re-entry.
3. **Walk the 6 sections in order** (problem, goal, architecture, components, testing, success-criteria).
   For each: **Read** `$ART/design-doc/.draft/<section>.md` (the seed) + `$ART/adjudicated.md` + the
   parts' `findings.md`; **draft** the section and **Write** it to that `.draft/<section>.md` path;
   present it in chat; then **AskUserQuestion**: Approve / Revise / Skip.
   - **Approve** → keep, next section.
   - **Revise** → take free-form direction via a follow-up, re-draft, re-present (cap 4 revises; after
     the cap, force-approve the current draft and move on).
   - **Skip** → Write `_(skipped)_` as the whole body. **Skip is NOT offered for the four
     audit-required sections** (goal, architecture, testing, success-criteria) — they must be drafted.

### Stage 11 (multi-repo): the 8-section walk

When `multi-repo.txt` ∈ {single-sub, multi}: after `score synthesize` (still seeds the 6 base sections),
walk the **multi section list** — for `multi`, all 8 in this exact order (must match `SECTIONS_MULTI` in
`core/scoreDoc.ts`): **problem, goal, architecture, components, execution-dag, cross-repo-notes, testing,
success-criteria** (single-sub uses the 6 base sections + the singular header). The 2 multi-only sections
(`execution-dag`, `cross-repo-notes`) have **no synthesize seed** — draft them fresh. Resume via
`$CS score walk-state <TOPIC>`. Per-section rules:

- **architecture** (multi): draft a `### <slug>` subsection per target (read `$ART/targets.txt` col 1
  for the slugs) plus any shared/hub architecture. (Required — no Skip.)
- **cross-repo-notes**: a normal narrative section (Skip allowed) — per-target dependencies, ordering
  constraints, and shared contracts drawn from the parts' findings.
- **execution-dag**: the special gated section (below). (No Skip.)
- All other sections: exactly as the single-repo walk (the 4 required sections never offer Skip).

**execution-dag drafting + pre-Approve gate** (mirrors the bash predecessor's v0.54.0 gate; NO executor):
1. From the parts' cross-repo-dependency findings, **Write** `$ART/dag-rows.tsv` — one tab-separated
   `<step>\t<repo>\t<desc>\t<deps-csv|none>` row per step (`deps` = comma-separated upstream step
   numbers, or `none`). Then `$CS score emit-dag <TOPIC>` renders `.draft/execution-dag.md` as a
   `## Execution DAG` section (numbered `N. <repo> — <desc> (depends on M, N)` lines, em-dash U+2014).
2. **Pre-validate before presenting:** `$CS score check-dag <TOPIC>`.
   - **rc 0** → present the section; **AskUserQuestion Approve / Revise** (NO Skip — execution-dag is
     required in multi-repo).
   - **rc 1** → it printed the malformed line(s) to stderr. Do **not** offer the normal options; instead
     **AskUserQuestion**: **Revise** / **Force-Approve (override)** / **Abort**.
     - Revise → take direction, rewrite `dag-rows.tsv`, re-run `emit-dag`, re-loop the gate (cap 4 revises).
     - Force-Approve → keep the non-conforming draft as-is; the Stage-12 audit
       (`execution_dag_not_parseable`) will catch it.
     - Abort → stop the walk.
3. The drafted heading MUST be exactly `## Execution DAG` (a decorated heading silently disables the
   gate). score validates conformance only — it does NOT topo-sort, compute waves, or detect cycles
   (a cyclic-but-syntactically-valid DAG passes here and surfaces only at perform time).

## Stage 12 — assemble + deploy-audit gate (retry loop)

`$CS score assemble <TOPIC>`.
- **rc 0** → it prints the design-doc path. **Read and present** the doc, then point at
  `/consort:perform <path>` (once perform ships). Continue to Stage 13 (Phase F).
- **rc 1** (audit FAIL) → it printed paired `ISSUE=<code>` + `SECTION=<mapped>` lines to stderr. For
  each `SECTION=`:
  - a **section name** (problem/goal/architecture/components/testing/success-criteria) → re-walk that
    one section (Stage 11 for it), then re-assemble.
  - `ASK` (a TBD/TODO/fill-in marker) → AskUserQuestion which section carries the marker, re-walk it.
  - `execution-dag` (multi-repo, from `execution_dag_not_parseable`) → `rm $ART/design-doc/.draft/execution-dag.md`,
    re-walk that one section (re-runs the Stage-11 `emit-dag` + `check-dag` gate), re-assemble.
  - `header` (multi-repo, from `target_subproject_when_invalid` — a **single-sub** slug-validity failure;
    the plural multi `**Target Sub-Project(s):**` header is descriptive and not audited as a slug) →
    `rm -f $ART/multi-repo.txt $ART/targets.txt` and **bounce back to Stage 10** detection, then re-walk
    + re-assemble.
  - empty (unknown code) → surface the raw `ISSUE=` and stop.
  Re-assemble after each fix; loop until rc 0 (bound to a few attempts per section, then surface the
  remaining ISSUEs and stop).

## Stage 13 — drilldown (optional; parts still live)

(Fast-path: no parts → skip Stages 13–15 entirely; go to Stage 16.) Derive the design-doc path
(`$ART/design-doc/<date>-<TOPIC>-design.md`, also printed by `assemble`; missing → tell the user and
skip drilldown). **AskUserQuestion**: "Any aspect to drill deeper before tearing down? (parts still
live)" — **Yes, drill** / **No, proceed to teardown**. While Yes, per round:
1. Free-form: **drill subject** (a section/topic) → SECTION; **focus angle** (e.g. "the tradeoffs feel
   hand-wavy") → FOCUS.
2. **AskUserQuestion which part(s)** — an N-aware option set from `$ART/roster.txt`: N=2 → the 2 parts +
   "both (parallel)"; N=3 → the 3 parts + 3 pairs + "all three (parallel)".
3. Dispatch (the CLI caps at 2 parts per call):
   - one or two parts → one call: `$CS score drilldown <TOPIC> "<SECTION>" "$ART/drilldowns" "<FOCUS>"
     <DESIGN_DOC> <i1> <m1> [<i2> <m2>]`.
   - **all three** → **two parallel** `$CS score drilldown …` Bash calls in one message (a K=2 call +
     a K=1 call) sharing `<TOPIC>` + `"$ART/drilldowns"`. Success if ≥1 call returns rc 0.
   - multi-repo: append the target `<subproject>` slug as the final arg to scope the drill; the output
     file then carries the `-<subproject>-` infix.
4. **Read back** `$ART/drilldowns/_scratch/drilldown-<section-slug>-*.md` (tolerate an optional
   `-<subproject>-` infix) and summarize. On **rc 1** (all empty/timeout) → AskUserQuestion **Retry /
   Different aspect / Skip**. Then "Drill another aspect?" — loop or proceed.

The drill files stay in `_score/drilldowns/_scratch/` (out of `design-doc/`) and ride along into the
archive (Stage 15). Re-drilling the same section auto-suffixes `-2`, `-3`, ….

## Stage 14a — forensics capture + Maestro reflection

`FORENSICS=$($CS score forensics <TOPIC>)` (best-effort; prints a path only if mechanical signals were
found, else empty — never blocks). If `FORENSICS` is non-empty: tell the user "forensics captured:
$FORENSICS", then **Read** it and **append** a `## Maestro reflection` section (3–5 interpretive bullets:
what's surprising, repeat-vs-first-time patterns, the suggested next action — a memory worth saving, a
spec topic, a patch, or a one-off) via the Write/Edit tool. **Idempotent:** skip the append if the file
already contains the exact header `## Maestro reflection`. The forensics file lives under
`~/.consort/forensics/<date>/` — OUTSIDE the topic state — so it survives teardown + archive.

## Stage 14b — teardown (FINE banner)

Tear down all live parts in one shared banner: read the roster instruments from `$ART/roster.txt` and
run `$CS coda --pairs <TOPIC> <instrument…>` (one 9s graceful FINE-banner batch, then hard-kill +
per-part archive). Per-part failures are tolerated. (Equivalent fallback: `$CS coda <instrument>
<TOPIC>` per part.) Fast-path: no parts → skip.

## Stage 15 — archive

`$CS score archive <TOPIC>` → `archiveTopic(topic,'score')`: stamps every part `status.json` to
`state=archived`, moves the whole `_score/` dir (including `drilldowns/`) to
`~/.consort/archive/<repo-hash>/<TOPIC>/_score-<ts>`, and rmdirs the topic. The forensics file from
Stage 14a is untouched (it lives outside the state tree). Fast-path: skip (nothing beyond the doc).

## Stage 16 — present + perform handoff

**Read and present** the final design-doc (`$ART/design-doc/<date>-<TOPIC>-design.md` — the path
`assemble` printed; after Stage 15 it's the archived copy). Then point the user at the next step:
"run `/consort:perform <doc>` once perform ships" — the deploy-audit gate already guarantees the doc is
perform-ready (single-repo AND multi-repo). This is the end of `score`.

## Notes

- Fast-path spawns no parts and writes no working artifacts beyond `topic.txt`, `.draft/*.md`, the
  assembled `design-doc/<date>-<slug>-design.md`, and `audit.log`. No teardown needed.
- Escalation Stages 3–12 (spawn-all → research → diff → cross-verify → adjudicate → synthesize →
  design walk → deploy-audit gate), single-repo AND multi-repo (detection → 8-section walk → execution
  DAG), ship in Phases C–E. The wind-down (Stages 13–16: drilldown → forensics + Maestro reflection →
  `coda` teardown → archive → present + perform handoff) ships in Phase F. `score` is now complete
  end-to-end; only the other high-level commands (`perform` / `prelude` / `rehearsal` / `playback`)
  remain unbuilt.
