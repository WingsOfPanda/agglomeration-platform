# Explore ultracode workers (opt-in) — design

Date: 2026-07-24
Status: approved (user-requested: "for explore command, when we launch claude code part, can we
launch it with ultracode?")

## Problem

Claude Code has a per-prompt "ultracode" keyword trigger (settings key
`workflowKeywordTriggerEnabled`, default on — verified against the installed binary's settings
schema: *"including the keyword in a prompt opts that turn into the Workflow tool"*). A claude
worker whose turn is opted in orchestrates its own multi-agent Workflow fleets — exactly the depth
a research turn wants.

ap's claude workers can never opt in today. The worker's typed pane prompt is only the fixed nudge
line (`src/commands/send.ts:30` — `Read <inbox> and execute the task. Reply when done.`); the
actual brief arrives through a Read tool call on `inbox.md`. The binary's trigger copy is
per-prompt typed-input scanning ("this prompt"/"this turn" banner + per-prompt toggle); whether
tool-result content is also scanned is unproven, so the typed nudge is the only placement known to
work — and a correct one either way. There is no CLI flag or session-wide switch to enable
ultracode at spawn time, so no `contracts.yaml` `modes` row can do it either.

## Goal

An opt-in, per-run mechanism: when the hub sets `AP_ULTRACODE=1` on a dispatch, a **claude**
worker's nudge line carries the `ultracode` keyword, opting that worker turn into Workflow
orchestration. Non-claude providers and default (env unset) runs produce byte-identical nudges to
0.5.2. `/ap:explore`'s directive documents the wiring so a user asking for ultracode workers gets
them on every explore turn.

## Architecture

Gate in the shared send path. Every command's mid-run worker dispatch — explore's
`research-send`/`openq-send`/`crossverify-send`/`adversary-send`/`rebuttal-send`/`gap-send`/
`signoff-send`, plus hub relays via `ap send` — flows through `run()` in `src/commands/send.ts`
(design/implement/bridge/quick/autoresearch import `sendRun` from the same module). One pure
helper composes the nudge:

```ts
taskNudge(inbox, model, env = process.env)
// env.AP_ULTRACODE === "1" && model === "claude"
//   -> `Read <inbox> and execute the task with ultracode. Reply when done.`
// otherwise the existing line, byte-for-byte
```

Decisions and their reasons:

- **Env var, not a flag.** `AP_ULTRACODE=1` follows the existing `AP_AUTORESEARCH_AUTONOMOUS` /
  `AP_DRY_RUN` `=== "1"` convention, and needs no flag-threading through explore's seven send
  verbs — each `$CS` child process inherits the hub's per-call environment.
- **Claude-only gate.** codex/agy/opencode have no ultracode trigger; their nudges never change.
- **Send path only.** The spawn initial-task nudge (`src/commands/spawn.ts`) and autoresearch's
  injected dispatch nudge (`src/commands/autoresearch.ts`) keep the plain line — explore spawns
  with no initial task, and widening the surface is not needed for the driving use case. If the
  keyword is ever wanted there, extend `taskNudge` adoption; do not fork the string.
- **Frozen wall untouched.** The nudge sentence is not on the frozen list; no event names, JSON
  fields, `contracts.yaml` keys, sentinels, or state filenames change.
- **Directive wiring ships for explore only.** The send-layer mechanism is command-agnostic by
  construction (any directive could set the env), but only `commands/explore.md` advertises it —
  importing the behavior into other command directives needs its own spec per the repo rule.
- **Per-turn semantics are a feature.** The keyword opts in one turn; because every dispatch
  re-types the nudge, prefixing each send re-arms it — no worker-session state to manage.

Cost note (documented in the directive): an ultracode'd claude worker fans out Workflow fleets
inside each turn, on top of explore's own N-worker ensemble — real token volume, and long
workflow runs eat into the turn timeout.

Entitlement caveat: the keyword only fires when the worker account's Workflows feature is active —
the binary additionally gates on the `allow_workflows` entitlement, workflow availability, and
`enableWorkflows`/`disableWorkflows`/`CLAUDE_CODE_DISABLE_WORKFLOWS`. On a deployment without
Workflows the keyword is a silent no-op and the nudge degrades to a plain extra phrase — harmless,
but the depth benefit is environment-dependent (verify per box before relying on it).

## Components

- `src/commands/send.ts` — new exported pure helper `taskNudge(inbox: string, model: string,
  env?: NodeJS.ProcessEnv): string`; the `run()` nudge call site uses it.
- `commands/explore.md` — new "Ultracode workers (opt-in)" paragraph after the `Let CS=` line:
  when the user's ask contains "ultracode", prefix every `$CS explore *-send` dispatch and every
  `$CS send --from hub …` relay with `AP_ULTRACODE=1`.
- `tests/send-nudge.test.ts` — pure unit tests for `taskNudge` (no tmux, no panes).
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — version
  0.5.2 → 0.5.3.
- `dist/ap.cjs` — rebuilt and committed (zero-build install).

## Testing

Pure unit tests on `taskNudge` (`tests/send-nudge.test.ts`):

- env unset → exact legacy string (byte-identical to 0.5.2).
- `AP_ULTRACODE=1` + `claude` → `Read <inbox> and execute the task with ultracode. Reply when
  done.`
- `AP_ULTRACODE=1` + `codex` → legacy string (provider gate).
- `AP_ULTRACODE=0` (or any non-`"1"`) + `claude` → legacy string (strict `"1"` semantics).

Gate: `npm run typecheck` + `npm run lint` + `npm run test` + `npm run build` all green; the
stale-tokens gate is untouched ("ultracode" is not a banned token).

## Success Criteria

- `AP_ULTRACODE=1 ap send --from hub <claude-agent> <topic> "<task>"` types a nudge ending
  `…execute the task with ultracode. Reply when done.` into the claude pane (dogfood check:
  `tmux capture-pane`), and the worker's turn shows the ultracode opt-in.
- With the env var unset, every nudge in the system is byte-identical to 0.5.2 behavior.
- A codex/agy/opencode worker's nudge never contains the keyword, env var or not.
- `commands/explore.md` documents the opt-in prefix; full suite green; dist committed.
