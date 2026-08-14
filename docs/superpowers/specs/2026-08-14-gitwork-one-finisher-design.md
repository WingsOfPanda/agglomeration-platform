# One finisher in gitwork + the quick finish guard — design

**Date:** 2026-08-14 · **Origin:** the four-walk architecture review (candidate 3 "one finish
concept, three finishers" + the gitwork frictions + candidate 12's Runner dedup), Wave A PR-1 of
the deepening program agreed by grilling. · **Scope:** one PR (0.5.18), three ordered commits.
The ONLY behavior change in this PR is commit 1's quick finish guard; commits 2-3 are
byte-identical concentrations.

## Problem

`src/core/gitwork.ts` exports three finishers that share one algorithm (guard → act → restore the
start branch) but each spell it again:

- The distinct-branch invariant exists in four spellings: exported as `hasDistinctBranch`
  (gitwork.ts:194), called inside `finishBranchAction` (gitwork.ts:202), hand-inlined negated
  inside `finishBranchPrMerge` (gitwork.ts:239-241), and called again by implement's `applyFinish`
  pre-classification (implement.ts:472). **quick's `finishBranch` (gitwork.ts:164) is the one
  finisher with no guard at all**: `finishWith` (quick.ts:318) reads `branch.txt` — written with
  the intended name even when the checkout failed (quick.ts:164-165 only warns) — and goes
  straight to `git push -q -u origin <branch>` (gitwork.ts:171). A missing ref makes the push fail
  and the run records `pr-failed-kept`, a PR problem, when the truth is there was never a branch
  to act on.
- The push + `gh pr create` step is written twice byte-alike (gitwork.ts:171-182 vs :212-218,
  differing only in the default title prefix) and a third time inside bridge's superset flow
  (gitwork.ts:254-273 — push-failure semantics, existing-PR fallback, merge + ff-pull), which is
  legitimately different and keeps its own outcomes.
- The outcome vocabulary (16 gitwork strings plus the record-only strings the commands invent:
  `same-branch`, `branch-only (kept …)`, `in-place (commits on the current branch)`,
  `stash-wip-kept`) has no owner; its meaning is re-explained in prose in three directives.

Riders, same files, same review cycle:

- `stashPush`'s proof-of-park rule ("which outcomes mean work IS parked, so write the marker") is
  re-derived by its only caller as `st.outcome !== "none" && st.outcome !== "failed"`
  (quick.ts:153) — a sixth outcome added in gitwork would be silently misclassified in quick.
- `stashPopByMessage`'s HEAD precondition (the one mistake nothing can undo: popping onto the
  wrong branch) lives in the caller (quick.ts:288-293), not the callee.
- `implementQuestions.ts:9-10` re-declares `RunResult`/`QuestionRunner` byte-identical to
  gitwork's `RunResult`/`Runner` (gitwork.ts:4-5), and interleaves the WIRED question codec
  (percentEncode/percentDecode/parseQuestionPayload/validateQuestionLine/extractQuestionPayload)
  with the deliberately-unwired claim verifier (`verifyClaim`/`formatReply`, adjudicated parked
  2026-07-06 — kept, never deleted).

## Goal

One deep finisher owns guard → act → restore and the outcome vocabulary; the three current
exports survive as thin byte-identical wrappers; quick's finish refuses loudly instead of pushing
a ref that was never created; the three rider invariants move into the modules that own them.
Everything except commit 1 is provably behavior-preserving: same git call sequences, same
outcome strings, same on-disk records, same log lines.

## Architecture

### Commit 1 — the quick finish guard (THE behavior change, sanctioned by the grilling perimeter)

In `finishWith` (src/commands/quick.ts:318), on the `doFinish` path only, before calling
`finishBranch`:

```ts
if (!hasDistinctBranch(r, branch, startBranch)) { …refuse… }
```

The refusal: `log.error` naming the recorded branch and the start branch and that NOTHING was
pushed; best-effort `git checkout -q <startBranch>`; `restoreStashWip` exactly as today; write
`finish-result.txt` as `none\tno-branch\n` + the kept line (reusing implement's `no-branch`
outcome string and bridge's `none` action precedent — one union, one meaning); and
`runFlag("quick", topic, "finish-no-branch: …")` so the refusal reaches /ap:review (the same
pattern as implement's `same-branch` flag, implement.ts:492). Return 0 — the refusal is a
recorded outcome, not a crash. The `doFinish === no` path is unchanged.

Red-green: the regression test drives `finishWith` with a fake runner whose `show-ref` fails and
asserts ZERO `push`/`gh` calls were issued plus the `none\tno-branch` record; it must fail
against the pre-commit-1 code.

Known residual, deliberately out of scope here: a STALE `feat/quick-<topic>` ref surviving from
an earlier run passes this guard (it exists and is distinct) even though this run's checkout
failed. Telling that apart needs the intent record — Wave C's `branchRecord` PR (C1) owns it;
noted there.

### Commit 2 — the collapse (byte-identical)

**`finishWork(r, o)`** — new function in gitwork.ts, the one deep finisher:

```ts
o: { branch: string; base: string;
     action: "auto" | "merge" | "pr" | "keep" | "discard" | "pr-merge";
     hasGh: boolean; originUrl?: string; title?: string; body?: string;
     titlePrefix: string /* default-title branding: "quick" | "implement" | "bridge" */ }
→ { action: string; outcome: string }
```

*Amended at build (2026-08-14): `titlePrefix` ships REQUIRED, not optional.* Optional needs a
fallback, and there is no single right one — the historical default is `quick` for the `auto` arm,
`implement` for the explicit `pr` arm and `bridge` for `pr-merge`, so any one default silently
mislabels two callers' PRs. All three wrappers pass it, so requiring it costs a word and removes
the trap.

Internals, each spelled once:

- **Guard first**: `hasDistinctBranch(r, o.branch, o.base)` — on failure return
  `{action: "none", outcome: "no-branch"}` (the `pr-merge` arm's current shape;
  wrappers map it to their historical return forms).
- **`pushAndPr` (private)**: the push → remote get-url → gh pr create → outcome triple
  (`pr-opened` / `pr-pushed-no-gh` / `pr-failed-kept`), used by the `auto`-resolved `pr` arm and
  the explicit `pr` arm; default title from `titlePrefix`.
- **`auto`** resolves via `finishAutoAction` then runs the `keep`/`pr` arm (quick's current
  semantics: keep restores + `kept`).
- **`merge` / `keep` / `discard`** — finishBranchAction's arms verbatim.
- **`pr-merge`** — finishBranchPrMerge's flow verbatim (its push-failure/`pushed-no-gh`/
  existing-PR-fallback/merge/ff-pull outcomes are a superset the shared `pushAndPr` must NOT
  absorb — different strings, different semantics).
- **Restore start branch** on every arm exactly where each finisher restores today. The git call
  SEQUENCE per arm must be identical to today's (the fake-runner tables pin call order): the only
  sequence change in this PR is commit 1's added `show-ref` on quick's path.

*Amended at build: quick's finish path ends up with TWO `show-ref` probes, not one.* Commit 1 guards
at the command level (quick.ts, so the refusal can write quick's record and flag) and commit 2's
`finishWork` guards inside `finishBranch` — the same read-only probe, run twice on the healthy path,
never on the refusing one. Deduplicating it would mean either a guardless finisher or a command that
cannot word its own refusal; the second probe is the cheaper price. The claim above should read: the
only sequence change is the added `show-ref` on quick's path, which the collapse then issues twice.
The interleaving is safe: if the ref vanishes BETWEEN the two probes, `finishWork` returns
`no-branch` without performing its restore checkout, and quick's record reads `none  no-branch`
while `restoreStashWip` — which proves HEAD rather than assuming it — sees `wrong-head`, keeps the
stash, and flags it.

**Wrappers** (the current three exports, byte-identical to callers):

- `finishBranch(r, FinishOpts)` → `finishWork(action: "auto", titlePrefix: "quick")`, mapping the
  guard refusal to `{action: "none", outcome: "no-branch"}` (commit 1's shape — `FinishResult.action`
  widens to `"pr" | "keep" | "none"`).
- `finishBranchAction(r, FinishActionOpts)` → string returns exactly as today (`no-branch` on
  guard, arm outcome otherwise).
- `finishBranchPrMerge(r, PrMergeOpts)` → `{action, outcome}` exactly as today; its inline guard
  is REPLACED by the shared one (identical git probe: one `show-ref --verify --quiet`). *Amended at
  build:* `finishWork` returns the eight-action union, so this wrapper narrows `action` back to
  bridge's four with a single commented assertion — the pr-merge arm provably returns only those.

**`hasDistinctBranch` STAYS exported** — a deliberate revision of the review's suggestion:
implement's `applyFinish` (implement.ts:454-477) legitimately pre-classifies with its own
command wording and distinct outcomes (`no-branch` from branch-mode, `same-branch` for detached
baseline and non-distinct branch, each with recovery-instruction warns). That is command policy,
not finisher mechanics; folding it into gitwork as an option used by one caller would relocate,
not concentrate. implement.ts is untouched by this PR beyond the type import if needed.

**The outcome union**: export `type FinishOutcome` in gitwork.ts enumerating every string the
finishers produce, with a doc comment listing the record-only strings the commands add
(`same-branch`, `branch-only (kept …)`, `in-place (commits on the current branch)`,
`stash-wip-kept`) and pointing at the directives. `commands/quick.md` gains one line documenting
the new `no-branch` refusal (what it means, how to recover: re-run `quick branch`, then finish).
`implement.md`/`bridge.md` prose is already correct and unchanged.

### Commit 3 — the riders (byte-identical)

- **`StashPushResult.entryExists: boolean`** — set inside `stashPush`: true exactly when this
  push left an entry to restore (`outcome !== "none" && outcome !== "failed"` — i.e. `parked`,
  `partial`, `failed-with-entry`). quick.ts:153's marker rule becomes `if (st.entryExists)`.
  The rule now lives beside the five-way outcome decision it derives from.
- **`stashPopOnBranch(r, message, expectSha, requiredBranch)`** — new export wrapping
  `stashPopByMessage`: probes `currentBranch(r)`; when it differs from `requiredBranch` returns
  `{outcome: "wrong-head", head}` WITHOUT touching the stash; otherwise
  `{outcome: stashPopByMessage(...), head}`. `stashPopByMessage` itself is unchanged (the
  hasDistinctBranch-extraction precedent: new wrapper, old export byte-stable). quick's
  `restoreStashWip` (quick.ts:274-316) calls the wrapper; its `wrong-head` arm carries the
  exact current warn lines (using the returned `head`, `(detached)` for "").
- **`src/core/questionCodec.ts`** — new module holding the WIRED codec: `percentDecode`,
  `percentEncode`, `parseQuestionPayload`, `validateQuestionLine`, `extractQuestionPayload`, and
  the `ClaimKind`/`ClaimRoute`/`QuestionPayload` types. `implementQuestions.ts` keeps
  `verifyClaim`/`formatReply`/`VerifyResult` under a file header stating the subsystem is
  UNWIRED BY DECISION (2026-07-06 adjudication — placement only, never deletion), imports the
  codec types it needs from the new module (*amended at build:* it needs none — `verifyClaim` and
  `formatReply` take plain strings — so it imports only `Runner`), and imports `Runner` as a type from
  `gitwork.js` instead of re-declaring them (`QuestionRunner` disappears; the parked
  `verifyClaim(kind, value, runner?: Runner)` signature is shape-identical). implement.ts:21 and
  the tests update their imports; no compatibility re-exports (internal module, the bundle is the
  only consumer).

## Components

- `src/core/gitwork.ts` — `finishWork` + `pushAndPr` + `FinishOutcome` + wrappers +
  `entryExists` + `stashPopOnBranch`.
- `src/commands/quick.ts` — commit 1 guard in `finishWith`; `restoreStashWip` via
  `stashPopOnBranch`; marker rule via `entryExists`.
- `src/core/questionCodec.ts` (new) + `src/core/implementQuestions.ts` (parked header, shared
  Runner) + `src/commands/implement.ts` (codec import path only).
- `commands/quick.md` — one line: the `no-branch` finish refusal.
- `tests/` — see Testing. Version 0.5.17 → 0.5.18 (three manifests) + rebuilt committed
  `dist/ap.cjs`.

## Testing

- **Commit-1 red-green**: fake runner, `show-ref` fails → zero push/gh calls, record
  `none\tno-branch\n`, hub flag recorded; `branch === startBranch` → same; healthy distinct
  branch → the existing finish tests pass unchanged. Must fail pre-commit-1.
- **Wrapper byte-stability**: the existing three tables (tests/implement-gitwork.test.ts,
  tests/gitwork-prmerge.test.ts, tests/quick-gitwork.test.ts) pass with NO assertion edits — they
  are the frozen pins, including git call ORDER via the scripted fake runners. A new
  `finishWork` table covers the deep interface once (guard × arms × pr outcomes). *Amended at build:
  holds exactly as written for every finisher row; the one exception is commit 3's `entryExists`
  field on quick-gitwork.test.ts's `stashPush` rows — see that bullet.*
- **Mutation rule** (program-wide, from grilling Q10): a wrapper re-pointed at a body that
  DIVERGES from `finishWork` — in `base`, `action`, `titlePrefix`, or arm order — must fail at
  least one test; reviewers verify by mutation. *Amended at build (adversarial review): stated as
  "restoring a hand-rolled body" this rule was unsatisfiable.* A hand-rolled body that is
  byte-identical in behavior to what `finishWork` does is undetectable BY CONSTRUCTION for a
  behavior-preserving collapse — no test can distinguish two implementations that issue the same
  git calls and return the same strings — and that undetectability is the evidence FOR the
  collapse, not a hole in the pins. What must be caught is DIVERGENCE, which is what the
  divergence form above asks for and what the default-title rows added at build now cover
  (`titlePrefix` mutations on quick's and bridge's wrappers each fail a test).
- **entryExists**: pinned across all five outcomes; quick's marker tests unchanged. *Amended at
  build: this is the ONE place an existing assertion had to change.* `stashPush`'s nine rows in
  tests/quick-gitwork.test.ts assert the whole result with `toEqual({outcome, sha})`, and no new
  field can be added to that object without them failing — so each row gained `entryExists: <bool>`,
  which IS the "pinned across all five outcomes" this bullet asks for. Strictly additive: no existing
  expectation was relaxed, and the finisher assertions in the same file were not touched. The
  byte-stability rule above therefore covers the three tables' FINISHER rows; the stash rows in
  quick-gitwork.test.ts are commit 3's, and a field addition is the one edit it sanctions.
- **stashPopOnBranch**: wrong-head (named branch + detached), pass-through of all five pop
  outcomes; quick's restore tests (tests/quick-cmd.test.ts:547-563 region) pass with the warn
  wording unchanged.
- **Codec split**: question/codec tests pass with updated imports; `grep -rn "QuestionRunner"
  src/` is empty; one `Runner` interface in core.
- Full gate green (`typecheck`/`lint`/`test`/`build`); dist rebuilt and committed.

## Success Criteria

- Replaying the field shape (branch checkout failed at `quick branch`, finish=yes) through the
  built dist refuses with `none\tno-branch`, a flag, and zero pushes — no `pr-failed-kept` lie.
- All pre-existing finisher/stash/question tests pass without assertion edits (*amended at build:*
  except the additive `entryExists` field on `stashPush`'s rows — see Testing); the DIVERGENCE
  mutation checks hold (*amended at build:* identity mutations are undetectable by construction —
  see the Mutation rule); outcome strings and git call sequences are byte-identical everywhere
  except the sanctioned commit-1 path.
- One finisher, one guard, one push+PR step, one Runner interface, one outcome vocabulary owner.
- Gate green; dist rebuilt+committed; 0.5.18.
