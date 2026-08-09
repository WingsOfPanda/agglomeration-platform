# Consort Port-Parity Completion — Design

> **What this is.** The approved design for closing the 11 behavioral gaps found by the
> 2026-05-31 clone-wars → consort port audit. It restores **full clone-wars behavioral
> parity** across `score`, `rehearsal`, `perform`, and `solo` (plus one shared helper), in a
> single combined spec → single TDD plan, using consort's Hybrid convention.
>
> **Source of truth.** The behavioral reference is `<workspace>/clone-wars` (grep by
> symbol; line numbers drift). Where this design and `MIGRATION.md` differ, this design wins.
> Every fix here is a *faithful-port parity restoration*, not net-new behavior — so a single
> combined spec satisfies the phase guard in `CLAUDE.md`.

---

## 0. TL;DR

The port is structurally complete (every command/primitive/verb maps), but a script-by-script
audit found 11 behaviors present in clone-wars and absent (or narrowed) in consort. The user
elected to **restore all 11 to clone-wars parity** — including the three that looked like
deliberate consort narrowings (#8 audit "Proceed anyway", #9 claude token confirm, #10 solo
auto-finish). This design specifies each fix using the **Hybrid** convention: pure logic and
state mutation live in tested `core/*` modules + CLI verbs; AskUserQuestion prompts and
multi-step flow live in the `commands/*.md` directives.

---

## 1. Background — the 11 gaps

Grouped by severity as surfaced in the audit:

**A. Material missing features**
- **#1 score skill-hints** — topic classification (`brainstorming`/`systematic-debugging`/`none`) → `skill.txt` → append `config/skill-hints/<skill>.md` to every research and verify prompt. Absent entirely; `config/skill-hints/` does not exist in consort.
- **#2 rehearsal lib-seed** — seed `config/deep-research-lib-seed/*` into `<art>/lib/` so parts can `import` shared helpers. Absent; the experiment template still references `{{ART_DIR}}/lib/` (dangling).
- **#3 perform prose-DAG rescue** — clone-wars Step 5b: when a multi-repo `## Execution DAG` is narrative/box-art rather than parser-conforming, extract implicit lines, verify each repo on disk, edit the doc copy, re-parse. Absent; consort just stops on a malformed DAG.

**B. Recovery-path holes**
- **#4 score offset-reset** — clean-retry primitive (`consult-offset-reset.sh`): delete part-owned `findings.md`/`verify.md` + cascade downstream artifacts. Absent; a re-prompt over stale `findings.md` yields a false `FS=ok`.
- **#5 perform not-idle reset** — after a `TS=timeout`, the part's `status.json` stays non-idle; clone-wars offers Wait-60s / Force-retry (atomic reset) / Abort. Absent; consort's auto-retry dead-ends on the not-idle gate.
- **#6 perform proceed-degraded** — multi-repo wave failure → retry-once, then "proceed degraded" by dropping the failed sub-repo. Absent; one sub-repo failure aborts the whole run.

**C. UX / ergonomic regressions**
- **#7 perform source-default** — no-arg invocation finds the newest `_consult` design doc and confirms. Absent; consort hard-errors without an explicit path.
- **#8 perform audit-proceed** — audit-FAIL "Proceed anyway" override + distinct rc for unreadable (rc 2) vs FAIL (rc 1). Narrowed to a hard stop.
- **#9 perform claude-confirm** — token-cost confirmation before spending claude tokens on a plugin-repo deploy (with codex fallback). Dropped; consort spawns claude silently.
- **#10 solo auto-finish** — strike always pushed + opened a PR on a repo with a remote; consort gates this behind opt-in `--finish`.

**D. Cosmetic bug**
- **#11 preSnapshot wording** — `gitwork.preSnapshot` hardcodes `chore: WIP before solo <topic>`; wrong for `perform` runs (shares the function).

---

## 2. Scope & decisions (locked)

- **Restore all 11**, including #8/#9/#10, to clone-wars parity.
- **One combined spec + one TDD plan**; plan tasks grouped by command.
- **Hybrid implementation** (Approach 3): tested `core/*` + CLI verb for logic/state; directive for prompts/flow.
- **#10 escape hatch:** restore auto-finish-by-default **and** add `--no-finish` (a small consort superset of strike's always-finish). Legacy `--finish` remains accepted (no-op alias).

---

## 3. Architecture & conventions

- **Hybrid split (house rule).** Pure functions and atomic state mutations → `core/*` modules with vitest coverage, exposed as CLI verbs via the existing DI pattern (`<verb>With(args, deps)` / `live<Verb>Deps` / thin `<verb>Run`). AskUserQuestion prompts, the multi-step orchestration, and `tmux`-driving steps → the `commands/*.md` directive. This mirrors how `perform` already separates `performQuestions.ts` (logic) from `perform.md` (flow).
- **Frozen protocol untouched.** No changes to event names, `END_OF_INSTRUCTION`, the `From:` header, JSON field names, status states, `pane.json` keys, `handoff-data.kv` key set/order, the repo hash, or `CLAUDE_CODE_SESSION_ID`. CLI-internal **verb names** and **env-var names** are *not* frozen → they get consort names.
- **Stale-token gate compliance.** `tests/stale-tokens.test.ts` scans `src config commands hooks .claude-plugin`. The two new shipped config directories (`config/skill-hints/*`, `config/rehearsal-lib-seed/*`) are therefore scanned and **must be scrubbed on port**: Yoda→Maestro, trooper→part, commander→instrument, clone-wars→consort, `cw_`→dropped, `master-yoda`→`maestro`, `@cw_`→`@cs_`, "MISSION ACCOMPLISHED"→"FINE". Scrubbing is a required step in each porting task, never weaken the gate.
- **Atomic writes** (tmp-in-same-dir + rename) for every `status.json`/`parts.txt`/state mutation introduced here.
- **All renames remain cosmetic** — the consort art-dir already uses `_score`/`_rehearsal`/`_perform`/`_solo`; ported paths target those (e.g. source-default searches `_score/design-doc/`, not `_consult/`).

---

## 4. The fixes (detailed)

Each entry: **Source** (clone-wars) · **Restore** (behavior) · **Placement** (consort) · **Interface** · **Tests**.

### 4.1 Shared — #11 preSnapshot wording

- **Source:** `gitwork.ts:preSnapshot` commits dirty trees as `chore: WIP before solo ${topic}`; clone-wars `deploy_pre_snapshot` uses `chore: WIP before deploy <topic>`.
- **Restore:** the WIP commit message must name the running command.
- **Placement:** `core/gitwork.ts` only.
- **Interface:** add a `command: string` parameter → `preSnapshot(repo, topic, command)`; message `chore: WIP before ${command} ${topic}`. Callers: `solo` passes `"solo"`, `perform` passes `"perform"`.
- **Tests:** preSnapshot commit message includes the command label for both callers.
- **Why first:** shared by `solo` and `perform`; landing it first unblocks both snapshot callers cleanly.

### 4.2 score

**#1 skill-hints**
- **Source:** `consult-init.sh:118` (`cw_consult_classify_topic` → `skill.txt`), `consult-research-send.sh:30` + `consult-verify-send.sh:110` (`cw_consult_skill_hint_append` → append `config/skill-hints/<skill>.md`), env kill-switch `CW_CONSULT_SKILL_OVERRIDE=none`.
- **Restore:** classify the topic to a Claude Code skill name, persist it, and append the corresponding hint text to every research and verify prompt; env override forces `none`.
- **Placement:** new `config/skill-hints/{brainstorming,systematic-debugging,none}.md` (ported verbatim, **scrubbed**); new `core/scoreSkill.ts`; wired into `score init` (write `_score/skill.txt`) and `score.ts:researchSendWith`/`verifySendWith` (append after building the base prompt — matching clone-wars' append-in-send).
- **Interface:**
  - `classifyTopic(topic: string): "brainstorming" | "systematic-debugging" | "none"` — whole-word case-insensitive keyword match; **`brainstorming` wins ties**; keyword sets ported verbatim from clone-wars.
  - `skillHintAppend(basePrompt: string, skill: string, hintsDir: string): string` — returns `basePrompt` unchanged when `skill === "none"` or `CONSORT_SCORE_SKILL_OVERRIDE === "none"`, else `basePrompt + "\n\n" + <hint file contents>`.
  - Note: `preludeLit.ts` already exports a differently-typed `classifyTopic`; `scoreSkill.ts` keeps its own (separate module, no shared export).
- **Tests:** classify keyword cases + brainstorming tie-break; append concatenation; `none`/override short-circuit; unknown skill → falls back to `none`; `score init` writes `skill.txt`.

**#4 offset-reset**
- **Source:** `consult-offset-reset.sh` — "the only documented retry primitive": removes `_consult/<phase>-<commander>.txt`, always clears `question-<commander>.txt`, and unless `--keep-findings` deletes the part-owned `findings.md`/`verify.md` (globbed across model dirs), cascading: research-phase → remove `diff.md` + `*_only_items.txt`; both phases → remove `adjudicated-draft.md`.
- **Restore:** a clean-retry primitive that invalidates a part's prior turn and the downstream artifacts derived from it.
- **Placement:** new `score offset-reset` verb in `score.ts`; cascade target-set computed by a pure tested fn (in `score.ts` core or a small `core/scoreReset.ts`).
- **Interface:** `score offset-reset <topic> [<phase>] [--keep-findings]`; `cascadeTargets(phase, keepFindings) → { globs: string[], files: string[] }` (pure). Faithful to the bash phase/instrument scoping; paths use `_score`.
- **Tests:** cascade target-set per phase × `--keep-findings`; clears `question-<instrument>.txt`; `--keep-findings` preserves `findings.md`/`verify.md`.

### 4.3 rehearsal — #2 lib-seed

- **Source:** `deep-research-init.sh:172` (`cw_deep_research_seed_lib`) copies `config/deep-research-lib-seed/{arena.py,__init__.py,README.md}` into `<art>/lib/`; `experiment.md:44-54` points parts at `{{ART_DIR}}/lib/`.
- **Restore:** populate `<art>/lib/` at init so the experiment template's reference resolves.
- **Placement:** new `config/rehearsal-lib-seed/{arena.py,__init__.py,README.md}` (ported, **scrubbed** — the gate scans `config/`); best-effort `seedLib(artDir)` in `rehearsal.ts:initWith` after the art-dir mkdir.
- **Interface:** `seedLib(artDir: string): void` — copies each seed file into `<artDir>/lib/`, skip-if-exists, **never throws** (matches the bash best-effort helper).
- **Tests:** copies all seed files; idempotent skip-if-exists; missing source dir → no throw.

### 4.4 perform

**#3 prose-DAG rescue**
- **Source:** `deploy.md:138-375` (Step 5b), env gate `CW_DEPLOY_FORCE_RESCUE_PROMPT`. Extract implicit `N. <slug> — <desc>` lines from a narrative/box-art DAG, verify each `<slug>` against on-disk repo layout (dir exists + `CLAUDE.md`/`AGENTS.md`), Edit parser-conforming lines into the design-doc copy, re-run `dag-parse` + `multi-init` **once**.
- **Restore:** auto-rescue a non-parseable multi-repo DAG instead of hard-failing.
- **Placement:** new pure CLI verb `perform verify-dag-repos` (logic in `core/dag.ts` or `core/multirepo.ts`); rescue **stage** in `perform.md` (Maestro extracts lines → calls verify → Edits the doc copy → re-runs parse+multi-init, one-shot, env-gated by `CONSORT_PERFORM_FORCE_RESCUE`, no loop).
- **Interface:** `verify-dag-repos` takes candidate slugs (or the doc) and reports per-slug `ok|missing-dir|missing-marker`. The line-extraction + Edit is the Maestro's job in the directive (not a CLI verb).
- **Tests:** `verify-dag-repos` repo-layout check (dir present, marker present/absent, slug missing).

**#5 not-idle reset**
- **Source:** `deploy.md:636-655` — on turn-send "trooper not idle": AskUserQuestion Wait-60s / Force-retry (atomically reset `status.json` → idle) / Abort.
- **Restore:** a force-reset path for a part left non-idle by a timeout.
- **Placement:** new `perform reset-status <topic> <instrument>` (atomic `status.json` → `state:"idle"`); `perform.md` Stage 1 sub-menu on the not-idle refusal (the `turnSendWith` not-idle gate already exists at `perform.ts:136`).
- **Interface:** `reset-status` atomic-writes the idle state (preserving unrelated fields where present).
- **Tests:** atomic idle write; round-trips through the existing not-idle gate.

**#6 proceed-degraded**
- **Source:** `deploy.md:1018-1051` — first wave failure → retry-once (full teardown + re-preflight + re-dispatch); second failure → AskUserQuestion "Proceed degraded with N=M" (rewrite `troopers.txt` dropping the failed part) / "Abort all".
- **Restore:** ship the rest of a multi-repo run when one sub-repo persistently fails.
- **Placement:** new `perform drop-part <topic> <instrument>` (rewrite `parts.txt`, return new N); `perform.md` Stage 3b retry-once → AskUserQuestion ladder.
- **Interface:** `drop-part` removes the instrument's row from `parts.txt` atomically and reports the new N.
- **Tests:** `parts.txt` rewrite removes exactly the target row; new N correct; no-op when absent.

**#7 source-default**
- **Source:** `deploy.md` Step 0.4 — no positional `.md` → find newest `*/_consult/design-doc/*-design.md` + AskUserQuestion Use-this / Cancel. consort `initWith` (`perform.ts:85`) hard-errors `return 2`.
- **Restore:** no-arg ergonomics — default to the freshest score output.
- **Placement:** new `perform find-latest-doc [--cwd <dir>]` (newest `*/_score/design-doc/*-design.md` by mtime); `perform.md` Stage 0 no-arg branch → confirm.
- **Interface:** `find-latest-doc` prints the path or empty (none found). `init` keeps requiring an explicit path; the *default* is supplied by the directive.
- **Tests:** newest-by-mtime selection; none-found → empty.

**#8 audit-proceed**
- **Source:** `deploy.md:394-413` — audit as a separate step distinguishing `AUDIT_RC=2` (unreadable → archive + stop) from `AUDIT_RC=1` (FAIL → AskUserQuestion "Proceed anyway / Abort and edit doc"). consort `initWith` (`perform.ts:92`) folds audit in and returns rc 1 unconditionally on FAIL.
- **Restore:** the override escape + the unreadable/FAIL distinction.
- **Placement:** new standalone `perform audit <doc>` returning rc 0/1/2 (0=PASS, 1=FAIL, 2=unreadable); `perform init --force` to bypass a FAIL; `perform.md` Stage 0 runs audit then branches (rc2 → archive+stop; rc1 → AskUserQuestion Proceed-anyway[`init --force`] / Abort-and-edit).
- **Interface:** `audit` reuses `audit.ts:auditDoc`; `--force` lets `init` proceed past a FAIL verdict.
- **Tests:** audit rc mapping (PASS/FAIL/unreadable); `init --force` bypasses FAIL; `init` without `--force` still stops on FAIL.

**#9 claude-confirm**
- **Source:** clone-wars writes `auto_provider.txt`; `deploy.md` Step 0.8 → AskUserQuestion before using `claude` on a plugin repo (codex fallback). consort writes `provider.txt` (`perform.ts:110`) and spawns unconditionally.
- **Restore:** a token-cost confirmation gate before a claude spawn.
- **Placement:** `perform init` writes an `auto_provider.txt` marker recording the auto-detected provider; `perform.md` Stage 1 → if detected provider is `claude`, AskUserQuestion Use-claude / Fall-back-to-codex before spawn.
- **Interface:** marker write only; the gate is in the directive. Provider detection (`perform.ts:detectProvider`) is unchanged and already tested.
- **Tests:** `init` writes `auto_provider.txt` with the detected value.

### 4.5 solo — #10 auto-finish

- **Source:** `strike` (`commands/strike.md:277`) **unconditionally** runs `deploy-finish.sh`: local-only repo → keep branch + restore checkout; repo with a remote → `git push` + `gh pr create`. consort `parseSoloArgs` defaults `finish=false`; `finishWith` short-circuits to branch-only unless `--finish`.
- **Restore:** auto-finish by default (parity), with a `--no-finish` opt-out (consort superset).
- **Placement:** `core/solo.ts:parseSoloArgs` (default `finish=true`, add `--no-finish`); `finishWith` logic unchanged (local→keep+restore / remote→push+PR); `solo.md` updated to document default-finish + `--no-finish`; document the restored auto-finish inline so a future audit doesn't re-flag it.
- **Interface:** `--no-finish` → `finish=false`; bare `--finish` still parses (legacy no-op alias).
- **Tests:** default `finish=true`; `--no-finish` → false; legacy `--finish` still parses true.

---

## 5. Naming (decided)

- **Env vars:** `CONSORT_SCORE_SKILL_OVERRIDE` (was `CW_CONSULT_SKILL_OVERRIDE`), `CONSORT_PERFORM_FORCE_RESCUE` (was `CW_DEPLOY_FORCE_RESCUE_PROMPT`).
- **New CLI verbs:** `score offset-reset`, `perform verify-dag-repos`, `perform reset-status`, `perform drop-part`, `perform find-latest-doc`, `perform audit`, `perform init --force`, `solo --no-finish`.
- **Config dirs:** keep `config/skill-hints/`; rename `deep-research-lib-seed/` → `config/rehearsal-lib-seed/`.

---

## 6. Testing strategy

- **vitest unit** per new `core` function; `CONSORT_HOME` set to a fresh temp dir per test (`tests/helpers/tmpHome.ts`).
- **tmux/state code** tested as pure arg-array builders / atomic-write assertions; never spawn real panes.
- **Directive (`.md`) flows** validated by extending the existing `scripts/dogfood-*.sh` simulators where cheap (e.g. a degraded-wave path, a not-idle reset, a source-default pick) — real `node dist/consort.cjs` against a throwaway `CONSORT_HOME`.
- **Gates green before every commit:** `npm run typecheck`, `npm run test`, `npm run lint`, and the stale-token gate (new config files scrubbed). After `src/` changes, `npm run build` and commit the refreshed `dist/consort.cjs`.

---

## 7. Sequencing (for the plan)

1. **#11** preSnapshot `command` param (shared — unblocks solo/perform snapshot).
2. **score:** #1 skill-hints, #4 offset-reset.
3. **rehearsal:** #2 lib-seed.
4. **perform:** #3 verify-dag-repos + rescue stage, #5 reset-status, #6 drop-part, #7 find-latest-doc, #8 audit/`--force`, #9 claude-confirm marker.
5. **solo:** #10 auto-finish default + `--no-finish`.
6. Final: rebuild `dist/`, full-suite + dogfood, holistic review.

≈12–14 bite-sized TDD tasks in one combined plan.

---

## 8. Risks

- **Stale-token gate on ported config files** — `config/skill-hints/*` and `config/rehearsal-lib-seed/*` are gate-scanned; scrub-on-port is a required step in each relevant task.
- **`classifyTopic` name collision** — `preludeLit.ts` already exports one; `scoreSkill.ts` keeps a separate, differently-typed function (no shared export).
- **prose-DAG rescue is the most complex + mostly directive** — keep the CLI helper pure/small, the rescue one-shot, env-gated; do not introduce a re-parse loop.
- **#8/#9/#10 reverse consort's current (narrower) behavior** — document the restoration inline in `perform.md`/`solo.md` so a future audit does not re-flag it as a regression.
- **`dist/` drift** — every task that touches `src/` must rebuild and commit `dist/consort.cjs`.

---

## 9. Non-goals

- No new providers; no protocol/wire changes; no `handoff-data.kv` key changes.
- No refactors beyond what each fix requires; no behavior beyond clone-wars parity.
- No new high-level commands; this is parity completion, not feature work.

---

## 10. Acceptance criteria

- All 11 gaps closed with the behavior described in §4; #8/#9/#10 restored to clone-wars parity (with the `--no-finish` opt-out for #10).
- New `core` logic unit-tested; full vitest suite, `typecheck`, `lint`, and the stale-token gate all green.
- `config/skill-hints/` and `config/rehearsal-lib-seed/` present and scrubbed; `rehearsal`'s `<art>/lib/` is populated at init.
- `dist/consort.cjs` rebuilt and committed; the relevant dogfood simulators exercise the new recovery/UX paths.
- A re-run of the port audit over these 11 items reports no remaining gaps.

---

*Reference: `<workspace>/clone-wars` (grep by symbol). Audit basis: the 2026-05-31 five-family
behavior diff. This design is the contract; the Bash code is the behavioral spec.*
