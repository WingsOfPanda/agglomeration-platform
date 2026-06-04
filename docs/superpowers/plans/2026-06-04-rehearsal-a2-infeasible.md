# Rehearsal A2 — INFEASIBLE-vs-REFUTED Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify a botched result as INFEASIBLE (A1 `mismatch` ∪ A3 `under-run`/`log-contradiction`/`audit-knob-drift`) and route it to a non-ranked scoreboard group, so it's never a refuted idea, a false leader, or Lane-D evidence; plus a directive bounded re-dispatch.

**Architecture:** A new pure `src/core/rehearsalInfeasible.ts` (`classifyInfeasible` + `parseVerdicts`). `computeScore` reads `verification.tsv` (A1 verdict) + the just-computed A3 flags and sets `ScoreRow.infeasibleReason`; `buildScoreboard` routes those `ok` rows to an `xN`-rank group below the ranked rows. Because `checkCompletion`/`status-brief` match only integer-rank rows, infeasible exclusion from completion + top-3 is automatic (no change to those modules). The bounded re-dispatch + Lane-D-feasible-only live in the directive.

**Tech Stack:** TypeScript (Node/ESM), esbuild single-bundle `dist/consort.cjs`, vitest.

**Spec:** `docs/superpowers/specs/2026-06-04-rehearsal-a2-infeasible-design.md`.

**Refinement over the spec (planning):** the spec §4.3/§8 say `ScoreRow.infeasible?: boolean`; this plan uses **`ScoreRow.infeasibleReason?: string`** (the trigger string; presence ⇒ infeasible) so the scoreboard can render *why* (e.g. `infeasible:mismatch`). Same semantics, carries the reason.

**Key facts:** `checkCompletion.parseRows` and `status-brief.parseTopRows` both skip non-integer-rank rows (`/^\|\s+\d+\s+\|\s+exp-/`), so `xN` rows are auto-excluded — these modules need NO change. The partial group already uses `~N` (also auto-excluded), so `xN` follows the same proven pattern.

**Conventions:** pure core + verb-applies-plan; no emojis; gates `npm run typecheck`/`test`/`lint`/`build`.

---

### Task 1: Infeasible core — classify + parse verdicts

**Files:**
- Create: `src/core/rehearsalInfeasible.ts`
- Test: `tests/rehearsal-infeasible.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/rehearsal-infeasible.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyInfeasible, parseVerdicts, INFEASIBLE_FLAGS } from "../src/core/rehearsalInfeasible.js";

describe("classifyInfeasible", () => {
  it("verdict=mismatch -> 'mismatch'", () => {
    expect(classifyInfeasible("mismatch", [])).toBe("mismatch");
  });
  it("an invalidating flag -> that flag (mismatch takes precedence)", () => {
    expect(classifyInfeasible(undefined, ["under-run"])).toBe("under-run");
    expect(classifyInfeasible(undefined, ["audit-knob-drift"])).toBe("audit-knob-drift");
    expect(classifyInfeasible(undefined, ["log-contradiction"])).toBe("log-contradiction");
    expect(classifyInfeasible("mismatch", ["under-run"])).toBe("mismatch");
  });
  it("advisory-only flags / verified / none -> null", () => {
    expect(classifyInfeasible("verified", ["ceiling-exceeded"])).toBeNull();
    expect(classifyInfeasible(undefined, ["integrity-attestation-incomplete"])).toBeNull();
    expect(classifyInfeasible(undefined, [])).toBeNull();
    expect(classifyInfeasible(undefined, ["ceiling-exceeded", "integrity-attestation-incomplete"])).toBeNull();
  });
  it("INFEASIBLE_FLAGS is the core-unambiguous set", () => {
    expect([...INFEASIBLE_FLAGS].sort()).toEqual(["audit-knob-drift", "log-contradiction", "under-run"]);
  });
});

describe("parseVerdicts", () => {
  it("maps instrument/exp -> verdict, last write wins, header/blank skipped", () => {
    const tsv = "exp_id\tinstrument\tverdict\treason\trecomputed\tts\n" +
      "exp-001\tviola\tverified\t\t0.9\tT1\n" +
      "exp-001\tviola\tmismatch\tvalue\t0.5\tT2\n" +
      "exp-002\toboe\tunavailable\tno-contract\t\tT3\n";
    expect(parseVerdicts(tsv)).toEqual({ "viola/exp-001": "mismatch", "oboe/exp-002": "unavailable" });
  });
  it("empty / headerless input -> {}", () => {
    expect(parseVerdicts("")).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/rehearsal-infeasible.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write minimal implementation** — create `src/core/rehearsalInfeasible.ts`:

```ts
// INFEASIBLE-vs-REFUTED classification for /consort:rehearsal (research-validity A2).
// A result is INFEASIBLE ("couldn't be validly executed") iff its A1 verdict is `mismatch` OR its A3
// sanity flags include a core-unambiguous invalidating flag. ceiling-exceeded /
// integrity-attestation-incomplete stay advisory (do NOT make a result infeasible). Pure.

export const INFEASIBLE_FLAGS = ["under-run", "log-contradiction", "audit-knob-drift"] as const;

/** Returns the trigger reason (verdict or flag name) when infeasible, else null. */
export function classifyInfeasible(verdict: string | undefined, flags: string[]): string | null {
  if (verdict === "mismatch") return "mismatch";
  for (const f of flags) {
    if ((INFEASIBLE_FLAGS as readonly string[]).includes(f)) return f;
  }
  return null;
}

/** Parse verification.tsv into instrument/exp -> latest verdict (last write wins). */
export function parseVerdicts(tsv: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of tsv.split("\n")) {
    if (!line || line.startsWith("exp_id\t")) continue;
    const c = line.split("\t");          // exp_id, instrument, verdict, ...
    if (c[0] && c[1] && c[2]) out[`${c[1]}/${c[0]}`] = c[2];
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/rehearsal-infeasible.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalInfeasible.ts tests/rehearsal-infeasible.test.ts
git commit -m "feat(rehearsal): infeasible core — classify + parse verdicts (A2)"
```

---

### Task 2: metric.md — parse `max_debug_attempts`

**Files:**
- Modify: `src/core/rehearsalMetric.ts` (`MetricThresholds`; `parseMetricMd`)
- Test: `tests/rehearsal-core.test.ts` (the `parseMetricMd round-trips` describe)

- [ ] **Step 1: Write the failing test** (add an `it` inside the existing `parseMetricMd` describe):

```ts
  it("parses max_debug_attempts; undefined when absent", () => {
    expect(parseMetricMd("**Primary metric:** acc\n**max_debug_attempts:** 3\n").maxDebugAttempts).toBe(3);
    expect(parseMetricMd("**Primary metric:** acc\n").maxDebugAttempts).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/rehearsal-core.test.ts -t "max_debug_attempts"` → FAIL.

- [ ] **Step 3: Write minimal implementation** — in `src/core/rehearsalMetric.ts`:
- In `MetricThresholds`, after `minRuntimeS?: number;`, add:
```ts
  /** optional metric.md `**max_debug_attempts:**` for A2 bounded re-dispatch; caller defaults to 2. */
  maxDebugAttempts?: number;
```
- In `parseMetricMd`, near the other `let` decls, add: `let maxDebugAttempts: number | undefined;`
- Add a parse branch alongside the others:
```ts
    else if ((m = line.match(/^\*\*max_debug_attempts:\*\*\s+(.*)$/))) { const n = parseInt(m[1].trim(), 10); if (!Number.isNaN(n)) maxDebugAttempts = n; }
```
- Add `maxDebugAttempts` to the returned object.

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/rehearsal-core.test.ts -t "max_debug_attempts"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalMetric.ts tests/rehearsal-core.test.ts
git commit -m "feat(rehearsal): parse metric.md max_debug_attempts (A2)"
```

---

### Task 3: buildScoreboard — route infeasible to the `xN` group

**Files:**
- Modify: `src/core/rehearsalResult.ts` (`ScoreRow` interface; `buildScoreboard`)
- Test: `tests/rehearsal-core.test.ts` (the `buildScoreboard` describe)

- [ ] **Step 1: Write the failing test** (add `it`s in the `buildScoreboard` describe):

```ts
  it("routes an ok+infeasible row to the xN group below the ranked rows", () => {
    const rows2: ScoreRow[] = [
      { expId: "exp-001", instrument: "oboe",  metric: "0.90", status: "ok", runtime: "10", approach: "a", metricName: "accuracy" },
      { expId: "exp-002", instrument: "viola", metric: "0.99", status: "ok", runtime: "20", approach: "b", metricName: "accuracy", infeasibleReason: "mismatch" },
    ];
    const lines = buildScoreboard(rows2).split("\n").filter((l) => /^\| /.test(l) && !/Rank|---/.test(l));
    // ranked: only exp-001 (0.90) at rank 1; exp-002 (0.99, but infeasible) is NOT rank 1
    expect(lines[0]).toContain("| 1 | exp-001 | oboe |");
    expect(lines[1]).toContain("| x2 | exp-002 | viola |");
    expect(lines[1]).toContain("infeasible:mismatch");
  });
  it("checkCompletion ignores an infeasible row (no checkCompletion change)", () => {
    // exp-002 is ok+0.99 but infeasible -> must NOT satisfy target (>= 0.95); only the ranked 0.90 counts.
    const sb = buildScoreboard([
      row("exp-001", "oboe", "0.90"),
      { expId: "exp-002", instrument: "oboe", metric: "0.99", status: "ok", runtime: "1", approach: "a", metricName: "accuracy", infeasibleReason: "under-run" },
    ]);
    const c = checkCompletion(sb, metricMd);
    expect(c.targetMet).toBe(false); // infeasible 0.99 excluded -> target >= 0.95 not met
    expect(c.floorMet).toBe(true);   // ranked 0.90 meets min_acceptable >= 0.90
  });
```

NOTE: the `metricMd`/`row` helpers already exist in `tests/rehearsal-core.test.ts` (defined near the `checkCompletion` describe — `metricMd` has `min_acceptable >= 0.90`, `target >= 0.95`). Reuse them; do not redefine.

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/rehearsal-core.test.ts -t "infeasible row|xN group"` → FAIL (`infeasibleReason` not on `ScoreRow`; infeasible row ranks as `1`/`2`).

- [ ] **Step 3: Write minimal implementation** — in `src/core/rehearsalResult.ts`:
- add to the `ScoreRow` interface:
```ts
  /** A2: trigger reason (mismatch / under-run / log-contradiction / audit-knob-drift) when infeasible;
   *  set => the row is routed to the non-ranked `xN` group instead of the ranked leader set. */
  infeasibleReason?: string;
```
- replace the body of `buildScoreboard` (keep the existing direction-aware C0 doc comment; extend it) with the 3-way partition:
```ts
/** Build the full scoreboard.md. OK rows sorted best-metric-first (metric-desc for a maximize
 *  objective, metric-asc for minimize) / runtime-asc / exp-id; fail+partial grouped below sorted by
 *  exp-id; rank counter continuous; partial -> ~ rank. `direction` from metric.md (undefined =>
 *  maximize, byte-identical to the pre-fix descending sort; a deliberate consort divergence — roadmap C0).
 *  A2: ok rows whose `infeasibleReason` is set are routed to a separate `x<rank>` group between the
 *  ranked rows and the fail group (visible but out of the integer-ranked leader set, so
 *  checkCompletion/status-brief — which match only integer ranks — exclude them automatically). */
export function buildScoreboard(rows: ScoreRow[], direction?: "maximize" | "minimize"): string {
  const ranked = rows.filter((r) => r.status === "ok" && !r.infeasibleReason);
  const infeasible = rows.filter((r) => r.status === "ok" && r.infeasibleReason);
  const fail = rows.filter((r) => r.status !== "ok");
  const minimize = direction === "minimize";
  ranked.sort((a, b) =>
    (minimize ? parseFloat(a.metric) - parseFloat(b.metric) : parseFloat(b.metric) - parseFloat(a.metric)) ||
    (parseFloat(a.runtime) - parseFloat(b.runtime)) ||
    (expNum(a.expId) - expNum(b.expId)));
  infeasible.sort((a, b) => expNum(a.expId) - expNum(b.expId));
  fail.sort((a, b) => expNum(a.expId) - expNum(b.expId));

  const lines: string[] = [
    "<!-- scoreboard schema_version=2 -->",
    "# Scoreboard",
    "",
    "| Rank | Experiment | Instrument | Metric | Status | Runtime | Approach | metric_name |",
    "|---|---|---|---|---|---|---|---|",
  ];
  let rank = 1;
  for (const r of ranked) {
    lines.push(`| ${rank} | ${r.expId} | ${r.instrument} | ${renderScoreboardRow(r.metric, r.runtime, r.metricName, r.status, r.approach)} |`);
    rank++;
  }
  for (const r of infeasible) {
    lines.push(`| x${rank} | ${r.expId} | ${r.instrument} | ${renderScoreboardRow(r.metric, r.runtime, r.metricName, `infeasible:${r.infeasibleReason}`, r.approach)} |`);
    rank++;
  }
  for (const r of fail) {
    const rankCell = r.status === "partial" ? `~${rank}` : `${rank}`;
    lines.push(`| ${rankCell} | ${r.expId} | ${r.instrument} | ${renderScoreboardRow("n/a", r.runtime, r.metricName, r.status, r.approach)} |`);
    rank++;
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes** — the `-t` filter, then the WHOLE file `npx vitest run tests/rehearsal-core.test.ts`. The existing buildScoreboard test ("orders ok rows … ranks continue into fails") MUST stay green: with no infeasible rows the `infeasible` partition is empty, so output is byte-identical to before.

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalResult.ts tests/rehearsal-core.test.ts
git commit -m "feat(rehearsal): buildScoreboard infeasible xN group (A2)"
```

---

### Task 4: computeScore — set `infeasibleReason` from verdict + flags

**Files:**
- Modify: `src/core/rehearsalScore.ts` (`computeScore`)
- Test: `tests/rehearsal-core.test.ts` (the `computeScore` describe)

- [ ] **Step 1: Write the failing test** (add `it`s in the `computeScore` describe):

```ts
  it("computeScore marks a row infeasible when verification.tsv verdict is mismatch", () => {
    const files: Record<string, string> = {
      "/a/metric.md": "**Primary metric:** accuracy\n**Direction:** maximize\n",
      "/a/verification.tsv": "exp_id\tinstrument\tverdict\treason\trecomputed\tts\nexp-001\tviola\tmismatch\tvalue\t0.5\tT\n",
      "/a/parts/viola/state.txt": "current_exp_id=exp-001\n",
      "/a/parts/viola/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"x",metric_name:"accuracy",metric_value:0.99,status:"ok",
        runtime_s:50,log_paths:[],checkpoint_path:null,notes:"",
        integrity:{ split_before_fit:true, no_train_test_overlap:true, target_not_in_features:true, trained_steps:10, seed:1 } }),
    };
    const c = computeScore("/a", fakeFs(files), () => "T");
    // exp-001 is ok+0.99 but verdict=mismatch -> routed to xN group, NOT rank 1
    expect(c.scoreboardMd).toMatch(/\| x\d+ \| exp-001 \| viola \|.*infeasible:mismatch/);
    expect(c.scoreboardMd).not.toMatch(/\| 1 \| exp-001 \|/);
  });
  it("computeScore marks a row infeasible from an A3 under-run flag (no verdict)", () => {
    const files: Record<string, string> = {
      "/a/metric.md": "**Primary metric:** accuracy\n**Direction:** maximize\n",
      "/a/parts/viola/state.txt": "current_exp_id=exp-001\n",
      "/a/parts/viola/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"x",metric_name:"accuracy",metric_value:0.99,status:"ok",
        runtime_s:0,log_paths:[],checkpoint_path:null,notes:"",   // runtime 0 -> A3 under-run
        integrity:{ split_before_fit:true, no_train_test_overlap:true, target_not_in_features:true, trained_steps:10, seed:1 } }),
    };
    const c = computeScore("/a", fakeFs(files), () => "T");
    expect(c.scoreboardMd).toMatch(/infeasible:under-run/);
  });
  it("computeScore leaves a clean verified/unflagged result in the ranked group", () => {
    const files: Record<string, string> = {
      "/a/metric.md": "**Primary metric:** accuracy\n**Direction:** maximize\n",
      "/a/verification.tsv": "exp_id\tinstrument\tverdict\treason\trecomputed\tts\nexp-001\tviola\tverified\t\t0.95\tT\n",
      "/a/parts/viola/state.txt": "current_exp_id=exp-001\n",
      "/a/parts/viola/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"x",metric_name:"accuracy",metric_value:0.95,status:"ok",
        runtime_s:50,log_paths:[],checkpoint_path:null,notes:"",
        integrity:{ split_before_fit:true, no_train_test_overlap:true, target_not_in_features:true, trained_steps:10, seed:1 } }),
    };
    const c = computeScore("/a", fakeFs(files), () => "T");
    expect(c.scoreboardMd).toMatch(/\| 1 \| exp-001 \| viola \|/);
    expect(c.scoreboardMd).not.toMatch(/infeasible/);
  });
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/rehearsal-core.test.ts -t "infeasible"` → FAIL (rows not marked).

- [ ] **Step 3: Write minimal implementation** — in `src/core/rehearsalScore.ts`:
- add import: `import { classifyInfeasible, parseVerdicts } from "./rehearsalInfeasible.js";`
- near the top of `computeScore`, after the `const parsed = metricMd ? parseMetricMd(metricMd) : null;` line, add:
```ts
  const verdicts = parseVerdicts(fs.read(join(art, "verification.tsv")) ?? "");
```
- find the existing `rows.push({ expId, instrument, metric: str(o.metric_value), ... });` line in the walk loop and change it to capture a reference (so A2 can set `infeasibleReason` after the A3 flags are computed):
```ts
      const scoreRow: ScoreRow = { expId, instrument, metric: str(o.metric_value), status: str(o.status),
        runtime: str(o.runtime_s), approach: str(o.approach_label), metricName: str(o.metric_name) };
      rows.push(scoreRow);
```
- INSIDE the loop, AFTER the A3 sanity block (where `const flags = sanityFlags({...})` is computed and rows are pushed to `sanityRows`), add:
```ts
      const infReason = classifyInfeasible(verdicts[`${instrument}/${expId}`], flags.map((f) => f.flag));
      if (infReason) scoreRow.infeasibleReason = infReason;
```
(`ScoreRow` is already imported in this file via `import { ... type ScoreRow } from "./rehearsalResult.js"`; `flags`, `scoreRow`, `instrument`, `expId` are all in scope in the loop.)

- [ ] **Step 4: Run test to verify it passes** — `-t "infeasible"`, then the WHOLE file. Existing computeScore tests stay green (no verification.tsv + clean results → no infeasible rows → identical scoreboards; the A1/A3 tests untouched).

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalScore.ts tests/rehearsal-core.test.ts
git commit -m "feat(rehearsal): computeScore classifies infeasible rows (A2)"
```

---

### Task 5: Maestro directive — the A2 loop + Lane-D feasible-only

**Files:**
- Modify: `commands/rehearsal.md` (the Step-3.5 A1/A3 verify block; the Lane-D block ~262-279; the Step-3 / Step-4 decision policy)

- [ ] **Step 1: Edit the directive** (prose; verified by reading + the stale-token gate).

(a) In the Step-3.5 verify block, after the A3 suspect-flag point (the one added in A3, point `e.`), add the A2 acting point:
```markdown
     f. **A2 — act on INFEASIBLE.** A result is INFEASIBLE when its verify verdict is `mismatch` OR it
        carries an A3 `under-run` / `log-contradiction` / `audit-knob-drift` flag. The score pass routes
        infeasible results to the scoreboard `x<rank>` group (out of the ranked leader set — they are
        NOT a refuted idea and never the leader). When the just-landed experiment is INFEASIBLE and this
        idea has been attempted fewer than `max_debug_attempts` times (metric.md, default 2),
        RE-DISPATCH the same idea with the failure feedback in the approach-brief (e.g. "previous attempt
        was INFEASIBLE: `audit-knob-drift mcts_sims=16 vs 200` — set 200 and re-run"). If the cap is hit,
        record the idea INFEASIBLE-final in `## Recent decisions` ("couldn't be validly executed", NOT
        refuted) and let the part move to a new idea. A REFUTED result (feasible `ok`, genuinely low)
        steers normally — it is real evidence the idea is weak.
```

(b) In the Lane-D abandon block (the frozen criteria list ~262-279), make it count FEASIBLE experiments only. After the line about "NONE of this part's LAST 3 experiments scored >= min_acceptable", add a clause:
```markdown
     (count only FEASIBLE experiments — the ranked scoreboard rows; an INFEASIBLE run in the
     `x<rank>` group is NOT Lane-D evidence, because it was botched, not a weak idea.)
```

(c) In the scoreboard-reading guidance (wherever the scoreboard groups are described — near Step 3), add a note: the scoreboard has three groups — integer-ranked (`1,2,3…`, the valid leader set), `x<rank>` (INFEASIBLE: ran but invalid — excluded from leader/completion/Lane-D), and `~<rank>`/`<rank>` (partial/fail). Steer ONLY on the integer-ranked group.

- [ ] **Step 2: Verify no banned tokens** — `npx vitest run tests/stale-tokens.test.ts` → PASS.

- [ ] **Step 3: Sanity-read** the inserted blocks in context to confirm they sit in the right sections and use `$CS`/voice consistent with neighbours.

- [ ] **Step 4: Commit**

```bash
git add commands/rehearsal.md
git commit -m "feat(rehearsal): A2 directive — act on INFEASIBLE + Lane-D feasible-only (A2)"
```

---

### Task 6: Release — version bump, build, full gate

**Files:**
- Modify: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (0.1.14 → 0.1.15)
- Modify: `dist/consort.cjs` (rebuilt)

- [ ] **Step 1: Pre-bump gate** — `npm run typecheck && npm run test && npm run lint` → all green.
- [ ] **Step 2: Bump** the three manifests 0.1.14 → 0.1.15.
- [ ] **Step 3: Build** — `npm run build`; sanity `grep -c "classifyInfeasible\|infeasibleReason" dist/consort.cjs` ≥ 1.
- [ ] **Step 4: Final gate** — `npm run typecheck && npm run test && npm run lint && npx vitest run tests/stale-tokens.test.ts` → all green.
- [ ] **Step 5: Commit**

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json dist/consort.cjs
git commit -m "chore(release): consort 0.1.15 — rehearsal INFEASIBLE-vs-REFUTED (A2)"
```

---

## Self-review notes (author)

- **Spec coverage:** §4.1 rule → Task 1; §4.2 verdict lookup → Task 1 (`parseVerdicts`) + Task 4 (use); §4.3 `ScoreRow` + xN group → Task 3; §4.4 `max_debug_attempts` → Task 2; §5 flow / classification in score pass → Task 4; §7 directive (A2 loop + Lane-D) → Task 5; §9 testing → every task; §10 acceptance → Tasks 3/4 (+ the checkCompletion-regression test) + Task 6 gate.
- **No-change guarantee:** `checkCompletion`/`status-brief`/`experiment-send` are NOT modified — the xN non-integer rank auto-excludes from their integer-rank parsing (Task 3 test proves checkCompletion ignores an infeasible row).
- **Type consistency:** `classifyInfeasible`/`parseVerdicts`/`INFEASIBLE_FLAGS` (Task 1) used in Task 4; `ScoreRow.infeasibleReason?: string` (Task 3) set in Task 4; `maxDebugAttempts` (Task 2) consumed only by the directive (Task 5).
- **Frozen/additive:** new module + optional `metric.md` field + optional `ScoreRow` field; `status` enum, `scoreboard.md` 8-column schema + `schema_version=2`, A1 `verification.tsv` / A3 `sanity.tsv` all unchanged. The scoreboard *content* gains the xN group (the deliberate A2 change), but the column schema + integer-rank contract are byte-identical.
```
