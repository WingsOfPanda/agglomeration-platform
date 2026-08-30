# Provider fallback: codex spawn dies → continue with claude — design

**Date:** 2026-08-30
**Version:** 0.5.64
**Scope:** `commands/quick.md` + `commands/implement.md` (the 0.5.63 retry-once paragraph amended,
plus one fallback paragraph each), a `quick set-provider` verb + a `--reason` extension of
`implement set-provider`, one shared helper in `src/core/implement.ts`, one `job status` line, one
`SUMMARY.md` provider string, one `jobBrief` carve-out, tests. **Wire protocol untouched.**
**Provenance:** user's idea 2026-08-30 after #175/#176; four decisions settled by AskUserQuestion
(order, scope, warning form, gate) — all the recommended options. Amended 2026-08-30 after an
adversarial review (25 findings, 21 upheld) — the amendments are marked inline as **[R]**.

## Problem

0.5.63 made a codex cold-start death (`pane_dead` / ready `timeout`) survivable by retrying the
spawn once. When the retry also dies the run is still terminal: `quick` aborts with a SUMMARY,
`implement` archives and stops, and a detached job ends with nothing done — although a `claude`
worker is installed on every box that runs ap and would have carried the same brief. The operator
then re-launches by hand, usually with `--provider claude`, having lost the run's setup (branch,
args file, pre-snapshot) and, in the detached case, the whole unattended window.

## Goal

When the codex worker fails to spawn twice in `/ap:quick` or `/ap:implement` (attached or
detached), the hub **switches the run to a claude worker and continues** — same brief, same
branch, same round protocol — after mechanically re-routing the run's provider record, rebinding
its own `PROVIDER` value, recording the switch as a flag on the run's issue, and **warning the user
in the main session** with one loud line. Detached runs never park for this; `job status` and the
quick `SUMMARY.md` carry the switch. The switch is codex→claude only; a run that already used
claude, or whose claude spawn fails too, is terminal exactly as today.

## Architecture

### A. Directive — the fallback step (quick + implement)

Two edits per directive.

**(i) The `spawn-retry-once` paragraph's closing sentence is AMENDED** — today it says a second
failure is terminal "whatever its reason", which contradicts the fallback outright. **[R]** In
`commands/quick.md` and `commands/implement.md` it becomes: a **second** failure with provider
`codex` and reason `pane_dead` or `timeout` is NOT terminal — take the **provider fallback** step
below; every other second failure is terminal exactly as today (the abort / archive instruction is
unchanged, only qualified).

**(ii) A `**provider fallback**` paragraph is appended after it.** **[R]** That paragraph lands
**INSIDE** the slice `tests/spawn-retry-directive.test.ts` currently pins (`**spawn-retry-once**` →
`Dispatch round 1` in quick.md, → `## Stage 1 — run the worker turn` in implement.md) — the
earlier claim that it sits outside was false. The test is re-bounded rather than left to overlap:
the retry slice now ends at the `**provider fallback**` anchor and a second slice runs from that
anchor to the old end markers, so neither paragraph can satisfy the other's pins (three retry pins
— `pane_dead`, `timeout`, `once` — would otherwise be satisfiable by the fallback text alone). The
fallback paragraph must not contain the strings `Dispatch round 1` or `## Stage 1 — run the worker
turn`: the helper slices to the FIRST occurrence. Note the split point: the retry sentence's own
forward reference is the FIRST `**provider fallback**`, so the retry paragraph's closing
abort/archive instruction lands at the head of the fallback slice. Harmless — every pin is a
`toContain` and none of the fallback pins appear in that one bled sentence — but it is why the
fallback pins are discriminating rather than a bare `terminal`.

The paragraph says, in order:

1. **Trigger.** The spawn has now failed **twice**, and BOTH hold: the run's provider is `codex`,
   **and** the second spawn's `SPAWN_FAILED reason=` line says `pane_dead` or `timeout`. **[R]**
   That is exactly the retry's own set — `error_event` is NOT in it (settled: the fallback trigger
   is the retry trigger), so neither directive needs to redefine "the cold-start reasons" it
   already defines one paragraph earlier. Any other reason (`binary_not_found`, `config_error`,
   `killed`, `pane_failed`, `spawn_error`), or a provider other than codex, is terminal as today.
2. **`<reason>` is the SECOND spawn's.** **[R]** Both spawns printed a `SPAWN_FAILED reason=` line;
   `<reason>` throughout the paragraph is the value from the **second** (the retry's own Bash
   result), never the first's. Stated once, at first use, so the WARNING line inherits it.
3. **Re-route + record + flag in ONE verb call:**
   - quick: `$CS quick set-provider <SLUG> claude --reason <reason>`
   - implement: `$CS implement set-provider <TOPIC> claude --reason <reason>`

   The verb rewrites the routing file, writes `<art>/provider-fallback.txt`, records the hub flag
   (§B), and prints `PROVIDER=claude`. rc 0 → continue; rc 1/2 → terminal (surface the message).
4. **Rebind `PROVIDER=claude` for the rest of the run.** **[R]** The verb fixes the FILE; the hub
   still holds the `PROVIDER=` value `init` printed. Every later interpolation must now name
   `claude`: implement's spawn line ``$CS spawn lead "$PROVIDER" "$TOPIC"`` and both directives'
   `TS=unreachable` status.json probes (`<SLUG state>/<AGENT>-<PROVIDER>/status.json`,
   `<state>/lead-<PROVIDER>/status.json`) — the failed spawn moved `<agent>-codex` out of the state
   tree into `~/.ap/archive/`, so a probe still spelling `codex` reads a path that no longer
   exists. This widens implement.md's existing "for this spawn" rebind, which is per-spawn only.
   Teardown is NOT in that list: `$CS stop <AGENT> <SLUG>` takes agent+topic and resolves the model
   from the worker dirs itself.
5. **Warn, attached or detached** — print verbatim to the session:
   `WARNING: codex worker failed at spawn twice (reason=<reason>) — continuing with a claude worker
   for <SLUG|TOPIC>. It will use claude tokens.`
   In a detached run the hub has no operator; this is not a decision, so it neither asks nor parks.
   The line still goes to the hub pane transcript, and the switch reaches the operator through
   `job status` (§C) and the run's issue.
6. **Spawn once more with claude** — the SAME spawn command with the provider replaced (`timeout:
   300000`, the existing contract). Nothing to clean up: the failed spawn FAILED-archived its
   `<agent>-codex` dir, so the agent name is free and `<agent>-claude` is minted fresh; implement's
   `assertLeadMatches` passes because `provider.txt` now says claude. Success → continue the
   directive unchanged (turn-send routes by the provider file, so the `ultracode` nudge keyword
   follows automatically). Failure → terminal exactly as the second failure was: **no third retry,
   no further fallback**.
7. **Gate bypass (implement only):** the Claude-confirm gate (`commands/implement.md:236-249`) is
   NOT re-applied on fallback — the WARNING line and the issue flag are the disclosure. The gate
   still applies to a run that auto-detected claude at init.
8. **The run's closing report names the switch** when `<art>/provider-fallback.txt` exists. **[R]**
   Stated inside the fallback paragraph (not only at Stage 4) so it is pinnable by the fallback
   slice. quick needs no extra instruction — `quick summary` already puts it in SUMMARY.md's
   `- Provider:` line.

### B. The `set-provider` verbs

- `quick set-provider <SLUG> <provider> [--reason <r>]` (new; mirror of `implement set-provider`,
  `src/commands/implement.ts:212-227`): validates slug / art dir / `agentBinary(provider)`
  (rc 2 usage, rc 1 no art dir), then `atomicWrite(<art>/selected-provider.txt)` — the file
  `roundProtocol` routes by (`src/core/roundProtocol.ts:68-72, 105-113`).
  **[R] It does NOT rewrite `<exec>/provider.txt`.** Nothing reads that file; it is `quick init`'s
  own record of what was requested, and a verb that also rewrote it would need a test pinning a
  file with no consumer.
- `implement set-provider` gains the same optional `--reason <r>`; behaviour without it is
  **byte-identical** (same rc, same stderr, same stdout — nothing printed).
- **[R] `--reason` takes a CLOSED token set: `pane_dead | timeout`, rc 2 otherwise** ("unknown
  reason", naming the accepted tokens). The reason reaches three sinks that are all
  line-structured — `job status`'s `KEY=value` KV stream, quick's `- Provider: …` markdown bullet,
  and the `recordHubFlag` note on the run's issue — so free text there injects KV keys and breaks
  markdown. Precedent: `FAILURE_REASONS` + its rc-2 refusal in `src/core/forensics.ts:19,66`; this
  set is that set minus `killed`/`error_event`, i.e. exactly what the directive can produce. The
  guard sits in the shared helper both verbs cross, so it covers all three sinks once.
- With a valid `--reason <r>` both verbs additionally: write `<art>/provider-fallback.txt` =
  `PROVIDER_FALLBACK=<old>-><new> reason=<r>\n` (old = the routing file's previous value), call
  `recordHubFlag({ command, topic, note: "PROVIDER_FALLBACK <old>-><new> reason=<r>: codex worker
  failed at spawn twice; continuing with claude" })` so the switch lands on the run's issue (the
  art dir exists before the first spawn in both commands, so this is the run's issue, not a
  spawn-only one), and print `PROVIDER=<new>` on stdout.

### C. Surfaces

- `job status`: **[R]** immediately after the `FINISH=` line, echo `<art>/provider-fallback.txt`'s
  line verbatim when it exists (`src/commands/job.ts` statusRun; `commandArtDir(rec.command,
  rec.topic)` is the art dir). `job.json` is not rewritten (write-once record; sibling files are
  the precedent).
- **[R] `src/core/job.ts`'s `jobBrief`** tells the detached hub `Run parameters. These are settled
  and are NOT yours to change: provider <p>` — which the fallback contradicts. One carve-out line
  after the `provider` row says the provider-fallback step is the exception and is mechanical
  (nothing to ask, nothing to park). That brief is `job.json.provider`'s **only** consumer, so
  after a fallback the record is stale by design and only the brief needs the carve-out.
- quick `SUMMARY.md`: **[R]** no new `SummaryFacts` field. `summaryRun` composes the EXISTING
  `provider` fact — `claude (fallback from codex, reason=<r>)` when `<art>/provider-fallback.txt`
  exists, else the plain `selected-provider.txt` value (`src/commands/quick.ts:471`). The `ok`
  branch's `- Provider:` line therefore names the switch with no change to its rendering. **The
  `aborted` branch gains one conditional bullet** under `## Why aborted` (`src/core/quick.ts`
  aborted return), emitted only when the composed string names a fallback — a fallback whose claude
  spawn also fails aborts with the same `spawn-failed` reason as a plain double-codex failure and
  would otherwise be indistinguishable from it. An abort with no fallback renders byte-identically.
- implement has no `SUMMARY.md`; its Stage 4 final report names the fallback when
  `provider-fallback.txt` exists — instructed inside the fallback paragraph (§A.8) so a directive
  pin can hold it.

### D. Known consequence

`timeout_multiplier` is 1.5 for codex and 1 for claude (`contracts.yaml`), so after a fallback
implement's turn budget is the claude budget (shorter by a third). Accepted: the worker IS claude
now; the budget follows the provider file like everything else.

## Components

- `commands/quick.md` — (a) the retry paragraph's closing sentence amended with the codex +
  `pane_dead`/`timeout` exception before the abort instruction; (b) the `**provider fallback**`
  paragraph after it, carrying the literal token `PROVIDER_FALLBACK` (the artifact line the verb
  writes), the `PROVIDER=claude` rebind, the WARNING line, and the closing-report sentence.
- `commands/implement.md` — same two edits after Stage 1.1's retry-once paragraph, plus the
  gate-bypass sentence.
- **[R] No new `src/core/providerFallback.ts`.** The helper lives in `src/core/implement.ts`
  (88 lines, the smaller of the two cores `set-provider` already routes through):
  `FALLBACK_REASONS` (the closed set), `recordProviderFallback(command, art, topic, from, to,
  reason)` = `atomicWrite` of the line + `recordHubFlag`, and `readProviderFallback(art)` (via
  `readIfExists`) returning `{ raw, from, to, reason } | null` — `raw` for `job status`'s verbatim
  echo, the parts for quick's composed provider string, so the line format is spelled once.
- `src/commands/quick.ts` — `set-provider` verb (dispatch + usage line); `summaryRun` composes the
  `provider` fact.
- `src/commands/implement.ts` — `setProviderRun` parses and validates `--reason`.
- `src/commands/job.ts` — the `status` echo.
- `src/core/job.ts` — `jobBrief`'s settled-parameters carve-out.
- `src/core/quick.ts` — one conditional bullet in `renderSummary`'s aborted branch. `SummaryFacts`
  is unchanged.
- **Tests**
  - `tests/quick-cmd.test.ts` — `set-provider` rewrites `selected-provider.txt`, rc 2 unknown
    provider / arity / bad slug, rc 1 no art dir; with `--reason` writes `provider-fallback.txt`
    with the exact line, prints `PROVIDER=claude`, and files a flag on the RUN's issue — asserted
    on the queue record's front matter (`kind: flag`, `command: quick`, `art_dir:
    <quickArtDir(slug)>`), which is what distinguishes a run-issue flag from a spawn-only one;
    **[R]** `--reason 'timeout\nPARKED=yes'` (and any non-token) → rc 2, no `provider-fallback.txt`,
    no queue record; `quick summary` with `provider-fallback.txt` present → `- Provider: claude
    (fallback from codex, reason=pane_dead)` and, on `--aborted`, the same bullet under
    `## Why aborted`; without the file, `- Provider: codex` and an aborted SUMMARY unchanged.
  - `tests/implement-cmd.test.ts` — `--reason` additions (artifact line, flag record with
    `art_dir: <implementArtDir(topic)>`, `PROVIDER=` stdout, rc 2 on a non-token); without it,
    byte-identical behaviour (no artifact, no flag, no stdout).
  - `tests/job-cmd.test.ts` — `status` echoes `PROVIDER_FALLBACK=` right after `FINISH=` when the
    file exists, and prints no such line otherwise.
  - `tests/job.test.ts` — `jobBrief` carries the provider-fallback carve-out.
  - `tests/spawn-retry-directive.test.ts` — **[R]** `para()` gains a START parameter and asserts
    both anchors are present before slicing (a missing anchor must fail loudly, not silently yield
    a garbage slice). `RETRY_PARAGRAPHS` re-bounds to `**spawn-retry-once**` →
    `**provider fallback**`; every existing retry assertion is unchanged, plus one new pin that the
    retry paragraph carries the exception (so no unqualified "second failure … and stop" survives).
    A second describe slices `**provider fallback**` → `Dispatch round 1` /
    `## Stage 1 — run the worker turn` and pins, whitespace-collapsed: `set-provider`,
    `claude --reason`, `PROVIDER=claude`, `WARNING: codex worker failed at spawn twice`,
    `PROVIDER_FALLBACK`, `provider-fallback.txt`, and — **[R]** discriminating, since a bare
    `terminal` carries no signal — the codex-only trigger (`` the run's provider is `codex` ``,
    `a provider other than codex`), the non-cold-start exclusion (`` Any other reason
    (`binary_not_found` ``, deliberately worded differently from the retry paragraph's
    `Every other reason (`), and `no third retry, no further fallback`. implement.md additionally
    pins the gate-bypass sentence and the closing-report sentence.
    `tests/spawn-timeout-directive.test.ts` unchanged and green.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — 0.5.64;
  `dist/ap.cjs` rebuilt and committed by the hub.

## Testing

Pure unit tests as above (fresh `AP_HOME`, no tmux, `AP_FORENSICS_BACKEND=queue` from
`tests/helpers/setupEnv.ts` — never overridden).
Live: force it once — `/ap:quick` with codex's binary shadowed by a script that exits immediately
(→ `pane_dead`) — and watch: retry, then `WARNING:` line, `selected-provider.txt=claude`, a
`<agent>-claude` worker running the round, the flag comment on the run issue, and
`- Provider: claude (fallback from codex, …)` in SUMMARY.md.

## Success Criteria

- `npm run typecheck` / `lint` / `test` green; dist fresh; the `spawn-retry` assertions and
  `spawn-timeout` directive pins green.
- Two cold-start codex failures in quick/implement → one `set-provider … claude --reason` call,
  one WARNING line, one claude spawn, and the run continues to finish; the run's issue carries the
  `PROVIDER_FALLBACK` flag; `job status` and quick's SUMMARY.md show it.
- A `binary_not_found`/`config_error`/`killed` failure, a claude-provider run, or a failed claude
  fallback spawn remains terminal exactly as 0.5.63 — and the amended retry paragraph carries no
  unqualified "second failure … and stop".
- A fallback whose claude spawn then fails aborts with the fallback named in `SUMMARY.md`.
- `job status`'s stdout stays one line per key across a fallback (closed reason set).
- `implement set-provider` without `--reason` is byte-identical to today.

## Non-goals

- Any direction other than codex→claude; agy/opencode as fallback targets.
- design/explore/autoresearch/bridge (per-worker degradation already exists in the ensembles;
  bridge is single-worker but a separate spec if wanted).
- Pre-checking claude availability (the spawn's own `binary_not_found` is the check).
- Asking or parking before the switch (settled: auto-continue + disclosure).
- Rewriting `job.json`, or `<exec>/provider.txt`.
- A `formatSummaryBlock` line for implement (its Stage 4 report mention covers it; a second surface
  is not earned).
