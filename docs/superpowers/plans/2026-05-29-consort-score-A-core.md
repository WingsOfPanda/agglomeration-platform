# consort score — Phase A (core modules) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the byte-faithful pure-logic core modules for consort `score` — no directive, no spawn — with full unit coverage.

**Architecture:** Each module ports one clone-wars consult/deploy behavior as pure TypeScript (string/regex/fs-read logic), tested against fixtures. This is **Phase A of a phased plan set (A–F)** from `docs/superpowers/specs/2026-05-29-consort-score-design.md` §14. It ships **no user-facing command** — it is the foundation Phases B–F build on.

**Tech Stack:** TypeScript (ES2022/NodeNext/strict), vitest, eslint (`no-unused-vars: error`). ESM imports use the `.js` extension.

**Spec:** `docs/superpowers/specs/2026-05-29-consort-score-design.md`.

---

## Scope of THIS plan

The spec's Phase A lists 8 core modules. To keep this plan byte-faithful and reviewable, it covers the **6 structural modules + the archive change** that Phase B (init + fast-path) builds on:

1. `src/core/score.ts` — slug (reused), `--ensemble`/`--targets` parse, `_score` paths.
2. `src/core/audit.ts` — `auditDoc` + `extractTarget` (the deploy-audit gate, byte-identical).
3. `src/core/dag.ts` — `parseDagLine` / `checkDagSection` / `emitSoftDag` (validator + producer).
4. `src/core/multirepo.ts` — `detectMultiRepo`.
5. `src/core/scoreWalk.ts` — `walkSectionState` + `auditIssueToSection`.
6. `src/core/scoreDoc.ts` — the 6/8 section model + `assembleDoc`.
7. `src/core/archive.ts` — add `"score"` to `archiveTopic`'s suite union.

The two **N-way escalation aggregators** — `core/scoreDiff.ts` (Venn bucketing) and `core/scoreAdjudicate.ts` (5-tier classifier) — are escalation-only (needed by Phase C/D, not B). They get a **focused companion plan** (`score-A2-aggregators`) authored before Phase C, since they require careful porting of the most complex consult Bash. This slicing matches the spec's "multiple plans" intent.

**Execution order (one cross-module dependency):** implement in the order **T1 → T3 (`dag.ts`) → T2 (`audit.ts`) → T4 → T5 → T6 → T7**. `audit.ts` imports `checkDagSection` from `dag.ts`, so `dag.ts` must exist before `audit.ts`'s test runs green. All other tasks are independent.

**Spec reconciliation (note for the design author):** current-main `bin/consult-walk-assemble.sh` stamps `# <Title>` + (for multi/single-sub) `**Date:** <YYYY-MM-DD>` + `**Target Sub-Project(s):** …`. It does **not** emit the v0.16 `Source/Generated/Path` trust blockquote (dropped in v0.17). `scoreDoc.assembleDoc` here reproduces the **v0.17** header (full-main parity). The spec §5/§7/§10 references to a "trust-label header (Source/Generated/Path)" should be read as this Date/Target header; the spec will be updated to match.

**Foundation facts (verified against the repo + clone-wars):**
- `core/solo.ts` already exports `deriveSlug(text): string` (lowercase → `[a-z0-9-]` → collapse `-` → trim → cap 20 → trim trailing `-`; `""` if no alphanumerics) — **byte-identical** to consult's slug rule (`bin/consult-init.sh:88-94`). `score.ts` reuses it.
- `core/paths.ts` exports `topicDir(topic)`. `core/atomic.ts` exports `atomicWrite`. `core/log.ts` exports `log`. `src/args.ts` exports `kvParse(flag, next)`.
- The stale-token gate bans `clone-wars`/`cw_`/`master-yoda`/`MISSION ACCOMPLISHED`/`@cw_` in `src config commands hooks .claude-plugin` (not `consult`/`trooper`).

---

## Task 1: `core/score.ts` — paths + arg parsing (slug reused)

**Files:** Create `src/core/score.ts`; Test `tests/score-core.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/score-core.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { scoreArtDir, scoreDraftDir, parseScoreArgs } from "../src/core/score.js";

describe("score paths", () => {
  it("scoreArtDir / scoreDraftDir hang off the topic dir under _score", () => {
    process.env.CONSORT_HOME = "/R";
    const art = scoreArtDir("score-auth");
    expect(art.endsWith(join("score-auth", "_score"))).toBe(true);
    expect(scoreDraftDir("score-auth")).toBe(join(art, "design-doc", ".draft"));
  });
});

describe("parseScoreArgs", () => {
  it("plain topic → no ensemble, no targets", () => {
    expect(parseScoreArgs(["compare", "LRU", "vs", "LFU"])).toEqual({ topicText: "compare LRU vs LFU", ensemble: false, targets: [] });
  });
  it("--ensemble is a token-exact boolean flag, stripped from the topic", () => {
    const r = parseScoreArgs(["--ensemble", "design", "auth"]);
    expect(r.ensemble).toBe(true);
    expect(r.topicText).toBe("design auth");
  });
  it("--ensemble-please is NOT the flag (token-exact)", () => {
    const r = parseScoreArgs(["--ensemble-please", "x"]);
    expect(r.ensemble).toBe(false);
    expect(r.topicText).toBe("--ensemble-please x");
  });
  it("--targets a,b,c parses a list and strips the flag", () => {
    const r = parseScoreArgs(["--targets", "api,web", "refactor"]);
    expect(r.targets).toEqual(["api", "web"]);
    expect(r.topicText).toBe("refactor");
  });
  it("--targets=a,b inline form", () => {
    expect(parseScoreArgs(["--targets=api,web", "x"]).targets).toEqual(["api", "web"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/score-core.test.ts`
Expected: FAIL — cannot resolve `../src/core/score.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/score.ts
import { join } from "node:path";
import { topicDir } from "./paths.js";
import { kvParse } from "../args.js";
export { deriveSlug } from "./solo.js"; // identical to consult's slug rule; reused, not duplicated

/** `_score` art dir for a topic. */
export function scoreArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_score");
}
/** Where the per-section drafts live. */
export function scoreDraftDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(scoreArtDir(topic, opts), "design-doc", ".draft");
}

export interface ScoreArgs { topicText: string; ensemble: boolean; targets: string[]; }

/** Pull the `--ensemble` boolean flag (token-exact) and `--targets a,b,c` out of the glued $ARGUMENTS. */
export function parseScoreArgs(tokens: string[]): ScoreArgs {
  let ensemble = false;
  let targets: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--ensemble") { ensemble = true; continue; }
    if (t === "--targets" || t.startsWith("--targets=")) {
      const { value, shift } = kvParse(t, tokens[i + 1]);
      targets = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (shift === 2) i++;
      continue;
    }
    rest.push(t);
  }
  return { topicText: rest.join(" "), ensemble, targets };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/score-core.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/score.ts tests/score-core.test.ts
git commit -m "feat(score): core paths + arg parsing (slug reused from solo)"
```

---

## Task 2: `core/audit.ts` — the deploy-audit gate (byte-identical) + extractTarget

**Files:** Create `src/core/audit.ts`; Test `tests/audit.test.ts`.
**Behavioral source:** `clone-wars/lib/deploy.sh:68-122` (`cw_deploy_audit_doc`) + `:391-419` (`cw_deploy_extract_target`). Slug regex `CW_SLUG_REGEX_BASE='[A-Za-z0-9._-]+'` (`lib/state.sh:10`). Issue-emission ORDER is load-bearing (tests assert it).

- [ ] **Step 1: Write the failing test**

```ts
// tests/audit.test.ts
import { describe, it, expect } from "vitest";
import { auditDoc, extractTarget, SLUG_REGEX } from "../src/core/audit.js";

const COMPLETE = [
  "# X", "## Problem", "p", "## Goal", "g", "## Architecture", "a",
  "## Components", "c", "## Testing", "t", "## Success Criteria", "s",
].join("\n") + "\n";

describe("auditDoc", () => {
  it("complete doc → PASS, no issues", () => {
    expect(auditDoc(COMPLETE)).toEqual({ verdict: "PASS", issues: [] });
  });
  it("missing mandatory sections → the four no_*_section issues in order", () => {
    const r = auditDoc("# X\n## Problem\np\n## Components\nc\n");
    expect(r.verdict).toBe("FAIL");
    expect(r.issues).toEqual(["no_goal_section", "no_arch_section", "no_testing_section", "no_success_section"]);
  });
  it("Approach satisfies the architecture gate", () => {
    const doc = COMPLETE.replace("## Architecture", "## Approach");
    expect(auditDoc(doc).issues).not.toContain("no_arch_section");
  });
  it("TBD as a word fails; lowercase todo is allowed", () => {
    expect(auditDoc(COMPLETE + "note: TBD\n").issues).toContain("tbd_marker");
    expect(auditDoc(COMPLETE + "field: todo_count\n").issues).not.toContain("todo_marker");
    expect(auditDoc(COMPLETE + "TODO later\n").issues).toContain("todo_marker");
  });
  it("fill in later / to be determined markers (case-insensitive)", () => {
    expect(auditDoc(COMPLETE + "Fill In Later\n").issues).toContain("fill_in_later_marker");
    expect(auditDoc(COMPLETE + "to be determined\n").issues).toContain("to_be_determined_marker");
  });
  it("hallucinated placeholder block-list", () => {
    expect(auditDoc(COMPLETE + "see <previous-deep-research>\n").issues).toContain("unresolved_placeholder");
    expect(auditDoc(COMPLETE + "the <topic> var\n").issues).not.toContain("unresolved_placeholder");
  });
  it("invalid Target Sub-Project slug → issue; valid → none", () => {
    expect(auditDoc(COMPLETE + "**Target Sub-Project:** ../escape\n").issues).toContain("target_subproject_when_invalid");
    expect(auditDoc(COMPLETE + "**Target Sub-Project:** api\n").issues).not.toContain("target_subproject_when_invalid");
  });
  it("unparseable Execution DAG → issue; absent heading → none", () => {
    expect(auditDoc(COMPLETE + "## Execution DAG\n1. bad line no emdash\n").issues).toContain("execution_dag_not_parseable");
    expect(auditDoc(COMPLETE).issues).not.toContain("execution_dag_not_parseable");
  });
  it("issue order: placeholder before tbd before markers before target before dag", () => {
    const doc = COMPLETE + "**Target Sub-Project:** ../x\n## Execution DAG\n1. bad\nTBD <archive>\n";
    const idx = (k: string) => doc && auditDoc(doc).issues.indexOf(k);
    const i = auditDoc(doc).issues;
    expect(i.indexOf("unresolved_placeholder")).toBeLessThan(i.indexOf("tbd_marker"));
    expect(i.indexOf("tbd_marker")).toBeLessThan(i.indexOf("target_subproject_when_invalid"));
    expect(i.indexOf("target_subproject_when_invalid")).toBeLessThan(i.indexOf("execution_dag_not_parseable"));
  });
});

describe("extractTarget", () => {
  it("no header → present:false", () => { expect(extractTarget(COMPLETE)).toEqual({ present: false }); });
  it("valid slug", () => { expect(extractTarget("**Target Sub-Project:** api\n")).toEqual({ present: true, valid: true, slug: "api" }); });
  it("invalid slug → valid:false", () => { expect(extractTarget("**Target Sub-Project:** ../x\n")).toEqual({ present: true, valid: false }); });
  it("two headers → valid:false (ambiguous)", () => {
    expect(extractTarget("**Target Sub-Project:** a\n**Target Sub-Project:** b\n")).toEqual({ present: true, valid: false });
  });
  it("SLUG_REGEX accepts dotted/hyphen/underscore", () => { expect(SLUG_REGEX.test("a.b-c_d")).toBe(true); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audit.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/audit.ts
import { checkDagSection } from "./dag.js";

/** clone-wars CW_SLUG_REGEX_BASE (lib/state.sh:10). */
export const SLUG_REGEX = /^[A-Za-z0-9._-]+$/;

const TARGET_HEADER = /^[ \t]*\*\*Target Sub-Project:\*\*[ \t]+/gm;

export type TargetResult =
  | { present: false }
  | { present: true; valid: true; slug: string }
  | { present: true; valid: false };

/** Port of cw_deploy_extract_target. No header → present:false; 1 valid → slug; 1 invalid or 2+ → valid:false. */
export function extractTarget(docText: string): TargetResult {
  const matches = docText.match(TARGET_HEADER);
  if (!matches || matches.length === 0) return { present: false };
  if (matches.length > 1) return { present: true, valid: false };
  const line = docText.split("\n").find((l) => /^[ \t]*\*\*Target Sub-Project:\*\*[ \t]+/.test(l)) ?? "";
  const slug = line.replace(/^[ \t]*\*\*Target Sub-Project:\*\*[ \t]+([^ \t]+).*$/, "$1");
  return SLUG_REGEX.test(slug) ? { present: true, valid: true, slug } : { present: true, valid: false };
}

export interface AuditResult { verdict: "PASS" | "FAIL"; issues: string[]; }

/** Port of cw_deploy_audit_doc — a pure read-only markdown linter. Issue ORDER mirrors the Bash. */
export function auditDoc(docText: string): AuditResult {
  const issues: string[] = [];
  if (!/^##\s+Goal\b/m.test(docText)) issues.push("no_goal_section");
  if (!/^##\s+(Architecture|Approach)\b/m.test(docText)) issues.push("no_arch_section");
  if (!/^##\s+.*[Tt]est/m.test(docText)) issues.push("no_testing_section");
  if (!/^##\s+.*[Ss]uccess/m.test(docText)) issues.push("no_success_section");
  if (/<(archive|previous-[a-z][a-z0-9_-]*|archived-[a-z][a-z0-9_-]*|source-[a-z][a-z0-9_-]*)>/.test(docText)) issues.push("unresolved_placeholder");
  if (/\bTBD\b/.test(docText)) issues.push("tbd_marker");
  if (/\bTODO\b/.test(docText)) issues.push("todo_marker");
  if (/fill in later/i.test(docText)) issues.push("fill_in_later_marker");
  if (/to be determined/i.test(docText)) issues.push("to_be_determined_marker");
  const t = extractTarget(docText);
  if (t.present && !t.valid) issues.push("target_subproject_when_invalid");
  if (/^## Execution DAG[ \t]*$/m.test(docText) && !checkDagSection(docText)) issues.push("execution_dag_not_parseable");
  return issues.length === 0 ? { verdict: "PASS", issues } : { verdict: "FAIL", issues };
}
```

> Note: `audit.ts` imports `checkDagSection` from `dag.ts` (Task 3). Implement Task 3 first, or land both before running; the test run in Step 4 assumes `dag.ts` exists.

- [ ] **Step 4: Run test to verify it passes** (after Task 3's `dag.ts` exists)

Run: `npx vitest run tests/audit.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/audit.ts tests/audit.test.ts
git commit -m "feat(score): deploy-audit gate (auditDoc + extractTarget), byte-identical"
```

---

## Task 3: `core/dag.ts` — DAG validator + producer (NOT the executor)

**Files:** Create `src/core/dag.ts`; Test `tests/dag.test.ts`.
**Behavioral source:** `clone-wars/lib/deploy-dag.sh:22-72` (`cw_deploy_dag_parse_line`, `cw_deploy_dag_check_section`) + `lib/consult-walk.sh:41-57` (`cw_consult_emit_soft_dag`). **Do NOT port** the topological/wave/fan-in executor — that is `perform`'s.
**Critical:** the em-dash is U+2014 (`—`); emit/parse must round-trip.

- [ ] **Step 1: Write the failing test**

```ts
// tests/dag.test.ts
import { describe, it, expect } from "vitest";
import { parseDagLine, checkDagSection, emitSoftDag } from "../src/core/dag.js";

describe("parseDagLine", () => {
  it("plain line, no deps", () => {
    expect(parseDagLine("1. api — build the service")).toEqual({ step: "1", repo: "api", path: "none", desc: "build the service", deps: "none" });
  });
  it("with deps, comma-space normalized on parse input", () => {
    expect(parseDagLine("3. web — ship (depends on 1, 2)")).toEqual({ step: "3", repo: "web", path: "none", desc: "ship", deps: "1,2" });
  });
  it("optional (/abspath) group", () => {
    expect(parseDagLine("2. api (/srv/api) — deploy")).toEqual({ step: "2", repo: "api", path: "/srv/api", desc: "deploy", deps: "none" });
  });
  it("malformed (no em-dash) → null", () => { expect(parseDagLine("1. api - build")).toBeNull(); });
});

describe("emitSoftDag", () => {
  it("no deps vs deps (comma → comma-space)", () => {
    expect(emitSoftDag([{ step: "1", repo: "api", desc: "build", deps: "none" }])).toBe("1. api — build");
    expect(emitSoftDag([{ step: "2", repo: "web", desc: "ship", deps: "1,3" }])).toBe("2. web — ship (depends on 1, 3)");
  });
  it("round-trips with parseDagLine", () => {
    const line = emitSoftDag([{ step: "3", repo: "core", desc: "wire it", deps: "1,2" }]);
    expect(parseDagLine(line)).toEqual({ step: "3", repo: "core", path: "none", desc: "wire it", deps: "1,2" });
  });
});

describe("checkDagSection", () => {
  it("absent section → ok", () => { expect(checkDagSection("# X\n## Goal\ng\n")).toBe(true); });
  it("all numbered lines parse → ok", () => {
    expect(checkDagSection("## Execution DAG\n1. api — build\n2. web — ship (depends on 1)\n## Next\n")).toBe(true);
  });
  it("a malformed numbered line → fail", () => {
    expect(checkDagSection("## Execution DAG\n1. api - no emdash\n")).toBe(false);
  });
  it("box-art / prose lines are ignored (only ^digit. checked)", () => {
    expect(checkDagSection("## Execution DAG\nsome prose\n- a bullet\n1. api — build\n")).toBe(true);
  });
  it("suffixed heading is NOT recognized (treated as no-DAG)", () => {
    expect(checkDagSection("## Execution DAG (multi)\n1. bad line\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dag.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/dag.ts
export interface DagNode { step: string; repo: string; path: string; desc: string; deps: string; }
export interface SoftDagRow { step: string; repo: string; desc: string; deps: string; } // deps: "none" | "1,2"

const LINE_RE = /^(\d+)\.[ \t]+([A-Za-z0-9_-]+)(?:[ \t]+\((\/[^)]+)\))?[ \t]+—[ \t]+(.+)$/;
const DEPS_RE = /^(.+?)[ \t]+\(depends[ \t]+on[ \t]+([0-9, ]+)\)[ \t]*$/;

/** Port of cw_deploy_dag_parse_line. Returns the parsed node or null on a malformed line. */
export function parseDagLine(line: string): DagNode | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const step = m[1], repo = m[2], path = m[3] ?? "none", rest = m[4];
  const d = DEPS_RE.exec(rest);
  if (d) return { step, repo, path, desc: d[1], deps: d[2].replace(/ /g, "") };
  return { step, repo, path, desc: rest, deps: "none" };
}

/** Port of cw_deploy_dag_check_section. Absent/no-numbered-lines → ok; any malformed numbered line → fail. */
export function checkDagSection(docText: string): boolean {
  const lines = docText.split("\n");
  let inDag = false;
  const body: string[] = [];
  for (const l of lines) {
    if (/^## Execution DAG[ \t]*$/.test(l)) { inDag = true; continue; }
    if (/^## /.test(l)) { inDag = false; continue; }
    if (inDag) body.push(l);
  }
  for (const l of body) {
    if (!/^[ \t]*\d+\./.test(l)) continue;
    if (parseDagLine(l) === null) return false;
  }
  return true;
}

/** Port of cw_consult_emit_soft_dag. "1,2" deps render as "1, 2"; "none"/"" → no suffix. */
export function emitSoftDag(rows: SoftDagRow[]): string {
  return rows
    .filter((r) => r.step.length > 0)
    .map((r) =>
      r.deps === "none" || r.deps === ""
        ? `${r.step}. ${r.repo} — ${r.desc}`
        : `${r.step}. ${r.repo} — ${r.desc} (depends on ${r.deps.replace(/,/g, ", ")})`,
    )
    .join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dag.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/dag.ts tests/dag.test.ts
git commit -m "feat(score): DAG validator + soft-DAG emitter (round-trip); executor deferred to perform"
```

---

## Task 4: `core/multirepo.ts` — sibling-repo detection

**Files:** Create `src/core/multirepo.ts`; Test `tests/multirepo.test.ts`.
**Behavioral source:** `clone-wars/lib/consult-walk.sh:75-98` (`cw_consult_detect_multi_repo`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/multirepo.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMultiRepo } from "../src/core/multirepo.js";

function repo(root: string, name: string, marker?: "CLAUDE.md" | "AGENTS.md") {
  const d = join(root, name); mkdirSync(d, { recursive: true });
  if (marker) writeFileSync(join(d, marker), "x");
}

describe("detectMultiRepo", () => {
  it("matches siblings with a marker whose slug appears in the corpus (case-insensitive)", () => {
    const root = mkdtempSync(join(tmpdir(), "mr-"));
    repo(root, "api", "CLAUDE.md");
    repo(root, "web", "AGENTS.md");
    repo(root, "infra", "CLAUDE.md");      // present but not in corpus
    repo(root, "nomarker");                 // no marker → skipped
    mkdirSync(join(root, ".hidden"), { recursive: true });
    const hits = detectMultiRepo(root, "We touch the API and the Web frontend");
    expect(hits.map((h) => h.slug).sort()).toEqual(["api", "web"]);
    expect(hits.every((h) => h.marker.endsWith("CLAUDE.md") || h.marker.endsWith("AGENTS.md"))).toBe(true);
  });
  it("zero hits → []", () => {
    const root = mkdtempSync(join(tmpdir(), "mr0-"));
    repo(root, "api", "CLAUDE.md");
    expect(detectMultiRepo(root, "nothing relevant here")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/multirepo.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/multirepo.ts
import { readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface RepoHit { slug: string; marker: string; }

/** Port of cw_consult_detect_multi_repo. Sibling dirs with CLAUDE.md/AGENTS.md whose slug is a
 *  case-insensitive substring of the corpus (= adjudicated.md content). */
export function detectMultiRepo(cwd: string, corpus: string): RepoHit[] {
  const corpusLower = corpus.toLowerCase();
  const hits: RepoHit[] = [];
  let entries: string[];
  try { entries = readdirSync(cwd, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return hits; }
  for (const slug of entries) {
    if (slug.startsWith(".")) continue;
    const dir = join(cwd, slug);
    let marker: string;
    if (existsSync(join(dir, "CLAUDE.md"))) marker = join(dir, "CLAUDE.md");
    else if (existsSync(join(dir, "AGENTS.md"))) marker = join(dir, "AGENTS.md");
    else continue;
    if (!corpusLower.includes(slug.toLowerCase())) continue;
    let abs = marker;
    try { abs = join(realpathSync(dir), marker.slice(dir.length + 1)); } catch { /* keep marker */ }
    hits.push({ slug, marker: abs });
  }
  return hits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/multirepo.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/multirepo.ts tests/multirepo.test.ts
git commit -m "feat(score): detectMultiRepo sibling-scan"
```

---

## Task 5: `core/scoreWalk.ts` — walk resume state + audit-issue routing

**Files:** Create `src/core/scoreWalk.ts`; Test `tests/score-walk.test.ts`.
**Behavioral source:** `clone-wars/lib/consult-walk.sh:18-33` (`cw_consult_audit_issue_to_section`) + `:106-129` (`cw_consult_walk_section_state`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/score-walk.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkSectionState, auditIssueToSection } from "../src/core/scoreWalk.js";

describe("auditIssueToSection", () => {
  it("maps each known issue code", () => {
    expect(auditIssueToSection("no_goal_section")).toBe("goal");
    expect(auditIssueToSection("no_arch_section")).toBe("architecture");
    expect(auditIssueToSection("no_testing_section")).toBe("testing");
    expect(auditIssueToSection("no_success_section")).toBe("success-criteria");
    expect(auditIssueToSection("tbd_marker")).toBe("ASK");
    expect(auditIssueToSection("todo_marker")).toBe("ASK");
    expect(auditIssueToSection("target_subproject_when_invalid")).toBe("header");
    expect(auditIssueToSection("execution_dag_not_parseable")).toBe("execution-dag");
    expect(auditIssueToSection("unresolved_placeholder")).toBe("architecture");
    expect(auditIssueToSection("something_unknown")).toBe("");
  });
});

describe("walkSectionState", () => {
  it("names sorted; --with-status detects _(skipped)_ vs approved", () => {
    const dir = mkdtempSync(join(tmpdir(), "walk-"));
    writeFileSync(join(dir, "goal.md"), "## Goal\n\nreal content\n");
    writeFileSync(join(dir, "components.md"), "_(skipped)_\n");
    expect(walkSectionState(dir)).toEqual(["components", "goal"]);
    expect(walkSectionState(dir, { withStatus: true })).toEqual([
      { name: "components", status: "skipped" },
      { name: "goal", status: "approved" },
    ]);
  });
  it("missing dir → []", () => { expect(walkSectionState("/no/such/dir")).toEqual([]); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/score-walk.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/scoreWalk.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Port of cw_consult_audit_issue_to_section. Section name | "ASK" | "header" | "" (unknown). */
export function auditIssueToSection(key: string): string {
  switch (key) {
    case "no_goal_section": return "goal";
    case "no_arch_section": return "architecture";
    case "no_testing_section": return "testing";
    case "no_success_section": return "success-criteria";
    case "tbd_marker": case "todo_marker": case "fill_in_later_marker": case "to_be_determined_marker": return "ASK";
    case "target_subproject_when_invalid": return "header";
    case "execution_dag_not_parseable": return "execution-dag";
    case "unresolved_placeholder": return "architecture";
    default: return "";
  }
}

export interface SectionStatus { name: string; status: "approved" | "skipped"; }

/** Port of cw_consult_walk_section_state. Lists *.md basenames (sorted). A draft whose whitespace-
 *  stripped body is exactly "_(skipped)_" is skipped; anything else approved. Missing dir → []. */
export function walkSectionState(dir: string): string[];
export function walkSectionState(dir: string, opts: { withStatus: true }): SectionStatus[];
export function walkSectionState(dir: string, opts?: { withStatus?: boolean }): string[] | SectionStatus[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); }
  catch { return opts?.withStatus ? [] : []; }
  const names = files.map((f) => f.replace(/\.md$/, "")).sort();
  if (!opts?.withStatus) return names;
  return names.map((name) => {
    const body = readFileSync(join(dir, `${name}.md`), "utf8").replace(/\s/g, "");
    return { name, status: body === "_(skipped)_" ? "skipped" : "approved" } as SectionStatus;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/score-walk.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scoreWalk.ts tests/score-walk.test.ts
git commit -m "feat(score): walk resume-state reader + audit-issue→section map"
```

---

## Task 6: `core/scoreDoc.ts` — section model + assembler

**Files:** Create `src/core/scoreDoc.ts`; Test `tests/score-doc.test.ts`.
**Behavioral source:** `clone-wars/bin/consult-walk-assemble.sh:59-95` (section lists, header, per-section concat with `_(missing draft)_`). v0.17 header = `# Title` + (multi/single-sub) `**Date:**` + Target header.

- [ ] **Step 1: Write the failing test**

```ts
// tests/score-doc.test.ts
import { describe, it, expect } from "vitest";
import { SECTIONS_SINGLE, SECTIONS_MULTI, sectionTitle, assembleDoc } from "../src/core/scoreDoc.js";

describe("section model", () => {
  it("single = 6 ordered keys; multi inserts dag + cross-repo between components and testing", () => {
    expect(SECTIONS_SINGLE).toEqual(["problem", "goal", "architecture", "components", "testing", "success-criteria"]);
    expect(SECTIONS_MULTI).toEqual(["problem", "goal", "architecture", "components", "execution-dag", "cross-repo-notes", "testing", "success-criteria"]);
    expect(sectionTitle("execution-dag")).toBe("Execution DAG");
    expect(sectionTitle("success-criteria")).toBe("Success Criteria");
  });
});

describe("assembleDoc", () => {
  const drafts = new Map([["goal", "## Goal\n\ng"], ["architecture", "## Architecture\n\na"]]);
  it("single mode: H1, no header, missing drafts get _(missing draft)_", () => {
    const doc = assembleDoc({ title: "Cache Policy", mode: "single", date: "2026-05-29", targets: [], drafts });
    expect(doc.startsWith("# Cache Policy\n\n")).toBe(true);
    expect(doc).not.toContain("**Date:**");
    expect(doc).toContain("## Goal\n\ng\n");
    expect(doc).toContain("## Problem\n\n_(missing draft)_\n\n");
  });
  it("single-sub: Date + singular Target header", () => {
    const doc = assembleDoc({ title: "X", mode: "single-sub", date: "2026-05-29", targets: ["api"], drafts });
    expect(doc).toContain("**Date:** 2026-05-29\n");
    expect(doc).toContain("**Target Sub-Project:** api\n\n");
  });
  it("multi: Date + plural Target header + 8 sections (DAG + Cross-Repo)", () => {
    const doc = assembleDoc({ title: "X", mode: "multi", date: "2026-05-29", targets: ["api", "web"], drafts });
    expect(doc).toContain("**Target Sub-Project(s):** api, web\n\n");
    expect(doc).toContain("## Execution DAG\n\n_(missing draft)_\n\n");
    expect(doc).toContain("## Cross-Repo Notes\n\n_(missing draft)_\n\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/score-doc.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/scoreDoc.ts
export const SECTIONS_SINGLE = ["problem", "goal", "architecture", "components", "testing", "success-criteria"] as const;
export const SECTIONS_MULTI = ["problem", "goal", "architecture", "components", "execution-dag", "cross-repo-notes", "testing", "success-criteria"] as const;

const TITLES: Record<string, string> = {
  problem: "Problem", goal: "Goal", architecture: "Architecture", components: "Components",
  "execution-dag": "Execution DAG", "cross-repo-notes": "Cross-Repo Notes",
  testing: "Testing", "success-criteria": "Success Criteria",
};
export function sectionTitle(key: string): string { return TITLES[key] ?? key; }

export type DocMode = "single" | "single-sub" | "multi";
export interface AssembleInput { title: string; mode: DocMode; date: string; targets: string[]; drafts: Map<string, string>; }

/** Port of bin/consult-walk-assemble.sh's concat. v0.17 header = H1 + (multi/single-sub) Date + Target. */
export function assembleDoc(input: AssembleInput): string {
  const sections = input.mode === "multi" ? SECTIONS_MULTI : SECTIONS_SINGLE;
  let out = `# ${input.title}\n\n`;
  if (input.mode === "multi") {
    out += `**Date:** ${input.date}\n`;
    out += `**Target Sub-Project(s):** ${input.targets.join(", ")}\n\n`;
  } else if (input.mode === "single-sub") {
    out += `**Date:** ${input.date}\n`;
    out += `**Target Sub-Project:** ${input.targets[0] ?? ""}\n\n`;
  }
  for (const key of sections) {
    const draft = input.drafts.get(key);
    if (draft != null) out += `${draft}\n`;
    else out += `## ${sectionTitle(key)}\n\n_(missing draft)_\n\n`;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/score-doc.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scoreDoc.ts tests/score-doc.test.ts
git commit -m "feat(score): deploy-schema section model + doc assembler (v0.17 header)"
```

---

## Task 7: `core/archive.ts` — add `"score"` to the suite union

**Files:** Modify `src/core/archive.ts`; Test `tests/archive.test.ts` (existing).

- [ ] **Step 1: Write the failing test** (append to `tests/archive.test.ts`)

```ts
import { archiveTopic } from "../src/core/archive.js"; // already imported there; reuse
// In a new test, scaffold a topic dir with a `_score` art dir under a temp CONSORT_HOME,
// call archiveTopic(topic, "score"), and assert the _score dir moved under archive/<hash>/<topic>/_score-<ts>.
```

Concretely add (match the existing archive.test.ts style — it already builds part dirs under a temp home):

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTopic } from "../src/core/archive.js";
import { topicDir, globalRoot, repoHash } from "../src/core/paths.js";

describe("archiveTopic supports the score suite", () => {
  it("moves _score/ into the archive", () => {
    process.env.CONSORT_HOME = mkdtempSync(join(tmpdir(), "arch-score-"));
    const topic = "score-demo";
    const art = join(topicDir(topic), "_score");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "topic.txt"), "x");
    archiveTopic(topic, "score");
    const dest = join(globalRoot(), "archive", repoHash(), topic);
    const moved = existsSync(dest) ? readdirSync(dest).some((n) => n.startsWith("_score-")) : false;
    expect(moved).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/archive.test.ts`
Expected: FAIL — `archiveTopic(topic, "score")` is a type error / the `_score` art dir isn't recognized (suite union lacks `"score"`).

- [ ] **Step 3: Write minimal implementation**

In `src/core/archive.ts`, change the `archiveTopic` signature's suite union to include `"score"`:

```ts
export function archiveTopic(topic: string, suite: "consult" | "deploy" | "meditate" | "score", opts?: { now?: Date }): void {
```

(The body already builds `_${suite}` paths, so `"score"` → `_score` works with no further change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/archive.test.ts`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/core/archive.ts tests/archive.test.ts
git commit -m "feat(archive): add 'score' to archiveTopic suite union"
```

---

## Final gate (after Task 7)

- [ ] Run `npm run typecheck && npm run lint && npm run test` — all clean/green (the 6 new suites + archive + the stale-token gate). Do NOT run `npm run build` (no dispatcher change yet; Phase B wires the command).

---

## Self-Review (run by the plan author — recorded here)

**1. Spec coverage (Phase A modules):** `score.ts` (T1), `audit.ts`+`extractTarget` (T2), `dag.ts` parse/check/emit (T3), `multirepo.ts` (T4), `scoreWalk.ts` walkSectionState+auditIssueToSection (T5), `scoreDoc.ts` section model+assembler (T6), `archiveTopic` `"score"` union (T7). **`scoreDiff.ts` + `scoreAdjudicate.ts` are intentionally deferred** to the companion `score-A2-aggregators` plan (escalation-only; needed by Phase C/D, not B) — documented in "Scope of THIS plan." Spec §5/§7/§10 trust-header note reconciled (v0.17 Date/Target header; spec to be updated).

**2. Placeholder scan:** No TBD/TODO/"implement later"; every code step shows complete code. (The audit module deliberately contains the literal strings "TBD"/"TODO" as markers it scans for — that is content, not a placeholder.)

**3. Type consistency:** `auditDoc` returns `{verdict,issues}` used nowhere else in Phase A (Phase B consumes it). `checkDagSection(docText): boolean` consumed by `auditDoc` (T2↔T3 ordering noted). `parseDagLine` returns `DagNode|null`; `emitSoftDag(SoftDagRow[])` round-trips to it (test-locked). `walkSectionState` overloads (`string[]` vs `SectionStatus[]`) match the test. `assembleDoc` `DocMode` = `"single"|"single-sub"|"multi"` matches `multi-repo.txt` values from the spec. `deriveSlug` re-exported from `solo.ts` (reuse, not redefine). `archiveTopic` suite union extended consistently with the `_${suite}` body.
