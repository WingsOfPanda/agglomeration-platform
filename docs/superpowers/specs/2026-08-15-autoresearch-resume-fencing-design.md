# Autoresearch resume-intent offset + mandatory generation fencing — design

**Date:** 2026-08-15 · **Origin:** codex review findings f3 (REAL, medium) and f4 (PARTIAL — the
unfenced-dispatch half REAL, the check-then-act-race half REFUTED), both verified by execution.
Grouped because both live in `src/commands/autoresearch.ts` + the ledger and both harden the
campaign-spine crash/takeover model. · **Scope:** one PR (0.5.29), two commits.

## Problem A (f3) — resume attributes an old completion to a new unresolved intent

`dispatch-intent` is appended with NO outbox offset (autoresearch.ts ~708; `data` carries only
`operator`). `dispatch-delivered` carries `data.outboxOffset = preOffset` captured before the inbox
write. So `replayLedger` only ever knows the PREVIOUS dispatch's pre-send offset. Resume's pass-2
(unresolved-intent) slices the acceptance tail from THAT offset — which for exp-002's intent begins
at exp-001's dispatch point and contains all of exp-001's own ack/progress/done. Reproduced with a
crash-injection fixture (exp-001 dispatched+delivered+completed, then exp-002 gets a dispatch-intent
but the hub crashes before inboxWrite): resume prints no `REDISPATCH`, appends a fabricated
`dispatch-delivered{outboxOffset:<prev>, reconstructed:true}`, and marks the lane
`working/current_exp_id=exp-002` — stranding the lane (re-running resume can't fix it;
`experiment-send` and `fresh-worker` both refuse the working lane; only a pane death or the Monitor's
900s/1800s escalation rescues it). The error variant writes a PHANTOM failed experiment into the
campaign record the validity layer reads. Every exp-N, N≥2, is exposed; exp-001 is safe.

The spec's own acceptance criterion (un-keyed-completion hazard closed by offset scoping) holds on
the DELIVERED path (tested) and is open on the INTENT path — a crash-matrix gap, not a design
tradeoff.

## Problem B (f4) — dispatch fencing is optional, so a superseded hub launders writes

`experiment-send`'s stale-generation check runs only when `--gen` is supplied
(autoresearch.ts ~639-642: `effGen = hasLedger ? controllerGen(art) : 1;` then the refusal is gated
on `p.gen !== undefined`). The documented flow dispatches the INITIAL controller without `--gen`
(commands/autoresearch.md: `[--gen <GEN>]` bracket-optional; "after a resume, always pass --gen"),
and `init` never prints a GEN. So a controller that started via `init` and never resumed dispatches
UNFENCED for the whole campaign — and after another hub resumes and bumps the generation, the old
hub's writes are stamped with the LIVE generation, so the ledger (the artifact meant to make
split-brain visible on replay) hides them. Reproduced: superseded hub with no `--gen` dispatched
`exp-002` rc 0 under gen 2; two hubs concurrently clobbered one worker's inbox, both rc 0.

REFUTED sub-claim (do NOT "fix"): the check-then-act race with a VALID `--gen` is already closed —
`appendEvent`'s append-time re-read throws on `ev.gen < controllerGen` BEFORE any worker-visible
effect (proven: a resume fired inside the dispatch window left inbox md5 unchanged, lane untouched,
no dispatch-intent). Full lock/CAS is NOT justified (it would only buy the sub-ms intent→inbox gap
in a one-controller model, at the cost of lease-expiry policy — the very reason generations were
chosen over locks).

## Architecture

### Commit 1 — Problem A: persist and slice the intent's own offset

1. autoresearch.ts (the dispatch-intent append, ~708): `preOffset` is already captured one line
   above. Stamp it on the intent: `data: { outboxOffset: preOffset, ...(operator !== undefined ?
   { operator } : {}) }`.
2. src/core/autoresearchLedger.ts: add `intentOffset?: number` to `LedgerIntent`; populate it in the
   `dispatch-intent` branch from `e.data?.outboxOffset`. `lastDeliveredOffset` keeps its meaning
   (only the delivered branch writes it).
3. autoresearch.ts pass-2 (~1666): slice from the intent's own offset with a legacy-safe fallback:
   `const priorDelivery = replay.lastDeliveredOffset.get(agent);`
   `const reconstructed = intent.intentOffset ?? (priorDelivery === undefined ? 0 : -1);`
   and when `reconstructed < 0` (a pre-fix ledger with a prior delivery — unattributable), SKIP the
   ack/done tail scan and fall through to the existing `phase !== "working"` → REDISPATCH branch.
   `??` not `||` (offset 0 is valid — a recreated outbox makes zero a real pre-send offset, and
   `||` would read it as "unrecorded" and strand the lane). Pre-fix in-flight campaigns thus fail
   SAFE: an unattributable intent re-dispatches the SAME exp_id (idempotent), guarded by
   `phase !== "working"`.
   CONFIRM the exact line/variable names against the current source (post-0.5.22 this routes through
   `reconcileLaneAtResume`); the verifier's line cites may have drifted.
4. The scan slice carries the same SHRINK GUARD as its two sibling readers (`ipc.readFrom`,
   `reconcileFromOutboxSince` — the latter called on the very next line with this same offset): an
   offset past EOF means the outbox was RECREATED (a respawn zeroes it while the ledger keeps the
   old offsets), so the whole new file is this dispatch's tail. `start = obBuf.length <
   reconstructed ? 0 : reconstructed`, leaving `-1` as the legacy "unattributable" sentinel. Without
   it the scan and the reconcile on the next line would disagree about the same bytes — and the
   intent offset trips this MORE often than the delivered offset it replaces, being strictly later.

### Commit 2 — Problem B: grandfathered mandatory fencing

autoresearch.ts, next to the existing gate (~639-642):
```
const hasLedger = existsSync(ledgerPath(art));
const effGen = hasLedger ? controllerGen(art) : 1;
if (hasLedger && effGen > 1 && p.gen === undefined) {
  return fail(`campaign is on controller generation ${effGen}; pass --gen (re-enter via 'autoresearch resume ${topic}')`, 3);
}
if (hasLedger && p.gen !== undefined && Number(p.gen) !== effGen) { ...existing rc 3... }
```
`effGen > 1` is the grandfather clause: a never-resumed campaign (gen 1) and pre-ledger campaigns
dispatch exactly as today, so the shipped directive's `[--gen]` needs no edit and no in-flight
campaign breaks on update; the moment any hub resumes, every controller not from that resume is
fenced out permanently instead of adopting the new gen.

Cosmetic (same commit): wrap the two `ledgerAppend` calls so `appendEvent`'s "stale gen" throw
returns the documented rc 3 + same stderr wording instead of an uncaught stack trace + rc 1 (effects
were already none in that path — proven). The conversion is NARROW: only that throw becomes rc 3
(matched via the ledger's own `isStaleGenError`), because an unwritable ledger (EACCES, EISDIR, disk
full) reported as "pass --gen / re-enter via resume" sends the operator after a generation that is
not the problem — every other error keeps surfacing as it did before. On the DELIVERED append rc 3
means the inbox already landed and only the delivery record was fenced; the superseding controller's
resume resolves that lane through the unresolved-intent pass, which is why the effect is left in
place rather than rolled back.

Frozen protocol untouched: `--gen` is a CLI flag; ledger event kinds and `data` are outside the wire
protocol; `campaign-ledger.jsonl`'s filename, kinds, and every wire event/field unchanged. Old builds
read new ledgers (extra `data.outboxOffset` ignored); new build reads old ledgers (legacy fallback).

## Components

- `src/commands/autoresearch.ts` — intent offset stamp + pass-2 slice + fencing gate + ledger-throw
  wrap.
- `src/core/autoresearchLedger.ts` — `intentOffset` on `LedgerIntent`.
- `commands/autoresearch.md` — only if the fencing changes what the directive must do (it should NOT,
  thanks to the grandfather clause; add one note that a resumed campaign requires `--gen`).
- `tests/` — see Testing. Version 0.5.28 → 0.5.29 (three manifests) + rebuilt committed dist.

## Testing

- **A red-green** (crash-matrix, the gap the existing suite missed): exp-001 dispatched+delivered
  +completed (done in outbox, result.json present), then exp-002 dispatch-intent only (crash before
  inbox). Resume → `REDISPATCH=<agent>:exp-002`, lane left idle/failed (not working), no fabricated
  dispatch-delivered. The error variant (exp-001 errored) → no phantom failed exp-002. Must fail
  against unmodified code. Legacy fallback: a pre-fix ledger (intent without outboxOffset) with a
  prior delivery → re-dispatches the same exp_id, does not strand.
- **B red-green**: ledger at gen 2 + `experiment-send` with NO `--gen` → rc 3, inboxWrite spy not
  called, no dispatch-intent appended. Grandfather: ledger at gen 1 + no `--gen` → still rc 0
  (dispatched). Existing tests/autoresearch-cmd.test.ts:397 (stale --gen → rc 3) and :417 (no-ledger)
  stay green (only that one test seeds gen≥2 and it passes --gen). The ledger-throw wrap → rc 3 not
  rc 1 for a gen bumped inside the window.
- Existing resume crash-matrix tests stay green (none has a prior delivered event for the agent).
- **Pins that must BITE** (each verified by mutation, not by dist-freshness): a recreated outbox
  with an intent offset past EOF still accepts its own ack (drop the shrink guard → that test
  fails); an intent offset of 0 alongside a NON-zero prior delivery still accepts (`??` → `||` →
  that test fails); a ledger that cannot be read/written throws as itself instead of rc 3 (widen
  the catch → that test fails). Both rc-3 refusals assert their exact stderr wording.
- Full gate green; dist rebuilt+committed.

## Success Criteria

- A crash between dispatch-intent and inbox for exp-N (N≥2) resumes by RE-DISPATCHING exp-N, never
  by attributing exp-(N-1)'s completion; the campaign record gains no phantom experiment.
- `experiment-send` without `--gen` on a resumed (gen>1) campaign refuses rc 3; gen-1 and pre-ledger
  campaigns are byte-identical to today.
- The refuted check-then-act race is left alone (no CAS/lock added).
- Gate green; 0.5.29.

## Known residuals (recorded, deliberately NOT closed here)

- **The tail is LEFT-bounded only.** An intent orphaned by a LATER successful dispatch to the same
  lane still absorbs the successor's `ack`. This is main-identical (the fix moves the left bound,
  it does not add a right one); closing it needs exp-id keying that the frozen wire protocol does
  not guarantee on `ack`/`done`.
- **A pre-fix ledger's unattributable intent on a `working` lane is left unresolved.** The `-1`
  sentinel skips the scan and the existing `phase !== "working"` guard then declines to
  re-dispatch, so the ledger keeps a permanently-open intent. Fail-safe by construction (nothing is
  fabricated, nothing double-dispatches) and self-clearing on the next legitimate dispatch.
- **The fence is dispatch-only.** `score`'s best-effort ledger tail and the other non-dispatch
  writers still append under the live generation with no `--gen` claim, so the ledger cannot fully
  expose a split brain — a superseded hub's non-dispatch writes are still adopted. Making every
  writer carry a generation claim is a broader follow-up with its own spec.
