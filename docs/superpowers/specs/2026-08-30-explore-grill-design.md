# Grilling in `/ap:explore` — frame round + post-landscape grill — design

**Date:** 2026-08-30
**Version:** 0.5.61
**Scope:** `commands/explore.md` (two new hub↔user phases), one new core module, one new
`PHASES` row + consult kind, handoff KV additions, tests. **Wire protocol untouched.**
**Review:** 3-lens adversarial review + per-finding verification (22 findings, 21 upheld, folded in).

## Problem

`/ap:explore` takes the user's topic string verbatim (`src/core/exploreTurn.ts:54`), spends N
worker research turns on it, and ends by printing a Conclusion. In 873 directive lines the user is
asked exactly two things: "worker busy — retry?" and, rarely, "skip the adversary?". Open questions
are relayed worker→worker (Phase 4b) and then listed in the landscape doc; nothing routes a
decision to the person who owns it. The run is a one-shot survey, not a thinking partner:

- A fuzzy topic burns the whole research pass — nothing sharpens *what would count as a good idea*
  before the workers start.
- The final landscape surfaces approaches, a tradeoff matrix, adversary critiques and open
  questions, then stops. The human never confronts those with the workers still live; the choice
  among surfaced ideas is deferred to `/ap:design`, which restarts research from a handoff that
  still carries every unresolved axis.

The `grilling` skill (`~/.claude/skills/grilling/SKILL.md`, user-local, **not shipped**) is the
missing protocol: interview in rounds over a design tree; the *frontier* is every decision whose
prerequisites are settled; each question carries a recommended answer; facts are the interviewer's
job (dispatched, never asked of the user), decisions are the user's; done when the frontier is
empty. This spec inlines a bounded form of that protocol into the explore directive at the two
places where it pays: one round before research, and a full grill after the final landscape.

## Goal

After this change an `/ap:explore` run (1) opens with **one framing round** that settles scope,
constraints, and what-counts-as-good as user decisions and stamps them into every worker's research
brief, and (2) after the final landscape doc is signed off — workers still live — runs a **bounded
grill** (≤3 rounds) over the landscape's open axes: each frontier question carries the Conclusion's
recommended answer, decisions go to the user, new fact needs go to the workers as a one-turn drill,
and the settled decisions reach `design-handoff.md` so `/ap:design` starts from what the human
actually chose — with hub-defaulted decisions always labelled as such, never laundered into user
choices. The landscape doc itself is never rewritten and the confidence gate is never re-run. Both
interviews are directive-owned (AskUserQuestion), with durable `$ART` records so a re-entered run
never re-asks a recorded answer.

## Architecture

### A. Phase 0.5 — frame (hub + user, one round)

Sits between `explore init` (which writes `topic.txt`) and `explore classify`. The only hard
constraint is *before Phase 3 research dispatch*, where `researchSendWith` composes each worker's
prompt (`src/commands/explore.ts:168-177`); the pre-`classify` slot is chosen so the user is asked
before Phase 2 spawns N panes, making a `skip` or an abandoned run cost nothing.

1. The hub reads `$ART/topic.txt` and drafts **at most 4** framing questions. Each is a *decision*
   (never a fact the hub could look up): scope boundary (in/out), hard constraints, what "good"
   means (evaluation criteria / priority order), and anything already decided or off-limits. Each
   question has 2–4 options with the hub's recommended option first, labelled `(Recommended)`.
2. One `AskUserQuestion` call (Header `Frame`), ≤4 questions. The user may pick `Other` and type;
   an `Other` answer of `skip` on any question leaves that heading `as stated in the topic`.
3. **Record** with the Write tool: `$ART/frame.md`, fixed schema —
   ```markdown
   # Frame: <topic>
   ## Scope
   ## Constraints
   ## Good means
   ## Decided
   ```
   one bullet list per heading, the user's answers verbatim (a heading the user skipped carries the
   single bullet `- as stated in the topic`). `## Decided` holds only user answers.
4. **Resume key:** if `$ART/frame.md` already exists the phase is skipped without asking (the
   `metric.md` precedent, `commands/autoresearch.md:119`).
5. `explore research-send` reads `$ART/frame.md` when present and passes its body to
   `composeExploreResearchPrompt`, which appends a `Framing (user-settled — treat as constraints,
   do not re-litigate):` block after the `Research lens:` line. Absent file → prompt byte-identical
   to today (test-asserted).

**Invariants.** The frame round is decisions-only by construction: the hub never runs retrieval
(frozen explore invariant) and pre-spawn there are no workers to dispatch facts to. A framing
question that would need a fact is simply not asked — the fact is ordinary research, which Phase 3
already dispatches on the topic. Phase 0.5 **never rewrites `$ART/topic.txt`** — the frame reaches
workers only via `frame.md` at `research-send`; `topic.txt` stays the user's verbatim topic because
`classify`'s keyword scan (`src/commands/explore.ts:142-143`), both landscape `## Topic` blocks
(`commands/explore.md:350`, `:601`) and the archived record read it directly. Phase 2's
`teardown --panes-only` retry path preserves `frame.md` exactly as it preserves `topic.txt`.

### B. Phase 8c — grill (hub + user + workers; ≤3 rounds)

Sits after Phase 8b (worker sign-off; the landscape doc is final and fair) and before Phase 8a
forensics / Phase 9 teardown, so workers are still live for drill turns. **Runs on degraded
(single-survivor) runs too** — mirroring `commands/explore.md:646` for sign-off: drill facts route
to the survivor, and every settled decision in `grill.md` is tagged `(degraded: single-source
evidence)`. The directive's degraded chain paragraph (`commands/explore.md:244-252`) gains `8c`
between `8b` and `9`.

**Inputs (read-only):** the final landscape doc, `adversary-<agent>.md`, `gap-<agent>.md`,
`open-questions.md`, `openq-<agent>.md`, `frame.md`. Worker rows come from the **current**
`$ART/list.txt` (post-survivors, the `:254-256` rule — add `8c` to that enumeration).

**Design tree.** The root is "which approach, under which constraints, do we take into design".
Candidate nodes, in priority order:
1. **Approach choice** — the first question on a converged run: adopt the Conclusion's strongest
   approach, or a named runner-up from `## Approaches` (the matrix row that "changes the
   conclusion" per `commands/explore.md:640`).
   **No-convergence run** (the landscape doc has no numbered item under `## Approaches` — the same
   condition `topApproach()` reads as empty, `src/core/exploreConfidence.ts:26-35`, which Phase 9
   later stamps `mode=explore-no-convergence`; at 8c-time `handoff-data.kv` does not exist, so the
   test is the doc itself): node 1 still leads, but its options are the approaches/axes the survey
   could not separate (`## Tradeoff matrix` rows where the candidates split, plus any CONTESTED
   marker) and **no option carries `(Recommended)`** — the hub never invents a recommendation.
   The question body states plainly that the survey did not converge and the choice is the
   user's. If `## Approaches` is empty entirely, node 1 is dropped and the frontier starts at 2.
2. Each `## Open questions` bullet of the landscape doc.
3. Each tradeoff-matrix criterion on which the top two approaches split.
4. Each adversary critique still marked needs-attention / CONTESTED after rebuttal and gap.
Each candidate is classified **decision** (the user's) or **fact** (evidence needed). A fact the
landscape already answers is *hub-answered* with a citation into the doc and never asked of the
user. A fact with no evidence in any artifact is a **drill fact**.

**Resume key.** On (re-)entry the hub reads `$ART/grill.md` if it exists. `## Settled decisions`
present → skip the phase entirely. Otherwise let `r` = the highest `## Round <r>` section present
(0 if none): every `Q<n>` in those sections already carries `status: settled | defaulted` and is
**never re-asked** — its answer feeds the frontier computation, and drill answers in
`$ART/drill-<agent>.md` are folded in as usual. Resume at round `r+1`; if `r >= 3` or the
recomputed frontier is empty, go straight to **Terminate** — write `## Settled decisions` /
`## Left open` from the recorded rounds without asking anything. A `## Round <r>` section is never
written twice.

**Round r (r = 1..3):**
1. **Frontier** = every decision node whose prerequisite nodes are settled (a question that depends
   on another still-open question in this round belongs to a later round) plus the drill facts
   discovered this round.
2. **Drill first, ask second.** Route this round's drill facts to the next **un-drilled** worker in
   the current `list.txt` order (one drill turn per worker for the whole grill — the same one-turn
   cap as rebuttal and sign-off, because `PHASES` state files are one-shot per phase). Write the
   facts as bullets to `$ART/grill-facts-<agent>.txt`, then `$CS explore drill-send <TOPIC>
   <agent> <provider>` and a **background** `drill-wait`. When no un-drilled worker remains, or
   the drill guard skips (`DS=skipped`, latest phase timeout/failed), the fact is recorded
   `unresolved` and the decision that depended on it is asked *under uncertainty* — the user is
   told which fact is missing.
3. **Ask** the frontier's decision questions: `AskUserQuestion` (Header `Grill r<r>`), ≤4 questions
   per call, more → a second call in the same round. Format per question: a short title, the
   question body naming the evidence (`landscape §…`, `$ART/adversary-<agent>.md`), 2–4 options
   with the recommended answer first labelled `(Recommended)` and its one-line rationale from the
   Conclusion. `Other` = free text. An `Other` answer of `stop` ends the grill after this round.
4. **Record** the round (Write tool, `$ART/grill.md`, append one `## Round <r>` section; schema
   below).
   **Reading drill answers.** Before round r+1 computes its frontier, the hub checks round r's
   drilled worker: `$ART/drill-<agent>.done` exists AND the last `DS=` line of
   `$ART/drill-<agent>.txt` is present. Only then may `$ART/drill-<agent>.md` (sections `## F1`,
   `## F2`, … each with a `[citation]` or the literal `cannot resolve, because …`) be read. If
   `.done` is absent, or `DS=` is `timeout`/`failed`/`missing`/`skipped`, or the state file's `AC=`
   line is `expired`, that round's facts stay `unresolved` for the next round and the dependent
   decisions are asked under uncertainty; a later round's check picks the answers up, and whatever
   settles after the last round is folded into the handoff Evidence table at termination. A round
   never blocks on its own drill.
   **`DS=question`.** A drill worker may raise a `question` event; `phaseWait` records
   `DS=question` and drops `drill-<agent>.done` generically. Handle it per Intervention Pattern 1
   (hub composes the answer from `grill.md` + the landscape; a genuine decision goes to the user as
   a frontier question), relay with `$CS send --from hub`, `rm -f $ART/drill-<agent>.done` (**never**
   the `.txt` state file — the one-turn cap is state-file existence), re-arm the background
   `drill-wait`.
5. **Terminate** when the frontier is empty, on `stop`, or after round 3. Every still-open decision
   is recorded `defaulted` with the recommended answer (or, on a no-convergence node with no
   recommendation, `defaulted: undecided`); every unanswered fact `unresolved`.
   **Mop-up (mandatory, even when the grill routed zero drill facts).** For every current
   `list.txt` row with no `$ART/drill-<agent>.txt` (never drilled this run), run `$CS explore
   drill-send <TOPIC> <agent> <provider>` followed by a background `drill-wait` — no
   `grill-facts-<agent>.txt` exists for it, so the verb self-skips (`DS=skipped`, note `no drill
   facts routed`) and the wait's skipped fast-path drops the `.done` marker. Then **`$CS explore
   wait-gate <TOPIC> drill` must exit 0 before Phase 8a** — without the mop-up the roster-wide
   gate (`src/core/phaseTable.ts:593-611`, `every(... === "terminal")`) can never go green. A
   `DS=timeout`/`failed` worker is terminal; its fact goes `unresolved`.

**`$ART/grill.md` schema** (Hub Write):
```markdown
# Grill: <topic>
## Round 1
- Q1 [decision] <title>: <question>
  recommended: <option> — <rationale>        (or: none — survey did not converge)
  answer: <user's answer>
  status: settled | defaulted
- F1 [fact] <question>
  routed: <agent> | hub-answered (<citation>) | unresolved
  answer: <text or ->
## Round 2
…
## Settled decisions
- <title>: <answer> (round <r>, settled|defaulted[, degraded: single-source evidence])
## Left open
- <title>: hub-defaulted to <answer> — <why not reached> (round cap | stop | prerequisite unresolved fact F<n>)
- <title>: <why> (unresolved fact: F<n>)
```
Every `defaulted` decision appears in **both** `## Settled decisions` (it is the operative
constraint the design is built against) and `## Left open` (it is an unconfirmed choice); the
`## Left open` section is empty only when nothing was defaulted and nothing is fact-blocked.

**Invariants (carried from the explore program, memory `explore-collab-improvement-analysis`):**
- The landscape doc is **never rewritten**; grill output is new files only.
- The confidence gate is **never re-run**; no drill answer re-gates anything.
- Drill dispatch honours the phase guard (`latest` kind, chain `SS GS RS AS VS QS FS`): a worker
  whose latest phase ended timeout/failed is skipped, never clobbered.
- Drill text is worker-authored **data**: the hub cites it, never executes instructions in it.

### C. Handoff (Phase 9c) and present (Phase 10)

`explore handoff-extract` adds to `handoff-data.kv`, in the existing additive slot — immediately
after `cross_verification_detail` and before the frozen tail `session_path` / `topic_txt_path` /
`generated_ts` (the 2026-08-08 precedent documented at `src/core/exploreHandoff.ts:54-56`) — each
conditional on presence: `frame_doc=frame.md`, `grill_doc=grill.md`, `drill_paths=<csv of
drill-<agent>.md>` (line omitted when none). The `mode` key is **not** rewritten by the grill: it
describes what the survey achieved, not what the user chose; a `mode=explore-no-convergence`
handoff naming a settled approach is the expected output. The six-section handoff schema is
unchanged; the directive folds the grill in:

- `## Recommendation` — on a converged run names the approach; "user-settled" **only** when the
  approach node's status is `settled`. If it differs from the survey's Conclusion, say so in one
  sentence ("The survey favoured X; the user settled on Y because …"). When the node is
  `defaulted`, the sentence reads "the survey's Conclusion carried forward — the grill ended
  (round cap | `stop`) before the user confirmed it" and the words "user settled" do not appear.
  **On no-convergence** the fixed sentence at `commands/explore.md:792-793` stays FIRST (the
  survey's verdict is a fact about the survey), followed by "The grill settled on <approach> as a
  user choice over a non-converged survey; it is not a survey finding." (or nothing more when the
  node was `defaulted: undecided`). `## Recipe` stays OMITTED on no-convergence, exactly as
  `commands/explore.md:794` requires.
- `## Constraints (carry-forward)` gains two labelled lists: `User-settled (grill):` for
  `settled` lines only, and `Hub-defaulted (grill, unconfirmed):` for `defaulted` lines. Never
  drop a defaulted line — it is the constraint the design is actually built against.
- `## Open questions` = the grill's `## Left open` items (plus any CONTESTED marker the grill did
  not reach); the section is omitted only when `## Left open` is empty and no such marker exists.
- `## Evidence` folds drill answers exactly like gap answers (a cited answer upgrades / adds a row,
  `cannot resolve` adds nothing).
- `## Appendix: artifacts` lists `frame_doc`, `grill_doc`, `drill_paths`.

Phase 10 gains two grill lines. (a) When `grill.md`'s **settled** approach differs from the
Conclusion's strongest approach, print ONE line **before** the Conclusion body (after the DEGRADED
caveat when both apply, mirroring `commands/explore.md:809-810`): `Grill override: the survey
suggested <A>; you settled on <Y> — ignore the /ap:design line inside the conclusion below and use
the handoff invocation.` The Conclusion body stays VERBATIM — never suppressed, never annotated
inline. (b) After the body: `Grill: <n> decisions settled (<d> defaulted), <m> left open —
$ART/grill.md`.

### D. Directive housekeeping

- Task list `TaskCreate × 19`: add `0.5 Frame [hub + user]` (`Framing the question`) and
  `8c Grill [hub + user + workers]` (`Grilling the landscape`) at their positions.
- Intervention Pattern 1 (`commands/explore.md:843-851`) is a closed enumeration: add `DS=question`
  (drill) to the key list and `drill-<agent>.done` to the marker list.
- The consult-kind enumeration at `commands/explore.md:219-220` gains `DRILL`.
- The degraded chain (`:244-252`) and the current-`list.txt` re-derivation list (`:254-256`) gain
  `8c` as noted in §B.

## Components

- `commands/explore.md` — header paragraph (one sentence: frame + grill), task table (×19), new
  `## Phase 0.5 — frame`, new `## Phase 8c — grill` (rounds, resume key, drill-read precondition,
  `DS=question`, mop-up + gate), Phase 9c folding rules (§C), Phase 10 two lines, §D housekeeping.
  The grilling protocol is inlined (frontier / recommended answer / facts-vs-decisions / cap) — no
  reference to the user-local skill.
- `src/core/exploreGrill.ts` (new) — `GRILL_MAX_ROUNDS = 3`; `FRAME_HEADINGS` (`Scope`,
  `Constraints`, `Good means`, `Decided`); `frameBlock(frameText)` → the research-prompt block
  (trims, returns `""` for empty input; no per-heading parsing); `parseFacts(text)` → `- ` bullets
  (the `parseOpenQuestions` shape, `src/core/exploreOpenq.ts:14-25`); `composeDrillPrompt(topic,
  facts, writeTo)` → one bounded answer turn writing `## F1..` with `[citation]` anchors and the
  `cannot resolve, because …` escape, ending with `artifactContract(writeTo)` (mirror
  `composeOpenqPrompt`, `exploreOpenq.ts:62-85`).
- `src/core/exploreTurn.ts` — `composeExploreResearchPrompt(topic, writeTo, lit, lens, selfassessTo,
  frame = "")`; when `frame` is non-empty insert `frameBlock(frame)` after the `Research lens:` line.
- `src/commands/explore.ts` — `research-send` reads `join(art, "frame.md")` if it exists and passes
  the body; new `drill-send` verb (`phaseSend` over the `drill` row: prepare reads
  `grill-facts-<agent>.txt`, `skip` when missing/empty with the note `no drill facts routed`);
  dispatch switch + usage line. `drill-wait` and `wait-gate <topic> drill` come free from the table.
- `src/core/phaseTable.ts` — `PhaseKey` gains `"DS"` (update the doc comment at `:65-67`);
  `PHASES` gains the row `{ phase: "drill", key: "DS", cmd: "explore", timeoutKind: "drill",
  artifactFor: drill-<agent>.md, stateFn: verifyState, skippable: true, retryNote: "exists — one
  drill turn per worker (the one-turn cap)", guard: { kind: "latest", noun: "latest phase", chain:
  ["SS","GS","RS","AS","VS","QS","FS"] } }` appended last (pipeline order). `gateState`'s key
  comment (`src/core/designTurn.ts:102-106`) updated.
- `src/core/contracts.ts` + `config/contracts.yaml` — consult kind `drill`, default 600 s
  (`drill_timeout_s: 600`; the gap budget); the `consultTimeout` error string (`contracts.ts:87`)
  enumerates `'drill'`.
- `src/core/exploreHandoff.ts` — `buildHandoffKv` input gains `frameDoc`, `grillDoc`, `drillPaths`;
  emitted conditionally in the slot after `cross_verification_detail` (§C); `extractHandoffData`
  fills them from the art dir.
- **Tests**
  - `tests/explore-grill.test.ts` (new, unit) — `frameBlock`, `parseFacts`, `composeDrillPrompt`
    (contract line present, every fact numbered, escape sentence present); research prompt
    byte-identical when `frame` is empty and carries the block when not; `drill-send` prepare/skip
    paths via the existing `SendDeps` fakes; `phaseWait` over the `drill` row (ok / skipped /
    timeout / question classification).
  - `tests/explore-grill-directive.test.ts` (new, directive pins on `commands/explore.md`,
    whitespace-collapsed, the `tests/design-assemble.test.ts:92-106` idiom): `## Phase 0.5 — frame`
    precedes `## Phase 1`; `## Phase 8c — grill` precedes `## Phase 8a` and `## Phase 9 —`; the cap
    text `after round 3`; `never rewritten`; the `(Recommended)` label rule; `TaskCreate × 19`;
    `never rewrites` + `topic.txt`; the mop-up sentence (`no $ART/drill-<agent>.txt`) before
    `wait-gate <TOPIC> drill`; the drill-read precondition (`drill-<agent>.done` exists AND);
    `DS=question` inside Pattern 1; `Hub-defaulted (grill, unconfirmed):`; `Grill override:`
    before `Suggested next step:`; the resume sentence (`## Settled decisions` present → skip).
  - `tests/phase-table.test.ts` — timeoutKind map gains `explore/drill: "drill"`; guarded-phase list
    gains `drill`; kind/noun map gains `drill: ["latest", "latest phase"]`; a `chain("drill")` case.
  - `tests/phase-send.test.ts` — `RETRY_NOTES` gains `"explore drill"`; the GUARDED pin gains `drill`.
  - `tests/explore-cmd.test.ts` — a `drill` skeleton row (`:301-302`); the starve (zero-input skip)
    set at `:305-309` gains `drill`; guard-chain case for `DS`.
  - `tests/explore-gate.test.ts` — `DS=question` is non-terminal like the other six keys.
  - `tests/explore-handoff.test.ts` — the three keys land after `cross_verification_detail` and
    before `session_path`; absent files → lines omitted; frozen tail unchanged.
  - `tests/contracts.test.ts` — `KINDS` tuple gains `"drill"`; default 600 and env override
    `AP_CONSULT_TIMEOUT_DRILL`.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — 0.5.61;
  `dist/ap.cjs` rebuilt and committed by the hub at the end.

## Testing

- Pure unit tests only (fresh `AP_HOME`, no tmux), as enumerated under Components.
- Directive pins are the contract `/ap:explore`'s hub follows; they are what a future edit must
  not silently drop.
- Live behaviour = the dogfood: one `/ap:explore` run on a real topic after the plugin update,
  checking that (a) the frame block appears in `<agent>_research_prompt.md`, (b) a drill turn
  dispatches and its answers reach `grill.md` round 2, (c) the mop-up leaves every worker
  `DS=skipped` or terminal and the gate exits 0, (d) `design-handoff.md` carries the settled
  approach with the right provenance label.

## Success Criteria

- `npm run typecheck`, `lint`, `test` green; `dist/ap.cjs` fresh; stale-token gate untouched.
- With no `frame.md`, every research prompt is byte-identical to 0.5.60's (test).
- `topic.txt` bytes are unchanged from `init` to teardown (directive invariant, pinned).
- A run with `frame.md` shows the `Framing (user-settled …)` block in every `<agent>_research_prompt.md`.
- Phase 8c asks at least the approach-choice question on every run whose landscape doc lists at
  least one approach, never more than 3 rounds, and every question on a converged run shows a
  `(Recommended)` option first; a no-convergence node shows none.
- `drill-send` is refused on a second call for the same worker (one-turn cap) and skipped with
  `DS=skipped` when that worker's latest phase ended timeout/failed; after the mop-up
  `wait-gate <TOPIC> drill` exits 0 on every run, including one that routed zero drill facts.
- `grill.md` ends with `## Settled decisions` and `## Left open`; every `defaulted` decision is in
  both. `design-handoff.md`'s Recommendation names the settled approach on a converged run (a
  no-convergence run keeps its fixed sentence first) and its Constraints carry every settled
  decision under the correct provenance label.
- The landscape doc's bytes are unchanged between the end of Phase 8b and teardown.

## Non-goals

- No re-research loop (the "gate-as-loop-predicate" and "worker re-dispatch to fix S2" items are
  refused in memory); drill answers enrich the handoff only.
- No per-round drill turns per worker (would need round-suffixed phase state; the one-turn cap
  with round-robin routing is the deliberate ceiling — revisit if the field shows round-2 facts
  matter and all workers are already drilled).
- No `must-answer` escape hatch in the frame (a framing question that needs a fact is not asked).
- No grill in `/ap:design`'s drilldown or in `/ap:quick`/`implement` — separate specs if wanted.
- No config knob for the round cap or for opting out of the interviews (a user who wants a lean
  run answers `stop` in round 1, or `skip` in the frame round).
