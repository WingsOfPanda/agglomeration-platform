# State-tree agreement guard: prove the hub and the worker share a tree (PR H)

Date: 2026-08-24. Companion to `2026-08-24-uniform-state-rooting-design.md` (PR G), which fixes the
cause. This spec adds the check that proves the fix holds, and fails closed if a future change
breaks it.

## Problem

PR G makes every verb family resolve one state tree by re-rooting at the dispatcher. That is nine
identical edits enforcing one rule — and a rule applied at nine call sites is exactly the shape that
rots when a tenth is added. The failure it guards against is not hypothetical: PR #150 applied this
same rule to `job` verbs and left the other eight, and the gap took a field incident and six
forensics flags to surface.

The consequence of a silent regression is severe and quiet. `src/commands/send.ts` writes the task
with `inboxWrite(agent, model, topic, msg)` and nudges with
`taskNudge(inboxPath(agent, model, topic), model)` — both derived from the same cwd-derived path. If
the hub resolves a different tree than the worker was given, the write and the nudge stay consistent
with EACH OTHER while both miss the worker. Nothing in the hub notices.

Today the only thing that catches it is the worker refusing a nudge naming an inbox its
`identity.md` does not name. That refusal is correct and load-bearing — but it is the LAST line, it
depends on the worker being well-behaved, and it reports the problem to the wrong side: the hub has
already written the task into the wrong place before anything objects.

## Goal

The hub proves, before it types into a pane, that the state tree it resolved is the tree the worker
was actually given — and refuses loudly if not, instead of writing a task nobody will read.

## Architecture

The only reference shared between hub and worker that does NOT route through the cwd-derived state
dir is **the tmux pane**. ap already stamps a per-pane secret there (`@ap_nonce`, `src/core/tmux.ts`)
and uses it as the single oracle for pane ownership.

At spawn, stamp the worker's own state dir onto its pane as `@ap_state` — set in the same place and
by the same mechanism as `@ap_nonce`, so the two are written and verified together and neither can
be present without the other. It records the absolute `workerDir(agent, model, topic)` that
`identityWrite` embedded in the worker's `identity.md`, i.e. the path the worker itself believes.

Before `send` writes an inbox and nudges, it reads the pane's `@ap_state` and compares it to the
state dir it just resolved:

- **equal** — proceed exactly as today (the steady state after PR G; this is a no-op).
- **different** — refuse with rc 2, naming both paths and the remedy (run from the repo root, or
  finish/tear down the run that owns the other tree). Nothing is written to either inbox.
- **absent** — proceed. A pane stamped by a pre-`@ap_state` release has no value to compare, and a
  guard that refuses on absence would break every in-flight worker across the upgrade. Absence is
  "unverified", never "mismatched" — the same three-valued discipline `job wait` and
  `classifyTestRun` already use, where a check that could not run is never reported as a failure.

The comparison is on `realpath`-normalized strings, so a symlinked state dir (the workaround the
field run resorted to) compares equal to its target rather than tripping the guard.

## Why this is not redundant with PR G

PR G removes the cause; this proves the removal. They fail differently: PR G is wrong if the
re-rooting rule is mis-applied at one dispatcher, and that error is invisible — the verb simply uses
a different tree and everything downstream agrees with it. The guard is what makes that specific
error loud, at the moment of writing, on the hub side. It is the mutation-locked invariant for a
rule that lives in nine places.

## Non-goals

- **Not a path source.** The guard compares; it never rewrites the nudge or the inbox path. A
  "nudge from the recorded path" design was considered and rejected: locating the recorded path
  needs the tree you are trying to verify, and the task has already been written by then.
- **Does not replace the worker's refusal.** Both stay. The worker's check is the far side of the
  same invariant, and defense that only exists on the sending side is defense that a compromised or
  restarted hub can skip.
- **Not extended to every verb.** Only the sites that TYPE INTO A PANE (`send`, and the two other
  `taskNudge` callers) can be wrong in this specific, silent way. A read-only verb resolving the
  wrong tree fails visibly on its own.

## Components

- `src/core/tmux.ts` — `paneStateSet(pane, dir)` (mirroring `paneNonceSet`) and the read side that
  parses `@ap_state` from the same `list-panes` snapshot that already carries `@ap_nonce`.
- `src/commands/spawn.ts` — stamp `@ap_state` beside `@ap_nonce`, in the same fail-closed path
  (if the stamp cannot be written, the pane is not trusted — match the existing nonce discipline).
- `src/commands/send.ts` — compare before `inboxWrite`; rc 2 on mismatch, proceed on equal/absent.
- `tests/state-agreement.test.ts` (new).
- `dist/ap.cjs` — rebuilt and committed.

## Testing

- `tests/state-agreement.test.ts` — pane stamped with a DIFFERENT state dir than the one `send`
  resolves: rc 2, both paths named on stderr, and **no inbox written to either tree** (assert both
  files absent — the refusal must precede the write, not follow it).
  **Mutation:** compare after `inboxWrite` instead of before -> the "no inbox written" assertion
  goes red.
- `tests/state-agreement.test.ts` — pane stamped with the SAME dir: byte-identical behavior to
  today (inbox written, nudge sent, rc 0).
  **Mutation:** treat equal as mismatch -> red.
- `tests/state-agreement.test.ts` — pane with NO `@ap_state` (pre-upgrade worker): proceeds, rc 0.
  **Mutation:** refuse on absence -> red. This is the upgrade-safety row.
- `tests/state-agreement.test.ts` — symlinked state dir resolving to the stamped target: compares
  EQUAL, rc 0. **Mutation:** compare raw strings without realpath -> red.
- `tests/state-agreement.test.ts` — `spawn` stamps `@ap_state` equal to the `workerDir` that
  `identityWrite` wrote into `identity.md` (the two must agree by construction).
  **Mutation:** stamp a different path -> red.
- Non-regression: every existing `send` and `spawn` test stays green UNCHANGED.

## Success Criteria

- With PR G in place the guard never fires in normal operation (all existing flows byte-identical).
- Reverting any single dispatcher's re-rooting from PR G makes `send` refuse with both paths named,
  rather than writing a task the worker will never read.
- A worker spawned by a pre-`@ap_state` release keeps working across the upgrade.
- `npm run typecheck && npm test && npm run lint && npm run build` green; `dist/ap.cjs` committed.
