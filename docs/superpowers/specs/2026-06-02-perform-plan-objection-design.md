# perform: plan objection — design spec

**Status:** proposed (pending author review)
**Date:** 2026-06-02
**Command:** `/consort:perform`
**Branch:** `feat/perform-plan-objection`
**Relationship:** extends the shipped perform QUESTION-CLAIM protocol; faithful to clone-wars
`deploy` part-question handling. No new CLI verb; no new wire event.

## Problem

A part executing a perform turn can already halt mid-turn and ask the Maestro a question via a
single frozen `question` event on its outbox (`composeRound1Prompt`/`blockers()` →
`turnWaitWith` → `extractQuestionPayload` → `parseQuestionPayload`). Today that event has exactly
two routes:

- **verify** — the question carries a `claim:{kind,value}`; the Maestro mechanically verifies it
  (`verifyClaim`) and replies FOUND/NOT FOUND/UNVERIFIABLE (`formatReply`).
- **escalate** — no claim; the Maestro renders the prose question to the user for a judgment call.

There is no route for a part to **object to the plan itself** — to say "the design slice you handed
me is wrong / unsafe / internally inconsistent, and I should not just implement it." Such a halt
today must be smuggled through `escalate` as an undistinguished judgment question, so the Maestro
cannot reliably recognize a plan-level objection, cannot present the user a structured
Revise/Override/Abort decision, and cannot bound how many times a part re-objects before the turn
is forced forward. On the **multi-repo** path the situation is worse: `waveWaitWith` does not even
wait on the `question` event, so a wave part that raises any judgment question (objection included)
is invisible to the barrier and simply times out.

## Goal

Add a **third route — `objection`** — to the existing perform question protocol, on the **no-claim**
side only, so that:

1. A part can raise a plan-level objection by prefixing its `question` message with a literal
   `OBJECTION:` marker (parallel to the shipped `FLAG:` convention).
2. The Maestro recognizes it, renders the objection, and drives a structured
   **Revise / Override / Abort** decision via `AskUserQuestion`, replying to the part with
   **Maestro-authored prose** through the existing `send` primitive.
3. The behavior reaches **both** the single-repo turn path and the multi-repo wave path with true
   parity — including the offset/re-arm machinery the wave path is currently missing.
4. Objection storms are a **bounded, terminal** condition: at most **2** objections per dispatch,
   then force-escalate.

Out of scope: any change to the frozen wire protocol, any new CLI verb, any change to the
claim-verify (`verify`) route, and any reuse of this mechanism by commands other than `perform`.

## Current state (grounded)

| Concern | Where | Today |
|---|---|---|
| Route discriminant (extract) | `src/core/performQuestions.ts:175` | `const route = claim ? "verify" : "escalate";` |
| Route type | `src/core/performQuestions.ts:27` | `export type ClaimRoute = "verify" \| "escalate";` |
| Route parse | `src/core/performQuestions.ts:50` | `const route: ClaimRoute = (first("ROUTE") ?? "escalate") === "verify" ? "verify" : "escalate";` |
| Single-repo wait | `src/commands/perform.ts:208-231` (`turnWaitWith`) | waits `["done","error","question"]`; on `question` writes `question-<PART>-<round>.txt`, **bumps** offset via `appendFileSync(stateFile, "OFFSET=" + outboxOffset(outboxPath(PART,model,topic)) + "\nTS=question\n")` (lines 225-226), carries `round` throughout |
| Wave wait | `src/commands/perform.ts:647-667` (`waveWaitWith`) | verb args `<topic> <instrument> <provider>` (no round, no offset); waits `["done","error"]`; reads from **hardcoded offset 0** (line 658); writes `wave-<instrument>.txt` via `atomicWrite` (full overwrite, line 664); **no** `question` handling |
| Outbox match precedence | `src/core/ipc.ts:75-89` (`lastMatch`) | iterates the event-set in **argument order** — the first listed event present anywhere wins, returning its last occurrence |
| Offset reader | `src/core/scoreTurn.ts:39` (`parseLatestOffset`) | returns the **latest** `OFFSET=` line from append-structured state |
| Offset measurer | `src/core/ipc.ts:55` (`outboxOffset(path)`) | byte length of the outbox file |
| Build prompt (single) | `src/core/performTurn.ts` `composeRound1Prompt` | already appends `blockers(testCmd)` |
| DAG-unit prompt (multi) | `src/core/performTurn.ts:130-132` (`composeDagUnitPrompt`) | emits a done/error reporting block; **no** `blockers()` / question protocol |
| Wave barrier prose | `commands/perform.md` Stage 3a / 3b (312-332) / 3d (368-374) | per-part `wave-wait`; understands only `TS=ok` / `TS=failed` / `TS=timeout` |

The objection route is added strictly on the **no-claim** side of the existing discriminant, so the
**claim-wins precedence** is preserved: a question carrying a claim is *always* `verify`, even if
its message also begins with `OBJECTION:`.

## The design

### The three routes

| Route | Trigger (in precedence order) | Maestro action |
|---|---|---|
| `verify` | `claim:{kind,value}` present | mechanical `verifyClaim` → `formatReply` (FOUND/NOT FOUND/UNVERIFIABLE) — **unchanged** |
| `objection` | no claim **and** message matches `/^OBJECTION:/` | render objection → `AskUserQuestion(Revise / Override / Abort)` → Maestro-authored prose reply via `send` |
| `escalate` | no claim, no marker | render prose question to the user — **unchanged** |

Precedence is **claim-wins, then marker, then default**:

```
route = claim
  ? "verify"
  : /^OBJECTION:/.test(message)
    ? "objection"
    : "escalate";
```

The marker is consulted **only** when there is no claim. This mirrors the shipped
`extractQuestionPayload` discriminant (line 175) and widens it on the else branch only.

### The `OBJECTION:` marker encoding

- **Literal, anchored, case-sensitive** marker `OBJECTION:` at the very start of the decoded
  `message`. The regex is exactly `/^OBJECTION:/` — no leading-whitespace tolerance, no `i` flag.
  This parallels the shipped `FLAG:` marker. A message with leading whitespace
  (`" OBJECTION: ..."`), the marker mid-message (`"I think OBJECTION: ..."`), or a lowercase
  `"objection:"` does **not** match and routes to `escalate`. These semantics are pinned by tests
  (see Testing) so a future loosened regex cannot regress them silently.
- **Strip at extract time** so the payload's `TEXT` carries clean prose: remove **one** leading
  `OBJECTION:` and at most **one** single following space. Exactly: `s.replace(/^OBJECTION: ?/, "")`.
  Consequences pinned by tests: `"OBJECTION: hi"` → `"hi"`; `"OBJECTION:hi"` → `"hi"`;
  `"OBJECTION:  hi"` → `" hi"` (only one space stripped, one survives); a second `OBJECTION:` later
  in the prose is preserved (`"OBJECTION: a OBJECTION: b"` → `"a OBJECTION: b"`).
- **Empty prose is legal.** `"OBJECTION:"` or `"OBJECTION: "` alone round-trips to `TEXT=""` with
  `ROUTE=objection`. `validateQuestionLine` ran against the **raw** (non-empty) message, so extract
  still succeeds; the orchestration render step (Stage 1 step 3, Stage 3b/3d) **must tolerate empty
  objection text** and render a generic "the part objects to the plan (no detail given)" prompt.
- `ClaimRoute` widens to `"verify" | "escalate" | "objection"`. The strip and `ROUTE=objection`
  emission happen in `extractQuestionPayload`; `parseQuestionPayload` reads `ROUTE=objection` back.

### Maestro flow (Revise / Override / Abort)

When a wait resolves `TS=question` and the parsed `route === "objection"`:

1. **Render** the objection: the part's instrument, its (possibly empty) objection prose, and the
   relevant design slice, presented to the user.
2. **`AskUserQuestion`** with three options:
   - **Revise** — the design slice is wrong; the Maestro will hand the part a corrected directive.
   - **Override** — the objection is noted but the user wants the part to proceed as planned.
   - **Abort** — stop this part (single-repo: abort the turn; multi-repo: treat as a failed part
     and enter the wave/fix failure ladder).
3. **Maestro-authored prose reply.** For Revise and Override the Maestro **writes the reply prose
   itself** (this is a judgment route, not the mechanical `formatReply` template) and delivers it via
   the existing `send` primitive:
   `$CS send "<instrument>" "<TOPIC>" "@$ART/<reply-file>"`. The reply ends with an explicit
   resume/stop instruction so the part knows whether to proceed.
4. **Re-arm and resume.** The part reads its inbox reply, emits `ack`, and continues to its next
   terminal (`done`/`error`) or next `question`. The Maestro re-arms the wait **past the bumped
   offset** so the just-handled `question` line is below the read window (see the wait/re-arm wiring
   below). Note: the re-armed wait's event-set (`["done","error","question"]`) does **not** include
   `ack`; the re-armed wait (resuming past the bumped offset) **ignores** the part's `ack` (a
   no-progress event) and returns on the next terminal/question event. **Do NOT add `ack` to the
   wait event-set** — doing so would make the wait return on the ack and re-arm prematurely on a
   no-progress event.

There is **no new CLI verb**: rendering, the `AskUserQuestion`, and the reply authoring all live in
the `commands/perform.md` orchestration prose; delivery rides the existing `send` primitive.

### Prompt changes

- **`blockers()` objection clause.** Extend the existing `blockers()` text
  (`src/core/performTurn.ts`) with a clause telling the part how to raise a plan-level objection:
  prefix the `question` message with `OBJECTION:` and **omit the `claim` object** (an objection has
  no ground-truth referent to verify — it is a no-claim judgment question, **not** a missing
  referent). This clause is additive prose around the already-present judgment-question instruction.
- **`composeDagUnitPrompt()` gains `blockers("")`.** The multi-repo DAG-unit prompt
  (`src/core/performTurn.ts:130-132`) today emits only a done/error reporting block and carries no
  question protocol. Append `blockers("")` (empty `testCmd` — the wave part runs its own suite; the
  diagnostic-test clause degrades to the generic wording). Placement: append the `blockers("")`
  block **after** the existing done/error reporting line and **before** `BRANCH DISCIPLINE`,
  matching `composeRound1Prompt`'s ordering. The two blocks are **intentionally complementary**:
  the existing block defines the *terminal* report (`done`/`error`); `blockers("")` defines the
  *mid-turn halt* (`question`/objection + `ack`). They coexist by design and are not contradictory.

### Multi-repo parity (D1): the wave path gains the `question` route

The wave path must mirror the single-repo turn path's question handling. The single-repo mechanism
that makes re-arm safe is **the offset bump** (perform.ts:225-226): after handling a question it
records a fresh `OFFSET=` past that question and the re-armed wait reads from it, so the handled
`question` line is below the read window and `lastMatch`'s argument-order precedence
(`done`/`error` checked before `question`) returns the part's terminal event, not the stale
question. The wave path has **none** of this today (hardcoded offset 0, atomic-overwrite state
file, no round, no `question` in the event-set). A naive "record `OFFSET=` in `wave-<instrument>.txt`
and pass it back" is **not wireable** against the real code — that file is overwritten on each call,
the verb has no offset argument, and there is no per-dispatch discriminant. This subsection
specifies the concrete, wireable mechanism.

**1. Add a dispatch discriminant to the wave verb.** The wave path identifies state purely by
`instrument`, but a part is dispatched **multiple times** (across waves and across Stage 3d
fix-rounds, `n` up to `MAX_FIX_ROUNDS=3`) reusing the **same** instrument. Without a per-dispatch
token, the second dispatch's question/offset state collides with the first's and the re-arm cannot
tell a fresh question from a stale one. Therefore:

- Add a positional `<dispatch>` token (a monotonically increasing per-part integer the
  orchestration threads from Stage 3a/3b/3d) to the `wave-wait` verb and `waveWaitWith` signature.
  New verb shape: `perform wave-wait <topic> <instrument> <provider> <dispatch> [<since>]`.
- Name the question payload file `question-<instrument>-<dispatch>.txt` (the wave analogue of
  single-repo's `question-<PART>-<round>.txt`). The `<dispatch>` token is what makes this name
  fillable on the wave side — it is the wave's substitute for single-repo's native `<round>`.
- Persist the bumped offset in a **separate, append-only** state file
  `wave-<instrument>-<dispatch>.txt`, written with `appendFileSync` and read via `parseLatestOffset`
  — mirroring single-repo's `turn-<PART>-<round>.txt`. **Do NOT** record `OFFSET=` inside
  `wave-<instrument>.txt`: that file is atomically overwritten on every call (which would destroy a
  recorded offset) and its exact byte layout is pinned by an existing test — leave its ok/error/
  timeout field order unchanged.

**2. Read the starting offset from persisted state, not the literal 0.** Change `waveWaitWith` to
read its starting offset from `wave-<instrument>-<dispatch>.txt` via `parseLatestOffset`,
**defaulting to 0** when that file is absent (the first wait of a dispatch). The optional `<since>`
positional overrides it for a re-arm. The hardcoded `0` at perform.ts:658 is replaced by this
resolved offset.

**3. Wait on `question`.** Add `question` to the wave event-set, making it
`["done","error","question"]` — the **same argument order** as single-repo. `lastMatch`'s
argument-order precedence (ipc.ts:75-89) means `done`/`error` are searched across the read window
**before** `question`, so once the offset is bumped past a handled question, the part's terminal
event wins on re-arm. The offset advance is therefore a **hard precondition** of every re-arm: a
re-armed wait that did not advance past the handled `question` would re-return it (the part's `ack`
is not in the event-set and does not advance past it).

**4. On `question`, bump the offset with the correct identity.** Compute the bumped offset with the
**wave-path identity** — `outboxOffset(outboxPath(instrument, provider, topic))` — **not** the
single-repo `outboxOffset(outboxPath(PART, model, topic))`. Copy-pasting the single-repo line would
read the wrong outbox and silently re-read offset 0 (re-handling the same question forever). Then
write `question-<instrument>-<dispatch>.txt` (via `extractQuestionPayload`) and
`appendFileSync(wave-<instrument>-<dispatch>.txt, "OFFSET=" + bumped + "\nTS=question\n")`, and set
the first `TS=` line written to `wave-<instrument>.txt` to `question`.

**5. Stage 3b control flow (barrier reconciliation).** The existing Stage 3b barrier is whole-wave:
one `wave-wait` per part, collect all, then apply the `WAVE_RETRY` ladder. There is no existing
per-part re-arm scaffold, so grafting a `TS=question` re-arm onto a whole-wave barrier requires
explicit reconciliation:

```
on each wave-completion notification, for every part read the first TS= of wave-<instrument>.txt:
  partition parts into { ok, failed|timeout, question }
  for each `question` part:
    parse question-<instrument>-<dispatch>.txt
    route = verify ? (mechanical reply) : objection ? (Revise/Override/Abort) : escalate
    handle the route (reply via send, or AskUserQuestion), respecting the per-dispatch cap (D2)
    bump dispatch -> dispatch'  (increment the part's dispatch token)
    re-fire in background:
      $CS perform wave-wait <TOPIC> <instrument> <provider> <dispatch'> <bumped-offset>
    keep this part OUT of the completion set (it is still in flight)
  the wave is COMPLETE only when EVERY part is terminal (ok | failed | timeout)
  the WAVE_RETRY ladder is evaluated ONLY after all parts reach terminal
```

The rolling todo tracks still-in-flight (re-armed) parts; siblings already `TS=ok` wait at the
barrier until the questioning part terminates. Because the re-armed `wave-wait` resumes from the
bumped offset (step 4) and `done`/`error` outrank `question` in `lastMatch`, a re-armed wait whose
offset is past the handled question returns the part's terminal `done`, never the stale `question`
— so the wave **cannot deadlock** on a re-asked question and always terminates at the wave timeout
in the worst case.

**6. Stage 3d (fix-loop) and Stage 3a must not be deaf to `TS=question`.** Adding `question` to the
event-set is **global** — every `wave-wait` callsite can now return `TS=question`. Stage 3d's
completion logic today understands only `TS=ok` ("re-run Stage 3c verification") and implicitly
treats everything else as "still buggy," which would re-send a fix prompt while the part waits on a
reply that never comes — a hang that burns all 3 fix rounds. Therefore **Stage 3d gets the same
`TS=question` branch** (verify/escalate/objection handling, per-dispatch re-arm, and the cap), and
Stage 3a is confirmed to route any `TS=question` through the same handler. No `wave-wait` callsite
is left deaf to `TS=question`.

### Guardrails (D2): objection cap, persisted

The objection cap is **2 per dispatch** (per turn-round single-repo, per wave-dispatch multi-repo);
the **third** objection from the same dispatch is **force-escalated** (routed to `escalate` and
rendered as a plain judgment question, never re-offered as Revise/Override).

The counter is **persisted in the dispatch's state file**, not held in an in-memory shell variable
— because the re-armed wait is a background task whose completion re-enters the same markdown
branch, an in-memory counter is not guaranteed to survive re-entry and the cap could fail to trip
(allowing verify→Override→objection to loop to timeout). Concretely:

- Single-repo: append `OBJECTIONS=<n>` to `turn-<PART>-<round>.txt` alongside the bumped `OFFSET=`.
- Multi-repo: append `OBJECTIONS=<n>` to `wave-<instrument>-<dispatch>.txt` alongside the bumped
  `OFFSET=`.

The orchestration branch **reads and increments** `OBJECTIONS=` from disk on every re-arm
(latest-line-wins, same as `parseLatestOffset` / the `kvFileField` reader at perform.ts:247) and
forces escalate once it reaches 2. Because the counter lives on disk, the cap holds across
background-task re-entry.

## Wire-protocol safety

Nothing frozen is renamed or added:

- **Event names** (`ready/ack/progress/done/error/question`) — unchanged; the objection rides the
  existing `question` event.
- **Sentinel** `END_OF_INSTRUCTION`, **JSON fields** (`ts/summary/artifacts/note/message/fatal/
  task_summary/model/topic`), **`contracts.yaml` keys**, **state filename format**,
  **`CLAUDE_CODE_SESSION_ID`** — untouched.
- `OBJECTION:` is content **inside** the frozen `message` string — not a new field, not a new event,
  not on the wire as structure. It parallels the already-shipped `FLAG:` marker.
- `ROUTE=` (and the new `ROUTE=objection` value), `OFFSET=`, `OBJECTIONS=`, and the `<dispatch>`
  token are **conductor-only** KV fields inside `_perform/` state files — they never appear on the
  outbox/inbox wire the external model binaries read.
- The stale-token gate (`tests/stale-tokens.test.ts`, which scans `src config commands hooks
  .claude-plugin` **including comments**) stays green: `OBJECTION:` and the new KV fields introduce
  none of the banned tokens (`clone-wars` / `cw_` / `master-yoda` / `MISSION ACCOMPLISHED` / `@cw_`).
  Keep new comments free of banned tokens.

## Change surface (file-by-file)

| File | Change |
|---|---|
| `src/core/performQuestions.ts:27` | widen `ClaimRoute` to `"verify" \| "escalate" \| "objection"` |
| `src/core/performQuestions.ts:50` | **rewrite** the route ternary to a three-way branch: `ROUTE=objection`→`objection`, `=verify`→`verify`, else→`escalate`. (typecheck alone will **not** flag a missing objection branch — the current 2-way ternary is type-valid and simply never returns `objection`; the round-trip test catches it, but name the rewrite explicitly so it is not missed.) |
| `src/core/performQuestions.ts:175` | widen the extract discriminant to `claim ? "verify" : /^OBJECTION:/.test(message) ? "objection" : "escalate"`; when `objection`, strip a leading `OBJECTION: ?` from the encoded `TEXT` |
| `src/core/performTurn.ts` (`blockers`) | add the objection clause (prefix `OBJECTION:`, omit `claim`) |
| `src/core/performTurn.ts:130-132` (`composeDagUnitPrompt`) | append `blockers("")` after the done/error line, before `BRANCH DISCIPLINE` |
| `src/commands/perform.ts:208-231` (`turnWaitWith`) | on `route==="objection"` it already writes `question-<PART>-<round>.txt` and bumps `OFFSET=`; additionally append `OBJECTIONS=<n>` to `turn-<PART>-<round>.txt` for the persisted cap |
| `src/commands/perform.ts:48` (usage string) | update `wave-wait` argument list |
| `src/commands/perform.ts:647-651` (`waveWaitRun`) | accept `<dispatch>` (required) and optional `<since>`; new usage `wave-wait <topic> <instrument> <provider> <dispatch> [<since>]`; validate `<dispatch>` (and `<since>` if present) is a non-negative integer |
| `src/commands/perform.ts:653-667` (`waveWaitWith`) | add `dispatch` (and optional `since`) params; read the start offset from `wave-<instrument>-<dispatch>.txt` via `parseLatestOffset` (default 0; `since` overrides); wait `["done","error","question"]`; on `question`, write `question-<instrument>-<dispatch>.txt`, append `OFFSET=outboxOffset(outboxPath(instrument,provider,topic))` + `TS=question` + `OBJECTIONS=<n>` to `wave-<instrument>-<dispatch>.txt`, and set the first `TS=` in `wave-<instrument>.txt` to `question`. **Do not** add `OFFSET=` to `wave-<instrument>.txt` (preserve its pinned ok/error/timeout layout). |
| `commands/perform.md` Stage 1 step 3 | add the `route==="objection"` branch: render → AskUserQuestion(Revise/Override/Abort) → Maestro-authored reply via `send`; cap from `OBJECTIONS=`; tolerate empty objection text |
| `commands/perform.md` Stage 3a | confirm any `TS=question` routes through the question handler |
| `commands/perform.md` Stage 3b (312-332) | add the `TS=question` branch + barrier-reconciliation control flow (partition ok/failed/question; per-part re-arm with bumped offset + incremented dispatch; wave complete only when all terminal; `WAVE_RETRY` evaluated only after all terminal) |
| `commands/perform.md` Stage 3d (368-374) | add the same `TS=question` branch (verify/escalate/objection, per-dispatch re-arm, cap) so the fix-loop is not deaf to questions |

## Testing strategy

### Unit (pure) — `performQuestions`

- **Route detection** (`extractQuestionPayload`): claim present + `OBJECTION:` message → `verify`
  (claim-wins, marker ignored); no claim + `OBJECTION: ...` → `objection`; no claim, no marker →
  `escalate`.
- **Marker negative/edge cases** (lock the case-sensitive, anchored, no-leading-trim semantics):
  - leading whitespace `" OBJECTION: ..."` → `escalate` (chosen behavior: do **not** trim).
  - marker mid-message `"I think OBJECTION: ..."` → `escalate`.
  - lowercase `"objection: ..."` → `escalate`.
  - marker-only / empty prose after strip (`"OBJECTION:"`, `"OBJECTION: "`) → `route=objection`
    with `TEXT` decoding to `""` (assert extract still succeeds and the round-trip yields empty text;
    the perform.md render must handle it).
- **Strip exact-equality** (use `toBe` on the round-tripped decoded text, not `toContain`):
  `"OBJECTION: hi"`→`"hi"`; `"OBJECTION:hi"`→`"hi"`; `"OBJECTION:  hi"`→`" hi"` (one leading space
  survives); `"OBJECTION: a OBJECTION: b"`→`"a OBJECTION: b"` (only the leading marker stripped).
- **Standalone parse** (`parseQuestionPayload`), independent of the extractor since other call sites
  read it: `parseQuestionPayload("TEXT=x\nROUTE=objection\n").route === "objection"`;
  `parseQuestionPayload("TEXT=x\nROUTE=bogus\n").route === "escalate"` (unknown ROUTE still defaults
  to escalate after the widening) — mirroring the existing `ROUTE` escalate-default test at line 50.
- **Round-trip** extract→parse for an objection event (no claim, `OBJECTION:` message) →
  `route==="objection"`, `text` stripped.

### Unit (pure) — `perform-turn` prompts

- `blockers()` text contains the objection clause (prefix `OBJECTION:`, omit `claim`).
- `composeDagUnitPrompt()` contains **both** the existing `{"event":"done"}` / `{"event":"error"}`
  reporting line **and** the appended objection clause, in that order, before `BRANCH DISCIPLINE`.

### Unit (pure) — `perform-wave-wait`

- **Update the existing regression-pins (deliberate edits, not new cases):**
  - `tests/perform-wave-wait.test.ts:97-98`: the event-set assertion changes from
    `["done","error"]` to `["done","error","question"]`, and the call gains the `<dispatch>`
    argument. The offset assertion at line 97 (`calls[0].off === 0`) holds for the **first** dispatch
    (no `wave-<instrument>-<dispatch>.txt` yet) — keep it as the first-dispatch case.
  - `tests/perform-wave-wait.test.ts:104-111` (field-order pin): it currently covers only `TS=ok`;
    `wave-<instrument>.txt`'s byte layout is **unchanged** for the ok/error/timeout cases (no
    `OFFSET=` added there), so that assertion must still pass verbatim. Add a separate `TS=question`
    field-order assertion for the new question case.
- **New cases:**
  - `question` event with `OBJECTION:` message → `wave-<instrument>.txt` first line `TS=question`;
    `question-<instrument>-<dispatch>.txt` written; `wave-<instrument>-<dispatch>.txt` has a bumped
    `OFFSET=`.
  - **Bumped-offset value** against a seeded fixture: inject a wait returning a `question` event over
    an outbox fixture with >1 line and assert the recorded `OFFSET=` equals
    `outboxOffset(outboxPath(instrument, provider, topic))` (proves it is non-zero and uses the
    **wave-path identity**, not `PART`/`model`).
  - **Re-arm does not re-return the stale question:** a re-armed `wave-wait` started at the bumped
    offset (`<since>` past the handled question) returns the part's terminal `done` (or `error`),
    not the prior `question` — exercising `lastMatch`'s `done`-before-`question` precedence together
    with the offset advance.
  - **First-vs-re-arm offset resolution:** with no `wave-<instrument>-<dispatch>.txt` present the
    wait starts at 0; with one present it starts at its latest `OFFSET=`.
- **Unchanged done/error/timeout behavior** for the non-question cases is otherwise a regression-pin.

### Suite-as-gate (doc control-flow) — honest scope

The `commands/perform.md` Stage 1 / 3a / 3b / 3d branches are **uncompiled prose with no automated
control-flow test**: the stale-token gate only confirms `OBJECTION:` and the new KV fields introduce
no banned token, and `typecheck`/`lint`/`build` do **not** parse `.md`. **Manual review** of the
four branches is the gate, and the **live dogfood** below is the real exercise.

### Dogfood

Run a perform turn (single-repo first, then a multi-repo wave) where a part emits
`{"event":"question","message":"OBJECTION: the design slice references a module that doesn't exist"}`
with no claim. Confirm: the Maestro renders it, offers Revise/Override/Abort, the part receives the
Maestro-authored reply, emits `ack`, resumes, and the wait re-arms to the part's terminal event
without re-asking. Then exercise the cap by raising 3 objections from one dispatch and confirm the
third force-escalates.

## Risks

- **Wave re-arm offset round-trip (the easy fatal gap).** The wave path has no native offset/round
  state and `wave-<instrument>.txt` is atomically overwritten, so the bumped offset **must** live in
  a separate append-only `wave-<instrument>-<dispatch>.txt` (read via `parseLatestOffset`) and the
  re-arm **must** pass the bumped offset + incremented `<dispatch>`. If the implementer instead
  records `OFFSET=` in `wave-<instrument>.txt`, the next overwrite destroys it and the re-arm reads
  offset 0, re-finding the same `question` and spinning to the 14400s timeout. The bumped-offset
  value test (seeded fixture) and the re-arm test are the guards.
- **Wrong outbox identity on bump.** Using the single-repo `outboxPath(PART, model, topic)` on the
  wave path reads the wrong outbox and silently re-reads offset 0. The bumped-offset fixture test
  pins the correct `outboxPath(instrument, provider, topic)` identity.
- **`lastMatch` precedence + offset interaction.** A re-armed wave-wait that does **not** advance the
  offset will re-return the stale `question` (the part's `ack` is not in the event-set and does not
  advance past it). The offset advance is a **hard precondition** of every re-arm; the re-arm test
  asserts the terminal event is returned, not the stale question.
- **Per-dispatch state collision.** Without the `<dispatch>` token, a part's second dispatch reuses
  the first's question/offset files and the re-arm cannot distinguish fresh from stale. The token
  must be threaded from Stage 3a/3b/3d and must be unique per dispatch.
- **Objection storm.** Bounded by the persisted `OBJECTIONS=` counter (cap 2/dispatch,
  force-escalate the third). Because it lives on disk it survives background-task re-entry.
- **Adding `ack` to the wait event-set.** Tempting but wrong — it would make the wait return on a
  no-progress event and re-arm prematurely. The event-set stays `["done","error","question"]`.

## Acceptance criteria

- [ ] `ClaimRoute` is `"verify" | "escalate" | "objection"`; `parseQuestionPayload`'s route branch
  is three-way and unknown `ROUTE` still defaults to `escalate`.
- [ ] `extractQuestionPayload` routes claim→`verify` (even with `OBJECTION:` message), no-claim +
  `/^OBJECTION:/`→`objection` (with `OBJECTION: ?` stripped from `TEXT`), else→`escalate`.
- [ ] Marker is case-sensitive, anchored, no-leading-trim; the four negative cases route to
  `escalate`; the strip exact-equality cases pass with `toBe`.
- [ ] `blockers()` carries the objection clause; `composeDagUnitPrompt()` carries both the
  done/error block and `blockers("")`, in the specified order.
- [ ] `waveWaitWith` takes `<dispatch>` (+ optional `<since>`), waits
  `["done","error","question"]`, reads the start offset from `wave-<instrument>-<dispatch>.txt`
  (default 0; `since` overrides), and on `question` writes `question-<instrument>-<dispatch>.txt` +
  appends the bumped `OFFSET=` (wave-path identity) and `OBJECTIONS=` to
  `wave-<instrument>-<dispatch>.txt`, leaving `wave-<instrument>.txt`'s ok/error/timeout layout
  byte-identical.
- [ ] `tests/perform-wave-wait.test.ts:97-98` updated to `["done","error","question"]` with the
  `<dispatch>` argument; the field-order pin keeps the `TS=ok` assertion verbatim and gains a
  `TS=question` case.
- [ ] The bumped-offset value test and the re-arm-does-not-re-ask test pass.
- [ ] `commands/perform.md` Stage 1 step 3, Stage 3a, Stage 3b, and Stage 3d all handle
  `TS=question` (verify/escalate/objection), with per-dispatch re-arm and the persisted cap; the
  wave is declared complete only when all parts are terminal.
- [ ] The objection cap force-escalates the third objection from one dispatch (persisted
  `OBJECTIONS=`).
- [ ] `npm run typecheck && npm run test && npm run lint && npm run build` all pass; `dist/consort.cjs`
  rebuilt and committed.
- [ ] Stale-token gate green (`OBJECTION:` and the new KV fields introduce no banned token).
- [ ] Live dogfood (single-repo and multi-repo) confirms the full render → decide → reply → ack →
  resume → re-arm cycle and the cap.

## Relationship to clone-wars

This faithfully extends clone-wars `deploy` part-question handling: the `verify`/`escalate` routes
are the byte-faithful ports already shipped; `objection` is a new judgment sub-route on the no-claim
side, carried by content inside the frozen `question` event (parallel to the shipped `FLAG:`
marker). The wave path's offset/re-arm wiring is brought to parity with the single-repo turn path's
existing offset-bump mechanism. No frozen protocol surface changes.

## Out of scope

- Any change to the `verify` (claim) route or `formatReply`.
- Any new CLI verb or new wire event/field.
- Any reuse of the objection route by commands other than `perform`.
- Auto-revising the design doc on Revise (the Maestro authors a directive to the part; rewriting the
  on-disk design slice is a separate concern).
