# CLAUDE.md — agglomeration-platform

Guidance for Claude Code working in this repository. These instructions override default
behavior. The machine-wide `~/.claude/CLAUDE.md` and the workspace `/home/liupan/CC/CLAUDE.md`
also apply and are not restated here.

> **Naming lineage (all cosmetic; the wire protocol is frozen throughout).** This plugin was a Bash
> tool, rewritten to TypeScript as `consort`, then renamed + de-musicalized to **`agglomeration-platform`**
> (the 2026-06-15 rebrand: spec/plan under `docs/superpowers/{specs,plans}/2026-06-15-agglomeration-platform-rebrand*`).
> Historical specs/plans under `docs/` still use the older `consort`/musical names and are left as a
> dated record. The shipped code (below) is the source of truth.

## What this is

`agglomeration-platform` is a Claude Code plugin where a **hub** (a Claude Code session running
`/ap:*` commands) spawns and orchestrates real interactive model TUIs (`codex` / `claude` / `agy` /
`opencode`) as **tmux panes** the user can attach to. Coordination is **file-based IPC**
(inbox / outbox / status / pane), not in-process messaging. The platform agglomerates **agents** into
color-coded **clusters**; a spawned agent working a task is a **worker**.

The **wire protocol, state layout, and tmux mechanics are frozen** so the external model binaries are
drop-in. One committed `dist/ap.cjs` (zero-build install) is dispatched by subcommand.

## Canonical docs — read before touching code

| Doc | What it is |
|---|---|
| `docs/superpowers/specs/2026-06-15-agglomeration-platform-rebrand-design.md` | the rebrand spec (vocabulary, frozen wall, gate, PR split) |
| `docs/superpowers/specs/2026-05-29-consort-foundation-design.md` | the original foundation design (historical names) — IPC + tmux contract, acceptance |
| `MIGRATION.md` | full architecture + phasing reference (historical names; carries a rebrand banner) |
| `docs/superpowers/specs/2026-06-04-multi-repo-retirement-design.md` | why the multi-sub-repo subsystem was retired |

## Current phase guard — load-bearing

**Shipped:** the foundation (scaffold + `core/*` + the primitives `spawn`/`send`/`collect`/`preflight`)
and the high-level commands **`quick`**, **`design`**, **`implement`**, **`review`**,
**`autoresearch`**, **`explore`**, plus the operational commands **`list`**, **`stop`**, **`check`**,
and the cross-repo **`bridge`** — each grounded by its own spec under `docs/superpowers/specs/` and a
live dogfood. `autoresearch` ships the full research-validity layer (verify / sanity / INFEASIBLE-vs-REFUTED
/ coverage / lineage / independent inspector).

**Single-repo only.** The multi-sub-repo subsystem was retired (design:
`docs/superpowers/specs/2026-06-04-multi-repo-retirement-design.md`): no `--targets`, no multi-repo
detection, no DAG/wave/sibling execution. New behavior beyond a faithful port — or a deliberate
divergence like the retirement or the rebrand — needs its own spec under `docs/superpowers/specs/`; do
not import features across command boundaries without a design doc.

## Vocabulary & the frozen protocol

The current (de-musicalized) vocabulary:

| Concept | Term |
|---|---|
| orchestrating Claude Code session | **hub** (IPC `From: hub`) |
| configured model role (`agents.yaml`) + `pane.json`/`ready` JSON key | **agent** |
| a spawned agent working a task | **worker** |
| color grouping of agents (pane-border color family) | **cluster** (`azure`/`sage`/`amber`/`slate`/`ivory`/`violet`/`neutral`) |
| default agent call-signs | NATO phonetic (`alpha`..`zulu`, in `config/agents.yaml` + `core/colors.ts`) |
| teardown banner | **DONE** |
| namespace / env / state dir / tmux opts / bundle | `ap` (`/ap:<verb>`) / `AP_HOME` / `.ap/` / `@ap_*` / `dist/ap.cjs` |
| commands | `design` `explore` `autoresearch` `implement` `quick` `review` `list` `stop` `check` `bridge` |
| primitives (CLI-internal plumbing) | `spawn` `send` `collect` `preflight` `hook` — unchanged |

**FROZEN — never rename** (drop-in compatibility with the external model binaries depends on it):
event names `ready/ack/progress/done/error/question`; sentinel `END_OF_INSTRUCTION`; JSON fields
`ts/summary/artifacts/note/message/fatal/task_summary/model/topic`; `contracts.yaml` keys
(`binary/modes/default_mode/ready_timeout_s/bootstrap_sleep_s/timeout_multiplier/consult_validated` —
**`consult_validated` keeps that name** though the command is now `design`); state filenames;
`CLAUDE_CODE_SESSION_ID`. Note the `autoresearch` command keeps a **`score`** subcommand and an
internal **scoreboard** metric (`buildScoreboard`/`ScoreRow`) — that `score` is the metric, distinct
from the retired `score` command (now `design`); do not rename it.

A `tests/stale-tokens.test.ts` gate fails the build if removed brand/metaphor tokens reappear in
shipped `src`/`config`/`commands`/`hooks`/`.claude-plugin`: case-sensitive `clone-wars`/`cw_`/
`master-yoda`/`MISSION ACCOMPLISHED`/`@cw_`/`cs_`/`@cs_`; case-insensitive `trooper`/`commander`/
`consort`/`maestro`/`instrument`. Generic English (`part`/`section`/`score`/`perform`/`solo`/`fine`)
is intentionally **not** banned (false positives). Fix the offending file; never weaken the gate.

## Architecture & conventions

- **One esbuild bundle:** `dist/ap.cjs`, dispatched by subcommand (`src/ap.ts` →
  `src/commands/<verb>.run(args)`). Logic in `src/core/*`; one file per responsibility.
- **`dist/` is committed** (zero-build install). After changing `src/`, run `npm run build` and
  commit the refreshed `dist/ap.cjs`.
- **tmux is the only subprocess surface** (via `execa`). Test tmux code as **pure arg-array
  builders**; never spawn real panes in unit tests (live behavior = the dogfood).
- **Typed objects + `JSON.parse`, not shell parsing.** Event matching is `JSON.parse(line)` then
  `obj.event === name` (never the anchored regex). Skip non-JSON lines.
- **Atomic writes** for `status.json`/`pane.json`/`inbox.md`/identity: tmp-in-**same-dir** + rename.
  Never write to `/tmp` then rename (cross-device renames aren't atomic).
- **All state paths absolute**; `<repo-hash> = sha256(realpath(cwd))` with no trailing newline.
- No emojis in shipped output (grep-ability). Errors to **stderr**, never the outbox. Closed
  provider set (a new provider = a `contracts.yaml` row + dogfood, not an open OpenAI-compat set).

## Commands (toolchain)

```
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run lint        # eslint
npm run build       # esbuild → dist/ap.cjs (commit the result)
```

Test isolation: set `AP_HOME` to a fresh temp dir per test (see `tests/helpers/tmpHome.ts`).
For the live dogfood, run inside tmux with `CLAUDE_PLUGIN_ROOT=$PWD`.

## CodeGraph

This project has CodeGraph initialized (`.codegraph/`) and the `codegraph_*` MCP tools. Prefer it
for structural questions (where is X, what calls Y, what breaks if Z changes) over grep. The
index lags writes by ~1s via the file watcher; check the staleness banner before trusting stale files.
