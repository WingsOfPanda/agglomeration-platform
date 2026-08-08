# Spawn status.json seeding + implement objection-reply wording — design

**Date:** 2026-08-08 · **Origin:** /ap:review forensics cluster (2026-07-26 `relax-numa-data-layo`
implement run, local box) · **Scope:** one small PR.

## Problem

Nothing in `src/` ever creates a worker's `status.json`. `spawn` writes identity/inbox/pane.json
(`src/commands/spawn.ts`), and the identity template tells the worker to "**update** status.json
after every event" (`config/prompt-templates/identity.md:17`) — the file's very existence depends
on the worker inferring it should create it. On 2026-07-26 a codex `lead` worker took the wording
literally and hard-blocked: *"The required worker status file is missing, so I cannot perform the
mandatory status update"* — the hub had to create the file by hand. The forensics finding says it
plainly: "ap spawn should seed status.json unconditionally."

Same run, second confusion: the implement directive's objection-*Revise* reply says "Plan updated —
re-read the plan and continue" (`commands/implement.md`), but at objection time `$ART/plan.md`
often does not exist (the hub edited `design.md`); the worker halted asking whether the hub meant
to create plan.md.

## Goal

Every spawned worker starts with a well-formed `status.json` on disk, written by the platform, so
no worker ever has to invent the file; and the objection-reply template names the file(s) the hub
actually edited. No gate behavior changes: the seeded state must read as **not busy** under both
`workerBusyState` and `workerSendGate`.

## Architecture

Seed at the one choke point every spawn path crosses — `spawn.ts` right after `identityWrite`
(both the `--target-pane` respawn path and the split path flow through it).

Seed state is **`idle`, not `ready`**. `idle` is the waiting state the identity template mandates
after a terminal event, and the one implement's reset-status already writes. `ready` was rejected
because it doubles as the frozen outbox **event** name that spawn hard-waits on: a literal worker
could read a pre-existing `state: ready` as "the handshake is already recorded" and skip emitting
its `ready` line, hanging the bootstrap wait. Both words sit in `TERMINAL_WORKER_STATES`
(`src/core/ipc.ts:23`), so the gate semantics are the same either way. `last_event: "spawn"` is
deliberately **not** an event name — it is a marker meaning "platform-written, the worker has not
reported yet". Atomic write (tmp-in-same-dir + rename), JSON matching the identity template's
shape: `{"state":"idle","updated":"<iso>","last_event":"spawn"}`.

The write is an **unconditional overwrite as defence-in-depth**, not incident recovery: on the real
spawn path `stateInit` rmSyncs `status.json` (it is in archive.ts's `STALE` list) one line before
the seed, so there is no stale file left to clear — the incident's failure mode was a **missing**
file, not a stale one.

The seeded state reads identical to the absent file it replaces **for every busy/send gate reader**
— the rc-3 busy gate, `workerSendGate`, and implement's idle gate. That is the claim; it is not
"for every reader": `finalizeArchived` (`src/core/archive.ts`) skips worker dirs with no
`status.json`, so seeding makes it reachable for workers that never reported, and it now stamps
`state: archived` + `archived_ts` over the seed. That is intended and harmless — an archived dir is
out of the dispatch path.

Bootstrap failure stamps the truth over the seed: in the `!ev || ev.event === "error"` branch,
immediately before `stateArchive(..., "FAILED")`, spawn writes
`{"state":"error","updated":"<iso>","last_event":"bootstrap-failed"}`. Without it a FAILED archive
would preserve a status claiming a dispatchable state for a worker that never reported. `error` is
already in `TERMINAL_WORKER_STATES`, so no gate behavior changes.

The seeding lives in a small exported `seedWorkerStatus(agent, model, topic, now?)` in
`src/core/ipc.ts` (beside `statusPath`/`identityWrite`) so it is unit-testable without tmux. The
three pre-tmux state writes in `spawn.ts` — `stateInit`, `identityWrite`, `seedWorkerStatus` — are
extracted into an exported `prepareWorkerState(agent, model, topic)` in `spawn.ts` so the call-site
wiring itself is unit-testable without spawning a pane.

Wording fix is prose-only in `commands/implement.md`: the *Revise* reply becomes "Design amended —
re-read `<ART>/design.md` and continue.", with an unquoted hub-side instruction that the hub
substitutes the **absolute** art-dir path (the `ART=` value captured in Stage 0) for `<ART>` — never
the literal `$ART`, which the worker cannot expand — and names `plan.md`'s absolute path too when it
actually edited that file. The reply then always names a file that exists, spelled the way the
worker can read it.

## Components

- `src/core/ipc.ts` — new `seedWorkerStatus(i, m, t, now?)`: atomicWrite of the seed JSON to
  `statusPath(...)`; doc comment covers the `idle`-not-`ready` choice and its collision rationale,
  the non-event `last_event` marker, gate-reader equivalence (not every reader), and the
  defence-in-depth overwrite.
- `src/commands/spawn.ts` — new exported `prepareWorkerState(agent, model, topic)` wrapping
  `stateInit` + `identityWrite` + `seedWorkerStatus`, called from `run()` in place of the three
  inline lines; plus the `state=error` / `last_event=bootstrap-failed` stamp immediately before
  `stateArchive(..., "FAILED")` in the bootstrap-failure branch.
- `commands/implement.md` — *Revise* branch reply text: "Design amended — re-read
  `<ART>/design.md` and continue.", plus the absolute-path substitution instruction.
- `tests/` — see Testing.
- Version bump 0.5.9 → 0.5.10 in `package.json` + `.claude-plugin/plugin.json` +
  `.claude-plugin/marketplace.json`; rebuilt `dist/ap.cjs` committed.

## Testing

- `seedWorkerStatus` writes valid JSON with `state=idle`, `last_event=spawn`, and an `updated` pinned
  exactly to `isoUtc`'s second-precision format via an injected `now`; file readable via `statusPath`.
- Seeded file → `workerBusyState` returns null (not busy) and `workerSendGate` passes (given an
  outbox), i.e. no send path regresses.
- Unconditional overwrite: a pre-existing `{"state":"working"}` status is replaced by the seed —
  pinning the defence-in-depth behavior (on the real path `stateInit` has already cleared the file).
- `prepareWorkerState` under a fresh `AP_HOME`: one call leaves `identity.md`, a touched
  `outbox.jsonl`, and an `idle` `status.json` at the worker-dir paths (`CLAUDE_PLUGIN_ROOT` set to
  the repo root so `identityWrite` finds the template, matching `tests/ipc.test.ts`).
- Frozen-wall guard: state filename stays `status.json`; no event-name/JSON-field changes.
- Existing suite stays green (no gate behavior change is the claim; the suite is the evidence).

## Success Criteria

- A spawn on a fresh AND on a recycled worker dir leaves `status.json` present with `state=idle`
  before the worker's first action; a bootstrap failure archives it as `state=error`.
- Full gate green (typecheck / lint / vitest / build); dist rebuilt and committed.
- `commands/implement.md` no longer instructs a worker to re-read a file that may not exist.
