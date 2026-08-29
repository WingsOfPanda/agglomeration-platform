# `job start` refuses a design doc the run's worktree cannot see

Issue: **#160**. Ships in **0.5.56**.

## Problem

`ap job start --command implement --args-file <f>` launches a detached run in an isolated worktree
forked from **committed HEAD** (0.5.36 onward). A design doc that exists only as uncommitted or
untracked work in the operator's checkout is therefore invisible to the worker — and that doc is the
single input the run exists to consume.

`startWorktree` already notices this. It only WARNS, and it warns late (`src/commands/job.ts:255-268`):

```
job start: <root> has UNCOMMITTED changes and they are NOT in the worktree — it forks committed HEAD
(<sha>). Nothing of yours was touched or stashed; the run simply will not see that work.
  not in the worktree: docs/superpowers/specs/2026-08-29-x-design.md
  If the run must READ any of those — a design doc especially — stop now: 'ap job stop <topic>',
  commit them, and start again.
```

The field sequence that produces, in order:

1. `git worktree add -b base/<topic> <root>/.ap/worktrees/<topic> <baseSha>` — the worktree exists.
2. `base/<topic>` — the branch exists.
3. `cp -al node_modules` into the worktree.
4. the WARN above is printed, into a stream the operator is usually not reading yet.
5. the job record is written, the job hub is spawned (~30s bootstrap), `rc 0` is returned, and the
   Monitor watch is armed on a run that is guaranteed to fail.
6. the operator's remedy: `ap job stop <topic>`, commit, relaunch — after paying for all of 1-5.

Twice in the field the invisible file was exactly the design doc. A warning that arrives after the
launch has committed resources is a warning that costs a full teardown to act on.

## Goal

Refuse the launch at the point where the failure is already mechanically certain, before a single
resource exists. `rc 2` (the launch-time-refusal code `job start` already uses), a message that names
the doc and the fix, nothing created, nothing to tear down.

Non-goal: turning the generic dirty-tree warning into a refusal. Other dirty files are WIP the run
may legitimately be forking away from.

## Architecture

**One preflight, before any resource.** `refuseInvisibleDoc` (`src/commands/job.ts:385`) is called
from `startRun` (`src/commands/job.ts:457-460`) immediately after `const r = runnerAt(root)`
(`src/commands/job.ts:456`) and before `startWorktree` (`src/commands/job.ts:466`). Everything above
that point is a pure read — argument parsing, `existsSync` on the args file, topic derivation and
validation, the in-flight check, `pickRandomAgent`, `repoRoot`, `runnerAt`. Nothing is written, no
directory is made, no branch is cut. Returning `2` there leaves the checkout exactly as it was found.

**Reuse, not a second rule.** Two pieces already existed and are shared rather than reimplemented:

- `J.docFromImplementArgs` (`src/core/job.ts:417`) — newly extracted from `topicFromImplementArgs`
  (`src/core/job.ts:425`), which now calls it. The token rule is unchanged byte-for-byte: the first
  token that does not start with `-` and ends in `.md`. It is the same rule `implement init` reads
  the doc by, and a preflight that disagreed with init about which token is the doc would gate the
  wrong file. `--topic` precedence in `topicFromImplementArgs` is untouched.
- `dirtyPaths` (`src/commands/job.ts:171`) — the existing porcelain parser, including its rename-
  destination and quoted-path handling.

**Resolution.** The doc is resolved exactly as `--args-file` is (`src/commands/job.ts:441`): against
the ORIGIN's cwd, because that is the frame the operator typed it in, then made repo-relative with
`relative(root, abs)` because `git status --porcelain` reports repo-relative paths. An absolute doc
outside the repo simply will not match — the right answer, since this gate is not the missing-file
check (`implement init` owns that).

**The collapsed-directory case.** `git status --porcelain` reports a wholly-untracked directory
collapsed, as `?? docs/`; git stops descending once it knows the directory is untracked, so the doc
inside it is never named. That is precisely the common shape of this bug — a brand-new specs
directory — so the match treats a trailing-slash entry as the prefix it is
(`src/commands/job.ts:399-400`). `-uall` would expand it instead, at the cost of walking every
untracked tree in the repo on every launch.

**`--allow-invisible-doc`** (`src/commands/job.ts:412`) is a boolean flag in the same parse loop as
`--no-worktree`, and skips the gate for an operator who means it. The generic `startWorktree` WARN is
left EXACTLY as it was: it still covers every other dirty file, and it still names the doc on the
`--allow-invisible-doc` path, so nothing goes unsaid.

**Scope.**

- Gated only when `command === "implement" && useWorktree && !allowInvisibleDoc`.
- `--no-worktree` is not gated: there is no fork for the doc to be invisible to.
- **`--command quick` is deliberately NOT gated.** A quick run's task is inline text in its args
  file, not a path the run must read; a `.md` token there is prose, not an input. Issue #160 marks it
  lower priority, and gating it would refuse launches over a filename someone merely mentioned.

**Accepted cost.** `git status --porcelain` now runs twice per worktree start — once here, once in
`startWorktree`. That is one cheap process against restructuring `startWorktree`, whose fail-closed
sequencing is load-bearing and out of scope.

## Components

| File:line | Change |
|---|---|
| `src/core/job.ts:417` | new `docFromImplementArgs(text)` — the doc-positional rule, extracted |
| `src/core/job.ts:425-433` | `topicFromImplementArgs` now calls it; behavior byte-identical |
| `src/commands/job.ts:374-403` | new `refuseInvisibleDoc(argsText, root, origCwd, r): number` |
| `src/commands/job.ts:407,412` | `--allow-invisible-doc` in `startRun`'s parse loop |
| `src/commands/job.ts:457-460` | the call, before `startWorktree` |
| `src/commands/job.ts:38` | the flag in `usage()` |
| `src/commands/job.ts:255-268` | the generic dirty-tree WARN — **unchanged** |
| `commands/implement.md:45-47` | the `job start` rc-2 enumeration names the new refusal |

## Testing

`tests/job.test.ts` — the pure rule: the doc positional is found; flag TOKENS are skipped and a
flag's VALUE deliberately is not; no doc yields `""`; `--topic` steers the topic and leaves the doc
alone; the existing `topicFromImplementArgs` cases stay green (byte-identical refactor).

`tests/job-worktree.test.ts` — the whole `start` verb against REAL git in a throwaway repo, with a
tmux shim that always fails (the file's existing `repo()` harness):

- an untracked doc in a new directory (`?? docs/` collapsed) → rc 2, and **nothing created**: no
  worktree dir, `git worktree list` still one entry, no `base/<topic>`, no job record;
- an untracked doc in a TRACKED directory (git names the file) → rc 2;
- a MODIFIED tracked doc → rc 2;
- **ordering**: a pre-planted `base/<topic>` branch is something `startWorktree` itself refuses over,
  in its own words. The refusing launch never emits that text — proof the gate ran first;
- the identical launch with a COMMITTED doc → rc 1 with `startWorktree`'s base-branch refusal, i.e.
  the gate was passed;
- `--allow-invisible-doc` on the invisible doc → the same rc 1, the gate passed;
- `--no-worktree`, `--command quick`, and an args file with no doc positional → no refusal.

**Mutation evidence** (both run, both fail):

- m1 — force `allowInvisibleDoc = true` before the gate: 4 tests fail.
- m2 — move the gate to AFTER the `startWorktree` call: the same 4 fail, three of them on the
  `existsSync(worktreePathFor(root, TOPIC))` assertion — the worktree got created.

## Success Criteria

1. A `job start --command implement` whose design doc is uncommitted exits **2**, prints a message
   naming the doc and both remedies, and leaves no worktree, no `base/<topic>`, no job record, no
   spawned hub.
2. `--allow-invisible-doc` restores the pre-0.5.56 behavior exactly, generic warning included.
3. Every other launch shape — committed doc, `--no-worktree`, `--command quick`, no doc positional —
   is unchanged.
4. `topicFromImplementArgs` is byte-identical; the existing suite stays green.
5. Full gate green (`typecheck` / `test` / `lint` / `build`) with `dist/ap.cjs` committed.
