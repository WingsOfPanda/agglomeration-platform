# agglomeration-platform

**Multi-model tmux orchestration for Claude Code.** A **hub** — a Claude Code session running
`/ap:*` slash commands — spawns and steers real interactive model TUIs (`codex` / `claude` /
`agy` / `opencode`) as **tmux panes you can attach to and watch**. Coordination is file-based IPC
(inbox / outbox / status / pane), so the external model binaries behave exactly as they do on their
own — agglomeration-platform just orchestrates them.

The platform agglomerates agents: the orchestrating session is the **hub**, each model TUI is an
**agent**, a spawned agent working a task is a **worker**, and agents are grouped into color-coded
**clusters** (azure / sage / amber / slate / ivory / violet) so concurrent panes stay visually
distinguishable. The commands are plain verbs — `design`, `explore`, `autoresearch`, `implement`,
`quick`, `review`.

> agglomeration-platform is a TypeScript rewrite of an earlier Bash plugin. The packaging changed (one
> committed `dist/ap.cjs`, zero-build install); the wire protocol, state layout, and tmux
> mechanics are byte-compatible so the model binaries are drop-in.

---

## Install

agglomeration-platform ships as a Claude Code plugin via its own marketplace:

```
/plugin marketplace add WingsOfPanda/agglomeration-platform
/plugin install ap@agglomeration-platform
```

To update later: `/plugin marketplace update`, then re-install/upgrade.

### Requirements

- **Claude Code** (the hub runs as a Claude Code session).
- **tmux** — every worker is a real tmux pane; agglomeration-platform is the only subprocess surface.
- **At least one model CLI on `PATH`** — `codex`, `claude`, `agy`, or `opencode`. Run
  `/ap:check` to detect what's available and pick your active set.
- No build step: `dist/ap.cjs` is committed.

### Getting started

1. Install (above), then open a Claude Code session in the repo you want to work in.
2. Run **`/ap:check`** — it detects which model CLIs (`codex` / `claude` / `agy` / `opencode`) are on
   your `PATH` and lets you pick the active provider set.
3. For a fast, unattended change, run **`/ap:quick "<describe the change>"`** — one worker implements
   it on its own branch while you watch the pane; the hub briefs, verifies, and finishes.
4. For research-driven work, follow **`/ap:explore` → `/ap:design` → `/ap:implement`**.
5. **`/ap:list`** shows active workers; **`/ap:stop`** tears them down with a `DONE` banner.

---

## Commands

| Command | What it does |
|---|---|
| **`/ap:check`** | Health check (tmux / pane-border / state / config / providers) + an interactive roster picker that selects the active provider set for `/ap:design`. |
| **`/ap:list`** | Show active workers (panes + state), optionally scoped to a topic. |
| **`/ap:quick`** | Light pipeline — one worker implements a clear single-repo change unattended on its own branch; the hub briefs, verifies, and finishes. No research, no design doc, no gates. |
| **`/ap:explore`** | Deep multi-aspect exploration — SOTA surveys, multi-angle thinking, an adversary-tested landscape doc that feeds `/ap:design`. |
| **`/ap:design`** | Cross-verified multi-model research synthesized into a deploy-audit-passing design doc — a hub fast-path, or escalate to a 2–3 worker ensemble. |
| **`/ap:autoresearch`** | Advisor-driven autoresearch — lock a measurable metric, sweep SOTA, spawn 2–3 persistent `codex` workers, and adaptively dispatch experiments until a target / plateau / budget stop. **Explore-only** (see below). |
| **`/ap:implement`** | Implement a deploy-schema design doc — audit + route, spawn one worker to plan / implement / self-verify, the hub cross-verifies and runs a bounded fix-loop, then finish + teardown. This is the promotion-to-real-code path. |
| **`/ap:review`** | Review accumulated forensics from `quick`/`design`/`implement`/`explore`/`autoresearch` — surface problems recorded since you last looked, cluster recurring patterns with their lifetime trend, suggest next actions, then archive what was reviewed. |
| **`/ap:stop`** | Gracefully end workers (a `DONE` banner) and archive their state. |
| **`/ap:bridge`** | Cross-repo work — open one persistent worker inside a *different* git repo (repo B) and co-develop with it over open-ended rounds, finishing as a PR there, while the hub stays in repo A. |

A typical research-to-code flow: **`explore` → `design` → `implement`** (explore → design → build),
with **`autoresearch`** as the heavyweight research loop and **`quick`** for fast unattended changes.
`check` / `list` / `review` / `stop` are the operational glue, and `bridge` reaches into a second repo.

---

## `/ap:autoresearch` — the autoresearch loop

`autoresearch` is the most substantial command: an AIDE-style loop where the hub locks a measurable
metric, sweeps the state of the art, spawns 2–3 persistent `codex` workers as tmux panes, and
adaptively dispatches single-config experiment ideas until a stop condition (target met, plateau, or
time budget). It is **explore-only** — it never touches your real repo; promotion to real code is
`/ap:implement`.

It ships a **research-validity layer** that treats a worker's self-reported metric as *a claim, not
evidence*, and hardens the loop against both buggy and deliberately-gaming workers:

- **Metric trust (verify):** the trusted hub re-runs each result's scoring step *outside* the
  worker's pane and adjudicates a verdict.
- **Sanity & integrity gates:** mechanical task-agnostic checks (ceiling / under-run /
  log-contradiction / config-knob drift) + a recorded integrity attestation.
- **INFEASIBLE vs REFUTED:** a botched run (couldn't be validly executed) is classified INFEASIBLE
  and kept out of the leader set — it never masquerades as a refuted idea or a false leader.
- **Coverage & diversity guard:** an approach-aware plateau + a per-family coverage tally, so the loop
  can't quietly converge on one approach family.
- **Operators & attribution:** typed Draft / Improve moves with a single-change-vs-parent lineage
  advisory, so a metric delta is attributable.
- **Independent re-implementation inspector:** for a new-best leader, the cross-family hub
  regenerates the experiment from the worker's run-card *alone* and re-derives the metric — catching a
  worker whose own scoring code is the gamed artifact. A confident non-reproduction demotes the leader.

These are gated, additive, and surfaced in the live status brief; design docs live under
`docs/superpowers/specs/`.

---

## How it works

- **One bundle, dispatched by subcommand.** `dist/ap.cjs` (built from `src/ap.ts`) routes
  `ap <verb>` to `src/commands/<verb>`. Core logic lives in `src/core/*`, one file per
  responsibility. `dist/` is committed for zero-build install.
- **tmux is the only subprocess surface** (via `execa`). Workers are real panes you can attach to.
- **File-based IPC.** Coordination happens through `inbox` / `outbox` / `status` / `pane` files under
  a per-machine state root (`AP_HOME`, default `~/.ap/`), keyed by a hash of the working
  directory. Writes are atomic (tmp-in-same-dir + rename).
- **A closed provider set.** `codex` / `claude` / `agy` / `opencode`, each defined by a row in
  `config/contracts.yaml`. Adding a provider is a config row + a dogfood, not an open compat surface.
- **A frozen wire protocol.** Event names (`ready`/`ack`/`progress`/`done`/`error`/`question`), the
  `END_OF_INSTRUCTION` sentinel, and the result/state schemas are stable so the external binaries stay
  drop-in.

---

## Development

```
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run lint        # eslint
npm run build       # esbuild -> dist/ap.cjs  (commit the result)
```

After changing `src/`, run `npm run build` and commit the refreshed `dist/ap.cjs`. Tests isolate
state by pointing `AP_HOME` at a fresh temp dir; tmux arg-builders are unit-tested as pure
functions (no real panes spawned). For a live dogfood, run inside tmux with `CLAUDE_PLUGIN_ROOT=$PWD`.

Canonical guidance for contributors is in `CLAUDE.md`; the architecture/phasing reference is
`MIGRATION.md`.

---

## License

MIT.
