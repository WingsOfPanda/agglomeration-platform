# Rehearsal B2 — Operators & ideation quality design

**Status:** approved design (2026-06-04), pending implementation plan. Phase **B2** of the rehearsal
research-validity roadmap (`docs/superpowers/specs/2026-06-03-rehearsal-research-validity-roadmap.md`),
the second leg of the **Q2 idea-generation track**. Builds on B1 (coverage/diversity, 0.1.17) and the
proven A3/B1 score-pass+tsv arc. Deps: B1.

## 1. Problem

AIRA's empirical result: **"operators, not search policies, are the bottleneck"** — improving the
per-round *idea-transformation move* matters far more than the scheduler. At 2-3 parts there is
essentially no search to speak of, so the entire premium is operator quality. Two concrete gaps in
rehearsal today:

- **Ideation is one generic move.** The Maestro composes a free-text ~50-token "direction" per idle
  part (`commands/rehearsal.md` Step 5.2). There is no typed operator vocabulary, no diversity
  mechanism (parts can collapse onto tweaks of the current leader — the documented mode-collapse
  failure), and no attribution discipline (a metric delta can come from many simultaneous changes, so
  it is not causal).
- **The SOTA sweep is decoupled from selection.** `sota.md` is re-read into every *part* prompt but
  **never into the Maestro's idea-selection inputs** (Step 5.2 reads only session-summary + scoreboard
  + topic/metric). Its curated `family` column — the only structured family list in the system — is
  never diffed against what's actually been tried.

B2 makes the per-round move a small **typed operator** with prompt-level diversity, a single-change
attribution contract, SOTA re-grounding, and a light advisory lineage record.

## 2. Constraints

- **Directive-heavy, mechanical-light (user choice; matches A2/B1 precedent).** Both prior B-track
  phases shipped directive-only. A mechanical *gate* ("exactly one variable changed") is **infeasible**
  against today's free-text approach-brief — there is no structured per-experiment config; the only
  structured config is `audit.json` (mandated `hard_constraints` knobs, post-run). So B2's mechanical
  surface is ONE light **advisory** signal (flag-don't-block, A3 philosophy), not a reject.
- **Additive only.** New pure module (`rehearsalLineage`), new optional `--parent` flag, new per-exp
  `lineage.txt` marker, new `lineage.tsv` state file. No frozen wire token renamed; `result.json`
  schema, `status` enum, scoreboard schema + integer-rank contract, `experiment-send`'s 5-positional
  contract all untouched (the flag is additive in the flags-first loop).
- **Explore-only preserved.**
- **YAGNI.** Rejected as over-engineering for a 2-3 part explore-only harness: MCTS/UCT/evolutionary
  search, the Crossover operator, Elo/full-Swiss tournaments, a pre-run pairwise idea-ranking judge
  (run-all + post-hoc real-metric ranking is cheaper and uses the trustworthy signal the validity
  track already built), RL/fine-tuned ideator, Nova's bespoke retrieval subsystem, parsing/trusting
  the Verbalized-Sampling probabilities, a `{{PARENT_BLOCK}}` template token (parent context rides in
  the existing free-text brief), a hard one-variable `experiment-send` reject, and applying Verbalized
  Sampling to convergent (single-answer) sub-steps. Recorded so a future audit doesn't re-add them.

## 3. The typed operators — resolving the B1×B2 tension

The core framing. "Single-change attribution" (B2) and "open new families" (B1) appear to conflict — a
one-variable child is the SAME family as its parent, which B1's diversity guard discourages. They are
in fact the AIRA **Draft vs Improve** distinction, and naming them resolves the tension:

- **Draft** = open a NEW orthogonal approach family. This is exactly what B1's coverage steering
  already triggers when the `Coverage:` line is `(short by K)`. Diversity-maximizing; no parent.
- **Improve** = a single-variable change on a NAMED `parent_id` → an attributable metric delta.
  Refinement within a promising family.

The directive (Step 5) tells the Maestro WHICH to use from state: coverage short / a new angle
warranted → **Draft**; a promising family to refine → **Improve** (declare a parent, change one thing).

## 4. Directive & template changes (the bulk of B2)

### 4.1 Diverse Draft (`commands/rehearsal.md` Step 5 + template)
When Drafting, the Maestro:
- picks from a **small discovery-lens catalog** (4-5 orthogonal generative stances — mechanism-swap /
  representation-change / constraint-relaxation / objective-reframe / decomposition — optionally mapped
  onto a SOTA family) so angles are categorically different, not tweaks of the leader;
- uses **Verbalized Sampling** — enumerate k≈3-5 candidate angles as a distribution before committing
  (gated to ideation only; the verbalized probabilities are a diversity lever, **not** parsed/trusted);
- applies an **avoid-set** = the current leader + already-tried families (read from the `Coverage:`
  line) as an explicit "different from these" constraint.

### 4.2 Single-change Improve contract (`commands/rehearsal.md` Step 5 + template)
- An Improve dispatch passes `--parent <exp-id>` and changes **exactly one variable** vs that parent,
  named in the free-text brief ("change exactly one thing per experiment" → causal delta; isolate
  first, combine only after each change is attributed — the 2x2 escape hatch).
- The parent's config + the one change ride in the existing `{{APPROACH_BRIEF}}` — **no new template
  token**.
- Template: a static note — "if your brief references a parent experiment to improve on, change exactly
  ONE variable vs it so the metric delta is attributable" — plus strengthening the existing
  **"Simplicity bias"** prose into an **early-round complexity cue** (keep it simple early; go deeper
  once a baseline exists — AIRA: curb turn-1 over-engineering).

### 4.3 SOTA re-grounding (`commands/rehearsal.md` Step 5, directive-only)
Add `$ART/sota.md` to the Step-5 selection inputs (the Maestro re-reads the FILE, not stale chat
memory) and diff its `family` column against the `Coverage:` line → prefer an **untried known family**
when Drafting. Composes with B1: B1 says "open a new family"; this says *which* known one is untried.
Kept directive-only — no second mechanical sidecar.

### 4.4 Ranking (`commands/rehearsal.md`, affirm existing)
**No pre-run pairwise.** Dispatch the diverse angles and let the real (A1-verified / A3-sanity-gated)
metric rank them post-hoc — the trustworthy signal the validity track already built (AIRA's
absolute-fitness selection). This is already how the loop works; the directive just affirms it.

## 5. The light advisory lineage (the one mechanical piece)

Reuses the A3/B1 arc verbatim.

### 5.1 `--parent` flag + per-exp marker
`experiment-send` gains an optional **`--parent <exp-id>`** flag, parsed in `parseExperimentSendArgs`
and carried on the `ExperimentSendArgs` interface (both in `src/commands/rehearsal.ts`) — additive in
the flags-first loop; the 5-positional contract is byte-identical. Validated like the other flags:
`EXP_ID_RE`, and the parent's exp dir must exist under the SAME instrument's experiments dir
(**same-lane-only for v1** — rc 1 if missing, mirroring the existing missing-precondition rc-1 paths).
At dispatch, the verb `experimentSendWith` writes a per-exp `lineage.txt` in the new exp dir (via the
injected atomic writer) containing `parent_id=<exp-id>` (additive new state file; absence of the file
⇒ a Draft). `buildDispatchState` (the pure state-merge helper) is unchanged — `lineage.txt` is a
separate FS write in the verb, not part of `state.txt`.

### 5.2 New pure core `src/core/rehearsalLineage.ts`
Mirrors `rehearsalCoverage.ts`/`rehearsalSanity.ts`:
- `LineageRow { expId; instrument; parentId; knobsChanged; verdict; ts }`.
- `LINEAGE_TSV_HEADER = "exp_id\tinstrument\tparent_id\tknobs_changed\tverdict\tts\n"`.
- `lineageRow(r)` — tab-joined serializer.
- `diffAuditKnobs(parentAudit, childAudit)` — pure; counts mandated knobs whose values differ
  (numeric-tolerant, reusing the A3 `parseFloat`-both-sides compare from `rehearsalSanity`). Over the
  union of keys; a key present on one side only counts as a difference.
- `classifyLineage(parentId, knobsChanged)` — pure: no `parentId` → `"draft"`; with parent and
  `knobsChanged === 1` → `"improve-single"`; `> 1` → `"improve-multi"`; `=== 0` →
  `"improve-unverified"`.

### 5.3 `computeScore` hook
In the per-experiment walk (which already reads `audit.json` for A3), additionally read the exp's
`lineage.txt`; if a `parent_id` is present, read the parent's `audit.json`
(`experimentDir(art, instrument, parentId)/audit.json`), compute `diffAuditKnobs` vs this exp's audit
object, and `classifyLineage`. Push a `LineageRow` for **every** experiment (a parentless exp gets a
`draft` row with empty `parentId`/`knobsChanged`). Accumulate `lineageRows` on `ScoreComputation`.
`scoreWith` writes `lineage.tsv` as a **snapshot** (overwrite, never append) immediately after the
`coverage.tsv` write, preserving the frozen write order.

### 5.4 Surfacing — record richly, flag ONE verdict
- **`lineage.tsv` records the full edge** for every experiment (parent + verdict + knobs-changed
  count) — cheap, a tree view, and the lineage substrate C1 will need.
- **The status brief surfaces exactly ONE advisory:** an `improve-multi` experiment appearing in the
  scoreboard **top-3** gets a per-row tag `[multi-change]` (keyed `instrument/exp`, mirroring A1's
  verdict / A3's `[suspect]` tags) — "this leader's delta spans >1 changed knob, not cleanly
  attributable; do not over-trust it." **Only `improve-multi` tags.** `draft` and `improve-single` are
  healthy (no tag); `improve-unverified` is NOT surfaced — because `audit.json` only covers *mandated*
  knobs, most real Improves change a non-mandated knob and would land in `improve-unverified`; flagging
  the majority of Improves is the A3 "noisy flag" anti-pattern (the Maestro learns to ignore it). It is
  recorded (count 0) but never tagged.
- **Finalize** folds `improve-multi` rows into `## Warnings` (mirroring how A3 folds non-audit sanity
  flags), so a botched-attribution leader is visible in the final session summary.

### 5.5 No `metric.md` knob
The single-change norm is a directive contract + an advisory flag, not a threshold — no knob needed
(YAGNI; unlike `min_families`/`max_debug_attempts` which parameterize a gate).

## 6. Flow

1. Maestro decides the next move (Step 5): **Draft** (new family — uses lenses + Verbalized Sampling +
   avoid-set + SOTA untried-family diff) or **Improve** (refine a promising family — `--parent <exp-id>`,
   exactly one variable, named in the brief).
2. `experiment-send` validates `--parent` (same-lane exp exists) and writes `lineage.txt` at dispatch.
3. Experiment lands → `score` (`computeScore`) reads `lineage.txt` + `audit.json` + the parent's
   `audit.json`, classifies the lineage, and `scoreWith` writes the `lineage.tsv` snapshot.
4. `status-brief` tags an `improve-multi` top-3 leader `[multi-change]` (advisory). The Maestro reads
   it; it does not gate — it cautions the Maestro against over-trusting that delta and suggests an
   isolating single-change Improve.
5. The real (A1-verified / A3-gated) metric ranks all dispatched angles post-hoc — no pre-run pairwise.

## 7. Boundaries — what B2 does NOT do

- Does **not** add a hard one-variable `experiment-send` reject (advisory only; the free-text diff is
  undecidable and the mandated-knob audit is best-effort).
- Does **not** add a pre-run pairwise/Swiss ranking judge.
- Does **not** parse/trust Verbalized-Sampling probabilities, add a `{{PARENT_BLOCK}}` token, re-run
  the SOTA sweep mid-loop, or add a machine-readable SOTA-families sidecar (SOTA re-grounding is
  directive-only).
- Does **not** change the scoreboard schema, the `status` enum, `result.json`, or the integer-rank
  parsing contract. `experiment-send`'s 5 positionals are byte-identical (the flag is additive).
- Does **not** introduce a cross-lane parent (same-lane-only for v1).

## 8. Files

- **New:** `src/core/rehearsalLineage.ts` — `LineageRow`, `LINEAGE_TSV_HEADER`, `lineageRow`,
  `diffAuditKnobs`, `classifyLineage`.
- **Modified:**
  - `src/commands/rehearsal.ts` — `ExperimentSendArgs` gains optional `parentId`;
    `parseExperimentSendArgs` (`--parent` flag); `experimentSendWith` (validate same-lane parent +
    write `lineage.txt`); import lineage header/row; `scoreWith` (lineage.tsv snapshot write after
    coverage.tsv); `statusBriefWith` (lineage.tsv join); finalize (`improve-multi` → Warnings).
  - `src/core/rehearsalScore.ts` — read each exp's `lineage.txt` + parent `audit.json`, classify,
    `lineageRows` on `ScoreComputation` + return. (`rehearsalExperiment.ts`/`buildDispatchState`
    untouched — `lineage.txt` is a separate verb-side write, not part of `state.txt`.)
  - `src/core/rehearsalBrief.ts` — `StatusBriefInput.multiChange?` (instrument/exp set); top-3
    `[multi-change]` tag.
  - `config/prompt-templates/rehearsal/experiment.md` — Improve single-change note + early-round
    simplicity cue.
  - `commands/rehearsal.md` — Step 5 typed operators, diverse Draft, Improve contract, SOTA
    re-grounding, the `[multi-change]` reading note; Phase 1.5 unchanged.
  - `tests/rehearsal-*.test.ts`, `dist/consort.cjs`, the 3 version manifests.

## 9. Testing

- `diffAuditKnobs`: 0 / 1 / 2 differing mandated knobs (numeric-tolerant: `"200"` vs `"200.0"` → same);
  a key present on one side only counts as a difference.
- `classifyLineage`: no parent → `draft`; parent + 1 → `improve-single`; parent + 2 → `improve-multi`;
  parent + 0 → `improve-unverified`.
- `lineageRow` / `LINEAGE_TSV_HEADER`: exact tab layout.
- `experiment-send`: `--parent` with a valid same-lane parent → rc 0 + `lineage.txt` written; `--parent`
  to a non-existent exp → rc 1; no `--parent` → no `lineage.txt` (Draft), rc 0; the 5-positional
  contract + frozen done-contract assertions unchanged.
- `computeScore`: an exp with `lineage.txt` parent + a 2-knob audit diff → `improve-multi` row; a
  1-knob diff → `improve-single`; a parentless exp → `draft` row; `lineageRows` on `ScoreComputation`.
- `scoreWith`: writes a `lineage.tsv` snapshot (overwrite, header present) after `coverage.tsv`.
- `status-brief`: an `improve-multi` top-3 row tagged `[multi-change]`; `draft`/`improve-single`/
  `improve-unverified` NOT tagged; absent lineage → no tag (back-compat).
- finalize: an `improve-multi` row folded into `## Warnings`.
- No real subprocess/FS in unit tests; stale-token gate green; frozen schema/fields/status enum and the
  5-positional experiment-send contract untouched; scoreboard.md byte-identical.

## 10. Acceptance criteria

1. The directive gives the Maestro typed **Draft / Improve** operators; Draft uses lenses + Verbalized
   Sampling + an avoid-set; Improve declares a `--parent` and changes one variable. (directive + tests
   on the flag/lineage wiring)
2. `experiment-send --parent <exp-id>` validates a same-lane parent (rc 1 if missing), writes a
   `lineage.txt`, and keeps the 5-positional contract byte-identical.
3. `lineage.tsv` is a per-experiment snapshot (overwrite, never append) with verdict ∈
   `{draft, improve-single, improve-multi, improve-unverified}` from the audit-knob diff.
4. The status brief tags ONLY an `improve-multi` top-3 leader `[multi-change]`; the other three verdicts
   are recorded but never surfaced; absent lineage → no tag (back-compat). Finalize folds
   `improve-multi` into `## Warnings`.
5. SOTA re-grounding: `sota.md` is in the Step-5 selection inputs with a diff-vs-Coverage instruction.
6. No pre-run pairwise ranking; no hard one-variable reject; no `{{PARENT_BLOCK}}` token; no `metric.md`
   knob.
7. Frozen contracts intact: `result.json`, `status` enum, scoreboard schema + integer-rank parse,
   `experiment-send` 5 positionals, A1/A2/A3/B1 state files untouched.
8. All gates green (typecheck / vitest / lint / stale-tokens / build); version bumped; `dist` rebuilt.

## 11. Out of scope (later phases / deferred tail)

A4 (multi-seed + statistical gate), B3 (search/budget — likely CUT), C1 (independent re-implementation
inspector — which consumes the lineage edge B2 records here), a hard one-variable gate, a pre-run
pairwise judge, a re-runnable mid-loop SOTA sweep, and a typed Debug operator (parts are already
persistent interactive TUIs — AIRA²'s multi-turn-operator upgrade comes for free).
