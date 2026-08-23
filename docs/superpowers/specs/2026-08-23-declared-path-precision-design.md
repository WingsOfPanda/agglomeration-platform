# Declared-path precision: report the unresolved, narrow nothing (PR F)

Date: 2026-08-23. Deferred from `2026-08-23-brief-path-correctness-design.md` (PR #151), which
recorded the defect and explicitly declined to fix it there.

## Problem

The 0.5.44 field run reported `TESTING_DECLARED=10` when only 5 of those tokens were test files. The
other five — `Spec/metrics`, `value_range/aux_shape`, `elif/raise`, `loss/grad`, `D15/D16/D17` —
are slash-bearing PROSE that `pathTokensFrom` (`src/core/implementScope.ts`) admits because it keeps
any token containing `/`. The number a human adjudicates the Stage 4 scope gate against was 100%
inflated.

## Goal

The count a human weighs is honest about how much of it is resolvable, without changing which paths
are declared, which are in scope, or any rc.

## Architecture

**Narrow nothing.** The tempting fix — filter the extractor — is the one whose failure mode points
the wrong way, and the corpus says it buys nothing:

- `matchDiffAgainstComponents` (`src/core/implementScope.ts`) is a pure elementwise existential OR
  with no cross-element state, so removing a declaration can only ever move a path from in-scope to
  OUT-of-scope: a passing check turned failing. Measured by a 200,000-trial randomized fuzz:
  removal increased OOS 12,439 times and decreased it **0** times.
- The fragments are inert. Across all 206 tracked `.md` files, extraction yields 227 distinct
  extension-less/slash-less ("dir-form") tokens; **0** are real directories and **0** equal or
  dir-prefix any of the 437 tracked files. Over docs/superpowers/specs alone: 788 declared tokens,
  152 dir-form (137 distinct), 0 on disk.
- A flip search — every doc's declared set vs the `fileShaped`-narrowed set, over a candidate diff
  universe of all 437 tracked files plus every file-shaped token declared in the same doc — found
  **0** paths that change scope.
- And narrowing would be safe only by CORPUS COINCIDENCE, not by contract: a bare `src/core` is a
  legal declaration under the implicit-directory rule, shape-identical to `Spec/metrics`. Every
  genuine directory declaration in the corpus (`src/`, `src/core/`, `tests/`, `config/`,
  `.ap/worktrees/`) already carries a trailing `/` — today. Nothing makes that true tomorrow.

So `scope-check` keeps its declared set, its matcher input, its OOS set and its rc **byte-identical**
and additionally reports what it could not resolve:

- `SCOPE_UNRESOLVED=<n>` / `TESTING_UNRESOLVED=<n>` on stdout, after the existing KV lines.
- `scope-unresolved.txt` in the art dir, one token per line in declaration order — the layer records
  its own verdict, because stdout is gone once the hub's turn ends.

"Unresolved" = declared but naming neither a file (a `.ext`) nor an explicit directory (a trailing
`/`), reusing the existing `fileShaped` predicate so the C3 bullet counter and this report share ONE
definition of "names a file".

The known false positive is pinned, not hidden: a legitimate bare `src/core` is reported unresolved,
and the test asserts that it is — because the alternative is a report that quietly disagrees with
the matcher.

**One additional guard, whose effect today is provably nil.** 62 of the trailing-slash declarations
in this repo's specs are the bare token `/`. It is inert only because `git diff --name-only` emits
repo-relative paths; under the explicit-directory rule an absolute-path diff would put the ENTIRE
diff in scope — a scope gate that silently opens. A bare `/` is never a meaningful declaration, so
it is dropped at extraction. Dropping a declaration is the safe direction (it can only add OOS), and
it removes zero in-scope paths today because no repo-relative path starts with `/`.

## Rejected (with the measurement that kills each)

- **Existence-based discriminator** (dir-form counts only if it is a real directory in the target):
  its only advantage is preserving bare `src/core`, and that instance set is EMPTY (0 of 788). Its
  kept set is a strict superset of the shape rule's, so it cannot flip fewer verdicts than a rule
  that already flips zero. It also makes the verdict irreproducible from `design.md` + the diff
  alone — the exact pair a human weighs at the Stage 4 question — and opens a trapdoor: declare
  `src/legacy` for a design that DELETES it, and at check time the token vanishes and every deleted
  path goes OOS, with nothing in the artifacts explaining why.
- **A warn on every ambiguous token**: fires on 45 of 78 design docs with an actionable rate of
  zero, against this repo's own standard ("a warning that fires every run is a warning nobody
  reads"). Worse, the only way an author can silence it on `refs/heads/x` or `done/idle` is to
  append a trailing `/` — manufacturing the first legitimate-looking directory declaration and
  destroying the very corpus property that makes any future narrowing safe.
- **Narrowing the extractor at all**: see Architecture. Revisit only with a stated authoring
  contract, and only if the corpus stops being 0-for-137.

## Components

- `src/core/implementScope.ts` — export `fileShaped`; new `unresolvedDeclaredPaths(declared)`;
  drop a bare `/` token in `pathTokensFrom`.
- `src/commands/implement.ts` — `scopeCheckWith`: emit `SCOPE_UNRESOLVED=`/`TESTING_UNRESOLVED=`,
  write `scope-unresolved.txt`. The `declaredPaths` value handed to the matcher is untouched.
- `commands/implement.md` — Stage 4: read the two counts when weighing `OOS_COUNT`; a high
  unresolved share means the declared number is prose, not scope.
- `tests/implement-scope.test.ts`, `tests/implement-scope-check.test.ts`.
- `dist/ap.cjs` — rebuilt and committed.

## Testing

- `tests/implement-scope-check.test.ts` — a design declaring bare `src/core` in Components and
  mixing `tests/model/test_d19_temporal_graph.py` with the verbatim fragments `Spec/metrics` and
  `elif/raise` in Testing; diff = `src/core/x.ts` + the test file. Assert: (a) `OOS_COUNT=0` and an
  empty `scope-out-of-scope.txt`; (b) `SCOPE_DECLARED=`/`TESTING_DECLARED=` byte-identical to
  today's values; (c) `TESTING_UNRESOLVED=2`, `SCOPE_UNRESOLVED=1`; (d) `scope-unresolved.txt`
  lists the tokens in declaration order, INCLUDING `src/core` — pinning the known false positive.
- **THE DECISIVE MUTATION** (must turn that test red): promote the report into the verdict by
  passing `declaredPaths.filter(fileShaped)` to the matcher. On this fixture `OOS` goes
  `[]` -> `["src/core/x.ts"]`, flipping `OOS_COUNT` 0 -> 1. This is the standing guard against a
  future contributor doing exactly that, and it is why the fixture declares a bare `src/core` even
  though the corpus contains none.
- **Second mutation** (the counter is real, not decoration): weaken `unresolvedDeclaredPaths` to
  reuse `pathTokensFrom`'s admission rule (`!HAS_SLASH && !ENDS_WITH_EXT`) instead of `fileShaped`
  — the exact mistake the C3 counter already documents — and the fragment counts collapse to 0.
- `tests/implement-scope.test.ts` — a bare `/` token is not declared; a real trailing-slash
  directory (`src/`) still is. Mutation: keep `/` -> the first assertion goes red.
- Non-regression: every existing scope-check assertion stays green UNCHANGED. If an existing
  expectation needs editing, the change has touched the verdict and is wrong.

## Success Criteria

- `scope-check` stdout gains two counts and the art dir gains one file; `OOS_COUNT`, `OOS_PATH`,
  `SCOPE_DECLARED`, `TESTING_DECLARED`, `scope-out-of-scope.txt` and the rc are unchanged for every
  existing fixture.
- Re-running the field doc reports `TESTING_DECLARED=16` with `TESTING_UNRESOLVED=1` rather than a
  bare inflated count.
- `npm run typecheck && npm test && npm run lint && npm run build` green; `dist/ap.cjs` committed.
