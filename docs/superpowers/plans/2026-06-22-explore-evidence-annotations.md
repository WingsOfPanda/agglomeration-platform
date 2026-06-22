# Explore Evidence-Weakness Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Phase 5b "annotate" pass to `/ap:explore` that marks single-source citations `[unverified]` and uncited tradeoff rows `[no citation]` in the landscape draft, with the guarantee that all five confidence-gate signals stay byte-identical.

**Architecture:** One new pure module (`src/core/exploreAnnotate.ts`) computes the annotations from the draft + findings; one additive helper (`soloCitations`) is extracted from the gate so annotation and the gate share one definition of "single-source"; one thin verb (`explore annotate`) does atomic I/O; one directive insert sequences it between Phase 5 and Phase 5.5. The pass changes no gate signal, so `confidence` and the adversary phase are untouched.

**Tech Stack:** TypeScript (Node 18 target), esbuild single-bundle (`dist/ap.cjs`), vitest, eslint. Pure functions in `src/core/*`, CLI verbs in `src/commands/explore.ts`.

## Global Constraints

- **No wire-protocol change.** Event names, JSON fields, state filenames, `contracts.yaml` all frozen — `contracts.yaml` is not touched.
- **No change to `computeSignals` observable behavior.** `tests/explore-confidence.test.ts` must stay green unchanged; the only edit there is extracting `soloCitations` and calling it.
- **The all-signals invariant:** `computeSignals(buildAnnotations(draft, findings).annotatedDraft, findings)` deep-equals `computeSignals(draft, findings)` for every draft. This is the headline correctness property.
- **Atomic writes only:** use the existing `atomicWrite(path, content)` (tmp-in-same-dir + rename) for every file write. Never write to `/tmp` then rename.
- **No emojis in shipped output; errors to stderr** (use `log.error`/`log.ok`/`log.info` from `src/core/log.ts`).
- **`dist/` is committed.** After changing `src/`, run `npm run build` and commit the refreshed `dist/ap.cjs`.
- **Version is 3-way synced** across `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (enforced by `tests/manifest.test.ts`). Current version is `0.3.7`; this work ships as `0.3.8`.
- **Pure functions are tested without tmux/panes.** Verb tests use `freshHome()` from `tests/helpers/tmpHome.ts` and the `exploreArtDir(topic)` layout.

---

### Task 1: Extract `soloCitations` from the gate (single source of truth)

The annotation pass and the gate's S2 signal must agree exactly on which citations are "single-source" (corroborated by `< 2` findings). Extract the S2 inner loop into an exported helper and have `computeSignals` call it. Behavior is preserved byte-for-byte.

**Files:**
- Modify: `src/core/exploreConfidence.ts` (the S2 block in `computeSignals`, ~lines 53-59)
- Test: `tests/explore-confidence.test.ts` (add one `describe` block; do not change existing cases)

**Interfaces:**
- Produces: `soloCitations(draft: string, findings: string[]): string[]` — draft citation tokens (in `draftCitations` order) appearing in fewer than 2 findings files.

- [ ] **Step 1: Write the failing test**

Add to `tests/explore-confidence.test.ts` (import `soloCitations` in the existing top import from `../src/core/exploreConfidence.js`):

```ts
// NOTE: keep citation URLs newline-safe in fixtures. draftCitations' URL regex
// (https?:\/\/[^ )"\\]+) does NOT stop at \n, so a "- url\n- url" list tokenizes the first URL
// as "url\n-" (mangled). Separate URLs with a space / trailing text, not just a newline.
describe("soloCitations", () => {
  it("returns only citations present in fewer than 2 findings", () => {
    const draft = "Cited: https://both.example/p and https://solo.example/q in the text.";
    const findings = [
      "see https://both.example/p and https://solo.example/q",
      "also https://both.example/p only",
    ];
    expect(soloCitations(draft, findings)).toEqual(["https://solo.example/q"]);
  });
  it("empty when every citation is corroborated by >= 2 findings", () => {
    const draft = "Cited https://both.example/p here.";
    expect(soloCitations(draft, ["https://both.example/p a", "https://both.example/p b"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/explore-confidence.test.ts -t soloCitations`
Expected: FAIL — `soloCitations is not a function` (not exported yet).

- [ ] **Step 3: Add the helper and refactor `computeSignals`**

In `src/core/exploreConfidence.ts`, add this exported function immediately above `export function computeSignals` (after the `UNCERTAIN` const):

```ts
/** Draft citations corroborated by < 2 findings files (the S2 "solo" set, in draft order). */
export function soloCitations(draft: string, findings: string[]): string[] {
  return draftCitations(draft).filter((cite) => findings.filter((f) => f.includes(cite)).length < 2);
}
```

Then replace the S2 block inside `computeSignals` (the `let solo = 0; for (...) { ... } const s2 = solo === 0;`) with:

```ts
  // S2: every draft citation appears in >= 2 findings.
  const s2 = soloCitations(draft, findings).length === 0;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/explore-confidence.test.ts`
Expected: PASS — both the new `soloCitations` block and all pre-existing `computeSignals` cases (the S2 case proves behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/core/exploreConfidence.ts tests/explore-confidence.test.ts
git commit -m "refactor(explore): extract soloCitations from the S2 gate signal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `uncitedMatrixReasons` pure function

Detect tradeoff-matrix Reason cells that contain **no** citation token at all (the genuine-absence condition, not S4's lead-char quirk). Skips the markdown header row and the `|---|` separator. Reuses `draftCitations` so the "has a citation" test matches the gate's exact regex.

**Files:**
- Create: `src/core/exploreAnnotate.ts`
- Test: `tests/explore-annotate.test.ts`

**Interfaces:**
- Consumes: `draftCitations` (Task-independent; already exported from `exploreConfidence.ts`).
- Produces: `uncitedMatrixReasons(draft: string): { reason: string; lineIndex: number }[]` — 0-based line index of each uncited Reason row.

- [ ] **Step 1: Write the failing test**

Create `tests/explore-annotate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { uncitedMatrixReasons } from "../src/core/exploreAnnotate.js";

const MATRIX = [
  "## Tradeoff matrix",
  "| Priority | Best fit | Reason |",
  "|---|---|---|",
  "| latency | flash | it is simply faster |",        // uncited -> flagged
  "| memory | ring | /papers/ring.pdf shows it |",    // cited -> not flagged
  "## Citations",
].join("\n");

describe("uncitedMatrixReasons", () => {
  it("flags only data rows whose Reason cell has no citation token", () => {
    const out = uncitedMatrixReasons(MATRIX);
    expect(out.map((r) => r.lineIndex)).toEqual([3]); // the 'it is simply faster' row
    expect(out[0].reason).toBe("it is simply faster");
  });
  it("ignores the header and separator rows", () => {
    // header 'Reason' and separator '---' both lack citations but must NOT be flagged
    expect(uncitedMatrixReasons(MATRIX).length).toBe(1);
  });
  it("empty when every Reason cell carries a citation", () => {
    const m = ["## Tradeoff matrix", "| a | b | /p/x.pdf ok |", "## End"].join("\n");
    expect(uncitedMatrixReasons(m)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/explore-annotate.test.ts -t uncitedMatrixReasons`
Expected: FAIL — cannot resolve `../src/core/exploreAnnotate.js`.

- [ ] **Step 3: Create the module with the function**

Create `src/core/exploreAnnotate.ts`:

```ts
// src/core/exploreAnnotate.ts — Phase 5b evidence-weakness annotations for /ap:explore.
// Pure: (draft, findings) -> annotated draft + plan. The annotations are constructed so that
// computeSignals over the annotated draft equals computeSignals over the original draft (all five
// signals byte-identical) — the gate is blind to them. See the design spec
// docs/superpowers/specs/2026-06-22-explore-evidence-annotations-design.md.
import { draftCitations } from "./exploreConfidence.js";

/** A markdown table separator row, e.g. `|---|---|---|` or `| :-- | --- |`. */
function isSeparatorRow(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

/** Tradeoff-matrix Reason (3rd) cells that contain NO citation token. Skips header + separator. */
export function uncitedMatrixReasons(draft: string): { reason: string; lineIndex: number }[] {
  const out: { reason: string; lineIndex: number }[] = [];
  const lines = draft.split("\n");
  let inMatrix = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^## Tradeoff matrix/.test(line)) { inMatrix = true; continue; }
    if (/^## /.test(line)) { inMatrix = false; continue; }
    if (!inMatrix) continue;
    if (!line.startsWith("| ") || !line.endsWith("|")) continue;
    if (isSeparatorRow(line)) continue;
    const cells = line.split("|");       // ["", c1, c2, reason, ""] for a 3-column row
    if (cells.length !== 5) continue;
    if (i + 1 < lines.length && isSeparatorRow(lines[i + 1])) continue; // this is the header row
    const reason = cells[3];
    if (draftCitations(reason).length === 0) out.push({ reason: reason.trim(), lineIndex: i });
  }
  return out;
}
```

Note: this step imports only `draftCitations` (the only symbol Task 2 uses), so the Task 2 commit is lint-clean. Task 3 widens the import to add `soloCitations`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/explore-annotate.test.ts -t uncitedMatrixReasons`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/exploreAnnotate.ts tests/explore-annotate.test.ts
git commit -m "feat(explore): uncitedMatrixReasons detector for Phase 5b annotations

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `buildAnnotations` + the all-signals invariant + idempotency

The core. Append ` [unverified]` after each single-source citation outside `## Approaches`; append ` [no citation]` inside each uncited Reason cell. Record Approaches-line solo citations as `approaches-flagged` without editing them (so `topApproach`/S1 is untouched). Prove the invariant and idempotency with tests.

**Files:**
- Modify: `src/core/exploreAnnotate.ts`
- Test: `tests/explore-annotate.test.ts`

**Interfaces:**
- Consumes: `soloCitations` (Task 1), `uncitedMatrixReasons` (Task 2), `computeSignals` (for the invariant test).
- Produces:
  - `interface AnnotationItem { kind: "unverified" | "no-citation" | "approaches-flagged"; token?: string; lineIndex: number }`
  - `interface AnnotationPlan { items: AnnotationItem[] }`
  - `buildAnnotations(draft: string, findings: string[]): { annotatedDraft: string; plan: AnnotationPlan }`

- [ ] **Step 1: Write the failing tests**

Add to `tests/explore-annotate.test.ts` (extend the import to `{ uncitedMatrixReasons, buildAnnotations }` and add `import { computeSignals } from "../src/core/exploreConfidence.js";`):

```ts
const FIND_A = "alpha found https://solo.example/q . also https://both.example/p . uncertain about edge.";
const FIND_B = "beta found https://both.example/p only.";

const DRAFT = [
  "## Approaches",
  "1. [https://solo.example/q] Approach One — desc",   // solo citation on an Approaches line
  "## Findings by worker",
  "Claim backed by https://solo.example/q and https://both.example/p.",
  "## Tradeoff matrix",
  "| latency | One | it is simply faster |",            // uncited reason cell
  "## Citations",
  "- https://solo.example/q single-source",             // trailing text -> newline-safe token
  "- https://both.example/p corroborated",
].join("\n");

describe("buildAnnotations", () => {
  it("appends [unverified] to a solo citation outside Approaches", () => {
    const { annotatedDraft } = buildAnnotations(DRAFT, [FIND_A, FIND_B]);
    expect(annotatedDraft).toContain("https://solo.example/q [unverified] and https://both.example/p");
    expect(annotatedDraft).not.toContain("https://both.example/p [unverified]"); // corroborated -> untouched
  });
  it("does NOT edit an Approaches line; records it as approaches-flagged", () => {
    const { annotatedDraft, plan } = buildAnnotations(DRAFT, [FIND_A, FIND_B]);
    expect(annotatedDraft).toContain("1. [https://solo.example/q] Approach One — desc"); // byte-identical
    expect(plan.items.some((i) => i.kind === "approaches-flagged" && i.token === "https://solo.example/q")).toBe(true);
  });
  it("appends [no citation] inside an uncited matrix Reason cell", () => {
    const { annotatedDraft } = buildAnnotations(DRAFT, [FIND_A, FIND_B]);
    expect(annotatedDraft).toContain("| latency | One | it is simply faster [no citation] |");
  });

  it("INVARIANT: all five gate signals are byte-identical after annotation", () => {
    const findings = [FIND_A, FIND_B];
    const { annotatedDraft } = buildAnnotations(DRAFT, findings);
    expect(computeSignals(annotatedDraft, findings)).toEqual(computeSignals(DRAFT, findings));
  });
  it("INVARIANT holds for a CONTESTED-saturated, low-convergence draft", () => {
    const d = DRAFT + "\nThis is CONTESTED and uncertain.";
    const findings = ["nothing relevant", "also nothing"];
    const { annotatedDraft } = buildAnnotations(d, findings);
    expect(computeSignals(annotatedDraft, findings)).toEqual(computeSignals(d, findings));
  });
  it("IDEMPOTENT: re-annotating an annotated draft is a no-op", () => {
    const findings = [FIND_A, FIND_B];
    const once = buildAnnotations(DRAFT, findings).annotatedDraft;
    const twice = buildAnnotations(once, findings).annotatedDraft;
    expect(twice).toBe(once);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/explore-annotate.test.ts -t buildAnnotations`
Expected: FAIL — `buildAnnotations is not a function`.

- [ ] **Step 3: Implement `buildAnnotations`**

First widen the import at the top of `src/core/exploreAnnotate.ts` to add `soloCitations`:

```ts
import { draftCitations, soloCitations } from "./exploreConfidence.js";
```

Then append to `src/core/exploreAnnotate.ts`:

```ts
export interface AnnotationItem {
  kind: "unverified" | "no-citation" | "approaches-flagged";
  token?: string;
  lineIndex: number;
}
export interface AnnotationPlan { items: AnnotationItem[]; }

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Line indices that sit under a `## Approaches` heading (until the next `## ` heading). */
function approachesLines(lines: string[]): Set<number> {
  const set = new Set<number>();
  let inApp = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Approaches/.test(lines[i])) { inApp = true; continue; }
    if (/^## /.test(lines[i])) { inApp = false; continue; }
    if (inApp) set.add(i);
  }
  return set;
}

/** Annotate evidence-weakness into the draft. The annotations never change any of the 5 gate
 *  signals (see the module header + the invariant test). Deterministic and idempotent. */
export function buildAnnotations(draft: string, findings: string[]): { annotatedDraft: string; plan: AnnotationPlan } {
  const solo = soloCitations(draft, findings);
  const lines = draft.split("\n");
  const inApp = approachesLines(lines);
  const items: AnnotationItem[] = [];

  // Rule 1: solo citations. Append " [unverified]" after each occurrence OUTSIDE ## Approaches.
  // On Approaches lines, record (do not edit) so topApproach() / S1 stay byte-identical.
  for (let i = 0; i < lines.length; i++) {
    for (const tok of solo) {
      if (!lines[i].includes(tok)) continue;
      if (inApp.has(i)) {
        items.push({ kind: "approaches-flagged", token: tok, lineIndex: i });
        continue;
      }
      // (?![A-Za-z0-9_./:-]) = not a prefix of a longer token; (?! \[unverified\]) = idempotent.
      const re = new RegExp(escapeRegExp(tok) + "(?![A-Za-z0-9_./:-])(?! \\[unverified\\])", "g");
      if (re.test(lines[i])) {
        lines[i] = lines[i].replace(
          new RegExp(escapeRegExp(tok) + "(?![A-Za-z0-9_./:-])(?! \\[unverified\\])", "g"),
          tok + " [unverified]",
        );
        items.push({ kind: "unverified", token: tok, lineIndex: i });
      }
    }
  }

  // Rule 2: uncited matrix Reason cells. Append " [no citation]" inside the cell (idempotent).
  for (const { lineIndex } of uncitedMatrixReasons(lines.join("\n"))) {
    if (lines[lineIndex].includes("[no citation]")) continue;
    lines[lineIndex] = lines[lineIndex].replace(/ \|$/, " [no citation] |");
    items.push({ kind: "no-citation", lineIndex });
  }

  return { annotatedDraft: lines.join("\n"), plan: { items } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/explore-annotate.test.ts`
Expected: PASS — all `uncitedMatrixReasons` and `buildAnnotations` cases, including the two INVARIANT cases and IDEMPOTENT.

- [ ] **Step 5: Commit**

```bash
git add src/core/exploreAnnotate.ts tests/explore-annotate.test.ts
git commit -m "feat(explore): buildAnnotations with all-signals invariant + idempotency

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `explore annotate` verb + dispatcher wiring

The thin impure executor: read the draft + findings, call `buildAnnotations`, atomic-write the annotated draft + `annotations.json` + `annotate-applied.txt` marker. Idempotent (marker no-op), validator-style rc codes.

**Files:**
- Modify: `src/commands/explore.ts` (import, dispatcher `switch`, `usage()` string, new `annotateRun`)
- Test: `tests/explore-cmd.test.ts`

**Interfaces:**
- Consumes: `buildAnnotations` (Task 3); `parseListFile`, `missingListArtifacts`, `atomicWrite`, `isoUtc`, `readIf`, `exploreArtDir` (all already in `explore.ts`).
- Produces: `annotateRun(rest: string[]): Promise<number>` — `explore annotate <topic>`; rc 2 (usage), rc 1 (missing inputs), rc 0 (applied or no-op).

- [ ] **Step 1: Write the failing tests**

Add to `tests/explore-cmd.test.ts` (extend the `../src/commands/explore.js` import to include `annotateRun`; `seedFindings`/`DRAFT` already exist in that file):

```ts
describe("explore annotate", () => {
  it("annotates a solo citation + uncited row, writes marker + annotations.json", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      // alpha+charlie both cite https://x.test/p (corroborated); https://x.test/solo is solo (alpha only).
      writeFileSync(join(art, "findings-alpha.md"), "https://x.test/p and https://x.test/solo . uncertain.");
      writeFileSync(join(art, "findings-charlie.md"), "https://x.test/p only.");
      writeFileSync(join(art, "landscape-draft.md"), [
        "## Findings by worker", "See https://x.test/solo here.",
        "## Tradeoff matrix", "| latency | One | plain prose reason |",
      ].join("\n"));
      const rc = await annotateRun(["x"]);
      expect(rc).toBe(0);
      const out = readFileSync(join(art, "landscape-draft.md"), "utf8");
      expect(out).toContain("https://x.test/solo [unverified]");
      expect(out).toContain("plain prose reason [no citation]");
      expect(existsSync(join(art, "annotate-applied.txt"))).toBe(true);
      expect(readFileSync(join(art, "annotations.json"), "utf8")).toContain("\"n_unverified\"");
    } finally { cleanup(); }
  });
  it("is a no-op when annotate-applied.txt already exists", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      await seedFindings(art, DRAFT);
      writeFileSync(join(art, "annotate-applied.txt"), "applied: earlier\n");
      const before = readFileSync(join(art, "landscape-draft.md"), "utf8");
      const rc = await annotateRun(["x"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "landscape-draft.md"), "utf8")).toBe(before); // untouched
    } finally { cleanup(); }
  });
  it("rc1 when the draft is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      expect(await annotateRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/explore-cmd.test.ts -t "explore annotate"`
Expected: FAIL — `annotateRun` is not exported.

- [ ] **Step 3: Add the import, dispatcher case, usage string, and `annotateRun`**

In `src/commands/explore.ts`:

(a) Add to the imports (next to the other `../core/explore*` imports):

```ts
import { buildAnnotations } from "../core/exploreAnnotate.js";
```

(b) In `usage()`, add `annotate|` after `confidence|` in the verb list string.

(c) In the `switch (verb)`, add after the `confidence` case:

```ts
    case "annotate": return annotateRun(rest);
```

(d) Add the verb implementation immediately after `confidenceRun` (before the adversary section):

```ts
// ---- annotate (Phase 5b evidence-weakness transparency overlay) ----
export async function annotateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: explore annotate <topic>"); return 2; }
  const art = exploreArtDir(topic);
  const markerPath = join(art, "annotate-applied.txt");
  if (existsSync(markerPath)) { log.ok(`explore annotate: already applied (${markerPath}) — no-op`); return 0; }
  const draftPath = join(art, "landscape-draft.md");
  const draft = readIf(draftPath);
  if (!draft.trim()) { log.error(`explore annotate: landscape-draft.md missing/empty at ${art}`); return 1; }
  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error(`explore annotate: list.txt missing at ${art}`); return 1; }
  const rows = parseListFile(readIf(listPath));
  const missing = missingListArtifacts(art, rows, "findings");
  if (missing.length) {
    log.error("explore annotate: blocked — missing or empty findings:");
    for (const m of missing) log.error(`  - ${join(art, m)}`);
    return 1;
  }
  const findings = rows.map((r) => readIf(join(art, `findings-${r.agent}.md`)));

  const { annotatedDraft, plan } = buildAnnotations(draft, findings);
  const counts = {
    n_unverified: plan.items.filter((i) => i.kind === "unverified").length,
    n_no_citation: plan.items.filter((i) => i.kind === "no-citation").length,
    n_approaches_flagged: plan.items.filter((i) => i.kind === "approaches-flagged").length,
  };
  atomicWrite(draftPath, annotatedDraft);
  atomicWrite(join(art, "annotations.json"), JSON.stringify({ topic, counts, items: plan.items }, null, 2) + "\n");
  atomicWrite(markerPath,
    `applied: ${isoUtc()}\nunverified=${counts.n_unverified} no_citation=${counts.n_no_citation} ` +
    `approaches_flagged=${counts.n_approaches_flagged}\n`);
  log.ok(`explore annotate: ${counts.n_unverified} unverified, ${counts.n_no_citation} no-citation, ` +
    `${counts.n_approaches_flagged} approaches-flagged`);
  return 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/explore-cmd.test.ts -t "explore annotate"`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/commands/explore.ts tests/explore-cmd.test.ts
git commit -m "feat(explore): annotate verb (Phase 5b transparency overlay)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Phase 5b directive prose

Sequence the verb in the Hub-followed directive: run `annotate` after the draft is written (Phase 5) and before the gate (Phase 5.5). No new TaskCreate row — it runs under task 5's umbrella.

**Files:**
- Modify: `commands/explore.md` (insert between line 192 `Set task \`5\` → \`completed\`.` and line 194 `## Phase 5.5 — confidence gate`)

**Interfaces:** none (shipped prose). Verification is the stale-tokens gate + a grep.

- [ ] **Step 1: Insert the Phase 5b section**

In `commands/explore.md`, between the `Set task \`5\` → \`completed\`.` line that ends Phase 5 and the `## Phase 5.5 — confidence gate` heading, insert:

```markdown
## Phase 5b — annotate (Hub runs; no task row)

`$CS explore annotate <TOPIC>` — a deterministic transparency overlay. It marks **single-source
citations** (cited by `< 2` workers) with `[unverified]` and **uncited tradeoff rows** with
`[no citation]`, editing `landscape-draft.md` in place and writing `$ART/annotations.json` (counts,
for `/ap:review`) + `$ART/annotate-applied.txt` (the idempotency marker). It runs under task `5` (no
new TaskCreate row).

This pass is **annotation-only and gate-neutral**: by construction it leaves all five confidence
signals byte-identical, so the Phase 5.5 gate below sees exactly what it would have on the raw draft —
the markers exist for the final landscape doc and a downstream `/ap:design` reader, not to change the
gate. **rc 1** if `landscape-draft.md` or any `findings-<agent>.md` is missing/empty; a re-run with
`annotate-applied.txt` present is a no-op (crash/resume-safe). Citations on `## Approaches` lines are
recorded in `annotations.json` but **not** inlined (inlining there would perturb signal S1).

```

- [ ] **Step 2: Verify the insertion and the stale-token gate**

Run: `grep -n "Phase 5b — annotate" commands/explore.md && npx vitest run tests/stale-tokens.test.ts`
Expected: the grep prints the new heading line; the stale-tokens suite PASSES (the prose introduces no banned brand/metaphor token).

- [ ] **Step 3: Commit**

```bash
git add commands/explore.md
git commit -m "docs(explore): Phase 5b annotate directive prose

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Version bump to 0.3.8, rebuild dist, full gate

Ship it: bump the 3-way-synced version, rebuild the committed bundle, run the whole gate.

**Files:**
- Modify: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (version `0.3.7` → `0.3.8`)
- Modify: `dist/ap.cjs` (rebuilt)

**Interfaces:** none.

- [ ] **Step 1: Bump the version in all three manifests**

Set `"version": "0.3.8"` in `package.json`, `.claude-plugin/plugin.json`, and the plugin entry in `.claude-plugin/marketplace.json` (each currently `0.3.7`).

- [ ] **Step 2: Verify the manifest sync test passes**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS (the three versions agree).

- [ ] **Step 3: Rebuild the committed bundle**

Run: `npm run build`
Expected: esbuild writes `dist/ap.cjs` with no errors.

- [ ] **Step 4: Run the full gate**

Run: `npm run typecheck && npm run test && npm run lint && npm run build`
Expected: typecheck clean; all tests pass (including `explore-annotate`, the extended `explore-confidence` and `explore-cmd`); eslint clean; build clean.

- [ ] **Step 5: Smoke-test the verb through the built bundle**

Run:
```bash
node dist/ap.cjs explore annotate 2>&1 | head -1
```
Expected: prints the usage line `usage: explore annotate <topic>` (rc 2 path) — confirms the verb is wired into the dispatched bundle.

- [ ] **Step 6: Commit**

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json dist/ap.cjs
git commit -m "chore(release): explore Phase 5b annotations, bump to 0.3.8

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Two annotation rules (single-source `[unverified]`, uncited row `[no citation]`) → Task 3. ✓
- `soloCitations` extracted, single source of truth, `computeSignals` unchanged → Task 1. ✓
- `uncitedMatrixReasons` (genuine-absence, not S4 lead-char) → Task 2. ✓
- All-five-signals invariant + idempotency tests → Task 3. ✓
- Approaches-line skip + `approaches-flagged` record → Task 3. ✓
- `annotate` verb: validator rc codes, marker no-op, atomic writes of annotated draft + `annotations.json` + marker → Task 4. ✓
- Phase 5b directive between Phase 5 and 5.5, "no task row", gate-neutral note → Task 5. ✓
- Forensics counts in `annotations.json` for `/ap:review` → Task 4 (the JSON `counts`). ✓
- No `contracts.yaml` change; no wire-protocol change → none of the tasks touch them. ✓
- Version 3-way bump + dist rebuild → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the exact command + expected result. ✓

**Type consistency:** `soloCitations(draft, findings): string[]` (Task 1) consumed identically in Task 3. `uncitedMatrixReasons(draft): {reason, lineIndex}[]` (Task 2) consumed in Task 3 (`for (const { lineIndex } of ...)`). `buildAnnotations(draft, findings): {annotatedDraft, plan}` (Task 3) consumed in Task 4 with the same destructuring and `plan.items[].kind` values (`"unverified" | "no-citation" | "approaches-flagged"`) matched in the `counts` filters. `annotateRun(rest): Promise<number>` (Task 4) matches the dispatcher case and the test import. ✓
