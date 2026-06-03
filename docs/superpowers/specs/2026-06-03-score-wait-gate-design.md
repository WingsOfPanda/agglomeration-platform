# score wait-gate — mechanically gate the ensemble on ALL N parts finishing

**Status:** approved approach (option b: faithful prose restoration + mechanical gate), spec for review (2026-06-03)

## Problem

In `/consort:score`'s escalation path (a 2–3 part ensemble), the Maestro proceeds past the
research-wait stage (and the cross-verify stage) when **only one part has finished**, while the
other part(s) are still working. Observed symptom: "codex is still researching while the Maestro
already started the next step."

### Root cause (confirmed)

The CLI is correct: `score research-wait <TOPIC> <INST> <PROV>` blocks on **one** part's outbox
until it emits `done`/`error`/`question`, then writes `research-<INST>.done` and appends an `FS=`
line (`src/commands/score.ts:271-296`). The Maestro launches **N** of these in the background, one
per part (`commands/score.md:143-147`).

The defect is in the orchestration prose. clone-wars' `consult.md` Step 5 (the behavioral spec)
gated "all N done" three explicit ways:

1. an expectation — "you will receive `N` notifications total, one per trooper";
2. an until-all loop — "**continue handling notifications until all `N` ... state files show a
   terminal `FS`**; `FS=question` is transient — only proceed when every trooper is terminal";
3. a structural TodoWrite-task gate — mark task 5 `completed` only when all N are terminal.

consort's `score.md` compressed all of that into a single trailing clause:
`Stage 5` line 169 "**Proceed only when every part is terminal (no `FS=question` outstanding)**"
(and the identical `Stage 8` line 207 for verify). The harness re-invokes the Maestro on the
**first** part's completion notification; reading that part's `FS=ok` ("terminal; findings.md
exists") it sees the weak gate satisfied — the "no `FS=question` outstanding" framing reads as a
question-relay condition, not an all-N-completion condition — and advances to the diff while other
parts are still running. It is intermittent because it depends on whether the Maestro happens to
wait for the remaining notifications. This is a faithful-port regression, confined to
`commands/score.md`, affecting **two** sites: Stage 5 (research wait) and Stage 8 (verify wait).

## Goal

Make "advance only when all N parts are terminal" **mechanical and race-proof**, not dependent on
the Maestro's judgment — at both the research-wait and verify-wait stage boundaries — while also
restoring clone-wars' explicit prose so the intent is unambiguous.

## Design

Two complementary parts.

### Part 1 — new mechanical gate verb

`$CS score wait-gate <TOPIC> <phase>` where `phase ∈ {research, verify}` (the same phase argument
convention already used by `score offset-reset <topic> <instrument> <phase>`).

Behavior:

1. Resolve the art dir (`scoreArtDir(topic)`); read `$ART/roster.txt` and parse the N parts via the
   existing `parseRosterFile`. For `phase=verify` this is the **diff roster** (the prose rewrites
   `roster.txt` to the diff roster before Stage 6), which is exactly the set that should be gated in
   Stage 8.
2. For each part, compute a status from its **frozen** per-phase state files:
   - state file `<phase>-<INST>.txt`, done marker `<phase>-<INST>.done`,
   - status key is `FS=` for `research`, `VS=` for `verify`; read the **last** such line,
   - **`terminal`** iff `<phase>-<INST>.done` exists AND a last status line is present AND its value
     is not `question`,
   - **`question`** iff the last status line's value is `question` (transient — still needs a relay),
   - **`pending`** otherwise (no `.done` yet, or `.done` present but no status line) — i.e. the part
     is still running or mid-flight.
   This "`question` is the only transient; everything else with a `.done` is terminal" rule is
   phase-agnostic, so one verb serves both stages. It deliberately does NOT enumerate the specific
   terminal values (`ok`/`empty`/`malformed`/`failed`/`timeout`/`skipped`/`missing`) — any non-question
   value paired with a `.done` is terminal, which is forward-compatible with the existing
   `researchState`/`verifyState` value sets.
3. Print one line per part `<INST>\t<terminal|question|pending>` to stdout (the `walk-state` output
   idiom).
4. Exit code:
   - **rc 0** iff every part is `terminal`,
   - **rc 1** if any part is `pending` or `question`,
   - **rc 2** for usage errors: missing `<topic>`/`<phase>`, `phase` not in `{research, verify}`,
     missing art dir, or missing/empty `roster.txt`.

The verb is purely a **readiness check** — it never relays questions, sends, or waits. The
question-relay loop stays in the prose; a `question` part simply keeps the gate at rc 1 until the
Maestro relays and the re-armed wait turns it terminal.

### Part 2 — prose restoration (`commands/score.md`)

**Stage 5 (research wait)** and **Stage 8 (verify wait)** each regain the explicit clone-wars gate,
now anchored on the mechanical verb. Replace the single weak "Proceed only when every part is
terminal" clause with wording to the effect of:

> You launched **N** background waits — expect **N** completion notifications, one per part. On each,
> handle that part (relaying any `FS=question`/`VS=question` per the loop above, which re-arms it).
> **Before proceeding, run `$CS score wait-gate <TOPIC> research`** (Stage 8: `... verify`). It prints
> `<INST>\t<terminal|question|pending>` per part and **exits 0 only when every part is terminal**.
> rc 1 means at least one part is still `pending` (working) or `question` (needs a relay) — do NOT
> proceed; keep handling notifications / relay, then re-run the gate. Only on **rc 0** continue
> (build the diff roster / proceed to adjudication).

The downstream logic is unchanged (diff-roster construction, the `<2 parts → abort` rule, the
`roster.txt` rewrite to the diff roster).

## Components (isolation + testability)

- **`src/core/scoreTurn.ts`** — new pure helper
  `gateState(art: string, phase: "research" | "verify", rows: RosterRow[]): Array<{ instrument: string; status: "terminal" | "question" | "pending" }>`.
  Pure file reads only (no IPC, no tmux); unit-tested by seeding a temp art dir with `.txt`/`.done`
  files. This holds the status logic; the verb is a thin wrapper.
- **`src/commands/score.ts`** — `waitGateRun(rest)`: validate args, read+parse roster, call
  `gateState`, print the lines, return rc per the rules. Wire into the dispatch switch and the
  `usage()` string.
- **`commands/score.md`** — Stage 5 + Stage 8 prose.
- **Tests** — `gateState`: all-terminal → all `terminal` (verb rc 0); one part `.done` missing →
  `pending` (rc 1); one part last line `FS=question` → `question` (rc 1); a part with `FS=ok` but a
  later re-armed `FS=question` → `question` (last-line wins); mixed research vs verify key (`FS` vs
  `VS`). `waitGateRun`: bad/absent phase → rc 2; missing roster → rc 2.

## Error handling

- Usage/precondition failures → rc 2 with a `score wait-gate: ...` stderr message (consistent with
  sibling verbs); never write to stdout on rc 2 except the per-part lines are simply omitted.
- A part directory or state file that does not yet exist is treated as `pending` (not an error) —
  the gate is meant to be polled while waits are in flight.

## Frozen-protocol / parity safety

- The gate **reads** frozen state filenames (`<phase>-<INST>.txt`, `<phase>-<INST>.done`) read-only;
  it renames/creates nothing on the wire.
- It is a new **internal conductor verb** (CLI plumbing), not a provider and not part of the frozen
  event/JSON/sentinel protocol. Adding it does not touch `contracts.yaml` or any frozen token.
- No banned token (`clone-wars`/`cw_`/`master-yoda`/`MISSION ACCOMPLISHED`/`@cw_`) is introduced; the
  stale-token gate is unaffected.
- The prose change restores clone-wars behavior (parity-positive), and the mechanical verb is the
  strengthening that option (b) asked for.

## Acceptance criteria

1. `score wait-gate <TOPIC> research` and `... verify` exist, print `<INST>\t<status>` per part, and
   exit 0 iff all parts are terminal, rc 1 if any part is pending/question, rc 2 on usage errors.
2. `gateState` is a pure, unit-tested helper; the four+ test cases above pass.
3. `commands/score.md` Stage 5 and Stage 8 instruct the Maestro to gate on `wait-gate` rc 0 before
   proceeding, with the restored "expect N notifications / continue until all terminal" wording.
4. Full gate green (`typecheck` / `test` incl. stale-tokens / `lint`); `dist/consort.cjs` rebuilt and
   committed; version bumped.
5. No frozen-protocol token altered; no banned token introduced.

## Out of scope / risks

- **Other commands.** `prelude` and `rehearsal` also run multi-part background waits; whether they
  share this weakness is a separate investigation, not addressed here. This spec is `score`-only.
- **No automated test for the .md control flow.** The prose orchestration has no unit test by design;
  the new `wait-gate` verb is the testable mechanical anchor, and a live dogfood (a real `--ensemble`
  run where one part lags the other) is the end-to-end confirmation.
- **Low risk — last-line semantics.** `gateState` must read the **last** `FS=`/`VS=` line (a
  question→re-arm cycle appends `question` then a terminal value); the tests pin this.
