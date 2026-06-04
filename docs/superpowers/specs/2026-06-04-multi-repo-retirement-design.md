# Multi-Repo Retirement — Design

**Date:** 2026-06-04
**Status:** approved (brainstorming)
**Scope of this PR:** code only (`src/` + `tests/` + rebuilt `dist/` + version bump). Documentation
updates (shipped command-doc prose, `MIGRATION.md`, the `CLAUDE.md` phase-guard narrative) are a
deliberate **follow-up PR**, not part of this work.

## Why

consort carries a whole "operate across sibling sub-repos" capability — ported faithfully from
clone-wars' `consult`/`deploy`. It exists to serve a workspace where sibling directories each carry a
`CLAUDE.md`/`AGENTS.md` marker (the `/home/liupan/CC` shape): `score` detects those sub-projects and
emits a multi-target design doc with a `**Target Sub-Project(s):**` header + an `## Execution DAG`;
`perform` hub-and-spoke routes implementation into each sub-repo.

We will **no longer work in a multi-sub-repos environment**. With no sibling markers the feature does
not break — it self-degrades to single mode (`detectMultiRepo` finds nothing → `score` always
`mode=single` → `perform` always routes single) — so the entire multi-repo path goes cold and becomes
dead weight. This spec retires it.

This is a **port-parity divergence**: the multi-repo feature was part of the faithful clone-wars port,
so dropping it intentionally diverges from clone-wars. That divergence is the reason this spec exists
(per the CLAUDE.md phase guard).

## Goal

Make consort **single-repo-only** by hard-removing every multi-sub-repo-exclusive unit and collapsing
every shared seam to its single-repo behavior — preserving single-repo behavior **byte-identically**.

## Architecture / approach

**Leaf-to-root, green at every step.** Remove in dependency order so the build and test suite stay
green at each checkpoint:

1. Delete the fully-exclusive **leaf verbs + their dedicated test files** (nothing single-repo imports
   them).
2. Collapse the **shared seams** to single-repo behavior (`resolveTarget`→cwd, `iterTargets`→one row,
   `assembleDoc`→header-less single, `auditDoc` drops 2 rules, `--targets` gone, scope-check
   single-only, drilldown drops `<subproject>`).
3. Delete the now-**orphaned modules** (`multirepo.ts`, `dag.ts`, `performSibling.ts`, `extractTarget`,
   `parseMultiRepoMode`, `writeTargetsTsv`, `parseRosterTargets`) once nothing imports them.
4. **Trim the interleaved test files** to drop only their multi-repo cases (single-repo assertions
   preserved byte-identically).
5. Rebuild `dist/consort.cjs`, bump the 3 manifests `0.1.22 → 0.1.23`.

Rejected alternatives: *seam-first* (force routing/mode to single then bulk-delete — fewer green
checkpoints, a mid-sweep switch-case can reference a deleted verb); *big-bang per-file rewrite*
(fastest to write, hardest to prove byte-identical).

## The critical disambiguation (do not conflate)

The word "target" names two unrelated things. Only #1 is retired.

1. **SUB-REPO targets (RETIRE):** the `--targets` CLI flag, `detectMultiRepo`/`validateTargets`/
   `RepoHit`, `targets.txt`, the `**Target Sub-Project(s):**` header, `## Execution DAG`, Cross-Repo
   Notes, `DocMode` `multi`/`single-sub`, `SECTIONS_MULTI`, `parts.txt`, `perform`'s `resolveTarget`
   header branches + hub/spoke routing + the sibling guard.
2. **INSTRUMENT targets (KEEP):** the ensemble cross-verification where multiple **model** instruments
   (viola/cello/harp) check each other — `verifyScopeFiles(target, instruments)`, `parseRosterFile`,
   `roster.txt`, `formatRosterFile`, `spawnRosterArg`, `cascadeTargets`/`ResetPhase`, the
   `--ensemble` escalation flag, the research/verify/adjudicate flow. **Zero coupling to multi-repo.**

## Scope — what gets DELETED (whole units)

**Source modules (whole-file delete):**
- `src/core/multirepo.ts` — `RepoHit`, `TargetValidation`, `resolveMarker`, `validateTargets`,
  `detectMultiRepo`. Only importers: `src/commands/score.ts` + `tests/multirepo.test.ts`. (It imports
  `SLUG_REGEX` from `audit.ts`; that import dies with the file but **`SLUG_REGEX` itself stays** — see
  micro-decisions.)
- `src/core/dag.ts` — the entire `## Execution DAG` machinery (`parseDagLine`, `dagSectionBody`,
  `checkDagSection`, `dagMalformedLines`, `emitSoftDag`, `dagTopological`, `dagUniqueRepos`,
  `dagFanInRepos`, `SoftDagRow`, `DagNode`). Importers (`perform.ts`, `score.ts`, `audit.ts`) all use
  it only for multi-repo; deletable once those uses are gone.
- `src/core/performSibling.ts` — `enumerateSiblings`, `captureSiblingBaseline`, `formatBaselineFile`,
  `parseBaselineFile`, `diffSiblingAgainstBaseline`, `revertAndReplay` (the hub/spoke rogue-sibling
  guard). Wrapped only by the three `sibling-*` verbs.

**`src/commands/perform.ts` verbs (delete the run/with fns, their Deps/live-Deps, the `run()` switch
cases, and the `usage()` tokens):**
- `detectRouting` helper (inline `routing="single"`)
- `dag-parse` (`dagParseRun`/`dagParseWith` + `DagParseDeps` + `liveDagParseDeps`)
- `multi-init` (`multiInitRun`/`multiInitWith` + `MultiInitDeps` + `liveMultiInitDeps`)
- `send-unit` (`sendUnitRun`/`sendUnitWith` + `SendUnitDeps` + `liveSendUnitDeps`)
- `drop-part` (`dropPartRun`)
- `verify-dag-repos` (`verifyDagReposRun` + `hasRepoMarker`)
- `wave-wait` (`waveWaitRun`/`waveWaitWith` + `PERFORM_WAVE_TIMEOUT`)
- `cross-signal` (`crossSignalRun`/`crossSignalWith` + `CrossSignalDeps` + `liveCrossSignalDeps`)
- `sibling-baseline`/`sibling-verify`/`sibling-rescue` (`sibling*Run`/`With` + `SiblingDeps` +
  `liveSiblingDeps`)
- now-dead imports: `composeDagUnitPrompt`, the `dag.ts` imports, the `performSibling` imports,
  `PerformResolveError` (after the resolveTarget collapse)

**`src/core/performTurn.ts`:** `composeDagUnitPrompt` (per-sub-repo DAG unit prompt). Called only by
`sendUnitWith`.

**`src/commands/score.ts` verbs + `src/core/score.ts` helpers:**
- `detect-multi-repo` (`detectMultiRepoRun`)
- `emit-dag` + `check-dag` (`emitDagRun`/`checkDagRun`)
- `parseMultiRepoMode`, `writeTargetsTsv`, `parseRosterTargets` (core)

**`src/core/scoreDoc.ts`:** `SECTIONS_MULTI`; the `assembleDoc` `mode==="multi"` block (Date + plural
header); the `TITLES` entries `execution-dag`/`cross-repo-notes`; `AssembleInput.targets`/`date`.

**`src/core/audit.ts`:** `TARGET_HEADER`, `extractTarget`, `TargetResult`; the
`target_subproject_when_invalid` and `execution_dag_not_parseable` pushes in `auditDoc`; the
`import { checkDagSection } from "./dag.js"`.

**`src/core/scoreWalk.ts`:** the `auditIssueToSection` cases `target_subproject_when_invalid → "header"`
and `execution_dag_not_parseable → "execution-dag"`.

**Whole test files to delete:** `tests/multirepo.test.ts`, `tests/dag.test.ts`,
`tests/dag-executor.test.ts`, `tests/perform-dag-parse.test.ts`, `tests/perform-multi-init.test.ts`,
`tests/perform-cross-signal.test.ts`, `tests/perform-wave-wait.test.ts`,
`tests/perform-drop-part.test.ts`, `tests/perform-verify-dag-repos.test.ts`,
`tests/perform-sibling.test.ts`, `tests/perform-sibling-verbs.test.ts`.

## Scope — what gets COLLAPSED (shared seams → single-repo, byte-identical)

- **`src/core/perform.ts` `resolveTarget` → deleted; inline `targetCwd = d.repoRoot()` at the
  `perform init` call site.** No design doc carries a `**Target Sub-Project:**` header anymore, so the
  only reachable branch was the no-header `return cwd`, and `cwd` there is `d.repoRoot()`. Inlining is
  byte-identical — the call site still writes `target_cwd.txt = repoRoot + "\n"`. Delete the whole
  `resolveTarget` function (the slug/`.git`/hub-self/throw branches and the `extractTarget` call go with
  it).
- **`PerformResolveError`** + the `try/catch` around the (now-deleted) `resolveTarget` call in
  `initWith`: delete the class, its import, and the `try/catch` — `targetCwd = d.repoRoot()` cannot
  throw.
- **`iterTargets` → single `{slug:"main", cwd}` row.** Drop the `parts.txt` precedence branch; keep the
  `target_cwd.txt` branch and the empty fallback. All ~9 per-target loop call-sites (pre-snapshot,
  branch, scope-check, summary, finish, finish-one, …) keep iterating exactly once. **Do not delete
  `iterTargets`.**
- **`initWith` routing** (`src/commands/perform.ts`): force `routing="single"` (drop the
  `parsed.targets` ternary + `detectRouting`); keep `ROUTING=single` in stdout.
- **`scopeCheckWith`:** delete the `if (existsSync(partsFile))` multi block; keep the single-repo `else`
  branch (`target_cwd.txt` + `branch-base.sha`) byte-identical.
- **`src/core/scoreDoc.ts` `assembleDoc` → always header-less + `SECTIONS_SINGLE`.** Remove the
  `mode`/`targets`/`date` params and the multi branch. `single` and `single-sub` already produced
  identical bytes, so single-repo output is preserved exactly. **Delete the `DocMode` type** and the
  `AssembleInput.targets`/`date` fields; `assembleDoc` takes just `{ title, drafts }`.
- **`src/commands/score.ts` `assembleRun`:** hardcode `mode="single"`, `keys=SECTIONS_SINGLE`,
  `targets=[]`; drop the `multi-repo.txt`/`targets.txt` reads. Draft loop, audit, atomicWrite, stdout
  path stay byte-identical.
- **`src/commands/score.ts` `initWith`:** drop the `validateTargets` dep + the `if (targets.length>0)`
  block + `targetHits` + the `mode` computation + the `targets.txt` write. Keep writing `multi-repo.txt`
  as the constant `"single\n"` (compat shim) and keep `MODE=single` in the stdout KV block (the
  `score.md` directive parses both).
- **`parseScoreArgs` / `parsePerformArgs`:** drop the `--targets` branch + the `targets` field; keep
  `--ensemble` and topic derivation byte-identical.
- **`drilldownWith` (`src/commands/score.ts`) + `resolveDrilldownPath` (`src/core/score.ts`):** drop the
  optional `<subproject>` positional (the `n===8`/`n===10` arity handling) and the
  `${subproject ? "-"+subproject : ""}` filename infix. Drilldown collapses to fixed arg counts.
- **`auditDoc` (`src/core/audit.ts`):** keep the 8 single-repo rule pushes **in order**; delete the
  trailing `extractTarget` call + the 2 multi rules. Verdict logic unchanged. (Issue order is asserted
  by `audit.test.ts`; deleting at the tail leaves the leading rules untouched.)
- **`auditIssueToSection` (`src/core/scoreWalk.ts`):** delete only the 2 multi cases; keep all
  single-repo cases + the `default: return ""`.

## Scope — what explicitly STAYS

`verifyScopeFiles` / `parseRosterFile` / `roster.txt` / `formatRosterFile` / `spawnRosterArg`
(instrument ensemble); `cascadeTargets` / `ResetPhase` / `offsetResetRun` (ensemble offset-reset
cascade — `*Targets` is a misnomer, not sub-repo); `--ensemble`; `synthesizeSeeds` / `SEED_SPECS`;
`detectProvider`; `pickInstruments`; the general helpers `runnerAt`/`kvFileField`/`isDir`; the
single-repo fix-loop (`performState`, `composeRound1Prompt`, `composeFixPrompt`, `blockers`,
`BRANCH_DISCIPLINE`, `turnSendWith`, `turnWaitWith`, `resetStatusRun`, `latestObjections`); `exportDocTo`
/ `scoreExportDocPath` / `exportDocRun`; and the state files `target_cwd.txt`, `perform-branches.tsv`,
`baselines/*.tsv` (degenerate to the single `main` row).

## State-file fates

| File | Fate |
|---|---|
| `targets.txt` | **Dead** — never written (no `--targets`), never read. Remove writer + reader. |
| `parts.txt` | **Dead** — written only by `multi-init`/`drop-part` (deleted); `iterTargets` drops its reader branch. |
| `dag-waves.txt` / `dag-edges.txt` / `dag-rows.tsv` / `.draft/execution-dag.md` | **Dead** — DAG artifacts. |
| `sibling-baseline.txt` / `sibling-rogue.txt` / `sibling-rescue.txt` | **Dead** — sibling-guard family. |
| `multi-repo.txt` | **Compat shim** — keep writing a constant `"single\n"` in both `score init` and `perform init`; drop only the *reader* (`parseMultiRepoMode`). Lets the not-yet-updated shipped directives still read a valid value until the docs follow-up. |
| `target_cwd.txt` | **STAYS** — single-repo backbone; always `repoRoot + "\n"`. Read by `iterTargets`, scope-check, turn/test-detection, solo. |
| `perform-branches.tsv` / `baselines/*.tsv` | **STAY** — degenerate to a single `main` row; single-repo finish/branch/summary still read them. |

## Resolved micro-decisions

1. **`multi-repo.txt`:** keep writing constant `"single\n"` (compat shim); drop only the reader.
2. **`SLUG_REGEX`** (`audit.ts`): **keep** the public export + its direct `audit.test.ts` assertion —
   generic slug validator, zero churn, becomes an unused-but-public export.
3. **`resolveHub`:** **delete** — pure vestige (only `perform.test.ts` referenced it).
4. **`finish-one` verb:** **keep** — operates harmlessly on the lone `main` row.

## Interim caveat + hard acceptance criterion

Because docs are a follow-up, the shipped `score.md`/`perform.md` directives' **multi-repo branches**
will reference verbs/flags that no longer exist; those branches would error *only if a multi-repo flow
reached them*. Single-repo flows must be unaffected.

**Acceptance criterion (hard):** verify that **no removed verb or flag sits on the unconditional
single-repo directive path** in `commands/score.md`, `commands/perform.md`, `commands/solo.md`. If one
does, keep it as a thin single-repo stub (returning the single-repo result) rather than break
single-repo flows before the docs PR. (The directive `.md` prose is otherwise out of scope for this PR.)

## Tests adjusted (drop multi cases only; preserve single-repo assertions byte-identical)

`tests/perform.test.ts` (delete the `resolveTarget` describe and the `resolveHub` describe — both
functions are gone; drop the `--targets` parse cases + the `iterTargets` `parts.txt` cases; keep the
single `main` row + `neither→[]` iterTargets cases), `tests/perform-init.test.ts` (drop `MULTI_DOC` + the multi-routing case; keep single,
update the `multi-repo.txt` assertion to constant `single`), `tests/perform-scope-check.test.ts` (drop
the multi-repo describe), `tests/perform-finish.test.ts` (reseed via `target_cwd.txt` single row, not
`parts.txt`), `tests/perform-turn.test.ts` (drop the `composeDagUnitPrompt` describe; keep
fix-loop tests), `tests/perform-cmd.test.ts` (keep — verify no `parts.txt`-only assertions remain),
`tests/audit.test.ts` (drop `extractTarget` describe + the target/dag cases; keep `SLUG_REGEX`
assertion + single-repo cases), `tests/score-doc.test.ts` (drop `SECTIONS_MULTI`,
`sectionTitle('execution-dag')`, the `single-sub` + `multi` assemble cases; keep `SECTIONS_SINGLE`,
single header-less, `synthesizeSeeds`), `tests/score-core.test.ts` (drop `--targets`,
`parseMultiRepoMode`, `writeTargetsTsv`; keep roster/instrument + drilldown-collision cases),
`tests/score-init.test.ts` (drop the 2 `--targets` cases + the `validateTargets` stub),
`tests/score-assemble.test.ts` (drop/adjust the `multi-repo.txt` seed to match the compat-shim
constant), `tests/score-escalation.test.ts` (drop the `detect-multi-repo` describe, the `emit-dag`/
`check-dag` cases, the drilldown `<subproject>` cases), `tests/score-walk.test.ts` (drop the 2 multi
mapping assertions), `tests/args.test.ts` (drop the `--targets` value-flag cases; keep the unrelated
multi-LINE `$ARGUMENTS` cases).

## Release

Rebuild `dist/consort.cjs` (deterministic — verify a second build is byte-identical) and bump
`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` `0.1.22 → 0.1.23`. The
release rides this PR (publish-after-every-change pattern). **Do not weaken
`tests/stale-tokens.test.ts`** (it scans for clone-wars terms, unaffected by this removal).

## Out of scope (deferred follow-up PR)

Command-doc prose (`commands/score.md`, `perform.md`, `solo.md` multi-repo phases + the
`[--targets a,b,c]` argument hints), `MIGRATION.md`'s multi-repo architecture sections, the `CLAUDE.md`
phase-guard "Fully ported" narrative (record the intentional divergence), and the dated historical
plan/spec docs.

## Acceptance criteria

1. `npm run typecheck` clean; `npm run lint` clean.
2. `npm run test` green — multi-repo tests removed, every retained single-repo assertion unchanged.
3. `tests/stale-tokens.test.ts` passes unmodified.
4. No removed verb/flag on the unconditional single-repo directive path (the hard criterion above).
5. `multirepo.ts`, `dag.ts`, `performSibling.ts` gone; no dangling imports; build clean.
6. `dist/consort.cjs` rebuilt + deterministic; 3 manifests at `0.1.23`.
7. Single-repo `score`/`perform`/`solo` flows behave byte-identically (assemble output, audit verdicts,
   `target_cwd.txt`, routing stdout all unchanged for single-repo inputs).
