# Stale branch resume refusal (PR E)

Date: 2026-08-23. Source: found independently by both adversarial critics during the PR A-D design
review; it is the hazard UNDER the operator's "22 lingering remote feat/* branches" report, which is
why a branch sweep would mask it rather than fix it.

## Problem

`createOrResumeBranch(r, name)` (`src/core/gitwork.ts:186-191`) checks out an existing ref
unconditionally:

```
if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).code === 0) {
  return r.run("git", ["checkout", "-q", name]).code === 0;
}
return r.run("git", ["checkout", "-q", "-b", name]).code === 0;
```

Branch names are derived from the topic (`branchNameFor`), so a second run on the same topic gets
the same name. After a **squash merge** — the operator's merge style — the local
`feat/<cmd>-<topic>` survives with commits that are NOT ancestors of `main`, even though their
content is in `main`. A re-run of that topic silently resumes that branch, and its finish opens a PR
re-proposing already-merged work. The same shape produces the remote-branch litter the operator is
now cleaning up by hand.

Call sites, from `grep -rn "createOrResumeBranch" src/`:

| Call site | Context |
|---|---|
| `src/commands/quick.ts:172` | `quick branch` — primary branch creation |
| `src/commands/implement.ts:344` | `implement branch` — resume arm (ref exists) |
| `src/commands/implement.ts:345` | `implement branch` — create arm |
| `src/commands/bridge.ts:121` | `bridge branch` — repo-B branch |

All four log the boolean and continue; none inspect what they resumed.

## Goal

A run resumes a same-named branch only when that branch is a genuine continuation of where the
checkout stands now. A branch that has diverged — the squash-merged leftover — stops the verb with a
message naming the remedy, instead of being silently inherited.

## Architecture

`createOrResumeBranch` returns a typed outcome instead of a bare boolean:

- ref absent -> `"created"` (checkout `-b`; unchanged behavior)
- ref exists and its tip is HEAD or a **descendant** of HEAD -> `"resumed"` (checkout; unchanged) —
  the genuine continuation: work carried forward from where we stand.
- ref exists and HEAD is **not** an ancestor of the ref -> `"stale"`, and **no checkout happens**.
  The checkout has moved on past the branch's fork point, which is what a merge of the run's own work
  back into the start branch does.

The ancestry probe is `git merge-base --is-ancestor HEAD refs/heads/<name>` (rc 0 = HEAD is an
ancestor of the branch tip = genuine continuation). It is one cheap, local call and needs no network
and no patch-id heuristics.

A false positive is possible and acceptable: a genuine WIP branch whose start branch has since moved
also reports `stale`. Resuming such a branch is already the wrong default (it is based on an old
fork point), and the message tells the operator the three ways forward. A false NEGATIVE — silently
inheriting merged work — is the failure being closed, and it cannot happen under this rule.

Callers surface it, each in its own wording, and refuse rather than proceed on a stale branch:

- `src/commands/quick.ts:172` and `src/commands/implement.ts:344-345`: `stale` -> `log.error` naming
  the branch, the fact that it has diverged from the current HEAD (likely already merged), and the
  remedy — delete it (`git branch -D <name>`), rename it, or check it out by hand and re-run — then
  return rc 1. This joins the existing rc-1 aborts of those verbs (`quick.ts:177` not-a-git-repo).
- `src/commands/bridge.ts:121`: same message, and the run aborts through bridge's existing
  setup-abort path (`bridge summary --aborted setup branch`).

Nothing is deleted, force-updated, or renamed by ap. The operator's branch and its commits are left
exactly as they are.

## Rejected

- Auto-deleting or auto-renaming the stale branch: it is the operator's work, possibly unmerged in a
  way ancestry cannot see, and ap must never destroy state it did not create.
- Patch-id detection (`git cherry`) of "already merged by squash": a squash merge produces ONE commit
  for N, so no individual patch-id matches. It would report clean and change nothing.
- A `--resume-branch` opt-out flag: no caller has asked for one, and the remedy line already gives
  three ways forward. Add it if a real workflow demands it.

## Components

- `src/core/gitwork.ts` — `createOrResumeBranch` returns `"created" | "resumed" | "stale"`; the
  ancestry probe; doc comment stating why a diverged branch is refused rather than inherited.
- `src/commands/quick.ts` — `branchWith` at the call site: refuse on `stale` with rc 1.
- `src/commands/implement.ts` — `branchRun` resume/create arms: same refusal.
- `src/commands/bridge.ts` — the setup-abort path on `stale`.
- `tests/gitwork-*.test.ts`, `tests/quick-cmd.test.ts`, `tests/implement-cmd.test.ts`,
  `tests/bridge-cmd.test.ts` — the cases below.
- `commands/quick.md`, `commands/implement.md` — one line each in the branch step naming the new
  rc-1 refusal and its remedy.
- `dist/ap.cjs` — rebuilt and committed.

## Testing

- `tests/gitwork-*.test.ts` (real git) — three outcomes: no ref -> `"created"` and HEAD is on the new
  branch; ref exists at HEAD -> `"resumed"`; ref exists, then `main` advances by one commit ->
  `"stale"` AND `git symbolic-ref HEAD` still names the ORIGINAL branch (proving no checkout
  happened). Mutation: drop the ancestry probe so the ref-exists path always checks out -> the stale
  case goes red on both assertions.
- `tests/gitwork-*.test.ts` — the SQUASH-MERGE reproduction, end to end: create `feat/quick-t`, commit
  on it, return to `main`, `git merge --squash feat/quick-t && git commit`, then call
  `createOrResumeBranch(r, "feat/quick-t")` -> `"stale"`. Mutation: revert to the committed
  pre-PR implementation -> it returns true and checks the merged branch out -> red.
- `tests/quick-cmd.test.ts` — `quick branch` on a squash-merged leftover returns rc 1, stderr names
  the branch and the `git branch -D` remedy, and NO `branch.txt` is written (the run did not start).
  Mutation: return 0 on stale -> red.
- `tests/implement-cmd.test.ts` and `tests/bridge-cmd.test.ts` — the same refusal at their own call
  sites.
- Non-regression: every existing branch test (create + genuine resume) stays green UNCHANGED — a
  resume where the checkout has not moved is the common case and must not have been made stricter.

## Success Criteria

- Re-running a topic whose PR was squash-merged creates nothing, resumes nothing, and stops with a
  message naming the leftover branch and the remedy.
- A genuine same-topic continuation (start branch unmoved) still resumes exactly as today.
- `npm run typecheck && npm test && npm run lint && npm run build` green; `dist/ap.cjs` committed.
