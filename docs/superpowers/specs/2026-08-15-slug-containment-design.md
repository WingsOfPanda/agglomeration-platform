# Slug containment: gate topic + agent at the path choke points — design

**Date:** 2026-08-15 · **Origin:** codex whole-repo adversarial review finding f1, adversarially
verified REAL (medium) by execution against the committed dist. · **Scope:** one PR (0.5.27).
Security/robustness fix; the only behavior change is that ~90 verbs now REFUSE an out-of-charset
topic/agent instead of acting on a traversed path.

## Problem

`validateSlug` (core/slug.ts, `^[a-z0-9-]+$`, 1..32) is called from exactly THREE verbs today —
spawn, send, collect (PR #90). Every other path-bearing verb interpolates its `topic` (and, at some
sites, `agent`) straight into `join()` with no containment check, and `topicDir()`/`workerDir()`
normalize `../` segments. Reproduced against the committed dist (throwaway cwd + AP_HOME, canaries
outside the state root):

- `design archive '../../../canary'` → rc 0, renamed `canary/_design` and rewrote
  `canary/alpha-codex/status.json` (a file outside `.ap/state`).
- `design offset-reset '../../../victim' alpha research` → rc 0, deleted files under `victim/`.
- `design offset-reset auth-review '../../../../../../../secrets/keep' research` → rc 0, **deleted
  an arbitrary `.txt` with a perfectly VALID topic** — the `agent` arg is a second unguarded segment
  interpolated as `${phase}-${agent}.txt` / `.done` / `question-${agent}.txt`.
- `stop '../../../victim'` → rc 0, renamed a directory outside state.

Every slug MINTER already emits a subset of `[a-z0-9-]` (deriveSlug ≤20; autoresearch `--slug` ≤20;
assertImplementTopic ≤32), and the supplier of a topic/agent is the hub/operator only — no
worker-controlled string becomes a path segment (traced: `topic.txt` is display text, never joined;
agent names come from roster/readdir). So this is a confused-deputy containment gap, not a direct
worker capability — medium, with genuinely destructive primitives (arbitrary single-file delete,
external directory rename, status.json clobber) if the hub is ever induced to pass a crafted string.

## Goal

One choke point gates every art-dir derivation; one arg gate covers the `agent` segment that the
choke point cannot see (it is interpolated into a filename INSIDE the art dir). Refusal is a clean
rc 2 + one stderr line, never a stack trace. No frozen name touched; every legitimate hub-driven run
is byte-identical.

## Architecture

1. **core/slug.ts** — add `export class SlugError extends Error { code = 2 }` and
   `export function assertSlug(kind: "topic" | "agent", s: string): string` that returns `s` when
   `validateSlug(s)` else throws `SlugError` with the existing wording
   (`<kind> must match [a-z0-9-]+ and be <= 32 chars; got: '<s>'`). Do NOT tighten `validateSlug`.
2. **core/paths.ts** — `topicDir()` gates its topic through `assertSlug("topic", topic)`;
   `workerDir()` gates its agent through `assertSlug("agent", agent)` (the `${agent}-${model}` seg).
   This single edit covers every art dir (design/explore/implement/quick/bridge/autoresearch),
   archiveTopic/stateArchive, stop, ipc, agents — all ~90 verbs at once. `preflight` keeps an
   explicit call (its `--art-dir` form never reaches `topicDir`, and its topic also lands in the
   pane's tmux sentinel command) but loses its PRIVATE `SLUG` copy, whose `<= 64` bound had been
   silently disagreeing with the choke point's `<= 32`: one validator, one bound.
3. **core/dispatch.ts** — catch `SlugError` alongside the existing `KvError` so it renders as a
   clean stderr line + rc 2 instead of an rc-1 stack.
4. **The sites the choke point cannot see** — where a segment is interpolated into a path the two
   gated helpers never build. Add the gate after each verb's own arg validation. Enumerated from the
   shipped source (the verifier's candidate list was a map, not gospel; corrected on both sides):

   | Site | Why it needs its own gate |
   |---|---|
   | `runFlag` (`core/forensics.ts`), i.e. `<command> flag <topic>` for all six commands | the ONLY non-art-dir site: `recordHubFlag` → `writeForensicsFeed` names `globalRoot()/forensics/<date>/<time>-<command>-flag-<topic>.md` and passes the literal `"(hub-flag)"` as its art dir, so no art-dir helper ever runs. The gate must sit in `runFlag`, NOT in `recordHubFlag`/`captureSpawnFailure` — both wrap their bodies in a catch-all that returns `""`, which would swallow the refusal and report success |
   | `design offset-reset` (`commands/design.ts`) | `rmSync(join(art, \`${phase}-${agent}.txt\`))`, `.done`, `question-<agent>.txt`, `clearAgentStrikes` — the arbitrary-file delete |
   | `triad()` (`core/phaseTable.ts`) | the shared arg parser for EVERY design/explore `<phase>-send` and `<phase>-wait`; `phaseSend`/`phaseWait` spell `<phase>-<agent>.txt`, `<agent>_<phase>_prompt.md`, `question-<agent>.txt` in the art dir BEFORE the first `workerDir` read |
   | `autoresearch monitor` | `mkdirSync(workerStateDir(art, agent))` + the lane cursor writes |
   | `autoresearch verify-plan` / `verify-check` / `inspect-plan` / `inspect-check` | `experimentDir(art, agent, expId)` — the read and the verdict sidecar write. BOTH segments: `assertSlug("agent", …)` and, on the next line, the `EXP_ID_RE` test these four verbs skipped though `refine`/`experiment-send` already run it |

   Rejected as already covered, and deliberately NOT double-gated: `implement reset-status` (agent
   goes only through `resolveModel`'s readdir prefix match — dir names carry no separator — and
   `statusPath` → `workerDir`); `autoresearch drop-worker` (agent is a `workers.txt` line and a Map
   key, never a path segment; only its topic is); `autoresearch fresh-worker` / `experiment-send` /
   `refine` (already gated by `AGENT_RE` ahead of any path use); `implement turn-send`/`turn-wait`
   (hardcoded `WORKER = "lead"`); `stop` (readdir prefix filter); every loop over `workers.txt` /
   `list.txt` / readdir (roster-derived, not operator args).

   Out of scope, recorded not fixed: the `model` segment of `${agent}-${model}` (contracts-derived,
   and `spawn` never validated it either) and `AP_IMPLEMENT_ART_DIR_OVERRIDE`, which bypasses
   `topicDir` by design.

## Components

- `src/core/slug.ts` — `SlugError` + `assertSlug`.
- `src/core/paths.ts` — the two choke-point gates.
- `src/core/dispatch.ts` — `SlugError` → rc 2.
- `src/commands/design.ts`, `src/core/phaseTable.ts`, `src/commands/autoresearch.ts`,
  `src/core/forensics.ts`, `src/commands/preflight.ts` — the gate at the enumerated sites.
- `tests/` — see Testing. Version 0.5.26 → 0.5.27 (three manifests) + rebuilt committed dist.

## Testing

- Traversal regression per destructive verb (`tests/slug-containment.test.ts`): `design archive`,
  `design offset-reset` (topic AND agent), `design <phase>-send`/`-wait`, `stop`, `implement
  reset-status`, `autoresearch drop-worker` / `monitor` / `verify-*` / `inspect-*` (agent AND
  exp-id), `<command> flag` for all six commands, and `preflight`, each with a `../` segment → rc 2,
  one stderr line, and a planted canary OUTSIDE a temp state root UNTOUCHED.
  Each case first PINS the reach it refuses (`resolve(art, <the interpolated name>)` equals the
  canary path), so a mis-counted `../` fails the test instead of passing vacuously. One exception,
  by the enumeration above: `implement reset-status` with a traversal AGENT is rc **1** (no worker
  found), not rc 2 — asserted as such, with the canary intact.
- Happy path: each of those verbs with a valid slug behaves byte-identically (rc + stdout pinned).
- `assertSlug` unit: accepts the minter charset, rejects `../`, absolute paths, empty, >32,
  uppercase, `/`.
- Existing suites pass. Known adjustment: tests/implement-init.test.ts:121 hands a 36-char topic
  straight to `implementArtDir` as a probe — the VERB still refuses first (rc 2 unchanged), only the
  test's own `existsSync(implementArtDir(badTopic))` probe now throws; adjust that ONE line
  (`expect(() => implementArtDir(badTopic)).toThrow()` or build the path manually). List it in the
  report.
- Full gate green; dist rebuilt+committed.

## Success Criteria

- Every reproduced traversal (archive/offset-reset topic+agent/stop/drop-worker) refuses rc 2 with
  the canary intact; every legitimate minted-slug run is byte-identical (the existing 2220-test
  suite is that pin, plus three explicit happy-path rc-0 cases).
- `assertSlug` is the single gate; `validateSlug` and every frozen name are unchanged.
- Gate green; 0.5.27.
