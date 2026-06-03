# Rehearsal A1 — Metric Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a rehearsal part's self-reported metric checkable — the part declares a `verify` contract, the trusted Maestro re-runs the scoring step outside the part's pane, and two pure CLI verbs adjudicate a first-class verdict (verified/mismatch/unavailable/pending) into `verification.tsv`.

**Architecture:** Additive only. A new pure core module `src/core/rehearsalVerify.ts` holds all logic (block parse, sha256 provenance, plan, adjudicate, tsv render). The CLI never execs untrusted code: `verify-plan` plans + persists terminal verdicts, the Maestro runs the command via its own Bash tool, `verify-check` adjudicates the run. `computeScore` snapshots a provenance manifest at score-time. `status-brief` joins the verdict tsv. `scoreboard.md` shape is untouched.

**Tech Stack:** TypeScript (Node/ESM), esbuild single-bundle `dist/consort.cjs`, vitest. `node:crypto` for sha256 (no new dep).

**Spec:** `docs/superpowers/specs/2026-06-03-rehearsal-a1-metric-trust-design.md`.

**Refinements over the spec (discovered during planning):**
1. Verbs take `<topic> <instrument> <exp-id>` (exp-ids repeat across parts — the score test has both `viola` and `cello` at `exp-001`).
2. `verify-check` takes `--stdout-file <path>` (the Maestro tees the command's stdout) and parses the `VERIFY_METRIC=` marker **mechanically** in the CLI, rather than trusting a Maestro-parsed `--recomputed`. More robust, same intent.
3. Provenance hashes the **utf8 content** of inputs (both `computeScore` and `verify-plan` read utf8, so the comparison is consistent). Adequate for the common text/JSON artifacts; a documented limitation for binary inputs.

**Conventions to follow (existing patterns):** pure core + verb-applies-plan (mirror `computeScore`/`scoreWith` in `src/core/rehearsalScore.ts` + `src/commands/rehearsal.ts:520`); errors to `log.error` (stderr); atomic writes via `atomicWrite` (`src/core/atomic.ts`); paths via `rehearsalArtDir`/`experimentDir` (`src/core/rehearsal.ts`); timestamps via `isoUtc` (`src/core/archive.js`). No emojis in shipped output. Run gates with `npm run typecheck`, `npm run test`, `npm run lint`, `npm run build`.

---

### Task 1: Verify core — block parse, adjudicate, marker, tsv render

**Files:**
- Create: `src/core/rehearsalVerify.ts`
- Test: `tests/rehearsal-verify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/rehearsal-verify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseVerifyBlock, checkVerify, recomputedFromOutput, verificationRow,
} from "../src/core/rehearsalVerify.js";

describe("parseVerifyBlock", () => {
  it("extracts a valid block", () => {
    const b = parseVerifyBlock({ verify: { kind: "rescore", command: "python s.py", inputs: ["./p.json"], metric_from: "marker" } });
    expect(b).toEqual({ kind: "rescore", command: "python s.py", inputs: ["./p.json"], metric_from: "marker" });
  });
  it("returns undefined for absent/malformed/bad-kind", () => {
    expect(parseVerifyBlock({})).toBeUndefined();
    expect(parseVerifyBlock({ verify: 7 })).toBeUndefined();
    expect(parseVerifyBlock({ verify: { kind: "weird" } })).toBeUndefined();
  });
  it("keeps kind=none with no command", () => {
    expect(parseVerifyBlock({ verify: { kind: "none" } })).toEqual({ kind: "none" });
  });
});

describe("checkVerify", () => {
  it("verified within epsilon", () => {
    expect(checkVerify({ recomputed: 0.901, runFailed: false, reported: 0.9, epsilon: 0.01 }))
      .toEqual({ verdict: "verified", reason: "" });
  });
  it("mismatch beyond epsilon", () => {
    expect(checkVerify({ recomputed: 0.8, runFailed: false, reported: 0.9, epsilon: 0.01 }).verdict).toBe("mismatch");
  });
  it("run-failed -> mismatch", () => {
    expect(checkVerify({ recomputed: null, runFailed: true, reported: 0.9, epsilon: 0.01 }))
      .toEqual({ verdict: "mismatch", reason: "rerun-failed" });
  });
  it("no marker / no reported -> mismatch", () => {
    expect(checkVerify({ recomputed: null, runFailed: false, reported: 0.9, epsilon: 0.01 }).reason).toBe("no-marker");
    expect(checkVerify({ recomputed: 0.9, runFailed: false, reported: null, epsilon: 0.01 }).reason).toBe("no-reported");
  });
});

describe("recomputedFromOutput", () => {
  it("parses the LAST VERIFY_METRIC marker on stdout", () => {
    expect(recomputedFromOutput("noise\nVERIFY_METRIC=0.5\nVERIFY_METRIC=0.93\n", "marker", () => null)).toBe(0.93);
  });
  it("returns null when no marker", () => {
    expect(recomputedFromOutput("just logs\n", "marker", () => null)).toBeNull();
  });
  it("reads metric_value from a declared json file", () => {
    expect(recomputedFromOutput("", "./verify-out.json", () => JSON.stringify({ metric_value: 0.77 }))).toBe(0.77);
    expect(recomputedFromOutput("", "./verify-out.json", () => "not json")).toBeNull();
  });
});

describe("verificationRow", () => {
  it("renders a 6-col tsv row", () => {
    expect(verificationRow({ expId: "exp-001", instrument: "viola", verdict: "verified", reason: "", recomputed: "0.93", ts: "T" }))
      .toBe("exp-001\tviola\tverified\t\t0.93\tT\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rehearsal-verify.test.ts`
Expected: FAIL — `Cannot find module '../src/core/rehearsalVerify.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/rehearsalVerify.ts`:

```ts
// Metric-trust (verify-by-re-execution) pure logic for /consort:rehearsal (research-validity A1).
// The harness re-runs the part's declared scoring step OUTSIDE the part's pane and adjudicates a
// verdict. Pure: FS access is injected; the verbs apply the returned plan/rows.
import { createHash } from "node:crypto";

export type Verdict = "verified" | "mismatch" | "unavailable" | "pending";

export interface VerifyBlock {
  kind: "rescore" | "rerun" | "none";
  command?: string;
  inputs?: string[];
  metric_from?: string;
}

/** Pull a valid verify block out of a parsed result.json; undefined if absent/malformed/bad-kind. */
export function parseVerifyBlock(result: Record<string, unknown>): VerifyBlock | undefined {
  const v = result.verify;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind !== "rescore" && o.kind !== "rerun" && o.kind !== "none") return undefined;
  const block: VerifyBlock = { kind: o.kind };
  if (typeof o.command === "string") block.command = o.command;
  if (Array.isArray(o.inputs)) block.inputs = o.inputs.filter((x): x is string => typeof x === "string");
  if (typeof o.metric_from === "string") block.metric_from = o.metric_from;
  return block;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MARKER_RE = /^VERIFY_METRIC=(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;

/** Recomputed metric from the command's captured stdout (marker) or a JSON file it wrote. */
export function recomputedFromOutput(
  stdout: string, metricFrom: string, readJson: (path: string) => string | null,
): number | null {
  if (metricFrom === "marker") {
    const lines = stdout.split("\n").map((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(MARKER_RE);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }
  const raw = readJson(metricFrom);
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return typeof o.metric_value === "number" ? o.metric_value : null;
  } catch { return null; }
}

export function checkVerify(opts: {
  recomputed: number | null; runFailed: boolean; reported: number | null; epsilon: number;
}): { verdict: Verdict; reason: string } {
  if (opts.runFailed) return { verdict: "mismatch", reason: "rerun-failed" };
  if (opts.recomputed === null) return { verdict: "mismatch", reason: "no-marker" };
  if (opts.reported === null) return { verdict: "mismatch", reason: "no-reported" };
  if (Math.abs(opts.recomputed - opts.reported) <= opts.epsilon) return { verdict: "verified", reason: "" };
  return { verdict: "mismatch", reason: `value:${opts.recomputed}vs${opts.reported}` };
}

export interface VerificationRow {
  expId: string; instrument: string; verdict: Verdict; reason: string; recomputed: string; ts: string;
}
export const VERIFICATION_TSV_HEADER = "exp_id\tinstrument\tverdict\treason\trecomputed\tts\n";
export function verificationRow(r: VerificationRow): string {
  return `${r.expId}\t${r.instrument}\t${r.verdict}\t${r.reason}\t${r.recomputed}\t${r.ts}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rehearsal-verify.test.ts`
Expected: PASS (4 describes).

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalVerify.ts tests/rehearsal-verify.test.ts
git commit -m "feat(rehearsal): verify core — block parse, adjudicate, marker, tsv (A1)"
```

---

### Task 2: Verify core — provenance manifest + planVerify

**Files:**
- Modify: `src/core/rehearsalVerify.ts`
- Test: `tests/rehearsal-verify.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/rehearsal-verify.test.ts`)

```ts
import { buildManifest, planVerify, type VerifyManifest } from "../src/core/rehearsalVerify.js";

describe("buildManifest", () => {
  it("hashes command + inputs; null for kind=none/no-command", () => {
    const read = (rel: string) => (rel === "./p.json" ? "PREDS" : null);
    const m = buildManifest({ kind: "rescore", command: "c", inputs: ["./p.json", "./missing"] }, read)!;
    expect(m.command).toBe("c");
    expect(Object.keys(m.hashes)).toEqual(["./p.json"]); // missing input skipped at snapshot
    expect(buildManifest({ kind: "none" }, read)).toBeNull();
  });
});

describe("planVerify", () => {
  const read = (rel: string) => (rel === "./p.json" ? "PREDS" : null);
  const manifest: VerifyManifest = { command: "c", hashes: { "./p.json": "" } };
  // fix the hash to the real one
  const fixed = (): VerifyManifest => buildManifest({ kind: "rescore", command: "c", inputs: ["./p.json"] }, read)!;

  it("no block -> unavailable no-contract", () => {
    expect(planVerify({ block: undefined, manifest: null, authorizeRerun: false, readInput: read }))
      .toEqual({ run: false, verdict: "unavailable", reason: "no-contract" });
  });
  it("kind=none -> unavailable part-declined", () => {
    expect(planVerify({ block: { kind: "none" }, manifest: null, authorizeRerun: false, readInput: read }).reason).toBe("part-declined");
  });
  it("rerun without authorization -> pending rerun-deferred", () => {
    expect(planVerify({ block: { kind: "rerun", command: "c" }, manifest: fixed(), authorizeRerun: false, readInput: read }))
      .toEqual({ run: false, verdict: "pending", reason: "rerun-deferred" });
  });
  it("no manifest -> unavailable no-manifest", () => {
    expect(planVerify({ block: { kind: "rescore", command: "c", inputs: ["./p.json"] }, manifest: null, authorizeRerun: false, readInput: read }).reason).toBe("no-manifest");
  });
  it("provenance hash change -> mismatch", () => {
    const tampered = (rel: string) => (rel === "./p.json" ? "DIFFERENT" : null);
    expect(planVerify({ block: { kind: "rescore", command: "c", inputs: ["./p.json"] }, manifest: fixed(), authorizeRerun: false, readInput: tampered }))
      .toEqual({ run: false, verdict: "mismatch", reason: "provenance:./p.json" });
  });
  it("clean -> run with command + metricFrom default marker", () => {
    expect(planVerify({ block: { kind: "rescore", command: "c", inputs: ["./p.json"] }, manifest: fixed(), authorizeRerun: false, readInput: read }))
      .toEqual({ run: true, command: "c", metricFrom: "marker" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rehearsal-verify.test.ts -t "buildManifest|planVerify"`
Expected: FAIL — `buildManifest`/`planVerify` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/core/rehearsalVerify.ts`)

```ts
export interface VerifyManifest { command: string; hashes: Record<string, string>; }

/** Snapshot command + sha256(inputs utf8) at score-time. null when kind=none / no command. */
export function buildManifest(block: VerifyBlock, readInput: (rel: string) => string | null): VerifyManifest | null {
  if (block.kind === "none" || !block.command) return null;
  const hashes: Record<string, string> = {};
  for (const rel of block.inputs ?? []) {
    const c = readInput(rel);
    if (c !== null) hashes[rel] = hashContent(c);
  }
  return { command: block.command, hashes };
}

export type VerifyPlan =
  | { run: false; verdict: Verdict; reason: string }
  | { run: true; command: string; metricFrom: string };

export interface PlanInput {
  block: VerifyBlock | undefined;
  manifest: VerifyManifest | null;
  authorizeRerun: boolean;
  readInput: (rel: string) => string | null;
}

export function planVerify(p: PlanInput): VerifyPlan {
  const b = p.block;
  if (!b || b.kind === "none" || !b.command) {
    return { run: false, verdict: "unavailable", reason: b ? "part-declined" : "no-contract" };
  }
  if (b.kind === "rerun" && !p.authorizeRerun) return { run: false, verdict: "pending", reason: "rerun-deferred" };
  if (p.manifest === null) return { run: false, verdict: "unavailable", reason: "no-manifest" };
  for (const rel of b.inputs ?? []) {
    const c = p.readInput(rel);
    if (c === null) return { run: false, verdict: "unavailable", reason: `missing-input:${rel}` };
    if (hashContent(c) !== p.manifest.hashes[rel]) return { run: false, verdict: "mismatch", reason: `provenance:${rel}` };
  }
  return { run: true, command: b.command, metricFrom: b.metric_from ?? "marker" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rehearsal-verify.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalVerify.ts tests/rehearsal-verify.test.ts
git commit -m "feat(rehearsal): verify core — provenance manifest + planVerify (A1)"
```

---

### Task 3: metric.md — parse `verify_epsilon`

**Files:**
- Modify: `src/core/rehearsalMetric.ts` (interface `MetricThresholds` ~line 62; `parseMetricMd` ~line 71)
- Test: `tests/rehearsal-core.test.ts` (in the `describe("parseMetricMd round-trips ...")` block)

- [ ] **Step 1: Write the failing test** (add an `it` inside the existing `parseMetricMd` describe)

```ts
  it("parses verify_epsilon; undefined when absent", () => {
    expect(parseMetricMd("**Primary metric:** acc\n**verify_epsilon:** 0.005\n").verifyEpsilon).toBe(0.005);
    expect(parseMetricMd("**Primary metric:** acc\n").verifyEpsilon).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rehearsal-core.test.ts -t "verify_epsilon"`
Expected: FAIL — `verifyEpsilon` is `undefined` → first assert fails (and TS: property absent).

- [ ] **Step 3: Write minimal implementation**

In `MetricThresholds` (after `direction?: ...`):
```ts
  /** optional metric.md `**verify_epsilon:**` for A1 verify-by-re-execution; default 0.01 in callers. */
  verifyEpsilon?: number;
```

In `parseMetricMd`, add a local near the other `let`s:
```ts
  let verifyEpsilon: number | undefined;
```
Add a parse branch alongside the others:
```ts
    else if ((m = line.match(/^\*\*verify_epsilon:\*\*\s+(.*)$/))) { const n = parseFloat(m[1].trim()); if (!Number.isNaN(n)) verifyEpsilon = n; }
```
Add `verifyEpsilon` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rehearsal-core.test.ts -t "verify_epsilon"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalMetric.ts tests/rehearsal-core.test.ts
git commit -m "feat(rehearsal): parse metric.md verify_epsilon (A1)"
```

---

### Task 4: score pass — snapshot `verify-manifest.json` once

**Files:**
- Modify: `src/core/rehearsalScore.ts` (`ScoreComputation` ~line 30; `computeScore` ~line 44; return ~line 97)
- Modify: `src/commands/rehearsal.ts` (`scoreWith` apply loop, line 533-539)
- Test: `tests/rehearsal-core.test.ts` (in the `computeScore` describe)

- [ ] **Step 1: Write the failing test** (add an `it` in the `computeScore` describe block)

```ts
  it("computeScore snapshots verify-manifest.json once for a verify-bearing result", () => {
    const files: Record<string, string> = {
      "/a/metric.md": "**Primary metric:** accuracy\n",
      "/a/parts/viola/state.txt": "current_exp_id=exp-001\n",
      "/a/parts/viola/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"x",metric_name:"accuracy",metric_value:0.9,status:"ok",
        runtime_s:1,log_paths:[],checkpoint_path:null,notes:"",
        verify:{ kind:"rescore", command:"python s.py", inputs:["./preds.json"], metric_from:"marker" } }),
      "/a/parts/viola/experiments/exp-001/preds.json": "PREDS",
    };
    const c = computeScore("/a", fakeFs(files), () => "T");
    const man = c.manifests.find((m) => m.path === "/a/parts/viola/experiments/exp-001/verify-manifest.json");
    expect(man).toBeDefined();
    expect(JSON.parse(man!.body)).toMatchObject({ command: "python s.py" });
    expect(JSON.parse(man!.body).hashes["./preds.json"]).toMatch(/^[0-9a-f]{64}$/);
  });
  it("computeScore writes no manifest when one already exists (idempotent)", () => {
    const files: Record<string, string> = {
      "/a/metric.md": "**Primary metric:** accuracy\n",
      "/a/parts/viola/state.txt": "current_exp_id=exp-001\n",
      "/a/parts/viola/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"x",metric_name:"accuracy",metric_value:0.9,status:"ok",
        runtime_s:1,log_paths:[],checkpoint_path:null,notes:"",
        verify:{ kind:"rescore", command:"c", inputs:[], metric_from:"marker" } }),
      "/a/parts/viola/experiments/exp-001/verify-manifest.json": "{\"command\":\"c\",\"hashes\":{}}\n",
    };
    expect(computeScore("/a", fakeFs(files), () => "T").manifests).toHaveLength(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rehearsal-core.test.ts -t "verify-manifest"`
Expected: FAIL — `c.manifests` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/rehearsalScore.ts`:
- add import: `import { parseVerifyBlock, buildManifest } from "./rehearsalVerify.js";`
- add to `ScoreComputation`: `manifests: { path: string; body: string }[];`
- declare in `computeScore` near the other accumulators: `const manifests: { path: string; body: string }[] = [];`
- inside the loop, right after the existing `rows.push(...)` / `tsvRows.push(...)` block (after validation passed), add:
```ts
      const vblock = parseVerifyBlock(o);
      if (vblock && vblock.kind !== "none" && vblock.command) {
        const manifestPath = join(branchDir, "verify-manifest.json");
        if (!fs.exists(manifestPath)) {
          const manifest = buildManifest(vblock, (rel) => fs.read(join(branchDir, rel)));
          if (manifest) manifests.push({ path: manifestPath, body: JSON.stringify(manifest) + "\n" });
        }
      }
```
- add `manifests` to the returned object:
```ts
  return { scoreboardMd: buildScoreboard(rows, parsed?.direction), resultsTsv: buildResultsTsv(tsvRows),
    sidecars, staleSidecars, phaseClears, warnings, manifests };
```

In `src/commands/rehearsal.ts` `scoreWith`, after the `phaseClears` write loop (line 538), add:
```ts
  for (const m of c.manifests) deps.writeAtomic(m.path, m.body);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rehearsal-core.test.ts -t "verify-manifest"`
Then full file: `npx vitest run tests/rehearsal-core.test.ts`
Expected: PASS; no regressions (existing computeScore tests still green — they have no verify block, so `manifests` is `[]`).

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalScore.ts src/commands/rehearsal.ts tests/rehearsal-core.test.ts
git commit -m "feat(rehearsal): snapshot verify-manifest.json at score-time (A1)"
```

---

### Task 5: CLI verb — `verify-plan`

**Files:**
- Modify: `src/commands/rehearsal.ts` (add verb fn + live deps + dispatch in `run()` ~line 1508; usage string ~line 44)
- Test: `tests/rehearsal-cmd.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/rehearsal-cmd.test.ts`; reuse its `tmpHome`/`CONSORT_HOME` pattern — see existing tests in the file for the exact helper)

```ts
import { createHash } from "node:crypto";
import { verifyPlanWith, type VerifyPlanDeps } from "../src/commands/rehearsal.js";

describe("rehearsal verify-plan", () => {
  const baseResult = { metric_value: 0.9, verify: { kind: "rescore", command: "python s.py", inputs: ["./p.json"], metric_from: "marker" } };
  const manifestFor = (preds: string) => ({ command: "python s.py", hashes: { "./p.json": createHash("sha256").update(preds).digest("hex") } });

  function deps(over: Partial<VerifyPlanDeps>): { d: VerifyPlanDeps; rows: any[]; out: string[] } {
    const rows: any[] = []; const out: string[] = [];
    const d: VerifyPlanDeps = {
      readResult: () => baseResult,
      readManifest: () => manifestFor("PREDS"),
      readInput: () => "PREDS",
      writeRow: (_a, _i, _e, r) => { rows.push(r); },
      now: () => "T",
      stdout: (l) => out.push(l),
      ...over,
    };
    return { d, rows, out };
  }

  it("clean -> emits RUN_CMD, persists nothing", async () => {
    const { d, rows, out } = deps({});
    expect(await verifyPlanWith(["topic", "viola", "exp-001"], d)).toBe(0);
    expect(out.some((l) => l.startsWith("RUN_CMD=python s.py"))).toBe(true);
    expect(out.some((l) => l.startsWith("METRIC_FROM=marker"))).toBe(true);
    expect(rows).toHaveLength(0);
  });
  it("provenance change -> persists mismatch, no RUN_CMD", async () => {
    const { d, rows, out } = deps({ readInput: () => "TAMPERED" });
    await verifyPlanWith(["topic", "viola", "exp-001"], d);
    expect(rows[0]).toMatchObject({ verdict: "mismatch", reason: "provenance:./p.json" });
    expect(out.some((l) => l.startsWith("RUN_CMD"))).toBe(false);
  });
  it("rerun without --authorize-rerun -> pending", async () => {
    const { d, rows } = deps({ readResult: () => ({ metric_value: 1, verify: { kind: "rerun", command: "c" } }) });
    await verifyPlanWith(["topic", "viola", "exp-001"], d);
    expect(rows[0]).toMatchObject({ verdict: "pending", reason: "rerun-deferred" });
  });
  it("missing result -> rc 1", async () => {
    const { d } = deps({ readResult: () => null });
    expect(await verifyPlanWith(["topic", "viola", "exp-001"], d)).toBe(1);
  });
  it("bad arity -> rc 2", async () => {
    const { d } = deps({});
    expect(await verifyPlanWith(["topic", "viola"], d)).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rehearsal-cmd.test.ts -t "verify-plan"`
Expected: FAIL — `verifyPlanWith` not exported.

- [ ] **Step 3: Write minimal implementation** (add to `src/commands/rehearsal.ts`; place near the other verb fns, e.g. after `dropPartWith`)

Add imports at the top of the file (alongside existing core imports):
```ts
import { parseVerifyBlock, planVerify, checkVerify, recomputedFromOutput, buildManifest, verificationRow, VERIFICATION_TSV_HEADER, type VerifyManifest, type VerificationRow } from "../core/rehearsalVerify.js";
```
(Task 6 uses `checkVerify`/`recomputedFromOutput`; importing them now is fine.)

```ts
// ---- A1: verify-plan — plan the harness re-execution + persist terminal verdicts ----
export interface VerifyPlanDeps {
  readResult(art: string, instrument: string, expId: string): Record<string, unknown> | null;
  readManifest(art: string, instrument: string, expId: string): VerifyManifest | null;
  readInput(art: string, instrument: string, expId: string, rel: string): string | null;
  writeRow(art: string, instrument: string, expId: string, row: VerificationRow): void;
  now(): string;
  stdout?: (l: string) => void;
  opts?: PathOpts;
}

export async function verifyPlanWith(args: string[], deps: VerifyPlanDeps): Promise<number> {
  const authorize = args.includes("--authorize-rerun");
  const pos = args.filter((a) => !a.startsWith("--"));
  if (pos.length !== 3) { log.error("rehearsal verify-plan: usage: <topic> <instrument> <exp-id> [--authorize-rerun]"); return 2; }
  const [topic, instrument, expId] = pos;
  const art = rehearsalArtDir(topic, deps.opts);
  const result = deps.readResult(art, instrument, expId);
  if (result === null) { log.error(`rehearsal verify-plan: result.json missing for ${instrument}/${expId}`); return 1; }
  const block = parseVerifyBlock(result);
  const manifest = deps.readManifest(art, instrument, expId);
  const plan = planVerify({ block, manifest, authorizeRerun: authorize, readInput: (rel) => deps.readInput(art, instrument, expId, rel) });
  const out = deps.stdout ?? ((l: string): void => { process.stdout.write(l + "\n"); });
  if (!plan.run) {
    deps.writeRow(art, instrument, expId, { expId, instrument, verdict: plan.verdict, reason: plan.reason, recomputed: "", ts: deps.now() });
    out(`VERDICT=${plan.verdict} reason=${plan.reason}`);
    return 0;
  }
  out(`RUN_CWD=${experimentDir(art, instrument, expId)}`);
  out(`RUN_CMD=${plan.command}`);
  out(`METRIC_FROM=${plan.metricFrom}`);
  return 0;
}
```

Add the live deps + a shared row-writer (used by both verbs) near the other `live*Deps`:
```ts
function appendVerificationRow(art: string, instrument: string, expId: string, row: VerificationRow): void {
  const tsv = join(art, "verification.tsv");
  const prior = existsSync(tsv) ? readFileSync(tsv, "utf8") : VERIFICATION_TSV_HEADER;
  atomicWrite(tsv, prior + verificationRow(row));
  atomicWrite(join(experimentDir(art, instrument, expId), "verification.txt"),
    `${row.verdict} reason=${row.reason} recomputed=${row.recomputed} at ${row.ts}\n`);
}
const liveVerifyPlanDeps: VerifyPlanDeps = {
  readResult: (art, i, e) => { const p = join(experimentDir(art, i, e), "result.json"); if (!existsSync(p)) return null; try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { return null; } },
  readManifest: (art, i, e) => { const p = join(experimentDir(art, i, e), "verify-manifest.json"); if (!existsSync(p)) return null; try { return JSON.parse(readFileSync(p, "utf8")) as VerifyManifest; } catch { return null; } },
  readInput: (art, i, e, rel) => { const p = join(experimentDir(art, i, e), rel); return existsSync(p) ? readFileSync(p, "utf8") : null; },
  writeRow: appendVerificationRow,
  now: () => isoUtc(),
};
```

In `run()` switch (near `case "drop-part"`):
```ts
    case "verify-plan": return verifyPlanWith(rest, liveVerifyPlanDeps);
```

Update the `usage()` string (line 44) to include `verify-plan|verify-check` in the verb list.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rehearsal-cmd.test.ts -t "verify-plan"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/rehearsal.ts tests/rehearsal-cmd.test.ts
git commit -m "feat(rehearsal): verify-plan verb (A1)"
```

---

### Task 6: CLI verb — `verify-check`

**Files:**
- Modify: `src/commands/rehearsal.ts` (verb fn + live deps + dispatch + usage already updated in Task 5)
- Test: `tests/rehearsal-cmd.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/rehearsal-cmd.test.ts`)

```ts
import { verifyCheckWith, type VerifyCheckDeps } from "../src/commands/rehearsal.js";

describe("rehearsal verify-check", () => {
  function deps(over: Partial<VerifyCheckDeps>): { d: VerifyCheckDeps; rows: any[]; out: string[] } {
    const rows: any[] = []; const out: string[] = [];
    const d: VerifyCheckDeps = {
      readResult: () => ({ metric_value: 0.9, verify: { kind: "rescore", command: "c", metric_from: "marker" } }),
      readMetricMd: () => "**Primary metric:** accuracy\n",
      readStdout: () => "VERIFY_METRIC=0.901\n",
      readJson: () => null,
      writeRow: (_a, _i, _e, r) => rows.push(r),
      now: () => "T",
      stdout: (l) => out.push(l),
      ...over,
    };
    return { d, rows, out };
  }
  it("recomputed within epsilon -> verified", async () => {
    const { d, rows } = deps({});
    expect(await verifyCheckWith(["topic", "viola", "exp-001", "--stdout-file", "/x"], d)).toBe(0);
    expect(rows[0]).toMatchObject({ verdict: "verified" });
  });
  it("beyond epsilon -> mismatch", async () => {
    const { d, rows } = deps({ readStdout: () => "VERIFY_METRIC=0.5\n" });
    await verifyCheckWith(["topic", "viola", "exp-001", "--stdout-file", "/x"], d);
    expect(rows[0].verdict).toBe("mismatch");
  });
  it("--run-failed -> mismatch rerun-failed", async () => {
    const { d, rows } = deps({});
    await verifyCheckWith(["topic", "viola", "exp-001", "--run-failed"], d);
    expect(rows[0]).toMatchObject({ verdict: "mismatch", reason: "rerun-failed" });
  });
  it("honors metric.md verify_epsilon", async () => {
    const { d, rows } = deps({ readMetricMd: () => "**Primary metric:** accuracy\n**verify_epsilon:** 0.2\n", readStdout: () => "VERIFY_METRIC=0.75\n" });
    await verifyCheckWith(["topic", "viola", "exp-001", "--stdout-file", "/x"], d);
    expect(rows[0].verdict).toBe("verified"); // |0.75-0.9|=0.15 <= 0.2
  });
  it("missing --stdout-file and no --run-failed -> rc 2", async () => {
    const { d } = deps({});
    expect(await verifyCheckWith(["topic", "viola", "exp-001"], d)).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rehearsal-cmd.test.ts -t "verify-check"`
Expected: FAIL — `verifyCheckWith` not exported.

- [ ] **Step 3: Write minimal implementation** (add to `src/commands/rehearsal.ts`, after `verifyPlanWith`)

```ts
// ---- A1: verify-check — adjudicate the harness re-execution into a verdict ----
export interface VerifyCheckDeps {
  readResult(art: string, instrument: string, expId: string): Record<string, unknown> | null;
  readMetricMd(art: string): string | null;
  readStdout(path: string): string | null;
  readJson(path: string): string | null;
  writeRow(art: string, instrument: string, expId: string, row: VerificationRow): void;
  now(): string;
  stdout?: (l: string) => void;
  opts?: PathOpts;
}

export async function verifyCheckWith(args: string[], deps: VerifyCheckDeps): Promise<number> {
  const runFailed = args.includes("--run-failed");
  let stdoutFile: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stdout-file") { stdoutFile = args[++i]; }
    else if (args[i] === "--run-failed") { /* flag */ }
    else if (!args[i].startsWith("--")) pos.push(args[i]);
  }
  if (pos.length !== 3) { log.error("rehearsal verify-check: usage: <topic> <instrument> <exp-id> (--stdout-file <path> | --run-failed)"); return 2; }
  if (!runFailed && stdoutFile === undefined) { log.error("rehearsal verify-check: need --stdout-file <path> or --run-failed"); return 2; }
  const [topic, instrument, expId] = pos;
  const art = rehearsalArtDir(topic, deps.opts);
  const result = deps.readResult(art, instrument, expId);
  if (result === null) { log.error(`rehearsal verify-check: result.json missing for ${instrument}/${expId}`); return 1; }
  const reported = typeof result.metric_value === "number" ? result.metric_value : null;
  const block = parseVerifyBlock(result);
  const metricFrom = block?.metric_from ?? "marker";
  const md = deps.readMetricMd(art);
  const epsilon = (md ? parseMetricMd(md).verifyEpsilon : undefined) ?? 0.01;

  let recomputed: number | null = null;
  if (!runFailed) {
    const stdout = stdoutFile ? deps.readStdout(stdoutFile) : null;
    recomputed = stdout === null ? null : recomputedFromOutput(stdout, metricFrom, (p) => deps.readJson(join(experimentDir(art, instrument, expId), p)));
  }
  const { verdict, reason } = checkVerify({ recomputed, runFailed, reported, epsilon });
  deps.writeRow(art, instrument, expId, { expId, instrument, verdict, reason, recomputed: recomputed === null ? "" : String(recomputed), ts: deps.now() });
  const out = deps.stdout ?? ((l: string): void => { process.stdout.write(l + "\n"); });
  out(`VERDICT=${verdict} reason=${reason}`);
  return 0;
}
```

Add live deps near `liveVerifyPlanDeps`:
```ts
const liveVerifyCheckDeps: VerifyCheckDeps = {
  readResult: liveVerifyPlanDeps.readResult,
  readMetricMd: (art) => { const p = join(art, "metric.md"); return existsSync(p) ? readFileSync(p, "utf8") : null; },
  readStdout: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  readJson: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  writeRow: appendVerificationRow,
  now: () => isoUtc(),
};
```

In `run()` switch:
```ts
    case "verify-check": return verifyCheckWith(rest, liveVerifyCheckDeps);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rehearsal-cmd.test.ts -t "verify-check"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/rehearsal.ts tests/rehearsal-cmd.test.ts
git commit -m "feat(rehearsal): verify-check verb (A1)"
```

---

### Task 7: status-brief — annotate top-3 with the verdict

**Files:**
- Modify: `src/core/rehearsalBrief.ts` (`StatusBriefInput` ~line 18; the scoreboard top-3 render ~line 66-80)
- Modify: `src/commands/rehearsal.ts` (`statusBriefWith` — pass the parsed verification map; find it via `grep -n "statusBriefWith" src/commands/rehearsal.ts`)
- Test: `tests/rehearsal-core.test.ts` (the `buildStatusBrief` describe)

- [ ] **Step 1: Write the failing test** (add an `it` in the existing `buildStatusBrief`/status-brief describe; if none, create one near the other rehearsal-core describes)

```ts
import { buildStatusBrief } from "../src/core/rehearsalBrief.js";

describe("buildStatusBrief verify annotation", () => {
  const sb = [
    "<!-- scoreboard schema_version=2 -->", "# Scoreboard", "",
    "| Rank | Experiment | Instrument | Metric | Status | Runtime | Approach | metric_name |",
    "|---|---|---|---|---|---|---|---|",
    "| 1 | exp-002 | viola | 0.9600 | ok | 1.00s | b | accuracy |",
    "| 2 | exp-001 | oboe | 0.9000 | ok | 1.00s | a | accuracy |",
  ].join("\n") + "\n";
  it("annotates each top row with its verdict from the verification map", () => {
    const out = buildStatusBrief({
      parts: [], scoreboardMd: sb, completion: null,
      verdicts: { "viola/exp-002": "verified", "oboe/exp-001": "mismatch" },
    });
    expect(out).toMatch(/exp-002 — 0\.9600 — accuracy \[verified\]/);
    expect(out).toMatch(/exp-001 — 0\.9000 — accuracy \[mismatch!\]/);
  });
  it("omits the annotation when no verdicts map is given (back-compat)", () => {
    const out = buildStatusBrief({ parts: [], scoreboardMd: sb, completion: null });
    expect(out).toContain("exp-002 — 0.9600 — accuracy");
    expect(out).not.toContain("[");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rehearsal-core.test.ts -t "verify annotation"`
Expected: FAIL — `verdicts` not on `StatusBriefInput`; no annotation rendered.

- [ ] **Step 3: Write minimal implementation**

In `src/core/rehearsalBrief.ts`:
- add to `StatusBriefInput`:
```ts
  /** instrument/exp -> verdict, joined from verification.tsv; omit for back-compat (no annotation). */
  verdicts?: Record<string, string>;
```
- in the top-3 render loop, change the row push to append the annotation:
```ts
      for (const r of rows) {
        const v = input.verdicts?.[`${r.instrument}/${r.exp}`];
        const tag = v ? ` [${v === "mismatch" ? "mismatch!" : v}]` : "";
        sb.push(`${r.rank}. ${r.instrument}/${r.exp} — ${r.metric} — ${r.metricName}${tag}`);
      }
```

In `src/commands/rehearsal.ts` `statusBriefWith`: build the verdicts map from `verification.tsv` and pass it. Add near where it assembles `StatusBriefInput`:
```ts
  const vtsv = join(art, "verification.tsv");
  let verdicts: Record<string, string> | undefined;
  if (existsSync(vtsv)) {
    verdicts = {};
    for (const line of readFileSync(vtsv, "utf8").split("\n")) {
      if (!line || line.startsWith("exp_id\t")) continue;
      const c = line.split("\t");          // exp_id, instrument, verdict, ...
      if (c[0] && c[1] && c[2]) verdicts[`${c[1]}/${c[0]}`] = c[2];   // last write wins (latest verdict)
    }
  }
```
and include `verdicts` in the `buildStatusBrief({ ... })` call.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rehearsal-core.test.ts -t "verify annotation"` then the full file.
Expected: PASS; existing status-brief tests still green (no `verdicts` → no annotation).

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalBrief.ts src/commands/rehearsal.ts tests/rehearsal-core.test.ts
git commit -m "feat(rehearsal): status-brief verdict annotation (A1)"
```

---

### Task 8: experiment template — the `verify` block step

**Files:**
- Modify: `config/prompt-templates/rehearsal/experiment.md` (after step 4 result.json, ~line 147)
- Test: `tests/rehearsal-cmd.test.ts` (a content assertion; the stale-token gate already covers banned tokens)

- [ ] **Step 1: Write the failing test** (append to `tests/rehearsal-cmd.test.ts`)

```ts
import { readFileSync as rfs } from "node:fs";
describe("experiment template verify contract", () => {
  it("instructs the part to emit a verify block + VERIFY_METRIC marker", () => {
    const tpl = rfs("config/prompt-templates/rehearsal/experiment.md", "utf8");
    expect(tpl).toContain("\"verify\"");
    expect(tpl).toContain("VERIFY_METRIC=");
    expect(tpl).toContain("rescore");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rehearsal-cmd.test.ts -t "verify contract"`
Expected: FAIL — template has none of these strings yet.

- [ ] **Step 3: Write minimal implementation**

Insert after the result.json schema step (after current line ~146, before step 5 "THIS IS THE TERMINAL STEP"). Add a sub-step:

```markdown
   - Also emit a "verify" block so the Maestro can independently re-derive your
     metric (it re-runs your scoring step outside your pane):

       "verify": {
         "kind": "rescore" | "rerun" | "none",
         "command": "<shell cmd that recomputes metric_value WITHOUT retraining>",
         "inputs": ["./predictions.json"],
         "metric_from": "marker"
       }

     - kind="rescore": command re-scores a saved artifact (cheap). PREFER this.
     - kind="rerun": command re-runs the whole experiment (only for metrics with
       no separable artifact; costly — the Maestro runs it selectively).
     - kind="none": you cannot provide a re-derivation (verdict = unavailable).
     - The command MUST be deterministic (seed/pin) and print its result as the
       LAST stdout line `VERIFY_METRIC=<number>` (metric_from="marker"), OR write
       a JSON file `{"metric_value": <n>}` and set metric_from to its path.
     - "inputs" lists every file the command reads; the Maestro hashes them now
       and re-checks before re-running (tamper detection).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rehearsal-cmd.test.ts -t "verify contract"` then `npx vitest run tests/stale-tokens.test.ts`
Expected: both PASS (no banned tokens introduced).

- [ ] **Step 5: Commit**

```bash
git add config/prompt-templates/rehearsal/experiment.md tests/rehearsal-cmd.test.ts
git commit -m "feat(rehearsal): experiment template verify contract (A1)"
```

---

### Task 9: Maestro directive — Step 3 verify loop

**Files:**
- Modify: `commands/rehearsal.md` (Step 3, after the `score`/`status-brief` calls — locate via `grep -n "status-brief" commands/rehearsal.md`)

- [ ] **Step 1: Add the verify loop prose** (no automated test — `commands/*.md` is directive prose; verify by reading + the stale-token gate)

After the existing Step-3 `score` + `status-brief` instructions, insert:

```markdown
3.5. **Verify the landed result (metric-trust gate).** After `score`/`status-brief`, for the
     experiment that just landed (`<instrument>`/`<exp>`):

     a. `$CS rehearsal verify-plan <TOPIC> <instrument> <exp>` (add `--authorize-rerun` ONLY
        when this result is a new leader or would change your next-round direction — a `rerun`
        is costly).
     b. If it printed `RUN_CMD=...`: run that command yourself via Bash, in the printed
        `RUN_CWD`, with a timeout, teeing stdout to a temp file `<exp-dir>/verify-stdout.log`.
     c. `$CS rehearsal verify-check <TOPIC> <instrument> <exp> --stdout-file <exp-dir>/verify-stdout.log`
        (or `--run-failed` if the command errored / produced no `VERIFY_METRIC=` marker).
     d. The verdict now annotates the next `status-brief` top-3 (`verified` / `mismatch!` /
        `unavailable` / `pending`). Treat a `mismatch` as a result you do NOT yet trust — note it
        in `## Recent decisions`; acting on it (re-dispatch) is a later phase, but never steer the
        whole roster toward a `mismatch` leader.
```

- [ ] **Step 2: Verify no banned tokens**

Run: `npx vitest run tests/stale-tokens.test.ts`
Expected: PASS.

- [ ] **Step 3: Sanity-read** the inserted block in `commands/rehearsal.md` to confirm it sits inside Step 3 and uses `$CS` consistently with neighbours.

- [ ] **Step 4: Commit**

```bash
git add commands/rehearsal.md
git commit -m "feat(rehearsal): Maestro Step-3 verify loop (A1)"
```

---

### Task 10: Release — version bump, build, full gate

**Files:**
- Modify: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (0.1.12 → 0.1.13)
- Modify: `dist/consort.cjs` (rebuilt)

- [ ] **Step 1: Full gate (pre-bump)**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: typecheck clean; all tests pass; lint clean.

- [ ] **Step 2: Bump the three manifests** 0.1.12 → 0.1.13 (the `"version"` line in each).

- [ ] **Step 3: Rebuild the bundle**

Run: `npm run build`
Expected: `dist/consort.cjs` written. Sanity: `grep -c "verify-plan" dist/consort.cjs` ≥ 1.

- [ ] **Step 4: Final gate**

Run: `npm run typecheck && npm run test && npm run lint && npx vitest run tests/stale-tokens.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json dist/consort.cjs
git commit -m "chore(release): consort 0.1.13 — rehearsal metric-trust (A1)"
```

---

## Self-review notes (author)

- **Spec coverage:** §4.1 verify block → Task 1/8; §4.2 verdict + epsilon → Task 1/3; §5.1 verify-plan (incl. terminal-verdict persistence, no-manifest, provenance) → Task 2/5; §5.2 verify-check → Task 6; §5.3 manifest snapshot → Task 4; §5.4 Maestro step → Task 9; §5.5 status-brief join (no scoreboard schema change) → Task 7; §6 rerun budget (`--authorize-rerun`) → Task 5/9; §8 template → Task 8; §10 testing → every task; §11 acceptance → Tasks 5/6/7 + Task 10 gate.
- **Type consistency:** `VerifyBlock`/`VerifyManifest`/`VerificationRow`/`Verdict` defined in Task 1-2, imported everywhere after; `planVerify`/`checkVerify`/`recomputedFromOutput`/`buildManifest`/`parseVerifyBlock` signatures stable across tasks; verbs uniformly `<topic> <instrument> <exp-id>`.
- **No scoreboard schema change** (Task 7 joins a side tsv); `checkCompletion`/`parseRows` untouched.
- **Frozen protocol:** only an additive optional `verify` field + new files; event names / `END_OF_INSTRUCTION` / existing result.json fields unchanged.
```
