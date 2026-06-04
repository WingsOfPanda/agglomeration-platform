# Rehearsal C1 — independent re-implementation inspector design

**Status:** approved design (2026-06-04), pending implementation plan. Phase **C1** of the rehearsal
research-validity roadmap (`docs/superpowers/specs/2026-06-03-rehearsal-research-validity-roadmap.md`),
the cross-cutting anti-gaming capstone. Deps: **A1** (verify substrate, 0.1.13) + **B2** (lineage edge,
0.1.18) + reuses A3's integrity attestation (0.1.14) and A2's INFEASIBLE routing (0.1.15). The largest
and most expensive phase — gated and budget-capped by design.

## 1. Problem

A1 (verify-by-re-execution) re-RUNs the part's **own** declared scoring command outside its pane and
checks the reported metric reproduces. That catches a *flaky/buggy* part — but a **deliberately-gaming**
part whose own scoring code is the gamed artifact sails through A1 as `verified` (its command
faithfully reproduces its own fabricated number). A3 records an `integrity` attestation (5 keys:
`split_before_fit`/`no_train_test_overlap`/`target_not_in_features`/`trained_steps`/`seed`) but only
checks *completeness* — it explicitly defers *verifying* the claims to C1.

C1 is the strict upgrade: the cross-family Claude Maestro **regenerates the experiment from the part's
structured run-card ALONE** (never reading the part's `code/`), **re-runs it end-to-end** (the full
AIRepr round-trip), re-derives the metric, and verifies the integrity attestation — so a fabricated or
leaky result has nothing to anchor to (an independent re-implementation produces a different number,
and the equivalence check fails). It is the only mechanism that defends an open-ended metric against a
deliberately-gaming part. Literature anchors: AIRepr (round-trip reproduction, arXiv:2502.16395),
RewardHackingAgents (the dominant attack is evaluator-tampering ~50% / leakage ~0%; the
`metric_drift_inconclusive` verdict is essential — arXiv:2603.11337), When-To-Verify (budget the
expensive check to high-stakes runs — arXiv:2504.01005 / 2602.17633).

## 2. Constraints

- **Full round-trip, gated + degrade-to-inconclusive (user choice).** C1 re-runs the experiment
  end-to-end, not just re-derives the metric over saved artifacts. Because experiments are
  explore-only and deliberately small (~50-200 LoC, fast iteration), a gated, budget-capped re-run is
  feasible for the harness's actual workload; a genuinely-expensive one hits the cap and degrades to
  `inconclusive` (never a false demotion).
- **Additive only.** New pure module (`rehearsalInspect`), new optional run-card fields (`data_spec`,
  `metric_formula`), new optional `metric.md` knobs (`c1_epsilon`, `c1_budget`), new `--authorize-inspect`
  flag, new `inspect-plan`/`inspect-check` verbs, new `inspection.tsv` state file. No frozen wire token
  renamed; `result.json` REQUIRED_FIELDS + the `verify`/`integrity` blocks, the `status` enum, the
  scoreboard schema + integer-rank parse, A1 `verification.tsv` / A3 `sanity.tsv` / B1 `coverage.tsv` /
  B2 `lineage.tsv` producers — all untouched. C1 does NOT reinterpret A1's `verify` semantics; it is a
  new sibling.
- **Explore-only — hard.** The re-implementation writes only into a scratch dir under the art tree
  (`experiments/<exp>/c1/`), NEVER the user repo, NEVER via `/consort:perform` (which writes real
  branches). The DANGER honor-system sandbox banner applies (the re-impl runs arbitrary code).
- **Cross-family — required.** AIRepr's self-evaluation-bias finding makes a same-family inspector a
  non-starter. The Claude Maestro re-implementing a codex part satisfies this for free; C1 warns if the
  inspector ever resolves same-family as the part under inspection.
- **YAGNI.** Rejected: held-out unit-test harness, a reward-hack classifier / exploit taxonomy,
  evaluator hash-locking + pristine-reference infra, multi-seed re-runs (that is A4), a spawned
  inspector *part* (the Maestro-Bash re-impl is already cross-family and far cheaper), Weaver-style
  weak-verifier ensembles, α/β online error control (the trigger is a trivial new-best gate at 2-3
  parts). Recorded so a future audit doesn't re-add them.

## 3. Architecture

C1 reuses the A1 verb skeleton and the proven score-pass + tsv arc:
1. A new pure `rehearsalInspect` module owns the three-way verdict classify + the integrity
   cross-check + the `inspection.tsv` row I/O. It reuses A1's `recomputedFromOutput` (the
   `VERIFY_METRIC=` marker parse) and an epsilon-compare.
2. Two verbs `inspect-plan` / `inspect-check` mirror `verify-plan`/`verify-check`. `inspect-plan` gates
   (authorized? budget left? run-card sufficient?) and either writes an early terminal row or prints
   the run-card + scratch dir + an INSPECT instruction; the Maestro authors fresh code, obtains data
   per `data_spec`, re-runs, tees stdout; `inspect-check` adjudicates into `inspection.tsv`.
3. `computeScore` reads `inspection.tsv`; a confident `not-reproduced` / `integrity-refuted` derives an
   `infeasibleReason` (the A2 routing) so the row leaves the ranked leader set; `status-brief` tags the
   top-3; finalize folds it into `## Warnings`.
4. The directive (`commands/rehearsal.md` Step 3.5b) drives the gated, Maestro-authored round-trip.

## 4. Data model

### 4.1 Run-card enrichment (the round-trip prerequisite)

Two optional additive `result.json` fields (mirroring how `integrity`/`self_reported_*`/`verify` were
added — `validateResult`'s REQUIRED_FIELDS + invariants untouched; absent → C1 → `inconclusive`):
- **`data_spec`** — enough to obtain the SAME data + split: `{ source, split_seed?, split_hash?,
  target_column?, feature_columns? }` where `source` is a dataset id / URL / builtin name. Enables the
  re-run AND the integrity cross-check (a reconstructed split that contradicts the attested
  `split_before_fit`/`no_train_test_overlap` → `integrity-refuted`).
- **`metric_formula`** — a precise metric computation string (e.g. "macro-F1, positive class = 1") so
  the independently re-derived number is comparable to the reported one (avoids a false mismatch from
  macro-vs-micro / normalization differences).

The experiment template (`config/prompt-templates/rehearsal/experiment.md`) asks the part to emit both
for any result it expects to be a leader, telling it (RoT-style) "write these so an independent
implementer can reproduce your result from them alone — they are re-run by a cross-family inspector."

### 4.2 The verdict (pure, three-way)

`Inspection` verdict ∈ `reproduced` | `not-reproduced` | `inconclusive` (the `metric_drift_inconclusive`
lesson — never collapse benign nondeterminism into a demotion):
- **`reproduced`** — the re-run completed and `|reimpl_metric - reported| <= c1_epsilon`.
- **`not-reproduced`** — the re-run completed and the metrics disagree beyond `c1_epsilon` (a strong
  gaming/irreproducibility signal), OR the integrity cross-check is refuted (the reconstructed split
  contradicts an attested integrity claim).
- **`inconclusive`** — the re-run could NOT complete a confident comparison: run-card insufficient
  (`data_spec`/`metric_formula` absent), data unobtainable, re-run errored, over budget/time, or the
  metric landed in a gray band. Advisory only — NEVER demotes.

`classifyInspect({ reimplMetric, runFailed, reported, epsilon, integrityRefuted })` returns the verdict
+ a reason string. Pure, in `rehearsalInspect.ts`. Reuses the `checkVerify` epsilon shape but adds the
third bucket and the integrity input.

### 4.3 `inspection.tsv` — append (distinct from verification.tsv)

`INSPECTION_TSV_HEADER = "exp_id\tinstrument\tverdict\treason\treimpl_metric\tts\n"`; `inspectionRow(r)`
serializer; `appendInspectionRow` mirrors A1's `appendVerificationRow` (read-or-seed header,
atomic-write `prior + row`, + a per-exp `inspection.txt` sidecar). A **distinct** file from
`verification.tsv` so a C1 disagreement (independent re-implementation) is never conflated with an A1
`mismatch` (the part's own rescore) — different meaning, different tag, different verdict namespace.

### 4.4 INFEASIBLE routing (the gate) + the brief tags

`computeScore` reads `inspection.tsv` via a new `parseInspections(tsv)` (instr/exp → latest verdict,
mirroring `parseVerdicts`). A `not-reproduced` verdict derives an `infeasibleReason = "reimpl-mismatch"`
**in addition to** the A1/A3-derived one (precedence: any infeasible source sets the row infeasible):
`scoreRow.infeasibleReason = classifyInfeasible(a1Verdict, flags) ?? inspectInfeasibleReason(c1Verdict)`
where `inspectInfeasibleReason` returns `"reimpl-mismatch"` for `not-reproduced`, else null. So a
confident C1 disagreement routes the row to the `x<rank>` group (out of the leader set, never crowned),
classified as "couldn't be independently reproduced" — NOT refuted (re-dispatchable). `inconclusive`
and `reproduced` do NOT set `infeasibleReason`.

`status-brief` joins `inspection.tsv` into an `inspections` map (instr/exp → verdict) and the top-3
render appends a tag after the A1/A3/B2 tags: `[reimpl-ok]` (reproduced) / `[reimpl-mismatch!]`
(not-reproduced) / `[reimpl-inconclusive]` (inconclusive). Only these three; absent → no tag.

### 4.5 `metric.md` knobs (parse-only)

- **`c1_epsilon`** — the round-trip tolerance, parsed like `verify_epsilon`. Default **looser** than
  `verify_epsilon` (independent re-implementations legitimately vary more than a deterministic re-run):
  default `2 × (verify_epsilon ?? 0.01)` in the caller, i.e. **0.02** absent any config.
- **`c1_budget`** — hard per-session cap on C1 inspections (default **2**). When the cap is hit,
  `inspect-plan` returns a terminal `inconclusive reason=budget-exhausted` row (visible — no silent
  skip; `inconclusive` never demotes).

Both parse-only (added to `MetricThresholds` + `parseMetricMd`, NOT `formatMetricBlock`), like every
prior A/B knob.

## 5. The verbs + the gate

### 5.1 `inspect-plan <topic> <instrument> <exp> [--authorize-inspect]`
Reads `result.json` + `metric.md`. Gates (in order, each → an early terminal row, no run). All
terminal rows use the `inconclusive` verdict (the reason string carries the distinction; `inconclusive`
never demotes — only a `not-reproduced` does, so a deferred/capped inspection is safe by construction.
`pending` is an A1 `Verdict` value, NOT an `InspectVerdict` — C1's namespace is reproduced /
not-reproduced / inconclusive):
- not `--authorize-inspect` → `inconclusive reason=inspect-deferred` (Maestro hasn't deemed it new-best).
- C1 rows in `inspection.tsv` ≥ `c1_budget` → `inconclusive reason=budget-exhausted`.
- `data_spec` or `metric_formula` absent → `inconclusive reason=run-card-insufficient`.
- inspector resolves same-family as the part → `inconclusive reason=same-family`.
Otherwise prints `INSPECT_CWD=<exp-dir>/c1`, the run-card (the `data_spec` + `metric_formula` +
`approach_label`/`approach_brief` + `metric_name` + the reported `metric_value` + the `integrity`
claims) and an instruction for the Maestro to author fresh code there, obtain the data, re-run, and
emit `VERIFY_METRIC=<n>` as the last stdout line.

### 5.2 `inspect-check <topic> <instrument> <exp> (--stdout-file <path> | --run-failed) [--integrity-refuted]`
Reads the reported `metric_value` + `c1_epsilon` (`2× verify_epsilon` default), runs
`recomputedFromOutput` over the teed stdout (the `VERIFY_METRIC=` marker — reused from A1), calls
`classifyInspect`, writes the `inspection.tsv` row, prints `VERDICT=… reason=…`. `--run-failed` →
`inconclusive reason=reimpl-failed`. `--integrity-refuted` (the Maestro found the reconstructed split
contradicts an attested claim) → `not-reproduced reason=integrity-refuted`.

### 5.3 The directive — Step 3.5b (after the A1 verify 3.5a-f, before Step 4)
Fires ONLY when the just-landed result is a NEW-BEST leader (the same Maestro judgment that gates A1's
`--authorize-rerun`) AND A1-verified AND not `[suspect]`. The Maestro: `inspect-plan … --authorize-inspect`;
if it prints `INSPECT_CWD=`, author fresh independent code in that scratch dir (NOT reading the part's
`code/`), obtain the data per `data_spec`, re-run end-to-end with a timeout, tee stdout; cross-check the
integrity claims against the reconstructed split; `inspect-check …` (add `--integrity-refuted` if a
claim is contradicted). The verdict annotates the next status-brief; a `not-reproduced` leader is
demoted (A2 INFEASIBLE) and the idea re-dispatched; an `inconclusive` is noted, not acted on.

## 6. Flow

1. A new-best result lands → `score` → A1 verify (3.5a-f) → if A1-verified + not-suspect + new-best:
2. Step 3.5b: `inspect-plan --authorize-inspect`. If gated → terminal row (deferred / budget /
   insufficient / same-family) and stop. Else → run-card + scratch dir printed.
3. Maestro authors fresh code in `experiments/<exp>/c1/`, obtains data, re-runs, tees stdout,
   cross-checks integrity.
4. `inspect-check` → three-way verdict in `inspection.tsv`.
5. Next `score`: `computeScore` reads `inspection.tsv`; `not-reproduced` → `infeasibleReason
   reimpl-mismatch` → `x<rank>` (demoted, re-dispatchable, NOT refuted). `status-brief` tags the row;
   finalize folds `not-reproduced` into `## Warnings`. `reproduced`/`inconclusive` annotate only.

## 7. Boundaries — what C1 does NOT do

- Does **not** read the part's `code/` (the whole point — independence).
- Does **not** write outside `experiments/<exp>/c1/`, never the user repo, never via `/consort:perform`.
- Does **not** demote on `inconclusive` (advisory only) — only a confident `not-reproduced` gates.
- Does **not** add a `status` enum value, change the scoreboard schema / integer-rank parse, or touch
  the A1/A3/B1/B2 producers or `result.json` REQUIRED_FIELDS.
- Does **not** spawn an inspector part, hash-lock evaluators, run held-out tests, or multi-seed (A4).
- Does **not** re-run automatically on every result — only gated new-best leaders, capped by `c1_budget`.

## 8. Files

- **New:** `src/core/rehearsalInspect.ts` — `Inspection` verdict type, `classifyInspect`,
  `inspectInfeasibleReason`, `parseInspections`, `InspectionRow`, `INSPECTION_TSV_HEADER`,
  `inspectionRow`.
- **Modified:**
  - `src/commands/rehearsal.ts` — `inspect-plan`/`inspect-check` verbs + their deps + dispatch cases +
    `appendInspectionRow`; `statusBriefWith` (inspection.tsv join → `inspections` map); finalize
    (`not-reproduced` → Warnings, BOTH the warnings.txt write AND the render branch). **`scoreWith` is
    NOT modified** — `inspection.tsv` is append-produced by the `inspect-check` verb (like A1's
    `verification.tsv`), not a computeScore snapshot.
  - `src/core/rehearsalScore.ts` — read `inspection.tsv` via `parseInspections`; set `infeasibleReason`
    from `inspectInfeasibleReason` when A1/A3 didn't already (`?? `).
  - `src/core/rehearsalResult.ts` — `ResultJson` gains optional `data_spec?`/`metric_formula?` (no
    REQUIRED change; `validateResult` ignores unknown-optional, as with `integrity`).
  - `src/core/rehearsalMetric.ts` — `c1_epsilon` + `c1_budget` in `MetricThresholds` + `parseMetricMd`
    (NOT `formatMetricBlock`).
  - `src/core/rehearsalBrief.ts` — `StatusBriefInput.inspections?` + the `[reimpl-*]` top-3 tag.
  - `config/prompt-templates/rehearsal/experiment.md` — the `data_spec` + `metric_formula` run-card
    asks (RoT-style).
  - `commands/rehearsal.md` — Step 3.5b (gated round-trip) + the `[reimpl-*]` reading note + the
    `c1_epsilon`/`c1_budget` Phase-1 mention.
  - `tests/rehearsal-*.test.ts`, `dist/consort.cjs`, the 3 version manifests.

**Note on `inspection.tsv` production:** unlike the A3/B1/B2 snapshot tsvs (re-walked by computeScore),
`inspection.tsv` is **append-produced by the `inspect-check` verb** (like A1's `verification.tsv`),
because a C1 inspection is an out-of-band per-leader event, not a re-walk-derived aggregate.
`computeScore` only READS it (mirroring how it reads `verification.tsv`).

## 9. Testing

- `classifyInspect`: within epsilon → `reproduced`; beyond epsilon → `not-reproduced`; `runFailed` →
  `inconclusive reason=reimpl-failed`; `integrityRefuted` → `not-reproduced reason=integrity-refuted`;
  null reimpl (no marker) → `inconclusive`.
- `inspectInfeasibleReason`: `not-reproduced` → `"reimpl-mismatch"`; `reproduced`/`inconclusive`/absent
  → null.
- `parseInspections`: instr/exp → latest verdict, header/blank skipped, last-write-wins.
- `inspectionRow`/`INSPECTION_TSV_HEADER`: exact tab layout.
- `inspect-plan`: `--authorize-inspect` absent → `inconclusive inspect-deferred`; budget hit →
  `inconclusive budget-exhausted`; `data_spec`/`metric_formula` absent → `inconclusive
  run-card-insufficient`; same-family → `inconclusive same-family`; happy path → prints `INSPECT_CWD=`
  + run-card. (All gated rows are `inconclusive` — never demote; see §5.1.)
- `inspect-check`: `--stdout-file` with a `VERIFY_METRIC=` marker within/beyond `c1_epsilon` →
  reproduced/not-reproduced row; `--run-failed` → inconclusive; `--integrity-refuted` → not-reproduced.
- `computeScore`: an exp with an `inspection.tsv` `not-reproduced` verdict → `infeasibleReason
  reimpl-mismatch` → routed to the `x<rank>` group (regression: `checkCompletion` ignores it, no change
  to that module); `reproduced`/`inconclusive` stay ranked.
- `status-brief`: a `not-reproduced` top-3 row tagged `[reimpl-mismatch!]`; `reproduced` → `[reimpl-ok]`;
  `inconclusive` → `[reimpl-inconclusive]`; absent → no tag (back-compat).
- `metric.md`: `c1_epsilon`/`c1_budget` parse (defaults 0.02 / 2); `formatMetricBlock` byte-unchanged.
- finalize: a `not-reproduced` row folded into `## Warnings` (render branch + the warnings.txt write —
  BOTH halves, per the B2 final-review landmine).
- No real subprocess/FS in unit tests; stale-tokens green; frozen schema/fields/status enum + the
  scoreboard integer-rank contract untouched.

## 10. Acceptance criteria

1. The part can emit optional `data_spec` + `metric_formula`; absent → C1 returns `inconclusive
   reason=run-card-insufficient` (never a false demotion).
2. `inspect-plan`/`inspect-check` mirror the A1 verb skeleton; `inspect-plan` gates on
   `--authorize-inspect` + `c1_budget` + run-card sufficiency + cross-family, emitting visible terminal
   rows (no silent skip).
3. The three-way verdict is correct: `reproduced` / `not-reproduced` (metric beyond `c1_epsilon` OR
   integrity-refuted) / `inconclusive` (couldn't complete). Tested.
4. A confident `not-reproduced` routes the row to the `x<rank>` infeasible group (demoted, not refuted)
   via `infeasibleReason reimpl-mismatch`; `inconclusive`/`reproduced` do not demote. Status-brief tags
   `[reimpl-*]`; finalize folds `not-reproduced` into the rendered `## Warnings`.
4b. `inspection.tsv` is a distinct file from `verification.tsv` (C1 vs A1 verdicts never conflated).
5. `c1_epsilon` (default 0.02 = 2× verify_epsilon) + `c1_budget` (default 2) parse; `formatMetricBlock`
   byte-unchanged.
6. Explore-only holds: the re-impl writes only under `experiments/<exp>/c1/`; the directive never
   routes through `/consort:perform` or the user repo.
7. Frozen contracts intact: `result.json` REQUIRED_FIELDS + `verify`/`integrity`, `status` enum,
   scoreboard schema + integer-rank parse, A1/A2/A3/B1/B2 state files untouched.
8. All gates green (typecheck / vitest / lint / stale-tokens / build); version bumped; `dist` rebuilt.

## 11. Out of scope (later / deferred tail)

A4 (multi-seed + paired-bootstrap/ASO statistical gate — C1 does ONE independent re-run, not a seed
matrix), B3 (search/budget — likely CUT), a spawned cross-family inspector *part* (Option B — an opt-in
`--c1-inspector <provider>` escalation only if the Maestro-Bash re-impl proves insufficient), evaluator
hash-locking / pristine-reference benchmark infra, a reward-hack classifier, and held-out unit tests.
This is the last roadmap phase; anything beyond is new scope needing its own spec.
