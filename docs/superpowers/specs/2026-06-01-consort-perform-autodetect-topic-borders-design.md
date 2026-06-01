# consort `perform`: test-command auto-detect, topic-length guard, and pane-border hardening

**Date:** 2026-06-01
**Status:** approved (design)
**Branch:** `feat/perform-autodetect-topic-borders`

## Origin

A live `/consort:perform` run on the **iris-code** target (an npm/TS repo) surfaced three
problems, found via `/consort:playback` + a follow-up adversarially-verified investigation:

1. The part halted at round 1 asking what test command to run — the perform prompt hardcodes
   `bash tests/run.sh`, which does not exist in an npm/TS repo.
2. A doc-derived topic slug `iris-code-simplify-sweep-2-tiers-bce` (36 chars) was **accepted by
   `perform init`** but **rejected by `spawn`** (32-char cap), forcing a manual reset/re-init.
3. The spawned part pane showed no label on its border. Root-caused to a **window-local
   `pane-border-status off` override** on the iris-code tmux window that defeated consort's
   global-only `set -g` — the part label was set but never rendered.

This spec covers all three. They share the `perform` / `spawn` surface and ship as one PR.

## Verified root causes

### ① Hardcoded test command (single-repo perform prompts)
- `src/core/performTurn.ts:79` — `composeRound1Prompt` PHASE 2 literally says
  ``Run the full test suite (`bash tests/run.sh`)``.
- `src/core/performTurn.ts:32-46` — the module-level `BLOCKERS` const repeats the
  `bash tests/run.sh` literal at line 45, and is appended by **both** `composeRound1Prompt`
  (line 93) and `composeFixPrompt` (line 183).
- `src/core/performTurn.ts:100-135` — the multi-repo `composeDagUnitPrompt` is **already
  command-agnostic** (no literal, no `BLOCKERS`). Out of scope.
- A reusable detector already exists: `src/core/solo.ts:43-55`
  `detectTestCommand(root): string` → `tests/run.sh`→`"bash tests/run.sh"` > `package.json`
  `scripts.test`→`"npm test"` > `Makefile` `/^test:/`→`"make test"` >
  (`pyproject.toml`||`setup.cfg`)+`tests/`→`"pytest"`; `""` when none. Pure, exported, never executes.
- perform knows the target root at compose time: `art/target_cwd.txt`
  (written at `perform.ts:155`), read in `turnSendWith` (`perform.ts:174-192`).

**clone-wars relationship:** `deploy.sh:160,207` hardcodes `bash tests/run.sh`; only
`strike.sh` (the solo lineage) auto-detects, and even there detection feeds the *conductor's*
verification, never the part prompt. So auto-detecting in perform's **part prompt** is an
**enhancement beyond a faithful port**, not a parity restore. Per the phase guard it needs this spec.

### ② Topic length not validated at `perform init`
- `src/commands/spawn.ts:17,36` — `validateSlug` caps topics at 32 chars and `spawn`
  **hard-rejects** (`rc 2`) a longer one.
- `src/commands/perform.ts:132-133` — `initWith` only checks emptiness; no length/charset guard.
  The over-length topic is written to `topic.txt` and emitted as `TOPIC=`, then explodes when the
  Maestro runs `spawn` at `commands/perform.md` Stage 1.1.
- `src/core/perform.ts:24-31` — `deriveTopicFromPath` has no length cap (faithful port).
- The exact guard regex already exists in this codebase at `src/commands/perform.ts:645`
  (wave-wait): `/^[a-z0-9][a-z0-9-]{0,31}$/`.
- Sibling commands are safe: solo/score/prelude derive via `deriveSlug` (`solo.ts:9-18`,
  `.slice(0,20)`); rehearsal caps at 20. Only perform's derivation is unbounded.

**clone-wars relationship:** `deploy-init.sh:59` calls `cw_deploy_assert_topic`
(`deploy.sh:26-29`, regex `^[a-z0-9][a-z0-9-]{0,31}$`) right after deriving, so clone-wars
**rejects an over-length topic at init**. consort dropped that call. This is a **parity
restoration** of a dropped guard — fully in scope, no new behavior.

### ③ Part-pane label suppressed by a window-local border override
- `src/core/tmux.ts:41-49,76-78` — `ensurePaneBorders` runs `paneBorderArgs()`, which sets
  `pane-border-status` and `pane-border-format` with **`set -g` (global window-option)** only,
  and **silently swallows** any tmux error (`catch { /* tolerate */ }`).
- `pane-border-status` is a **window option**. A window-local `pane-border-status off` (as found
  live on the iris-code window) overrides the global `top`, so a pane spawned into that window
  shows no border — the `@cs_label` set by `paneLabelSet` (`tmux.ts:112-121`) never renders.
- perform has **no pane code of its own**; it reuses the `spawn` verb (`commands/perform.md`
  Stage 1.1), so this affects every spawn path, not just perform.

**clone-wars relationship:** clone-wars never set `pane-border-status`/`format` itself (medic only
*warned*). consort's `ensurePaneBorders` is already a **consort-introduced** hardening; this change
extends it (window-scoped status + visible warning), folded into this spec.

## Design

### Fix A — perform auto-detects the test command (single-repo only)

Thread a detected command into the single-repo part prompts; fall back to generic wording when none.

- **`src/core/performTurn.ts`:**
  - Replace the module-level `BLOCKERS` const with a function `blockers(testCmd: string): string`.
    The `'test' kind` note (currently line 44-46) becomes: when `testCmd` is non-empty,
    ``Running '<testCmd>' is your job.``; when `""`, `Running your repository's test suite is your job.`
  - `composeRound1Prompt` gains a `testCmd: string` field in its args object. PHASE 2 (line 79):
    when `testCmd` non-empty → ``Run the full test suite (`<testCmd>`) after each task and confirm green.``;
    when `""` → `Run the repository's full test suite after each task and confirm green.`
    Append `blockers(testCmd)` instead of the const.
  - `composeFixPrompt` gains a `testCmd: string` param and appends `blockers(testCmd)`.
- **`src/commands/perform.ts` (`turnSendWith`, lines 174-192):**
  - Import `detectTestCommand` from `../core/solo.js`.
  - Read target root: `targetCwd = existsSync(join(art,"target_cwd.txt")) ? readFileSync(...,"utf8").trim() : ""`.
  - `const testCmd = targetCwd ? detectTestCommand(targetCwd) : "";`
  - Pass `testCmd` into both `composeRound1Prompt({...})` and `composeFixPrompt(round, bundle, verifyPath, testCmd)`.
- **Out of scope:** `composeDagUnitPrompt` (already generic); `performQuestions.ts:111` `tests/run.sh`
  ban stays as-is (a detected `npm test`/`make test`/`pytest` is not matched by it, so it does not
  interfere); generalizing the ban is deferred.

### Fix B — perform validates topic length at init (parity restore)

- **`src/core/perform.ts`:** add, after `deriveTopicFromPath` (line 31), a pure helper:
  `export function assertPerformTopic(topic: string): boolean { return /^[a-z0-9][a-z0-9-]{0,31}$/.test(topic); }`
- **`src/commands/perform.ts` (`initWith`, after the empty-check at line 133, before the art dir
  is created at line 142/152):**
  `if (!assertPerformTopic(topic)) { log.error(\`perform init: invalid topic slug '${topic}' (must match ^[a-z0-9][a-z0-9-]{0,31}$, <= 32 chars; pass a shorter --topic)\`); return 2; }`
  Covers both `--topic` and the derived slug (they are already collapsed to one `topic` value).
  Fails before any art-dir mkdir, so no debris (matches clone-wars, which asserts before scaffolding).
- **`src/commands/perform.ts` (`waveWaitRun`, line 645):** replace the inline
  `/^[a-z0-9][a-z0-9-]{0,31}$/.test(topic)` with `!assertPerformTopic(topic)` so the two call sites
  cannot drift. The instrument/provider checks on that line are unchanged.
- **Decision:** validate-and-reject, **not** truncate. Truncation could collide two distinct design
  docs onto one topic dir / one `feat/perform-<topic>` branch (data-loss risk). `rc 2` matches
  clone-wars exit 2 and spawn's reject code.

### Fix C — harden `ensurePaneBorders` (window-scoped status + visible failure)

- **`src/core/tmux.ts`:**
  - Add a pure arg builder `windowBorderStatusArgs(target: string): string[]` →
    `["set-option", "-w", "-t", target, "pane-border-status", "top"]`, and an execa wrapper
    `ensureWindowBorderStatus(target: string): Promise<boolean>` (returns `false` on tmux error,
    never throws).
  - Change `ensurePaneBorders()` to return whether all border commands succeeded
    (`Promise<boolean>`), still tolerating individual failures (no throw).
- **`src/commands/spawn.ts`:**
  - At line 43: `if (!(await ensurePaneBorders())) log.warn("could not set pane-border globals; part labels may not render");`
  - After the spawned `pane` is resolved (after the `if (targetPane) … else …` block, before
    `paneMetaWrite` at line 92): `if (!(await ensureWindowBorderStatus(pane))) log.warn(\`could not force pane-border-status on the spawn window; '${labelFor(instrument, model, topic)}' label may not render\`);`
    This sets the status on the **part pane's window** so a window-local `off` override can't
    suppress the label. (The conductor and part share that window in the no-target split path.)
- **`src/core/tmux.ts` (`preflightLayout`, score escalation):** after the split loop and before/
  after `selectLayoutMainVertical`, call `await ensureWindowBorderStatus(conductor)` so the score
  path is covered too.
- **Decision (locked):** label only **part** panes (already done by `paneLabelSet`). The
  conductor/Maestro pane is **not** labeled — faithful clone-wars behavior, explicitly kept.
- Border warnings go to **stderr** (via `log.warn`) and are never fatal — borders are cosmetic.

## Testing strategy

Unit tests for the pure helpers; suite-as-gate for the integration-shaped wiring (no live tmux in
unit tests, per the project convention).

- **Fix A:** `composeRound1Prompt` with `testCmd:"npm test"` contains `npm test` and **no**
  `bash tests/run.sh`; with `testCmd:""` contains the generic fallback and no backtick command.
  `blockers("npm test")` names `npm test`; `blockers("")` uses the generic wording and contains no
  `bash tests/run.sh`. `composeFixPrompt(2, "...", "/v.md", "make test")` names `make test`.
- **Fix B:** `assertPerformTopic` accepts `iris-code-simplify` and a 32-char slug; rejects the
  36-char `iris-code-simplify-sweep-2-tiers-bce`, an empty string, leading `-`, and `Bad_Topic`.
  `initWith` with a 36-char `--topic` returns `2` and creates **no** art dir (assert via a temp
  `CONSORT_HOME`/`CONSORT_PERFORM_ART_DIR_OVERRIDE` and a non-existent art path afterward).
- **Fix C:** `windowBorderStatusArgs("%5")` equals
  `["set-option","-w","-t","%5","pane-border-status","top"]`. (`ensurePaneBorders` return value and
  the live `ensureWindowBorderStatus`/`log.warn` paths are covered by the suite-as-gate + dogfood.)
- Full gate (`npm run typecheck && npm run lint && npm run test`) green; stale-token test stays
  green (keep new comments free of the banned tokens).

## Acceptance criteria

1. A single-repo `perform` round-1/fix prompt on an npm repo instructs `npm test` (and never
   `bash tests/run.sh`); on a repo with no detectable suite it uses the generic fallback.
2. `perform init` with a >32-char or malformed topic exits `2` with a message pointing at `--topic`,
   before scaffolding any art dir; `wave-wait` shares the same guard.
3. `spawn` forces `pane-border-status top` on the spawn window, so a window-local `off` override no
   longer suppresses the part label; a failure to set borders emits a stderr warning instead of
   being swallowed. The conductor pane remains unlabeled.
4. `dist/consort.cjs` is rebuilt and committed; full gate green.

## Out of scope / deferred

- Labeling the conductor (Maestro) pane (explicitly declined).
- Generalizing the `performQuestions.ts:111` `tests/run.sh` ban to the detected command.
- Teaching the multi-repo DAG prompt / conductor verify to use per-sub-repo `detectTestCommand`.
- Raising spawn's 32-char cap (a FROZEN cross-binary contract surface).

## Risks

- **Prompt drift:** changing the round-1/fix prompt text risks diverging from the byte-faithful
  port. Mitigation: only the test-command sentence and the `BLOCKERS` `test`-kind note change;
  everything else (including the multi-repo prompt) is untouched, and the generic fallback mirrors
  solo's existing wording.
- **`assertPerformTopic` over-rejection:** the regex is exactly clone-wars' `cw_deploy_assert_topic`
  and spawn's cap, so it cannot reject anything spawn would have accepted.
- **Border change too broad:** `set -w` on the spawn window is idempotent and only ever sets
  `top`; it cannot turn borders off, and warnings are non-fatal.
