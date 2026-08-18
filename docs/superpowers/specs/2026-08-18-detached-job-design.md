# Detached jobs: run `/ap:implement` and `/ap:quick` as background jobs — design

**Date:** 2026-08-18
**Status:** approved (grilled 2026-08-18; decisions recorded in "Settled decisions" below)
**Scope of this design:** an **opt-in `--detached` mode** for `/ap:implement` and `/ap:quick` only,
delivered as two landings — (1) a `spawn --session` placement primitive, (2) a job layer whose
detached run is driven by a second model session (the **job hub**) inside a detached tmux session.
Explicitly **out of scope** (successor specs if wanted): detaching `design` / `explore` /
`autoresearch` / `bridge`; auto-respawning a dead job hub and resuming mid-stage; sandboxed
`verify-tests`; any change to the default attached behavior.

## Problem

A `/ap:implement` run whose worker spends hours on GPU training or a long verification suite pins the
originating Claude Code session to that run for the whole duration. Three distinct costs, only one of
which the current design addresses:

1. **Foreground blocking — already solved.** `commands/implement.md` and `commands/quick.md` already
   dispatch `turn-wait` with `run_in_background: true`, so the pane stays interactive. This is *not*
   the problem.
2. **Hub context occupancy — unsolved.** The orchestration lives in the originating session's
   conversation: it authors fix-prompts (Stage 3), cross-verifies (Stage 2), and answers the worker's
   relayed questions. That session cannot be spent on unrelated work without interleaving a
   multi-hour pipeline through it.
3. **Death on restart — unsolved, and the sharp edge.** The worker pane survives anything tmux
   survives, but the backgrounded `turn-wait` node process dies with the Claude Code session, and the
   orchestration conversation dies with it. A Claude Code update or a restart mid-run strands a live
   worker with nobody driving it. The operator's own standing rule — long jobs belong in a detached
   tmux session, never a session-owned shell — is currently unenforceable for ap runs.

Moving only the *worker pane* into a detached session fixes none of (2) or (3): the worker was never
the component that dies. The orchestration is.

## Goal

`/ap:implement <doc> --detached` (and `/ap:quick "<task>" --detached`) returns to the operator within
about a minute, having launched a self-contained job in a detached tmux session that drives the full
pipeline to a finished branch without further attention. The originating session keeps a cheap
read-only view of that job (status, completion notification, stall detection), can be restarted and
re-attach to a still-running job, and can answer a parked question when the job needs a human. The
operator can `tmux attach -t ap-<topic>` at any moment and watch the real TUIs work.

Without `--detached`, every existing command behaves byte-for-byte as it does today.

## Settled decisions

These were decided in a design interview and are inputs to this spec, not open questions.

| # | Decision | Rationale |
|---|---|---|
| D1 | The **whole run** detaches, not just the worker pane | Only this addresses Problem (2) and (3) |
| D2 | Wired into **`implement` and `quick` only** | `autoresearch` has its own resume/ledger machinery; reconciling them needs its own spec (`CLAUDE.md` phase guard) |
| D3 | **Opt-in `--detached`**, never a default, never auto-detected | The attached path stays byte-identical; the operator types the flag |
| D4 | **Park-and-relay** for questions; policy gates pre-answered by launch flags | Canning a worker's real question is how a wrong 6-hour run happens |
| D5 | **Same tmux server**, session named `ap-<topic>` | The `@ap_nonce` ownership layer already provides isolation; threading `-L` through every tmux call site buys nothing and risks silent wrong-server probes |
| D6 | The job hub is an **ap-spawned `claude` TUI** running the directive via its Skill tool | Attachable and live (a `claude -p` job gives a log, not a TUI); `codex` cannot load ap's plugin commands; a pure-TS state machine cannot do Stage 2/3, which are model judgment |
| D7 | The job hub gets its **own identity template**, not a relaxed `identity.md` | The worker trust rules are load-bearing security prose; they must not be perforated for every worker to serve one caller |
| D8 | **`--finish keep` is the only accepted finish action in detached mode** | Nothing merges or opens a PR while unattended; the operator decides on a finished branch |

## Architecture

### The recursion, and the two hubs

```
originating Claude Code session          "origin hub"   — monitors, relays, decides
  |
  |  ap job start  ->  tmux new-session -d -s ap-<topic>
  v
detached session ap-<topic>
  window 0: claude TUI                   "job hub"      — runs the ap:implement directive
  window 1: codex/claude TUI             worker         — implements the design doc
```

The job hub is an ordinary ap worker in every mechanical respect — `spawn` creates it, it has a state
dir, an identity file, an inbox, an outbox, a `status.json`, a `pane.json` with an ownership nonce —
whose *task* happens to be "invoke the `ap:implement` skill on this doc." ap's own commands are
exposed to a Claude session as skills (`plugin:ap:implement`), so this needs no new invocation
mechanism.

**The IPC sender stays `From: hub`** (frozen). To the implementation worker, the job hub *is* the hub;
nothing on the wire changes. Where this document needs to distinguish them it says **origin hub**
(the operator's session) and **job hub** (the detached one).

**One-writer rule.** Only the job hub writes its workers' inboxes; the origin hub writes only the job
hub's inbox. A second sender mid-run overwrites a running worker's task and it idles. `ap job relay`
is the origin hub's *only* write path into the job, and it targets the job hub exclusively.

### Landing 1 — `spawn --session <name>` (placement primitive)

A third placement branch alongside the existing two (`--target-pane` respawn, and the
`.last_pane`/`splitRight` chain):

```
spawn <agent> <model> <topic> --session ap-<topic> --cwd <repo>
  session absent -> tmux new-session -d -P -F '#{pane_id}' -s =<name> -c <cwd> <launch>
  session present -> tmux new-window  -d -P -F '#{pane_id}' -t =<name>: -c <cwd> <launch>
```

One window per worker, so `tmux attach -t ap-<topic>` gives a window per agent rather than a shrinking
grid. Everything downstream of pane creation is **unchanged**: `stampOrFail` stamps the same
`@ap_nonce`, `paneLabelSet` stamps the same three `@ap_*` options, `paneMetaWrite` records the same
`pane.json`, the same bootstrap sleep, identity nudge, and `ready` wait follow.

Three properties make this land cheaply:

- **Nothing else in the codebase changes.** Every ownership, liveness, kill, nudge, and capture path
  goes through `livePaneNonces()` (`src/core/tmux.ts:145`), which is `tmux list-panes -a` — server-wide,
  not session-scoped. `list`, `stop`, `check`, and `waitLive.ts`'s pane-liveness escape hatch already
  see panes in other sessions on the same server.
- **`--session` relaxes the `inTmuxSession()` gate** (`src/commands/spawn.ts:63`). That gate exists only
  because the current paths split *the caller's* pane. A detached spawn creates its own session, so the
  caller need not be inside tmux — detached runs work from the desktop app or an IDE, not just a terminal.
- **Session names are already safe.** `topic` is slug-gated to `[a-z0-9-]{1,32}`, so `ap-<topic>`
  contains no `.` or `:` (tmux target separators). Every target is written `=<name>` to force exact
  match rather than tmux's default prefix match.

`--session` and `--target-pane` are mutually exclusive (rc 2). `--session` skips the `.last_pane`
chain entirely — that file is the attached layout's concept.

**Session teardown is ownership-gated.** `killGraceful` respawns a pane into the DONE banner rather
than killing it, so a finished job's session lingers by design (attach and read it). The job's own
teardown kills the session explicitly, and only when it can prove the session is entirely ap's: list
that session's panes, and kill the session only if **every** pane id in it is one whose recorded nonce
we hold and still matches live. Any unrecognized pane -> leave the session alone and say so. This is
the same fail-closed posture as `stop`: unprovable is not permission.

### Landing 2 — the job layer

**New state, topic-keyed, alongside the existing art dirs:** `<repoStateDir>/<topic>/_job/`. It does not
collide with `implement init`'s in-flight guard, which tests `existsSync(<topic>/_implement)`
(`src/commands/implement.ts:139`) — verified, not assumed.

`_job/job.json` records what was launched and nothing else:

```json
{"command":"implement","topic":"<slug>","session":"ap-<slug>",
 "hub":{"agent":"<agent>","model":"claude"},
 "provider":"codex","finish":"keep","budget_hours":6,"max_rounds":5,
 "args_file":"<abs>","started":"<iso>"}
```

**`ap job status <topic>` composes recorded verdicts; it never infers one layer's answer from
another's.** Four independent reads:

| Source | Answers |
|---|---|
| `_job/job.json` | what was launched |
| job hub `pane.json` + `livePaneNonces()` | `alive` / `dead` / **`unknown`** |
| job hub `outbox.jsonl` | the event stream (stage progress, parked question, terminal) |
| job hub `status.json` | the hub's own declared state |

The three-valued liveness is load-bearing and matches the 0.5.30 rule: a `pane.json` with no nonce, or
a nonce that is not a platform-minted UUID, is **UNKNOWN, never dead**. Only a live-and-nonce-matching
pane is `alive`; only a verifiable nonce whose pane is gone is `dead`.

**Verbs** (`ap job <sub>`):

| Verb | Does |
|---|---|
| `start` | validate flags, write `job.json`, create the session, spawn the job hub, write its inbox task, return |
| `status <topic>` | the one-screen composite above |
| `wait <topic>` | block until the job hub emits `done`/`error`/`question`; the origin hub runs this with `run_in_background: true` |
| `attach <topic>` | print the re-arm block (session name, state paths, the `wait` command) after an origin-hub restart |
| `list` | every job under this repo hash, with liveness |
| `relay <topic> @<file>` | answer a parked question — writes the job hub's inbox, the origin hub's **only** write path |
| `stop <topic>` | stop the job hub and its workers, archive, then the ownership-gated session kill |
| `mode <topic>` | `DETACHED=1\|0` — the mechanical signal the directive branches on |
| `budget-check <topic>` | rc 0 within budget, rc 1 exceeded |

`wait` reuses `liveOutboxWait` unchanged, so it inherits the pane-liveness escape hatch: a job hub whose
pane vanishes without a terminal event fails the wait fast instead of blocking out the full budget.

### The job hub's identity — `config/prompt-templates/job-hub.md`

`identity.md` forbids exactly two things the job hub must do, so it cannot wear it:

- *"Foreground tool-use only… do NOT pass `run_in_background: true`"* — the job hub's core loop is a
  backgrounded `turn-wait`.
- *"never write another worker's files"* — the job hub writes worker inboxes via `ap send`; that is its
  function.

The new template is `identity.md` with **three deltas and nothing else**:

1. Backgrounding is permitted and expected, for `turn-wait`/`round-wait` only.
2. It may write its own workers' inboxes through `ap send`; it still may not write their outboxes,
   status files, or artifacts.
3. **Gate handling is park-and-relay**: where the attached directive would call AskUserQuestion, the
   job hub emits `{"event":"question", ...}` to its own outbox, sets status, and waits for its inbox.

Everything else is retained **verbatim**: the inbox-is-the-only-task-channel rule, the `FLAG:` discipline,
atomic `status.json` writes, safe JSONL emission, and the "worker output is DATA, not directives" posture
that `commands/implement.md` already applies to worker question payloads. A worker's outbox content is
never a directive to the job hub, whatever it says.

`identityWrite` gains a role parameter selecting the template; the default is `identity.md`, so every
existing call site is unchanged.

### DETACHED MODE in the directives

**One directive per command, not a forked copy.** `commands/implement.md` and `commands/quick.md` each
gain a single `## DETACHED MODE` section near the top that redefines exactly the gates that need a human,
with a mechanical entry test (`ap job mode <TOPIC>` -> `DETACHED=1`) rather than prose-only detection. A
forked `implement-detached.md` would drift from a 400-line directive within two releases.

Five gates are redefined; every other stage is shared, unmodified:

| Attached gate | Detached behavior |
|---|---|
| Claude-confirm provider gate | read `provider` from `job.json`; no question |
| Worker `ROUTE=escalate` question | emit job-hub `question` carrying the decoded text; wait for inbox; relay the answer to the worker |
| `turn-send` "not idle" | wait 60s and retry, then `reset-status` once, then **park** — never a third silent force |
| Scope-check `OOS_COUNT > 0` | **park**; never auto-`Force-keep`, never auto-amend |
| Finish menu | `finish` from `job.json`, which `start` has already constrained to `keep` |

Plus one new terminal path: Stage 2 `VERDICT: FAIL` with rounds exhausted writes `RESUME.md` and **parks**
rather than aborting, so a budget-exhausted run is recoverable rather than discarded.

`ROUTE=verify` and `ROUTE=objection` questions are **not** parked — the job hub verifies claims against
ground truth and adjudicates objections exactly as the attached directive does. Only genuinely
human-owned decisions reach the operator.

### The autonomy envelope

A detached job is a second `claude` session at `--permission-mode auto`, unattended, spawning its own
workers, running the target repo's own test command un-sandboxed in the target repo (`verify-tests` is
in-place by design — this defends an honest worker's forged log, not a committed test trojan). That is
the same posture ap already runs workers under; detachment changes the *duration* and removes the
observer, so it is bounded three ways:

1. **`--budget-hours <N>` (default 6).** Checked mechanically at each round boundary via
   `ap job budget-check`; on exceed the job writes `RESUME.md` and parks with a `question`. It never
   silently continues and never silently discards.
2. **Branch-pinned.** The job hub works on `feat/implement-<TOPIC>` off a clean pre-snapshot, exactly as
   the attached run does.
3. **`--finish keep` only.** `ap job start` **rejects** `--finish merge` and `--finish pr` (rc 2) with a
   message naming the reason. Nothing leaves the branch while nobody is watching. The operator returns to
   a finished branch and runs the finish menu themselves.

### Job-hub death

`ap job status` reports it; nothing auto-recovers. A second job hub waking onto a live worker is how a run
gets corrupted, and resuming mid-stage needs durable stage state that does not exist yet. The status output
names the orphaned worker and the exact `ap stop <agent> <topic>` remedy. Auto-respawn is a deliberate
successor spec, not a v1 omission.

## Components

- `src/core/tmux.ts` — add pure arg builders `newSessionArgs(session, launch, cwd?)`,
  `newWindowArgs(session, launch, cwd?)`, `hasSessionArgs(session)`, `killSessionArgs(session)`,
  `sessionPanesArgs(session)`, each emitting `=<name>` exact-match targets; add the live wrappers
  `sessionExists`, `newSession`, `newWindow`, `sessionPaneIds`, `killSession`.
- `src/commands/spawn.ts` — parse `--session <name>`; reject it alongside `--target-pane` (rc 2); skip the
  `inTmuxSession()` gate when it is present; add the third placement branch before the `.last_pane` chain;
  leave stamping, labeling, `paneMetaWrite`, bootstrap, and the `ready` wait untouched.
- `src/core/paths.ts` — add `jobDir(topic, opts?)` returning `<topicDir>/_job`, gated through the same
  `assertSlug` choke point as every other art dir.
- `src/core/job.ts` — NEW. The job codec and pure predicates: `parseJob`/`formatJob` for `job.json`,
  `classifyJobLiveness(live, meta)` returning `alive|dead|unknown`, `budgetExceeded(startedIso, hours, now)`,
  `sessionKillable(sessionPaneIds, ownedPaneIds)`, and the status composer over injected reads.
- `src/commands/job.ts` — NEW. The `job` verb: `start`, `status`, `wait`, `attach`, `list`, `relay`, `stop`,
  `mode`, `budget-check`.
- `src/ap.ts` — add `job: () => import("./commands/job.js")` to the dynamic-import dispatch map.
- `config/prompt-templates/job-hub.md` — NEW. `identity.md` plus the three deltas; every other rule verbatim.
- `src/core/ipc.ts` — `identityWrite(i, m, t, opts?: { role?: "worker" | "job-hub" })` selects the template;
  default `worker` keeps every existing call site byte-identical.
- `commands/implement.md` — add the `## DETACHED MODE` section and the five gate redefinitions.
- `commands/quick.md` — same section; `quick` is already unattended, so only the finish/park rules differ.
- `commands/job.md` — NEW. The `/ap:job` slash command (`status` / `attach` / `relay` / `stop`).
- `src/commands/list.ts` — append a `JOBS` section listing each `_job/` with its three-valued liveness.
- `src/commands/stop.ts` — after the existing per-worker teardown, attempt the ownership-gated session kill.
- `tests/tmuxSession.test.ts` — NEW. Arg-builder shapes, `=` exact-match targets, cwd threading.
- `tests/job.test.ts` — NEW. Codec round-trip, the liveness classification table, budget boundary,
  `sessionKillable` fail-closed cases.
- `tests/spawnSession.test.ts` — NEW. Flag parsing, `--session` + `--target-pane` rejection, gate relaxation.

## Testing

- **Pure arg builders only for tmux** (repo rule): assert the exact argv arrays for `new-session`,
  `new-window`, `has-session`, `kill-session`, `list-panes -t`. No real panes in unit tests; live behavior
  is the dogfood.
- **Liveness classification table** — the full cross product of {pane live, pane gone} x {nonce matches,
  nonce mismatched, nonce absent, nonce malformed}, asserting `unknown` (never `dead`) for every
  unverifiable row.
- **`sessionKillable` fail-closed** — a session containing one unrecognized pane must return false; an
  empty owned-set must return false; only a fully-owned session returns true.
- **Budget boundary** — exactly-at-N-hours is within budget; N+1s exceeds; a malformed `started`
  timestamp is treated as exceeded (fail-closed toward parking, never toward running forever).
- **`--finish merge`/`pr` rejection** at `job start` with rc 2.
- **Flag isolation** — a `spawn` invocation without `--session` produces argv byte-identical to today's,
  asserted directly against the existing builders.
- **Template rendering** — `job-hub.md` renders with the same `{{agent}}/{{model}}/{{topic}}/{{state_dir}}`
  substitutions and the same `ready`-emission tail; a diff test asserts it retains the inbox-only-channel
  and FLAG paragraphs verbatim from `identity.md`.
- **Isolation** — every test sets `AP_HOME` to a fresh temp dir (`tests/helpers/tmpHome.ts`).
- **Gates** — `npm run typecheck && npm run test && npm run lint && npm run build`; `dist/ap.cjs` rebuilt
  and committed. `tests/stale-tokens.test.ts` must stay green (no banned token enters `src`/`config`/
  `commands`/`hooks`).
- **Live dogfood** (not a unit test, required before the landing is called done): one real
  `/ap:implement <small doc> --detached` run on this repo, verifying: the origin hub returns in under
  ~2 minutes; `tmux attach -t ap-<topic>` shows two live TUIs; `ap job status` tracks the stages;
  a deliberately-parked question is answered with `ap job relay` and the run resumes; the origin
  hub's Claude Code session is restarted mid-run and `/ap:job attach` recovers the view; the run
  ends on `feat/implement-<topic>` with nothing merged or pushed.

## Success Criteria

1. `/ap:implement <doc>` and `/ap:quick "<task>"` without `--detached` emit byte-identical tmux argv and
   byte-identical state writes to 0.5.31.
2. `/ap:implement <doc> --detached` returns control to the origin hub in under 2 minutes and the run
   continues to completion with the origin hub idle.
3. `tmux attach -t ap-<topic>` shows the job hub and its worker as live, labeled, color-bordered TUIs.
4. Killing the origin hub's Claude Code session mid-run leaves the job running; `/ap:job attach <topic>`
   in a fresh session restores status, the completion notification, and stall detection.
5. `ap job status` never reports `dead` for a job hub whose ownership nonce is absent or unverifiable.
6. A worker `ROUTE=escalate` question reaches the operator as a parked `question`, and `ap job relay`
   resumes the run without re-sending the worker's task.
7. `ap job start --finish merge` and `--finish pr` exit rc 2; no detached run merges, pushes, or opens
   a PR.
8. A job exceeding `--budget-hours` parks with `RESUME.md` written; it neither continues nor discards.
9. A detached session is killed at teardown only when every pane in it is provably ap's; otherwise it is
   left intact with a message naming the unrecognized pane.
10. `npm run typecheck`, `npm run test`, `npm run lint`, `npm run build` all pass; `dist/ap.cjs` is
    rebuilt and committed; the stale-token gate stays green.

## PR split

- **PR 1 — placement primitive.** `src/core/tmux.ts` builders + wrappers, `spawn --session`, the three
  new test files' tmux/spawn halves. No job layer, no directive change, no behavior change to any
  existing path. Independently useful and independently reviewable.
- **PR 2 — job layer.** `src/core/job.ts`, `src/commands/job.ts`, `config/prompt-templates/job-hub.md`,
  the `identityWrite` role parameter, the `DETACHED MODE` directive sections, `commands/job.md`,
  the `list`/`stop` additions, and the remaining tests. Depends on PR 1.

## Frozen-protocol confirmation

No event name, sentinel, JSON field, `contracts.yaml` key, state filename, or env var is added, renamed,
or repurposed. The job hub communicates entirely in the existing `ready`/`ack`/`progress`/`done`/`error`/
`question` vocabulary, writes the existing `inbox.md`/`outbox.jsonl`/`status.json`/`pane.json`, and signs
its worker messages `From: hub`. `--session` is a new CLI flag on `spawn`; `job` is a new subcommand.
Both are additive.

## Amendments (recorded during implementation)

- **PR 1 ships only the builders it consumes.** The Components list names five session builders;
  `killSessionArgs`, `sessionPanesArgs`, and their live wrappers `sessionPaneIds`/`killSession` are
  deferred to PR 2, where the ownership-gated session teardown is the code that calls them. Shipping
  them in PR 1 would land four exported functions with no caller.
- **The prefix-match hazard is verified, not inferred.** Against live tmux 3.x with only `ap-foobar`
  on the server, `has-session -t ap-foo` exits 0 and `new-window -t ap-foo:` opens its window inside
  `ap-foobar`. The `=` exact-match form is therefore a correctness requirement, not defensive style.
- **`ensurePaneBorders` needed a second call on the detached path.** `tmux set-option -g` exits 1
  ("error connecting to ...") against a cold server, which is the normal state when a detached spawn
  is the first thing to touch tmux. Without the retry after `new-session`, every detached worker
  would lose its border label and the first call would emit a spurious warning. `spawn` now withholds
  the warning on the `--session` path and retries once the session has started a server.

### PR 2 amendments

- **The session sweep lives in `job stop`, not `stop.ts`.** The Components list put it in
  `src/commands/stop.ts`. In practice teardown kills every worker pane individually and tmux destroys
  a session once its last window closes, so the sweep is a **safety net for the case where a pane was
  deliberately NOT killed** (unprovable ownership) — never the normal path. Extending `StopDeps` with
  tmux session calls to serve an almost-always no-op was not worth the surface; `/ap:stop <topic>`
  leaves nothing behind either way. Both branches are verified: all-panes-ours kills the session, and
  one unaccountable pane leaves it intact and names the pane.
- **`job stop` deletes the job record rather than archiving it.** The per-worker archives already
  carry the outbox, the identity, and everything forensics reads; `archiveTopic`'s suite parameter is
  a closed enum that a new `_job` member would have to join for no gain.
- **`spawn --role worker|job-hub` is how the template gets selected.** The spec said `identityWrite`
  takes a role but not how a spawn expresses one. An unknown role is refused (rc 2) rather than
  falling back to the permissive template.
- **`job start` derives the topic from the args file** using the same `deriveTopicFromPath` /
  `--topic` precedence `implement init` uses, so the job record and the run it launches cannot
  disagree about which topic they are. `--topic` overrides; an underivable topic is refused with a
  message naming the flag.
- **`AP_JOB_WAIT_TIMEOUT_S`** (default 3600) bounds one `job wait`. A timeout is not a failure — the
  origin hub re-arms — so it is deliberately long and deliberately not fatal.
