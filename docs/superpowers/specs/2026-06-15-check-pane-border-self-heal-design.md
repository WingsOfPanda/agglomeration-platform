# `/ap:check` self-heals the pane-border globals

**Date:** 2026-06-15 · **Status:** approved (brainstorm) · **Branch:** `fix/check-pane-border-self-heal`

## Goal

Stop `/ap:check` from emitting the cosmetic pane-border WARN on a fresh install, so a newly
installed plugin on any machine reports green and worker labels render — without the user editing
`~/.tmux.conf`.

## Problem

`ap` already knows how to render worker labels on the tmux pane border: `paneBorderArgs()`
(`src/core/tmux.ts`) builds the idempotent `set -g pane-border-status top` + `pane-border-format
'…@ap_label…'` (+ active-border hook), and `ensurePaneBorders()` applies them on every **spawn**
(`spawn.ts:44`).

But `/ap:check` (`healthCheck()` in `src/commands/check.ts`) only *reads* the current globals and
runs the **pure** `paneBorderDiagnosis()`. On a fresh install, before any worker has been spawned,
the globals are still tmux defaults → `pane-border-format` has no `@ap_label` → check WARNs with
manual `~/.tmux.conf` instructions. The warning is genuinely cosmetic (spawn fixes it), but it fires
on every clean install, which is what the user hit.

## Decision

**Self-heal in check.** Before diagnosing, `healthCheck()` applies the same `paneBorderArgs()` that
spawn applies, then reads the (now-set) globals and diagnoses → reports green. The manual
`~/.tmux.conf` fix text stays, but only surfaces in the rare case where the live apply genuinely
failed (tmux error).

Rejected alternative — *reframe the WARN as an informational OK without mutating tmux*: less
invasive, but labels would still not render until the first spawn, and it only hides the message
rather than making the feature work. Self-heal is consistent with `check` already self-healing
missing config files (it copies `contracts.yaml`/`agents.yaml` defaults into the state dir).

**Accepted tradeoff:** running `check` now enables `pane-border-status top` globally on the tmux
server (a title line atop every pane) — identical to what spawning any worker already does. Only
runs inside the `inTmuxSession()` branch; idempotent; user-reversible (`set -g pane-border-status
off`).

## Changes

`src/commands/check.ts` only:

1. Import `paneBorderArgs` from `../core/tmux.js`.
2. Add a small sync helper:
   ```ts
   function applyPaneBorders(): void {
     for (const a of paneBorderArgs()) { try { execFileSync("tmux", a, { stdio: "ignore" }); } catch { /* diagnosed below */ } }
   }
   ```
   (`check` already uses synchronous `execFileSync` tmux calls; the async `ensurePaneBorders()` is
   spawn's path. Reusing `paneBorderArgs()` means zero new tmux surface — the same arg-arrays, which
   `tests/tmux.test.ts` already covers.)
3. In `healthCheck()`'s `inTmuxSession()` branch, call `applyPaneBorders()` immediately before the
   `paneBorderDiagnosis(...)` call.
4. Tiny message-accuracy tweak: the fix hint's "`ap` spawn sets this automatically" → "`ap`
   spawn/check sets this automatically".

The pure `paneBorderDiagnosis()` is **unchanged** (still WARN-only, still pure/testable).

## Out of scope

- Writing to the user's `~/.tmux.conf` (persistence across tmux-server restarts stays a manual,
  documented opt-in via the existing fix hint).
- Any change to `spawn` / `ensurePaneBorders` / `core/tmux.ts`.
- Changing the pure diagnosis logic or its tests.

## Verification

1. `npm run typecheck && npm run test && npm run lint && npm run build` — all green. Existing
   `tests/check-pane-border.test.ts` (pure diagnosis) and `tests/tmux.test.ts` (`paneBorderArgs`)
   pass unchanged.
2. **Live dogfood** (inside tmux): `node dist/ap.cjs check` now prints
   `pane-border: status=top, format @ap_label-aware (worker names visible)` (OK) instead of the
   WARN, on a session whose globals weren't preset.
3. Rebuild `dist/ap.cjs` (a `src/` change) and commit it.

## Delivery

One small PR off `main`: `fix(check): self-heal pane-border globals so fresh installs don't warn`.
