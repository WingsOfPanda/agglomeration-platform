# Consort Foundation — Dogfood Result

**Date:** 2026-05-29 · **Branch:** `feat/foundation` · **Verdict:** ✅ PASS

The foundation sub-project's acceptance gate (Plan 03 Task 24): a live
`spawn → send → collect → roster → coda` against a real `codex` pane in tmux,
under an isolated `CONSORT_HOME=/tmp/consort-dogfood`.

## Run

| Step | Result |
|---|---|
| `soundcheck` | `Verdict: OK — ready to spawn (4/4 providers available; 0 warnings)` |
| `spawn violin codex dogfood-foundation` | pane `%20447`, border label `strings-violin:codex:dogfood-foundation`; emitted `{"event":"ready","ts":"…","instrument":"violin","model":"codex"}`; rc=0 |
| `send violin dogfood-foundation "…"` | inbox written (`From: maestro`) + pane nudged; rc=0 |
| `collect violin dogfood-foundation` | `{done}` received; rc=0 |
| `roster` | `violin  codex  dogfood-foundation  %20447  idle (done)` |
| `coda violin dogfood-foundation` | graceful FINE banner → one 9s wait → killNow → `archived violin-codex-20260529T063726Z`; rc=0 |

Full outbox sequence (the wire protocol, end-to-end):
```jsonl
{"event":"ready","ts":"2026-05-29T06:35:48Z","instrument":"violin","model":"codex"}
{"event":"ack","task_summary":"Report current working directory, then emit done event.","ts":"…"}
{"event":"progress","note":"/home/liupan/CC/consort","ts":"…"}
{"event":"done","summary":"Current working directory reported: /home/liupan/CC/consort","ts":"…"}
```

Post-teardown: part dir archived, topic dir `rmdir`'d, pane killed. The `instrument`
key (Tier-2 rename) is live in the emitted events.

## Notes / findings surfaced by the dogfood

- **soundcheck global-root bug** (fixed, commit `5182d21`): `soundcheck` copied config
  into `globalRoot()` before ensuring that directory existed (it only `stateEnsure()`'d
  the project root). Fixed to ensure the global config root early; regression test added.
- **codex 0.135.0 directory-trust prompt** (environment prerequisite, not a consort
  defect): codex gates first-run per repo with a trust picker that `--dangerously-bypass-
  approvals-and-sandbox` does not cover. The spawn mechanics (pane split, launch, nudge,
  ready-poll, and on the first attempt the timeout → `failure-reason.txt` → `…-FAILED`
  archive → exit 1) all worked correctly; `{ready}` arrived once `/home/liupan/CC/consort`
  was added to codex's trusted projects.

## Verification context

- 102 vitest unit tests green; `tsc --noEmit` + eslint clean; stale-token gate clean.
- 12-agent adversarial verification vs. clone-wars caught + fixed a real event-precedence
  bug in `outboxWait` (commit `cc6dc6d`: events resolve in argument order, not file order).

---

# Consort `solo` — Dogfood Result

**Date:** 2026-05-29 · **Branch:** `feat/solo` · **Verdict:** PASS

The first high-level command (`solo`, porting clone-wars `strike`): a live
`init → brief → branch → spawn → single turn → verify → finish → coda → summary` against a
real `codex` part in tmux, under an isolated `CONSORT_HOME=/tmp/consort-solo-dogfood` and a
throwaway target repo `/home/liupan/CC/solo-dogfood-tmp` (run with `--finish`).

## Run

| Step | Result |
|---|---|
| `solo init "add hello file --finish"` | rc 0; printed `SLUG=add-hello-file INSTRUMENT=tuba PROVIDER=codex FINISH=yes TARGET=...`; scaffolded `_solo/{execute/}` + topic/provider/instrument/timing/finish files |
| brief | conductor wrote `_solo/task-brief.md` (Goal / Acceptance check) |
| `solo branch add-hello-file` | clean tree → no WIP commit; created `feat/solo-add-hello-file` (base `f62854d1`); recorded target_cwd/start-branch/branch-base/branch |
| `spawn tuba codex add-hello-file --cwd <tgt>` | pane `%20448`, label `brass-tuba:codex:add-hello-file`; `{"event":"ready",...,"instrument":"tuba","model":"codex"}`; rc 0 |
| `solo turn-send … 1` | composed round-1 prompt, `OFFSET=82` recorded, inbox written + pane nudged |
| `solo turn-wait … 1` | `TS=ok` appended; codex implemented `hello.txt`, ran the test, committed `feat: add hello file` |
| `solo detect-test <tgt>` | `bash tests/run.sh` |
| verify | `PASS (bash tests/run.sh)`; diff `1 file changed, 1 insertion(+)` |
| `solo finish add-hello-file` | `FINISH=yes`, no remote → `finishBranch` → `keep`/`kept`; restored target to `master` |
| `coda tuba add-hello-file` | graceful FINE banner → 9s wait → killed pane `%20448` → `archived tuba-codex-20260529T083827Z` |
| `solo summary add-hello-file` | `SUMMARY.md` `status: ok`, duration 259s, the full Result + Where-to-look sections |

Full outbox sequence (the wire protocol, end-to-end):
```jsonl
{"event":"ready","ts":"2026-05-29T08:35:23Z","instrument":"tuba","model":"codex"}
{"event":"ack","task_summary":"Create repo-root hello.txt with the required line, run tests, commit the change.","ts":"…"}
{"event":"progress","note":"…repo appears to have only README.md so far.","ts":"…"}
{"event":"progress","note":"Added hello.txt and tests/run.sh exited 0; preparing the conventional commit.","ts":"…"}
{"event":"done","summary":"Committed hello.txt with the required hello from solo line; tests/run.sh passes.","ts":"…"}
```

## Findings / fixes surfaced

- **Adversarial verification (6-agent, pre-dogfood)** vs the clone-wars `strike`/`deploy` spec:
  slug pipeline (5000-input differential fuzz), `preSnapshot`, and `finishBranch` (arg arrays,
  outcome tokens, always-restore) all **fidelity-confirmed**. It caught one **behavioral bug**:
  `turnWaitWith` *appends* a `TS=` line per wait, so after a question→re-arm cycle `turn-1.txt`
  holds multiple `TS=` lines; the directive must read the **last** one. Fixed (commit `3511af7`:
  `grep '^TS=' | tail -1`, matching `strike.md`).
- **SUMMARY archive line** (found by this dogfood): `SUMMARY.md` showed `Archived state: (not
  archived)` because nothing recorded `_solo/archived-path.txt`. Fixed (commit `c192c22`): the
  directive now captures `coda`'s reported archive path before `summary`, mirroring `strike`.
- **Documented intentional deviations** (verified, not bugs): the `args.ts` arg-fault rc legend
  is consort-internal (rc 2) and differs from strike's rc 1, but is consistent across consort
  commands and the missing-file terminal rc still coincides (1); the done-vs-error within-slice
  tie-break uses the foundation's pinned argument-order precedence and is unreachable in practice
  (a turn emits exactly one terminal event).

## Verification context

- 150 vitest unit tests green (`solo-core` / `solo-gitwork` / `solo-turn` / `solo-cmd` added);
  `tsc --noEmit` + eslint + stale-token gate clean; `dist/consort.cjs` rebuilt + committed.
- Per-task two-stage review (spec compliance → code quality) across 6 phases; one Important
  review finding fixed (init made deterministically testable so CI without `codex` still covers
  the happy path).
