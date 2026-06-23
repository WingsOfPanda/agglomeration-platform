# Shipped Config Always Wins — Design

**Date:** 2026-06-23
**Status:** approved (brainstorming)
**Scope of this PR:** code only (`src/core/contracts.ts`, `src/core/agents.ts`, `src/commands/check.ts`,
`commands/check.md`, `tests/`, rebuilt `dist/ap.cjs`, version bump). No wire-protocol change.

## Why

The shipped `config/contracts.yaml` and `config/agents.yaml` travel **with the versioned plugin**
(under `~/.claude/plugins/cache/agglomeration-platform/ap/<version>/config/`), so reading them
directly always yields the installed version's values. But today `/ap:check` **copies** both files
into `~/.ap/` once (only when absent, `check.ts:133-141`), and `contractsPath()`/`agentsPath()`
**prefer that copy** (`contracts.ts:6-9`, `agents.ts:7-9`). The copy is never refreshed, so after the
first `/ap:check` the user is frozen on a snapshot:

> Concretely — the codex `ready_timeout_s` 90→150 fix shipped in 0.3.9 does **not** reach a machine
> whose `~/.ap/contracts.yaml` is the older copy (verified: the local copy is byte-identical to
> shipped except for the two timeout bumps it missed — codex 90 vs 150, claude 60 vs 150). The current
> band-aid is a manual `cp … ~/.ap/contracts.yaml` tip in `commands/check.md:45-46`.

The user confirmed they **never hand-edit** these files — the `~/.ap` copies are pure auto-copy
artifacts, not deliberate overrides. So the override path has no real user and only causes staleness.

This is new behavior beyond the faithful port, so per the CLAUDE.md phase guard it gets its own spec.

## Goal

Make the plugin **always read the shipped (versioned) `contracts.yaml`/`agents.yaml`**, so every config
fix lands on the next `/ap:check`/spawn with no manual step. Remove the `~/.ap` shadow path entirely,
stop auto-copying, and self-heal away the existing stale copies (backed up, recoverable).

## Non-goals (YAGNI)

- **No override mechanism.** The `~/.ap/<file>` shadow is removed, not replaced. The user chose
  "always read shipped, no override machinery." A sanctioned, never-stale override is a separate future
  spec if a real need emerges.
- **`providers-available.txt` / `providers-active.txt` are untouched.** Those are legitimate
  user-selection state (home-global, correctly survive updates); this spec is only about the two
  shipped-config shadows.
- No change to `contracts.yaml`/`agents.yaml` **keys or filenames** — only which directory they're read
  from. No wire-protocol change.

## Architecture / approach

### 1. Resolvers always return the shipped path

- `src/core/contracts.ts` — `contractsPath()`: return `join(pluginRoot(), "config", "contracts.yaml")`
  unconditionally (drop the `globalRoot()/contracts.yaml` `existsSync` branch). Remove the now-unused
  `globalRoot` import if nothing else in the file uses it.
- `src/core/agents.ts` — `agentsPath()`: return `join(pluginRoot(), "config", "agents.yaml")`
  unconditionally (same shape).

`pluginRoot()` (paths.ts) is unchanged: `CLAUDE_PLUGIN_ROOT` override → self-locate from the running
bundle → `process.cwd()`. In production the running bundle self-locates to the installed version dir,
so the resolver tracks the installed version automatically.

### 2. `/ap:check` stops copying and self-heals the shadow

- **Remove the copy-if-absent block** for `contracts.yaml`/`agents.yaml` (`check.ts:133-141`). Check
  still verifies the shipped config is present and readable (it needs it for provider detection), but
  via `pluginRoot()`/`contractsExist()` — it no longer writes into `~/.ap`.
- **Add `migrateConfigShadow()`** — for each of `contracts.yaml`/`agents.yaml`, if
  `join(globalRoot(), <file>)` exists: `renameSync` it to `<file>.bak` (atomic, overwriting any prior
  `.bak`) and `log.ok` a one-line notice (e.g. `config: removed stale shadow ~/.ap/contracts.yaml ->
  contracts.yaml.bak (now tracking shipped)`). **Idempotent**: no shadow → no-op. Runs inside
  `healthCheck`, mirroring the existing `applyPaneBorders()` self-heal idiom. Pure-ish: the file-system
  effect is a single rename per file; the decision logic (which files exist) is straightforward to test
  against a temp `globalRoot`.
- **Fix the stale error string** at `check.ts:148`: print the path actually checked
  (`contractsPath()`), not `join(globalRoot(), "contracts.yaml")` — after this change the latter is no
  longer where contracts is read.

### 3. Docs

- `commands/check.md`: remove the `cp "${CLAUDE_PLUGIN_ROOT}/config/contracts.yaml" ~/.ap/contracts.yaml`
  refresh tip (lines ~45-46) and the "your contracts.yaml may predate the current provider set" framing.
  Replace with a one-line note: config now always tracks the installed plugin version; no manual
  refresh. Keep the `providers-active.txt` (global, one-per-machine) prose unchanged.

## Data flow

```
spawn / check / any consumer
  → contractsPath()  ==> pluginRoot()/config/contracts.yaml      (always shipped, version-tracked)
  → agentsPath()     ==> pluginRoot()/config/agents.yaml
/ap:check (healthCheck)
  → migrateConfigShadow(): ~/.ap/contracts.yaml  -> ~/.ap/contracts.yaml.bak  (if present)
                           ~/.ap/agents.yaml     -> ~/.ap/agents.yaml.bak     (if present)
  → (no copy into ~/.ap)
```

## Error handling

- `migrateConfigShadow`: `renameSync` failures are best-effort (`try/catch`, warn, don't fail the health
  check) — same posture as `applyPaneBorders`. A missing shadow is the common path (no-op).
- A `.bak` already present is overwritten by `renameSync` (last migration wins; the live shadow is the
  only thing that mattered).
- Provider detection still hard-fails (`fail=1`) if the **shipped** contracts is missing/unreadable
  (partial install) — unchanged behavior, just sourced from `contractsPath()`.

## Testing

**The test injection seam moves from `AP_HOME` to `CLAUDE_PLUGIN_ROOT`.** `tests/contracts.test.ts`
currently injects a fixture by writing `contracts.yaml` under `AP_HOME` (the shadow we're removing).
Rewrite its helper to set `CLAUDE_PLUGIN_ROOT=<tmp>` and write `<tmp>/config/contracts.yaml`
(the root the resolver now reads). `CLAUDE_PLUGIN_ROOT` is already the established fixture seam in 8
test files (`check.test.ts`, `paths-pluginroot.test.ts`, `check-list.test.ts`, …).

- `contracts.test.ts` / `agents` resolver tests: with `CLAUDE_PLUGIN_ROOT=<tmp>` + `<tmp>/config/...`,
  `agentReadyTimeout`/`listAgents`/etc. read the fixture. Existing assertions port over unchanged
  (codex=90 in the fixture, etc.).
- **New: shadow-ignored test** — write a `~/.ap/contracts.yaml` (via a temp `AP_HOME`/`globalRoot`)
  with a sentinel value AND a different `CLAUDE_PLUGIN_ROOT` shipped fixture; assert the resolver
  returns the shipped value, proving the shadow is ignored.
- **New: `migrateConfigShadow` test** — shadow present → `<file>.bak` exists and the original is gone;
  shadow absent → no-op (no `.bak` created); `.bak` already present → overwritten. Use a temp
  `globalRoot`, no tmux/panes.
- `check-list.test.ts` / `check.test.ts`: adjust any expectation that `/ap:check` writes
  `~/.ap/contracts.yaml` (it no longer does); add coverage that a pre-existing shadow is migrated.

## Acceptance

1. With no `~/.ap/contracts.yaml`, `contractsPath()` returns the shipped path and spawn reads the
   installed version's values (e.g. codex `ready_timeout_s: 150` on 0.3.10).
2. With a stale `~/.ap/contracts.yaml` present, one `/ap:check` renames it to `.bak` and subsequent
   reads use shipped — verified by the migration + shadow-ignored tests.
3. `npm run typecheck && npm run test && npm run lint && npm run build` green; `dist/ap.cjs` rebuilt +
   committed; version bumped to 0.3.10 (3-way manifest sync). `commands/check.md` no longer advertises a
   manual `cp` refresh.
