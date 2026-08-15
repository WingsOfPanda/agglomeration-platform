# Autoresearch worker lane — one home for state.txt's read-modify-write — design

**Date:** 2026-08-14 · **Origin:** the four-walk architecture review (walk 2, candidate 3), Wave A
PR-5 of the deepening program agreed by grilling. · **Scope:** one PR (0.5.22), one commit,
byte-identical throughout — state.txt bytes, every log/stdout line, every rc unchanged. No
behavior changes; in particular the finalize-vs-resume reconcile divergence is PRESERVED (its
unification is a behavior change requiring its own spec — listed as a post-dogfood candidate).

## Problem

`src/core/autoresearchState.ts` is a KV codec (parse/render/merge + two reconcile helpers), not a
lane module. The lane MACHINERY lives in the callers:

- `join(workerStateDir(art, agent), "state.txt")` reconstructed at 10 command-file sites
  (autoresearch.ts:560, 631, 881, 1036, 1121, 1152, 1568, 1673, 1702, 1733 as shipped at 0.5.21).
- The read-modify-write — spelled at 7 command-file sites (:1137, :1143, :1591, :1680, :1712,
  :1718, :1749) plus computeScore's plan entry; only `buildDispatchState`
  (autoresearchExperiment.ts) ever got a core home. **The seven do NOT share one read discipline,
  and this spec originally claimed they did** — the correction that follows is load-bearing,
  because a single tolerant base silently changes two of them:
  - 5 sites read TOLERANTLY, `atomicWrite(stateTxt, mergeState(readOr(stateTxt), {...}))`
    (:1137, :1143, :1680, :1712, :1718) — a missing lane merges onto nothing.
  - :1591 (fresh-worker's post-spawn reset) reads STRICTLY, `mergeState(readFileSync(stateTxt,
    "utf8"), ...)`, and THROWS if the lane vanished or became unreadable during the teardown +
    respawn window it just crossed. Recreating the lane from the six keys being written would
    report `[ OK ] respawned` over a broken campaign, and inside resume's pass 3 would turn an
    aborted verb into a "lane healthy" row.
  - :1749 (resume's pass-3 interrupt) merges over a SNAPSHOT: `raw` is read before the
    `ledgerAdd`, and the write is `mergeState(raw, ...)` — anything written to the lane in
    between is overwritten, not preserved.
  The lane module must preserve each site's discipline, not unify them.
- The finalize reconcile (autoresearch.ts:1114-1145) hand-rolls its pane-outbox tail slice with a
  comment explaining it is deliberately NOT `reconcileFromOutboxSince` (no shrink guard —
  finalize runs once at wind-down); resume uses the shrink-guarded helper. The divergence is
  real and intentional, but it lives as a call-site comment instead of two named entry points in
  one file.

## Goal

A lane module owns the path, the read, the transition write, and the two reconcile flavors — the
10 path builds and 7 read-modify-writes become one-liners, and the deliberate divergence becomes
two adjacent named functions whose doc comments explain each other. Bytes on disk identical.

## Architecture

**`src/core/autoresearchLane.ts`** (new; one file per responsibility — autoresearchState.ts stays
the pure codec, unchanged):

- `lanePath(art, agent): string` — the join, stated once.
- `readLane(art, agent): Record<string, string>` — `parseState(readOr(lanePath(...)))`.
- `applyTransition(art, agent, updates: Record<string, string>): void` — the atomic
  read-modify-write. Every current site's WRITE CONTENT must be byte-identical (same keys, same
  merge semantics — it delegates to mergeState). **Amendment (adversarial review):** one
  transition is not enough, because the seven sites use three different read disciplines (see
  Problem above). The module ships all three, each naming its site in a doc comment, which is the
  honest "one home" outcome — it makes a discipline that was previously incidental at each call
  site explicit and checkable:
  - `applyTransition` — TOLERANT (`readOr`), 5 sites.
  - `applyTransitionStrict(art, agent, updates)` — STRICT (`readFileSync`, throws), 1 site:
    fresh-worker's post-spawn reset.
  - `applyTransitionFrom(art, agent, existing, updates)` — SNAPSHOT (the caller's earlier read),
    1 site: resume's pass-3 interrupt, which keeps its `raw` capture.
- `reconcileLaneAtFinalize(...)` and `reconcileLaneAtResume(...)` — the two flavors, moved with
  their exact current semantics: finalize's = cursor-offset subarray of the PANE outbox with NO
  shrink guard + `reconcileFromOutbox` + conditional phase transition; resume's = the
  shrink-guarded `reconcileFromOutboxSince` path. Derive the exact signatures from the shipped
  call sites (finalize: autoresearch.ts:1118-1145 — the WHOLE per-agent body, both the (a)
  reconcile including the curExp/doneResultExists derivation and the (b) `finalizePhase` case-map
  call, so the caller is a one-line loop; resume: :1673-1680 and :1712-1718 — if the two resume
  sites differ, the function takes the differing inputs as parameters rather than unifying them).
  Each carries a doc comment naming the OTHER and why they differ (the shrink guard), replacing
  the call-site NOTE. The conditional `recon === "failed" || recon === "idle"` write stays exactly
  as-is in both.

  Realized signatures: finalize takes `(art, agent, topic)` and resolves the pane outbox itself,
  which preserves the shipped statement order exactly (the state.txt existence check runs BEFORE
  `resolveModel`); resume takes `(art, agent, outboxText, offset, expId)` — its two sites differ
  only in which experiment's result.json vouches for a `done` (pass 1 the lane's own
  `current_exp_id`, pass 2 the unresolved intent's), so that is the parameter.
- OUT OF SCOPE, stated in the module header as pointers only: the phase vocabulary's consumers
  (finalizePhase's case-map in autoresearchFinalize.ts, experiment-send's abandoned/idle dispatch
  gate, fresh-worker's `working` refusal) stay where they are — moving refusal checks is
  behavior-adjacent churn this PR does not buy; the header lists them so the next reader finds
  the whole vocabulary from one place.

Callers converted: every command-file read-modify-write site and path reconstruction;
computeScore's plan entry is NOT converted (it returns a plan applied by scoreWith — different
mechanism, byte-identical today; note in spec, leave alone). `buildDispatchState` stays in
autoresearchExperiment.ts (already a pure core home) — its APPLICATION site converts to
applyTransition only if that site is one of the enumerated read-modify-writes. It is not:
`atomicWrite(stateTxt, buildDispatchState(readFileSync(stateTxt, "utf8"), …))` passes a
fully-rendered string, not an updates map, so it stays as-is (its path build does convert).

## Components

- `src/core/autoresearchLane.ts` (new) · `src/commands/autoresearch.ts` (sites converted) ·
  `src/core/autoresearchState.ts` untouched.
- `tests/` — new lane suite: lanePath, applyTransition merge semantics (byte-compare state.txt
  against a hand-built mergeState result), both reconcile flavors incl. the divergence pin (a
  SHRUNK outbox: finalize flavor re-reads nothing / behaves exactly as the hand-rolled slice did;
  resume flavor re-reads from start — pin BOTH current behaviors). Existing suites: zero
  assertion edits (state.txt content assertions across autoresearch tests are the pins).
- Version 0.5.21 → 0.5.22 (three manifests) + rebuilt committed dist.

## Testing

- All existing suites green with zero assertion edits.
- Divergence pin: identical inputs with offset past EOF (shrunk/recreated outbox) → the two
  flavors differ exactly as today. What ships: `Buffer.subarray(start)` past EOF returns an EMPTY
  buffer (no clamp), so finalize replays NOTHING and only its case-map fires (a `working` lane
  lands on `incomplete`); resume's shrink guard re-reads from byte 0, sees the `done`, and settles
  the lane to `idle`. This is the pin that makes a future unification a VISIBLE behavior change.
- Mutation (Q10): re-inlining a read-modify-write at a converted site must fail a test; swapping
  the two reconcile flavors must fail the divergence pin. The re-inlining half needs a STRUCTURAL
  pin — a re-inlined `atomicWrite(stateTxt, mergeState(readOr(stateTxt), …))` is byte-identical by
  construction, so no behavioral test can catch it. The lane suite therefore greps the shipped
  `src/commands/autoresearch.ts` for the read-modify-write SHAPE (`atomicWrite(...mergeState...)`)
  and for a `, "state.txt")` path build and asserts both are absent (same idiom as
  `tests/stale-tokens.test.ts`). The pin is the shape and not the bare `mergeState(` symbol:
  banning the symbol outright would also fire on a legitimate non-lane use of the
  `buildDispatchState` composition.
- Read disciplines: one pin each — tolerant merges over a missing lane, strict throws on it, and
  snapshot overwrites a write that landed after the caller's read while tolerant keeps it.
- Full gate green; dist rebuilt and committed.

## Success Criteria

- `grep -c 'mergeState(readOr' src/commands/autoresearch.ts` is 0; the state.txt join appears
  once for the disk-backed lane, in the lane module. `computeScore` keeps its own path build
  because it reads through an INJECTED `ScoreFs`, not the disk — converting only its path
  expression would leave the read/write halves in two different homes, so the whole plan entry
  stays out of scope (as stated in Architecture above).
- The reconcile divergence is two named adjacent functions with mutual doc comments and a pin.
- Gate green; dist rebuilt+committed; 0.5.22; state.txt bytes provably unchanged.
