# `bridge finish` merges an already-open PR instead of failing

**Date:** 2026-06-16 · **Status:** approved · **Branch:** `fix/bridge-finish-existing-pr`

## Problem

`finishBranchPrMerge` (`src/core/gitwork.ts`) returns `pr-create-failed` whenever `gh pr create`
exits non-zero. But the **most common** cause in the bridge flow is that the *worker already opened
the PR*, so `gh pr create` fails with "a pull request for branch … already exists" even though a
perfectly **mergeable** PR is sitting there. The hub then reports `pr-merge → pr-create-failed` and
the human merges by hand.

Surfaced by `/ap:review` (bl202 forensics, 2026-06-15/16): the quirk recurred across two bridge
topics — PR #5 (`update-the-iris-cort`) and PR #8 (`two-deliverables-in`), the latter explicitly
"recurred as expected (memory: `ap-bridge-finish-pr-quirk`)". Each was recovered manually with
`gh pr merge <n> --squash` + `git fetch && git merge --ff-only`. The standing memory documented the
quirk but did not stop it — so this escalates the memory to a fix.

## Decision

On `gh pr create` failure, check whether a PR already exists for the head branch
(`gh pr view <branch>`). If one does, **fall through to the existing merge step** rather than
returning `pr-create-failed`. Only a create-failure with **no** existing PR is a genuine
`pr-create-failed`.

The merge step that follows (`gh pr merge <branch> --merge --delete-branch` then
`git pull --ff-only origin <base>`) is exactly the manual recovery the forensics describe — including
the stale-local-`main` fast-forward — so no other path needs to change.

## Change

`src/core/gitwork.ts`, `finishBranchPrMerge` only. Guard the `pr-create-failed` return behind an
added existence check (short-circuit `&&`):

```ts
if (r.run("gh", ["pr", "create", "--repo", url, "--base", o.base, "--head", o.branch, "--title", title, "--body", body]).code !== 0 &&
    r.run("gh", ["pr", "view", o.branch, "--repo", url, "--json", "number"]).code !== 0) {
  r.run("git", ["checkout", "-q", o.base]);
  return { action: "pr-merge", outcome: "pr-create-failed" };
}
```

`gh pr view` runs only when create failed (short-circuit), reusing the same `url` already accepted by
`gh pr create --repo`. When a PR exists, control falls through to the unchanged merge/ff-pull lines.

## Out of scope

- New outcome strings (the existing-PR case correctly resolves to `pr-merged-pulled` /
  `pr-open-merge-blocked` / `pr-merged-pull-failed` like any merge).
- The no-remote / no-gh / merge-blocked / ff-fail paths — unchanged.
- Any bridge command-surface change.

## Tests (`tests/gitwork-prmerge.test.ts`)

The `pr-create-failed` path is currently **untested**; add both branches:

1. **create fails + no PR → `pr-create-failed`** — `gh pr create` code 1, `gh pr view` code 1.
   Asserts `gh pr view feat/bridge-x` was issued and `gh pr merge` was **not**.
2. **create fails + PR exists → `pr-merged-pulled`** (the quirk fix) — `gh pr create` code 1,
   `gh pr view` code 0. Asserts the sequence `gh pr view … → gh pr merge feat/bridge-x → git pull
   --ff-only`.

Existing tests are unchanged: all have `gh pr create` succeeding, so the new `gh pr view` check
short-circuits and never appears in their sequences. Both new tests are RED on current code (no
`gh pr view` call exists) and GREEN after the fix.

## Verification

- `npm run typecheck && npm run test && npm run lint && npm run build` — all green; the two new
  tests RED→GREEN.
- Rebuild `dist/ap.cjs` (a `src/` change) and commit it.
- `0.3.2 → 0.3.3` bump across `package.json` + both manifests (manifest-sync gate stays green).

## Delivery

One small PR off `main`: `fix(bridge): finish merges an already-open PR instead of pr-create-failed`.
After it lands, the `ap-bridge-finish-pr-quirk` memory can note the fix shipped in 0.3.3.
