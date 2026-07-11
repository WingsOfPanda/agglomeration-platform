---
description: Deep multi-aspect exploration — SOTA surveys, multi-angle thinking, adversary-tested landscape doc that feeds /ap:design
argument-hint: <topic>
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, WebFetch, Skill, TaskCreate, TaskUpdate
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

## Task list (TaskCreate × 17 before Phase 0)

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
| 4a  | `4a Survivor filter [hub]`             | `Filtering survivors` |
| 4b  | `4b Open-questions relay [workers]`    | `Relaying open questions` |
| 4c  | `4c Peer cross-verify [workers]`       | `Cross-verifying peer claims` |
| 5   | `5 Preliminary synthesis [hub]`        | `Synthesizing draft` |
| 5.5 | `5.5 Confidence gate [hub + user]`     | `Evaluating confidence` |
| 6   | `6 Adversary dispatch [workers]`             | `Dispatching adversary` |
| 7   | `7 Adversary wait [workers]`                 | `Workers attacking synthesis` |
| 7b  | `7b Bounded rebuttal [workers]`        | `Workers defending claims` |
| 7c  | `7c Gap enrichment [workers]`          | `Workers filling gaps` |
| 8   | `8 Final synthesis [hub]`              | `Writing final landscape` |
| 8b  | `8b Worker sign-off [workers]`         | `Workers signing off` |
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

## Phase 4a — survivors (N-1 continuation)

Set task `4a` → `in_progress`.

`$CS explore survivors <TOPIC>` — keeps only the `list.txt` rows whose `findings-<agent>.md` is
non-empty (the exact predicate Phase 5's validator uses), preserving the full original roster at
`$ART/list-original.txt` the first time it rewrites (a re-run never overwrites it). Branch on rc /
stdout:

- **rc 1** → zero survivors: every findings file is missing or empty. Surface the error, run the
  Phase 9 teardown steps (stop --pairs + teardown), and abort.
- **`SURVIVORS=<N>` with no `DROPPED=` lines** → everyone survived. Continue to Phase 4b.
- **`DROPPED=<agent>` lines** → those workers are OUT of the run from here on. Every later phase
  derives its worker set fresh from the rewritten `$ART/list.txt` (the per-phase read below);
  Phase 9 stops/archives the dropped panes from `list-original.txt`. Record it:
  `$CS explore flag <TOPIC> "survivors: dropped <agent> — empty findings"`. Continue.
- **`DEGRADED=1`** (exactly one survivor) → DEGRADED RUN. Set tasks `4b`/`4c`/`7b`/`7c` →
  `completed` immediately (skipped: `diff` and `crossverify-send` refuse below 2 workers; rebuttal
  and gap depend on the diff buckets). Still run Phase 5 → 5b → 5.5 (S2 goes false naturally — all
  citations are solo — so the adversary fires) → Phase 6/7 as a single-worker adversary (the
  prompt composer already tolerates zero peers) → Phase 8 → Phase 8b (sign-off is exactly the
  misattribution check a single-source survey needs) → Phase 9. Phase 9c MUST stamp the degraded
  caveat into the handoff `## Constraints` (see Phase 9c). On a crash-recovery re-run, `SURVIVORS=1`
  with no `DROPPED=` lines ALSO means a degraded run when `$ART/list-original.txt` exists (the verb
  only prints `DEGRADED=1` on the run that performs the drop).

**Worker-set rule for every phase after this one:** phases 4b, 4c, 6, 7, 7b, 7c, and 8b derive
their worker rows fresh from the CURRENT `$ART/list.txt` at dispatch time — never from the `PART=`
pairs Phase 0 printed (survivors may have rewritten the list):

```bash
grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
  [ -n "$PROV" ] && [ -n "$INST" ] && <the per-worker command>
done
```

For background-await steps, read the same rows first, then issue one background-await Bash call
per row.

Set task `4a` → `completed`.

## Phase 4b — open-questions peer relay (auto-skips when OPENQ=none)

Set task `4b` → `in_progress`.

1. **Collate:** `$CS explore openq-collate <TOPIC>` — parses every `findings-<agent>.md`'s
   `## Open questions` bullets and round-robin routes each worker's questions to a DIFFERENT
   worker (N=2 swaps, N=3 rotates by list order), writing `$ART/open-questions.md` plus one
   `$ART/openq-claims-<agent>.txt` per receiving worker. If stdout says `OPENQ=none`, set task
   `4b` → `completed` and continue to Phase 5 — no worker turn happens.
2. **Dispatch:** dispatch each CURRENT list row (the Phase 4a worker-set rule — never init's PART= pairs):

   ```bash
   grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
     [ -n "$PROV" ] && [ -n "$INST" ] && $CS explore openq-send <TOPIC> "$INST" "$PROV"
   done
   ```

   The verb soft-skips (`QS=skipped`,
   no send) any worker whose research ended `FS=timeout`/`FS=failed` — a timed-out worker may
   still be churning, and a new inbox write would clobber its in-flight task — and any worker
   with no questions routed to it.
3. **Wait:** read the CURRENT list rows (same grep), then issue one background-await Bash call per row:
   `$CS explore openq-wait <TOPIC> <agent> <provider>`. Answers land at `$ART/openq-<agent>.md`;
   each wait appends `QS=` to `$ART/openq-<agent>.txt` and writes `$ART/openq-<agent>.done`.
4. **Gate:** do not proceed until `$CS explore wait-gate <TOPIC> openq` exits 0. The `QS=` value is
   informational (do NOT gate on `QS=ok`) — a `QS=timeout`/`QS=missing`/`QS=skipped` relay never
   blocks the run; Phase 5 simply proceeds without that worker's answers. If a worker's state file
   ends `QS=question`, handle via **Intervention Pattern 1** (state key `QS`, marker
   `openq-<agent>.done`).

Set task `4b` → `completed`.

## Phase 4c — peer cross-verify (auto-skips when peer buckets are empty)

Set task `4c` → `in_progress`.

1. **Diff:** `$CS explore diff <TOPIC>` — buckets every `findings-<agent>.md`'s `## Approaches`
   claims by citation overlap, writing `$ART/diff.md` plus the bucket files
   (`<agent>_only_items.txt`; N=3 adds `consensus.txt` + `<a>+<b>_only.txt`). rc 1 = `diff.md`
   already exists (`rm` to retry) or a findings file is missing.
2. **Dispatch:** dispatch each CURRENT list row (the Phase 4a worker-set rule — never init's PART= pairs):

   ```bash
   grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
     [ -n "$PROV" ] && [ -n "$INST" ] && $CS explore crossverify-send <TOPIC> "$INST" "$PROV"
   done
   ```

   Each worker is scoped to ONLY the
   buckets it is NOT a member of — its peers' solo claims (claude checks codex and vice versa;
   a worker never re-verifies its own claims). The verb soft-skips (`VS=skipped`, no send) a
   worker whose research/openq turn ended `timeout`/`failed`, and a worker whose peer buckets
   are all empty.
3. **Wait:** read the CURRENT list rows (same grep), then issue one background-await Bash call per row:
   `$CS explore crossverify-wait <TOPIC> <agent> <provider>`. Verdicts land at
   `$ART/crossverify-<agent>.md` (AGREE / DISPUTE / UNCERTAIN per item).
4. **Gate:** do not proceed until `$CS explore wait-gate <TOPIC> crossverify` exits 0. The `VS=`
   value is informational (do NOT gate on `VS=ok`); `VS=question` → **Intervention Pattern 1**
   (state key `VS`, marker `crossverify-<agent>.done`).

Cross-verify is gate-neutral by construction: signal S2 counts citations against findings files
only, and `crossverify-<agent>.md` is not a findings file. Its verdicts reach the gate only
organically — a peer-DISPUTED claim MUST be rendered CONTESTED in the Phase 5 draft (signal S3's
input) — transparency, never erasure.

Set task `4c` → `completed`.

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

Additionally read every `$ART/openq-<agent>.md` that Phase 4b produced (when the phase ran):
answered questions strengthen or resolve `## Open questions` entries — cite the answering
worker's evidence. Missing/empty answer files are fine; answers are optional enrichment and
never block the draft.

Additionally read every `$ART/crossverify-<agent>.md` that Phase 4c produced: a claim DISPUTED
by its verifying peer MUST be marked **CONTESTED** in the draft (organic input to signal S3 —
surface the disagreement, never erase the claim). AGREE verdicts strengthen a claim's standing;
UNCERTAIN verdicts are neutral. Missing/empty crossverify files are fine — verdicts are optional
enrichment and never block the draft.

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
logs `S1`–`S5` to stderr, and prints one `S<n>=<bool>` line per signal followed by `ALL_HOLD=<bool>`
(always the LAST stdout line — the `sed -n 's/^ALL_HOLD=//p'` parse is unchanged). The per-signal
lines tell you WHICH signal failed — e.g. `S2=false` means at least one draft citation is
corroborated by fewer than 2 workers; those exact citations reach the Phase 6 adversary prompts as
Priority targets via `annotations.json`. The signals are report-only: never re-run, repair, or loop
the gate on them.

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

Dispatch each CURRENT list row (the Phase 4a worker-set rule — never init's PART= pairs):

```bash
grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
  [ -n "$PROV" ] && [ -n "$INST" ] && $CS explore adversary-send <TOPIC> "$INST" "$PROV"
done
```

Each `adversary-send` renders that worker's adversary prompt against `landscape-draft.md`, captures
the pre-send `OFFSET=` into `$ART/adversary-<agent>.txt`, and nudges the pane.

The verb also assigns each worker a DISTINCT primary attack lens (by list order) and lists its
peers' raw `findings-<agent>.md` paths in the prompt. A worker whose research ended
`FS=timeout`/`FS=failed` — or whose Phase 4b relay turn ended `QS=timeout`/`QS=failed` — is
soft-skipped (`AS=skipped`, no send): dispatching to a possibly-still-churning worker would
clobber its single-slot inbox.

When Phase 5b's `annotations.json` recorded solo citations (`unverified` / `approaches-flagged`
items), each adversary prompt additionally lists those tokens under a `Priority targets` block —
citations corroborated by only ONE worker, which the adversary is told to open and verify first.
No annotations (or none of those kinds) → the block is simply absent; dispatch is unchanged.

Set task `6` → `completed`.

## Phase 7 — adversary wait (skipped if Phase 6 skipped)

Set task `7` → `in_progress`.

Read the CURRENT list rows (`grep -v '^#' "$ART/list.txt"`), then issue one background-await Bash call per row:

```
Bash(command='$CS explore adversary-wait <TOPIC> <agent> <provider>', run_in_background: true,
     description='explore adversary-wait <agent>')
```

**Do not proceed until `$CS explore wait-gate <TOPIC> adversary` exits 0** — it prints `<INST>\t<terminal|question|pending>` per worker; rc 1 means some worker is still `pending`/`question`, so keep handling / relay and re-run. Only on rc 0 continue. The `AS=` value is
informational (do NOT gate on `AS=ok`). Same question handling as Phase 4 — if a worker's state file's
last line shows `AS=question`, handle via **Intervention Pattern 1** before proceeding. A malformed
or empty adversary critique is handled by **Intervention Pattern 2**.

A worker skipped by the Phase 6 guard is immediately terminal (`adversary-wait` sees
`AS=skipped`, writes the `.done` marker, and returns 0) — background-wait every worker uniformly.

Set task `7` → `completed`.

## Phase 7b — bounded rebuttal (auto-skips without attributed needs-attention critiques)

Set task `7b` → `in_progress`. If the gate recorded `user_decision: skip` (no critiques exist),
set `7b` → `completed` and continue to Phase 7c.

The author of an attacked claim gets exactly ONE defend-or-concede turn — machine-selected,
never open-ended:

1. **Dispatch:** dispatch each CURRENT list row (the Phase 4a worker-set rule — never init's PART= pairs):

   ```bash
   grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
     [ -n "$PROV" ] && [ -n "$INST" ] && $CS explore rebuttal-send <TOPIC> "$INST" "$PROV"
   done
   ```

   The verb selects only
   `needs-attention` critiques (parsed from each `adversary-<agent>.md` verdict), attributes
   each Material finding to its originating worker via diff-bucket citation overlap (a finding
   whose tokens match zero buckets or tie across two stays unattributed — you weigh it alone in
   Phase 8, as today), and soft-skips (`RS=skipped`, no send) a worker with nothing attributed
   to it or whose adversary turn ended `AS=timeout`/`failed`. A second `rebuttal-send` for the
   same worker returns rc 1 — the one-turn cap is state-file existence; NEVER `rm` a rebuttal
   state file to force a second round.
2. **Wait:** read the CURRENT list rows (same grep), then issue one background-await Bash call per row:
   `$CS explore rebuttal-wait <TOPIC> <agent> <provider>`. Responses land at
   `$ART/rebuttal-<agent>.md` (DEFEND / CONCEDE per critique).
3. **Gate:** do not proceed until `$CS explore wait-gate <TOPIC> rebuttal` exits 0. `RS=` is
   informational; `RS=question` → **Intervention Pattern 1** (state key `RS`, marker
   `rebuttal-<agent>.done`).

Set task `7b` → `completed`.

## Phase 7c — post-gate gap enrichment (fires only on recorded S1/S2 failure)

Set task `7c` → `in_progress`.

When Phase 5.5 recorded `S1=false` or `S2=false` (the `signals_passed:` line in
`$ART/adversary-skip.txt`), each safe worker receives its peers' solo approaches to CONFIRM with
its own evidence, EXTEND, or REFUTE — the run learns from the overlap gap instead of discarding
it. The verbs read the recorded signals themselves; you never re-run `confidence`.

1. **Dispatch:** dispatch each CURRENT list row (the Phase 4a worker-set rule — never init's PART= pairs):

   ```bash
   grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
     [ -n "$PROV" ] && [ -n "$INST" ] && $CS explore gap-send <TOPIC> "$INST" "$PROV"
   done
   ```

   The verb soft-skips (`GS=skipped`, no
   send) every worker when the trigger did not fire, plus any worker whose latest phase ended
   `timeout`/`failed` or whose peer-only buckets are empty.
2. **Wait:** read the CURRENT list rows (same grep), then issue one background-await Bash call per row:
   `$CS explore gap-wait <TOPIC> <agent> <provider>`. Answers land at `$ART/gap-<agent>.md`
   (CONFIRM / EXTEND / REFUTE per item).
3. **Gate:** do not proceed until `$CS explore wait-gate <TOPIC> gap` exits 0. `GS=` is
   informational; `GS=question` → **Intervention Pattern 1** (state key `GS`, marker
   `gap-<agent>.done`).

**HARD anti-goals** (rejected non-goals of the 2026-06-22 annotations spec — they stay
rejected): gap answers feed ONLY the Phase 8 final landscape doc and the Phase 9c design-handoff
`## Evidence`. The draft is NEVER re-synthesized, `$CS explore confidence` is NEVER re-run after
Phase 5.5, no signal is retroactively flipped, and `adversary-skip.txt` is never rewritten. This
round enriches the OUTPUT, not the gate.

Set task `7c` → `completed`.

## Phase 8 — final synthesis (Hub Writes)

Set task `8` → `in_progress`.

Run the input validator: `$CS explore synth-final <TOPIC>`. It prints the canonical output path
`$ART/landscape-<date>-<topic>.md` on stdout. If adversary ran (the gate didn't record
`user_decision: skip`), it requires every `adversary-<agent>.md` and **rc 1** with a
missing-file list otherwise — surface and stop.

**Then run the adversary consensus tally** (under this task row — no new TaskCreate row), UNLESS
the gate recorded `user_decision: skip` (no critiques exist to tally — skip this call):

```
$CS explore verdict-tally <TOPIC>
```

It prints one `VERDICT=<agent>:<needs-attention|minor-revisions|accept|skipped|malformed>` line
per list row plus a final `TALLY=<value>` majority line (ties break to the MOST severe;
`skipped`/`malformed` rows are excluded from the majority; zero countable rows →
`TALLY=unavailable`). The tally shapes your PROSE OBLIGATIONS below — NEVER an automatic loop or
re-dispatch:

- `TALLY=needs-attention` → you MUST address every Material finding from each
  `adversary-<agent>.md` explicitly in `## Adversary critiques` and carry the surviving caveats
  into `## Conclusion`.
- `TALLY=accept` → a fast final synthesis is permitted — summarize the critiques normally.
- `TALLY=minor-revisions` or `TALLY=unavailable` → today's behavior: summarize each critique and
  incorporate what your judgment says matters.

When Phase 7b produced `$ART/rebuttal-<agent>.md` files, weigh each critique WITH its author's
response in `## Adversary critiques`: a CONCEDED critique stands as-is (note the concession); a
DEFENDED critique is summarized alongside the defense's evidence, and only the caveats that
survive the defense carry into `## Conclusion`.

When Phase 7c produced `$ART/gap-<agent>.md` files, fold CONFIRMED/EXTENDED items into the final
doc's `## Approaches` and `## Tradeoff matrix` revisions (the corroboration now exists — cite the
confirming worker's evidence) and record REFUTED items under `## Adversary critiques` or
`## Open questions` as fits. Gap answers revise the FINAL doc only — the draft and the gate
record stay untouched.

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

For a worker whose `$ART/adversary-<agent>.txt` ends `AS=skipped` (the Phase 6 dispatch guard),
render its critique bullet as:
`- **<agent> (<provider>):** (skipped: unsafe after research timeout)` — mirroring Intervention
Pattern 2's `(unavailable)` convention. `synth-final` already tolerates the missing
`adversary-<agent>.md` for such rows.

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

## Phase 8b — worker sign-off (final-doc fairness check; workers still live)

Set task `8b` → `in_progress`. In a DEGRADED run, sign-off still runs for the single survivor.

Each worker gets ONE bounded turn to confirm the final landscape doc fairly represents its
findings — a misquote/misattribution check, never a re-litigation, never new claims.

1. **Dispatch:** send each CURRENT list row's sign-off turn:

   ```bash
   grep -v '^#' "$ART/list.txt" | while IFS=$'\t' read -r PROV INST; do
     [ -n "$PROV" ] && [ -n "$INST" ] && $CS explore signoff-send <TOPIC> "$INST" "$PROV"
   done
   ```

   The verb carries the final doc's `## Conclusion`, the worker's own solo-bucket lines, and
   diff.md's Agreed section; it soft-skips (`SS=skipped`, no send) a worker whose latest phase
   (GS→RS→AS→QS→FS walk) ended `timeout`/`failed`. A second signoff-send for the same worker
   returns rc 1 — the one-turn cap is state-file existence; NEVER `rm` a signoff state file to
   force a second round.
2. **Wait:** read the CURRENT list rows, then issue one background-await Bash call per row:
   `$CS explore signoff-wait <TOPIC> <agent> <provider>`. Sign-offs land at
   `$ART/signoff-<agent>.md` (`VERDICT: fair | misrepresented` + `### Flag:` blocks).
3. **Gate:** do not proceed until `$CS explore wait-gate <TOPIC> signoff` exits 0. `SS=` is
   informational; `SS=question` → **Intervention Pattern 1** (state key `SS`, marker
   `signoff-<agent>.done`).
4. **Correction pass (at most ONE, BEFORE Phase 9):** read every `$ART/signoff-<agent>.md`. If any
   says `VERDICT: misrepresented`, apply AT MOST ONE Edit pass to the final landscape doc — fix
   the flagged passages and note each correction under `## Adversary critiques`
   (`sign-off correction (<agent>): <one-line summary>`). Never a second sign-off round, never a
   loop (same trust model as Phase 8 itself). **Ordering is load-bearing:** the correction must
   land BEFORE Phase 9 step 2 — teardown archives the art dir, and both `handoff-extract` and the
   Phase 9c author read the ARCHIVED copy. A `skipped`/`timeout`/`missing` sign-off never blocks —
   proceed without that worker's check.

Set task `8b` → `completed`.

## Phase 8a — forensics

`$CS explore forensics <TOPIC>` (best-effort; never blocks — prints a path only if mechanical
signals were found, else empty). If it printed a path, use the **Write/Edit tool** to APPEND a
`## Hub reflection` section to that file — 3-5 short bullets interpreting the mechanical findings
— **BEFORE** the Phase 9 teardown moves the art dir. Idempotent: skip the append if the file already
contains the exact header `## Hub reflection`. The forensics file lives outside the topic state
tree, so it survives teardown + archive.

Then run the contribution scoreboard: `$CS explore contribution <TOPIC>` — plain per-provider
counts (claims total/solo/consensus, peer verdicts, adversary verdict, rebuttal defend/concede,
sign-off) written to `$ART/contribution.tsv` and printed to stdout. Rows come from
`list-original.txt` when Phase 4a rewrote the list, so dropped workers appear with their real
(usually zero) counts. STRICTLY informational: it is archived with the art dir and surfaced in
Phase 10 — it never feeds a gate, a dispatch decision, or synthesis weighting.

## Phase 9 — teardown + archive + handoff-extract

Set task `9` → `in_progress`.

1. **Pane teardown first.** Read the list agents from `$ART/list-original.txt` when it exists (the Phase 4a rewrite
   preserved the full roster there — a dropped worker still gets its graceful DONE banner +
   per-worker archive instead of a bannerless orphan-kill), else `$ART/list.txt`, and run
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
When Phase 7c ran, fold gap answers into this table: a CONFIRM/EXTEND upgrades that source's
Strength (cite $ART/gap-<agent>.md); a REFUTE demotes or drops the row with a one-line note.
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

**Degraded-run stamp:** when Phase 4a printed `DEGRADED=1`, `## Constraints (carry-forward)` MUST
additionally open with: "DEGRADED RUN: single-worker survey — no independent corroboration, no
peer verification; treat every claim as single-source."

**No-convergence branch** (`mode=explore-no-convergence` in `handoff-data.kv`):
- `## Recommendation` reads: "Survey did not converge on a single best approach. See Evidence for
  contested findings and the tradeoff matrix."
- **OMIT `## Recipe`** entirely (no convergent approach → no recipe).
- `## Open questions` may capture the contested-decision axes the survey exposed but couldn't resolve.

Set task `9` → `completed`.

## Phase 10 — present

**Conclusion first — print it to the screen.** Read the final landscape doc
(`$ART/landscape-<date>-<topic>.md`; `$ART` is the rebound archive path) and render its
`## Conclusion` section body VERBATIM in your reply, so the user knows the outcome without
opening any file. This is chat output ONLY — write no new file for it. Rules:

- Lead with a one-line header: `== Explore conclusion: <topic> ==`, then the full `## Conclusion`
  body (strongest approach, caveats, suggested `/ap:design` invocation — Phase 8 already requires
  all three).
- **Degraded run** (single survivor): print the `DEGRADED RUN — no independent corroboration`
  caveat line FIRST, before the conclusion body.
- **No-convergence run** (`mode=explore-no-convergence`): the Conclusion states the survey did
  not converge — print it as-is; do not invent a recommendation.
- Missing `## Conclusion` section (should not happen — Phase 8 requires it): say so explicitly
  and point at the landscape doc path instead of fabricating a summary.

Then print the artifact block:

```
Explore complete.

Landscape doc:
  $ART/landscape-<date>-<topic>.md

Handoff doc (pipe directly into design):
  $ART/design-handoff.md

Contribution scoreboard (archived):
  $ART/contribution.tsv
<the TSV rows verbatim>

Suggested next step:
  /ap:design $ART/design-handoff.md

(Or hand-edit the topic to investigate a different angle.)
```

## Intervention patterns

The Hub regains control between every phase (file-IPC, not in-process messaging). If a worker
produces unexpected output, intervene before the next subcommand runs.

### Pattern 1: worker question event

A worker emits `{"event": "question", ...}`. The wait verb sets `FS=question` (research),
`QS=question` (open-questions relay), `VS=question` (cross-verify), `AS=question` (adversary),
`RS=question` (rebuttal), `GS=question` (gap), or `SS=question` (sign-off) as the state file's last line and captures the
question JSON to `$ART/question-<agent>.txt`. Read that file (its `message`, optional `options`),
compose an answer from the topic + findings, then relay it:
`$CS send --from hub <agent> <TOPIC> "<answer>"`. The wait verb already advanced the
`OFFSET=`; `rm -f` that phase's `.done` marker (`research-<agent>.done`, `openq-<agent>.done`,
`crossverify-<agent>.done`, `adversary-<agent>.done`, `rebuttal-<agent>.done`,
`gap-<agent>.done`, or `signoff-<agent>.done`) and re-arm that worker's background wait. The wait resumes past the
question — it never re-sends the prompt.

### Pattern 2: malformed adversary output

A worker's `adversary-<agent>.md` is empty or missing its `## Verdict` line. Re-dispatch that one
worker once with a clarifying inbox payload pointing at the missing structure
(`$CS send --from hub <agent> <TOPIC> "<clarification>"`). If a second attempt still fails,
mark that worker's critique as `(unavailable)` in the final landscape doc.

### Pattern 3: stuck spawn / cold-start failure

Already absorbed by Phase 2's auto-retry-once mechanism. If the retry also fails, Phase 2 tears down,
removes the topic state dir, and aborts with the provider-failure list. No further intervention.

## Non-goal: fast/slow overlap scheduling (adversarially REFUTED 2026-07-10)

Do not overlap a fast worker's next phase with a slow worker's research tail. Every post-research
phase is a global fan-in over ALL findings (diff membership is first-match-wins across workers, so
partial-input buckets misclassify solo-vs-consensus), the all-block `wait-gate` is the correct
design, and a mid-research dispatch would clobber the single-slot inbox. Wall-clock upside at
N=2-3 is near-zero. Recorded here so it is not re-proposed.
