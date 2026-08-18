# Detached runs work in a worktree — design

**Date:** 2026-08-18
**Status:** approved (grilled; six decisions recorded below)
**Scope:** detached (`--detached`) implement and quick runs only. Attached behavior byte-identical.
Successor items deliberately out: worktrees for attached runs; any polyglot dependency provisioner;
mechanically blocking local merges of detached branches (operator sovereignty + remoteless repos).

## Problem

A detached run frees the origin session in name only. Both live dogfoods checked out
`feat/implement-<topic>` in the MAIN checkout: the origin session was frozen out of its own repo
for the run's duration (an edit would have landed inside the worker's diff; a `git checkout main`
would have yanked the branch from under the worker), and the park-drill left HEAD sitting on the
drill branch. Branch checkout and the index are global to a checkout — the detached promise
("your session is free") does not hold for the very repo the job works on.

A second, subtler problem: the hub's cross-verify runs against the FORK BASE, but main moves while
a multi-hour job runs (five merges landed on main today during runs). A direct local merge of the
finished branch integrates code nobody verified against current main.

## Decisions (grilled 2026-08-18)

| # | Decision |
|---|---|
| D1 | Worktree isolation is **default-ON for every detached run** (implement and quick); attached runs untouched. `--no-worktree` at `job start` is the escape hatch for repos whose suite only runs in the blessed checkout. |
| D2 | The worktree forks **committed HEAD**; the operator's uncommitted WIP stays out. `job start` warns loudly when the main tree is dirty. Pre-snapshot's role in a detached run shrinks to recording the base. |
| D3 | Location `<repoRoot>/.ap/worktrees/<topic>` (same filesystem → `cp -al node_modules` works; `.ap/` is auto-gitignored). Provisioning = hardlink-clone `node_modules` when present; anything else is the worker's job. |
| D4 | **`job start` creates it** and records it in `job.json`; the brief tells the job hub; `implement init` / `quick init`+`branch` gain a `--target <abs>` override (which also closes the xjp forensics ask for a first-class target override). |
| D5 | Teardown: `job stop` removes a CLEAN worktree (`git worktree remove` + `prune`), KEEPS a dirty one and names it (a crashed worker's unarchived work), and never touches a path outside `.ap/worktrees/` (provenance, same rule as pane ownership). The branch always survives — worktrees share the ref store. |
| D6 | Integration goes through a **PR, never a local merge**: the run's default finish stays `keep`, but `--finish pr` becomes a LEGAL opt-in at `job start` (push + open PR, never merge; `merge`/`discard` stay refused). `job stop` prints the exact push+PR commands plus how far main has moved since the fork. Local merge of a detached branch is documented as the wrong verb (stale-base rationale), not mechanically blocked. |

## Architecture

```
job start --command implement --args-file F [--finish keep|pr] [--no-worktree]
  1. derive topic; refuse in-flight            (as today)
  2. BASE=$(git rev-parse HEAD)                 in the repo root
  3. WT=<repoRoot>/.ap/worktrees/<topic>
     refuse if WT exists (a kept-dirty leftover — the message names it and D5's remedy)
     git worktree add --detach "$WT" "$BASE"    detached at the base: the normal `branch`
                                                verb creates feat/<cmd>-<topic> INSIDE it,
                                                so the branch flow is unchanged, just re-homed
     cp -al node_modules "$WT/node_modules"     when present; hardlink clone, seconds
     [dirty main tree?] -> log.warn "your uncommitted WIP is NOT in the worktree"
  4. job.json += { worktree: WT, base_sha: BASE }   (absent fields tolerated: old records parse)
  5. brief += the --target instruction
  6. spawn the job hub                          (as today)
```

- **The hub and all `.ap` state stay keyed to the repo root** — moving them into the worktree
  would re-open the namespace-split class #135 closed. Only the WORKER's `target_cwd` moves.
- `implement init --target <abs>`: overrides `d.repoRoot()` as the target; must exist and be a git
  work tree. Everything downstream already flows from `target_cwd.txt`. Rejected inside
  `parseImplementArgs` today via the unknown-flag guard — becomes a first-class flag.
- `quick`: `--target` on `init` (echoed in `TARGET=`) and on `branch` (used + recorded in
  `target_cwd.txt`, src/commands/quick.ts:95/:103/:162); downstream verbs already read the record.
- **`--finish pr` end-to-end**: `job start` accepts it (`finishAllowedDetached` grows to
  {keep, pr}); the mechanical finish gates change from "only keep" to "only the action job.json
  records" — `implement finishWith` allows `pr` when `job.json.finish === "pr"`, refuses
  `merge`/`discard` always; quick's diversion likewise honors a recorded `pr` by taking its normal
  push+PR arm. The directives' DETACHED rows read the finish from job.json as they already do.
- **`job stop` finish hint**: when the topic branch exists and has commits past `base_sha`, print a
  `FINISH` block — the branch name, `git push -u origin <branch>` + `gh pr create` lines, and
  `main moved <N> commits since the fork` (`git rev-list --count BASE..main`). Keep-mode runs only.
- **Worktree sweep in `job stop`** (after the session sweep, before the record clear): recorded
  worktree + provenance check (path under `.ap/worktrees/`) → clean? remove+prune : keep+name.
  An incomplete sweep behaves like the session sweep: keep the record, rc 1.

## Components

- `src/core/job.ts` — `jobWorktreeDir(topic)`, `JobRecord` gains optional `worktree`/`base_sha`
  (codec tolerant both ways), `finishAllowedDetached` → {keep, pr}, `worktreeProvenanced(path,
  root)` pure predicate, `jobBrief` carries the `--target` line and the recorded finish.
- `src/commands/job.ts` — startRun steps 2–5 (+ `--no-worktree`, `--finish pr`), stopRun sweep +
  FINISH hint.
- `src/core/implement.ts` / `src/commands/implement.ts` — `--target` flag; finish gate honors the
  recorded action.
- `src/commands/quick.ts` — `--target` on init/branch; finish diversion honors a recorded `pr`.
- `commands/implement.md`, `commands/quick.md` — DETACHED MODE: pass `--target` from the brief;
  finish row reads job.json's action. `commands/job.md` — stop section: sweep + FINISH hint.
- `README.md` — detached section: worktree isolation, what the origin may now freely do (anything
  except checking out the worker's branch or touching that topic's `.ap` state), and PR-not-merge.
- Tests — codec back-compat; provenance predicate; `--target` parsing/validation both commands;
  brief content; `job start` worktree-exists refusal; live-git integration tests (temp repo):
  worktree created detached at base, node_modules hardlinked, dirty-main warning, clean sweep
  removes / dirty sweep keeps; finish gates: recorded `pr` allows `pr` and still refuses `merge`.

## Testing

Full gate (`typecheck`/`lint`/`test`/`build`, dist committed), fresh `AP_HOME` per test; live-git
tests use throwaway `git init` repos exactly as the namespace regression test does. Version 0.5.36
across the three manifests.

## Success Criteria

1. A detached run's worker never checks out a branch in the main checkout; the origin session can
   edit and switch branches there for the whole run.
2. The worktree forks committed HEAD; a dirty launch warns; `.ap/worktrees/<topic>` is removed on
   a clean `job stop` and kept+named when dirty; nothing outside `.ap/worktrees/` is ever removed.
3. `--finish pr` opens a PR and never merges; default remains `keep`; `merge`/`discard` still
   refused at start and at the finish verbs.
4. `job stop` prints the push+PR finish hint with the main-drift count for keep-mode runs.
5. Old `job.json` records (no worktree fields) still parse and behave as before.
6. Suite green, dist fresh, attached paths byte-identical.
