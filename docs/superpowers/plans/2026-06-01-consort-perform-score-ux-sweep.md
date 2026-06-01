# consort perform/score UX sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up perform's pane label (drop the `cody` placeholder, collapse to `tutti:codex:topic`), give score+perform a visible TodoWrite progress list, and have score export its design doc to `docs/superpowers/specs/` and report it clearly.

**Architecture:** Three independent fixes. (1) A label-collapse rule in the shared `colors.ts` plus a `cody→tutti` rename confined to perform-single. (2) Prompt-only additions to two command markdown files. (3) A pure path helper + an IO helper in `core/score.ts`, a new `score export-doc` verb, and command-doc wiring. Each task ends green and committed; `dist/consort.cjs` is rebuilt last.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffixes), vitest, esbuild → committed `dist/consort.cjs`, execa for tmux.

---

> **STALE-TOKEN LANDMINE (read before editing any `commands/*.md`, `src/`, or `config/`):** the
> `tests/stale-tokens.test.ts` gate scans those trees **including comments and prose** and fails the
> build if it finds `clone-wars`, `cw_`, `@cw_`, `master-yoda`, `MISSION ACCOMPLISHED`
> (case-sensitive) or `trooper` / `commander` (case-insensitive). None of the edits below introduce
> those tokens — but when adding the Progress-tracking prose, do **not** reach for predecessor
> terminology. Use "the predecessor plugin" if you must reference it. `cody`, `tutti`, `TodoWrite`,
> `export-doc` are all clean.

> **Note on `cody` in OTHER test files:** `tests/score-diff.test.ts`, `tests/score-adjudicate.test.ts`,
> `tests/solo-forensics.test.ts`, `tests/forensics-run.test.ts` use `cody` as a generic fixture
> instrument name unrelated to perform-single. **Do NOT touch them.** `cody` is not a banned token.

---

## Task 1: Label collapse for non-orchestral instruments (`colors.ts`)

**Files:**
- Modify: `src/core/colors.ts:54-61` (`labelFor`, `labelFmt`; add `isOrchestral` helper near `entry`)
- Test: `tests/colors.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these `it(...)` blocks inside the `describe("colors", ...)` in `tests/colors.test.ts` (after the existing `labelFmt` test at line 24):

```ts
  it("labelFor collapses the instrument segment for non-orchestral (fallback) names", () => {
    expect(C.labelFor("tutti", "codex", "design-x")).toBe("tutti:codex:design-x");
    expect(C.labelFor("cody", "codex", "design-x")).toBe("tutti:codex:design-x");
  });
  it("labelFmt collapses the instrument segment for non-orchestral names", () => {
    expect(C.labelFmt("tutti", "codex", "demo")).toBe(
      "#[fg=white,bold]tutti#[default]:#[fg=default,bold]codex#[default]:demo",
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/colors.test.ts`
Expected: the two new tests FAIL (current output is `tutti-tutti:codex:design-x` / `tutti-cody:...` and the `labelFmt` includes `tutti-tutti`).

- [ ] **Step 3: Implement the collapse rule**

In `src/core/colors.ts`, add the `isOrchestral` helper right after `entry` (after line 49), and rewrite `labelFor`/`labelFmt`:

```ts
function entry(instrument: string): Entry { return PALETTE[instrument.toLowerCase()] ?? FALLBACK; }
function isOrchestral(instrument: string): boolean { return instrument.toLowerCase() in PALETTE; }

export function sectionFor(instrument: string): Section { return entry(instrument).section; }
export function colorFor(instrument: string): string { return entry(instrument).primary; }

export function labelFor(instrument: string, model: string, topic: string): string {
  const sec = sectionFor(instrument);
  const head = isOrchestral(instrument) ? `${sec}-${instrument}` : sec;
  return `${head}:${model}:${topic}`;
}

export function labelFmt(instrument: string, model: string, topic: string): string {
  const e = entry(instrument);
  const head = isOrchestral(instrument)
    ? `#[fg=${e.primary},bold]${e.section}-${instrument}#[default]`
    : `#[fg=${e.primary},bold]${e.section}#[default]`;
  return `${head}:#[fg=${e.secondary},bold]${model}#[default]:${topic}`;
}
```

(`sectionFor`/`colorFor` keep their existing one-line bodies — shown for placement context only.)

- [ ] **Step 4: Run the full suite to verify green (orchestral labels unchanged)**

Run: `npm test -- tests/colors.test.ts` then `npm test`
Expected: colors.test.ts all PASS (the existing `strings-violin:...` assertions at lines 19/23/31-33 still hold — orchestral instruments are unaffected); full suite stays green.

- [ ] **Step 5: Commit**

```bash
git add src/core/colors.ts tests/colors.test.ts
git commit -m "fix(colors): collapse pane label to <section>:<model>:<topic> for non-orchestral parts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rename the perform-single part `cody` → `tutti` (code + tests)

**Files:**
- Modify: `src/commands/perform.ts:35,38,182,185,188,195,210,215,223,228,229`
- Test: `tests/perform-turn-cmd.test.ts` (22 refs), `tests/perform-cmd.test.ts` (1 ref)

- [ ] **Step 1: Update the perform.ts part constant + centralize the filename literals**

In `src/commands/perform.ts` apply these exact edits:

- Line 35: `const PART = "cody";` → `const PART = "tutti";`
- Line 38 (comment): `/** model for the cody part = the resolved provider (codex|claude). Reads provider.txt; default codex. */`
  → `/** model for the tutti part = the resolved provider (codex|claude). Reads provider.txt; default codex. */`
- Line 182: `` const stateFile = join(art, `turn-cody-${round}.txt`); ``
  → `` const stateFile = join(art, `turn-${PART}-${round}.txt`); ``
- Line 185: `... — was cody spawned?\`); return 1; }`
  → `... — was ${PART} spawned?\`); return 1; }` (it is already a template literal; change `cody` → `${PART}`)
- Line 188: `` const promptFile = join(art, `cody_turn_prompt_${round}.md`); ``
  → `` const promptFile = join(art, `${PART}_turn_prompt_${round}.md`); ``
- Line 195: `` log.info(`[turn-send] cody round=${round} offset=${offset}`); return 0; ``
  → `` log.info(`[turn-send] ${PART} round=${round} offset=${offset}`); return 0; ``
- Line 210: `` const stateFile = join(art, `turn-cody-${round}.txt`); ``
  → `` const stateFile = join(art, `turn-${PART}-${round}.txt`); ``
- Line 215: `` log.info(`[turn-wait] cody round=${round} offset=${offset} timeout=${timeout}s`); ``
  → `` log.info(`[turn-wait] ${PART} round=${round} offset=${offset} timeout=${timeout}s`); ``
- Line 223: `` atomicWrite(join(art, `question-cody-${round}.txt`), payload); ``
  → `` atomicWrite(join(art, `question-${PART}-${round}.txt`), payload); ``
- Line 228: `` writeFileSync(join(art, `turn-cody-${round}.done`), ""); ``
  → `` writeFileSync(join(art, `turn-${PART}-${round}.done`), ""); ``
- Line 229: `` log.ok(`[turn-wait] cody round=${round} TS=${ts}`); return 0; ``
  → `` log.ok(`[turn-wait] ${PART} round=${round} TS=${ts}`); return 0; ``

- [ ] **Step 2: Verify no `cody` remains in perform.ts**

Run: `grep -n cody src/commands/perform.ts`
Expected: no output (exit 1).

- [ ] **Step 3: Update the perform tests to the new name**

Global-replace `cody` → `tutti` in both test files (every occurrence is the perform part — outbox keys, `turn-cody-1.txt`, `cody_turn_prompt_1.md`, `question-cody-1.txt`, the `cody-claude` comment, and the test titles):

```bash
sed -i 's/cody/tutti/g' tests/perform-turn-cmd.test.ts tests/perform-cmd.test.ts
grep -n cody tests/perform-turn-cmd.test.ts tests/perform-cmd.test.ts   # expect no output
```

- [ ] **Step 4: Run the perform suite + full suite**

Run: `npm test -- tests/perform-turn-cmd.test.ts tests/perform-cmd.test.ts` then `npm test`
Expected: both perform test files PASS asserting `turn-tutti-1.txt` / `tutti_turn_prompt_1.md` / `question-tutti-1.txt`; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/perform.ts tests/perform-turn-cmd.test.ts tests/perform-cmd.test.ts
git commit -m "fix(perform): rename single-repo part cody -> tutti (matches collapsed label)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: perform.md doc rename + TodoWrite progress list

**Files:**
- Modify: `commands/perform.md` (frontmatter line 4; body line 13 area; the 9 `cody` references)

- [ ] **Step 1: Rename `cody` → `tutti` in the doc**

```bash
sed -i 's/cody/tutti/g' commands/perform.md
grep -n cody commands/perform.md   # expect no output
```

This turns `$CS spawn cody ...` → `$CS spawn tutti ...`, `reset-status <TOPIC> cody` → `... tutti`,
`turn-cody-<ROUND>.txt` → `turn-tutti-<ROUND>.txt`, `question-cody-<ROUND>.txt` →
`question-tutti-<ROUND>.txt`, `cody_turn_prompt_<ROUND>.md` → `tutti_turn_prompt_<ROUND>.md`, and the
prose "The `cody` part" / "the `cody` instrument" → "tutti".

- [ ] **Step 2: Add `TodoWrite` to allowed-tools**

In `commands/perform.md` line 4, change:
`allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, Skill, mcp__codegraph`
→ `allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, Skill, TodoWrite, mcp__codegraph`

- [ ] **Step 3: Add the Progress tracking block**

Immediately after the `Let CS="node ${CLAUDE_PLUGIN_ROOT}/dist/consort.cjs"` line (line 13), insert a
blank line then this block:

```markdown
## Progress tracking

Maintain a **TodoWrite** list so the user can see where the run is. Seed it right after Stage 0
`init` succeeds, mark each item `in_progress` when you enter that stage and `completed` when you
leave it, and use **one rolling todo** for the dynamic phases (fix-rounds, DAG waves) rather than one
todo per round/wave.

- `ROUTING=single` → seed: `spawn part`, `build+verify loop`, `scope+finish`, `teardown+archive`.
- `ROUTING=multi` → seed: `preflight`, `wave dispatch (rolling)`, `cross-repo verify`, `fix loop`,
  `sibling+scope+finish`, `teardown+archive`.
```

- [ ] **Step 4: Verify the stale-token gate**

Run: `npm test -- tests/stale-tokens.test.ts`
Expected: PASS (7/7 or current count). Also `grep -n cody commands/perform.md` → no output.

- [ ] **Step 5: Commit**

```bash
git add commands/perform.md
git commit -m "fix(perform): doc rename cody -> tutti; add TodoWrite progress list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `score export-doc` verb + `scoreExportDocPath` helper

**Files:**
- Modify: `src/core/score.ts:1-7` (imports), add helpers at end of file
- Modify: `src/commands/score.ts:2` (fs import), `:35` (usage), `:40-58` (dispatch), add `exportDocRun`
- Test: `tests/score-core.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/score-core.test.ts`, add `scoreExportDocPath` and `exportDocTo` to the existing import from
`../src/core/score.js` (line 7), then add this `describe` block at the end of the file:

```ts
import { mkdtempSync } from "node:fs";   // already imported at top; ensure present
import { existsSync, readFileSync as rf } from "node:fs";

describe("score export-doc", () => {
  it("scoreExportDocPath composes <root>/docs/superpowers/specs/<basename>", () => {
    expect(scoreExportDocPath("/repo", "2026-06-01-x-design.md")).toBe(
      join("/repo", "docs", "superpowers", "specs", "2026-06-01-x-design.md"),
    );
  });

  it("exportDocTo copies the assembled doc into the specs dir and returns the dest", () => {
    const home = mkdtempSync(join(tmpdir(), "cs-home-"));
    const root = mkdtempSync(join(tmpdir(), "cs-root-"));
    process.env.CONSORT_HOME = home;
    const ddir = join(scoreArtDir("export-topic"), "design-doc");
    mkdirSync(ddir, { recursive: true });
    writeFileSync(join(ddir, "2026-06-01-export-topic-design.md"), "# DOC\nbody\n");

    const dest = exportDocTo("export-topic", root);
    expect(dest).toBe(join(root, "docs", "superpowers", "specs", "2026-06-01-export-topic-design.md"));
    expect(existsSync(dest!)).toBe(true);
    expect(rf(dest!, "utf8")).toBe("# DOC\nbody\n");
  });

  it("exportDocTo returns null when no assembled doc exists", () => {
    const home = mkdtempSync(join(tmpdir(), "cs-home-"));
    const root = mkdtempSync(join(tmpdir(), "cs-root-"));
    process.env.CONSORT_HOME = home;
    expect(exportDocTo("missing-topic", root)).toBeNull();
  });
});
```

(The top of `score-core.test.ts` already imports `join`, `mkdtempSync`, `mkdirSync`, `writeFileSync`,
`tmpdir`. Only add the missing `existsSync`/`readFileSync as rf` import if not present, and append
`scoreExportDocPath`, `exportDocTo` to the `../src/core/score.js` import list.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/score-core.test.ts`
Expected: FAIL with `scoreExportDocPath is not a function` / `exportDocTo is not a function`.

- [ ] **Step 3: Implement the helpers in `src/core/score.ts`**

Expand the `node:fs` import (line 3) and add the `atomicWrite` import (after line 4):

```ts
import { existsSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
```
```ts
import { atomicWrite } from "./atomic.js";
```

Append at the end of `src/core/score.ts`:

```ts
/** Canonical export location for a finished design doc: <repoRoot>/docs/superpowers/specs/<basename>. */
export function scoreExportDocPath(repoRoot: string, basename: string): string {
  return join(repoRoot, "docs", "superpowers", "specs", basename);
}

/** Copy the single assembled `*-<topic>-design.md` out of `_score/design-doc/` into
 *  `<destRoot>/docs/superpowers/specs/`. Returns the dest path, or null if no assembled doc exists
 *  (assemble must have run first). Overwrites on re-run (latest assembled doc wins). */
export function exportDocTo(topic: string, destRoot: string, opts?: { home?: string; cwd?: string }): string | null {
  const ddir = join(scoreArtDir(topic, opts), "design-doc");
  if (!existsSync(ddir)) return null;
  const hits = readdirSync(ddir).filter((f) => f.endsWith(`-${topic}-design.md`)).sort();
  if (hits.length === 0) return null;
  const basename = hits[hits.length - 1];
  const dest = scoreExportDocPath(destRoot, basename);
  mkdirSync(join(destRoot, "docs", "superpowers", "specs"), { recursive: true });
  atomicWrite(dest, readFileSync(join(ddir, basename), "utf8"));
  return dest;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/score-core.test.ts`
Expected: all three new tests PASS.

- [ ] **Step 5: Wire the verb into `src/commands/score.ts`**

a) Add `exportDocTo` to the `../core/score.js` import block (lines 8-14): append `exportDocTo,` to the
named imports. (`repoRoot` is already imported on line 19.)

b) Add the dispatch case after line 58 (`case "archive": ...`):

```ts
    case "export-doc": return exportDocRun(rest);
```

c) Extend the usage string on line 35 — insert `export-doc|` before `forensics`:
`...|drilldown|offset-reset|export-doc|forensics|archive> ...`

d) Add the verb implementation (place it just after `assembleRun`, after line 158):

```ts
function exportDocRun(rest: string[]): number {
  const topic = rest[0];
  if (!topic) { log.error("usage: score export-doc <topic>"); return 2; }
  const dest = exportDocTo(topic, repoRoot());
  if (dest === null) {
    log.error(`score export-doc: no assembled *-${topic}-design.md found (run score assemble first)`);
    return 1;
  }
  log.ok(`score export-doc: exported to ${dest}`);
  process.stdout.write(`EXPORTED=${dest}\n`);
  return 0;
}
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/core/score.ts src/commands/score.ts tests/score-core.test.ts
git commit -m "feat(score): add export-doc verb to copy the design doc into docs/superpowers/specs/

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: score.md TodoWrite progress list + export-doc wiring

**Files:**
- Modify: `commands/score.md` (frontmatter line 4; body line 13 area; Stage 2 ~line 78; Stage 12 ~line 283; Stage 16 ~line 350)

- [ ] **Step 1: Add `TodoWrite` to allowed-tools**

In `commands/score.md` line 4, change:
`allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, Skill`
→ `allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, Skill, TodoWrite`

- [ ] **Step 2: Add the Progress tracking block**

After the `Let CS="node ${CLAUDE_PLUGIN_ROOT}/dist/consort.cjs"` line (line 13), insert a blank line
then:

```markdown
## Progress tracking

Maintain a **TodoWrite** list so the user can see where the run is. Seed it after Stage 0 `init`
with a single `route` item; once Stage 1 decides the path, replace it with the path-appropriate
high-level stages, marking each `in_progress` on entry and `completed` on exit:

- **fast-path:** `draft sections`, `assemble+audit`, `export+present`.
- **escalation:** `spawn ensemble`, `research`, `diff`, `cross-verify`, `adjudicate`,
  `detect-multi-repo` (skip when `--targets` was passed), `design walk`, `assemble+audit`,
  `drilldown` (optional), `teardown+archive`, `export+present`.
```

- [ ] **Step 3: Wire `export-doc` into the fast-path (Stage 2)**

In Stage 2, the `rc 0` bullet (line 78-79) currently reads:

```markdown
- **rc 0** → it prints the design-doc path. **Read and present** the doc to the user, then point at
  the next step: `/consort:perform <path>` (once perform ships).
```

Replace it with:

```markdown
- **rc 0** → it prints the design-doc path. Run `EXPORTED=$($CS score export-doc <TOPIC> | sed -n
  's/^EXPORTED=//p')` to copy the doc into `docs/superpowers/specs/` (a non-zero `export-doc` is
  non-fatal — just skip the exported path). **Read and present** the doc to the user, state its
  location clearly — **`$EXPORTED` (docs/superpowers/specs/) as the primary, discoverable path**, with
  the `_score/design-doc/` path as the source — then point at the next step:
  `/consort:perform $EXPORTED`.
```

- [ ] **Step 4: Wire `export-doc` into the escalation assemble gate (Stage 12)**

In Stage 12, the `rc 0` bullet (line 283-284) currently reads:

```markdown
- **rc 0** → it prints the design-doc path. **Read and present** the doc, then point at
  `/consort:perform <path>` (once perform ships). Continue to Stage 13 (Phase F).
```

Replace it with:

```markdown
- **rc 0** → it prints the design-doc path. Immediately run `EXPORTED=$($CS score export-doc <TOPIC>
  | sed -n 's/^EXPORTED=//p')` to copy the doc into `docs/superpowers/specs/` **before** teardown/
  archive (Stages 14b/15) so the `_score` source still exists (a non-zero `export-doc` is non-fatal).
  **Read and present** the doc, then continue to Stage 13 (Phase F). Carry `$EXPORTED` to Stage 16.
```

- [ ] **Step 5: Report the exported path in the final present (Stage 16)**

Stage 16 (line 350-353) currently reads:

```markdown
**Read and present** the final design-doc (`$ART/design-doc/<date>-<TOPIC>-design.md` — the path
`assemble` printed; after Stage 15 it's the archived copy). Then point the user at the next step:
"run `/consort:perform <doc>` once perform ships" — the deploy-audit gate already guarantees the doc is
perform-ready (single-repo AND multi-repo). This is the end of `score`.
```

Replace it with:

```markdown
**Read and present** the final design-doc. State its location clearly: **`$EXPORTED`
(`docs/superpowers/specs/`) is the primary, discoverable copy** (exported in Stage 12, survives
teardown/archive); the source `_score`/archive copy (`$ART/design-doc/<date>-<TOPIC>-design.md`, or
the archived path after Stage 15) is noted as provenance. Then point the user at the next step:
`/consort:perform $EXPORTED` — the deploy-audit gate already guarantees the doc is perform-ready
(single-repo AND multi-repo). This is the end of `score`.
```

- [ ] **Step 6: Verify the stale-token gate**

Run: `npm test -- tests/stale-tokens.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add commands/score.md
git commit -m "feat(score): add TodoWrite progress list; export design doc + report it clearly

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full gate + dist rebuild + commit

**Files:**
- Modify: `dist/consort.cjs` (rebuilt)

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck clean, lint clean, all tests pass (incl. `stale-tokens`).

- [ ] **Step 2: Rebuild the bundle**

Run: `npm run build`
Expected: writes `dist/consort.cjs` with no error.

- [ ] **Step 3: Smoke-test the bundle**

Run: `node dist/consort.cjs score 2>&1 | head -1` then `node dist/consort.cjs perform 2>&1 | head -1`
Expected: the score usage line includes `export-doc`; the perform usage line prints (rc 2). Also:
`node dist/consort.cjs score export-doc 2>&1` → prints the `usage: score export-doc <topic>` error (rc 2).

- [ ] **Step 4: Commit the rebuilt bundle**

```bash
git add dist/consort.cjs
git commit -m "build: rebuild dist/consort.cjs for perform/score UX sweep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (author)

- **Spec coverage:** Fix 1 → Tasks 1+2+3; Fix 2 → Tasks 3 (perform.md) + 5 (score.md); Fix 3 →
  Tasks 4 (verb) + 5 (wiring). dist rebuild → Task 6. All success criteria mapped.
- **Type consistency:** `isOrchestral` (Task 1) used only in colors.ts; `scoreExportDocPath(repoRoot,
  basename)` and `exportDocTo(topic, destRoot, opts?)` (Task 4) match the test calls and the
  `exportDocRun` caller; `repoRoot()` is the existing `src/core/paths.ts` export. `PART` constant is
  the single source of the part name after Task 2.
- **No placeholders:** every code step shows the exact code/edit; every command shows expected output.
