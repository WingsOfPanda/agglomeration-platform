# Rehearsal research-validity upgrade — roadmap

**Status (updated 2026-06-04):** the **validity track (Q1) is SHIPPED** — C0 → A1 → A3 → A2, versions
0.1.12–0.1.15. The standalone **K-streak direction bug** (A4 tail) shipped in **0.1.16 (PR #38)**.
The **idea-generation track (Q2)**: **B1 (coverage & diversity) SHIPPED in 0.1.17 (PR #39)**;
**B2 (operators & ideation quality) is NEXT** (spec `2026-06-04-rehearsal-b2-operators-design.md`),
with the heavy tail (**A4 multi-seed / B3 / C1**) deferred and reconsidered after B2. Each phase is its
own `brainstorm -> spec -> plan -> ship` cycle with its own `docs/superpowers/specs/` design doc.

## Why this exists

`/consort:rehearsal` is an AIDE-style autoresearch loop: the Maestro locks a metric, sweeps SOTA,
spawns 2-3 persistent codex parts, and adaptively dispatches single-config experiment ideas until a
stop condition. Two core questions motivated a literature + codebase audit (2026-06-03):

- **Q1 (execution validity):** how do we ensure a bad metric reflects a bad IDEA, not a
  buggy/misconfigured/leaky/under-trained EXECUTION?
- **Q2 (idea coverage & direction):** how do we ensure the Maestro generates the right diverse set
  of angles and steers the next round well, rather than converging prematurely or chasing a
  misleading metric?

**The one-sentence thesis both reduce to:** a part's self-reported metric is a *claim, not evidence* —
rehearsal used to treat it as evidence. The fix is to move from honor-system trust to mechanical
gates, and to **decouple idea-quality from execution-quality: only an execution-verified negative
result may retire an angle.**

## Constraints (apply to every phase)

- **Additive only** — new optional `result.json`/`metric.md` fields, new state files, new pure
  modules. No frozen wire token renamed (event names, `END_OF_INSTRUCTION`, existing `result.json`
  field names, `contracts.yaml` keys, state filenames, `CLAUDE_CODE_SESSION_ID`). A new status
  distinction is expressed via a *derived classification or a new optional field*, never by mutating
  the frozen `status` enum.
- **Open-ended task shape (settled in A1 brainstorming).** Experiments can be anything; the part owns
  data + training + scoring. The harness CANNOT compute/verify an arbitrary metric, so **task-semantic**
  checks must be part-attested (verified later by C1), while **task-agnostic** checks (numeric bounds,
  rank parsing, label/family strings, log markers) are the mechanical teeth.
- **Explore-only preserved** — promotion to real code remains `/consort:perform`.

## The proven implementation arc (reuse for every remaining phase)

A1/A3/A2 converged on one repeatable shape — follow it:
- a **pure core module** (`rehearsalVerify`/`rehearsalSanity`/`rehearsalInfeasible`) with injected FS;
- the **score pass** (`computeScore`) computes per-experiment artifacts; `scoreWith` applies them;
- a **flat `.tsv` state file** (`verification.tsv` append / `sanity.tsv` snapshot) joined by
  `status-brief` (keyed `instrument/exp`) for a top-3 annotation;
- optional **`metric.md` fields** parsed like `verify_epsilon`/`ceiling`/`max_debug_attempts`;
- the **directive** (`commands/rehearsal.md`) drives the Maestro-side judgment + loop;
- **subagent-driven execution**: grouped implementers, spec+code review each, a final adversarial
  whole-branch review, then release (bump 3 manifests + rebuild `dist` + PR).
- **Landmine:** the scoreboard's integer-rank parsing (`/^\|\s+\d+\s+\|/`) is the load-bearing
  contract — A2's `xN` group rides it for free; B1's plateau work must respect it.

---

## SHIPPED — validity track (Q1)

### C0 · scoreboard direction fix — SHIPPED 0.1.12 (PR #33)
Fixed `buildScoreboard` sorting descending regardless of `metric.md` `**Direction:**` (botched the
leader/handoff/teardown for `minimize`). `parseMetricMd` now reads Direction; sort is best-first.

### A1 · metric trust (verify-by-re-execution) — SHIPPED 0.1.13 (PR #34)
Spec: `2026-06-03-rehearsal-a1-metric-trust-design.md`. **Reframed** from "recompute on a sealed
holdout" to verify-by-re-execution once task shape was settled as open-ended: the part declares a
`verify` block (rescore/rerun/none); the trusted Maestro re-runs that scoring step via Bash OUTSIDE
the part's pane; `verify-plan`/`verify-check` adjudicate a verdict (verified/mismatch/unavailable/
pending) into `verification.tsv`; `computeScore` snapshots a provenance `verify-manifest.json`;
`status-brief` annotates. Substrate for C1.

### A3 · sanity & integrity gates — SHIPPED 0.1.14 (PR #35)
Spec: `2026-06-03-rehearsal-a3-sanity-gates-design.md`. **Scoped** (user choice) as mechanical
task-agnostic checks + a recorded integrity attestation — the **smoke-test env gate was NOT
included** (still deferred, see below). Score pass emits ceiling / under-run / log-contradiction /
integrity-attestation-incomplete / per-experiment audit-knob-drift to a `sanity.tsv` snapshot;
`status-brief` tags `[suspect: …]`; finalize folds non-audit flags into `## Warnings`. Orthogonal to
A1. The part attests an `integrity` block (5 keys) for C1 to verify.

### A2 · INFEASIBLE-vs-REFUTED — SHIPPED 0.1.15 (PR #36)
Spec: `2026-06-04-rehearsal-a2-infeasible-design.md`. Closes the original concern. `computeScore`
derives INFEASIBLE (A1 `mismatch` ∪ A3 `{under-run, log-contradiction, audit-knob-drift}`;
ceiling/integrity stay advisory) from `verification.tsv` + flags, and `buildScoreboard` routes those
ok-rows to an `x<rank>` group out of the ranked leader set. Because completion/top-3 parse only
integer ranks, exclusion is AUTOMATIC (zero change to `checkCompletion`/`status-brief`). Directive:
bounded re-dispatch (cap `metric.md max_debug_attempts`, default 2) + Lane-D counts feasible-only.

---

## REMAINING — idea-generation track (Q2)

### B1 · Coverage & diversity guard — SHIPPED 0.1.17 (PR #39)
Spec: `2026-06-04-rehearsal-b1-coverage-diversity-design.md`. Approach-aware plateau
(`globalFlat AND familiesActive>=min_families AND familiesImproving==0`, strictly additive — kills the
single-family gameable stop) + a per-family `coverage.tsv` tally surfaced as a `**Coverage:**` line,
counting only FEASIBLE ok (B1×A2: excludes A2-infeasible). New `rehearsalCoverage` core
(`normalizeFamily` shared by tally + plateau); parse-only `min_families` knob (default 2). Original
goal below, satisfied:
*Goal:* make "did we explore enough angles?" mechanical so the loop can't converge prematurely on one
approach family.
- **Mechanical (score-pass + tsv arc):** a **`coverage.tsv`** computed in `computeScore` from each
  experiment's `approach_label` (family → count + best metric), surfaced in `status-brief`; a
  **near-duplicate-dispatch alarm** when an `approach_label` repeats a covered family; and the prize —
  **approach-aware plateau**: today's plateau (`rehearsalComplete.ts:84-88`) reads the last-5 metric
  spread *regardless of which family*, so tuning one family looks like a global plateau. B1 makes
  plateau require family stabilization, fixing a gameable stop. Track running unique-family count as a
  premature-convergence alarm.
- **Directive:** the Maestro assigns a coarse family at dispatch and is steered to cover
  under-explored families.
- *Closes:* "no mechanical coverage/diversity guard", "premature convergence unguarded",
  "plateau narrow/gameable". *Mechanism:* Si et al. diversity collapse; MAP-Elites / Quality-Diversity.

### B2 · Operators & ideation quality  (NEXT; the proven direction bottleneck; deps: B1 [done])
Spec: `2026-06-04-rehearsal-b2-operators-design.md` (approved). Directive-heavy: typed **Draft/Improve**
operators (resolves the B1×B2 tension — Draft = new family, Improve = single-change on a parent),
diverse Draft (discovery lenses + Verbalized Sampling + avoid-set), single-change Improve contract,
SOTA re-grounding into selection, run-all + post-hoc metric (no pre-run pairwise). One light advisory
mechanical piece: `--parent` flag + `lineage.tsv` (audit-knob diff), surfacing only `improve-multi`.
*Goal:* improve per-round idea quality — AIRA: "operators, not search, are the bottleneck."
- **Mechanical (small):** **one-measurable-change vs a named `parent_id`** — `experiment-send`
  validates an idea changes exactly one variable vs its parent, so a metric delta is attributable.
- **Directive/template:** **discovery lenses + verbalized sampling** in ideation (orthogonal angles,
  not three tweaks of the leader); **pairwise/Swiss ranking** for "which angle next" over absolute
  self-scores; re-ground ideation against the SOTA sweep (today write-once, decoupled from selection).
- *Closes:* "diversity prompt-enforced not mechanical", "SOTA stale and decoupled". *Mechanism:* AIRA
  operators; Nova discovery lenses; Verbalized Sampling.

---

## DEFERRED tail — reconsider after B2

### A4 · Noise & reproducibility  (cost multiplier)
Multi-seed + a paired-bootstrap/ASO statistical gate; **K-corroboration re-runs the SAME config**
(today `rehearsalComplete.ts:45-92` counts distinct at-target experiments, so a lucky seed satisfies
completion); sub-threshold deltas → "inconclusive". *Open question:* is k× compute worth it for the
user's tasks? **STANDALONE BUG — FIXED in 0.1.16 (PR #38):** the K-streak in `checkCompletion`
(`improving = mv > best`) was direction-naive (wrong for `minimize`); now `direction`-aware
(seed `+Infinity`/`mv<best` for minimize). The remaining A4 work (multi-seed + paired-bootstrap/ASO
gate) stays deferred. *Deps: A1.*

### B3 · Search, budget & steering  (lowest leverage; likely CUT)
Greedy-best-first + epsilon-revisit; ASHA cheap-fidelity rungs; periodic stage-gate re-rooting;
held-out steering + robust top-k final selection. "Greedy Is a Strong Default" says search
sophistication buys ~nothing over greedy + early-stop once operators (B2) are good — so this is the
least valuable phase and a strong cut candidate. *Deps: A1, B1.*

### C1 · Independent re-implementation inspector  (the real open-ended anti-gaming; expensive)
AIRepr-style round-trip: the cross-family Claude Maestro regenerates the experiment from the part's
structured run-card alone, re-derives the metric, AND **verifies A3's `integrity` attestation** —
only for new-best / direction-changing runs (When-To-Verify budgeting). The only mechanism that
genuinely defends an open-ended metric against a deliberately-gaming part. *Deps: A1, B2.*

## Dependency graph (remaining)

```
[C0,A1,A3,A2 done] [K-streak fixed 0.1.16] [B1 done 0.1.17]      B2 ──► C1
                                                                  └────► (A4 / B3 deferred)
```

Recommended next: ship **B2** (operators & ideation quality — spec approved), then decide A4/B3/C1's
fate (B3 likely cut; C1 is the high-value tail item and consumes the lineage edge B2 records).

## Source base

2026-06-03 triple-search literature sweep + codebase grounding (10 agents). Key references: AIDE
(arXiv:2502.13138), AIRA / AIRA-dojo (arXiv:2507.02554) + AIRA^2 (arXiv:2603.26499), "Greedy Is a
Strong Default" (arXiv:2603.27415), MLE-bench (arXiv:2410.07095), R&D-Agent (arXiv:2505.14738), Si et
al. "Can LLMs Generate Novel Research Ideas?" (arXiv:2409.04109), Nova (arXiv:2410.14255), Verbalized
Sampling (arXiv:2510.01171), the Ideation-Execution Gap (arXiv:2506.20803), AI Scientist v2
(PMC13017497) + Beel et al. (arXiv:2502.14297) + Yu et al. (arXiv:2509.08713), reward-hacking
benchmarks (arXiv:2511.21654 / 2603.11337 / 2605.02964), AIRepr (arXiv:2502.16395), When-To-Verify
(arXiv:2504.01005), Paired Bootstrap Protocol (arXiv:2511.19794), deep-significance/ASO, seed power
analysis (arXiv:1806.08295), Kapoor & Narayanan leakage (Patterns 2023), ASHA (OpenReview S1MAriC5F7),
MAP-Elites / Quality-Diversity.
