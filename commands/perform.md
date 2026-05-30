---
description: Implement a deploy-schema design doc — audit + route, spawn one part to plan/implement/self-verify, Maestro cross-verifies and runs a bounded fix-loop, then per-target finish + teardown (single-repo)
argument-hint: [--no-branch] [--branch <n>] [--topic <slug>] [--max-rounds N] [<design-doc-path>]
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, Skill, mcp__codegraph
---

# /consort:perform

Run a part-implements / Maestro-verifies pipeline on `$ARGUMENTS` — the consumer of the
deploy-schema design doc that `/consort:score` produces. The `cody` part stays attached for the
whole run; `tmux select-pane` to watch.

Let `CS="node ${CLAUDE_PLUGIN_ROOT}/dist/consort.cjs"`.

> **Scope (this build):** single-repo **and multi-repo DAG execution**. A multi-repo doc (a
> `**Target Sub-Project(s):**` header plus a `## Execution DAG` section) routes through Stages 3a/3b
> (preflight panes → wave-by-wave dispatch). Cross-repo verify / per-repo fix-loop / per-repo finish
> are a later phase; the multi-repo path here ends after all waves complete plus a per-repo summary.

## Stage 0 — args-file + init + route + branch

1. **Strip `--max-rounds` first.** Scan `$ARGUMENTS` token-by-token: if you see `--max-rounds`,
   capture the NEXT token into `MAX_ROUNDS_OVERRIDE` and drop both tokens. (The init verb rejects
   `--max-rounds`, so it must never reach the args file.) If absent, leave `MAX_ROUNDS_OVERRIDE` unset.
2. Mint an args path: `$CS perform --mint-args-file` → prints `<args-path>`.
3. **Write tool:** `file_path` = `<args-path>`, `content` = the **filtered** argument string from
   step 1 (`$ARGUMENTS` minus the `--max-rounds <N>` pair), verbatim and unquoted.
4. Init: `$CS perform init --args-file <args-path>`. On success it prints to stdout:
   ```
   ART=<abs path to the _perform art dir>
   TOPIC=<slug>
   ROUTING=<single|multi>
   PROVIDER=<codex|claude>
   TARGET_CWD=<abs path the part runs in>
   ```
   Capture all five. Non-zero aborts:
   - **rc 1** — audit FAILED (it printed `ISSUE=<code>` lines to stderr) OR the doc/topic/target was
     unreadable/unresolvable. If `ISSUE=` lines were printed, surface them and tell the user to fix the
     design doc (or re-run `/consort:score` to regenerate one). Stop.
   - **rc 2** — usage error, or the topic is already in flight (run `/consort:coda <TOPIC>` to clear it
     first). Stop.
5. **If `ROUTING=multi`:** materialize the DAG + the per-repo roster *before* the shared step 6:
   1. `$CS perform dag-parse <TOPIC>` — parses `## Execution DAG` → `$ART/dag-waves.txt`
      (`<wave>\t<step>\t<repo>\t<path|none>\t<desc>`) + `$ART/dag-edges.txt` (`<from>\t<to>`); prints
      `WAVES=`/`STEPS=`. rc 1 = a cyclic or malformed DAG (the offending line / cycle was printed to
      stderr) → surface it and stop (re-run `/consort:score` for a clean DAG, or fix the doc by hand).
   2. `$CS perform multi-init <TOPIC> "$TARGET_CWD"` — resolves each unique sub-repo (in DAG
      first-occurrence order) under the hub `$TARGET_CWD`, checks its `CLAUDE.md`/`AGENTS.md` marker,
      assigns one part (instrument) + its detected provider per repo, and writes `$ART/parts.txt`
      (`<instrument>\t<cwd>\t<provider>`) + a per-part `$ART/<instrument>-branch-base.sha`. rc 1 = a
      sub-repo is missing / lacks a marker / the instrument pool is exhausted → surface and stop.
   Then step 6 runs **pre-snapshot + branch across all N parts** (`iterTargets` reads `parts.txt`).
6. **Pre-snapshot + branch.** `$CS perform pre-snapshot <TOPIC>` (commits any dirty tree so the
   perform branch forks clean; rc 2 = the target is not a git repo → surface and stop). Then, unless
   the user passed `--no-branch`, `$CS perform branch <TOPIC>` (creates/resumes `feat/perform-<TOPIC>`
   from the clean HEAD and records `branch-base.sha`). With `--no-branch`, run
   `$CS perform branch --no-branch <TOPIC>` (stays on the current branch).

> **Routing after Stage 0.** `ROUTING=single` → Stages 1.1 / 1 / 2 / 3 / 4 below. `ROUTING=multi` →
> **skip to Stage 3a** (the materialization in Stage 0 step 5 already ran; pre-snapshot + branch
> covered every part).

## Stage 1.1 — spawn the part (single-repo)

Spawn one part in the resolved target cwd:

```bash
$CS spawn cody "$PROVIDER" "$TOPIC" --cwd "$(cat "$ART/target_cwd.txt")"
```

On spawn failure (non-zero): `$CS perform archive <TOPIC>` and stop (nothing to tear down — the part
never came up).

## Stage 1 — run the part turn (round-aware, auto-retry-once)

Initialize once: `ROUND=1`, `RETRY=0`, `MAX_ROUNDS=${MAX_ROUNDS_OVERRIDE:-5}`. Then per round:

1. Dispatch: `$CS perform turn-send <TOPIC> <ROUND>`.
2. Wait in the background so your pane stays interactive:
   ```
   Bash(command='$CS perform turn-wait "$TOPIC" "$ROUND"', run_in_background: true,
        description="maestro await cody round=$ROUND")
   ```
   The default turn budget is 4 hours (`CONSORT_PERFORM_TURN_TIMEOUT_S=14400`); override the env var
   for unusually large or small tasks.
3. On completion, read `TS=` from `$ART/turn-cody-<ROUND>.txt` (the **last** `TS=` line). Branch:
   - **`TS=ok`** → Stage 2.
   - **`TS=failed` / `TS=timeout`** → auto-retry **once**: if `RETRY==0`, set `RETRY=1`,
     `rm -f $ART/turn-cody-<ROUND>.txt $ART/turn-cody-<ROUND>.done $ART/cody_turn_prompt_<ROUND>.md`,
     and loop back to step 1 (same round). If `RETRY==1` (a second failure), **AskUserQuestion**
     ("Hand-off (preserve the pane + write RESUME.md) / Abort (teardown + archive) / Try-again"):
     - *Hand-off* — write `$ART/RESUME.md` (topic dir, branch, last verdict, manual-takeover steps);
       do NOT tear down; stop.
     - *Abort* — `$CS coda <TOPIC>` then `$CS perform archive <TOPIC>`; stop.
     - *Try-again* — `RETRY=0`; loop back to step 1.
   - **`TS=question`** → the part halted with a question. Read the payload file
     `$ART/question-cody-<ROUND>.txt` (KV: `TEXT=` percent-encoded, `CLAIM_KIND=`, `CLAIM_VALUE=`,
     `ROUTE=verify|escalate`). Decode `TEXT` with the same scheme `score` uses (`%0A`→newline, etc.).
     - **`ROUTE=verify`** — verify the claim against ground truth: run the matching check for
       `CLAIM_KIND` in `TARGET_CWD` (`path`→exists+readable, `git`→`git -C "$TARGET_CWD" rev-parse
       --verify <value>`, `env`→is the var set, `cmd`→`command -v <value>`, `test`→`timeout 30 bash -c
       <value>`). Compose the reply: `From: maestro` then `Verdict: FOUND|NOT FOUND|UNVERIFIABLE` +
       the claim kind/value + the evidence + `Resume implementation.`. Write it to a temp file and
       deliver: `$CS send --from maestro cody "$TOPIC" @<reply-file>`.
     - **`ROUTE=escalate`** (or an unverifiable claim) — **AskUserQuestion** with the decoded `TEXT`
       as the question; write the user's answer to a temp file and deliver it the same way.
     - **Re-arm** the wait on the **same** round: re-run the background `turn-wait <TOPIC> <ROUND>`
       (the prior question-wait appended a fresh `OFFSET=`, so it resumes past the question). The next
       event you see should be the part's `ack`, then its next terminal event.

## Stage 2 — cross-verify (Maestro)

Invoke `superpowers:verification-before-completion`. Read (capped):
- `$ART/verify-report-<ROUND>.md` (the part's self-verify),
- `$ART/test-output-<ROUND>.log` (tail for pass/fail counts),
- `git -C "$TARGET_CWD" log --oneline "$(cat "$ART/branch-base.sha")"..HEAD` and
  `git -C "$TARGET_CWD" diff --stat "$(cat "$ART/branch-base.sha")"..HEAD`,
- up to 3 spot-checks: Read the highest-stakes diff hunk per critical requirement (paths from
  `git diff` are relative to `TARGET_CWD`; prefix them).

Write the verdict to `$ART/cross-verify-<ROUND>.md`: top line `VERDICT: PASS` or `VERDICT: FAIL`. On
FAIL, list issues under `## Issues`, each tagged `[bug]` / `[regression]` / `[spec-gap]` with a
`(file:line)` reference and a one-line fix direction.

- `VERDICT: PASS` → Stage 4.
- `VERDICT: FAIL` and `ROUND > MAX_ROUNDS` → write `$ART/RESUME.md`; **AskUserQuestion** ("Continue
  one more round / Hand-off / Abort"). Default hand-off. Continue → `MAX_ROUNDS=$((MAX_ROUNDS+1))` and
  go to Stage 3; Abort → `$CS coda <TOPIC>` + `$CS perform archive <TOPIC>`, stop.
- `VERDICT: FAIL` and within budget → Stage 3.

## Stage 3 — author the fix bundle

Read `cross-verify-<ROUND>.md`. Write `$ART/fix-prompt-$((ROUND+1)).md` — tagged bullets only, **no**
preamble, **no** skill mention, **no** `END_OF_INSTRUCTION` (the turn-send verb wraps it):

```markdown
- [bug] <file:line evidence> — <suggested fix direction>
- [spec-gap] <file:line evidence> — <suggested fix direction>
```

Then `ROUND=$((ROUND+1))`, `RETRY=0`, and loop back to Stage 1.

## Stage 4 — scope check + summary + finish + teardown

1. **Scope conformance.** `$CS perform scope-check <TOPIC>` (writes `scope-out-of-scope.txt`, prints
   `OOS_COUNT=`/`OOS_PATH=`). If `OOS_COUNT > 0`, read the file and **AskUserQuestion** ("Amend the
   design / Send back to the part / Force-keep"):
   - *Amend* — draft the new Components-table rows, present them, **Edit** `$ART/design.md` to insert
     them, and record `amended-rows=<n>` to `$ART/scope-amended.txt`.
   - *Send back* — append the out-of-scope paths as a `[scope]` bug to `$ART/fix-prompt-$((ROUND+1)).md`
     and re-enter Stage 1 (one more fix round).
   - *Force-keep* — append the paths to `$ART/scope-overrides.txt` and proceed.
2. **Summary.** `$CS perform summary <TOPIC>` — surface its per-target block (branch, baseline/HEAD,
   diff stat, commit list) to the user verbatim.
3. **Finish menu.** Recommend **Push + PR** if `git -C "$TARGET_CWD" remote` is non-empty, else
   **Merge**. **AskUserQuestion** ("Merge to start branch / Push + PR / Keep the branch / Discard"),
   then apply: `$CS perform finish <TOPIC> <merge|pr|keep|discard>`. Read the outcome from
   `$ART/finish-results.tsv` (`<slug>\t<action>\t<outcome>`); on `merge-conflict-left`, tell the user
   the branch was preserved and the repo restored to the start branch (resolve `git merge
   feat/perform-<TOPIC>` by hand).
4. **Forensics + reflection.** `$CS perform forensics <TOPIC>`. If it printed a path, use the
   **Edit/Write tool** to APPEND an idempotent `## Maestro reflection` section to that file — 3-5
   short bullets interpreting the mechanical findings.
5. **Teardown + archive.** `$CS coda <TOPIC>` (closes the part's pane; prints the **FINE** banner),
   then `$CS perform archive <TOPIC>`.
6. **Final summary.** Print: the branch + commit count (`git -C "$TARGET_CWD" log --oneline
   "$(cat "$ART/branch-base.sha")"..HEAD | wc -l`), the finish outcome, and the archive path.

## Stage 3a — multi-repo preflight (ROUTING=multi only)

Stage 0 step 5 + step 6 have already written `$ART/{dag-waves.txt,dag-edges.txt,parts.txt}` and
branched every sub-repo. Allocate one tmux pane per part, rooted later in each part's sub-repo cwd.
Build the preflight roster `<instrument>:<provider>` from `parts.txt` (col 1 = instrument, col 3 =
provider) and the part count `N`:

```bash
N=$(grep -vc '^$' "$ART/parts.txt")
ROSTER=$(awk -F'\t' 'NF>=3 {printf "%s%s:%s", sep, $1, $3; sep=","}' "$ART/parts.txt")
$CS preflight <TOPIC> "$N" --roster "$ROSTER" --art-dir "$ART"
```

`preflight` allocates **2–4** panes and writes `$ART/preflight-panes.txt` (TSV `<instrument>\t<pane>`).
If `N > 4`, dispatch the first 4 parts' panes and tell the user wider intra-wave fan-out is not yet
supported (the DAG still serializes by wave; only the per-wave pane budget is capped). Load
`preflight-panes.txt` into an `instrument → pane` map for Stage 3b.

## Stage 3b — DAG wave dispatch (ROUTING=multi only)

Build the lookup tables once — for each `parts.txt` row `<instrument>\t<cwd>\t<provider>`, the repo is
`basename(cwd)`; map `repo → {instrument, cwd, provider}`. Group `dag-waves.txt` rows by wave (column
1). The **fan-in** parts (a step with ≥2 incoming `dag-edges.txt` rows — `dagFanInRepos`) warrant
extra scrutiny in the later cross-verify phase; note them now.

Walk the waves in ascending order — **never start wave W+1 until every part in wave W reports `done`**.
For each wave, for each repo in it:

1. **Spawn** the part on its allocated pane, rooted in its sub-repo cwd (issue the per-wave spawns as
   parallel Bash calls in one message):
   ```bash
   $CS spawn "$INSTRUMENT" "$PROVIDER" "$TOPIC" --cwd "$CWD" --target-pane "$PANE"
   ```
2. **Dispatch the build unit** — `send-unit` composes the per-repo DAG-unit prompt (focus the part on
   its `### <repo>` design-doc slice + its upstream siblings) and delivers it via the canonical
   write+nudge `send` primitive:
   ```bash
   $CS perform send-unit "$TOPIC" "$REPO"
   ```
3. **Barrier** — fire one background `wave-wait` per part in the wave (parallel), then wait for all:
   ```
   Bash(command='$CS perform wave-wait "$TOPIC" "$INSTRUMENT" "$PROVIDER"', run_in_background: true,
        description="maestro await <INSTRUMENT> wave <W>")
   ```
   On the completion notifications, read each part's first `TS=` line from `$ART/wave-<instrument>.txt`.
   Every part `TS=ok` → advance to the next wave. Any `TS=failed`/`TS=timeout` → surface which
   sub-repo(s) failed and **AskUserQuestion** ("Retry the wave / Hand-off (preserve panes) / Abort").
   *Abort* → `$CS coda --pairs <TOPIC> <instrument…>` + `$CS perform archive <TOPIC>`, stop.

When the last wave's parts all report `TS=ok`, multi-repo execution is complete.

## Stage 3z — per-repo summary + teardown (ROUTING=multi; end of this build)

`$CS perform summary <TOPIC>` — `iterTargets` reads `parts.txt`, so it emits one block per part
(branch, baseline/HEAD, diff stat, commit list). Surface every block verbatim.

> **Deferred to a later phase:** cross-repo verify (the Maestro's own cross-repo invariant check,
> escalated on a fan-in / shared-path "feels unsafe" signal), the per-repo fix-loop, and the per-repo
> finish menu are **not built here** — they will be inserted between the summary and teardown. For now,
> tear down + archive: `$CS coda --pairs <TOPIC> <instrument…>` (closes every part pane; prints the
> **FINE** banner) then `$CS perform archive <TOPIC>`. Print the per-part commit counts + the archive
> path as the final summary.
