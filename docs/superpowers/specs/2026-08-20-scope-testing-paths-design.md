# Scope gate honors Testing-section paths — design

**Date:** 2026-08-20
**Status:** approved (hub-authored; the 2026-08-20 forensics review's Cluster 1 — ~7 lifetime
occurrences of scope-check flagging files the design itself sanctioned)

## Problem

`implement scope-check` builds its declared set from the design doc's `## Components` section only
(`extractComponentsPaths`, `src/commands/implement.ts:376`). Designs routinely sanction test files
in `## Testing` prose instead ("extend `tests/job-worktree.test.ts`", "coverage in `tests/model/`"),
so those files flag OUT-OF-SCOPE and force an operator park on every such run: 9 OOS paths on one
xjp run were all named or implied by Testing bullets; 2 of 3 on another were the design-demanded new
test files; local runs hit the same class. The gate cries wolf on exactly the files a good design
tells the worker to write.

## Goal

Paths named in the design's `## Testing` section count as in-scope for the OOS match, with the same
matching semantics Components paths get. Components-only behavior everywhere else is unchanged: the
warn-only existence lint stays Components-only (Testing paths are usually files that do not exist
yet), and a design with no Testing section behaves exactly as today.

## Architecture

Generalize the existing walker rather than fork it: `componentsPathsByLine`
(`src/core/implementScope.ts`) becomes a section walker parameterized by its header/prefix regexes
(same TABLE_ROW / bullet / `pathTokensFrom` harvesting, identical semantics), with
`componentsPathsByLine` calling it with the Components regexes — byte-identical output for every
existing input — and a new exported `extractTestingPaths(docText)` calling it with `## Testing`
header regexes (accept the same H2 flexibility the Components regexes have; define
`TESTING_HEADER`/prefix constants beside the existing ones).

`scope-check` (`src/commands/implement.ts`) unions the two sets (deduped) for
`matchDiffAgainstComponents`, and:
- writes `testing-paths.txt` beside `components-paths.txt` (which keeps Components-only content);
- prints `SCOPE_DECLARED=<union count>` (the honest declared total; the guard no-op warn fires on
  union 0) plus a new `TESTING_DECLARED=<testing count>` line after it;
- `lintComponentsPaths` and every other caller of the Components extractor stay untouched.

`commands/implement.md`'s Stage 4 scope-check step: one sentence noting Testing-section paths count
as declared scope (so hubs stop hand-adjudicating this class), and the `SCOPE_DECLARED=0` no-op
wording still holds since it reads the union.

## Components

- `src/core/implementScope.ts` — parameterized section walker; `TESTING_HEADER` constants;
  `extractTestingPaths` export; `componentsPathsByLine` delegates.
- `src/commands/implement.ts` — scope-check unions testing paths; `testing-paths.txt`;
  `TESTING_DECLARED=` line.
- `commands/implement.md` — the one-sentence Stage 4 note.
- `tests/implement-scope.test.ts` (or the existing file covering implementScope — extend, never
  fork) — extractTestingPaths harvesting (bullets, prose-with-backticks, table rows, dir form);
  Components extraction byte-identical on a doc with both sections; union OOS behavior; a doc with
  no Testing section unchanged.
- `tests/implement-scope-check.test.ts` — verb-level: Testing-named file in the diff no longer OOS;
  `TESTING_DECLARED=` printed; `SCOPE_DECLARED=` counts the union; guard no-op on union 0.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — 0.5.44.
- `dist/ap.cjs` — rebuilt and committed.

## Testing

Extend the named test files with the cases above (fresh AP_HOME where state is touched; injected
runners, no live tmux). Full gate: `npm run typecheck`, `npm run lint`, `npm run test`,
`npm run build`.

## Success Criteria

- A design that names a test file only in `## Testing` no longer flags it OOS; the xjp 9-OOS shape
  (dir form `tests/rehearsal/` + named files) reproduced in a unit test comes back OOS_COUNT=0.
- Components extraction output is byte-identical to pre-change for every existing test input.
- `SCOPE_DECLARED=` reads the union, `TESTING_DECLARED=` is printed, `testing-paths.txt` written;
  no-Testing-section docs behave exactly as before.
- 0.5.44 across the three manifests; dist rebuilt; full suite green with the new coverage.
