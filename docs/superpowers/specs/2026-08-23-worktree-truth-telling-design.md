# Worktree truth-telling (PR A)

Date: 2026-08-23. Sources: the operator's detached-run report from a sibling repo (5 PRs shipped
from ap worktrees, W1/W2/W3), and `/ap:review` forensics cluster F6 (near-miss, local
`04-10-36-implement-flag-scope-testing.md`).

## Problem

Five detached runs shipped through ap worktrees with no fatal defect, and four true statements about
the worktree were nowhere the operator or the run could read them:

- **W1 — a worktree forks committed HEAD.** `startWorktree` (`src/commands/job.ts:184`) runs
  `git worktree add -b base/<topic> <wt> <baseSha>`; the only non-git content copied is
  `node_modules` (`:191-206`). Uncommitted work is therefore invisible inside the run, and today's
  warning (`:208-210`) says only that the tree is dirty — not WHICH files, and nothing checks whether
  a path the design doc actually cites is among them. It bit the operator twice, both times a design
  doc; once it surfaced as a `chore: WIP snapshot` commit from an attached run auto-committing the
  spec.
- **W2 — a long-lived run branch goes stale.** One branch sat through three merges and landed a
  conflict. `DRIFT=` exists, but only in `finishHint` at `job stop` (`src/commands/job.ts:283-297`) —
  after the fact, never during the run.
- **W3 — a live worktree pins its branch.** `git branch -D base/<topic>` refuses mid-run. That is
  the protection mechanism, but it is stated only in error strings the operator reads *after*
  hitting it (`job.ts:150`, `:174`).
- **F6 — `job` verbs are cwd-sensitive.** `run()` (`src/commands/job.ts:57-59`) chdirs to
  `repoRoot()`, which from inside `.ap/worktrees/<topic>` resolves to the WORKTREE root, not the
  main checkout. `budget-check` then hashed the worktree path, found no job record, and printed
  `BUDGET=unknown` rc 1 — read as "budget exhausted" — on a healthy 0.62h/2h run. A healthy run
  would have parked on a cwd slip.

## Goal

Every fact the worktree hides is stated by the layer that knows it: `job` verbs resolve one job
record regardless of which of the two checkouts they are invoked from; `job start` names the
uncommitted files it is leaving behind; `implement init` reports design-doc paths that exist in the
main checkout but are missing in the run's target; `job status` shows staleness during the run
rather than at teardown; and the branch pin is documented before it is hit.

## Architecture

**A1 — re-root `job` verbs (F6).** New `mainCheckoutRoot(root)` in `src/core/job.ts`, the inverse of
the existing `worktreePathFor` (`src/core/job.ts:57-59`): the run worktree path is
`<root>/.ap/worktrees/<topic>` **by construction**, so recovering the main root is pure string
surgery on that prefix — no `git rev-parse` subprocess, no per-invocation git call. It returns the
recovered root only when `worktreeProvenanced(root, recovered)` (`src/core/job.ts:63-65`) agrees,
else `root` unchanged. `src/commands/job.ts` `run()` uses `J.mainCheckoutRoot(repoRoot())` in place
of `repoRoot()`; the chdir/restore discipline around it is untouched.

`repoRoot()` itself (`src/core/paths.ts`) is deliberately NOT broadened: it would silently re-home a
user's own worktree — the standard parallel-session discipline — into the main repo's state
namespace, and make `implement init` default its target to a checkout the user deliberately left.
The re-rooting is confined to `job` verbs and to ap-created run worktrees.

**A2 — name the uncommitted files (W1).** `startWorktree` already has the `git status --porcelain`
stdout in hand at `:208`. It lists the first 10 entry paths, adds `+N more` when truncated, and ends
with the actionable sentence (stop, commit, start again — if the run must READ any of them). The
porcelain is parsed properly: strip the two-char XY status prefix, take the post-`->` side of rename
entries, and unquote `core.quotePath`-escaped names — otherwise the warning prints ` M docs/spec.md`
and `"d\303\251sign.md"` at the operator.

**A3 — report invisible cited paths (W1's enforcement).** New
`pathsInvisibleInTarget(docText, mainRoot, targetCwd)` in `src/core/implementScope.ts`: walk both
the Components paths and the `## Testing` section paths, skip `[on-box]` lines, and keep `p` where
`existsSync(resolve(mainRoot,p)) && !existsSync(resolve(targetCwd,p))`.

The **exists-in-main AND missing-in-target** conjunction is the whole point. A plain
missing-in-target lint fires on every file the design intends to CREATE — which in this repo's docs
is most of them (`tests/implement-init.test.ts:148-160` already pins that a to-be-created path
warns), and a warning that fires every run is a warning nobody reads. Only the differential
isolates "this file exists where you are standing and not where the run will stand", which is
exactly and only the uncommitted-doc failure.

`initWith` (`src/commands/implement.ts:160-175`, after `targetCwd` is resolved and the art dir is
made) emits `INVISIBLE_IN_TARGET=<n>` plus one `INVISIBLE_PATH=<p>` per path on stdout when
`parsed.target && targetCwd !== d.repoRoot()`, and atomically writes `<art>/path-lint.txt` — the
layer records its own verdict, because stdout is gone after the hub's turn. **rc is unchanged (0)**:
this is a report, not a gate. `commands/implement.md` Stage 0's detached row instructs the hub to
PARK naming the paths when the count is non-zero; the attached path surfaces them to the user.

**A4 — staleness during the run (W2).** The drift computation is extracted out of `finishHint`
(`src/commands/job.ts:283-291`) into `driftFor(rec, r)`, preserving the degrade-to-`?` discipline
already pinned by `tests/job-worktree.test.ts:394-433`; `finishHint` calls it. `statusRun`
(`src/commands/job.ts:393-419`) appends `WORKTREE=`, `START_BRANCH=` and
`DRIFT=<n|?> (local ref; ap never fetches)` to its KV block, constructing a Runner (it has none
today).

The parenthetical is load-bearing, not decoration: ap issues **zero** network git calls anywhere in
`src`, so `DRIFT` counts `<base_sha>..refs/heads/<start_branch>` against the LOCAL ref. In the
operator's actual W2 scenario — three PRs squash-merged on GitHub, local `main` never pulled —
an unlabelled `DRIFT=0` would read as "not stale" and would be worse than no field at all.

**A5 — state the two facts (W1, W3).** `worktreeLines()` (`src/core/job.ts:238-260`, which feeds the
hub's brief) states that the worktree is a fresh checkout of committed HEAD: no build products, no
untracked `.env`/config, and a `node_modules` clone. `commands/job.md` documents, next to the
existing sweep paragraph, that a live run PINS `base/<topic>` and `feat/<cmd>-<topic>` — git's
refusal to check them out or `-D` them in the main checkout is the protection, and both clear after
`job stop`.

The *worker's* environment rule (a skipped env-gated leg is skipped, never green) is deliberately
NOT put here: `worktreeLines` feeds the HUB's inbox, and the actor who must not claim green is the
worker, whose prompt is composed by `composeRound1Prompt`. That rule ships in PR B.

## Rejected (do not re-raise)

- Auto-rebasing or merging `base/<topic>` mid-run: it rewrites the tree a worker is mid-edit in and
  invalidates the fork base every verdict was computed against.
- `git fetch` inside a read-only status verb: ap makes no network git calls, and a status verb is
  the wrong place to start.
- Copying uncommitted files into the worktree, or auto-stashing at `job start`: forking committed
  HEAD IS the isolation guarantee; a blanket copy carries secrets and half-finished edits into an
  unwatched run. A2/A3 make the invisibility visible instead.
- A dirty tree as a hard launch gate: unrelated WIP is the normal state of a checkout.
- ap pruning or removing worktree registrations it did not create. Verified by execution on
  git 2.43: a registration whose directory still EXISTS is not prunable at all, so the
  `git worktree prune` ap already issues cannot touch a foreign entry — the guard once proposed for
  this was error handling for an impossible scenario. Foreign registrations stay the operator's.

## Components

- `src/core/job.ts` — new `mainCheckoutRoot(root)`; `driftFor` is NOT here (it needs a Runner);
  `worktreeLines()` gains the fresh-checkout sentences.
- `src/commands/job.ts` — `run()` uses `mainCheckoutRoot(repoRoot())`; `startWorktree` names the
  dirty paths; `driftFor(rec, r)` extracted from `finishHint`; `statusRun` prints
  `WORKTREE=`/`START_BRANCH=`/`DRIFT=`.
- `src/core/implementScope.ts` — new `pathsInvisibleInTarget(docText, mainRoot, targetCwd)`.
- `src/commands/implement.ts` — `initWith` emits `INVISIBLE_IN_TARGET=`/`INVISIBLE_PATH=` and writes
  `<art>/path-lint.txt` for `--target` runs.
- `commands/implement.md` — Stage 0 detached row: PARK on `INVISIBLE_IN_TARGET>0`.
- `commands/job.md` — the branch-pin paragraph; the `status` fields, including the local-ref caveat.
- `tests/job-worktree.test.ts`, `tests/job.test.ts`, `tests/implement-scope.test.ts`,
  `tests/implement-init.test.ts` — the cases below.
- `dist/ap.cjs` — rebuilt and committed.

## Testing

- `tests/job-worktree.test.ts` — real repo + `startWorktree(root,'demo')`; write a job record in the
  ROOT namespace; `process.chdir(<root>/.ap/worktrees/demo)`; `run(['budget-check','demo'])` prints
  `BUDGET=within` rc 0. Mutation: revert `run()` to bare `repoRoot()` -> `BUDGET=unknown` rc 1 (the
  reproduced field bug).
- `tests/job-worktree.test.ts` — over-broad guard: a cwd inside a NON-provenanced worktree (a user's
  own, outside `.ap/worktrees/`) is left alone by `mainCheckoutRoot`. Mutation: drop the
  `worktreeProvenanced` check -> red.
- `tests/job-worktree.test.ts` — an untracked `docs/spec.md` appears BY NAME in `startWorktree`'s
  warning; with 12 dirty entries the warning carries `+2 more`; a rename entry reports its
  destination path; a `core.quotePath`-escaped name is printed unescaped. Mutation: restore the
  generic message -> red.
- `tests/job-worktree.test.ts` — `status` prints `DRIFT=2` and `START_BRANCH=main` after two commits
  on `main`; with `start_branch:''` it prints `DRIFT=?` and never `DRIFT=0`; the printed line carries
  the `local ref` caveat. Mutations: delete the DRIFT line -> red; make the unknown case print `0`
  -> red; drop the caveat text -> red.
- `tests/implement-scope.test.ts` (pure) — a doc citing `keep.ts` (in both), `new.ts` (in neither —
  the file the design will create), `spec.md` (main only) returns exactly `['spec.md']`; an
  `[on-box]` line is exempt; a `## Testing` path present in main only IS returned. Mutation: drop
  the exists-in-main conjunct -> `new.ts` leaks in -> red.
- `tests/implement-init.test.ts` — `init --target <tmp-git-dir>` with a doc citing a main-only path
  prints `INVISIBLE_IN_TARGET=1` + the `INVISIBLE_PATH=` line, returns rc 0, and writes
  `<art>/path-lint.txt`; a run WITHOUT `--target` prints neither line. Mutation: emit the lines
  unconditionally -> the no-target case goes red.
- `tests/job.test.ts` — `jobBrief` for a worktree record contains the fresh-checkout sentence; a
  `--no-worktree` record (`worktree:''`) does not (the existing shape assertion at :273 still holds).
  Mutation: delete the sentence -> red.

## Success Criteria

- From inside `.ap/worktrees/<topic>`, `ap job status|budget-check|mode <topic>` resolve the same
  record as from the repo root.
- `job start` with an uncommitted `docs/spec.md` names that file in its warning.
- `implement init --target <wt>` on a doc citing an uncommitted spec reports it, and the detached
  directive parks instead of burning a worker question round.
- `job status` shows `WORKTREE=`, `START_BRANCH=`, `DRIFT=` with the local-ref caveat.
- `npm run typecheck && npm test && npm run lint && npm run build` green; `dist/ap.cjs` committed.
- No behavior change for `--no-worktree` runs or for any attached (`/ap:implement` without
  `--target`) run: their stdout, rc and state files are byte-identical.
