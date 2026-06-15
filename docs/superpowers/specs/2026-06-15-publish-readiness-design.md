# Publish-readiness — Claude Code marketplace install

**Date:** 2026-06-15 · **Status:** approved (brainstorm) · **Branch:** `publish/marketplace-readiness`

## Goal

Make `agglomeration-platform` genuinely installable and usable by others via the Claude Code
marketplace, and verify that path end-to-end. This is a **verify + polish + lock-in** spec, not a
repair — the install path already works (see *Current state*).

## Decisions (resolved at brainstorm)

| Fork | Decision | Consequence |
|---|---|---|
| Distribution model | **Marketplace-only** | Keep `"private": true` in `package.json`. No `npm publish`. The Claude Code install vector is git-based (`/plugin marketplace add`); the hook runs the committed local `dist/ap.cjs`, and nothing uses `npx`, so npm adds a release step with zero install benefit. |
| Codex CLI | **Claude Code only** | No `.codex-plugin/` in this spec. Codex dual-publish stays an optional future item. |
| Scope size | **Approach B** | Concrete fixes + a permanent manifest-validity test + version bump. (Approach A = fixes only, no guard; Approach C = full CONTRIBUTING/CHANGELOG kit, rejected as YAGNI.) |

## Current state (evidence, 2026-06-15)

- GitHub repo `WingsOfPanda/agglomeration-platform` is **public**.
- `.claude-plugin/marketplace.json` and `plugin.json` are valid JSON; marketplace maps `ap -> ./`;
  the hook command (`node ${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs hook user-prompt-submit`) is correct.
- `dist/ap.cjs` is self-contained: it requires only `node:` built-ins — `execa` and `yaml` are
  inlined by esbuild — so the zero-build install works with **no `node_modules`** at install time.
- Hook smoke test (`hook user-prompt-submit`, isolated `AP_HOME`) runs clean.
- All 10 commands ship under `commands/`; `.antigravitycli/` in `.gitignore` is legitimate (the
  `agy` provider dir, referenced in `config/contracts.yaml`).
- `target-user-analysis.*` does **not** exist in this clone — nothing to prune.

## Concrete gaps (the actual work)

1. **README "Commands" table is missing `/ap:bridge`** — 10 commands ship, 9 are listed.
2. **GitHub repo description is empty.**
3. **`.gitignore` has a stale `.consort/`** entry (pre-rebrand) instead of `.ap/`.
4. **No automated guard** that the manifests stay valid and the three `version` fields stay in sync.

## Changes (Approach B)

### 1. README polish
- Add a `/ap:bridge` row to the Commands table, sourced from `commands/bridge.md` frontmatter
  (cross-repo: open a persistent worker inside a *different* git repo and co-develop over rounds,
  finishing as a PR there, while you stay in your own repo).
- Add a short **"Getting started"** subsection after Install: install → `/ap:check` to detect
  available model CLIs and pick the active provider set → first run (`/ap:quick "<task>"` for a fast
  unattended change, or the `explore → design → implement` flow). No restructure of existing sections.

### 2. GitHub repo description
- Set via `gh repo edit WingsOfPanda/agglomeration-platform --description "..."` to the one-liner
  `Multi-model tmux pane orchestration for Claude Code` (matches `package.json`/manifests).

### 3. `.gitignore`
- Replace stale `.consort/` with `.ap/` (matches the rebranded state-dir name / `AP_HOME` default).
  Keep `.antigravitycli/` and all other entries.

### 4. `tests/manifest.test.ts` (new, small)
A permanent installability gate. Resolves paths from the repo root (anchor off the test file
location, not `cwd`). Asserts:
- `marketplace.json` parses; has a non-empty `plugins` array; each plugin's `source` resolves to an
  existing directory.
- `plugin.json` parses; the `UserPromptSubmit` hook command references `dist/ap.cjs`, and that file
  exists.
- The three version fields agree: `package.json.version` === `marketplace.json.plugins[0].version`
  === `plugin.json.version`.
- Plugin name is consistent (`ap`) across `marketplace.json.plugins[0].name` and `plugin.json.name`.

This test reads repo files only (no `AP_HOME` state), so it needs no `tmpHome` helper.

### 5. Version bump
- `0.3.0 → 0.3.1` across `package.json`, `.claude-plugin/marketplace.json` (`plugins[0].version`),
  and `.claude-plugin/plugin.json`. Docs/packaging only — **no `src/` change**, so a rebuild of
  `dist/ap.cjs` must produce a byte-identical bundle (a divergence is a red flag to investigate, not
  to commit blindly).

## Out of scope

- npm publish / removing `"private": true`.
- `.codex-plugin/` (Codex dual-publish).
- `MIGRATION.md` rewrite (handover task 3).
- Dogfood Scenario B fix (handover task 2).
- Any command-behavior change.

## Verification

1. `npm run typecheck && npm run test && npm run lint && npm run build` — all green; the new manifest
   test passes; `git diff --stat dist/` after build shows `dist/ap.cjs` unchanged.
2. **Clean-clone smoke** (documented in the PR): `git archive HEAD | tar -x -C <tmp>`, then
   `node <tmp>/dist/ap.cjs` dispatches (prints `ap: missing subcommand`), the hook runs with an
   isolated `AP_HOME`, and both manifests resolve their referenced paths inside the archive — proving
   the shipped tree (no `node_modules`) is sufficient.
3. **Manual install** (final acceptance): from a clean Claude Code session,
   `/plugin marketplace add WingsOfPanda/agglomeration-platform` then
   `/plugin install ap@agglomeration-platform`, confirm `/ap:*` commands appear and `/ap:check` runs.

## Delivery

- One small PR off `main`: `chore(publish): marketplace install-readiness`.
- The stale-token gate (`tests/stale-tokens.test.ts`) must stay green — the `.gitignore` change
  removes a `consort` token rather than adding one.
- Rebuild `dist/ap.cjs` to confirm byte-identical, and commit it only if it actually changed.
