# Pane ownership nonce: never kill/nudge a pane we don't own — design

**Date:** 2026-08-15 · **Origin:** codex review finding f5, verified REAL (medium) by execution on a
scratch tmux server (a `stop` killed an unrelated `sleep` process; a `send` typed into a stranger's
shell). This is NEW behavior (a per-pane ownership proof), so it gets its own design doc per the
repo's spec discipline; no prior spec discusses pane-id ownership. · **Scope:** one PR (0.5.30).

## Problem

Worker teardown/messaging trusts a RAW tmux pane id (`%N`) as proof of ownership. `paneMetaWrite`
(ipc.ts:271) persists `{pane_id, agent, model, spawned_at}` — `spawned_at` is written and never
read; there is no server/session identity. `stop` (stop.ts:30-33) kills a persisted id whenever the
CURRENT server lists it (`livePanes().has(pane)`), with no label/ownership check before
`killGraceful` (respawn-pane -k) then `killNow` (kill-pane). tmux restarts its `%N` counter from 0 on
a fresh server, so after a reboot / `kill-server` / tmux upgrade (exactly when un-archived `.ap`
state outlives the panes and a NEW hub does the sweep), a stale recorded id can name an UNRELATED
pane. Reproduced end-to-end: a stale `pane.json` naming a reused `%3` made `stop` destroy an
unrelated user pane (`sleep 987654`, pid gone), `ap list` fabricate a live row for it, and `ap send`
type+execute the nudge in the stranger's shell. Same class in explore/autoresearch teardown
(`killNow`) and the liveness probes (a reused id reads as "worker alive").

Existing partial mitigation: `stateInit` (archive.ts) deletes stale `pane.json` when the SAME worker
dir is re-prepared, so a re-spawned worker is safe; only NEVER-respawned leftovers (the `stop --all`
/ post-reboot sweep population) are exposed.

## Goal

Every worker pane carries a per-spawn nonce in the platform's own `@ap_*` tmux option namespace,
stored in `pane.json`; teardown/nudge/liveness act on a pane ONLY when its live `@ap_nonce` matches
the recorded one. A mismatch (or a reused id) is treated as "not ours" — never killed, never typed
into. Zero extra tmux calls at stop/list (the nonce rides the existing single `list-panes -a`
snapshot); one `set-option` per spawn. No frozen name touched (`pane.json` keeps its name, gains one
key).

## Architecture

1. **spawn** (spawn.ts:104, both the respawn-of-preflight-pane and the split branch): mint
   `nonce = randomUUID()`, stamp it via a new `paneNonceSetArgs(pane, nonce)` builder in tmux.ts
   (`set-option -p -t <pane> @ap_nonce <nonce>` — pure arg array, unit-testable; respawn-pane
   preserves pane options, verified), and pass it to `paneMetaWrite`.
2. **ipc.ts**: `paneMetaWrite(..., nonce)` writes `pane_nonce` into pane.json;
   `PaneMeta`/`PaneJson`/`paneMetaReadForDir` gain `nonce` (a legacy file with no key → `""`).
3. **tmux.ts**: `livePanes()` → `livePaneNonces(): Promise<Map<string, string>>` from
   `list-panes -a -F '#{pane_id}\t#{@ap_nonce}'` (an unstamped pane's field is empty — verified).
   Keep a thin `livePanes()` wrapper if other callers need the id set alone; prefer migrating them.
4. **stop** (`teardownBatch`): kill only when `snapshot.get(pane) === meta.nonce && meta.nonce !==
   ""`. Mismatch or empty-recorded-nonce → NO killGraceful/killNow; `log.warn("pane <id> is live but
   is not ours (nonce mismatch) — not killing; it belongs to another program")`; still archive the
   worker state (the sweep must keep clearing leftovers) with a distinguishing suffix
   (`stateArchive(..., "stalepane")`) so forensics sees teardown never reached a pane. Extend
   `StopDeps` so the fake deps in tests/stop.test.ts get the nonce.
5. **Legacy pane.json (no `pane_nonce`)** = exactly the dangerous pre-upgrade leftovers: UNVERIFIABLE
   → do NOT kill; warn with the exact manual line (`tmux kill-pane -t <id>`) and archive. This is the
   one deliberate policy call (a mid-upgrade worker spawned by an old bundle is no longer auto-killed)
   — stated here so it is a decision, not a surprise.
6. **The other id consumers, or the fix is half a fix:** `send`/`paneSend` (gate the nudge on the
   nonce — currently types into a stranger's shell); `list` (nonce mismatch ⇒ `[ORPHAN]`, removing the
   fabricated "live" row that PROMPTS the stop); `check` if it reads panes; the liveness probes
   (`waitLive.ts` `paneMetaRead`→`paneId`, and `paneAlive`'s use — a reused id must not read as
   "worker alive"); explore/autoresearch teardown `killNow` and spawn's `.last_pane` split target.
   Each needs the same recorded-vs-live nonce check; where a probe only has the id (paneAlive), thread
   the nonce or have the caller compare against the snapshot. ENUMERATE every consumer from the source
   — the list above is the map.

## Components

- `src/core/ipc.ts` — `pane_nonce` in paneMetaWrite + PaneMeta/PaneJson/paneMetaReadForDir.
- `src/core/tmux.ts` — `paneNonceSetArgs`, `livePaneNonces`.
- `src/commands/spawn.ts` — mint + stamp + persist the nonce (both branches).
- `src/commands/stop.ts` — nonce-gated kill + legacy/mismatch policy + StopDeps.
- `src/commands/send.ts` / `list.ts` / `check.ts` + `src/core/waitLive.ts` + explore/autoresearch
  teardown killNow sites — the same gate at each id consumer.
- `tests/` — see Testing. Version 0.5.29 → 0.5.30 (three manifests) + rebuilt committed dist.

## Testing

Tmux stays a pure arg-array surface (never spawn real panes in unit tests):
- `paneNonceSetArgs` / `livePaneNonces` parse: id↔nonce map, empty field for unstamped, tab split,
  blank lines.
- stop teardown (fake deps): recorded nonce MATCHES live → killGraceful+killNow as today (healthy
  path byte-identical); recorded nonce MISMATCHES live id → NO kill, warn, archive with `stalepane`;
  legacy pane.json (no nonce) → NO kill, warn + manual line, archive; pane absent from the snapshot →
  today's orphan path unchanged. Mutation: removing the nonce check must fail the mismatch test.
- send: nonce mismatch → refuses with the orphan message, `paneSend` NOT called (mutation-pinned).
- list: nonce mismatch → `[ORPHAN]` not a live row.
- spawn: pane.json now carries `pane_nonce`; the arg builder stamps `@ap_nonce`; both spawn branches.
- A worker spawned+torn-down by THIS bundle is byte-identical (nonce matches).
- Full gate green; dist rebuilt+committed. A live-dogfood note (not a unit test): the real
  kill-wrong-pane path only reproduces across a server restart, which unit tests don't cover — the
  arg-builder + fake-dep tests are the contract, matching how the rest of the tmux surface is tested.

## Success Criteria

- A stale/mismatched-nonce pane is never killed or nudged; `ap list` shows it `[ORPHAN]`; the worker
  state is still archived (with a `stalepane` marker) so the sweep keeps working.
- A healthy worker spawned and torn down by this bundle is byte-identical to today.
- Legacy (nonce-less) leftovers are left for the operator with an explicit manual line rather than
  auto-killed — the one stated behavior change.
- Gate green; 0.5.30; `pane.json` gains exactly one key, no frozen name touched.

## Amendments (recorded during implementation)

The enumeration Architecture item 6 asked for turned up id consumers this design had not named, and
two of its prescriptions were wrong in detail. What shipped, and why:

1. **Two more records carry ids, so both gain the nonce.** `preflight-panes.txt` (art dir) and
   `.last_pane` (topic dir) outlive the tmux server exactly as `pane.json` does, and feed the same
   kind of action: explore/autoresearch teardown + `drop-worker` `killNow` those ids, and
   `spawn --target-pane` **respawn -k**s one (destroying whatever runs there). Both gain a nonce
   field — `preflight-panes.txt` a third TSV column (`<agent>\t<pane>\t<nonce>`, stamped by
   `preflightLayout` at pane CREATION), `.last_pane` a tab field (`<pane>\t<nonce>`) — and every one
   of those sites now checks it. Legacy 2-column / id-only content parses to `""`, i.e. unverifiable,
   i.e. not acted on. No filename changed; the directives parse neither file's columns.
2. **`spawn --target-pane` now REQUIRES `--preflight-art-dir`** (previously the art-dir check was
   conditional). Without it there is no recorded nonce for the target, and the action is a destructive
   respawn — the same "unverifiable → do not act" call as item 5. Every in-tree caller
   (`spawnAllBatch`, autoresearch `spawn-all`) already passes both.
3. **spawn reuses the preflight nonce** on the `--target-pane` branch instead of minting a fresh one
   (the split branch mints `randomUUID()` as specified). One nonce then follows a pane from creation
   through teardown, so the preflight-orphan sweep still recognizes a pane that became a worker.
   Safety does not rest on which nonce it is: the pre-respawn check against the RECORDED nonce is
   what refuses a stranger's pane.
4. **`livePanes()`/`paneAlive()` were deleted, not kept as wrappers.** Every caller migrated, and
   leaving an id-only liveness primitive is what lets the next verb re-open this hole. `paneOwned`
   (single pane) and `livePaneNonces` + the pure `ownsPane` (batch) are the only probes.
   `killGraceful`'s `alive?` fallback became a REQUIRED `owned` argument for the same reason.
5. **`ipc.ts`'s `WaitLivenessOpts.paneAlive` keeps its name.** ipc must stay free of tmux/execa, so
   the ownership check cannot live there; `waitLive.ts` (its only live binder) closes the recorded
   nonce into the injected probe.
6. **`check` needs no gate** — it reads pane-border globals only, never a pane id or `pane.json`.
   `roster.paneListedFor` became `paneNonceFor` (membership answer + the nonce the caller must
   verify); `list`'s row decision moved into a pure exported `rowState`; `send.run` gained an
   injectable `SendCmdDeps` so its refusal is unit-testable without a real pane.
7. **Testing note:** spawn's two branches stay unit-untested (they need real panes, which the repo
   forbids); their contract is covered by the arg-builder/codec/`paneNonceFor` tests plus the now
   REQUIRED `nonce` parameter on `paneMetaWrite`, which no spawn path can omit.
