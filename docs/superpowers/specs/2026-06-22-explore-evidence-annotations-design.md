# Explore Evidence-Weakness Annotations — Design

**Date:** 2026-06-22
**Status:** approved (brainstorming)
**Scope of this PR:** code only (`src/core/exploreAnnotate.ts` NEW, `src/core/exploreConfidence.ts`
additive helper, `src/commands/explore.ts` new `annotate` verb, `commands/explore.md` new Phase 5b
prose, `tests/`, rebuilt `dist/ap.cjs`, version bump). No wire-protocol change; `contracts.yaml`
untouched.

## Why

`/ap:explore` runs one research pass, then a 5-signal confidence gate
(`src/core/exploreConfidence.ts`) fires once to decide whether the adversary round runs. A
`/ap:explore` survey of "how to improve our explore command" (archived under
`~/.ap/archive/.../let-s-research-on-lo/_explore-20260622T123507Z/`, see `design-handoff.md`)
recommended a **bounded, CONTESTED-preserving validator** on the gate's *mechanical* gaps — explicitly
not promoting the gate into a loop predicate, because its S3 term is "no CONTESTED markers" and looping
to satisfy it optimizes toward **erasing disagreement**.

This is **new behavior beyond the faithful port**, so per the CLAUDE.md phase guard it gets its own
spec. Two rounds of adversarial scrutiny reshaped the original "mechanical-retry loop" idea:

1. A four-lens design review proved a worker re-dispatch round **cannot** flip S2 (the gate counts
   citations only against `findings-*.md`, `explore.ts:253`, so a post-hoc source is a new
   uncorroborated token) and carried four of five blockers. The worker round was cut.
2. Verifying the remaining "Hub self-repair flips S2/S4" premise against the gate's own tests
   (`tests/explore-confidence.test.ts`) showed the gate signals do not flip the way "fix the citation
   gaps" suggests:
   - **S4** passes only if a Reason cell's first non-space char is `/` or `:` (the all-hold fixture's
     cell is `/papers see https://…`; the test asserts a normal `| Priority | Best fit | Reason |`
     header row is *bad*). A cell leading with a URL or prose is S4-bad, so S4 "flips" only by
     reordering a rare **absolute-path** citation to the front.
   - **S2** counts a citation token across findings; annotating after it does not remove it, so S2
     "flips" only by **dropping** a real one-worker citation.

   Making the gate pass therefore means **removing evidence** (S2) or rare path-reordering (S4) — the
   opposite of the research's *surface uncertainty, do not hide it* north star.

So Phase 5b is reframed from "repair the gate" to a **transparency overlay**: it annotates
evidence-weakness into the draft so it is **visible in the final landscape doc** and to a downstream
`/ap:design` reader, while leaving the gate and the adversary phase **exactly as they are**. It does
not reduce how often the adversary runs; it makes the output more honest.

## Goal

Insert a **Phase 5b annotation pass** between `synth-preliminary` (Phase 5) and `confidence`
(Phase 5.5). It marks two genuine evidence-weakness conditions, derived from the same data the gate
uses, as inline `[unverified]` / `[no citation]` notes in `landscape-draft.md`. Its defining property:

> **The annotation pass leaves all five gate signals byte-identical to the un-annotated draft.**

Because the gate is blind to the annotations, Phase 5.5 runs once on the annotated draft and produces
the same result it would have on the raw draft — no re-gate, no loop, no cap, nothing to oscillate.

## Non-goals (YAGNI)

- **No gate-flipping.** The pass never drops a citation, never reorders matrix cells, never changes
  S1–S5. Removing one-worker evidence to satisfy S2 is explicitly rejected as anti-transparency.
- **No worker re-dispatch, no tmux, no IPC, no re-gate, no cap/once-guard.** A single deterministic
  Hub pass that does not change signals needs none of these.
- **No A5 cross-run memory, no over-reached-citation semantic lint** (unjudgeable by regex — stays the
  adversary's job), **no A8/A4**.
- **No change to `computeSignals` semantics.** Existing gate behavior and tests stay byte-identical;
  the one `exploreConfidence` change is extracting a reusable `soloCitations` helper that
  `computeSignals` then calls (single source of truth, no second copy).

## Architecture / approach

### The two annotation rules

Both are derived from the gate's own inputs (`draftCitations` + the per-finding corroboration count)
but target the **reader's** evidence-weakness signal, not the gate's exact pass/fail:

1. **Single-source citation → `[unverified]`.** A draft citation token corroborated by `< 2` findings
   files (the S2 condition, `exploreConfidence.ts:53-59`) is a one-worker claim. Append ` [unverified]`
   after each occurrence **outside `## Approaches`** (see the invariant below for why Approaches lines
   are skipped). Idempotent: skip an occurrence already followed by ` [unverified]`.
2. **Uncited tradeoff row → `[no citation]`.** A `## Tradeoff matrix` Reason (3rd) cell that contains
   **no** citation token at all (not the S4 lead-char quirk — genuine absence) gets ` [no citation]`
   appended inside the cell, before the trailing `|`. A cell that contains a citation anywhere (even
   trailing, even though S4's lead-char heuristic still flags it) is **not** annotated — it is anchored
   for the reader; the lead-char rule is a gate quirk, not a real gap. Idempotent: skip a cell already
   carrying ` [no citation]`.

### The all-five-signals invariant (the safety guarantee)

The annotations are constructed so `computeSignals(annotatedDraft, findings)` deep-equals
`computeSignals(draft, findings)`. Why each signal is unchanged:

| Signal | Reads | Why annotation can't move it |
|---|---|---|
| S1 | `## Approaches` lines via `topApproach()` | Rule 1 **never edits Approaches lines**, so `topApproach()` is byte-identical. |
| S2 | every `draftCitations` token's findings-count | ` [unverified]` / ` [no citation]` contain no `.`-ext or `http` → **not extracted** as citations; the original token still present and still in `< 2` findings → count unchanged. |
| S3 | `/CONTESTED/i` on the draft | The markers are `[unverified]` / `[no citation]` — **never the literal CONTESTED**. |
| S4 | each matrix Reason cell's **first** non-space char | Rule 2 appends **at the end** of the cell (the row stays a valid `^\| … \|$` with the same leading char) → row bad/good status unchanged. |
| S5 | `findings` only | No annotation mutates any `findings-*.md`. |

The invariant is enforced by edit construction **and** asserted by a test (below). Skipping
Approaches-line single-source citations is a documented limitation: a single-source *top approach* is
flagged in `annotations.json` (for `/ap:review`) but not inlined, because inlining there would perturb
S1. This is the deliberate price of the invariant.

### Flow

```
Phase 5   synth-preliminary  → Hub writes landscape-draft.md                       (unchanged)
Phase 5b  annotate (NEW):
   `explore annotate <topic>`:
     - if $ART/annotate-applied.txt exists → no-op, exit 0           (idempotent / crash-safe)
     - else: read landscape-draft.md + findings-*.md; build annotations; atomic-write the
       annotated landscape-draft.md + annotations.json (counts, for forensics) + annotate-applied.txt;
       print a one-line summary.
Phase 5.5 confidence            → runs on the annotated draft; same 5 signals as raw   (unchanged)
Phase 6+  adversary / Phase 8 synth-final / Phase 9 teardown                          (unchanged)
```

`synth-final` already authors the final doc from the draft, so the `[unverified]` / `[no citation]`
markers flow into the published landscape doc naturally.

## Components

- **`src/core/exploreAnnotate.ts` (NEW, pure — no I/O, no panes):**
  - `uncitedMatrixReasons(draft: string): { reason: string; lineIndex: number }[]` — Reason cells with
    no citation token (uses `draftCitations`' regex scoped to the cell).
  - `buildAnnotations(draft: string, findings: string[]): { annotatedDraft: string; plan: AnnotationPlan }`
    — applies rules 1 and 2 deterministically and idempotently; returns the annotated draft plus a
    typed `AnnotationPlan` (`{ kind: "unverified" | "no-citation" | "approaches-flagged"; token?: string; lineIndex: number }[]`).
- **`src/core/exploreConfidence.ts` (additive):** extract
  `soloCitations(draft: string, findings: string[]): string[]` (the existing S2 inner loop) and have
  `computeSignals` call it — single definition shared with `exploreAnnotate`, so the two can never
  diverge on what "single-source" means. `computeSignals`' observable behavior is unchanged (the S2
  test proves it).
- **`src/commands/explore.ts` (CHANGED):** add the `annotate` subcommand — validator-style: rc 1 if
  `landscape-draft.md` or any `findings-*.md` is missing (mirrors `synth-preliminary`); honors the
  `annotate-applied.txt` no-op guard; calls pure `buildAnnotations`; atomic-writes the annotated draft
  + `annotations.json` + marker; prints the summary. The deterministic text edits live in the pure
  function; the verb is the thin impure executor (atomic writes only).
- **`commands/explore.md` (CHANGED):** insert Phase 5b prose (run `annotate`, then `confidence`,
  then proceed); state plainly that it is annotation-only, changes no gate signal, and that the markers
  are expected to appear in the final doc.
- **Forensics:** `annotations.json` counts (n_unverified, n_no_citation, n_approaches_flagged) are
  recorded so `/ap:review` can trend evidence-weakness over time.

## Data flow

```
landscape-draft.md + findings-*.md
  → annotate verb
       buildAnnotations(draft, findings) → { annotatedDraft, plan }   [pure, idempotent]
       atomic-write: landscape-draft.md (annotated), annotations.json, annotate-applied.txt
  → confidence verb (UNCHANGED) over the annotated draft → same 5 signals as the raw draft
  → existing Phase 5.5 branch (offer-skip | adversary)
```

## Error handling

- `annotate` rc 1 on missing `landscape-draft.md` / empty `findings-*.md` (surface the list, stop) —
  mirrors `synth-preliminary`.
- `annotate-applied.txt` present → no-op (idempotent across crash / compaction / resume).
- Atomic writes (tmp-in-same-dir + rename) for the annotated draft, `annotations.json`, and the marker.
- An empty annotation set (no single-source citations, no uncited rows) still writes the marker and
  leaves the draft byte-identical.

## Testing (pure, no tmux — per repo convention)

- `soloCitations`: returns exactly the `< 2`-findings tokens; `computeSignals` still passes its
  existing S2 fixture after the refactor (no behavior drift).
- `uncitedMatrixReasons`: flags only Reason cells with zero citation tokens; ignores cells with a
  trailing or leading citation; empty for a citation-rich matrix.
- `buildAnnotations`: single-source citation outside Approaches → ` [unverified]` appended; the same
  token on an Approaches line → not inlined, recorded as `approaches-flagged`; uncited Reason cell →
  ` [no citation]` inside the cell; citation-rich draft → no edits.
- **Invariant test (the headline guarantee):** for adversarial drafts (CONTESTED-saturated,
  low-convergence, single-source citation on the top-approach line, uncited matrix rows),
  `computeSignals(buildAnnotations(draft, findings).annotatedDraft, findings)` **deep-equals**
  `computeSignals(draft, findings)` — all five signals identical.
- **Idempotency test:** `buildAnnotations(annotatedDraft, findings).annotatedDraft === annotatedDraft`.
- Verb-level: rc 1 on missing inputs; `annotate-applied.txt` second-call no-op; atomic artifacts
  written; `annotations.json` counts match the plan.

## Acceptance

1. On a draft with single-source citations and uncited tradeoff rows, Phase 5b annotates them, the
   annotations appear in the final landscape doc, and `confidence` reports the **same** five signals it
   would have on the un-annotated draft.
2. The invariant and idempotency tests pass.
3. `npm run typecheck && npm run test && npm run lint && npm run build` green; `dist/ap.cjs` rebuilt
   and committed; existing `explore-confidence` tests unchanged. Version bumped (3-way manifest sync).
