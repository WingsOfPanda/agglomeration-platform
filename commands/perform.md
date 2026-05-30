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

> **Scope (this build):** single-repo only. A multi-repo doc (a `**Target Sub-Project(s):**` header
> plus a `## Execution DAG` section) is detected and recorded, but its execution is a later phase —
> Stage 0 stops with a note when `ROUTING=multi`.

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
5. **If `ROUTING=multi`:** tell the user this design declares multiple sub-projects and a multi-repo
   `perform` is a later phase; the doc is recorded but will not execute here. Stop.
6. **Pre-snapshot + branch.** `$CS perform pre-snapshot <TOPIC>` (commits any dirty tree so the
   perform branch forks clean; rc 2 = the target is not a git repo → surface and stop). Then, unless
   the user passed `--no-branch`, `$CS perform branch <TOPIC>` (creates/resumes `feat/perform-<TOPIC>`
   from the clean HEAD and records `branch-base.sha`). With `--no-branch`, run
   `$CS perform branch --no-branch <TOPIC>` (stays on the current branch).

## Stage 1.1 — spawn the part

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
