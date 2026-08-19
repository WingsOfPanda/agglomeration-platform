# macOS portability: bounded test runs, worktree dep clone, honest check — design

**Date:** 2026-08-19
**Status:** approved (hub-authored; follow-up to issue #143 / PR #144)

## Problem

The first external macOS user (issue #143) hit the `sleep infinity` preflight kill, fixed in
PR #144 (0.5.40). An adversarial portability sweep confirmed three more real macOS hazards, all
execution-verified, plus a blind spot in `/ap:check`:

1. `src/core/implementVerifyTests.ts:57` — `liveTestRunner` shells out to GNU `timeout`
   (`execFileSync("timeout", ["--kill-after=5", String(timeoutS), "bash", "-c", "--",
   `${testCmd} 2>&1`], …)`). Stock macOS has NO `timeout(1)` (Homebrew coreutils installs it as
   `gtimeout`). Node's spawn ENOENT throws with `err.status = null`, the catch returns
   `{ code: 1, output: "" }`, and `classifyTestRun` says **"fail"** — the hub's independent re-run
   reports its own non-execution as an authoritative test failure with an EMPTY
   `hub-test-output-<round>.log`, every round, burning the fix-loop on a phantom regression. The
   deeper defect is platform-independent: a runner that never ran must classify `unverifiable`,
   never `fail`.
2. `src/commands/job.ts:194` — `r.run("cp", ["-al", deps, join(worktree, "node_modules")])`.
   BSD `cp` has no `-l`; every detached run on macOS loses the dependency clone (non-fatal warn,
   but the worker then pays a full install).
3. Directive/template prose mandates `timeout(1)`:
   - `commands/implement.md` claim-verify table: `` `test`→`timeout 30 bash -c <value>` `` — on a
     mac hub, command-not-found reads as claim-false.
   - `config/prompt-templates/autoresearch/experiment.md` step 2: "Wrap with
     `timeout {{TIME_BUDGET_S}}s`" — and the same template forbids brew, so a mac worker cannot
     comply.
4. `/ap:check` `healthCheck()` probes tmux but not the timeout tooling — it reported OK on the
   #143 reporter's box while every spawn died. CI has no macOS job, so none of this can regress
   visibly.

Adversarially REFUTED, out of scope (do not touch): `wrapLaunch`'s `bash -ic` (macOS bash 3.2 is
fine); the `echo '…%%…'` safe-pattern lines in identity.md/job-hub.md; `commands/autoresearch.md`
"with a timeout" (means the Bash tool's timeout parameter); `src/core/implementQuestions.ts:57`
(claim-verify runner subsystem is unwired — recorded skip, leave as is).

## Goal

macOS users get a working `implement verify-tests`, a working detached-worktree dependency clone,
and an `/ap:check` that names missing tooling — while **Linux (the primary platform) keeps
byte-identical behavior on every happy path**: when GNU `timeout` is on PATH the exact current
argv runs; when `cp -al` succeeds it remains the only `cp` call. A runner spawn-failure classifies
`unverifiable` on every platform.

## Architecture

Record-and-degrade, never guess: resolve the tool that exists, fall back portably, and surface
what happened.

- **A1 — bounded test runs** (`src/core/implementVerifyTests.ts`):
  - New exported pure `resolveTimeoutBin(have: (cmd: string) => boolean): string | null` —
    `"timeout"` if available, else `"gtimeout"`, else `null`. Live callers pass `haveCmd` from
    `src/core/deps.ts` (already injection-safe).
  - Restructure the live runner as an exported `runBounded(bin: string | null, cwd: string,
    testCmd: string, timeoutS: number): TestRunResult` so each branch is testable by execution:
    - `bin` non-null → current argv exactly, with `bin` as argv[0]:
      `execFileSync(bin, ["--kill-after=5", String(timeoutS), "bash", "-c", "--", `${testCmd} 2>&1`], …)`
      (same opts: cwd, utf8, stdio ignore/pipe/pipe, 64MB maxBuffer).
    - `bin === null` → `execFileSync("bash", ["-c", "--", `${testCmd} 2>&1`], { …same,
      timeout: timeoutS * 1000, killSignal: "SIGKILL" })` — Node's own bound; kills only the direct
      child (degradation noted in A4's check line).
  - Catch discipline (never throw), in order:
    1. `err.signal` set (Node bound killed it) → `{ code: 124, output }` — maps onto the existing
       timeout semantic so `classifyTestRun` needs no new case for it.
    2. `typeof err.status === "number"` → `{ code: err.status, output }` (unchanged).
    3. otherwise (ENOENT and kin — the runner itself never ran) → `{ code: null, output }` where
       output falls back to the error's message/code when stdout+stderr are empty, so
       `hub-test-output-<round>.log` is never blank on a spawn failure.
    Verify the actual thrown shapes by execution during implementation (a Node one-liner per
    branch), not from memory.
  - `TestRunResult.code` becomes `number | null`; `liveTestRunner.run` = resolve + `runBounded`.
  - `classifyTestRun`: add `if (code === null) return "unverifiable";` before the fail
    fallthrough; update its doc comment (null = the runner could not run at all). NOTE:
    `verifyTestsWith` already carries `code: number | null` and already renders null as empty
    `HUB_RC=` / `hub_rc=` — no change there.
- **A2 — worktree dep clone** (`src/commands/job.ts` `startWorktree`): replace the single
  `cp -al` with a first-success chain, each attempt against the same src/dest:
  1. `cp -al` (Linux happy path — identical single call),
  2. `cp -cR` (APFS clonefile on darwin; fails harmlessly where unsupported),
  3. `cp -R` (portable last resort).
  Between attempts, remove a partial destination (`rmSync(dest, { recursive: true, force: true })`).
  First success: `log.ok` naming the mode (`hardlink-cloned` / `clone-copied` / `copied`). All
  fail: the existing warn, run continues (unchanged semantics).
- **A3 — directive/template prose:**
  - `commands/implement.md` claim-verify `test` row: run `bash -c <value>` via the **Bash tool
    with a 30s timeout parameter** (not the `timeout(1)` binary, absent on stock macOS).
  - `commands/implement.md` Stage 2 Step A `unverifiable` bullet: add the spawn-failure case —
    empty `HUB_RC=` means the hub's runner could not execute at all (e.g. no timeout binary);
    the log then carries the spawn error, not test output.
  - `config/prompt-templates/autoresearch/experiment.md` step 2: bound the run to
    `{{TIME_BUDGET_S}}`s portably — `timeout {{TIME_BUDGET_S}}s <cmd>` where available
    (`gtimeout` with Homebrew coreutils on macOS), else
    `perl -e 'alarm shift; exec @ARGV' {{TIME_BUDGET_S}} <cmd>` (perl ships with macOS). Keep the
    tee/wall-clock-capture sentences.
- **A4 — `/ap:check`** (`src/commands/check.ts` `healthCheck`): after the tmux block, one probe
  line: `haveCmd("timeout")` → ok `timeout: GNU timeout`; else `haveCmd("gtimeout")` → ok
  `timeout: gtimeout (Homebrew coreutils)`; else `log.warn` that no timeout binary is on PATH —
  hub test re-runs fall back to Node's built-in bound, which kills only the direct child (stray
  test grandchildren may linger on timeout). Warn, never fail.
- **A5 — CI** (`.github/workflows/ci.yml`): add a `check-macos` job on `macos-latest` running the
  same steps EXCEPT the dist-sync diff (esbuild byte-determinism across platforms is not a bet we
  take; the ubuntu job keeps that gate). tmux is not needed — the suite never spawns live panes.
- **A6 — version:** 0.5.41 across the three manifests; `dist/ap.cjs` rebuilt and committed.

## Components

- `src/core/implementVerifyTests.ts` — `resolveTimeoutBin`, `runBounded`, catch discipline,
  `TestRunResult.code: number | null`, `classifyTestRun` null case + doc comments.
- `src/commands/job.ts` — `startWorktree` cp chain (imports `rmSync` if not present).
- `src/commands/check.ts` — timeout probe line in `healthCheck` (uses existing `haveCmd`).
- `commands/implement.md` — claim-verify `test` row; Step A `unverifiable` bullet.
- `config/prompt-templates/autoresearch/experiment.md` — step 2 portable bounding.
- `.github/workflows/ci.yml` — `check-macos` job.
- `tests/implement-verify-tests.test.ts` (or the existing file covering this module) — new cases.
- `tests/job-worktree.test.ts` — cp-chain cases with a scripted Runner.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — 0.5.41.
- `dist/ap.cjs` — rebuilt.

## Testing

- Pure: `classifyTestRun(cmd, null)` → `unverifiable`; existing cases unchanged.
  `resolveTimeoutBin` with injected have-maps: both → `timeout`; only gtimeout → `gtimeout`;
  neither → `null`.
- Execution (Linux CI runs all three `runBounded` branches for real):
  `runBounded("timeout", …, "exit 7", 30)` → code 7; `runBounded(null, …, "echo hi; exit 0", 30)`
  → code 0 + output; `runBounded(null, …, "sleep 60", 1)` → code 124 (Node bound);
  `runBounded("ap-no-such-bin-xyz", …)` → code null, non-empty output.
- cp chain with a scripted Runner: `-al` succeeds → exactly one cp call (Linux happy path
  unchanged, argv asserted verbatim); `-al` fails → `-cR` fails → `-R` succeeds (sequence
  asserted, ok logged); all three fail → warn, startWorktree still returns the worktree.
- Full gate: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`; manifest-sync,
  dist-fresh, stale-tokens gates stay green.

## Success Criteria

- With GNU `timeout` on PATH, the exact pre-change argv is what runs (asserted in tests); with
  neither binary, verify-tests emits `VERDICT=unverifiable` with a non-empty hub log — never
  `fail` — and `/ap:check` warns about the missing tooling.
- `startWorktree` on Linux still makes exactly one `cp -al` call; the chain lands a usable
  `node_modules` wherever any of the three modes works.
- No `timeout(1)` invocation remains in shipped prose without a portable alternative alongside it.
- The `check-macos` CI job passes on the PR; the ubuntu job (with the dist gate) stays green.
- 0.5.41 across the three manifests; `dist/ap.cjs` rebuilt; full suite green with the new
  coverage.
