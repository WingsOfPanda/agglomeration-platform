# Consort — Foundation Sub-Project Design

> **Status:** approved design (brainstorming output), 2026-05-29.
> **Next step:** writing-plans → detailed implementation plan.
> **Architecture spec:** `MIGRATION.md` (repo root) is the full architecture + phasing
> reference. This document is the *scoped, decision-locked* design for the **foundation
> sub-project** and the **musical-ensemble rebrand**. Where this doc and `MIGRATION.md`
> differ, **this doc wins** (it post-dates the naming decisions).
> **Behavioral spec:** `/home/liupan/CC/clone-wars` (grep by symbol; line numbers drift).

---

## 1. Scope

Port the Bash plugin `clone-wars` to TypeScript as `consort`, **rebranded to a
musical-ensemble theme**. This design covers the **foundation sub-project only**:

- **Phase 0** — scaffold
- **Phase 1** — core modules (`paths/atomic/ipc/tmux/colors/log/deps/contracts/instruments/archive/forensics`)
- **Phase 2** — the six primitives (`spawn/send/collect/roster/coda/soundcheck`) + `preflight` + a `hook` stub
- **Dogfood** — a live `spawn → send → collect → roster → coda` against a real `codex` pane

**Out of scope (each its own later spec → plan → build cycle):** the six high-level
commands `solo` (was `strike`), `prelude` (`meditate`), `perform` (`deploy`),
`score` (`consult`), `rehearsal` (`deep-research`), `playback` (`review-forensics`).
Their command-specific logic (~4.8k Bash LOC) is designed when each is built; this
foundation is the substrate they all reuse.

**Why foundation-first:** ~3k LOC of tightly-coupled IPC/tmux/primitive substrate is
one coherent unit. Locking its naming, module boundaries, IPC contract, build tooling,
and testing posture once — and proving the end-to-end pipeline with a live dogfood —
means every later command inherits a settled, tested base.

---

## 2. Locked naming scheme (musical-ensemble rebrand)

The wire protocol stays frozen except the one Tier-2 rename below. Only human-facing
words and the themed command names change.

### 2.1 Commands

| clone-wars | consort | note |
|---|---|---|
| `consult` | `score` | compose the design doc (out of scope here) |
| `deploy` | `perform` | play the score (out of scope) |
| `meditate` | `prelude` | exploratory opening (out of scope) |
| `deep-research` | `rehearsal` | iterative practice (out of scope) |
| `strike` | `solo` | one part, unattended (out of scope) |
| `review-forensics` | `playback` | review the recordings (out of scope) |
| `list` | **`roster`** | who's on stage — **in scope** |
| `teardown` | **`coda`** | dismiss + archive — **in scope** |
| `medic` | **`soundcheck`** | readiness + roster pick — **in scope** |
| `spawn` / `send` / `collect` | **unchanged** | CLI-internal plumbing; literal aids debugging — **in scope** |
| `deep-research-resume` | `rehearsal-resume` | internal resume handler (out of scope) |

CLI subcommand name == slash-command name for the themed ones. `spawn`/`send`/`collect`
are CLI-only (no `.md`). The three user-facing primitives get `commands/{roster,coda,soundcheck}.md`.

### 2.2 Roles, cast, identifiers

| clone-wars | consort |
|---|---|
| conductor / "Master Yoda" | **Maestro** (`From: maestro` in inboxes; default sender) |
| trooper / commander (worker) | **part** (a part = the line of music for one instrument) |
| cast pool `commanders.yaml` | **`instruments.yaml`** |
| commander names (rex, cody…) | **instrument names** (violin, cello, oboe…) — pool in §4.3 |
| `commander` field (JSON key, dir segment) | **`instrument`** (Tier-2 rename — see §6.2) |
| rank prefix in label (captain/commander/…) | **orchestral section** prefix (strings/woodwinds/brass/…) |
| Star Wars legions (color grouping) | **orchestral sections** (color grouping) |
| `@cw_label` / `@cw_color` / `@cw_label_fmt` | **`@cs_label` / `@cs_color` / `@cs_label_fmt`** |
| teardown banner "MISSION ACCOMPLISHED" | **"FINE"** (Italian musical term: the end) |
| `.clone-wars/` / `CLONE_WARS_HOME` | `.consort/` / `CONSORT_HOME` |
| `cw_*` function prefix | dropped (TS modules namespace naturally) |
| `/clone-wars:*` | `/consort:*` |

Frozen (Tier 3 — neutral protocol, NOT renamed): event names `ready`/`ack`/`progress`/
`done`/`error`/`question`; sentinel `END_OF_INSTRUCTION`; fields `ts`/`summary`/
`artifacts`/`note`/`message`/`fatal`/`task_summary`/`model`/`topic`.

---

## 3. Module architecture

```
consort/
├── .claude-plugin/plugin.json        # name=consort; UserPromptSubmit hook → consort.js hook
├── commands/
│   ├── roster.md                     # → node …/consort.js roster --args-file <p>
│   ├── coda.md                       # → node …/consort.js coda   --args-file <p>
│   └── soundcheck.md                 # → node …/consort.js soundcheck --args-file <p>
├── config/
│   ├── contracts.yaml                # copied verbatim (codex/agy/claude/opencode)
│   ├── instruments.yaml              # renamed from commanders.yaml; instrument pool (§4.3)
│   └── prompt-templates/identity.md  # rewritten: Maestro, "the <instrument> part", From: maestro
├── hooks/                            # minimal user-prompt-submit (full active-session logic lands with rehearsal)
├── src/
│   ├── consort.ts                    # CLI dispatcher (subcommand → handler)
│   ├── core/
│   │   ├── paths.ts      # stateRoot, globalRoot, repoHash(cwd), topicDir, partDir(instrument,model,topic), runDir(cmd), argsFile(cmd)
│   │   ├── atomic.ts     # atomicWrite(dest,content) (tmp+rename), appendJsonl(path,obj)
│   │   ├── log.ts        # info/warn/error/ok → stderr, TTY-guarded color
│   │   ├── deps.ts       # haveCmd, inTmux, tmuxVersionOk
│   │   ├── contracts.ts  # loadContracts, provider, modeArgs, readyTimeout, bootstrapSleep, validatedProviders
│   │   ├── instruments.ts# loadPool, pickRandom(topic), inUse(instrument,topic), collisionError  (was commanders.sh)
│   │   ├── colors.ts     # Morandi palette (verbatim values), colorFor, sectionFor, labelFor, labelFmt
│   │   ├── ipc.ts        # writeInbox, writeIdentity, readOutbox, waitForEvent, waitSince, outboxOffset, write/readPaneMeta, setStatus
│   │   ├── tmux.ts        # splitRight/Down, respawn, paneLabelSet, paneAlive, paneSend, capturePane, killGraceful/Now, preflightLayout (via execa)
│   │   ├── archive.ts    # archivePart, archiveTopic, finalizeArchivedStatus
│   │   └── forensics.ts  # MINIMAL: captureFailure() for spawn's bootstrap-fail path (clustering lands with playback)
│   └── commands/
│       ├── spawn.ts  send.ts  collect.ts        # literal CLI-only primitives
│       ├── roster.ts  coda.ts  soundcheck.ts    # themed; have .md slash commands
│       ├── preflight.ts                         # pane-grid pre-allocation (§5.5)
│       └── hook.ts                              # UserPromptSubmit handler (stub for now)
├── dist/consort.js                   # COMMITTED single-file esbuild bundle (zero-build install)
├── tests/                            # vitest
├── package.json  tsconfig.json  LICENSE  README.md
```

Carry-overs from `MIGRATION.md`: the `--args-file` injection fence (`.consort/_args/`),
the `_run/<cmd>.XXXXXX/` + `.last` run-dir mechanism, `.gitignore='*'` auto-written
into every state root, `<repo-hash> = sha256(realpath(cwd))`, all paths absolute,
atomic writes (tmp + rename) for `status.json`/`pane.json`/`inbox.md`.

CLI dispatcher (`src/consort.ts`) routes `spawn, send, collect, roster, coda,
soundcheck, preflight, hook` to `commands/<verb>.run(args)`; later commands
(`score`/`prelude`/`rehearsal`/`perform`/`solo`/`playback`) slot in unchanged.

---

## 4. State layout & config

### 4.1 Roots (rename only)

| Root | clone-wars | consort | Holds |
|---|---|---|---|
| Per-project state | `$PWD/.clone-wars/` (or `$CLONE_WARS_HOME`) | `$PWD/.consort/` (or `$CONSORT_HOME`) | per-topic part state, `_run/`, `_args/` |
| Per-machine config | `${CLONE_WARS_HOME:-$HOME/.clone-wars}` | `${CONSORT_HOME:-$HOME/.consort}` | `contracts.yaml`, `instruments.yaml`, `archive/` |

```
<root>/
├── contracts.yaml
├── instruments.yaml
├── state/<repo-hash>/<topic>/<instrument>-<model>/{identity.md,inbox.md,outbox.jsonl,status.json,pane.json}
├── _run/<command>.XXXXXX/   # per-invocation scratch; `.last` pointer
├── _args/                   # per-invocation $ARGUMENTS sink (injection fence)
└── archive/<repo-hash>/<topic>/<instrument>-<model>-<ts>/
```

### 4.2 `contracts.yaml`

Copied verbatim from clone-wars (`codex`/`agy`/`claude`/`opencode` rows; fields
`binary`, `modes`, `default_mode`, `ready_timeout_s`, `bootstrap_sleep_s`,
`consult_validated`, `timeout_multiplier`). Parsed with `yaml` into:

```ts
interface ProviderContract {
  binary: string;
  modes: Record<string, string[]>;
  default_mode: string;
  ready_timeout_s: number;
  bootstrap_sleep_s: number;
  consult_validated: boolean;
  timeout_multiplier?: number;
}
```

### 4.3 `instruments.yaml` — the cast pool

~32 single-token instrument names, grouped by section (the grouping also drives the
color families in §5.4):

```
strings:     violin viola cello contrabass harp
woodwinds:   flute piccolo oboe clarinet bassoon recorder
brass:       horn trumpet trombone tuba cornet
percussion:  timpani celesta vibraphone marimba xylophone glockenspiel
keys:        piano organ harpsichord
early:       lute theorbo viol sackbut shawm crumhorn cittern
```

`instruments.yaml` is a **flat list** of instrument names, mirroring clone-wars'
`commanders.yaml`, so `pickRandom`/`inUse` port identically. Section membership lives
in `colors.ts` (§5.4), **not** in the YAML — the section grouping shown above is
documentation only. (The first line above is illustrative grouping, not file syntax.)

---

## 5. tmux spawn fidelity (highest-care surface)

Everything here is a **behavior-preserving** port of `tmux.sh` / `spawn.sh` /
`preflight-layout.sh` / `colors.sh` / `_close-banner.sh`. Mechanics copied exactly;
only cosmetic content (color keying, section prefix, banner words) is re-authored.

### 5.1 Split topology

- First part in a topic → `tmux split-window -P -F '#{pane_id}' -h [-t <conductor>] -c <abs-cwd> <launch>` (right).
- Subsequent parts → `… -v -t <prior-pane> -c <abs-cwd> <launch>` (down), where
  `<prior-pane>` is read from `<topic-dir>/.last_pane`; write the new pane id back.
- `--target-pane <id>` path → `tmux respawn-pane -k [-c <cwd>] -t <id> <launch>`
  (used by preflight; **no** `.last_pane` write — `preflight-panes.txt` is the source of truth).
- Start dir = `--cwd <abs>` (validated: absolute + exists) or the repo root (`git toplevel` else `$PWD`).

### 5.2 Launch wrap

`bash -ic 'exec <launch>'` when `~/.bashrc` exists (sources user env / MCP keys into
the pane; `exec` keeps the provider as the pane's main process for clean respawn);
otherwise launch unchanged.

### 5.3 Bootstrap timing + nudge (preserve exactly)

1. After spawn: `sleep <bootstrap_sleep_s>` (codex/agy=20, claude=12, opencode=15 —
   the floor; **never lowered**, absorbs cold start).
2. Nudge: `paneSend(pane, "Read <identity-abs> and follow its instructions exactly.")`
   where `paneSend` = `send-keys -t <pane> -l <line>` → **`sleep 0.3`** → `send-keys -t <pane> Enter`.
   The 0.3s beat between literal text and Enter is load-bearing.
3. Wait for `{ready,error}` up to `ready_timeout_s` (poll outbox via wait-since, §6.3).

### 5.4 Color theme — keep exact Morandi values, re-key to instruments

`colors.sh` style (preserved): two OSC-immune per-pane user-options
(`@cs_label`/`@cs_color`/`@cs_label_fmt`), a curated **Morandi 256-color** palette
giving each part a **primary + secondary** pair, **grouped so each section reads as one
color family**, and a striped `pane-border-format` fragment.

Re-authored content:
- **Palette values stay verbatim** (the exact `colour110`/`colour187`/… codes from
  `cw_palette_for`). Re-assign those pairs to instruments, grouped by **orchestral
  section** the way clone-wars grouped by legion (e.g. strings → the dusty-blue family,
  brass → terracotta/warm, woodwinds → sage/olive earth tones, percussion → neutral
  greys, keys → cream, early → mauve/plum). Same "harmonious painting" intent.
- **`sectionFor(instrument)`** replaces `cw_rank_for` → returns the section name.
- **`labelFor(instrument,model,topic)`** = `<section>-<instrument>:<model>:<topic>`
  (e.g. `strings-violin:codex:auth-review`).
- **`labelFmt(instrument,model,topic)`** = the tmux border fragment, structure verbatim:
  `#[fg=<primary>,bold]<section>-<instrument>#[default]:#[fg=<secondary>,bold]<model>#[default]:<topic>`.
- `colorFor(instrument)` = primary only (used by the graceful-banner ANSI + simple label).
- `*` fallback → `white default` (unknown instrument), as today.

`paneLabelSet(pane, instrument, model, topic)` stamps the three `@cs_*` options
(idempotent), exactly like `cw_pane_label_set`.

### 5.5 Preflight layout (`preflight.ts` + `tmux.preflightLayout`)

Port of `preflight-layout.sh` — generic tmux-spawn infrastructure, pulled into the
foundation so later commands consume it:
- Inputs: topic, ordered roster (N=2–4), optional per-part cwd map, art-dir.
- Discover conductor pane: `$TMUX_PANE` preferred, `tmux display-message -p '#{pane_id}'` fallback.
- First pane `-h` (right of conductor), rest `-v` (down of prior); then
  `tmux select-layout -t <conductor> main-vertical` to even heights.
- Each pane runs a **colored sentinel**: `printf "<label_fmt>\n  reserved — awaiting
  spawn...\n"; sleep infinity` (holds the pane open until `respawn-pane -k` replaces it).
- Stamp `@cs_*` on each pane via `paneLabelSet`.
- Write ordered `preflight-panes.txt` (TSV `<instrument>\t<pane_id>`) **atomically**
  (tmp + rename) with **trap-driven rollback**: any mid-preflight failure kills all
  already-created panes and removes the tmp file. (In TS: try/catch that kills
  `createdPanes[]` and rethrows.)

### 5.6 Failure forensics (spawn bootstrap-fail path)

On `{ready}` timeout or `{error}` during bootstrap: dump the last 25 pane lines to
stderr, write `failure-reason.txt` **before** killing (so forensics survive),
hard-kill the pane (`kill-pane`), archive state with a `FAILED` suffix, exit non-zero.
`forensics.ts` ships only this `captureFailure()`; the clustering/aggregation logic is
`playback`'s concern (later spec).

### 5.7 Graceful teardown banner (`coda`)

`killGraceful(pane)` port of `cw_pane_kill_graceful` + `_close-banner.sh`:
- `tmux capture-pane -p -e -t <pane> > <snap>` (snapshot with escapes).
- `tmux respawn-pane -k -t <pane> "cat <snap>; <banner> <label> <color>; rm -f <snap>"`.
- Banner mechanics preserved: colored `━` rule, bold label, an 8-second countdown
  (`Closing in N second(s)...`), then `Closed.`; pane closes naturally
  (`remain-on-exit=off`). The part's Morandi primary drives the ANSI (`\e[38;5;<n>m`
  from `colourNNN` or bare number).
- **Re-themed words:** "MISSION ACCOMPLISHED — pane closing" → **"FINE — pane closing"**.
- Batch teardown shares a single banner sleep (port the `--pairs` one-sleep behavior so
  N panes don't each wait the full countdown).

---

## 6. IPC wire protocol

Behavior-identical to clone-wars; the only schema change is the Tier-2 `instrument` rename.

### 6.1 Frozen surfaces (Tier 3)

- **`inbox.md`** (atomic overwrite, single message):
  ```
  From: <sender>            # default `maestro`; --from <name> attributes; [a-zA-Z0-9_-]+

  <task text>

  When done, append a single JSONL line to <outbox-abs-path>:

  `{"event":"done","summary":"<one-line summary>","ts":"<iso-timestamp>"}`

  END_OF_INSTRUCTION
  ```
  Last line MUST be `END_OF_INSTRUCTION`. Atomic (tmp + rename).
- **`outbox.jsonl`** (append-only, one JSON/line): events `ready`/`ack`/`progress`/
  `done`/`error` (+ `question` later). `fatal:true` ⇒ recommend teardown;
  `fatal:false` ⇒ retry with new inbox.
- **`status.json`** (atomic overwrite): `{state, updated, current_task_summary,
  last_event}`; states `bootstrapping → idle → queued → working → idle|done|error`;
  conductor stamps `archived` + `archived_ts` on teardown.

### 6.2 Tier-2 schema change: `commander` → `instrument`

- `pane.json` = `{ "pane_id":"%62", "instrument":"violin", "model":"codex", "spawned_at":"<iso>" }`
- `ready` = `{"event":"ready","ts":"<iso>","instrument":"violin","model":"codex"}`
- `ack`   = `{"event":"ack","ts":"<iso>","task_summary":"..."}` (unchanged; no instrument needed)
- `identity.md` substitutes `{{instrument}}` and instructs the part to emit `"instrument"`.
- `pane.json` always carries canonical `instrument`/`model` so consumers never parse the
  hyphen-ambiguous dir name.

### 6.3 Two TS-port wins

- **Strict event match:** `JSON.parse(line)` then `obj.event === name` — replaces the
  anchored `^\{"event":"X"[,}]` regex; provably free of the substring false-positive.
  Skip non-JSON lines with try/catch.
- **Wait-since by byte offset:** record `statSync(outbox).size` before nudging; on each
  poll read only `[offset, size)` and `JSON.parse` the new lines (tail-reversed for
  `tail -n1` semantics). Guarantees you match only events from *this* dispatch.

### 6.4 Identity template rewrite (prose only)

`{{commander}}`→`{{instrument}}`; "a {{model}}-class clone trooper assigned to operation
{{topic}}" → "the **{{instrument}}** part (a {{model}}-class voice) in the consort,
playing **{{topic}}**"; "Master Yoda (your commanding officer)" → "the **Maestro**
(conducting from Claude Code)"; `From: master-yoda` → `From: maestro`; "Roger that,
Commander." → "Tuned and ready, Maestro." **Load-bearing instructions stay verbatim:**
the `END_OF_INSTRUCTION` wait, the `{ready}`-first-action with a fresh `date -u` ts,
foreground-tool-use-only, and the safe-JSONL-emission patterns (A/B/C).

---

## 7. Execution strategy (Approach 3 — hybrid)

| Phase | Work | How |
|---|---|---|
| 0 — Scaffold | package.json, tsconfig (ES2022/NodeNext/strict), esbuild + vitest + eslint, plugin.json, copy+rename config/ (instruments.yaml, rewritten identity.md), hello-world dist | I do directly (must be coherent) |
| 1a — Contract-critical core | paths, atomic, ipc, tmux, colors | Sequential TDD, tests-first, owned by me |
| 1b — Independent leaf modules | log, deps, contracts, instruments | Workflow fan-out (self-contained), then integrate + tsc |
| 2a — Load-bearing primitives | spawn (full §5 lifecycle + --target-pane), preflight, coda | Sequential, careful |
| 2b — Lighter primitives | send, collect, roster, soundcheck, hook stub + 3 commands/*.md | quick, can parallelize |
| V — Adversarial verify | multi-agent: TS tmux arg-arrays + IPC behavior checked byte-for-byte vs. Bash source | Workflow before dogfood |
| D — Live dogfood | real spawn → send → collect → roster → coda against a codex pane | Sequential, here |

Match the tool to the coupling: single-owner sequential TDD where correctness is
non-negotiable (the wire protocol and tmux/spawn lifecycle), parallel fan-out only on
genuinely independent leaf modules, and a multi-agent adversarial pass as the safety net
before the live run.

---

## 8. Testing strategy

- **vitest** unit tests; **TDD on the contract surface** (`ipc`, `atomic`, `paths`):
  pin the `END_OF_INSTRUCTION`/`From:` inbox format, the outbox event schema,
  atomic-write durability (tmp+rename, no torn writes), and wait-since offset logic.
- **tmux code tested as pure arg-array builders** (functions that return the
  `['split-window','-P','-F','#{pane_id}','-h',…]` arrays) — no real panes in unit tests.
- **Live-tmux integration** gated behind `CONSORT_LIVE_TMUX=1`.
- `tsc --noEmit` + eslint **replace clone-wars' static-wiring locks** (the locks existed
  only because Bash has no compiler). A few high-level smoke tests for command stage-sequencing.
- **Stale-token grep gate** (test or lint): fail on `clone-wars` / `cw_` / `commander` /
  `trooper` / `master-yoda` appearing in shipped paths or runtime output.

---

## 9. Build & packaging

- `esbuild src/consort.ts --bundle --platform=node --target=node18 --outfile=dist/consort.js`.
- **Commit `dist/`** → zero-build install. Build + smoke (`node dist/consort.js`) is part
  of every change; vitest runs against `src`.
- `plugin.json`: `name=consort`, `UserPromptSubmit` hook → `node ${CLAUDE_PLUGIN_ROOT}/dist/consort.js hook user-prompt-submit`.
- `commands/*.md` dispatch via the 3-step args-file fence:
  1. CLI mints a unique path under `.consort/_args/` and prints it.
  2. The directive **Writes** `$ARGUMENTS` into that path (Write tool — never echo/printf into a shell).
  3. The directive invokes `node ${CLAUDE_PLUGIN_ROOT}/dist/consort.js <sub> --args-file <path>`; the CLI reads + deletes it.

---

## 10. Risk mitigation

| Risk | Mitigation |
|---|---|
| tmux spawn fidelity regression (split/color/preflight/timing) | behavior-preserving port (§5); pure-fn arg tests; `CONSORT_LIVE_TMUX=1` integration test; adversarial verify vs. Bash; live dogfood gate |
| IPC contract drift breaks provider drop-in | TDD ipc against pinned fixtures; strict `obj.event===name` parse; bootstrap-floor sleeps preserved exactly; dogfood |
| committed `dist/` drifts from `src/` | build + smoke (`node dist/consort.js`) on every change; vitest runs against `src` |
| partial rename leaves stale tokens | wholesale rename map + grep gate (§8); `tsc` catches broken refs |
| fan-out agents diverge on conventions | signatures fixed by the module map; scaffold tsconfig/eslint enforce style; single-owner integration |
| scope creep into high-level commands | foundation-only guard; `solo`/`score`/etc. explicitly out of this spec |

---

## 11. Acceptance — definition of "done"

1. `npm run typecheck` clean; `npm run test` (vitest) green; `npm run build` emits
   `dist/consort.js`; smoke-dispatch (`node dist/consort.js <sub>`) works.
2. Stale-token grep gate clean.
3. **Live dogfood passes here:** inside tmux,
   `spawn violin codex <topic> "<task>"` → pane appears with the colored
   `strings-violin:codex:<topic>` border and emits `{ready}` → `send` a task →
   `collect` returns `{done}` → `roster` lists the part → `coda` tears down with the
   **FINE** banner → state archived under `archive/`.

---

## 12. References

- **Architecture + full phasing:** `MIGRATION.md` (repo root).
- **Behavioral spec (grep by symbol):** `/home/liupan/CC/clone-wars`
  — `bin/spawn.sh`, `bin/preflight-layout.sh`, `bin/_close-banner.sh`,
  `lib/tmux.sh`, `lib/colors.sh`, `lib/ipc.sh`, `lib/state.sh`, `lib/contracts.sh`,
  `lib/commanders.sh`, `lib/deps.sh`, `lib/log.sh`, `lib/opencode_preflight.sh`.
- **Architecture bible:** `/home/liupan/CC/clone-wars/docs/DESIGN.md`.
