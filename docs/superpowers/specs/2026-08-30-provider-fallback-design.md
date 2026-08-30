# Provider fallback: codex spawn dies → continue with claude — design

**Date:** 2026-08-30
**Version:** 0.5.64
**Scope:** `commands/quick.md` + `commands/implement.md` (one fallback paragraph each, after the
0.5.63 retry-once), a `quick set-provider` verb + a `--reason` extension of `implement set-provider`,
one `job status` line, one `SUMMARY.md` line, tests. **Wire protocol untouched.**
**Provenance:** user's idea 2026-08-30 after #175/#176; four decisions settled by AskUserQuestion
(order, scope, warning form, gate) — all the recommended options.

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
branch, same round protocol — after mechanically re-routing the run's provider record, recording the
switch as a flag on the run's issue, and **warning the user in the main session** with one loud line.
Detached runs never park for this; `job status` and the quick `SUMMARY.md` carry the switch. The
switch is codex→claude only; a run that already used claude, or whose claude spawn fails too, is
terminal exactly as today.

## Architecture

### A. Directive — the fallback step (quick + implement)

Appended **after** the `spawn-retry-once` paragraph in each directive (outside the slice
`tests/spawn-retry-directive.test.ts` pins, so those pins stay byte-valid), as a `**provider
fallback**` paragraph:

1. Trigger: the spawn has now failed **twice** (the first `pane_dead`/`timeout` earned the retry;
   the second failure is any cold-start reason `pane_dead`/`timeout`/`error_event`) **and** the
   run's provider is `codex`. Any other reason (`binary_not_found`, `config_error`, `killed`,
   `pane_failed`, `spawn_error`), or a provider other than codex, is terminal as today.
2. Re-route + record + flag in **one** verb call:
   - quick: `$CS quick set-provider <SLUG> claude --reason <reason>`
   - implement: `$CS implement set-provider <TOPIC> claude --reason <reason>`
   The verb rewrites the routing file, writes `<art>/provider-fallback.txt`, and records the hub
   flag (§B). rc 0 → continue; rc 1/2 → terminal (surface the message).
3. **Warn, attached or detached** — print verbatim to the session:
   `WARNING: codex worker failed at spawn twice (reason=<reason>) — continuing with a claude worker
   for <SLUG|TOPIC>. It will use claude tokens.`
   In a detached run the hub has no operator; the line still goes to the hub pane transcript, and
   the switch reaches the operator through `job status` (§C) and the run's issue.
4. Spawn once more with claude — the SAME `$CS spawn <AGENT> claude <SLUG> …` command (`timeout:
   300000`, the existing contract). Nothing to clean up: the failed spawn FAILED-archived its
   `<agent>-codex` dir, so the agent name is free and `<agent>-claude` is minted fresh; implement's
   `assertLeadMatches` passes because `provider.txt` now says claude. Success → continue the
   directive unchanged (turn-send routes by the provider file, so the `ultracode` nudge keyword
   follows automatically). Failure → terminal exactly as the second failure was (no third retry,
   no further fallback).
5. **Gate bypass (implement only):** the Claude-confirm gate (`commands/implement.md:236-249`) is
   NOT re-applied on fallback — the WARNING line and the issue flag are the disclosure. The gate
   still applies to a run that auto-detected claude at init.

### B. The `set-provider` verbs

- `quick set-provider <SLUG> <provider> [--reason <r>]` (new; mirror of `implement set-provider`,
  `src/commands/implement.ts:212-227`): validates slug / art dir / `agentBinary(provider)`
  (rc 2 usage, rc 1 no art dir), then `atomicWrite(<art>/selected-provider.txt)` — the file
  `roundProtocol` routes by (`src/core/roundProtocol.ts:68-72, 105-113`); also rewrites the
  never-read `<exec>/provider.txt` for consistency.
- `implement set-provider` gains the same optional `--reason <r>`; behaviour without it unchanged.
- With `--reason <r>` both verbs additionally: write `<art>/provider-fallback.txt` =
  `PROVIDER_FALLBACK=<old>-><new> reason=<r>\n` (old = the file's previous value), and call
  `recordHubFlag({ command, topic, note: "PROVIDER_FALLBACK <old>-><new> reason=<r>: codex worker
  failed at spawn twice; continuing with claude" })` so the switch lands on the run's issue (the
  art dir exists before the first spawn in both commands, so this is the run's issue, not a
  spawn-only one). Print `PROVIDER=<new>` on stdout.

### C. Surfaces

- `job status`: after the `FINISH=` line, echo `<art>/provider-fallback.txt` verbatim when it exists
  (`src/commands/job.ts` ~512; the job record knows command + topic → art dir). `job.json` is not
  rewritten (write-once record; sibling files are the precedent).
- quick `SUMMARY.md`: `SummaryFacts` gains optional `providerFallback`; `renderSummary` prints
  `- Provider: claude (fallback from codex, reason=<r>)` when set (`src/core/quick.ts:95-146`),
  sourced from `provider-fallback.txt` by `quick summary`.
- implement has no SUMMARY.md; its final report line in the directive names the fallback when
  `provider-fallback.txt` exists.

### D. Known consequence

`timeout_multiplier` is 1.5 for codex and 1 for claude (`contracts.yaml`), so after a fallback
implement's turn budget is the claude budget (shorter by a third). Accepted: the worker IS claude
now; the budget follows the provider file like everything else.

## Components

- `commands/quick.md` — the fallback paragraph after the retry-once paragraph (step 2 failure
  branch); the final report mentions the fallback when recorded.
- `commands/implement.md` — same after Stage 1.1's retry-once paragraph; gate-bypass sentence; the
  Stage 4 final summary names the fallback when recorded.
- `src/commands/quick.ts` — `set-provider` verb (dispatch + usage line).
- `src/commands/implement.ts` — `setProviderRun` parses `--reason`; shared helper in
  `src/core/providerFallback.ts` (new, small): `recordProviderFallback(command, art, topic, oldP,
  newP, reason)` = write `provider-fallback.txt` + `recordHubFlag`; `readProviderFallback(art)`.
- `src/commands/job.ts` — status line.
- `src/core/quick.ts` — `SummaryFacts.providerFallback`, `renderSummary` line; `src/commands/quick.ts`
  summary verb reads it.
- **Tests**
  - `tests/quick-cmd.test.ts` — `set-provider` rewrites `selected-provider.txt` (+ `provider.txt`),
    rc 2 unknown provider / arity, rc 1 no art dir; with `--reason` writes `provider-fallback.txt`
    with the exact line and records a flag (assert via the queue record under `AP_FORENSICS_BACKEND=queue`);
    turn-send after set-provider resolves `<agent>-claude`.
  - `tests/implement-cmd.test.ts` — `--reason` additions; without it, byte-identical behaviour.
  - `tests/job-cmd.test.ts` — status echoes `PROVIDER_FALLBACK=` when the file exists, absent otherwise.
  - `tests/quick-core.test.ts` (or where `renderSummary` is pinned) — the Provider line with/without fallback.
  - `tests/spawn-retry-directive.test.ts` — a second describe pinning, whitespace-collapsed, in
    both directives after the `**provider fallback**` anchor: `set-provider`, `claude --reason`,
    `WARNING: codex worker failed at spawn twice`, `PROVIDER_FALLBACK`, `terminal`; the
    retry-once pins unchanged; `tests/spawn-timeout-directive.test.ts` unchanged and green.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — 0.5.64;
  `dist/ap.cjs` rebuilt and committed by the hub.

## Testing

Pure unit tests as above (fresh `AP_HOME`, no tmux, `AP_FORENSICS_BACKEND=queue` from setup).
Live: force it once — `/ap:quick` with codex's binary shadowed by a script that exits immediately
(→ `pane_dead`) — and watch: retry, then `WARNING:` line, `selected-provider.txt=claude`, a
`lead-claude`/`<agent>-claude` worker running the round, the flag comment on the run issue, and
`- Provider: claude (fallback from codex, …)` in SUMMARY.md.

## Success Criteria

- `npm run typecheck` / `lint` / `test` green; dist fresh; `spawn-retry` and `spawn-timeout`
  directive pins untouched and green.
- Two cold-start codex failures in quick/implement → one `set-provider … claude --reason` call,
  one WARNING line, one claude spawn, and the run continues to finish; the run's issue carries the
  `PROVIDER_FALLBACK` flag; `job status` and quick's SUMMARY.md show it.
- A `binary_not_found`/`config_error`/`killed` failure, a claude-provider run, or a failed claude
  fallback spawn remains terminal exactly as 0.5.63.
- `implement set-provider` without `--reason` is byte-identical to today.

## Non-goals

- Any direction other than codex→claude; agy/opencode as fallback targets.
- design/explore/autoresearch/bridge (per-worker degradation already exists in the ensembles;
  bridge is single-worker but a separate spec if wanted).
- Pre-checking claude availability (the spawn's own `binary_not_found` is the check).
- Asking or parking before the switch (settled: auto-continue + disclosure).
- Rewriting `job.json`.
