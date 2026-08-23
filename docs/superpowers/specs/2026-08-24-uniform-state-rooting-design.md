# Uniform state rooting: one run, one state tree (PR G)

Date: 2026-08-24. Source: xjp field failure on `/ap:quick` (detached + worktree), 6 forensics flags
2026-08-23, root-caused and reproduced 2026-08-23. Extends PR #150, which fixed this class for
`job` verbs only.

## Problem

`repoHash` = sha256(realpath(**`process.cwd()`**)) (`src/core/paths.ts`). Nothing about `--cwd` or
`--target` enters that computation — `spawn`'s `--cwd` sets only the tmux pane's start directory
(`src/commands/spawn.ts`, `startDir`), and `prepareWorkerState` takes no cwd at all. So **which
state tree a verb touches is decided by where the hub happens to be standing.**

Reproduced, same command twice with `AP_HOME` fixed:

| Invocation | State tree written | identity.md names |
|---|---|---|
| from repo root, `--cwd <worktree>` | root hash | the ROOT inbox |
| from inside the worktree, same `--cwd` | worktree hash | — |

In the field this split one run across two trees: `turn-send` reported a missing `agent.txt` from
one cwd and "outbox not found" from the other; the worker **correctly refused** a nudge citing an
inbox its `identity.md` did not name, and idled; and `quick branch --target` wrote
`branch-base.sha`/`branch.txt`/`start-branch.txt` where `finish`/`summary` could not see them.

**The contract this violates is already written down in this repo, in code shipped by #151:**

- `src/commands/quick.ts` — *"the state dir is keyed to the repo root and never travels with
  `--target`"* (the state-relative brief-lint warning).
- `src/commands/quick.ts` — *"...which under `--target` is not the repo the state dir belongs to"*.

So `--target` is ALREADY documented as work-location-only and orthogonal to state. The
implementation simply fails to hold that line whenever the hub is not standing at the root. This
spec enforces a stated rule; it does not introduce a new one.

**Why the nudge is not the fix.** `send.ts` calls `inboxWrite(agent, model, topic, msg)` and then
`taskNudge(inboxPath(agent, model, topic), model)` — the write and the nudge derive from the SAME
cwd-derived path, so they are always consistent with each other and can be consistently wrong
relative to the worker. Making the nudge quote a recorded path would (a) need to locate the worker's
real state dir first, which is the same lookup problem, and (b) fix nothing, because the task has
already been written into the wrong tree. The worker's refusal is what turned a silent no-op into a
visible stall, and it stays (see Non-goals).

## Goal

One run resolves exactly one state tree, whatever directory the hub is standing in, for every verb
family — with a hub standing somewhere ambiguous told so rather than silently split.

## Architecture

`mainCheckoutRoot(root)` (`src/core/job.ts`, PR #150) already does the work: pure string surgery on
the `<root>/.ap/worktrees/<topic>` prefix — which is where an ap-created run worktree lives **by
construction** (`worktreePathFor`) — returning the recovered root only when `worktreeProvenanced`
agrees, and the input unchanged otherwise. No subprocess, no extra git call.

It is wired into `src/commands/job.ts run()` and nowhere else. Every verb family has the same
uniform dispatcher shape, so the wiring is one identical edit per file, not nine designs:

| File | Dispatcher | Today |
|---|---|---|
| `src/commands/job.ts` | `run()` :48 | **re-roots** (#150) |
| `src/commands/quick.ts` | `run()` :38 | raw cwd |
| `src/commands/implement.ts` | `run()` :114 | raw cwd |
| `src/commands/spawn.ts` | `run()` :70 | raw cwd |
| `src/commands/send.ts` | `run()` :25 | raw cwd |
| `src/commands/design.ts` | `run()` :43 | raw cwd |
| `src/commands/explore.ts` | `run()` :45 | raw cwd |
| `src/commands/bridge.ts` | `run()` :31 | raw cwd |
| `src/commands/autoresearch.ts` | `run()` :2117 | raw cwd |

The re-root is applied at the dispatcher, using `job.ts`'s existing chdir + restore discipline
(restore in a `finally`, tolerating a cwd that has since been removed, because tests share a
process). `repoRoot()` itself is NOT broadened — that would silently re-home a user's own worktree
(the standard parallel-session discipline) into the main repo's state namespace, and make
`implement init` default its target to a checkout the user deliberately left.

**Q4 — the orphan case, fail closed.** A run started before this change may already have state under
a worktree hash. After re-rooting, its verbs resolve an empty root tree and would read as "no such
topic". Rather than silently starting a second run or reporting a missing topic, the re-root
detects it: when the resolved ROOT tree has no state for the topic **and** the pre-re-root
(worktree) tree does, the verb refuses with rc 2 naming both paths and the remedy (finish or tear
the run down from its own worktree with the previous release, or move the topic dir). This is a
narrow, additive check on a path that is otherwise a no-op.

## Non-goals (deliberate, do not "fix")

- **The worker's refusal stays.** A worker that refuses a nudge naming an inbox its `identity.md`
  does not name is honoring the protocol (`config/prompt-templates/identity.md`: "Your inbox: ...",
  "The Hub will write inbox.md and nudge you with its path"). It is the reason this bug surfaced as
  a stall instead of a silent write into the wrong tree. Nothing here weakens it.
- **`repoRoot()` is not broadened.** See above.
- **No auto-migration of orphaned state.** ap does not move a run's state on the user's behalf; it
  names the situation and the remedy.
- **The nudge is not changed here.** Proving the two trees agree is a separate, additive guard
  (its own spec) and must not be confused with fixing the split.

## Components

- `src/core/job.ts` — `mainCheckoutRoot` gains an exported sibling `orphanedTopicState(topic, root,
  recovered)` returning the worktree-side path when the root tree lacks the topic and the worktree
  tree has it, else null. No change to `mainCheckoutRoot` itself.
- `src/commands/{quick,implement,spawn,send,design,explore,bridge,autoresearch}.ts` — each `run()`
  re-roots via `mainCheckoutRoot(repoRoot())` with the chdir/restore discipline, and refuses rc 2 on
  the orphan case.
- `tests/state-rooting.test.ts` (new) — the cross-verb matrix below.
- `dist/ap.cjs` — rebuilt and committed.

## Testing

- `tests/state-rooting.test.ts` — for EACH of the eight verb families, a real repo + an ap-created
  worktree: a state-touching verb invoked with `process.chdir(<worktree>)` resolves the SAME state
  path as the identical invocation from the repo root. Table-driven, one row per verb, so a family
  added later without re-rooting fails the row rather than being silently exempt.
  **Mutation:** revert any single dispatcher to bare `repoRoot()` -> that verb's row goes red (and
  only that row, proving the rows are independent).
- `tests/state-rooting.test.ts` — over-broad guard: cwd inside a NON-provenanced worktree (a user's
  own, outside `.ap/worktrees/`) is left exactly as git reported it, for every family.
  **Mutation:** drop the `worktreeProvenanced` check -> red.
- `tests/state-rooting.test.ts` — orphan detection: topic state present ONLY under the worktree
  hash -> rc 2 naming both paths; present under the root hash -> normal operation; present under
  BOTH -> root wins and no refusal (the post-fix steady state).
  **Mutation:** return the worktree path instead of refusing -> red.
- `tests/state-rooting.test.ts` — the reproduced field case end to end: `spawn` invoked from inside
  the worktree writes `identity.md` under the ROOT tree, and its recorded inbox path equals the one
  `send` computes from the root. **Mutation:** revert `spawn`'s re-root -> red (this is the exact
  two-tree split, pinned).
- Non-regression: every existing test that chdirs or asserts a state path stays green UNCHANGED. If
  an existing expectation needs editing, the change has altered a verb's contract and is wrong.

## Success Criteria

- Every verb family resolves one state tree from either checkout; the reproduction above yields a
  single tree.
- A pre-existing run whose state lives under a worktree hash gets a named refusal, not a silent
  second run.
- `--no-worktree` runs, and any hub standing at the repo root, are byte-identical in behavior.
- `npm run typecheck && npm test && npm run lint && npm run build` green; `dist/ap.cjs` committed.
