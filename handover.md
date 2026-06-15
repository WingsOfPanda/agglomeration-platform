# Handover — agglomeration-platform

**As of:** 2026-06-15 · `main` @ v0.3.0 · all green (typecheck · 1103 tests · lint · build).

This repo is the renamed **`agglomeration-platform`** (formerly `consort`). The rename +
de-musicalization is **complete** (3 PRs: #61 brand, #62 role nouns + cast, #63 verbs + docs).
Dev now continues on the GPU box (`bl201` = `gpu` = 47.84.226.25) at
`/home/liupan/Aerius/agglomeration-platform` — already cloned, `npm install`ed, and verified.

---

## How to work in this repo (orientation)

- **One esbuild bundle:** `dist/ap.cjs` (committed, zero-build install), dispatched by subcommand
  `src/ap.ts` → `src/commands/<verb>.run(args)`. Core logic in `src/core/*`.
- **After any `src/` change:** `npm run build` and **commit the refreshed `dist/ap.cjs`** (a stale
  dist is the #1 recurring footgun — tests that exec the bundle, like `tests/ap-dispatch.test.ts`,
  fail if dist isn't rebuilt).
- **Commands:** `npm run typecheck` · `npm run test` (vitest) · `npm run lint` · `npm run build`.
- **Read first:** `CLAUDE.md` (conventions, vocabulary, frozen protocol), `MIGRATION.md` (architecture,
  historical names), `docs/superpowers/specs/` (one spec per command/feature).
- **Vocabulary:** hub / agent / worker / cluster / DONE; commands
  `design explore autoresearch implement quick review list stop check bridge`; primitives
  `spawn send collect preflight hook`. Cast = NATO `alpha`..`zulu` in color clusters
  (azure/sage/amber/slate/ivory/violet) — `config/agents.yaml` + `src/core/colors.ts`.

### Don't break these (load-bearing)

- **Frozen wire protocol** (drop-in compat with external `codex`/`claude`/`agy`/`opencode`): event
  names `ready/ack/progress/done/error/question`; sentinel `END_OF_INSTRUCTION`; JSON fields
  `ts/summary/artifacts/note/message/fatal/task_summary/model/topic`; `contracts.yaml` keys
  (incl. **`consult_validated`** — kept that name though the command is now `design`); state
  filenames; `CLAUDE_CODE_SESSION_ID`.
- **`score` metric ≠ `score` command.** `autoresearch` keeps a `score` subcommand + a scoreboard
  metric (`buildScoreboard`/`ScoreRow`/`computeScore`) — that `score` stays; only the old `score`
  *command* became `design`. Never blanket-rename `score`.
- **Stale-token gate** (`tests/stale-tokens.test.ts`): bans `consort`/`cs_`/`@cs_`/`maestro`/
  `instrument` + clone-wars-era terms. Do **not** add generic English (`part`/`section`/`score`/
  `perform`/`solo`/`fine`) — false positives. Fix the file, never weaken the gate.
- **Never touch `target-user-analysis.*`** (untracked; keep them out of every commit).
- **Single-repo only** — the multi-sub-repo subsystem was retired; don't reintroduce it.

---

## What's left to do

### 1. Publish-readiness (the next spec — highest priority)

Make the plugin genuinely installable/usable for others. Brainstorm + spec this under
`docs/superpowers/specs/` before implementing. Scope to decide:

- **`package.json` `"private": true`** — remove it if publishing to npm (so `npx`/`@scope` resolves),
  or keep it if distribution stays marketplace-only. Decide the distribution model first.
- **Marketplace listing** — verify `/plugin marketplace add WingsOfPanda/agglomeration-platform` +
  `/plugin install ap@agglomeration-platform` works end-to-end from a clean machine; confirm
  `marketplace.json` / `plugin.json` are correct for discovery.
- **Prune dev artifacts** — `target-user-analysis.{html,md}` (untracked) and any dogfood/scratch files
  that shouldn't ship; decide what belongs in the published package.
- **README polish** — install/usage/quickstart beyond the rename; a real "getting started" path.
- (Optional) **Codex dual-publish** — `.codex-plugin/plugin.json` + the codex marketplace, if you
  want the plugin available in the Codex CLI too.

### 2. Fix the stale dogfood (Scenario B)

`scripts/dogfood-port-parity.sh` **Scenario B** tests `implement drop-worker` (was `perform
drop-part`), a verb **removed in the multi-repo retirement** — so the dogfood permanently reports
`FAILURES PRESENT` (5/17), masking real failures. Remove or rewrite Scenario B so the dogfood is a
trustworthy gate again. Small, self-contained PR.

### 3. (Optional / lower priority)

- **`MIGRATION.md`** is still written in the historical `consort`/musical vocabulary (it carries a
  rebrand banner). Rewrite for the current identity, or leave it as a dated architecture record.
- **Gate enforcement of musical residue** — we intentionally did *not* ban the old command verbs or
  cast names (generic-English collisions / impractical). Revisit only if regressions appear.

---

## Pointers

- Rebrand spec/plan: `docs/superpowers/specs/2026-06-15-agglomeration-platform-rebrand-design.md`,
  `docs/superpowers/plans/2026-06-15-agglomeration-platform-rebrand.md`.
- Multi-repo retirement (why single-repo): `docs/superpowers/specs/2026-06-04-multi-repo-retirement-design.md`.
- Process: brainstorm (superpowers:brainstorming) → spec → writing-plans → execute, one phase at a
  time. Land work as small PRs off `main`; rebuild `dist/` + bump version inside the feature PR.
