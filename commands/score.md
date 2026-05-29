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
   PART=<instrument>:<provider>   (one per part)
   ```
   `MODE` reflects `--targets`: `single` (none passed), `single-sub` (one), or `multi` (two or more).
   Non-zero aborts: rc 1 = empty topic OR fewer than 2 validated providers (redirect: just ask
   Claude directly — no orchestration needed); rc 2 = topic already in flight. Capture `TOPIC`/`N`/
   `ENSEMBLE`/`MODE` for later stages.

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

> **Phase B scope — two stubbed cases.** The full **escalation** path (spawn a 2-3 part ensemble →
> research → diff → cross-verify → adjudicate → walk → audit) and the **multi-repo** pipeline are
> **not yet built** — they land in Phases C–E. Before proceeding to Stage 2, branch on `MODE`:
>
> - **`MODE=single` and Stage 1 selected escalation** (`ENSEMBLE=yes`, or a complexity signal fired):
>   tell the user plainly: "the cross-verified ensemble path is not yet available in this build
>   (Phases C–E); producing a Maestro-solo (fast-path) single-repo doc instead — re-run once the
>   ensemble ships for cross-verification," then **proceed to Stage 2**. (Phases C–E replace this
>   stub with the real escalation pipeline.)
> - **`MODE` is `multi` or `single-sub`** (i.e. `--targets` was passed): do **NOT** proceed to the
>   fast-path — a multi doc would assemble placeholder Execution DAG / Cross-Repo Notes sections that
>   pass the audit while silently under-serving the multi-repo intent. Tell the user plainly:
>   "multi-repo runs (`--targets`) need the full ensemble + design-walk pipeline, which lands in
>   Phase E; re-run without `--targets` for a single-repo fast-path doc," and **stop**. (Phase E
>   replaces this stop with the real multi-repo pipeline.)

## Stage 2 — fast-path (Maestro solo)

You have already researched the topic in Stage 1 (or research it now if you arrived via the flag).
Draft the **6 deploy-schema sections** to `<TOPIC art>/_score/design-doc/.draft/<section>.md` using
the **Write tool** (atomic single-shot writes), one file per section:

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

## Notes

- Fast-path spawns no parts and writes no working artifacts beyond `topic.txt`, `.draft/*.md`, the
  assembled `design-doc/<date>-<slug>-design.md`, and `audit.log`. No teardown needed.
- The escalation pipeline (ensemble, diff, cross-verify, adjudicate, the interactive design walk,
  multi-repo execution-DAG, drilldown) arrives in later phases.
