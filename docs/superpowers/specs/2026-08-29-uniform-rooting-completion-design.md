# Uniform re-rooting completion: stop / list / collect / preflight — design

**Date:** 2026-08-29
**Status:** approved (issue #164, incl. its post-adversarial-review amendment of 2026-08-29;
mechanism verified on main at 0.5.56)
**Completes:** the #155 program (0.5.51 uniform cwd re-rooting) and its #156 companion guard.

## Problem

PR #155 (0.5.51) gave every verb family a uniform cwd re-rooting, so a process standing in an
ap-created run worktree — `<root>/.ap/worktrees/<topic>`, ap-created BY CONSTRUCTION — resolves the
SAME state tree as one standing in the root checkout. Every state path derives from `process.cwd()`
(`paths.ts` `stateRoot` + `repoHash`), so without that re-rooting a verb invoked from the run's own
worktree hashes the WORKTREE and reads an empty tree.

**Four top-level commands never received it.** All four resolve state from raw `process.cwd()`:

| Command | Raw site (pre-fix line numbers) | Symptom |
|---|---|---|
| `src/commands/stop.ts` | `topicDir(topic)` at :77, :78 (`.last_pane` read/remove), :83 (`collectTopicPairs`), :95 (`collectAgentPairs`), :111 (`cleanupTopicDir`); `repoStateDir()` at :146 (`--all`) | `[FAIL] no worker '<agent>' on topic '<topic>'` (stop.ts:180, rc 1) |
| `src/commands/list.ts` | `repoStateDir()` at :48 | empty table / `no workers deployed`, or orphan rows |
| `src/commands/collect.ts` | `resolveModel(agent, topic)` at :16 | the same false `no worker '<agent>' on topic '<topic>'` |
| `src/commands/preflight.ts` | `topicDir(topic)` at :32 (the default `_consult` art dir) | panes allocated against the wrong tree (`--art-dir` takes an absolute path and was never affected) |

**Field evidence (xjp, ap 0.5.5x, 6 recorded occurrences across ≥5 topics, 2026-08-24 → 08-28).**
`ap stop <AGENT> <SLUG>` run while the hub's cwd was the run's worktree returned `no worker` while
the worker was real, alive, and keyed under the ROOT hash. In the two worst runs — forensics
`2026-08-27/19-54-47` (`solo-pmg-overfit-mea`) and `2026-08-28/14-17-44` (`fix-what-you-need-an`) —
nothing was archived, `.ap/archive` stayed empty, the worker pane was left alive and idle, and
`archived-path.txt` was never written; teardown fell through to `job stop`'s sweep. Four earlier
flags record the same shape as "stop cwd-sensitivity, 2nd/3rd/4th occurrence" (each succeeded
verbatim when re-run from the repo root).

The forensics' own theory blamed `target_cwd.txt` (quick.ts:261). That is NOT the mechanism —
`target_cwd.txt` feeds `runnerAt`/finish, never state resolution. The mechanism is the missing
re-rooting above.

**Why it matters beyond the annoyance.** `stop` is the teardown verb: a false "no worker" leaves
live panes and unarchived state behind (observed twice on 0.5.5x), and the near-miss direction is
worse — a state tree resolved under the wrong hash is one step from tearing down the wrong thing.
#156's `@ap_state` pane guard protects `send`; `stop`/`list`/`collect`/`preflight` have no
equivalent.

## Goal

The uniform-rooting invariant becomes true of EVERY top-level state consumer: `stop`, `list`,
`collect` and `preflight` resolve the same state tree from either checkout of a worktree run, refuse
a genuinely split (pre-0.5.51) run loudly instead of guessing, and leave a user's own
(non-provenanced) worktree exactly as git reported it. No command internals change — entry-level
wrap only.

## Architecture

The canonical dispatcher pattern, already identical in `quick` / `implement` / `design` / `explore` /
`bridge` / `autoresearch` / `send` / `spawn` / `job`, applied verbatim at the TOP of each of the four
`run()`s (helpers all exported from `src/core/job.ts`: `worktreeProvenanced` :66, `mainCheckoutRoot`
:83, `worktreeTopic` :92, `orphanedTopicState` :107, `orphanRefusal` :116):

```ts
const origCwd = process.cwd();
const gitRoot = repoRoot();
const root = mainCheckoutRoot(gitRoot);
const wtTopic = worktreeTopic(gitRoot);
const stranded = orphanedTopicState(wtTopic, gitRoot, root);
if (stranded) { for (const l of orphanRefusal(wtTopic, stranded, root).split("\n")) log.error(l); return 2; }
if (root !== origCwd) process.chdir(root);
try { return await dispatchVerb(args); }
finally { if (root !== origCwd) { try { process.chdir(origCwd); } catch { /* caller's cwd is gone */ } } }
```

**Why the orphan refusal must come BEFORE the chdir** (issue #164 amendment 2, the adversarial
review's high finding). A bare chdir wrapper is not enough. A run that STARTED before 0.5.51 hashed
the worktree checkout, so its topic dir sits under the worktree tree while a re-rooted verb now reads
the main one. Re-rooting over that state would make `stop` report "no worker" again — this time
against a tree that legitimately has nothing — and `--pairs` could SUCCEED against the wrong tree.
`orphanedTopicState` fires only when the main tree has no state for the topic and the worktree tree
does (steady state — both present, or only the main one — is a no-op), and ap refuses rather than
migrating: it does not move a run's state on the operator's behalf.

**Why it must also precede any teardown.** `stop`'s destructive half (`teardownBatch`,
`stateArchive`, `cleanupTopicDir`, the `--all` sweep) all derives from cwd. Placing the guard at
`run()` entry means a refused stop has archived nothing, killed nothing and deleted nothing — the
operator's stranded run is exactly as they left it when they are asked to decide which tree it lives
in.

**Why `mainCheckoutRoot`, not a broader `repoRoot` change.** It re-roots ap-created run worktrees
ONLY (the `worktreeProvenanced` check) and leaves every other path — a user's own worktree, a plain
subdirectory, a repo three levels down — exactly as git reported it. Outside a git repo `repoRoot()`
falls back to cwd, so the whole wrap is a no-op there.

## Components

| File | Change |
|---|---|
| `src/commands/stop.ts` | `run()` becomes the wrap (full rationale comment); the former body is `dispatchVerb(args)`. Imports `repoRoot` from `core/paths.js` and `mainCheckoutRoot`/`orphanRefusal`/`orphanedTopicState`/`worktreeTopic` from `core/job.js`. `teardownTopic` (called by `job stop`) is untouched — `job`'s own dispatcher already re-rooted. |
| `src/commands/list.ts` | same wrap; former body is `dispatchVerb(args)`; adds the `log` import for the refusal lines. |
| `src/commands/collect.ts` | same wrap; former body is `dispatchVerb(args)`. |
| `src/commands/preflight.ts` | same wrap; former body is `dispatchVerb(args)`. The guard precedes the art-dir `mkdirSync`. |
| `tests/state-rooting.test.ts` | four new `ROWS` entries (`stop`/`list`/`collect`/`preflight`), a `seedWorker`/`seedWorkerPair` helper, `archiveTs` normalization in both text pipelines, and two new describes for stop's destructive half and its no-touch refusal. |

## Testing

`tests/state-rooting.test.ts` is the table-driven per-family suite; the four commands join `ROWS`, so
each is automatically exercised by all three existing describes:

1. **matrix** — the identical invocation from the root and from the provenanced worktree produces
   byte-identical text, the same rc, and the same created state trees, never `<WTHASH>`. Each row's
   verb is chosen so its OUTPUT names the tree it resolved: stop names the archive path it wrote,
   list prints the model the resolved tree recorded (a decoy provider is planted in the other tree),
   collect names `<agent>-<model>` in `tailing outbox for ...`, preflight's observable is which tree
   its `_consult` mkdir created.
2. **over-broad guard** — from a user's own (non-provenanced) worktree each verb behaves exactly as
   in a plain checkout and is never re-homed into the main repo's namespace.
3. **orphan** — topic state only under the worktree hash → rc 2 naming both paths and the remedy.

Plus per-command cases that a text comparison cannot see:

- stop archives the ROOT worker, removes the ROOT `.last_pane`, rmdirs the ROOT topic dir, and
  leaves a worktree-tree topic dir (and its `.last_pane`) untouched — which is simultaneously the
  both-trees steady state (no refusal, the root wins);
- `stop --all` from a worktree cwd sweeps the ROOT state dir and leaves a worktree-tree topic alone;
- list prints the root-keyed worker's row from the worktree cwd;
- collect resolves the root-keyed model from the worktree cwd;
- preflight's default art dir lands under the root `topicDir` and no worktree tree is created;
- stop's refusal touches nothing: stranded worker dir, `.last_pane` and an absent `archive/` after
  rc 2.

**Mutation evidence** (each run for real, then restored): m1 `root = gitRoot` in stop's wrap → 5 stop
cases red; m2 delete stop's orphan-refusal lines → the two rc-2 cases red; m3 remove list's wrap
entirely → 3 list cases red.

**Live bundle proof**: a throwaway git repo + fresh `AP_HOME` with hand-written root-keyed worker
state and a `git worktree add`-ed `.ap/worktrees/<topic>`; `node dist/ap.cjs list <topic>` and
`node dist/ap.cjs stop <agent> <topic>` run from INSIDE the worktree against the built bundle.

## Success Criteria

1. `stop` / `list` / `collect` / `preflight` resolve the ROOT state tree when invoked from an
   ap-created run worktree, and are unchanged from every other cwd.
2. A pre-0.5.51 run whose state is stranded under the worktree hash gets rc 2 naming both paths, and
   `stop` has archived / killed / deleted nothing when it refuses.
3. A user's own worktree is never re-homed.
4. The full gate is green (typecheck, test, lint, build) with `dist/ap.cjs` committed, and the three
   mutations above are red.
