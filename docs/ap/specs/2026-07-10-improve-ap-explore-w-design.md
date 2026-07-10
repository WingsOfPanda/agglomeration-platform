# Improve /ap:explore worker collaboration — cluster 1 (cheap, high-value): (a) adversary phase upgrades: adversary-send enumerates peers via list.txt and lists the OTHER workers' findings-<agent>.md absolute paths in the prompt so each adversary can attack the raw evidence, not just the hub's blended draft; composeAdversaryPrompt assigns each worker a DISTINCT attack lens (worker 1: citation fidelity — open every cited source; worker 2: frame exclusion + missed approaches) instead of today's identical prompt. (b) open-questions peer-relay round: after the research wait-gate is green, collate each worker's '## Open questions' from findings-<agent>.md and round-robin route them to a DIFFERENT terminal worker for one bounded answer turn; answers feed synth-preliminary. (c) timeout-dispatch guard: research-wait/adversary-wait write the .done marker unconditionally including on timeout (src/commands/explore.ts ~:204/:351), so gateState reports a timed-out-but-still-churning worker 'terminal' and a follow-up send would clobber its in-flight inbox — any new-round dispatch (and the existing adversary-send) must gate on FS/AS not in {timeout,failed}. Grounding: verified 2026-07-10 analysis in memory file /home/liupan/.claude/projects/-home-liupan-Aerius-agglomeration-platform/memory/explore-collab-improvement-analysis.md (P3 verdict FEASIBLE; workers spawn codex full-mode and already write into the art dir under ~/.ap, so peer-path reads are proven; adversarySendWith does not read list.txt today — peer enumeration is a real code add). Constraints: frozen wire protocol untouched (no new events/sentinel/state-filename renames); single-slot inbox — sends only to terminal workers; research-phase worker isolation stays (peer sharing is post-research only); new state files follow the <phase>-<agent> convention.

## Problem

In today's `/ap:explore`, the N workers (e.g. claude + codex) never touch each other's work: the
adversary phase sends every worker the byte-identical prompt against the hub's blended draft only
(`composeAdversaryPrompt`, `src/core/exploreTurn.ts:86-145` — inlines `landscape-draft.md`, never
peer findings), so adversaries cannot distinguish "the hub mis-synthesized" from "my peer's evidence
is weak" and tend to produce duplicate critiques. Each worker's `## Open questions` section
(`src/core/exploreTurn.ts:53`) is only hub-merged at final synthesis and never routed to a peer who
might answer it. Separately, `research-wait`/`adversary-wait` write their `.done` marker
unconditionally — including on timeout (`src/commands/explore.ts:204,351`) — so `gateState`
(`src/core/designTurn.ts:145-158`: `doneExists && last !== null` → terminal) reports a
timed-out-but-possibly-still-churning worker as terminal, and the next phase's send can clobber its
in-flight single-slot inbox (the recorded `hub-midrun-worker-messaging-clobbers-state` failure class).

## Goal

After this change, `/ap:explore`'s workers genuinely collaborate post-research while research-phase
isolation (the anti-correlated-blind-spots guard, `src/core/exploreTurn.ts:48-51`) stays intact:
each adversary reads the raw peer `findings-<agent>.md` files and attacks from a distinct assigned
lens instead of duplicating the same critique of the blended draft; each worker's unresolved
`## Open questions` are round-robin routed to a different terminal worker for one bounded answer
turn whose output feeds the hub's preliminary synthesis; and no explore verb can ever dispatch a
follow-up turn to a worker whose previous phase ended `timeout`/`failed` — the guard is enforced in
the send verbs themselves (a code guarantee, not directive discipline), with a soft-skip that keeps
the wait-gate and final synthesis coherent. The frozen wire protocol (events, sentinel, existing
state filenames, `contracts.yaml` key names) is untouched; all new state files follow the
`<phase>-<agent>` convention.

## Architecture

Three sub-features, one PR-sized change set. All new sends happen only to workers whose previous
turn ended in a *safe* terminal state; research-phase isolation is untouched (peer sharing starts
strictly after the research wait-gate is green, which the rejected-history in
`/home/liupan/.claude/projects/-home-liupan-Aerius-agglomeration-platform/memory/explore-collab-improvement-analysis.md`
confirms is the deliberate boundary).

### (a) Adversary phase: raw peer evidence + distinct attack lenses

`adversarySendWith` (`src/commands/explore.ts:311-328`) today reads only `landscape-draft.md`. It
gains a peer-enumeration step: `parseListFile(readIf(join(art, "list.txt")))` (the same read the
`confidence` verb does at `src/commands/explore.ts:250`), peers = rows whose `agent !== self`. It
passes to the prompt composer (i) the peers' absolute `findings-<agent>.md` paths (paths, NOT
inlined contents — workers open them with their own tools; prompt bloat stays negligible; reads are
proven because workers already *write* into the art dir under `~/.ap` in codex full mode,
`config/contracts.yaml` `default_mode: full`) and (ii) a lens assigned deterministically by the
worker's row index in `list.txt` order: `lens = ADVERSARY_LENSES[index % 3]`.

`composeAdversaryPrompt` (`src/core/exploreTurn.ts:86-145`) gains a required `opts` parameter
`{ peerFindingsPaths: string[]; lens: AdversaryLens }`. Three lenses (`ADVERSARY_LENSES` const in
`src/core/exploreTurn.ts`):

1. **citation-fidelity** — open every cited file/URL/paper in the draft AND in the peer findings;
   verify each claim is actually supported by its citation; flag over-reached citations.
2. **frame-exclusion** — hunt approaches that were missed or wrongly excluded; attack frames the
   synthesis adopted that shut out valid alternatives; compare against what the raw peer findings
   actually contain.
3. **staleness-and-correlation** — attack stale SOTA claims and convergent findings that may share a
   correlated blind spot (same paper, same missed development). (Used only at N=3.)

The lens is an *emphasis block* ("your PRIMARY attack angle — spend most of your effort here")
prepended to the existing attack-surface list, which is retained in full so N=2 keeps whole-surface
coverage. The prompt also lists the peer findings paths under a "Raw evidence behind the draft"
block instructing the adversary to check whether the draft faithfully represents them.

### (b) Open-questions peer-relay round (new Phase 4b)

New pure module `src/core/exploreOpenq.ts`:

- `parseOpenQuestions(findingsText): string[]` — the `- ` bullets under `## Open questions` until
  the next `## ` heading (tolerant: missing section or zero bullets → `[]`).
- `assignOpenQuestions(rows, questionsByAgent): Map<agent, {from, question}[]>` — round-robin to a
  DIFFERENT worker: N=2 swap (alpha→bravo, bravo→alpha); N=3 rotate by list order (a→b, b→c, c→a).
- `composeOpenqPrompt(assignments, answersPath): string` — "your fellow workers could not resolve
  these questions during research; answer each from your own investigation (use your tools; cite
  sources); write to `<answersPath>` as `## Q1 <question>` / answer / citations. If you cannot
  answer one, say so explicitly — do not pad." Body carries no done-line/END_OF_INSTRUCTION
  (`send` → `inboxWrite` appends them, same contract as the research prompt,
  `src/core/exploreTurn.ts:2-6`).

Three new verbs in `src/commands/explore.ts` (dispatcher `run()` switch, `:42-59`), mirroring the
research verbs' DI pattern:

- `openq-collate <topic>` (hub-only, no send): reads every `findings-<agent>.md`, writes
  `$ART/open-questions.md` (the collated view) and per-target `openq-claims-<agent>.txt` (the
  questions assigned TO that agent). Zero questions anywhere → prints `OPENQ=none` and the directive
  skips the phase.
- `openq-send <topic> <agent> <provider>`: guard (see (c)); if `openq-claims-<agent>.txt` is
  missing/empty → write state `openq-<agent>.txt` = `QS=skipped\n`, no send (mirror of design's
  `VS=skipped`, `src/commands/design.ts:310`). Else compose prompt to
  `$ART/<agent>_openq_prompt.md`, capture `OFFSET=` into `openq-<agent>.txt`, `send --from hub`.
- `openq-wait <topic> <agent> <provider>`: skipped-already fast path (last `QS=skipped` → write
  `.done`, rc 0 — mirror `src/commands/design.ts:337-338`); else `liveOutboxWait` on
  `TERMINAL_EVENTS` with `scaledTimeout(consultTimeout("openq"), multiplier)`, then
  `recordWaitOutcome(..., "QS", ...)` + `.done` (exact shape of `researchWaitWith`,
  `src/commands/explore.ts:188-207`). Answers land at `$ART/openq-<agent>.md`; state uses
  `verifyState` semantics (done → ok iff answers file non-empty).

`consultTimeout` (`src/core/contracts.ts:61-65`) gains `openq: 300` in `CONSULT_DEFAULTS` (an
answer turn is verify-sized, not research-sized), overridable like the other kinds; `ConsultKind`
union widened. `gateState`'s key union `"FS" | "VS" | "AS"` (`src/core/designTurn.ts:147`) widens
to include `"QS"`; the explore `wait-gate` verb (`src/commands/explore.ts:357-378`) accepts phase
`openq`. `recordWaitOutcome` already takes `key: string` — no change.

Directive (`commands/explore.md`): new **Phase 4b** between the research wait-gate and Phase 5 —
run `openq-collate`; if not `OPENQ=none`, N parallel `openq-send` then N background `openq-wait`,
gate on `wait-gate <TOPIC> openq`, question events handled by the existing Intervention Pattern 1
(state key `QS`). Phase 5 (synth-preliminary) additionally instructs the hub to read every
`openq-<agent>.md` when authoring `landscape-draft.md` (answered questions strengthen or resolve
`## Open questions` entries; the `synth-preliminary` validator is UNCHANGED — answers are optional
enrichment, a failed/skipped relay never blocks the run). Task table gains one row (`4b Open-questions
relay [workers]`).

### (c) Timeout-dispatch guard (verb-level, not directive discipline)

Every explore verb that dispatches a follow-up turn to a worker first reads that worker's previous
phase state file and refuses to send when its last state line is `timeout` or `failed`:

- `adversary-send` reads `research-<agent>.txt` last `FS=`; on `timeout`/`failed` → write
  `adversary-<agent>.txt` = `AS=skipped\n`, log a warning naming the unsafe state, rc 0 (soft-skip).
- `openq-send` reads the same `FS=` guard before its own zero-questions check.
- `adversary-wait` gains the skipped-already fast path (last `AS=skipped` → write `.done`, rc 0)
  so the directive can still background-wait every worker uniformly and `wait-gate` sees terminal.
- `synth-final` (`src/commands/explore.ts:381-404`) tolerance: a row whose `adversary-<agent>.txt`
  last `AS=skipped` is excluded from the missing-critique blocker (`missingListArtifacts` call at
  `:392`); the final doc lists that worker's critique as `(skipped: unsafe after research timeout)`
  — mirroring the existing `(unavailable)` convention of Intervention Pattern 2.

Rationale for soft-skip over hard-fail: a timed-out worker may still be churning — sending anything
(even a probe) risks the inbox clobber; skipping one adversary/answer turn degrades gracefully
(the run still completes with N-1 critiques), matching design's `VS=skipped` precedent. The
research phase's all-or-nothing synth gate is deliberately NOT changed here (N-1 survivor
continuation is a separate, later spec).

### Invariants

- Frozen wire protocol untouched: no new events, no sentinel change, no renames of existing state
  files or `contracts.yaml` keys (adding the optional `openq` consult kind is additive).
- Single-slot inbox: every new send targets a worker that is terminal AND whose terminal state is
  not `timeout`/`failed` — now enforced in code.
- Research-phase isolation preserved: no peer material enters any research prompt.
- Errors to stderr; no emojis in shipped output; `dist/ap.cjs` rebuilt and committed
  (`npm run build`) so the stale-dist CI gate stays green.

## Components

- `src/core/exploreTurn.ts` — `composeAdversaryPrompt(landscapeDraft, agent, outPath, opts)` gains
  required `opts: { peerFindingsPaths: string[]; lens: AdversaryLens }`; new exported
  `ADVERSARY_LENSES` const (3 lenses: citation-fidelity, frame-exclusion, staleness-and-correlation)
  and `AdversaryLens` type. Lens emphasis block + "Raw evidence behind the draft" peer-paths block
  prepended; existing attack-surface list retained verbatim.
- `src/core/exploreOpenq.ts` — NEW pure module: `parseOpenQuestions(findingsText): string[]`,
  `assignOpenQuestions(rows: ListRow[], questionsByAgent: Map<string, string[]>): Map<string, { from: string; question: string }[]>`
  (N=2 swap, N=3 rotate by list order), `composeOpenqPrompt(assignments, answersPath): string`.
- `src/commands/explore.ts` — `adversarySendWith`: peer enumeration via `parseListFile` + lens
  index + FS timeout/failed guard writing `AS=skipped` soft-skip; `adversaryWaitWith`: skipped-already
  fast path (write `.done`, rc 0) before the OFFSET parse; new verbs `openq-collate`, `openq-send`,
  `openq-wait` (DI-injected send/wait deps, mirroring `researchSendWith`/`researchWaitWith`);
  `exploreWaitGateRun` accepts phase `openq` (key `QS`); `synthFinalRun` excludes `AS=skipped` rows
  from the missing-critique blocker; dispatcher switch + usage string extended.
- `src/core/contracts.ts` — `ConsultKind` union + `CONSULT_DEFAULTS` gain `openq: 300`.
- `src/core/designTurn.ts` — `gateState` key union widens `"FS" | "VS" | "AS"` → `+ "QS"` (doc
  comment updated; no behavior change).
- `commands/explore.md` — new Phase 4b (openq-collate → parallel openq-send → background openq-wait
  → `wait-gate <TOPIC> openq`; skip whole phase on `OPENQ=none`); Phase 5 instructs the hub to read
  every `openq-<agent>.md` when authoring the draft; Phase 6/7 text notes the `AS=skipped` guard
  semantics and the `(skipped: unsafe after research timeout)` rendering in Phase 8; task table
  gains row `4b`; Intervention Pattern 1 mentions state key `QS`.
- `tests/explore-turn.test.ts` — updated `composeAdversaryPrompt` call sites + new assertions
  (peer paths present, distinct lens text per index, attack-surface list retained).
- `tests/explore-openq.test.ts` — NEW: `parseOpenQuestions` (normal / missing section / zero
  bullets / stops at next heading), `assignOpenQuestions` (N=2 swap, N=3 rotation, empty maps),
  `composeOpenqPrompt` (no END_OF_INSTRUCTION / no done-line embedded).
- `tests/explore-cmd.test.ts` — NEW cases: adversary-send guard (seed `research-<agent>.txt` with
  `FS=timeout` → state written `AS=skipped`, DI send spy NOT called); adversary-wait skipped fast
  path; openq-send zero-questions skip + FS guard; openq-send/openq-wait happy path (DI);
  synth-final tolerates `AS=skipped` row.
- `tests/explore-gate.test.ts` — `wait-gate openq` phase (pending/question/terminal/skipped rows).
- `tests/contracts.test.ts` — `consultTimeout("openq")` default 300 + env override.
- `dist/ap.cjs` — rebuilt via `npm run build` and committed (stale-dist CI gate).

## Testing

All unit tests are pure (no tmux panes, no live spawns — the tmux surface stays arg-array-builder
tested per repo convention); state seeded under a fresh `AP_HOME` temp dir per test
(`tests/helpers/tmpHome.ts`).

- `tests/explore-turn.test.ts` — `composeAdversaryPrompt` with `opts`: contains every peer
  `findings-<agent>.md` path; lens 0 vs lens 1 produce different emphasis text; the full existing
  attack-surface list is still present under both lenses; no `END_OF_INSTRUCTION` and no done-event
  line embedded (the `send`/`inboxWrite` contract, `src/core/exploreTurn.ts:2-6`).
- `tests/explore-openq.test.ts` — `parseOpenQuestions`: bullets extracted; missing `## Open
  questions` section → `[]`; extraction stops at the next `## ` heading; non-bullet lines ignored.
  `assignOpenQuestions`: N=2 swaps; N=3 rotates a→b→c→a; a worker with zero questions still
  RECEIVES peers' questions; all-empty input → empty map. `composeOpenqPrompt`: numbered questions
  with their `from` agent, answers path present.
- `tests/explore-cmd.test.ts` — verb-level with DI spies:
  - adversary-send guard: seed `research-<agent>.txt` ending `FS=timeout` (and separately
    `FS=failed`) → `adversary-<agent>.txt` written with `AS=skipped`, send dep NOT invoked, rc 0;
    seed `FS=ok` → send invoked as today.
  - adversary-wait skipped fast path: state `AS=skipped`, no `OFFSET=` → `.done` written, rc 0
    (no OFFSET error).
  - openq-send: missing/empty `openq-claims-<agent>.txt` → `QS=skipped`, no send; FS=timeout guard
    → `QS=skipped`, no send; happy path → OFFSET captured, send invoked with `@prompt-file`.
  - openq-wait: mirrors research-wait (done event + non-empty `openq-<agent>.md` → `QS=ok`;
    timeout → `QS=timeout`; question → question file captured + OFFSET bumped via
    `recordWaitOutcome`).
  - openq-collate: writes `open-questions.md` + per-target `openq-claims-<agent>.txt`; zero
    questions everywhere → prints `OPENQ=none`, writes no claims files.
  - synth-final: a row with `AS=skipped` in `adversary-<agent>.txt` and NO `adversary-<agent>.md`
    → rc 0 (not blocked); a row with no state file and missing critique → still blocked (rc 1).
- `tests/explore-gate.test.ts` — `wait-gate <topic> openq`: pending (no `.done`), question (last
  `QS=question`), terminal (`.done` + `QS=ok`), and skipped (`QS=skipped` + `.done`) rows; rc 0
  only when all terminal.
- `tests/contracts.test.ts` — `consultTimeout("openq")` → 300 default; env override respected;
  unknown kind still throws.
- `tests/stale-tokens.test.ts` — unchanged and green (new prose introduces no banned tokens).
- Full gate before PR: `npm run typecheck && npm run lint && npm run test && npm run build` with the
  refreshed `dist/ap.cjs` committed (CI's stale-dist byte-compare stays green).
- Live dogfood (post-merge, inside tmux): one `/ap:explore` run on a small topic — observe distinct
  `<agent>_adversary_prompt.md` contents (peer paths + different lenses), an executed Phase 4b with
  `openq-<agent>.md` answers, and forensics clean.

## Success Criteria

- `npm run typecheck`, `npm run lint`, `npm run test` all green with the new tests included (suite
  grows from 1323; every new behavior above has at least one covering test), and CI's stale-dist
  gate passes on the committed `dist/ap.cjs`.
- `<agent>_adversary_prompt.md` files from a run differ per worker: each contains the OTHER
  workers' absolute `findings-<agent>.md` paths and a distinct lens emphasis block, while the full
  original attack-surface list remains present in both.
- A run whose workers emitted `## Open questions` executes Phase 4b: `open-questions.md` +
  `openq-claims-<agent>.txt` exist, each worker answered its PEERS' questions (never its own) in
  `openq-<agent>.md`, and the landscape draft's `## Open questions` section reflects the answers.
  A run with zero open questions skips the phase with `OPENQ=none` and no worker turn.
- Unit-proven guard: with `research-<agent>.txt` ending `FS=timeout` or `FS=failed`, neither
  `adversary-send` nor `openq-send` invokes `send` for that worker; the run still completes with
  the remaining workers and `synth-final` renders that critique slot as skipped instead of
  blocking (rc 0).
- Frozen-protocol audit: `git diff` shows no change to event names, `END_OF_INSTRUCTION`, existing
  state filenames, or existing `contracts.yaml` key names; `tests/stale-tokens.test.ts` green.
- No research-prompt change: `composeExploreResearchPrompt` output is byte-identical to before
  (research-phase isolation preserved).

