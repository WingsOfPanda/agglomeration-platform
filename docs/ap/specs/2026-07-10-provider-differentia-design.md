# Provider-differentiated research lenses plus surfaced confidence signals and adversary verdict tally for /ap:explore (worker-collaboration cluster 2). (a) Per-provider research lens — a WEIGHTING, never a partition: composeExploreResearchPrompt (src/core/exploreTurn.ts:19-83) gains a lens param keyed on provider name inside exploreTurn.ts (NOT a contracts.yaml field — frozen keys untouched): codex emphasizes repo-code evidence, runtime probes, implementation feasibility; claude emphasizes literature/web synthesis, conceptual frames, cross-domain analogues; agy/opencode/unknown get a neutral default branch. The lens text MUST include an explicit 'still cover the whole landscape' instruction — a hard partition definitionally fails confidence signal S2 at N=2 (disjoint citation vocabularies, src/core/exploreConfidence.ts:44-46,59), while weighted-but-overlapping workers pass (verified 2026-07-10, memory file explore-collab-improvement-analysis.md, P2 verdict FEASIBLE_WITH_CHANGES). Known cost the spec must own: weighting reduces expected citation overlap, raising the adversary-fire rate — the fail-safe direction. (b) Surface the five confidence signals on stdout: the confidence verb currently logs S1-S5 to stderr and prints only ALL_HOLD=<bool> to stdout (src/commands/explore.ts:253-255); additionally print S1=..S5= lines to stdout so the directive can consume per-signal identity; feed the S2 solo-citation list (soloCitations, exploreConfidence.ts:44-46 / annotations.json tokens) into the adversary prompts as PRIORITY citation-fidelity targets — sharpens the attack, never re-runs or fixes the gate (hub self-repair of S2/S4 and gate-as-loop-predicate are REJECTED per the 2026-06-22 annotations spec non-goals; do not re-propose). (c) New mechanical verb `verdict-tally <topic>`: parse the `## Verdict` line (enum needs-attention|minor-revisions|accept, src/core/exploreTurn.ts:117) from each adversary-<agent>.md, print per-agent VERDICT= lines plus a TALLY= majority line to stdout; directive Phase 8 consumes it — majority needs-attention obliges the hub to address each Material finding explicitly in the final doc and carry caveats into the Conclusion; unanimous accept permits a fast final synthesis; NEVER an automatic loop. Constraints: frozen wire protocol untouched; research prompts stay peer-material-free (isolation guard); errors to stderr; dist/ap.cjs rebuilt and committed; tests pure per repo convention (fresh AP_HOME per test).

## Problem

`/ap:explore` sends every worker a byte-identical research prompt (`composeExploreResearchPrompt`,
`src/core/exploreTurn.ts:19-83` — only the global lit-track weighting varies), so a codex+claude
pair duplicates effort instead of exploiting codex's repo/runtime strength and claude's
literature/synthesis strength. The confidence gate computes five discrete signals but discards
their identity on the wire — `S1`-`S5` go to stderr and only `ALL_HOLD=<bool>` reaches stdout
(`src/commands/explore.ts:253-255`) — so the directive cannot see WHICH signal failed, and the S2
solo-citation list (`soloCitations`, `src/core/exploreConfidence.ts:44-46`) never reaches the
adversaries who are best placed to attack exactly those weak citations. Each adversary critique
ends with a structured `## Verdict` enum (`needs-attention|minor-revisions|accept`,
`src/core/exploreTurn.ts:117`) that is never machine-read: Intervention Pattern 2 only checks the
line EXISTS, and Phase 8 summarizes critiques as prose with no consensus signal.

## Goal

After this change, a codex+claude explore run is complementary instead of redundant: each provider
researches through a lens that weights its comparative advantage (codex → repo-code evidence,
runtime probes, implementation feasibility; claude → literature/web synthesis, conceptual frames)
while an explicit still-cover-the-whole-landscape instruction keeps the lenses a WEIGHTING — never
a partition, which would definitionally fail confidence signal S2 at N=2
(`src/core/exploreConfidence.ts:44-46,59`; verified 2026-07-10, P2 verdict). The directive gains
per-signal visibility (`S1=`..`S5=` on stdout) and hands the adversaries the S2 solo-citation list
as priority citation-fidelity targets — sharpening the attack without re-running, fixing, or
looping the gate (hub self-repair of S2/S4 and gate-as-loop-predicate remain rejected non-goals per
the 2026-06-22 annotations spec). A new deterministic `verdict-tally` verb turns the adversaries'
structured verdicts into a consumable consensus signal that obliges the hub's final synthesis to
address material findings when the majority says `needs-attention`. Frozen wire protocol,
`contracts.yaml` keys, and research-phase peer isolation are untouched.

## Architecture

Three small, coherent sub-features. None adds a worker round; none changes gate semantics; all new
output is additive.

### (a) Per-provider research lenses (weighting, never partition)

A `RESEARCH_LENSES` record plus `researchLens(provider: string): string` live in
`src/core/exploreTurn.ts` — keyed on provider NAME in code, deliberately NOT a `contracts.yaml`
field (the frozen key list stays untouched; provider names are as stable as the closed provider
set):

- `codex` → "Weight your investigation toward repo-code evidence: read the implementation, run
  runtime probes/experiments where cheap, judge implementation feasibility first-hand."
- `claude` → "Weight your investigation toward literature and web synthesis: papers, RFCs, vendor
  docs, cross-domain analogues, conceptual frames."
- default (agy/opencode/unknown) → neutral: "No special emphasis — balance code and literature
  evidence as the topic demands."

EVERY lens body (including neutral) ends with the same sentence: "This is an emphasis, not a
boundary — you must still cover the WHOLE landscape; do not skip an approach because it sits
outside your emphasis." This is the load-bearing partition guard: a hard code/lit split at N=2
gives disjoint citation vocabularies → every draft citation is solo → S2 systematically false
(`src/core/exploreConfidence.ts:44-46,59`). A weighting keeps vocabularies overlapping on central
sources → S2 plausibly passes; S1 needs only ≥ N-1 findings naming the top approach
(`exploreConfidence.ts:57`), which whole-landscape coverage preserves.

`composeExploreResearchPrompt(topic, writeTo, lit)` (`src/core/exploreTurn.ts:19`) gains a 4th
param `lens: string`, rendered as its own block immediately after the `Topic:` line
(`exploreTurn.ts:25-27`) and before `Output requirements` — the same threading pattern the `lit`
block uses. `researchSendWith` (`src/commands/explore.ts:155-173`) passes
`researchLens(provider)`; `provider` is already in scope (it feeds `d.multiplier(provider)` in the
wait, `explore.ts:195`). Research prompts remain peer-material-free — isolation intact.

Accepted cost (fail-safe direction): weighting lowers expected citation overlap → more
`[unverified]` annotations and a modestly higher S2-fail rate → the adversary runs more often.

### (b) Per-signal stdout + solo-citation priority targets for the adversary

`confidenceRun` (`src/commands/explore.ts:237-266`) additionally prints one line per signal to
stdout — `S1=<bool>` .. `S5=<bool>` — BEFORE the existing `ALL_HOLD=<bool>` line (which stays last;
the directive's `sed -n 's/^ALL_HOLD=//p'` parse is unaffected). The signal values already exist in
the `Signals` object (`exploreConfidence.ts:66`); this is stdout-only, no behavior change.

`adversarySendWith` (`src/commands/explore.ts:311-328`) reads `$ART/annotations.json` (written by
the annotate verb at `explore.ts:296`, always before Phase 6) and extracts the solo-citation tokens
(`items[].token` where `kind` is `unverified` or `approaches-flagged`). Non-empty → the composer
renders a "Priority targets" block: "These citations are corroborated by only ONE worker — open
each and verify the claim it anchors first." Missing/empty annotations.json → block omitted, no
error. `composeAdversaryPrompt` carries this as an optional `priorityTargets?: string[]` field on
its `opts` parameter — additive to (and compatible with) the `opts` introduced by the cluster-1
spec (`docs/ap/specs/2026-07-10-improve-ap-explore-w-design.md`); whichever spec lands second adds
its field to the same object. This sharpens the attack on exactly the evidence the gate found weak;
it does NOT re-run, repair, or loop the gate (S2/S4 hub self-repair and gate-as-loop-predicate are
rejected non-goals, 2026-06-22 annotations spec).

### (c) `verdict-tally` — deterministic adversary consensus

New pure module `src/core/exploreVerdict.ts`:

- `parseAdversaryVerdict(text): "needs-attention" | "minor-revisions" | "accept" | "malformed"` —
  the first non-empty line under `## Verdict` (until the next `## `), trimmed and lowercased; any
  other content → `malformed`.
- `tallyVerdicts(rows: { agent: string; verdict: string }[]): { tally: string }` — majority over
  parsed enum values; ties break to the MOST severe (`needs-attention` > `minor-revisions` >
  `accept`); `skipped`/`malformed` rows are reported but excluded from the majority; zero countable
  rows → `unavailable`.

New verb `verdict-tally <topic>` in `src/commands/explore.ts`: reads `list.txt` rows; per row, if
`adversary-<agent>.txt` last `AS=skipped` (the cluster-1 guard) → verdict `skipped`, else parse
`adversary-<agent>.md`. Prints `VERDICT=<agent>:<value>` per row plus a final `TALLY=<value>` to
stdout; rc 1 only when the art dir or `list.txt` is missing.

Directive (`commands/explore.md`) Phase 8: run `verdict-tally` before authoring the final doc
(under the existing task row — no new row). Consumption rules: `TALLY=needs-attention` → the hub
MUST address every Material finding explicitly in `## Adversary critiques` and carry the surviving
caveats into `## Conclusion`; `TALLY=accept` → a fast final synthesis is permitted;
`minor-revisions`/`unavailable` → today's behavior. NEVER an automatic loop or re-dispatch — the
tally shapes the hub's prose obligations only.

### Invariants

- Frozen wire protocol untouched (no new events/sentinel/state-filename renames; no
  `contracts.yaml` changes at all in this cluster).
- Research prompts stay peer-material-free; the lens contains no peer content.
- Errors to stderr; stdout stays the machine-parsed surface (`S1..S5`, `ALL_HOLD`, `VERDICT`,
  `TALLY` lines).
- `dist/ap.cjs` rebuilt (`npm run build`) and committed — stale-dist CI gate green.

## Components

- `src/core/exploreTurn.ts` — new exported `RESEARCH_LENSES` record + `researchLens(provider)`
  (codex / claude / neutral default, each ending with the whole-landscape guard sentence);
  `composeExploreResearchPrompt` gains 4th param `lens: string` rendered after the `Topic:` line;
  `composeAdversaryPrompt` `opts` gains optional `priorityTargets?: string[]` rendering a
  "Priority targets" block (additive to the cluster-1 `opts` fields).
- `src/core/exploreVerdict.ts` — NEW pure module: `parseAdversaryVerdict(text)` (first non-empty
  line under `## Verdict`, enum or `malformed`) and `tallyVerdicts(rows)` (majority; tie → most
  severe; `skipped`/`malformed` excluded; empty → `unavailable`).
- `src/commands/explore.ts` — `researchSendWith` passes `researchLens(provider)` into the
  composer; `confidenceRun` prints `S1=`..`S5=` lines to stdout before the existing `ALL_HOLD=`
  line; `adversarySendWith` reads `$ART/annotations.json` and passes solo-citation tokens as
  `priorityTargets` (graceful omit when missing/empty); new `verdict-tally` verb (reads `list.txt`
  + per-agent `adversary-<agent>.txt`/`.md`, prints `VERDICT=<agent>:<value>` lines + `TALLY=`);
  dispatcher switch + usage string extended.
- `commands/explore.md` — Phase 5.5 documents the per-signal stdout lines; Phase 6 notes the
  priority-targets block; Phase 8 runs `verdict-tally` and applies the consumption rules
  (needs-attention majority → address every Material finding + Conclusion caveats; accept → fast
  synthesis; never a loop). No task-table change.
- `tests/explore-turn.test.ts` — updated `composeExploreResearchPrompt` call sites (new param);
  lens assertions (codex vs claude vs neutral differ; every lens contains the whole-landscape
  sentence; prompt still peer-material-free); `composeAdversaryPrompt` priority-targets block
  present when given, absent when omitted.
- `tests/explore-verdict.test.ts` — NEW: parse (each enum value, whitespace/case tolerance,
  missing heading → `malformed`); tally (majority, tie → most severe, skipped/malformed excluded,
  all-uncountable → `unavailable`).
- `tests/explore-cmd.test.ts` — `confidence` stdout carries `S1=`..`S5=` + `ALL_HOLD=` last;
  `adversary-send` with seeded `annotations.json` passes tokens (DI spy on the composed prompt
  file), without it omits the block; `verdict-tally` verb output + rc paths.
- `dist/ap.cjs` — rebuilt via `npm run build` and committed (stale-dist CI gate).

## Testing

Pure unit tests only (no live panes; fresh `AP_HOME` per test via `tests/helpers/tmpHome.ts`):

- `tests/explore-turn.test.ts` —
  - `researchLens("codex")` / `researchLens("claude")` / `researchLens("agy")` return distinct
    texts; ALL contain the exact whole-landscape guard sentence (the partition guard is asserted,
    not assumed).
  - `composeExploreResearchPrompt(t, w, lit, lens)` renders the lens block after `Topic:` and
    before `Output requirements`; output contains no peer paths or peer content; existing
    assertions (citation format, no embedded `END_OF_INSTRUCTION`) still pass at the updated call
    sites (`explore-turn.test.ts:19,64`).
  - `composeAdversaryPrompt(..., { priorityTargets: ["src/a.ts:1", "https://x"] })` renders both
    tokens under "Priority targets"; omitted/empty → block absent.
- `tests/explore-verdict.test.ts` —
  - `parseAdversaryVerdict`: `accept`, `minor-revisions`, `needs-attention` parsed (case/whitespace
    tolerant); prose verdict line or missing `## Verdict` → `malformed`.
  - `tallyVerdicts`: majority wins; 1-1 tie at N=2 → `needs-attention` over `accept` (most severe);
    `skipped` and `malformed` excluded from the count but preserved per-agent; zero countable →
    `unavailable`.
- `tests/explore-cmd.test.ts` —
  - `confidence`: stdout contains `S1=`..`S5=` lines matching the stderr-logged signals, with
    `ALL_HOLD=` as the last line (directive-parse compatibility).
  - `adversary-send`: seeded `annotations.json` (unverified + approaches-flagged items) → composed
    prompt file contains the tokens; no `annotations.json` → prompt composed without the block, rc
    unchanged.
  - `verdict-tally`: seeded N=2 art dir with two critiques → two `VERDICT=` lines + `TALLY=`;
    one `AS=skipped` row → reported `skipped`, excluded from majority; missing art dir → rc 1.
- `tests/stale-tokens.test.ts` — green (lens/verdict prose introduces no banned tokens).
- Full gate before PR: `npm run typecheck && npm run lint && npm run test && npm run build`;
  refreshed `dist/ap.cjs` committed.
- Live dogfood (post-merge, inside tmux): one codex+claude `/ap:explore` run — codex's
  `*_research_prompt.md` carries the code lens, claude's the literature lens; both findings still
  span the whole landscape; `verdict-tally` output visible in the Phase 8 transcript.

## Success Criteria

- Full gate green (`typecheck`/`lint`/`test`/`build`) with the new tests included; CI stale-dist
  byte-compare passes on the committed `dist/ap.cjs`.
- In a codex+claude run, the two `<agent>_research_prompt.md` files differ ONLY by the lens block,
  and every lens (including neutral) contains the whole-landscape guard sentence — asserted by
  unit test, observed in the dogfood.
- `confidence` stdout machine-surface: `S1=`..`S5=` lines present, `ALL_HOLD=` last; existing
  directive parse (`sed -n 's/^ALL_HOLD=//p'`) returns the same value as before the change.
- With a seeded `annotations.json`, the composed adversary prompt lists every solo-citation token
  under "Priority targets"; with none, the block is absent and behavior is byte-identical to
  pre-change.
- `verdict-tally` on a seeded run prints one `VERDICT=<agent>:<value>` line per list row plus a
  single `TALLY=` line; tie at N=2 resolves to the more severe verdict; `AS=skipped` rows never
  enter the majority.
- Gate semantics unchanged: `computeSignals` untouched, no re-run/repair path added anywhere
  (grep: no new call sites of `computeSignals` or annotate mutation) — the rejected non-goals stay
  rejected.
- Frozen-protocol audit: no changes to event names, `END_OF_INSTRUCTION`, existing state
  filenames, or `contracts.yaml`.

