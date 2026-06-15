# Agglomeration-Platform Rebrand — Design

**Date:** 2026-06-15
**Status:** approved (brainstorming)
**Scope of this design:** the **rename only** — repository, plugin identity, command namespace,
role-noun vocabulary, command verbs, env/state/tmux names, and the stale-token gate. Actual
**publish-readiness** (npm `private` flag, marketplace listing, pruning `target-user-analysis.*` and
dogfood artifacts) is a deliberate **next** spec, not this one.

## Why

The project is being forwarded toward a publishable, usable product under a new descriptive name.
The GitHub repo has already been renamed `WingsOfPanda/consort` → `WingsOfPanda/agglomeration-platform`
(old URL auto-redirects; local `origin` updated). This spec covers the **internal identity** that the
repo rename does not touch.

The owner chose a **total de-musicalization**: replace the entire "consort" musical metaphor
(Maestro / instrument / part / section / FINE, plus the musical command verbs) with a professional
platform vocabulary. The framing of the new name is literal: *a platform that agglomerates **agents**
into **clusters**, coordinated by a **hub***.

This is a deliberate divergence beyond the faithful clone-wars→consort port, which is exactly why it
gets its own spec (per the `CLAUDE.md` phase guard). It does **not** revive any retired capability
(multi-repo stays retired); it is purely a naming/identity change.

## Goal

Rename every **cosmetic** identity token across the shipped plugin surface and active docs to the new
vocabulary, **while preserving the frozen wire protocol byte-for-byte** so the external model binaries
(`codex`/`claude`/`agy`/`opencode`) behave identically. Behavior is unchanged; only names change.

## Locked vocabulary

### Identity / packaging

| Concept | consort | agglomeration-platform |
|---|---|---|
| GitHub repo (done) | `consort` | `agglomeration-platform` |
| npm package (`package.json` `name`) | `consort` | `agglomeration-platform` |
| marketplace id (`marketplace.json` top-level `name`) | `consort` | `agglomeration-platform` |
| plugin id / command namespace (`plugin.json` `name`, marketplace plugin `name`) | `consort` | **`ap`** → `/ap:<verb>` |
| env home var | `CONSORT_HOME` | `AP_HOME` |
| state dir | `.consort/` | `.ap/` |
| tmux option prefix | `@cs_*` | `@ap_*` |
| internal fn prefix | `cs_` | `ap_` |
| bundle entry / output | `src/consort.ts` / `dist/consort.cjs` | `src/ap.ts` / `dist/ap.cjs` |

Note the **two distinct names**: the npm/marketplace id is the full `agglomeration-platform`; the
plugin id (which *is* the slash-command namespace) is the short `ap`. They intentionally differ so
users type `/ap:design`, not `/agglomeration-platform:design`.

### Role nouns

| consort | agglomeration-platform | Notes |
|---|---|---|
| `Maestro` (conductor) / IPC `From: maestro` | `hub` / `From: hub` | the orchestrating Claude Code session |
| `instrument` (cast/config) + `instruments.yaml` | `agent` + `agents.yaml` | **also a JSON key** in `pane.json`/`ready` — see Careful Renames |
| `part` (running worker instance) | `worker` | |
| `section` (color grouping) | `cluster` | sub-labels `strings/woodwinds/brass/percussion/keys/early` → neutral `cluster` labels |
| `FINE` (teardown banner) | `DONE` | human banner only; the frozen `done` *event* is untouched |

### Command verbs

Renames `commands/<verb>.md`, `src/commands/<verb>.ts`, the dispatch table in the bundle entry, and
internal `<verb>*` module/symbol names (e.g. `rehearsal*` → `autoresearch*`, `prelude*` → `explore*`).

| old | new | | old | new |
|---|---|---|---|---|
| `score` | `design` | | `playback` | `review` |
| `prelude` | `explore` | | `roster` | `list` |
| `rehearsal` | `autoresearch` | | `coda` | `stop` |
| `perform` | `implement` | | `soundcheck` | `check` |
| `solo` | `quick` | | `duet` | `bridge` |

CLI-internal primitives `spawn` / `send` / `collect` / `preflight` / `hook` are **unchanged** (plumbing,
not user surface). File renames:

- `commands/`: `score.md`→`design.md`, `prelude.md`→`explore.md`, `rehearsal.md`→`autoresearch.md`,
  `perform.md`→`implement.md`, `solo.md`→`quick.md`, `playback.md`→`review.md`, `roster.md`→`list.md`,
  `coda.md`→`stop.md`, `soundcheck.md`→`check.md`, `duet.md`→`bridge.md`.
- `src/commands/`: the same 10 `.ts` renames; `collect.ts`/`send.ts`/`spawn.ts`/`preflight.ts`/`hook.ts`
  keep their names.

## The frozen wall — never rename

The byte-faithful port's whole value is that the external model binaries see an unchanged protocol.
None of the following changes:

- **Event names:** `ready` / `ack` / `progress` / `done` / `error` / `question`
- **Sentinel:** `END_OF_INSTRUCTION`
- **JSON fields:** `ts` / `summary` / `artifacts` / `note` / `message` / `fatal` / `task_summary` /
  `model` / `topic`
- **`contracts.yaml` keys:** `binary` / `modes` / `default_mode` / `ready_timeout_s` /
  `bootstrap_sleep_s` / `timeout_multiplier` / `consult_validated` — **including `consult_validated`,
  which keeps that exact name even though the command is now `design`.** An inline comment will mark it
  so no future sweep "fixes" it. The `contracts.yaml` *filename* also stays.
- **State filenames:** `status.json` / `pane.json` / `inbox.md` / `outbox` / etc. (the *files*; the
  containing dir `.consort/`→`.ap/` is cosmetic and does move).
- **`CLAUDE_CODE_SESSION_ID`** (Claude Code's, not ours).

## Careful renames (allowed, but load-bearing)

1. **`instrument` → `agent` as a JSON key.** `instrument` is the cosmetic rename of clone-wars'
   `commander` key (concept + `pane.json`/`ready` JSON key); it is **not** in the frozen JSON-field
   list, so it is renameable. Both writer and reader are consort code, so it is internal — but at 835
   occurrences and crossing state I/O (`pane.json`, the `ready` handler, `agents.yaml` parsing, the
   bootstrap instruction that tells a worker what to emit), it gets its **own PR** (PR 2) and a live
   dogfood. Pre-existing `.consort/` runtime state is abandoned regardless, because the state dir
   becomes `.ap/`.
2. **`From: maestro` → `From: hub`.** An IPC value workers read as prose in their inbox; consort
   authors both ends, so renaming is safe as long as it is consistent.

## Stale-token gate rework (the known landmine)

`tests/stale-tokens.test.ts` scans `src config commands hooks .claude-plugin` (it deliberately
**excludes** `docs/`, and never scanned root `README`/`MIGRATION`/`CLAUDE.md`). It must enforce that
the new shipped surface is free of the *removed* identity tokens — but **only unambiguous ones**, never
generic English.

- **Keep** the existing clone-wars bans: `clone-wars`, `cw_`, `master-yoda`, `MISSION ACCOMPLISHED`,
  `@cw_` (case-sensitive) and `trooper`, `commander` (case-insensitive).
- **Add** consort-era brand bans: `cs_`, `@cs_` (case-sensitive); and `consort`, `maestro`,
  `instrument` (**case-insensitive** — `consort` must be case-insensitive so it also catches
  `CONSORT_HOME`, `.consort`, `Consort`; a case-sensitive `consort` would miss the uppercase env var).
- **Do NOT ban** generic English that doubles as a removed term: `part`, `section`, `score`
  (→ `scoreboard` lives in the autoresearch code!), `perform`, `solo`, `fine`. Banning these is the
  exact false-positive trap that bit prior implementers. Verb removal is proven by the renamed command
  files + dispatch, not by the gate.

The gate flips to its final form in **PR 3** (after both the brand and role-noun renames have landed),
so it never red-flags a legitimately-still-present token mid-migration.

## Docs scope

- **`docs/` historical specs/plans** (1,176 `consort` refs): left **as-is** — dated record, already
  gate-excluded. This rebrand spec is added to `docs/`.
- **`README.md`** (publish face), **`CLAUDE.md`** (active project guide, incl. its "musical rebrand
  (locked)" section), **`MIGRATION.md`** (active architecture reference): **rewritten** to the new
  identity. None are gated, so they cannot fail the build, but they are user/maintainer-facing and must
  reflect reality.
- `scripts/` (release/build helpers): swept for `consort`/identity tokens like any shipped area.

## PR sequencing

Each PR keeps `typecheck` + `test` + `lint` + `build` + the stale-token gate green, and is independently
shippable. Land in order:

| PR | Scope | Risk |
|---|---|---|
| **1 · brand** | `consort`→`ap`/`agglomeration-platform`; `CONSORT_HOME`→`AP_HOME`; `.consort/`→`.ap/`; `@cs_`→`@ap_`; `cs_`→`ap_`; `src/consort.ts`→`src/ap.ts`, `dist/consort.cjs`→`dist/ap.cjs` (+ build script + `plugin.json` hook path); `.claude-plugin/*` names + repo URLs; `package.json`; `README`/`CLAUDE.md`/`MIGRATION` | low, high-visibility |
| **2 · roles** | `instrument`→`agent` (incl. the JSON key + `instruments.yaml`→`agents.yaml`); `maestro`→`hub` (+ `From: hub`); `section`→`cluster`; `part`→`worker`; `FINE`→`DONE` | higher (state I/O, 835× term) |
| **3 · verbs + gate** | rename the 10 command files (`commands/*.md` + `src/commands/*.ts`) + dispatch + internal `<verb>*` symbols + command-doc prose; finalize the stale-token gate with the new bans | medium |

Per the repo's standing practice, each PR includes its `dist/ap.cjs` rebuild and a version bump across
the three manifests, and is merged after its own review.

## Acceptance criteria

- `WingsOfPanda/agglomeration-platform` is the live repo; `git remote -v` shows the new URL (**done**).
- After all 3 PRs: `grep -rIn` over `src config commands hooks .claude-plugin` returns **zero** hits for
  `consort`, `cs_`, `@cs_`, `maestro`, `instrument` (case-insensitive where specified).
- `/ap:check`, `/ap:list`, and a real spawn+teardown dogfood pass in tmux — proving the renamed
  `agent` JSON key and `From: hub` value round-trip through `pane.json`/`ready`/inbox unchanged in
  behavior.
- `npm run typecheck && npm run test && npm run lint && npm run build` green on each PR; the
  stale-token gate passes in its final form on PR 3.
- The frozen wall is untouched: a `git grep` confirms `ready`/`ack`/`progress`/`done`/`error`/`question`,
  `END_OF_INSTRUCTION`, the frozen JSON fields, and the `contracts.yaml` keys (incl. `consult_validated`)
  are all still present and unchanged.

## Risks & mitigations

- **Breaking the wire protocol.** *Mitigation:* the frozen wall is explicit; a live dogfood after PR 2
  and PR 3 exercises the real `codex`/`claude` round-trip, not just unit tests.
- **`instrument`→`agent` JSON-key drift** (writer/reader/bootstrap out of sync). *Mitigation:* isolated
  in PR 2 with a dedicated dogfood; old `.consort/` state is abandoned via the `.ap/` dir move.
- **Stale-token gate false positives** on generic English. *Mitigation:* ban only the documented
  unambiguous set; never `part`/`section`/`score`/`perform`/`solo`/`fine`.
- **Half-renamed intermediate states.** *Mitigation:* PR ordering keeps every checkpoint green; the
  gate only flips to its final bans in PR 3.
- **`/ap:` namespace collision or `ap` ambiguity.** *Accepted:* chosen deliberately for brevity; the
  repo/marketplace keep the full `agglomeration-platform` for discoverability.

## Out of scope (explicit)

- Publish-readiness: removing `package.json` `"private": true`, npm publish, marketplace listing
  mechanics, README "install/usage" polish beyond the rename, pruning `target-user-analysis.*` and
  dogfood artifacts. **Next spec.**
- Reviving any retired capability (multi-repo stays retired).
- Rewriting historical `docs/` specs/plans.
