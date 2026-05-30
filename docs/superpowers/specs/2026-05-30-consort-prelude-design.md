# consort `prelude` — design (port of clone-wars `meditate`)

**Status:** approved 2026-05-30. Last unported clone-wars command.
**Branch:** `feat/prelude`.
**Behavioral spec:** `/home/liupan/CC/clone-wars` — `commands/meditate.md`, `bin/meditate-*.sh`,
`lib/meditate.sh`, `config/prompt-templates/meditate/{research,adversary,landscape-skeleton}.md`.
Preserve **behavior**, not implementation (line numbers drift; grep by symbol).

---

## 1. What `prelude` is

Deep multi-aspect exploration of a hard topic. The **Maestro** (the Claude Code session running
`/consort:prelude <topic>`) orchestrates an N-part research pass (N = 2 or 3), classifies the topic
up front to weight academic-paper retrieval, synthesizes a preliminary landscape doc, runs a
5-signal confidence gate, optionally dispatches all N parts as **adversaries** against the
synthesis, and writes a final landscape doc with a tradeoff matrix + adversary critiques + a
directional **Conclusion** intended as a hand-off seed for `/consort:score`.

**The Maestro never runs retrieval — parts are the only retrievers.** The Maestro orchestrates and
synthesizes (authors the landscape docs + handoff via the Write tool); the CLI verbs do
init/classify/spawn/send/wait/validate/gate-compute/extract/teardown.

Intended workflow: **`prelude → score → perform`**. Prelude's Conclusion feeds score's next round.

**When it routes here** (vs. `score`): "explore SOTA / find new architectures / deep think /
survey the landscape / research from multiple aspects / meditate on X" — exploration *without*
committing to a buildable spec. "design X / build X / compare A vs B for a decision" routes to
`score` instead.

---

## 2. Architecture — build on `score`

`prelude` is `score` (the consult port) plus three additions: a literature-track classifier, a
5-signal confidence gate, and an adversary round. It **reuses score's machinery wholesale**:

- The DI verb pattern: `<Verb>Deps` interface + `<verb>With(args, deps)` + `live<Verb>Deps` +
  thin `<verb>Run` wrapper dispatched by subcommand.
- IPC / wait: `outboxOffset`, `outboxPath`, `outboxWaitSince`, `OutboxEvent` (`src/core/ipc.ts`).
- Turn helpers: `parseLatestOffset`, `scaledTimeout`, and the `done/error/question` wait-state
  classifier `researchState` (`src/core/scoreTurn.ts`).
- Timeouts: `consultTimeout("research")` (600s) and `consultTimeout("adversary")` (600s) — both
  already defined in `src/core/contracts.ts`; `instrumentTimeoutMultiplier` for per-provider scaling.
- Spawn: `score spawn-all`'s preflight + parallel-spawn shape (`preflight` + `spawn` commands).
- Forensics: `captureArtDir({ artDir, command: "prelude" })` (`src/core/forensics.ts`).
- Archive: `archiveTopic(topic, "prelude")` — **add `"prelude"` to the `archiveTopic` suite union**
  (mirrors the Phase-D `"rehearsal"` addition).
- Roster helpers from `src/core/score.ts`: `RosterRow`, `formatRosterFile`, `parseRosterFile`,
  `spawnRosterArg`, `spawnResultsTsv`, `spawnTally`, `parsePanesFile`.

Prompt templates become **TypeScript string-builders** (consort ships none of the
`config/prompt-templates/*` files for score — `scoreTurn.ts` inlines them as functions). Prelude
follows suit in `preludeTurn.ts`.

---

## 3. Verbs (`src/commands/prelude.ts`)

Dispatched by subcommand; each follows the score DI pattern. Exit codes: `0` ok, `1` operational
failure, `2` usage / missing-input.

| Verb | Args | Behavior (port of) |
|---|---|---|
| `init` | `<topic-text>` (via `--args-file`) | Derive `prelude-<slug>` (slug base capped to 20 chars so `prelude-<base>-NNN` stays bounded). Provider gate: needs **2–3** consult-validated active providers (0/1 → rc1 "just ask Claude directly"; >3 → cap to first 3). Pick instruments, create `_prelude/`, write `topic.txt` + `roster.txt`. Refuse if art-dir already exists (rc2). Print `TOPIC=/N=/ART=/PART=…`. (`meditate-init.sh`) |
| `classify` | `<topic>` | Whole-word case-insensitive keyword scan → `ON`/`OFF`; write `_prelude/lit-track.txt` (`<ON\|OFF>\nreason: auto-detect via keyword scan\n`). (directive Step 1 + `cw_meditate_classify_topic`) |
| `spawn-all` | `<topic>` | Read `roster.txt`, preflight panes, spawn N parts in parallel, write `spawn-results.tsv`, return spawn-tally rc. (directive Step 2 / `spawn-batch.sh`) |
| `research-send` | `<topic> <instrument> <provider>` | Render research prompt with the lit-guidance block from `lit-track.txt`; part writes `findings-<instrument>.md` in the **art-dir** (flat); dispatch via `send --from maestro`. Refuse if `research-<instrument>.txt` exists (rc1). (`meditate-research-send.sh`) |
| `research-wait` | `<topic> <instrument> <provider>` | Wait for `done/error/question` (timeout `consultTimeout("research")`×multiplier); classify via `researchState` against `findings-<instrument>.md`; on `question` record `question-<instrument>.txt` + bump offset; write `research-<instrument>.done`. (`consult-research-wait.sh research`) |
| `synth-preliminary` | `<topic>` | Input validator: require `topic.txt`, `roster.txt`, and `findings-<instrument>.md` for every roster part. Print the draft output path `_prelude/landscape-draft.md`. rc1 on missing inputs. (`meditate-synth-preliminary.sh`) |
| `confidence` | `<topic> [--decision skip\|continue]` | **No flag:** compute S1–S5 against `landscape-draft.md` + `findings-*.md`; log + print `S1=… S5=… ALL_HOLD=…`. If `ALL_HOLD=false`, write `adversary-skip.txt` (`user_decision: not-offered`). If `ALL_HOLD=true`, write nothing (Maestro will ask, then re-invoke with `--decision`). **With `--decision <skip\|continue>`:** recompute signals, write `adversary-skip.txt` with that decision. (directive Step 5.5) |
| `adversary-send` | `<topic> <instrument> <provider>` | Guard `landscape-draft.md` non-empty (rc1). Render adversary prompt (inline the draft); part writes `adversary-<instrument>.md`; dispatch. Refuse if `adversary-<instrument>.txt` exists. (`meditate-adversary-send.sh`) |
| `adversary-wait` | `<topic> <instrument> <provider>` | Same wait/classify shape as `research-wait`, output file `adversary-<instrument>.md`, timeout `consultTimeout("adversary")`×multiplier; write `adversary-<instrument>.done`. (`meditate-adversary-wait.sh` → `consult_wait adversary`) |
| `synth-final` | `<topic>` | Input validator: require `landscape-draft.md` + `topic.txt`; if `adversary-skip.txt` does **not** record `user_decision: skip`, require `adversary-<instrument>.md` for every part. Resolve + print canonical output path `_prelude/landscape-<YYYY-MM-DD>-<slug>.md` (slug = topic minus `prelude-` prefix; date = UTC today). (`meditate-synth-final.sh`) |
| `forensics` | `<topic>` | `captureArtDir({ artDir, command: "prelude" })`; print path; rc0 best-effort. (`forensics-capture.sh … meditate`) |
| `teardown` | `<topic>` | Preflight-orphan kill + `coda --pairs` graceful teardown of the roster panes, then `archiveTopic(topic, "prelude")`; print archive dest. (`meditate-teardown.sh` + directive Step 9 archive — combined like rehearsal's `teardown`) |
| `handoff-extract` | `<art-dir>` | Write `<art-dir>/handoff-data.kv` from the landscape doc + findings + `adversary-skip.txt` + `adversary-<instrument>.md` (see §6). Takes the **art-dir directly** (runs against the archive). rc2 if art-dir or `topic.txt` missing. (`meditate-handoff-extract.sh`) |

Synthesis (`landscape-draft.md`, `landscape-<date>-<slug>.md`, `score-handoff.md`) is authored by
the **Maestro** via the Write tool inside the directive — never by a verb.

---

## 4. Core modules (pure, unit-tested)

| Module | Public surface | Notes |
|---|---|---|
| `src/core/prelude.ts` | `preludeArtDir(topic)`, `derivePreludeSlug(text)`, `parsePreludeArgs(tokens)` | Reuse score's `RosterRow`/`formatRosterFile`/`parseRosterFile` rather than re-declaring. Slug: lowercase → `[a-z0-9-]` → collapse dashes → trim → **cap base 20**; empty → error. Topic = `prelude-<slug>` with `-N` (N≥2) uniqueness suffix when the dir exists. |
| `src/core/preludeLit.ts` | `classifyTopic(topic): "ON" \| "OFF"`, `LIT_KEYWORDS: string[]` | Whole-word, case-insensitive match against the 24-keyword list (loss, embedding, network, model, architecture, training, optimizer, scheduler, transformer, mamba, attention, regularization, augmentation, fine-tune, sota, state-of-the-art, benchmark, paper, arxiv, algorithm, inference, quantization, distillation, pruning). Empty topic → `OFF`. |
| `src/core/preludeConfidence.ts` | `computeSignals(draft, findings: string[]): { s1..s5: boolean, allHold: boolean }`, `renderSkipRecord({ signals, decision, now })` | Pure. Signal defs in §5. `renderSkipRecord` emits the 3-line `adversary-skip.txt` body. |
| `src/core/preludeTurn.ts` | `composePreludeResearchPrompt(topic, writeTo, litGuidance)`, `composeAdversaryPrompt(draft, instrument, outPath)`, `litGuidance(track: "ON" \| "OFF"): string` | Ports the three meditate prompt templates as string-builders. Bodies end with the frozen `{"event":"done",…}` line + `END_OF_INSTRUCTION`. |
| `src/core/preludeHandoff.ts` | `extractHandoffData(artDir): string \| null`, plus pure `buildHandoffKv(input)` | Reconciled reads (§6). `buildHandoffKv` is pure (parsed inputs → kv string); `extractHandoffData` does the file I/O + atomic write. rc/`null` on missing `topic.txt`. |

---

## 5. The 5-signal confidence gate (exact, ported from directive Step 5.5)

All computed against `landscape-draft.md` + the `findings-<instrument>.md` set. `N` = part count.

- **S1 — top-approach convergence.** Top approach = the text of the first `^N. ` numbered item
  under `## Approaches` in the draft (strip leading `N. `, trailing space, and any ` — …` tail).
  `HITS` = count of findings files that contain that text (case-insensitive, literal). `S1 = HITS ≥ N-1`.
- **S2 — citation cross-coverage.** Extract citation tokens from the draft via
  `[A-Za-z_./-]+\.[a-z]+(:[0-9]+)?` or `https?://[^ )"\\]+`, unique. For each, count findings files
  containing it (literal); a token cited by `< 2` files is "solo". `S2 = (solo count == 0)`.
- **S3 — no CONTESTED markers.** `S3 = false` iff the draft contains `CONTESTED` (case-insensitive),
  else `true`.
- **S4 — matrix citation backing.** Within the `## Tradeoff matrix` section, a row whose Reason
  (3rd) cell's first non-space char is neither `/` nor `:` (i.e. lacks a path/URL/paper anchor) is
  "bad". Faithful heuristic: count rows matching `^\| [^|]+\| [^|]+\| [^/:][^|]*\|$`.
  `S4 = (bad count == 0)`.
- **S5 — uncertainty acknowledged.** `S5 = true` iff any findings file matches (case-insensitive)
  `uncertain|unclear|depends on|could not determine|not sure|gap in evidence`.
- **`ALL_HOLD = S1 && S2 && S3 && S4 && S5`.** Only when all hold does the Maestro **offer** the
  skip (`AskUserQuestion`, default = run adversary). Otherwise no prompt; adversary runs.

`adversary-skip.txt` body (atomic write):
```
timestamp: <iso-utc>
signals_passed: S1=<b> S2=<b> S3=<b> S4=<b> S5=<b>
user_decision: <not-offered | skip | continue>
```

---

## 6. Handoff extraction (`handoff-data.kv`) — reconciled

`extractHandoffData(artDir)` writes `<artDir>/handoff-data.kv` atomically. **Frozen key set and
order:**

```
mode=<prelude | prelude-no-convergence>
topic=<topic.txt, newlines→spaces, trailing-trimmed>
landscape_doc=<basename>          # only if a landscape doc exists
top_approach=<text>               # only if non-empty
findings_paths=<csv of basenames> # only if any findings-*.md
confidence_signals=<csv>          # only if non-empty  (RECONCILED — see below)
adversary_findings_paths=<csv>    # only if any        (RECONCILED — see below)
tradeoff_matrix_present=<true|false>
session_path=.
topic_txt_path=topic.txt
generated_ts=<iso-utc>
```

- **landscape_doc:** glob `landscape-*.md`, prefer the non-`landscape-draft.md` (final) match;
  fall back to `landscape-draft.md`.
- **top_approach:** first `^N. ` item under `## Approaches` in the landscape doc (flag-based scan,
  not a sed range). Empty → `mode=prelude-no-convergence` and `top_approach`/related lines omitted.
- **findings_paths:** basenames of `findings-*.md`, comma-joined.
- **confidence_signals (RECONCILED, per approved decision):** parse the `signals_passed:` line of
  `adversary-skip.txt` and emit `S1=<b>,S2=<b>,S3=<b>,S4=<b>,S5=<b>`. (clone-wars read a never-written
  `confidence-record.txt`; the consort port reads the file the gate actually writes.)
- **adversary_findings_paths (RECONCILED):** basenames of `adversary-*.md` (the per-part critiques),
  comma-joined. (clone-wars globbed a never-written `adversary-findings-*.md`.)
- **tradeoff_matrix_present:** `true` iff the landscape doc has a `^## Tradeoff matrix` line.

The Maestro then composes `score-handoff.md` (Write tool) following meditate's six-section schema
(Recommendation / Recipe / Constraints / Open questions / Evidence / Appendix), with `mode=prelude-
no-convergence` degrading to "survey did not converge" + omitted Recipe. All Appendix paths absolute
(art-dir already rebound to the archive by teardown). Renamed output: **`score-handoff.md`**
(was `consult-handoff.md`); suggested next step prints `/consort:score <…>/score-handoff.md`.

---

## 7. Directive (`commands/prelude.md`) — phase map

Mirrors meditate Steps 0–10, consort-ified (verbs invoked as `node <CLI> prelude <verb> …`;
Maestro authors the synthesis docs). Task list created via `TaskCreate` before Step 0.

0. **Args + init + roster load** — write `$ARGUMENTS` to an args file; `prelude init`; load roster.
1. **Literature auto-detect** — `prelude classify <topic>` → `lit-track.txt`.
2. **Parallel spawn** — `prelude spawn-all <topic>`; Stage-1 retry-once on cold-start failure
   (teardown + retry; on second failure teardown + remove art-dir + exit 1).
3. **Research dispatch** — N parallel `prelude research-send …`.
4. **Research wait** — N background-await `prelude research-wait …`; handle `question` via the
   intervention pattern (answer via `send`, advance offset, re-wait).
5. **Preliminary synthesis** — `prelude synth-preliminary`; Maestro **Writes** `landscape-draft.md`
   with the preliminary section set (Topic / Approaches / Tradeoff matrix / Findings by part /
   Open questions / Citations); label CONTESTED claims; every matrix Reason cell carries ≥1 citation.
5.5 **Confidence gate** — `prelude confidence`; if `ALL_HOLD=true` fire `AskUserQuestion` (default
   run-adversary), then `prelude confidence --decision <skip|continue>`. `skip` → jump to Step 8.
6. **Adversary dispatch** — N parallel `prelude adversary-send …` (skipped on `skip`).
7. **Adversary wait** — N background-await `prelude adversary-wait …`; same question handling.
8. **Final synthesis** — `prelude synth-final`; Maestro **Writes** `landscape-<date>-<slug>.md`
   with the final section set (… / Adversary critiques / … / Conclusion / Citations); the
   adversary-skipped note when applicable; Conclusion names the strongest approach + caveats +
   a concrete suggested `/consort:score …` invocation.
8a. **Forensics** — `prelude forensics`; if a file was written, Maestro appends a `## Maestro
   reflection` section (3–5 bullets).
9. **Teardown + archive** — `prelude teardown` (panes + `archiveTopic`); rebind art-dir to archive.
9b. **Handoff extract** — `prelude handoff-extract <archive-art-dir>` → `handoff-data.kv`.
9c. **Compose handoff** — Maestro **Writes** `score-handoff.md` from the kv + landscape doc.
10. **Present** — print landscape doc path, handoff path, and the suggested `/consort:score` step.

---

## 8. Rebrand & frozen

**Cosmetic rebrand (prose + identifiers):** `meditate`→`prelude`, `_meditate/`→`_prelude/`,
`meditate-` topic prefix → `prelude-`, Master Yoda→Maestro, `From: master-yoda`→`From: maestro`,
trooper→part, commander→instrument, `consult-handoff.md`→`score-handoff.md`,
`/clone-wars:consult`→`/consort:score`, `mode=meditate[-no-convergence]`→`mode=prelude[-no-convergence]`,
`cw_*`/`CLONE_WARS_HOME`/`.clone-wars/` dropped.

**Stale-token gate (`tests/stale-tokens.test.ts`) — 7 banned tokens:** case-sensitive
`clone-wars`, `cw_`, `master-yoda`, `MISSION ACCOMPLISHED`, `@cw_`; case-insensitive `trooper`,
`commander`. (`meditate` and `Yoda` are **not** gated — JSDoc may cite `meditate-*.sh` source
filenames — but prose still rebrands to prelude/Maestro per this table; never write `cw_…`
identifiers or `clone-wars`.) Fix the offending file; never weaken the gate.

**FROZEN — never rename:** outbox event names `ready/ack/progress/done/error/question`; sentinel
`END_OF_INSTRUCTION`; JSON fields `ts/summary/artifacts/note/message/fatal/model/topic`;
`handoff-data.kv` key set **and order** (§6); the `contracts.yaml` keys; `CLAUDE_CODE_SESSION_ID`;
state-file conventions (`roster.txt`, `<phase>-<instrument>.txt`/`.done`, `findings-<instrument>.md`,
`adversary-<instrument>.md`, `landscape-draft.md`, `adversary-skip.txt`).

---

## 9. Conventions (per consort CLAUDE.md)

One esbuild bundle `dist/consort.cjs` (commit the refresh). Atomic writes (tmp-in-same-dir +
rename) for all state files. All state paths absolute; `<repo-hash> = sha256(realpath(cwd))`. tmux
only via `execa`; test tmux as pure arg-array builders — never spawn real panes in unit tests.
Typed objects + `JSON.parse` for event matching (skip non-JSON lines). No emojis in shipped output;
errors to stderr, never the outbox. Closed provider set.

---

## 10. Testing & acceptance

**Unit (vitest):**
- `preludeLit`: ON-keyword hits (whole-word; "network" ≠ "networking"), OFF for non-academic,
  empty → OFF.
- `preludeConfidence`: each of S1–S5 true/false branches; `allHold` AND-gate; `renderSkipRecord`
  for not-offered/skip/continue.
- `preludeHandoff`: full kv with convergence; `prelude-no-convergence` (empty top_approach);
  reconciled `confidence_signals` from `adversary-skip.txt`; reconciled `adversary_findings_paths`
  from `adversary-*.md`; missing-`topic.txt` → null/rc2.
- `preludeTurn`: research prompt contains topic + write-to + the correct lit-guidance + the frozen
  done-event line + `END_OF_INSTRUCTION`; adversary prompt inlines the draft + targets the out-path.
- `prelude.ts`: slug derivation (cap 20, empty rejected) + arg parse.

**Command-verb (vitest, injected deps — no real tmux):** init provider-gate branches (0/1→rc1,
>3→cap), classify writes lit-track, research-send/wait offset + question handling + art-dir-flat
findings, synth-preliminary/synth-final validators (incl. skip-aware final), confidence verb
(no-flag write vs `--decision`), adversary-send draft guard, teardown archive dest, handoff-extract
art-dir + rc2.

**Dogfood:** `scripts/dogfood-prelude-loop.sh` — simulate parts end-to-end (codex dir-trust blocks
live spawns; `CONSORT_DRY_RUN=1` skips the tmux nudge): init → classify → (simulate findings) →
synth-preliminary → confidence (both branches) → (simulate adversary critiques) → synth-final →
forensics → teardown/archive → handoff-extract → score-handoff compose → stale-token scan.

**Acceptance:** all 13 verbs behave per §3; the 5-signal gate matches §5; `handoff-data.kv`
populates the reconciled fields; `npm run typecheck` clean, `npm run lint` clean,
`npm run test` green (incl. stale-tokens 7/7), dogfood green; `dist/consort.cjs` rebuilt &
committed; CLAUDE.md phase guard flipped (prelude shipped → **nothing** left out of scope); one PR
on `feat/prelude`.

---

## 11. Risks

- **Signal heuristics are brittle regexes.** Port them byte-faithfully (§5) and unit-test each
  branch; do not "improve" them — the gate's value is its determinism, not its precision.
- **Art-dir-flat findings vs score's partDir.** Prelude keeps findings in `_prelude/` (faithful;
  the gate globs `findings-*.md` there). Do not reuse score's `partDir` findings path.
- **Confidence verb's two-call contract.** The `--decision` re-invocation recomputes signals; they
  must be deterministic so the recorded `signals_passed` matches the first call's print.
- **Reconciled handoff reads.** The `adversary-*.md` glob must not capture `adversary-skip.txt`
  (.txt, excluded) or `<instrument>_adversary_prompt.md` (wrong prefix, excluded) — verify the glob.
