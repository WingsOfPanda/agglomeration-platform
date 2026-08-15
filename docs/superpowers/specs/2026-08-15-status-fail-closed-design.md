# Worker status reads fail closed on empty/unreadable — design

**Date:** 2026-08-15 · **Origin:** codex review finding f6, verified PARTIAL (low) by execution. The
race codex described (partial mid-JSON body) does NOT occur — 0 partial reads in 1.3M samples, the
~72-byte status body lands in one `write(2)`. The real, narrow gaps: a ZERO-LENGTH status.json reads
as idle (fail-open, and it persists after a worker is killed mid-write), and a chmod-000 status
CRASHES with an uncaught EACCES. · **Scope:** one small PR (0.5.31 — after f5).

## Problem

`workerBusyState` (src/core/ipc.ts) does `existsSync` → `readFileSync` → regex `/"state"…/`. Two
holes, reproduced through the committed dist against a seeded worker dir:

- **zero-length status.json** → no regex match → `state=""` → returns null (idle). A `send` then
  proceeds and overwrites `inbox.md` while the worker may still be mid-task. A crashed worker write
  (SIGKILL inside the ~16 µs open(O_TRUNC)→write window) leaves exactly this, permanently blinding
  the gate for that worker.
- **unreadable status.json (chmod 000)** → `readFileSync` throws an uncaught EACCES → rc 1 + stack
  trace (fail-CLOSED-but-ugly, not fail-open, but still a crash).

DELIBERATELY NOT CHANGED (spec'd + test-locked design, do NOT touch): non-empty-but-unmatched
content (`not json at all`, a wrong key) reads as idle — `docs/superpowers/specs/2026-07-31-
artifact-completeness-design.md` L3 + `tests/artifact-completeness.test.ts:283` ("unreadable/
state-less status.json reads as idle") assert exactly this, because a worker whose status FORMAT
drifted must not be permanently rc-3'd. Closing it would overturn a review-amended decision.

## Goal

An EXISTING status file that is empty or unreadable makes the busy gate fail CLOSED (treat as busy)
rather than idle-or-crash; an ABSENT file stays idle (spawn seeds it; many tests rely on this);
non-empty-unmatched content is unchanged. No call-site change, no new rc/wording (every consumer
already branches on truthiness of the returned state).

## Architecture

`src/core/ipc.ts`, `workerBusyState`:
```ts
export const STATUS_UNREADABLE = "unreadable";
export function workerBusyState(i, m, t): string | null {
  const sp = statusPath(i, m, t);
  if (!existsSync(sp)) return null;                         // ABSENT stays idle
  let text: string;
  try { text = readFileSync(sp, "utf8"); } catch { return STATUS_UNREADABLE; }  // EACCES/EISDIR → busy
  if (text.trim() === "") return STATUS_UNREADABLE;         // the only race-observable shape
  const match = text.match(/"state"\s*:\s*"([^"]*)"/);
  const state = match ? match[1].trim() : "";
  return state && !TERMINAL_WORKER_STATES.has(state.toLowerCase()) ? state : null;  // unchanged
}
```
`STATUS_UNREADABLE` is truthy and not in `TERMINAL_WORKER_STATES`, so every consumer
(`workerSendGate`, `dispatchPrompt`'s rc-3 gate, `overrideEvidence` leg a, `design drilldown`)
treats it as busy through its EXISTING message — e.g. dispatchPrompt emits its existing rc 3
`worker <agent> busy (state=unreadable) — not sending; re-run wait-gate and retry`.

Hygiene (same PR): `workerStatusReport` reads through `readIfExistsOrNull` (existsSync + bare
readFileSync), so it throws the same EACCES before the guard's evidence legs run — switch it to the
existing `readOr` helper (which already swallows EACCES/EISDIR) and answer `"absent"` whenever the
read yields nothing: missing, unreadable, OR zero-length. All three are silence, and `"absent"`
already denies a skip override; only the absent case has a shipped assertion, and it is unchanged.
(A zero-length file previously read as `"reported"` — positive evidence from an empty file.) And fix the two stale doc comments
that already FALSELY claim this behavior — ipc.ts (~"null … absent/unreadable status") and
phaseTable.ts SendDeps.busyState ("null when idle/absent/unreadable").

Companion (no code, high value): add to `config/prompt-templates/identity.md` one line — "write
status.json atomically (a temp file in the same dir, then `mv` it over) — never `> status.json`" —
which removes the truncate window at the source for every provider.

## Components

- `src/core/ipc.ts` — `workerBusyState` empty/unreadable → sentinel; `workerStatusReport` reads
  through `readOr`, empty/EACCES → "absent"; two doc comments corrected.
- `src/core/phaseTable.ts` — the one stale SendDeps.busyState doc comment.
- `config/prompt-templates/identity.md` — the atomic-write line.
- `tests/status-fail-closed.test.ts` — see Testing (a new file; the test-locked
  `tests/artifact-completeness.test.ts` is not edited). Version 0.5.30 → 0.5.31 (three manifests) +
  rebuilt committed dist.

## Testing

- Red-green through a seeded worker dir: (a) zero-length status.json → the send REFUSES (was rc 0 +
  inbox clobbered); (b) chmod-000 → clean refusal, not an uncaught EACCES; (c) healthy `working` →
  still refuses; (d) healthy `idle`/`done`/spawn-seed → still proceeds; (e) ABSENT → still idle; (f)
  the shipped `"unreadable/state-less status.json reads as idle"` case (`not json at all`) → UNCHANGED
  (still proceeds). Must fail against unmodified code for (a)/(b).
  The `done`/`idle` half of (d) is already locked by artifact-completeness.test.ts's TERMINAL-states
  loop and is not restated. (b) MUST skip when the suite runs as root — root ignores mode bits, so
  the file stays readable and the refusal never fires. (GitHub's ubuntu-latest runner is non-root, so
  it really runs there; the skip covers root containers and any root-shelled local run.)
- Every consumer surfaces the sentinel through its existing wording (dispatchPrompt rc 3, no state
  file written; overrideEvidence denies the override).
- No legitimate flow newly refuses (fresh spawn, reset-status, post-archive all verified).
- Full gate green; dist rebuilt+committed.

## Success Criteria

- A crashed-mid-write (zero-length) or unreadable status stops a dispatch instead of clobbering the
  inbox or crashing; absent + drifted-format are byte-identical to today.
- Gate green; 0.5.31.
