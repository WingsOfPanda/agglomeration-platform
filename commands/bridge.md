---
description: Use when a task requires changes in a DIFFERENT git repository than the one you're working in — rather than cd-ing away, open one persistent claude/codex worker inside that other repo (repo B) and co-develop with it over open-ended rounds, relaying questions both ways with the user, finishing as a PR there.
argument-hint: --repo <abs-repo-path> <opening task> [--provider codex|claude|agy|opencode] [--in-place]
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion
---

# /ap:bridge

Open ONE persistent worker in the repo named by `--repo` (repo B) and collaborate with it over as many
rounds as the work needs. You (the conductor) stay in your own repo (repo A); the worker edits repo B.
Use **judgment** on the worker's questions: answer the ones you can confidently handle from context;
pull in the human via AskUserQuestion only for real decisions (taste, scope, ambiguous trade-offs).

Let `CS="node ${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs"`.

> **Claude** workers' task nudges carry the `ultracode` keyword by default — each dispatched turn
> opts into Claude Code's multi-agent Workflow orchestration (deeper work, more tokens; a harmless
> no-op without the Workflows feature). For a lean run, prefix every worker dispatch with
> `AP_ULTRACODE=0`.

## Flagging suspicions

At any point, if something looks off, record it: `$CS bridge flag <SLUG> "<what looked off>"`. It writes
straight to the review feed (survives teardown and aborts) and costs nothing. Review with `/ap:review`.

## Stage 0 — Init

1. Mint an args path and write `$ARGUMENTS` into it:
   - Run: `$CS bridge --mint-args-file` → prints `<args-path>`.
   - **Write tool:** `file_path` = `<args-path>`, `content` = `$ARGUMENTS` (verbatim, unquoted).
2. Init: `$CS bridge init --args-file <args-path>`. On success it prints (stdout is clean; logs go to stderr):
   ```
   SLUG=<slug>
   AGENT=<agent>
   PROVIDER=<provider>
   MODE=<branch|in-place>
   TARGET=<repo-B-abs-path>
   ```
   Capture each value. Non-zero exit aborts: rc 1 = bad/empty task or bad `--repo`, rc 2 = topic already
   in flight, rc 3 = provider not installed. No SUMMARY is written (state dir was never created).

## Stage 1 — Branch + spawn + open

1. If `MODE=branch`: `$CS bridge branch <SLUG>`. On **rc 1** (not a git repo, or repo B already on another
   `feat/bridge-*` branch) → abort: `$CS bridge summary <SLUG> --aborted setup branch "<reason>"`, print the
   SUMMARY, stop. (No worker spawned, so no `stop`.) If `MODE=in-place`: skip branch entirely.
2. Spawn the worker **in repo B** (NO initial prompt — the brief is round 1):
   `$CS spawn <AGENT> <PROVIDER> <SLUG> --cwd <TARGET>`. On **rc 1** (bootstrap failed) → abort:
   `$CS bridge summary <SLUG> --aborted setup spawn-failed "worker failed bootstrap"`, print SUMMARY, stop.
   Do **not** run `stop` — `spawn` already FAILED-archived the worker.
3. Dispatch round 1: `$CS bridge round-send <SLUG> 1`, then await it in the background:
   ```
   Bash(command='$CS bridge round-wait <SLUG> 1', run_in_background: true, description='bridge await round 1')
   ```

## Stage 2 — The collaboration loop (open-ended)

For the current `<ROUND>` (starting at 1), on each completion notification read the **last** `TS=` line
from `<SLUG state>/_bridge/execute/round-<ROUND>.txt` and branch:

- **`TS=ok`** → the worker finished this round. Review its work: read its outbox and run
  `git -C <TARGET> diff` to see the changes. Then decide:
  - **More to do** → choose the next round number `<N>` = `<ROUND>+1`. **Write**
    `<SLUG state>/_bridge/execute/followup-<N>.md` with your refinement/next instruction, then
    `$CS bridge round-send <SLUG> <N>` and background `$CS bridge round-wait <SLUG> <N>`. Set `<ROUND>=<N>`.
  - **Done** → if it looks complete, confirm with the human (a short AskUserQuestion or a direct
    question). On confirmation → go to Stage 3.
- **`TS=question`** → read `execute/question-<ROUND>.txt`. **Judgment:**
  - Answerable from context (a path, a naming convention, an obvious clarification) → answer it yourself:
    `$CS bridge relay <SLUG> <ROUND> "<your answer>"` (or `@<reply-file>` for long answers), then re-arm the
    background `$CS bridge round-wait <SLUG> <ROUND>`.
  - A real decision (taste, scope, an ambiguous trade-off) → **AskUserQuestion** the human, then relay
    their answer: `$CS bridge relay <SLUG> <ROUND> "<human's answer>"`, then re-arm the wait.
  The re-arm resumes past the handled question automatically (round-wait appended a bumped `OFFSET=`).
- **`TS=failed` or `TS=timeout`** → tell the human; offer to (a) re-arm the same round once more, or
  (b) abort: `$CS bridge summary <SLUG> --aborted round round-wait "worker round failed (TS=<ts>)"`, then
  `$CS stop <AGENT> <SLUG>`, print SUMMARY, stop.

At any round you may also need a call the worker didn't ask for — use AskUserQuestion directly, then
continue.

## Stage 3 — Verify + finish

1. Verify (advisory): `TEST_CMD=$($CS bridge detect-test <TARGET>)`. If non-empty, run it once in `<TARGET>`,
   tee to `execute/verify-1.log`; set `VERIFY` to `PASS (<cmd>)` / `FAIL (<cmd>)`. If empty,
   `VERIFY="skipped (no test command detected)"`. A FAIL does not block finish — you may open one more
   round to fix it (your judgment), or proceed.
2. Record the verify result so finish can embed it in the PR body:
   ```bash
   printf '%s\n' "$VERIFY" > <SLUG state>/_bridge/execute/verify-result.txt
   ```
3. Finish: `$CS bridge finish <SLUG>`. In **branch mode** this opens a PR, merges it (a merge commit), and
   fast-forwards repo B's base branch — so repo B ends back on its base branch, up to date, with the
   merge on record and no local/remote divergence. Fallbacks (each recorded in `finish-result.txt`): no
   remote → it merges into base locally; no `gh` → it pushes the branch and you open + merge the PR
   manually, then `git -C <TARGET> pull`; the PR merge being blocked (branch protection / CI / conflict)
   → it leaves the PR open for you to merge; base can't fast-forward → it reports and stops. In
   **in-place mode** it leaves the commits on the current branch.

## Stage 4 — Teardown + SUMMARY

1. **Forensics + reflection (BEFORE teardown):** `FORENSICS=$($CS bridge forensics <SLUG>)`. If non-empty,
   tell the user "forensics captured: $FORENSICS", **Read** it and **append** a `## Hub reflection`
   section (idempotent: skip if the file already contains the exact header `## Hub reflection`).
2. Tear down + archive the worker:
   ```bash
   ARCHIVED=$($CS stop <AGENT> <SLUG> 2>&1 | sed -n 's/.*archived [^:]*: //p' | tail -1)
   [ -n "$ARCHIVED" ] && printf '%s\n' "$ARCHIVED" > <SLUG state>/_bridge/archived-path.txt
   ```
3. `$CS bridge summary <SLUG>` — writes `SUMMARY.md`. Then print it: `cat <SLUG state>/_bridge/SUMMARY.md`.

## Notes

- One worker, one repo (repo B), open-ended rounds. This is NOT the retired multi-repo subsystem — no
  discovery, no `--targets`, no DAG.
- State lives under YOUR (conductor) repo hash; the worker just works in repo B via `--cwd`.
- `<SLUG state>` = `<repo-A>/.ap/state/<hash>/<SLUG>` (the conductor's state tree).
