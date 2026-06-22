---
description: Deep multi-aspect exploration — SOTA surveys, multi-angle thinking, adversary-tested landscape doc that feeds /ap:design
argument-hint: <topic>
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, WebFetch, Skill
---

# /ap:explore

Deep multi-aspect exploration of `$ARGUMENTS`. The Hub orchestrates an N-worker research
pass — classifying the topic up front to tell each worker how much to weight academic-paper
retrieval — synthesizes a preliminary landscape doc, runs a 5-signal confidence gate, dispatches
all N workers as adversaries against the synthesis if the gate doesn't let the user skip, then writes
a final landscape doc with a tradeoff matrix + adversary critiques + a directional Conclusion. The
Conclusion is the hand-off seed for `/ap:design`, emitted as `design-handoff.md`. **The Hub
itself never runs retrieval — workers are the only retrievers.** The intended workflow is
`explore → design → implement`.

**When to use this command.** Invoke `/ap:explore` when the user wants to explore SOTA,
think deeply, survey a landscape, or research a hard topic from multiple angles WITHOUT committing
to a buildable plan — "explore SOTA …", "find new architectures for …", "deep think about …",
"survey the landscape of …". Phrases that route to `/ap:design` instead (they need a buildable
spec): "design X", "build X", "compare A vs B to decide", "should we adopt …". The line is fuzzy;
explore's Conclusion feeds design's next research round.

Let `CS="node ${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs"`.

## Flagging suspicions

At any point in the run, if something looks weird, surprising, or suspicious — even a likely false
alarm — record it: `$CS explore flag <TOPIC> "<what looked off>"`. It writes straight to the review
feed (survives teardown and aborts) and costs nothing, so prefer over-recording. Review later with
`/ap:review`.

## Task list (TaskCreate × 11 before Phase 0)

Create the task list with `TaskCreate`. Update statuses at the phase boundaries below. Per-worker
rows are intentionally absent (N varies 2 or 3); each `[workers]` row covers the whole list in
parallel.

| # | subject | activeForm |
|---|---|---|
| 0   | `0 Args + init + list [hub]`         | `Staging args` |
| 1   | `1 Literature auto-detect [hub]`       | `Classifying topic` |
| 2   | `2 Parallel spawn [hub]`               | `Spawning workers` |
| 3   | `3 Research dispatch [workers]`              | `Dispatching research` |
| 4   | `4 Research wait [workers]`                  | `Workers researching` |
| 5   | `5 Preliminary synthesis [hub]`        | `Synthesizing draft` |
| 5.5 | `5.5 Confidence gate [hub + user]`     | `Evaluating confidence` |
| 6   | `6 Adversary dispatch [workers]`             | `Dispatching adversary` |
| 7   | `7 Adversary wait [workers]`                 | `Workers attacking synthesis` |
| 8   | `8 Final synthesis [hub]`              | `Writing final landscape` |
| 9   | `9 Teardown + archive + handoff [hub]` | `Tearing down` |

## Phase 0 — args + init + list

Set task `0` → `in_progress`.

1. Mint an args path: `$CS explore --mint-args-file` → prints `<args-path>`.
2. **Write tool:** `file_path` = `<args-path>`, `content` = `$ARGUMENTS` (verbatim, unquoted). Never
   echo it into a shell.
3. Init: `$CS explore init --args-file <args-path>`. On success it prints to stdout (logs go to
   stderr):
   ```
   TOPIC=<slug>
   N=<2|3>
   ART=<abs path to the _explore art dir>
   PART=<agent>:<provider>   (one per worker)
   ```
   Capture `TOPIC` / `N` / `ART` and the `PART=` agent:provider pairs — later phases read/write
   files under `$ART` and pass `<TOPIC>` to every subcommand. Non-zero exit aborts:
   - **rc 1** = empty topic OR fewer than 2 validated providers (redirect: just ask Claude directly
     — no orchestration needed).
   - **rc 2** = topic already in flight (run `/ap:stop` or pick a different topic).

   Surface stderr verbatim and stop on a non-zero rc.

Set task `0` → `completed`.

## Phase 1 — literature auto-detect

Set task `1` → `in_progress`.

`$CS explore classify <TOPIC>` — classifies the topic via keyword scan and writes
`$ART/lit-track.txt`. The result is consumed by Phase 3's per-worker research prompt (it tells each
worker how much to weight academic-paper retrieval). **The Hub itself never runs retrieval —
classify only weights how the workers retrieve.** rc 1 = `$ART` missing (init didn't run).

Set task `1` → `completed`.

## Phase 2 — parallel spawn (spawn-retry-once)

Set task `2` → `in_progress`.

Spawn the whole list in one call: `$CS explore spawn-all <TOPIC>`. It preflights N panes off your
pane, spawns every worker in parallel (`--target-pane`, `--cwd <repo>`), and writes
`$ART/spawn-results.tsv`. Branch on its rc:

- **rc 0** → all N workers ready. Continue to Phase 3.
- **rc 1 or 2, FIRST failure** → cold-start tolerance: reset the partial spawn
  (`$CS explore teardown <TOPIC> --panes-only` — kills the partial panes + clears the attempt
  artifacts but **preserves** `list.txt`/`topic.txt`/research state) and retry
  `$CS explore spawn-all <TOPIC>` **ONCE**. (Do NOT use a plain `teardown` for the retry — that
  archives the whole `_explore` dir, so the immediately-following `spawn-all` fails with
  "list.txt missing".)
- **rc 1 or 2, after the retry (second failure)** → retry exhausted. Tear down
  (`$CS explore teardown <TOPIC>`), `rm -rf "$ART/../"` (the topic state dir — its parent is
  `<topic>/`, of which `_explore` is a child), and abort. Surface the specific provider failures from
  `$ART/spawn-results.tsv` to the user and stop.

Set task `2` → `completed`.

## Phase 3 — parallel research dispatch

Set task `3` → `in_progress`.

Issue **N parallel Bash calls in one message** (one per worker), using the `PART=<agent>:<provider>`
pairs from init:

```
$CS explore research-send <TOPIC> <agent> <provider>
```

Each `research-send` renders that worker's research prompt — already weighted by `$ART/lit-track.txt`
(Phase 1) — captures the pre-send outbox `OFFSET=` into `$ART/research-<agent>.txt`, and nudges
the pane. The Hub orchestrates and synthesizes; the workers do all retrieval. (rc 1 = the state
file already exists — `rm` it to redo.)

Set task `3` → `completed`.

## Phase 4 — parallel research wait

Set task `4` → `in_progress`.

For **each** worker, await its research turn **in the background** — issue N background-await Bash
calls in parallel in one message:

```
Bash(command='$CS explore research-wait <TOPIC> <agent> <provider>', run_in_background: true,
     description='explore research-wait <agent>')
```

Each `research-wait` blocks on that worker's `done`/`error`/`question` outbox event, then appends an
`FS=` line to `$ART/research-<agent>.txt` and writes the
`$ART/research-<agent>.done` sentinel.

**Do not proceed until `$CS explore wait-gate <TOPIC> research` exits 0** — it prints `<INST>\t<terminal|question|pending>` per worker and returns 0 only when every worker is terminal. rc 1 means at least one worker is still `pending` (researching) or `question` (needs a relay): keep handling notifications / relay, then re-run the gate. The `FS=`
value is informational — do **NOT** gate on `FS=ok`; a worker with `FS=empty`/`FS=malformed` still
produced its `findings-<agent>.md` and the synth validator (Phase 5) catches truly missing
findings. If a worker emits a `question` event (its state file's last line shows `FS=question`),
handle it via **Intervention Pattern 1** before proceeding.

Set task `4` → `completed`.

## Phase 5 — preliminary synthesis (Hub Writes)

Set task `5` → `in_progress`.

Run the input validator: `$CS explore synth-preliminary <TOPIC>`. It prints the draft path
`$ART/landscape-draft.md` on stdout; **rc 1** if inputs are missing (topic.txt, list.txt, or any
`findings-<agent>.md` empty) — surface the missing-file list and stop.

Then **use the Write tool** to author `landscape-draft.md`, reading every `$ART/findings-<agent>.md`,
with this EXACT section set:

```markdown
## Topic
<verbatim from $ART/topic.txt>

## Approaches
1. <approach name> — <one-line summary, clustered across findings>
2. ...

## Tradeoff matrix
| Priority | Best fit | Reason (with citation) |
|----------|----------|------------------------|
| ...      | ...      | ...                    |

## Findings by worker
### <agent> (<provider>)
<digest of findings-<agent>.md>

## Open questions
- ...

## Citations
- ...
```

Label **CONTESTED** claims explicitly (this is confidence signal S3). Every Tradeoff-matrix Reason
cell MUST contain at least one citation — a file path, URL, or paper-id (this is signal S4).

Set task `5` → `completed`.

## Phase 5b — annotate (Hub runs; no task row)

`$CS explore annotate <TOPIC>` — a deterministic transparency overlay. It marks **single-source
citations** (cited by `< 2` workers) with `[unverified]` and **uncited tradeoff rows** with
`[no citation]`, editing `landscape-draft.md` in place and writing `$ART/annotations.json` (counts,
for `/ap:review`) + `$ART/annotate-applied.txt` (the idempotency marker). It runs under task `5` (no
new TaskCreate row).

This pass is **annotation-only and gate-neutral**: by construction it leaves all five confidence
signals byte-identical, so the Phase 5.5 gate below sees exactly what it would have on the raw draft —
the markers exist for the final landscape doc and a downstream `/ap:design` reader, not to change the
gate. **rc 1** if `landscape-draft.md` or any `findings-<agent>.md` is missing/empty; a re-run with
`annotate-applied.txt` present is a no-op (crash/resume-safe). Citations on `## Approaches` lines are
recorded in `annotations.json` but **not** inlined (inlining there would perturb signal S1).

## Phase 5.5 — confidence gate

Set task `5.5` → `in_progress`.

`$CS explore confidence <TOPIC>` → evaluates the 5 signals against `landscape-draft.md` + findings,
logs `S1`–`S5` to stderr, and prints `ALL_HOLD=<bool>` to stdout.

**Branch on `ALL_HOLD`:**

- **`ALL_HOLD=false`** (the common case — the gate is intentionally strict) → the verb has already
  written `$ART/adversary-skip.txt` with `user_decision: not-offered`. No prompt. **Fall through to
  Phase 6.**
- **`ALL_HOLD=true`** (rare) → fire **AskUserQuestion** (Header `Adversary`):
  - Option 1 (recommended) **"Run adversary (default — safer)"** — re-dispatch all N workers in
    parallel to challenge the synthesis; catches blind spots the gate may have missed (~5-8 min).
  - Option 2 **"Skip adversary, write Conclusion now"** — trust the preliminary synthesis; jump
    straight to the final landscape doc with Conclusion (saves ~5-8 min).

  Record the choice: `$CS explore confidence <TOPIC> --decision <skip|continue>` (writes
  `adversary-skip.txt` with the user's decision).
  - User chose **skip** → set tasks `5.5`/`6`/`7` → `completed` (adversary skipped), then
    **jump to Phase 8**.
  - User chose **continue** → proceed to Phase 6.

Set task `5.5` → `completed`.

## Phase 6 — adversary dispatch (skipped if user accepted skip)

Set task `6` → `in_progress` (or `completed` immediately if skipped).

Issue **N parallel Bash calls in one message** (one per worker):

```
$CS explore adversary-send <TOPIC> <agent> <provider>
```

Each `adversary-send` renders that worker's adversary prompt against `landscape-draft.md`, captures
the pre-send `OFFSET=` into `$ART/adversary-<agent>.txt`, and nudges the pane.

Set task `6` → `completed`.

## Phase 7 — adversary wait (skipped if Phase 6 skipped)

Set task `7` → `in_progress`.

For each worker, issue an N-way background-await Bash call in parallel in one message (mirror Phase 4):

```
Bash(command='$CS explore adversary-wait <TOPIC> <agent> <provider>', run_in_background: true,
     description='explore adversary-wait <agent>')
```

**Do not proceed until `$CS explore wait-gate <TOPIC> adversary` exits 0** — it prints `<INST>\t<terminal|question|pending>` per worker; rc 1 means some worker is still `pending`/`question`, so keep handling / relay and re-run. Only on rc 0 continue. The `AS=` value is
informational (do NOT gate on `AS=ok`). Same question handling as Phase 4 — if a worker's state file's
last line shows `AS=question`, handle via **Intervention Pattern 1** before proceeding. A malformed
or empty adversary critique is handled by **Intervention Pattern 2**.

Set task `7` → `completed`.

## Phase 8 — final synthesis (Hub Writes)

Set task `8` → `in_progress`.

Run the input validator: `$CS explore synth-final <TOPIC>`. It prints the canonical output path
`$ART/landscape-<date>-<topic>.md` on stdout. If adversary ran (the gate didn't record
`user_decision: skip`), it requires every `adversary-<agent>.md` and **rc 1** with a
missing-file list otherwise — surface and stop.

Then **use the Write tool** to author the final doc, reading `$ART/landscape-draft.md` + all
`$ART/adversary-<agent>.md` (if adversary ran), with this EXACT section set:

```markdown
## Topic
<from $ART/topic.txt>

## Approaches
<carried from the draft, possibly revised per adversary critiques>

## Tradeoff matrix
<carried from the draft, possibly revised per adversary critiques>

## Adversary critiques
- **<agent> (<provider>):** <one-paragraph summary of adversary-<agent>.md>
- ...

## Open questions
<merged from the draft + new questions raised by the adversary critiques>

## Conclusion
<the Hub's directional take — see below>

## Citations
<collected from all findings + adversary critiques>
```

**If adversary was SKIPPED**, replace the `## Adversary critiques` body with this blockquote note:

> _Adversary phase skipped after the confidence gate passed and the user accepted skip. Findings
> are single-pass — no post-synthesis challenge was implemented._

**The `## Conclusion`** is the hand-off seed for `/ap:design`. It must:

- Name the strongest approach + state explicit caveats.
- List the adversary-surfaced weaknesses the design phase must address.
- Suggest a concrete next invocation:
  `/ap:design Design <X> using approach <A>, with mitigations for <flagged-issue>`.
- If user priorities would shift the answer, point to the matrix row that changes it.

Set task `8` → `completed`.

## Phase 8a — forensics

`$CS explore forensics <TOPIC>` (best-effort; never blocks — prints a path only if mechanical
signals were found, else empty). If it printed a path, use the **Write/Edit tool** to APPEND a
`## Hub reflection` section to that file — 3-5 short bullets interpreting the mechanical findings
— **BEFORE** the Phase 9 teardown moves the art dir. Idempotent: skip the append if the file already
contains the exact header `## Hub reflection`. The forensics file lives outside the topic state
tree, so it survives teardown + archive.

## Phase 9 — teardown + archive + handoff-extract

Set task `9` → `in_progress`.

1. **Pane teardown first.** Read the list agents and run
   `$CS stop --pairs <TOPIC> <agent…>` — one 9s graceful **DONE**-banner batch across all panes
   (not N × 9s), then hard-kill + per-worker archive. Per-worker failures are tolerated.
2. **Archive the state.** `$CS explore teardown <TOPIC>` — orphan-kills any leftover preflight panes,
   archives the `_explore` dir, and prints the archive destination on stdout. **Rebind `ART` to that
   printed archive path** (the `_explore` archive location) for the handoff steps below. The final
   landscape doc now lives at `$ART/landscape-<date>-<topic>.md`.
3. **Extract handoff data.** `$CS explore handoff-extract "$ART"` — pass the **rebound archived
   art-dir** as the positional (this verb takes the art-dir path, NOT a topic). It writes
   `$ART/handoff-data.kv` with the mechanical fields (`mode`, `topic`, `landscape_doc`,
   `confidence_signals`, adversary-findings paths, findings paths, etc.). A non-zero rc (rc 2 =
   `topic.txt` missing under `$ART`) means inputs were missing — log it and **SKIP Phase 9c** (warn,
   do not crash).

## Phase 9c — compose design-handoff.md (Hub Writes)

Read `$ART/handoff-data.kv` (the mechanical facts) AND the landscape doc it names via
`landscape_doc=`. As Hub, **use the Write tool** to author `$ART/design-handoff.md` with this
six-section schema IN ORDER:

```markdown
# <topic>

Source: explore session at $ART
Generated: <generated_ts from the KV>

## Recommendation
<1-3 paragraphs of English prose (no bullets). Names the convergent approach. Past tense for
evidence, active voice.>

## Recipe
<Prescriptive distillation — the technique to adopt, key parameters, the differentiator from
runner-up approaches. Cite paper URLs / repo paths as $ART/<basename> (see Appendix); do NOT inline
lengthy quotes.>

## Constraints (carry-forward)
<Inline the confidence_signals from the KV (e.g. "S1=true,S2=true,S3=false,S4=true,S5=true") plus
any adversary findings (quote the key challenge per critique when adversary ran). When the adversary
phase was skipped, note: "No adversarial review implemented — the design plan should preserve room for
that uncertainty.">

## Open questions
<Emit ONLY when the landscape doc surfaced genuine unresolved planning decisions that design's
drilldown will not naturally close (CONTESTED markers, multiple equally-strong approaches the survey
couldn't separate). If research closed everything, OMIT the WHOLE section — no header, no stub.>

## Evidence
<A citations table from ## Approaches + ## Tradeoff matrix:
| Source | Claim | Strength |
|--------|-------|----------|
| <paper / repo file:line> | <claim> | strong \| medium \| weak |
Then report the confidence-gate result: parse confidence_signals → "<N>/5 passed".>

## Appendix: artifacts
ALL PATHS ABSOLUTE. Interpolate each KV value as $ART/<value> (where $ART is the rebound archive
dir). Do NOT prefix, transform, or rewrite paths. If a KV value already starts with `/`, emit it
verbatim WITHOUT prepending $ART.
- Source session: $ART
- Landscape doc: $ART/<landscape_doc>
- Findings / adversary findings: comma-separated $ART/<basename> entries from the KV
- Full topic: $ART/<topic_txt_path>
```

**No-convergence branch** (`mode=explore-no-convergence` in `handoff-data.kv`):
- `## Recommendation` reads: "Survey did not converge on a single best approach. See Evidence for
  contested findings and the tradeoff matrix."
- **OMIT `## Recipe`** entirely (no convergent approach → no recipe).
- `## Open questions` may capture the contested-decision axes the survey exposed but couldn't resolve.

Set task `9` → `completed`.

## Phase 10 — present

Print to the user:

```
Explore complete.

Landscape doc:
  $ART/landscape-<date>-<topic>.md

Handoff doc (pipe directly into design):
  $ART/design-handoff.md

Suggested next step:
  /ap:design $ART/design-handoff.md

(Or hand-edit the topic to investigate a different angle.)
```

## Intervention patterns

The Hub regains control between every phase (file-IPC, not in-process messaging). If a worker
produces unexpected output, intervene before the next subcommand runs.

### Pattern 1: worker question event

A worker emits `{"event": "question", ...}`. The wait verb sets `FS=question` (research) or
`AS=question` (adversary) as the state file's last line and captures the question JSON to
`$ART/question-<agent>.txt`. Read that file (its `message`, optional `options`), compose an
answer from the topic + findings, then relay it:
`$CS send --from hub <agent> <TOPIC> "<answer>"`. The wait verb already advanced the
`OFFSET=`; `rm -f "$ART/research-<agent>.done"` (or `adversary-<agent>.done`) and re-arm
that worker's background wait. The wait resumes past the question — it never re-sends the prompt.

### Pattern 2: malformed adversary output

A worker's `adversary-<agent>.md` is empty or missing its `## Verdict` line. Re-dispatch that one
worker once with a clarifying inbox payload pointing at the missing structure
(`$CS send --from hub <agent> <TOPIC> "<clarification>"`). If a second attempt still fails,
mark that worker's critique as `(unavailable)` in the final landscape doc.

### Pattern 3: stuck spawn / cold-start failure

Already absorbed by Phase 2's auto-retry-once mechanism. If the retry also fails, Phase 2 tears down,
removes the topic state dir, and aborts with the provider-failure list. No further intervention.
