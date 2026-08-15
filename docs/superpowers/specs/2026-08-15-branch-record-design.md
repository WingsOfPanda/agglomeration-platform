# The branch record: one name, one reader, and an honest `branch.txt` — design

**Date:** 2026-08-15 · **Origin:** the four-walk architecture review (walk 4, candidate 3) plus the
TWO deferrals A1's adversarial review reproduced. Wave C PR-1, the program's last. · **Scope:** one
PR (0.5.25). Carries behavior change #2 of the program's declared perimeter (below); everything else
byte-identical.

## What changed since the grilling

Grilling Q9 fixed the perimeter at exactly two behavior changes and deferred the second's shape:
"quick gains an intent record (default: adopt implement's `branch-mode.txt`) — exact placement
settled in C1's spec after I verify whether quick has any deliberate no-branch path."

**Verified: it has none.** `parseQuickArgs` (src/core/quick.ts) returns `{topicText, provider,
finish, stashWip}` — there is no `--no-branch` flag and `quick branch` always branches. So an intent
file would record a constant, and the fact actually missing is different and simpler:

> `quick branch` writes `branch.txt` with the INTENDED name even when the checkout failed
> (src/commands/quick.ts: `atomicWrite(join(exec,"branch.txt"), branch)` runs unconditionally;
> `if (!onBranch)` only warns). `implement` already records the branch it ACTUALLY ended on
> (`recorded` = the created/resumed branch, else the current one).

Recording the actual branch is therefore the whole fix, and it needs no new file. Adopting it
instead of an intent record is this spec's one deliberate divergence from the grilling default.

## Problem

1. **The stale-ref shape** (A1 review, reproduced on the shipped dist): a leftover
   `feat/quick-<topic>` from an earlier run passes A1's `hasDistinctBranch` guard, so finish pushes
   it and records `pr\tpr-opened` for a PR whose head ref contains **none of this run's commits**.
   The guard cannot tell "this run created the branch" from "a branch with that name exists".
2. **The same lie reaches the worker**: round-1's prompt is composed with
   `readField(branch.txt) || \`feat/quick-<topic>\`` and tells the worker "you are implementing on
   branch X" under BRANCH_DISCIPLINE ("you are already on the correct branch — do NOT checkout"),
   while HEAD is actually the start branch.
3. **Summary contradicts the refusal** (A1 review): after a `none\tno-branch` finish, `quick summary`
   still renders "Review the work: `git -C <target> checkout feat/quick-<topic>`" for a branch that
   does not exist. `SummaryFacts` carries no finish outcome, though bridge's summary already reads
   `finish-result.txt`.
4. **The branch name is spelled in six code sites and two directives** (this spec said five and
   missed quick's finish recover line, `git checkout -b ${branch || \`feat/quick-${topic}\`}`); the
   READ side is four different shapes (`readField` triples for quick/bridge, `branchMapField` over
   `implement-branches.tsv`, `kvField` over `baselines/<slug>.tsv`), so every consumer needs its own
   parser.

## Goal

One place computes a run's branch name; one accessor answers "what branch, from what start branch,
at what base sha" for all three commands; `quick`'s record tells the truth about what happened; and
the two A1 deferrals close. The frozen filenames and layouts are untouched.

## Architecture

**Deliberately NOT a write-side abstraction.** The deletion test says the READERS concentrate and
the writers do not: implement's per-slug TSV rows and quick/bridge's single-line files are three
genuinely different on-disk layouts that a shared writer would only re-spread through adapters.
So:

- **`src/core/branchRecord.ts`** (new):
  - `branchNameFor(command: "quick" | "implement" | "bridge", topic: string): string` — the one
    place `feat/<command>-<topic>` is spelled. All six current spellings (quick.ts's `branch`, its
    fallback in turn-send and its finish recover line, bridge.ts's branch + its `feat/bridge-`
    occupancy prefix — the prefix is `branchNameFor("bridge", "")` — and implement's `defaultBranch`)
    call it.
  - `readBranchRecord(command, ctx): { startBranch: string; baseSha: string; branch: string; mode:
    "branch" | "no-branch" | "in-place" }` — ONE reader with a thin per-command source map
    (quick/bridge: the three `execute/` files + bridge's `mode.txt`; implement: `branchMapField` +
    `kvField` + `branch-base.sha` + `branch-mode.txt`). Every field is the raw record, "" when
    absent: consumers keep wording their own defaults (`"main"`, `"unknown"`, `"(none)"`).
    **`ctx` is `{ dir, slug? }`, not `{ topic }`** — implement's art dir is opts-dependent
    (`implementArtDir(topic, opts)`) and its record is per-slug, while `applyFinish` holds an `art`
    path rather than the topic, so the caller passes the state dir it already has; TS overloads make
    `slug` required for implement. That also keeps `core/branchRecord.ts` importing nothing from
    `commands/*`, which is why **`branchMapField` moves into it** (it was private to implement.ts and
    has no other caller once `applyFinish` asks the record) and `readBranchMode` folds into `mode`.
    `kvField` stays in `core/fsread.ts`.
    Consumers are the three finishes and the three summaries. **`implement scope-check` is NOT one**:
    it holds no slug (it reads art-level `target_cwd.txt` + `branch-base.sha`) and needs `existsSync`
    on both for its own error path, so its single `readField(branch-base.sha)` — already exactly what
    the record would return — stays.
- **`quick branch` records the ACTUAL branch** (the behavior change): write `branch.txt` with the
  branch the run ended on — the created/resumed `feat/quick-<topic>` on success, the current branch
  when `createOrResumeBranch` returns false — mirroring implement's `recorded`. The existing warn
  line stays. Consequences, all wanted and all covered by A1's shipped guard:
  - a failed checkout now makes `branch === startBranch`, so A1's finish guard refuses with
    `none\tno-branch` + its flag instead of pushing a stale ref;
  - round-1's prompt names the branch the worker is really on;
  - `quick summary`'s Branch line reports reality;
  - that refusal's recover line follows it: it names a branch to CREATE, so a record that IS the
    start branch falls back to the topic-derived name (`git checkout -b main` while on main is a dead
    end). Not in the original draft; added because this change is what routes runs into that line.
  - `quick branch`'s trailing `log.ok` still names the INTENDED branch on a failed checkout — the
    warn line immediately above it already names both, and changing it is a third user-visible change.
- **`bridge branch` keeps the same lie, deliberately.** It also writes the intended name when
  `createOrResumeBranch` fails, and its finish reaches the same `hasDistinctBranch` guard through
  `finishBranchPrMerge`, so it carries the same stale-ref exposure. Fixing it would be a third
  behavior change, outside the program's declared perimeter — follow-up, not this PR.
- **`quick summary` consumes the finish record**: `SummaryFacts` gains `finishResult` (read from
  `execute/finish-result.txt` exactly as bridge does), and the "Review the work: checkout <branch>"
  hint is suppressed/replaced when the outcome is `no-branch`. Renderer change only; no new file.

## Components

- `src/core/branchRecord.ts` (new) · `src/commands/quick.ts` (actual-branch record; summary facts) ·
  `src/core/quick.ts` (`renderSummary` hint) · `src/commands/{bridge,implement}.ts` +
  `src/core/gitwork.ts` (name spellings → `branchNameFor`; `createOrResumeBranch`'s doc comment
  currently says "Create feat/quick-<topic>" though implement and bridge are its other two callers —
  fix the comment).
- `commands/quick.md` — one line: `branch.txt` records the branch the run is actually on, so a failed
  checkout ends in the `no-branch` refusal rather than a PR containing none of the run's work.
- `tests/` — see Testing. Version 0.5.24 → 0.5.25 (three manifests) + rebuilt committed dist.

## Testing

- **Red-green for the behavior change**: with `createOrResumeBranch` failing, assert `branch.txt`
  holds the START branch (not the intended name), then that `finishWith` records `none\tno-branch`
  with zero pushes — and that the same fixture on the pre-change code pushes a ref. Must fail before.
- **The stale-ref shape specifically**: a pre-existing `feat/quick-<topic>` from an earlier run + a
  failed checkout for THIS run → refusal, not `pr-opened` (the exact A1-review reproduction).
- Round-1 prompt names the recorded branch; `quick summary` after a `no-branch` finish omits the
  checkout hint and reports the real branch.
- `branchNameFor`: every call site returns byte-identical names to today (pin all six, plus the
  empty-topic prefix bridge's single-occupancy check matches on).
- `readBranchRecord`: the three commands' shapes, including implement's per-slug rows, a missing
  file, and `(detached)`.
- ALL existing quick/bridge/implement suites pass; assertions may change ONLY where they pin the old
  intended-name-on-failure behavior — list every such edit in the report.
- Full gate green; dist rebuilt+committed. The E2E replaying the stale-ref shape through the built
  dist is a MANUAL verification, not a committed test — this suite spawns no real git repos, and
  `tests/dist-fresh.test.ts` already pins `dist/ap.cjs` to a fresh build of `src`.

## Success Criteria

- A quick run whose checkout failed can no longer produce a PR that contains none of its work — the
  A1 guard is now sufficient because the record it reads is honest.
- `grep -rn 'feat/quick-\|feat/implement-\|feat/bridge-' src/` returns no CODE spelling — only three
  prose comments (quick.ts's and implement.ts's explanations of the leftover-branch shape, plus
  implement.ts's rebrand lineage note), left as prose. `branchNameFor` does not match the grep either:
  it composes `feat/${command}-${topic}`.
- Gate green; 0.5.25; the program's declared perimeter closes at exactly two behavior changes.
