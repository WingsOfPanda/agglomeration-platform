# `job attach` reports the parked state — design

**Date:** 2026-08-18
**Status:** approved (hub-authored; the first live dogfood of the detached-job layer)

## Problem

`ap job attach <topic>` — the verb an operator runs after their own Claude Code session restarted —
prints only the re-arm block (session name, hub, outbox path, the status/wait commands). Whether the
job is currently **parked on a question** is exactly what the returning operator needs first, and
today they must run `job status` separately to learn it; `commands/job.md`'s attach flow tells them
to do so every time. The parked verdict is already computed correctly (with answered-question
suppression) in `statusRun`, so attach withholding it is an omission, not a design choice.

## Goal

`ap job attach <topic>` also reports the job's current parked verdict, using exactly the same rules
`job status` uses: `PARKED=yes|no`, and on yes a percent-encoded `PARKED_MESSAGE=`, with a question
the origin already answered (relay cursor at or past the snapshot) never reported as parked.

## Architecture

Reuse, do not re-derive. `statusRun` (src/commands/job.ts) already implements the exact computation:
one read of the hub's outbox (`readIfExists(outboxPath(...))`), `parseOutbox` + `jobProgress` from
`src/core/job.ts`, then suppression via `questionConsumed(Buffer.byteLength(outbox, "utf8"),
readCursor(topic))`. Factor that computation into one small helper in `src/commands/job.ts` (e.g.
`parkedNow(rec): OutboxEvent | null`) and call it from BOTH `statusRun` and `attachRun`, so the two
verbs cannot drift. `attachRun` appends `PARKED=` (and `PARKED_MESSAGE=` when parked, encoded with
the existing `enc` helper) after its current block. `attachRun` stays synchronous — the computation
is pure file reads, no tmux. Output stays `KEY=value` lines, no emoji, worker-authored text
percent-encoded (the established forgery defense). Update `commands/job.md`'s attach section: it now
also reports the parked state, so the returning operator sees a pending question without running
`status` first.

## Components

- `src/commands/job.ts` — add the shared `parkedNow` helper; use it in `statusRun` (replacing the
  inline computation) and in `attachRun` (new `PARKED=`/`PARKED_MESSAGE=` lines).
- `commands/job.md` — one sentence in the attach section documenting the new lines.
- `tests/job-cmd.test.ts` — attach coverage (see Testing).
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — bump the version
  to 0.5.34 (all three; the manifest-sync test enforces it).
- `dist/ap.cjs` — rebuilt and committed (`npm run build`; the dist-freshness test enforces it).

## Testing

Extend `tests/job-cmd.test.ts` (fresh `AP_HOME` per test via `tests/helpers/tmpHome.ts`; the file
already has `seedJob`/`seedOutbox`/`capture` helpers):

- attach with an outbox ending in an unanswered question → `PARKED=yes` and `PARKED_MESSAGE=` with
  the message percent-encoded (assert a newline in the message renders as `%0A`).
- attach after the cursor was recorded at the snapshot size (question answered) → `PARKED=no`.
- attach with no outbox at all, and with an outbox ending in `ack`/`done` → `PARKED=no`.
- `job status` output unchanged for the same fixtures (the refactor must not alter it).

Full gate: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`.

## Success Criteria

- `ap job attach <topic>` prints `PARKED=` consistent with `ap job status <topic>` on the same
  state, including the answered-question suppression.
- `statusRun` and `attachRun` share one parked computation (no duplicated logic).
- Version 0.5.34 across the three manifests; `dist/ap.cjs` rebuilt and committed; the full test
  suite passes with the new attach tests included.
