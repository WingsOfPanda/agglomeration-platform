# Worker delegation reminder: every worker hands the grind to its execution subagents — design

**Date:** 2026-09-05
**Version:** 0.5.73
**Scope:** one paragraph appended to the worker role block in `src/core/ipc.ts` (rendered into every
worker's and, by composition, every slice's `identity.md`; the job hub excluded), one fixture
regenerated, one test. No directive, verb, or wire-protocol change.
**Provenance:** user's request 2026-09-05, after the Fable-seat rule in the global `CLAUDE.md` and the
Astra/Sol rule in the codex `AGENTS.md` were aligned with each other. Ten decisions settled in a grill
session (all the recommended options); facts from a four-reader sweep of 0.5.72.

## Problem

A spawned codex worker runs the operator's default model: ap passes no model flag, so `config.toml`
decides, and on this fleet that is the orchestrator-tier model at the highest reasoning effort. The
operator's `~/.codex/AGENTS.md` tells that model to keep decomposition and review and to hand
implementation, repository sweeps, test runs and log analysis to cheaper execution subagents; codex
loads that file for every session regardless of cwd, multi-agent is enabled, and a subagent default
model is configured. Inside ap the worker nevertheless does the whole brief itself.

The likeliest cause is ap's own identity text. The worker role block carries a hard rule, "Do NOT
background your own work (... do NOT spawn detached processes for your investigation)", which a
careful worker reads as a ban on subagents. Codex's own developer message adds a second gate: it
spawns subagents only when "applicable AGENTS.md/skill instructions explicitly ask" for them, and
ap's brief never does. A claude worker on the expensive tier under the global `CLAUDE.md` Fable-seat
rule has the same shape. Net effect: the most expensive model runs the tool-output loops.

The failure mode of the opposite direction is already on record: `src/core/wait.ts` notes a codex
worker in internal-agents mode emitting `done` mid-turn and continuing to work.

## Goal

Every ap worker whose own instructions define an orchestrator/executor split applies it inside its
turn, and the ap protocol survives the delegation: one writer of the worker's IPC files, one `done`.

## Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Scope | every worker of every command; slices by composition; the job hub excluded (its executors are ap workers) |
| D2 | Placement | the worker role block in `src/core/ipc.ts`, beside the foreground rule it reconciles; not the per-turn inbox wrapper |
| D3 | Wording | provider-neutral: no model or role names in shipped text; the pointer is "your instructions" |
| D4 | Foreground rule | kept as is; subagents are declared in-session foreground work |
| D5 | Guardrail | the worker alone writes its outbox, status, report and result files and emits `done` once, after reviewing the subagents' diff |
| D6 | Providers | one paragraph serves codex (`AGENTS.md`) and claude (`CLAUDE.md` Fable seat); no provider branch in code |
| D7 | Verification | the next real `/ap:quick` or `/ap:implement` run, recorded here as an amendment; no dedicated dogfood |

## Design

The paragraph appended to `WORKER_BLOCKS.role_block`, verbatim:

> **Delegate the grind:** if your instructions define an orchestrator/executor split (a cheaper
> execution model for subagents), apply it here: keep the plan, the decisions and the final review;
> hand implementation, repository sweeps, test runs and log analysis to execution subagents with an
> explicit model and effort. Subagents run inside your session and count as foreground work; you
> alone write this worker's outbox, status, report and result files, and you emit `done` once, after
> reviewing their diff.

Leading words are borrowed on purpose: "grind" is the global `CLAUDE.md`'s word, and "repository
sweeps, test runs and log analysis" is the `AGENTS.md` list, so the worker links the paragraph to the
rule it already carries. Both sentences state the target behavior; the only prohibition in the block
stays the pre-existing one on backgrounded shells and detached processes, which subagents are not.

## Testing

- `tests/fixtures/identity-worker.md` regenerated from the render, never hand-edited;
  `identity-job-hub.md` unchanged.
- `tests/job-hub-template.test.ts`: the worker and slice identities contain the paragraph, the hub's
  does not. MUTATION: deleting the paragraph from the role block turns the test red.
- The stale-tokens gate is unaffected: none of the paragraph's words are banned.

## Dogfood checklist (next real run; append the record here)

- The worker's codex session shows subagent spawns for implementation, sweeps or test runs
  (`codex agents`, or the session log).
- The worker's token count against a previous run of similar size.
- Exactly one `done` in the outbox, after the report; none from a subagent.
- For claude workers: `Agent`/Workflow calls carrying an explicit cheaper model.

## Risks

- `/ap:quick` has no premature-`done` hold (implement does, since 0.5.70). A subagent that emits
  `done` ends a quick turn early; the guardrail sentence is the only defense today. If the dogfood
  shows it, extend the hold to quick under its own spec.
- A long session may compact the identity away. If the rule fades, add a one-line pointer to the
  per-turn inbox wrapper in `inboxWrite`.
- A worker whose instructions define no such split reads a conditional that never fires; the cost is
  one paragraph per spawn.

## Non-goals

Choosing the worker's own model or effort (the operator's codex/claude config owns that); a
provider-conditional composer; any change to the job hub's identity or to the turn briefs.

## Frozen protocol

Untouched: event names, the sentinel, JSON fields, state filenames, `contracts.yaml` keys.
