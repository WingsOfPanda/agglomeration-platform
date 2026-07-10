# Diff-based peer machinery for /ap:explore: cross-verification, bounded rebuttal, and post-gate gap enrichment (worker-collaboration cluster 3 — the substantial one; depends on the cluster-1 spec 2026-07-10-improve-ap-explore-w-design.md for the timeout-dispatch guard/soft-skip pattern and on the cluster-2 spec 2026-07-10-provider-differentia-design.md for per-signal stdout + verdict parsing; implementation order cluster1 -> cluster2 -> cluster3). (P1) Peer cross-verify round between research and synthesis: port design's N-way diff to explore — generalize parseClaims (src/core/designDiff.ts:4-19) with a headings parameter defaulting to ['Claims'] so design does not regress; explore passes ['Approaches'] whose lines are already the exact `N. [cite] text` shape (src/core/exploreTurn.ts:36-38); fix citationOverlaps (designDiff.ts:22-40) mishandling `paper:<id>` citations (identical paper cites currently compare non-overlapping because aPath becomes 'paper' and the numeric-line check fails — add a paper: exact-match branch like runtime:). New explore verbs diff / crossverify-send / crossverify-wait reusing verifyScopeFiles (src/core/design.ts:137-149) + composeVerifyPrompt (src/core/designTurn.ts:162-192) + the recordWaitOutcome pattern; key VS; peer-DISPUTED claims are marked CONTESTED in the draft (organic S3 evidence — transparency, never erasure); gate-neutral by construction (S2 counts findings-*.md only; crossverify-<agent>.md is not a findings file). (P4) Bounded rebuttal round after the adversary gate: select only needs-attention critiques (parse via cluster-2's exploreVerdict); attribute each Material finding to its originating worker via bucket membership (citation tokens in the finding overlap claims in exactly one <agent>_only bucket; zero or ambiguous -> unattributed, no rebuttal, hub handles as today); rebuttal-send guards on AS not in timeout/failed and refuses a second round (state-file existence is the cap); one defend-or-concede turn, no counter-attack; key RS. (P5-reframed) Post-gate gap enrichment: when cluster-2's surfaced S1 or S2 is false, send each safe worker the peer-only buckets ('confirm with your own evidence, extend, or refute'); answers gap-<agent>.md feed ONLY the final landscape doc and design-handoff Evidence — NEVER re-synthesize the draft, re-run the confidence gate, or loop to flip signals (gate-as-loop-predicate and post-hoc S2 flipping are REJECTED per the 2026-06-22 annotations spec; the gate ran once and its record stands); key GS. Timeouts: crossverify reuses consultTimeout('verify')=300; CONSULT_DEFAULTS gains rebuttal:300 and gap:600 (src/core/contracts.ts:61). gateState key union widens with RS and GS (src/core/designTurn.ts:147). wait-gate gains phases crossverify/rebuttal/gap. Each round soft-skips independently (empty scope, unsafe worker, or trigger not firing -> <KEY>=skipped, mirror of design.ts:310/:337). All state files new and <phase>-<agent>-conventioned; frozen wire protocol untouched; research-phase isolation untouched; errors to stderr; dist/ap.cjs rebuilt and committed; tests pure with fresh AP_HOME per test.

## Problem

`/ap:explore` has no per-claim peer machinery: solo claims marked `[unverified]` by annotate
(`src/core/exploreAnnotate.ts:57-80`) are never verified by the other worker, adversary critiques
get no rebuttal from the claim's author (the hub adjudicates alone at Phase 8), and when the
confidence gate fails on low overlap the run learns nothing from the gap — each worker never sees
what its peer found that it missed. The sibling `/ap:design` already has the needed machinery
(`diffFindings` bucketing + `verifyScopeFiles` + `composeVerifyPrompt`,
`src/core/designDiff.ts:53-108`, `src/core/design.ts:137-149`, `src/core/designTurn.ts:162-192`),
but it cannot be reused as-is: `parseClaims` gates on a `## Claims` heading explore findings never
contain (`designDiff.ts:8` vs the explore schema at `src/core/exploreTurn.ts:32-58`), so the diff
returns empty buckets; and `citationOverlaps` mishandles explore's `paper:<id>` citation format —
two IDENTICAL paper citations compare as non-overlapping because the path component becomes
`paper` and the line-range check fails on `arxiv:...` (`designDiff.ts:27-39`), silently inflating
every solo/peer-only set.

## Goal

After this change explore gains design-grade per-claim collaboration built on one ported diff: a
cross-verify round between research and synthesis in which each worker AGREE/DISPUTE/UNCERTAINs the
claims only its peers made (claude checks codex and vice versa), with peer-DISPUTED claims marked
CONTESTED in the draft as organic evidence — transparency, never erasure; a bounded rebuttal round
after the adversary gate in which the author of an attacked claim gets exactly one defend-or-concede
turn, selected only for `needs-attention` critiques whose findings attribute cleanly to one worker
via bucket membership; and a post-gate gap-enrichment round, fired only when surfaced signal S1 or
S2 is false, whose confirm/extend/refute answers feed ONLY the final landscape doc and the
design-handoff Evidence — never re-synthesizing the draft, re-running the gate, or looping to flip
signals (rejected non-goals of the 2026-06-22 annotations spec stay rejected). Every round
soft-skips independently on empty scope, unsafe worker state, or an unfired trigger, so a run
without the preconditions is byte-identical in cost to today. This spec depends on the cluster-1
spec (`docs/ap/specs/2026-07-10-improve-ap-explore-w-design.md` — guard/soft-skip pattern) and the
cluster-2 spec (`docs/ap/specs/2026-07-10-provider-differentia-design.md` — per-signal stdout +
verdict parsing); implementation order is cluster 1 → 2 → 3. All components live in THIS repo at
the paths named in Components.

## Architecture

One ported diff, three rounds that consume it. All rounds are send→background-wait→wait-gate
phases in the exact shape of the existing research/adversary machinery
(`src/commands/explore.ts:155-207,306-354`), inherit the cluster-1 timeout-dispatch guard
(never send to a worker whose previous phase ended `timeout`/`failed` — soft-skip
`<KEY>=skipped`, mirror of `src/commands/design.ts:310,337`), and add only new
`<phase>-<agent>`-conventioned state files. Frozen wire protocol and research-phase isolation are
untouched.

### Foundation: the ported diff

- `parseClaims(findings)` (`src/core/designDiff.ts:4-19`) gains an optional second parameter
  `headings: string[] = ["Claims"]` — a claim line is `N. [cite] text` under ANY listed heading.
  Design call sites pass nothing (zero regression); explore passes `["Approaches"]`, whose lines
  the research prompt already mandates in exactly that shape
  (`1. [<citation>] <approach name> — <one-line description>`, `src/core/exploreTurn.ts:36-38`).
  Tradeoff bullets (dash-prefixed, free-form citation placement) are deliberately NOT diffed —
  the Approaches section is the claim-shaped, load-bearing landscape content.
- `citationOverlaps` (`designDiff.ts:22-40`) gains a `paper:` branch mirroring the existing
  `runtime:` branch (`if (a.startsWith("paper:") || b.startsWith("paper:")) return a === b;`
  before the path split). Today two identical `paper:arxiv:2401.04088` citations return FALSE
  (path component `paper` matches, but line component `arxiv:2401.04088` fails the numeric check,
  `designDiff.ts:37`). This is a correctness fix that also benefits design.
- New verb `diff <topic>` in `src/commands/explore.ts`: reads `list.txt` +
  `findings-<agent>.md` (art-flat, `explore.ts:163`), calls
  `diffFindings(workers)` (`designDiff.ts:53`) with the explore extractor, writes `$ART/diff.md`
  plus the standard bucket files (`<agent>_only_items.txt`; N=3 adds `consensus.txt` +
  `<a>+<b>_only.txt`) — same filename conventions as design, in explore's own art dir. rc 1 if
  `diff.md` exists (rm to retry) or a findings file is missing.

### Round 1 (P1) — cross-verify, new Phase 4c (between research gate and synthesis)

- `crossverify-send <topic> <agent> <provider>`: guard on `research-<agent>.txt` last `FS=`
  (`timeout`/`failed` → `VS=skipped`); scope = `verifyScopeFiles(agent, agents)`
  (`src/core/design.ts:137-149`) — the buckets where this worker is NOT a member; empty scope →
  `VS=skipped`. Else write `crossverify-claims-<agent>.txt`, compose via `composeVerifyPrompt`
  (`src/core/designTurn.ts:162-192` — its `[cite] text` item format is exactly the bucket-line
  shape `designDiff.ts:83` emits) with output path `$ART/crossverify-<agent>.md`, capture
  `OFFSET=` into `crossverify-<agent>.txt`, send.
- `crossverify-wait`: skipped-already fast path, else `liveOutboxWait` +
  `recordWaitOutcome(..., "VS", ...)` + `.done`; timeout `scaledTimeout(consultTimeout("verify"))`
  (existing kind, 300s base). `wait-gate <topic> crossverify` gates the phase (key `VS`, already in
  `gateState`'s union).
- Consumption (directive Phase 5): the hub reads every `crossverify-<agent>.md` while authoring
  `landscape-draft.md`; a claim DISPUTED by its verifying peer MUST be marked CONTESTED in the
  draft — organic input to signal S3, surfacing disagreement rather than erasing it. Gate-neutral
  by construction: S2 counts citations against `findings-*.md` only
  (`src/core/exploreConfidence.ts:44-46`), and `crossverify-<agent>.md` is not a findings file.

### Round 2 (P4) — bounded rebuttal, new Phase 7b (between adversary gate and Phase 8)

- Selection: parse each `adversary-<agent>.md` verdict via the cluster-2 module
  (`src/core/exploreVerdict.ts` `parseAdversaryVerdict`); only `needs-attention` critiques
  proceed.
- Attribution: new pure module `src/core/exploreRebuttal.ts` —
  `attributeFinding(findingText, buckets: Map<agent, Claim[]>): string | null`: extract citation
  tokens from the finding's `Targets:`/`Why vulnerable:` text (the `draftCitations` regex,
  `src/core/exploreConfidence.ts:22-27`); a token that `citationOverlaps` a claim in exactly ONE
  agent's `<agent>_only` bucket attributes the finding to that agent; zero matches or a tie →
  `null` (unattributed — no rebuttal, the hub weighs it alone as today). This is the concrete
  substrate the blended draft lacks: attribution comes from the diff buckets, never from guessing.
- `rebuttal-send <topic> <agent> <provider>`: guard on `adversary-<agent>.txt` last `AS=`
  (`timeout`/`failed` → `RS=skipped`); no findings attributed to this agent → `RS=skipped`;
  `rebuttal-<agent>.txt` already existing refuses a second round (rc 1 — the one-turn cap). Else
  `composeRebuttalPrompt` (in `exploreRebuttal.ts`): the worker's own attributed claims + the
  critiques against them; "defend each with evidence or concede it explicitly — one turn, no
  counter-attacks, no new claims; write to `$ART/rebuttal-<agent>.md`". OFFSET capture, send.
- `rebuttal-wait`: mirror, key `RS` (`gateState` union widened, `src/core/designTurn.ts:147`);
  timeout = new `CONSULT_DEFAULTS.rebuttal: 300` (`src/core/contracts.ts:61`).
  `wait-gate <topic> rebuttal`.
- Consumption (Phase 8): a conceded critique stands as-is; a defended critique is weighed WITH the
  defense in `## Adversary critiques` and the Conclusion caveats.

### Round 3 (P5-reframed) — post-gate gap enrichment, new Phase 7c (after rebuttal, workers live)

- Trigger: the per-signal stdout from cluster 2 — fire only when `S1=false` OR `S2=false` was
  recorded at Phase 5.5. Gate already ran; its record (`adversary-skip.txt`) stands untouched.
- `gap-send <topic> <agent> <provider>`: guard on the worker's latest phase state (`AS=`, falling
  back to `FS=` when the adversary was skipped for it) — unsafe → `GS=skipped`; scope =
  `verifyScopeFiles(agent, agents)` peer-only buckets (what the peers found that this worker
  didn't); empty → `GS=skipped`. Prompt: "your fellow workers surfaced these approaches you did not
  cover — for each, CONFIRM with your own evidence, EXTEND, or REFUTE; write to
  `$ART/gap-<agent>.md`; this feeds only the final landscape doc." (`composeGapPrompt` lives in
  `src/core/exploreTurn.ts` beside the other prompt builders.)
- `gap-wait`: mirror, key `GS`; timeout = new `CONSULT_DEFAULTS.gap: 600` (investigation-flavored).
  `wait-gate <topic> gap`.
- Consumption: Phase 8 reads `gap-<agent>.md` into the final doc's Approaches/Tradeoffs revisions
  and the design-handoff `## Evidence`. HARD anti-goals, stated in the directive: the draft is
  never re-synthesized, `confidence` is never re-run, no signal is retroactively flipped —
  gate-as-loop-predicate and post-hoc S2 repair are rejected non-goals (2026-06-22 annotations
  spec) and this round exists to enrich the OUTPUT, not to satisfy the gate.

### Sequencing and cost

Escalated-run phase order becomes: research (4) → [openq 4b, cluster 1] → crossverify (4c) →
synthesis (5) → annotate (5b) → confidence (5.5) → adversary (6/7) → rebuttal (7b) → gap (7c) →
final synthesis (8). Worst case adds three bounded rounds (~300s+300s+600s base, scaled by
provider multiplier); each fires only when its precondition holds (non-empty peer buckets;
attributed needs-attention critiques; S1/S2 false) and soft-skips otherwise, so a clean convergent
run pays nothing. The directive's task table gains rows `4c`, `7b`, `7c`; `VS`/`RS`/`GS` question
events route through the existing Intervention Pattern 1.

### Invariants

- Frozen wire protocol untouched; all state files new, `<phase>-<agent>`-conventioned.
- Single-slot inbox: every send verb guards on the previous phase's state (cluster-1 pattern) and
  targets only wait-gate-terminal workers.
- Research-phase isolation untouched — peer material flows only in post-research rounds.
- `dist/ap.cjs` rebuilt (`npm run build`) and committed; errors to stderr.

## Components

- `src/core/designDiff.ts` — `parseClaims` gains optional `headings: string[] = ["Claims"]`
  (design call sites unchanged; explore passes `["Approaches"]`); `citationOverlaps` gains a
  `paper:` exact-match branch before the path split (correctness fix, benefits design too);
  `diffFindings` API unchanged.
- `src/core/exploreRebuttal.ts` — NEW pure module: `attributeFinding(findingText, buckets)`
  (draftCitations-token × citationOverlaps bucket membership; unique owner or `null`),
  `selectRebuttalTargets(critiques, buckets)` (needs-attention findings grouped per attributed
  agent), `composeRebuttalPrompt(claims, critiques, outPath)` (defend-or-concede, one turn, no
  counter-attacks).
- `src/core/exploreTurn.ts` — new `composeGapPrompt(bucketItems, outPath)` beside the existing
  prompt builders (confirm/extend/refute peer-only approaches; feeds final doc only; no embedded
  done-line/END_OF_INSTRUCTION per the `send`→`inboxWrite` contract).
- `src/commands/explore.ts` — new verbs: `diff` (explore-schema diffFindings → `$ART/diff.md` +
  bucket files), `crossverify-send`/`crossverify-wait` (scope via `verifyScopeFiles`, prompt via
  `composeVerifyPrompt`, claims file `crossverify-claims-<agent>.txt`, key `VS`, FS-guard),
  `rebuttal-send`/`rebuttal-wait` (verdict selection via `exploreVerdict`, attribution via
  `exploreRebuttal`, key `RS`, AS-guard, second-round refusal), `gap-send`/`gap-wait` (peer-only
  buckets, key `GS`, latest-phase guard); `exploreWaitGateRun` accepts phases
  `crossverify`/`rebuttal`/`gap`; dispatcher switch + usage extended.
- `src/core/contracts.ts` — `ConsultKind` + `CONSULT_DEFAULTS` gain `rebuttal: 300` and
  `gap: 600` (crossverify reuses the existing `verify: 300`).
- `src/core/designTurn.ts` — `gateState` key union widens with `"RS" | "GS"` (`"QS"` arrives via
  the cluster-1 spec; `"VS"` already present).
- `commands/explore.md` — new Phase 4c (diff → crossverify send/wait/gate; hub marks
  peer-DISPUTED claims CONTESTED in the Phase 5 draft), Phase 7b (verdict-selected, attributed
  rebuttal send/wait/gate; Phase 8 weighs defenses/concessions), Phase 7c (S1/S2-triggered gap
  send/wait/gate; Phase 8 + handoff Evidence consume answers; explicit never-re-gate anti-goal
  text); task table gains rows 4c/7b/7c; Intervention Pattern 1 lists `VS`/`RS`/`GS`.
- `tests/design-diff.test.ts` (or the existing designDiff test file) — headings param: default
  behavior byte-identical on design fixtures; `["Approaches"]` extracts explore-schema numbered
  claims; `paper:` overlap: identical ids true, different ids false, mixed paper/path false.
- `tests/explore-rebuttal.test.ts` — NEW: attribution unique/ambiguous/zero-match cases;
  selection filters non-needs-attention verdicts; prompt content (claims + critiques + one-turn
  rule).
- `tests/explore-cmd.test.ts` — verb-level DI cases: `diff` writes buckets from explore findings;
  crossverify-send FS-guard + empty-scope skip + happy path; rebuttal-send AS-guard +
  unattributed skip + second-round refusal; gap-send trigger-off/empty/unsafe skips + happy path;
  each `*-wait` mirrors research-wait (ok/timeout/question via `recordWaitOutcome`).
- `tests/explore-gate.test.ts` — `wait-gate` phases crossverify/rebuttal/gap.
- `tests/contracts.test.ts` — `consultTimeout("rebuttal")`/`consultTimeout("gap")` defaults + env
  override.
- `dist/ap.cjs` — rebuilt via `npm run build` and committed (stale-dist CI gate).

## Testing

Pure unit tests only (no live panes; fresh `AP_HOME` per test via `tests/helpers/tmpHome.ts`);
tmux stays arg-array-builder tested per repo convention.

- designDiff regression + port (`tests/design-diff.test.ts` or existing designDiff suite):
  - `parseClaims(fixture)` with no headings arg → byte-identical claims to today on the existing
    `## Claims` fixtures (zero-regression gate for design).
  - `parseClaims(exploreFindings, ["Approaches"])` → extracts `1. [src/x.ts:4] Name — desc` lines,
    ignores `## Tradeoffs` bullets and prose.
  - `citationOverlaps("paper:arxiv:2401.04088", "paper:arxiv:2401.04088")` → true (the current
    code returns false — this test pins the fix); different ids → false; `paper:` vs a file path →
    false; existing path/URL/runtime cases unchanged.
  - `diffFindings` over two explore-schema findings → correct `<agent>_only_items.txt` and agreed
    buckets in `[cite] text` shape.
- `tests/explore-rebuttal.test.ts` —
  - `attributeFinding`: token overlapping one agent's bucket → that agent; tokens hitting two
    agents' buckets → `null`; no citation tokens → `null`.
  - `selectRebuttalTargets`: only `needs-attention` critiques pass; findings grouped per
    attributed agent; unattributed findings excluded.
  - `composeRebuttalPrompt`: contains the worker's claims, the critique text, the
    defend-or-concede + no-counter-attack instruction, the output path; no embedded
    `END_OF_INSTRUCTION`/done-line.
- `tests/explore-cmd.test.ts` (DI spies, seeded art dirs) —
  - `diff`: writes `diff.md` + buckets; rc 1 on existing `diff.md` or missing findings.
  - `crossverify-send`: `FS=timeout` seed → `VS=skipped`, send NOT called; empty scope →
    `VS=skipped`; happy path → `crossverify-claims-<agent>.txt` written, OFFSET captured, send
    called with `@prompt-file`.
  - `rebuttal-send`: `AS=timeout` → `RS=skipped`; zero attributed findings → `RS=skipped`;
    existing `rebuttal-<agent>.txt` → rc 1 (one-turn cap); happy path sends.
  - `gap-send`: trigger not recorded → `GS=skipped`; unsafe latest phase → `GS=skipped`; empty
    peer buckets → `GS=skipped`; happy path sends.
  - each `*-wait`: skipped fast path writes `.done` rc 0; done+non-empty output → `ok`; timeout →
    `timeout`; question → question file + OFFSET bump (`recordWaitOutcome` contract).
- `tests/explore-gate.test.ts` — `wait-gate` for `crossverify`/`rebuttal`/`gap`: pending /
  question / terminal / skipped rows; rc 0 only when all terminal.
- `tests/contracts.test.ts` — `rebuttal` → 300, `gap` → 600, env overrides, unknown kind still
  throws.
- `tests/stale-tokens.test.ts` — green.
- Full gate before PR: `npm run typecheck && npm run lint && npm run test && npm run build`;
  refreshed `dist/ap.cjs` committed (CI stale-dist byte-compare green).
- Live dogfood (post-merge, inside tmux, after clusters 1-2 are live): one deliberately divergent
  explore topic — observe non-empty buckets, a crossverify round with at least one DISPUTE
  surfacing as CONTESTED in the draft, and (when S1/S2 fails) a gap round whose answers appear in
  the final doc's Evidence.

## Success Criteria

- Full gate green (`typecheck`/`lint`/`test`/`build`) with all new tests; CI stale-dist
  byte-compare passes on the committed `dist/ap.cjs`.
- Zero design regression: the design command's diff output over its existing fixtures is
  byte-identical before/after the `parseClaims` headings parameter (pinned by test).
- `citationOverlaps("paper:X", "paper:X")` returns true (pinned by test — it is false today).
- On a seeded two-worker explore art dir: `diff` produces non-empty `<agent>_only_items.txt` from
  explore-schema findings; `crossverify-send` scopes each worker to ONLY its peers' buckets
  (never its own claims); a peer-DISPUTED claim is rendered CONTESTED in the draft per the
  directive.
- Rebuttal discipline is machine-enforced: only `needs-attention` critiques with unique bucket
  attribution generate a rebuttal turn; a second `rebuttal-send` for the same worker returns rc 1;
  `AS=timeout`/`failed` workers are never sent to (send spy not called).
- Gap round fires only when recorded `S1=false` or `S2=false`; the confidence gate is never
  re-invoked after Phase 5.5 (grep: no second `confidence` call in the directive flow) and
  `adversary-skip.txt` is never rewritten; gap answers appear in the final doc and handoff
  Evidence, and `landscape-draft.md` is not modified after annotate.
- A convergent run (empty peer buckets, no needs-attention verdicts, S1/S2 true) executes ZERO new
  worker turns — every round records `<KEY>=skipped` and wall-clock cost matches today's.
- Frozen-protocol audit: no changes to event names, `END_OF_INSTRUCTION`, existing state
  filenames, or `contracts.yaml` key names (new consult kinds are additive TS defaults);
  `tests/stale-tokens.test.ts` green.

