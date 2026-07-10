# Resilience and accountability for /ap:explore (worker-collaboration cluster 4, panel-verified 2026-07-10 against HEAD 5da92ab): (E1) N-1 survivor continuation — new `survivors` verb after the research wait-gate: survivor = list.txt row whose findings-<agent>.md passes the SAME readIf().trim() predicate as missingListArtifacts; >=2 survivors and fewer than N -> preserve list-original.txt once then atomicWrite list.txt to survivor rows; exactly 1 -> same rewrite + DEGRADED=1 (directive branch: skip openq/diff/crossverify/rebuttal/gap — diff and crossverify-send return rc 1 below 2 agents — still run synth/annotate/confidence/single-worker adversary, stamp the design-handoff Constraints with a loud no-independent-corroboration caveat); 0 -> abort as today. TWO panel-found blockers the spec must own: the DIRECTIVE caches the worker set from init's PART= pairs (every phase 4b/4c/6/7/7b/7c dispatch must be rewritten to re-derive the set from the rewritten $ART/list.txt via grep loops, design.md-style), and Phase 9 teardown must read list-original.txt when present so the dropped worker still gets its graceful stop + archive. (E2) Worker sign-off — new Phase 8b between the Phase 8 final doc and 8a forensics (workers still live): signoff-send/signoff-wait per safe worker (latest-phase guard walk GS->RS->AS->QS->FS; one-turn cap via state-file existence like rebuttal-send; key SS; consult kind signoff:300; soft-skip SS=skipped): prompt carries the final doc Conclusion + that worker's <agent>_only bucket lines + the diff.md Agreed section (solo bucket alone under-covers consensus claims at N=2); worker confirms fair representation or flags specific misquotes to signoff-<agent>.md; hub applies AT MOST ONE correction pass to the final landscape doc BEFORE Phase 9 archive (both handoff-extract and Phase 9c read the ARCHIVED copy — the ordering is load-bearing); single fan-out, never a loop. (E3) Worker self-assessment — the research prompt gains an output requirement writing to a SEPARATE artifact selfassess-<agent>.md (per-approach confidence high/medium/low + 'claims I am least sure of' with citations); CRITICAL panel-confirmed invariant: it must NOT be embedded in findings-<agent>.md because computeSignals reads raw findings with no section scoping — the UNCERTAIN regex (exploreConfidence.ts:41) would flip S5 vacuously true and restated citations would inflate S2; confidence/annotate continue to read findings only. New pure module src/core/exploreSelfAssess.ts (parser); consumption: composeAdversaryPrompt opts gains a DISTINCT lowConfidenceClaims field rendered as its own 'Self-flagged low-confidence claims' block (do NOT fold under the solo-citation priority-targets header — semantically different), adversary-send passes the union across workers' selfassess files (missing -> omit); hub Phase 5/8 uses confidence grades for the Evidence strength column. (E4) Per-provider contribution scoreboard — new pure module src/core/exploreContribution.ts + read-only hub verb `contribution <topic>` at Phase 8a: per row of list-original.txt||list.txt, PLAIN COUNTS only (B1 spec rejects entropy/diversity metrics): claims_total = parseClaims(findings,['Approaches']).length, claims_solo = parseBucketLines(<agent>_only_items.txt).length, claims_consensus = total - solo (at N=2 NO consensus file exists — designDiff writes only <name>_only_items.txt; do not read one), peer verdicts on this worker's solo claims via designAdjudicate.parseVerdicts over the OTHER workers' crossverify-<agent>.md attributed by citationOverlaps against the owner bucket, adversary verdict via exploreVerdict.parseAdversaryVerdict, rebuttal defended/conceded best-effort, signoff flag count; missing/skipped artifacts -> zero, never error; output $ART/contribution.tsv (tab/newline-scrubbed cells) + stdout rows; strictly informational and archived — never feeds a gate, dispatch, or synthesis weighting (gate-as-loop-predicate stays rejected). (E5) Fast/slow overlap scheduling — SCOPED OUT, panel-REFUTED: every post-research phase is a global fan-in over all findings (diff membership is first-match-wins across workers — partial input misclassifies solo-vs-consensus), the all-block wait-gate is the correct design, and dispatching mid-research violates the single-slot inbox; document as a non-goal. Constraints: frozen wire protocol untouched; research-phase peer isolation intact (self-assessment is self material); errors to stderr; dist/ap.cjs rebuilt + committed; tests pure with fresh AP_HOME; every new send verb follows the soft-skip + guard conventions shipped in clusters 1-3.

## Problem

Post-cluster-3 `/ap:explore` (HEAD 5da92ab) is still all-or-nothing on worker loss: one empty
`findings-<agent>.md` blocks `synth-preliminary` (`missingListArtifacts`,
`src/commands/explore.ts:594-608`) and aborts a run the surviving workers already covered. The
final `## Conclusion` and `design-handoff.md` are hub-authored alone and never shown to any worker
(`commands/explore.md` Phase 8/9c), so a misquoted or misattributed claim ships unchecked. No run
records which provider actually contributed what — solo vs consensus claims, peer verdicts,
adversary outcomes are all on disk but never aggregated. And workers never state their own
confidence, so the hub weighs a worker's shakiest claim exactly like its strongest. A fifth idea —
overlapping a fast worker's next phase with a slow worker's research tail — was adversarially
assessed and REFUTED (every post-research phase is a global fan-in; partial-input diffs misclassify
solo-vs-consensus, `src/core/designDiff.ts:69-87`); it is a documented non-goal, not a gap.

## Goal

After this change an explore run degrades honestly instead of aborting: when a worker produces no
findings, a `survivors` pass rewrites the working list (preserving the original for teardown and
attribution), the remaining workers carry the run, and a single-survivor run completes as a loudly
caveated no-independent-corroboration survey. Accountability closes the loop at both ends: each
worker writes a self-assessment to a separate artifact the confidence gate never reads (the
panel-confirmed S5/S2 protection), the adversaries receive the self-flagged low-confidence claims
as their own distinct attack block, each worker gets one bounded sign-off turn on the final doc
before it is archived (misquotes fixed by at most one hub correction pass — a single fan-out, never
a loop), and a read-only `contribution.tsv` of plain per-provider counts rides into the archive for
`/ap:review` trending. Fast/slow overlap scheduling is explicitly out of scope (panel-refuted).
The frozen wire protocol, research-phase peer isolation, and every rejected non-goal
(gate-as-loop-predicate, entropy metrics, dedicated verifier workers) remain untouched; all new
rounds follow the guard + soft-skip conventions shipped in clusters 1-3.

## Architecture

Four features + one documented non-goal. All were adversarially verified 2026-07-10 against HEAD
5da92ab (3-agent panel; corrections below are the panel's, baked in). Everything follows the
cluster-1/3 conventions: send verbs guard on unsafe prior-phase state and soft-skip
(`<KEY>=skipped`), wait verbs short-circuit skipped rows with `.done`, all state files are
`<phase>-<agent>`-conventioned, frozen wire protocol untouched.

### (E1) N-1 survivor continuation

New verb `survivors <topic>` (hub-only, runs immediately after the research wait-gate, before
Phase 4b):

- survivor = `list.txt` row whose `findings-<agent>.md` passes the EXACT predicate
  `missingListArtifacts` uses (`readIf(...).trim()` non-empty, `src/commands/explore.ts:594-596`)
  — reuse it, do not re-implement (a whitespace-only file must not survive the filter and then
  block synthesis anyway).
- All rows survive → print `SURVIVORS=<n>`, no writes. Some dropped, ≥2 survive → write
  `list-original.txt` once (skip if it exists — crash/retry-safe), `atomicWrite` `list.txt` to the
  survivor rows (same `formatListFile` format), print `SURVIVORS=<n>` + one `DROPPED=<agent>` line
  each. Exactly 1 survivor → same rewrite + `DEGRADED=1`. Zero → rc 1 (directive aborts as today).

Panel-found blockers this spec owns:

1. **The directive caches the worker set.** `commands/explore.md` dispatches every phase from
   "the `PART=` pairs from init" — a code-level rewrite never reaches those loops. Phases
   4b/4c/6/7/7b/7c (send AND wait AND gate fan-outs) are rewritten to re-derive the worker set
   fresh from the current `$ART/list.txt` via `grep -v '^#'` TSV loops, exactly design.md's
   per-stage pattern. This is the largest directive edit in the cluster and is load-bearing.
2. **Teardown reads the original list.** Phase 9 step 1 (`stop --pairs`) reads
   `list-original.txt` when present (else `list.txt`) so a dropped worker still gets its graceful
   DONE banner + per-worker archive instead of a bannerless orphan-kill via preflight-panes.
3. **Degraded N=1 branch (net-new, no design-command precedent).** The directive skips Phase 4b
   (openq), 4c (both `diff` and `crossverify-send` return rc 1 below 2 agents — skip them
   explicitly, don't rely on the error), 7b, and 7c; it still runs synth-preliminary → annotate →
   confidence (S2 goes false naturally — all citations solo — so the adversary fires; verified
   sane at n=1: S1 = `top !== ""` since hits ≥ n-1 = 0) → the single-worker adversary turn
   (`peerFindingsPaths` empty — the composer already guards the peer block) → Phase 8. Phase 9c
   stamps `## Constraints` with: "DEGRADED RUN: single-worker survey — no independent
   corroboration, no peer verification; treat every claim as single-source."

Known accepted wart (panel-noted, minor): `handoff-extract` globs `findings-*.md`, so a dropped
worker's empty file appears in `handoff-data.kv`; harmless because the Phase 9c author reads the
landscape doc, not raw findings.

### (E2) Worker sign-off on the final doc — new Phase 8b

Between Phase 8 (final landscape doc authored) and Phase 8a (forensics), workers still live:

- `signoff-send <topic> <agent> <provider>`: one-turn cap via state-file existence (rc 1 if
  `signoff-<agent>.txt` exists — mirror `rebuttal-send`); latest-phase guard walking
  `GS→RS→AS→QS→FS` (first non-null, non-`skipped` tag; `timeout`/`failed` → `SS=skipped`
  soft-skip). Prompt (`composeSignoffPrompt` in `src/core/exploreTurn.ts`): the final doc's
  `## Conclusion` text + the worker's `<agent>_only_items.txt` bucket lines + the `## Agreed`
  section text from `diff.md` (the solo bucket alone under-covers consensus claims at N=2 — the
  Agreed bucket exists only as diff.md prose, `src/core/designDiff.ts:92-95`); ask: "confirm your
  findings are fairly represented, or flag SPECIFIC misquotes/misattributions — no new claims, no
  re-litigation; write to `signoff-<agent>.md` with `VERDICT: fair | misrepresented` first, then
  one `### Flag:` block per issue."
- `signoff-wait`: mirror of rebuttal-wait; key `SS`; `consultTimeout("signoff")` = new additive
  `CONSULT_DEFAULTS.signoff: 300`. `wait-gate <topic> signoff`.
- Consumption (directive): hub reads every `signoff-<agent>.md`; if any `misrepresented`, apply
  **at most one** correction pass to the final landscape doc — Edit the flagged passages, note the
  correction in `## Adversary critiques` — and continue. Single fan-out, never a second round
  (directive discipline, same trust model as Phase 8 itself). **Ordering is load-bearing:** the
  correction must land BEFORE Phase 9 step 2 (`teardown` archives the art dir; both
  `handoff-extract` and the Phase 9c author read the ARCHIVED copy).

In a degraded N=1 run, sign-off still runs for the single survivor (it is exactly the
misattribution check a caveated single-source survey needs).

### (E3) Worker self-assessment — separate artifact, gate-blind

- `composeExploreResearchPrompt` gains a 5th param `selfassessTo: string`; the prompt's output
  requirements add: "SECOND file — write your self-assessment to `<selfassessTo>`: per-approach
  confidence (`high`/`medium`/`low`, one line each: `<confidence>: <approach name>`), then a
  `## Least sure` section listing the claims you are least confident in, each with its
  [citation]." `researchSendWith` passes `join(art, "selfassess-" + agent + ".md")`.
- **CRITICAL panel-confirmed invariant:** the self-assessment is NEVER embedded in
  `findings-<agent>.md` and NEVER read by `computeSignals` or `buildAnnotations` (both read raw
  findings with no section scoping — embedding would flip S5 vacuously true via the UNCERTAIN
  regex, `src/core/exploreConfidence.ts:41,65`, and restated citations would inflate S2). The
  `confidence` and `annotate` verbs are UNTOUCHED.
- New pure module `src/core/exploreSelfAssess.ts`: `parseSelfAssessment(text)` →
  `{ grades: { confidence, approach }[], leastSure: string[] }` (tolerant: missing file/sections
  → empty).
- Consumption: `adversary-send` reads every `selfassess-<agent>.md` (missing → skip), unions the
  `leastSure` lines, and passes them as a NEW optional `composeAdversaryPrompt` opts field
  `lowConfidenceClaims?: string[]`, rendered as its own block — "Self-flagged low-confidence
  claims (the workers themselves are least sure of these — verify them first)" — DISTINCT from
  the solo-citation priority-targets block (semantically different sources; do not fold). Hub
  Phase 5/8: the confidence grades inform the tradeoff-matrix Reason strength and the handoff
  `## Evidence` Strength column (hub prose, no code).

### (E4) Per-provider contribution scoreboard — read-only, plain counts

New pure module `src/core/exploreContribution.ts` (`buildContribution(inputs)` → rows +
`renderContributionTsv(rows)` with tab/newline cell-scrub) and a hub-only verb
`contribution <topic>` (run at Phase 8a, after sign-off, before teardown):

- Rows = `list-original.txt` when present, else `list.txt` (dropped workers appear with their
  real counts — usually zeros).
- Per row: `claims_total` = `parseClaims(findings-<agent>.md, ["Approaches"]).length`;
  `claims_solo` = `parseBucketLines(<agent>_only_items.txt).length` (missing → 0);
  `claims_consensus` = `max(0, total - solo)` — at N=2 NO consensus file exists
  (`designDiff.ts:92-93` writes only `<name>_only_items.txt`), so it is derived, never read;
  `peer_agree`/`peer_dispute`/`peer_uncertain` = verdicts on THIS worker's solo claims parsed from
  the OTHER workers' `crossverify-<agent>.md` via the existing `designAdjudicate.parseVerdicts`
  (exact `N. TAG [cite] text` format match) and attributed to the owner bucket by
  `citationOverlaps`; `adversary_verdict` = `parseAdversaryVerdict(adversary-<agent>.md)` or
  `skipped`; `rebuttal_defended`/`rebuttal_conceded` = best-effort line counts from
  `rebuttal-<agent>.md`; `signoff` = the sign-off VERDICT or `skipped`. Missing/skipped artifacts
  → zeros/`skipped`, never an error.
- Output: `$ART/contribution.tsv` + the same rows to stdout. **Strictly informational**: archived
  with the art dir, surfaced in the Phase 10 present block, never feeds a gate, a dispatch
  decision, or synthesis weighting (gate-as-loop-predicate and B1's entropy/diversity metrics stay
  rejected — plain integer counts and enums only).

### (E5) Non-goal: fast/slow overlap scheduling — REFUTED, scoped out

Every post-research phase is a global fan-in over ALL workers' findings; diff membership is
first-match-wins across workers (`designDiff.ts:69-87`), so partial-input buckets misclassify
solo-vs-consensus; the all-block `wait-gate` (`explore.ts:803`) is the correct design; dispatching
a next-phase turn mid-research violates the single-slot inbox. Wall-clock upside at N=2-3 is
near-zero. Recorded here so it is not re-proposed.

### Invariants

- Frozen wire protocol untouched; new consult kind (`signoff`) and gate key (`SS`) are additive.
- Research-phase peer isolation intact — the self-assessment is self material written by the same
  research turn.
- `confidence`/`annotate` read `findings-<agent>.md` only (gate-blindness of `selfassess-*` is a
  tested invariant, not an accident).
- Errors to stderr; stdout stays machine-parsed (`SURVIVORS=`/`DROPPED=`/`DEGRADED=`, TSV rows).
- `dist/ap.cjs` rebuilt (`npm run build`) and committed.

## Components

- `src/commands/explore.ts` — new verb `survivors` (missingListArtifacts-predicate filter,
  `list-original.txt` preservation, atomicWrite rewrite, `SURVIVORS=`/`DROPPED=`/`DEGRADED=`
  stdout); new verbs `signoff-send`/`signoff-wait` (one-turn cap, `GS→RS→AS→QS→FS` latest-phase
  guard, key `SS`, soft-skip); new verb `contribution` (reads `list-original.txt`||`list.txt`,
  builds rows via exploreContribution, writes `$ART/contribution.tsv` + stdout);
  `researchSendWith` passes the `selfassess-<agent>.md` path into the research prompt;
  `adversarySendWith` reads all `selfassess-<agent>.md` files and passes the unioned `leastSure`
  lines as `lowConfidenceClaims`; `exploreWaitGateRun` accepts phase `signoff`; dispatcher switch
  + usage extended.
- `src/core/exploreTurn.ts` — `composeExploreResearchPrompt` gains 5th param `selfassessTo`
  (second-output-file requirement in the prompt body); new `composeSignoffPrompt(conclusion,
  soloBucketLines, agreedText, outPath)` (VERDICT: fair|misrepresented + `### Flag:` blocks, no
  new claims, no END_OF_INSTRUCTION/done-line); `composeAdversaryPrompt` opts gains
  `lowConfidenceClaims?: string[]` rendered as a distinct "Self-flagged low-confidence claims"
  block (separate from priorityTargets).
- `src/core/exploreSelfAssess.ts` — NEW pure module: `parseSelfAssessment(text)` →
  `{ grades: { confidence: "high"|"medium"|"low"; approach: string }[]; leastSure: string[] }`,
  tolerant of missing file/sections.
- `src/core/exploreContribution.ts` — NEW pure module: `buildContribution(inputs)` (plain counts:
  claims_total/solo/consensus-derived, peer agree/dispute/uncertain via
  `designAdjudicate.parseVerdicts` + `citationOverlaps` owner-bucket attribution,
  adversary_verdict via `exploreVerdict.parseAdversaryVerdict`, rebuttal defended/conceded
  best-effort, signoff verdict) + `renderContributionTsv(rows)` with tab/newline cell-scrub.
- `src/core/contracts.ts` — `ConsultKind` + `CONSULT_DEFAULTS` gain `signoff: 300`.
- `src/core/designTurn.ts` — `gateState` key union widens with `"SS"`.
- `commands/explore.md` — the load-bearing directive refactor: Phases 4b/4c/6/7/7b/7c re-derive
  the worker set from the CURRENT `$ART/list.txt` via `grep -v '^#'` TSV loops (replacing the
  cached `PART=` pairs language); new "Phase 4a — survivors" section right after the research
  wait-gate (abort on rc 1 / zero survivors; DEGRADED=1 branch skipping 4b/4c/7b/7c explicitly);
  new "Phase 8b — sign-off" section (send/wait/gate loops, the at-most-one correction pass BEFORE
  Phase 9, degraded-run note); Phase 8a gains the `contribution` run + Phase 10 surfaces the TSV
  rows; Phase 9 step 1 reads `list-original.txt` when present; Phase 9c degraded-run Constraints
  stamp; task table gains rows `4a`/`8b`; Intervention Pattern 1 lists `SS`.
- `tests/explore-cmd.test.ts` — verb-level DI cases: survivors (all-survive no-op / partial
  rewrite + list-original preservation + idempotent re-run / single-survivor DEGRADED=1 / zero →
  rc 1 / whitespace-only findings dropped); signoff-send (cap rc 1 on existing state, guard
  soft-skip per unsafe tag in the GS→RS→AS→QS→FS walk, happy path); signoff-wait (skipped fast
  path, ok/timeout/question); adversary-send lowConfidenceClaims wiring (seeded selfassess files
  → block present; none → absent); contribution (seeded full art dir → exact TSV rows; missing
  artifacts → zeros; dropped worker row from list-original.txt); confidence/annotate ignore a
  seeded `selfassess-<agent>.md` stuffed with "uncertain"/citations (S5/S2 unchanged — the
  gate-blindness invariant test).
- `tests/explore-selfassess.test.ts` — NEW: parseSelfAssessment (grades, least-sure extraction,
  missing sections, stops at next heading).
- `tests/explore-contribution.test.ts` — NEW: buildContribution counting (solo/consensus derive,
  peer-verdict attribution via overlaps, best-effort rebuttal/signoff, missing → zero);
  renderContributionTsv scrubbing.
- `tests/explore-turn.test.ts` — research prompt renders the selfassess second-file requirement;
  composeSignoffPrompt content (VERDICT line, Flag blocks, no-new-claims, no
  END_OF_INSTRUCTION); composeAdversaryPrompt lowConfidenceClaims block distinct from
  priorityTargets (both present simultaneously → two separate headers).
- `tests/explore-gate.test.ts` — `wait-gate signoff` phase rows.
- `tests/contracts.test.ts` — `consultTimeout("signoff")` default 300 + override.
- `dist/ap.cjs` — rebuilt via `npm run build` and committed (stale-dist CI gate).

## Testing

Pure unit tests only (fresh `AP_HOME` per test via `tests/helpers/tmpHome.ts`; no live panes).

- `tests/explore-cmd.test.ts` (DI spies, seeded art dirs):
  - `survivors`: all rows non-empty → `SURVIVORS=N`, `list.txt` untouched, no `list-original.txt`;
    one empty findings at N=3 → `list-original.txt` written once + `list.txt` rewritten to 2 rows
    + `DROPPED=` line; re-run after crash → `list-original.txt` NOT overwritten; N=2 with one
    empty → `DEGRADED=1`; all empty → rc 1; whitespace-only findings counts as dropped (same
    predicate as `missingListArtifacts` — asserted by reusing it in the test oracle).
  - Post-rewrite pipeline: after a survivors rewrite, `synth-preliminary`, `annotate`, and
    `confidence` pass over the survivor set (no blocker from the dropped row).
  - `signoff-send`: existing `signoff-<agent>.txt` → rc 1 (one-turn cap); each unsafe tag in the
    `GS→RS→AS→QS→FS` walk → `SS=skipped` + send spy NOT called; `skipped` tags are walked past;
    happy path → prompt file contains the Conclusion excerpt, the worker's solo bucket lines, and
    the diff.md Agreed text; OFFSET captured.
  - `signoff-wait`: `SS=skipped` fast path writes `.done` rc 0; done + non-empty
    `signoff-<agent>.md` → `SS=ok`; timeout → `SS=timeout`; question → payload captured + OFFSET
    bump (`recordWaitOutcome` contract).
  - `adversary-send`: seeded `selfassess-*.md` files → composed prompt carries the
    "Self-flagged low-confidence claims" block with the unioned lines; no selfassess files →
    block absent, behavior byte-identical.
  - **Gate-blindness invariant**: seed `selfassess-<agent>.md` stuffed with "uncertain",
    "unclear", and restated `[citation]` tokens while `findings-*.md` are confident and
    citation-disjoint → `confidence` stdout shows S5=false and the S2 value computed from
    findings alone; `annotate` markers unchanged.
  - `contribution`: fully seeded N=2 art dir (findings, buckets, crossverify files, adversary
    critiques, rebuttal, signoff) → exact expected TSV rows incl. consensus = total − solo and
    peer-verdict attribution; missing/skipped artifacts → zeros/`skipped`; with
    `list-original.txt` present the dropped worker appears as a zero row.
- `tests/explore-selfassess.test.ts` — grades parsed (`high: X` lines), `## Least sure` bullets
  extracted, missing file/sections → empty, extraction stops at the next `## ` heading.
- `tests/explore-contribution.test.ts` — `buildContribution` unit cases (counting, attribution
  via `citationOverlaps` incl. a `paper:` cite, best-effort parses); `renderContributionTsv`
  scrubs tabs/newlines inside cells.
- `tests/explore-turn.test.ts` — research prompt names BOTH output files (findings + selfassess);
  `composeSignoffPrompt` structure (VERDICT enum line first, `### Flag:` blocks, explicit
  no-new-claims sentence, no END_OF_INSTRUCTION/done-line); `composeAdversaryPrompt` with BOTH
  `priorityTargets` and `lowConfidenceClaims` renders two distinct headers.
- `tests/explore-gate.test.ts` — `wait-gate signoff`: pending/question/terminal/skipped rows.
- `tests/contracts.test.ts` — `consultTimeout("signoff")` → 300 default + override; unknown kind
  still throws.
- `tests/stale-tokens.test.ts` — green.
- Full gate before PR: `npm run typecheck && npm run lint && npm run test && npm run build`;
  refreshed `dist/ap.cjs` committed (CI stale-dist byte-compare green).
- Live dogfood (post-merge, inside tmux, after the user updates the plugin): one explore run with
  a deliberately killed worker mid-research → run completes on survivors, dropped worker archived
  gracefully from `list-original.txt`, handoff carries the degraded caveat when N=1;
  `contribution.tsv` rows in the present block; a sign-off flag visibly corrected in the final doc.

## Success Criteria

- Full gate green (`typecheck`/`lint`/`test`/`build`) with the new tests (suite grows from 1420);
  CI stale-dist byte-compare passes on the committed `dist/ap.cjs`.
- Survivor resilience, unit-proven: a seeded run with one empty `findings-<agent>.md` completes
  synthesis on the survivor set instead of blocking; `list-original.txt` preserves the full
  original roster; a single-survivor run prints `DEGRADED=1` and the directive text stamps the
  no-independent-corroboration caveat into the handoff Constraints.
- The directive no longer caches the worker set: every phase-4b/4c/6/7/7b/7c dispatch loop in
  `commands/explore.md` derives its workers from the CURRENT `$ART/list.txt` (grep-loop pattern),
  and Phase 9 teardown reads `list-original.txt` when present — verified by reading the shipped
  directive (no remaining "PART= pairs from init" dispatch language in those phases).
- Gate-blindness invariant, pinned by test: a `selfassess-<agent>.md` saturated with UNCERTAIN
  vocabulary and restated citations changes NO confidence signal and NO annotate marker
  (`computeSignals`/`buildAnnotations` still read findings only; both files untouched by diff).
- Sign-off discipline machine-enforced where possible: one turn per worker (state-file cap, rc 1
  on retry), unsafe workers soft-skipped (`SS=skipped`, send spy not called); the correction pass
  is at most one and lands before the Phase 9 archive (directive text states the ordering and its
  reason).
- `contribution.tsv`: plain integer/enum cells only (no ratios, no entropy — B1 constraint);
  derived consensus (never a read of a nonexistent N=2 consensus file); missing/skipped artifacts
  produce zeros/`skipped`, never an error; the verb is read-only (no state file it writes is read
  by any other verb — grep-verifiable).
- Adversary prompts render self-flagged low-confidence claims as a block DISTINCT from the
  solo-citation priority targets (both simultaneously → two headers, pinned by test).
- Frozen-protocol audit: no changes to event names, `END_OF_INSTRUCTION`, existing state
  filenames, or `contracts.yaml` key names (the `signoff` consult kind is an additive TS default);
  `tests/stale-tokens.test.ts` green.
- E5 (overlap scheduling) appears in the shipped directive/spec ONLY as a documented non-goal.

