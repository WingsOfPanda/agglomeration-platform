# /ap:implement verify duration-gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Skip the hub's independent test re-run (and instead trust the worker's report) when the worker's *own* test run already took longer than the hub's verify budget — deciding up front from a worker-logged duration, rather than wasting up to 30 min hitting the timeout.

**Architecture:** The worker records its test-suite wall-clock as `TEST_DURATION_S=<n>` in `$ART/worker-test-duration-<round>.txt`. The `verify-tests` verb reads it and, if it exceeds `AP_IMPLEMENT_VERIFY_MAX_S` (default = the run timeout, 1800s), emits a new `VERDICT=skipped` without running. Stage 2 treats `skipped` like `none`/`unverifiable` — fall back to the worker's log, no auto-FAIL. **Fail-safe: a missing/unparseable duration never skips (verify by default).**

**Tech Stack:** TypeScript NodeNext strict, esbuild bundle `dist/ap.cjs` (committed), vitest.

**Design provenance:** Follow-up to PR #82 (`ap-implement-brief-verify-handoff-gap` memory). User request 2026-07-06: gate the independent verification on a worker-logged duration so a very long (>30 min) suite is not re-run. Threat-model note carried from #82: the *decision to verify* now depends on a self-reported number — fine under the honest-worker model (a gamed duration yields exactly today's read-the-log fallback, no worse).

## Global Constraints

- `dist/` is committed: after `src/` changes run `npm run build` and commit `dist/ap.cjs`.
- Atomic writes via `atomicWrite`. Errors to stderr (`log.error`); machine-readable `KEY=value` to stdout. No emojis.
- Frozen wire protocol untouched (hub-side + worker-prompt only; no new event names/fields).
- Process execution is NEVER spawned in unit tests — test pure functions + `verifyTestsWith` with an injected `TestRunner`.
- Test isolation: fresh `AP_HOME` via `freshHome()`; restore any `process.env.AP_IMPLEMENT_VERIFY_MAX_S` you set within a test.
- Fail-safe default: skip ONLY when a duration is reported AND strictly `>` the threshold. Missing/unparseable duration → run.
- Stdout key order EXACTLY: `TESTCMD=`, `HUB_RC=`, `WORKER_DURATION_S=`, `VERDICT=` (one `\n`-terminated line each). `HUB_RC=` and `WORKER_DURATION_S=` are the empty string when not applicable.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/implementVerifyTests.ts` (**modify**) | Add `"skipped"` to `TestVerdict`; add pure `parseWorkerDuration` + `shouldSkipVerify`. |
| `src/commands/implement.ts` (**modify**) | Wire the gate into `verifyTestsWith`: read the duration file, `maxVerifyS()`, the `skipped` branch, `WORKER_DURATION_S` in stdout + `.tsv`. |
| `tests/implement-verify-tests.test.ts` (**modify**) | Tests: the two pure helpers + verb skip/run/fail-safe cases. |
| `src/core/implementTurn.ts` (**modify**) | Worker brief (both prompt composers) records `TEST_DURATION_S`. |
| `commands/implement.md` (**modify**) | Stage 2 Step A gains the `skipped` branch + `WORKER_DURATION_S`. |
| `tests/implement-turn.test.ts` (**modify**) | Assert the duration instruction appears in the round-1 prompt. |
| `dist/ap.cjs` (**rebuild + commit**) | Refreshed bundle. |

---

## Task 1: Duration-gate core (pure helpers + verb wiring)

**Files:**
- Modify: `src/core/implementVerifyTests.ts:9` (the `TestVerdict` union) and add two functions after `classifyTestRun` (after `src/core/implementVerifyTests.ts:21`)
- Modify: `src/commands/implement.ts` (import line ~`src/commands/implement.ts:27`; add `maxVerifyS()` after `implementTestTimeout()` ~`:320`; rewrite `verifyTestsWith` body `:332-351`)
- Test: `tests/implement-verify-tests.test.ts` (append pure + verb cases)

**Interfaces:**
- Produces: `parseWorkerDuration(body: string): number | null`; `shouldSkipVerify(workerDurationS: number | null, maxS: number): boolean`; `TestVerdict` now includes `"skipped"`. `verifyTestsWith` unchanged signature; new stdout line `WORKER_DURATION_S=` and new `.tsv` key `worker_duration_s`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/implement-verify-tests.test.ts`. First extend the top-of-file import from `../src/core/implementVerifyTests.js` to also bring in the two new helpers:

```ts
import { classifyTestRun, parseWorkerDuration, shouldSkipVerify, type TestRunner } from "../src/core/implementVerifyTests.js";
```

Then append these describe blocks:

```ts
describe("parseWorkerDuration (pure)", () => {
  it("parses TEST_DURATION_S=<int>", () => { expect(parseWorkerDuration("TEST_DURATION_S=1234\n")).toBe(1234); });
  it("tolerates trailing spaces/tabs", () => { expect(parseWorkerDuration("TEST_DURATION_S=42 \t")).toBe(42); });
  it("returns null when absent", () => { expect(parseWorkerDuration("nothing here\n")).toBeNull(); });
  it("returns null when non-numeric", () => { expect(parseWorkerDuration("TEST_DURATION_S=abc")).toBeNull(); });
});

describe("shouldSkipVerify (pure)", () => {
  it("null duration never skips (fail-safe)", () => { expect(shouldSkipVerify(null, 1800)).toBe(false); });
  it("under threshold does not skip", () => { expect(shouldSkipVerify(1799, 1800)).toBe(false); });
  it("equal to threshold does not skip (strict >)", () => { expect(shouldSkipVerify(1800, 1800)).toBe(false); });
  it("over threshold skips", () => { expect(shouldSkipVerify(1801, 1800)).toBe(true); });
});

describe("implement verify-tests (duration gate)", () => {
  it("worker duration over budget -> VERDICT=skipped, runner NOT called, no hub-test-output", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-skip");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "worker-test-duration-1.txt"), "TEST_DURATION_S=999999\n"); // > 1800 default
    let called = false;
    const runner: TestRunner = { run: () => { called = true; return { code: 0, output: "" }; } };
    const { rc, out } = await capture(() => verifyTestsWith("vt-skip", 1, deps(runner, "npm test")));
    expect(rc).toBe(0);
    expect(out).toContain("VERDICT=skipped\n");
    expect(out).toContain("WORKER_DURATION_S=999999\n");
    expect(out).toContain("TESTCMD=npm test\n");
    expect(called).toBe(false);
    expect(existsSync(join(art, "hub-test-output-1.log"))).toBe(false);
    expect(readFileSync(join(art, "hub-verify-1.tsv"), "utf8")).toContain("verdict=skipped");
    h.cleanup();
  });

  it("worker duration under budget -> runs normally (VERDICT=pass), carries WORKER_DURATION_S", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-under");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "worker-test-duration-1.txt"), "TEST_DURATION_S=5\n");
    const runner: TestRunner = { run: () => ({ code: 0, output: "ok\n" }) };
    const { out } = await capture(() => verifyTestsWith("vt-under", 1, deps(runner, "npm test")));
    expect(out).toContain("VERDICT=pass\n");
    expect(out).toContain("WORKER_DURATION_S=5\n");
    expect(readFileSync(join(art, "hub-test-output-1.log"), "utf8")).toBe("ok\n");
    h.cleanup();
  });

  it("no duration file -> runs (fail-safe), WORKER_DURATION_S empty", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-nodur");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    const runner: TestRunner = { run: () => ({ code: 0, output: "ok\n" }) };
    const { out } = await capture(() => verifyTestsWith("vt-nodur", 1, deps(runner, "npm test")));
    expect(out).toContain("VERDICT=pass\n");
    expect(out).toContain("WORKER_DURATION_S=\n");
    h.cleanup();
  });

  it("AP_IMPLEMENT_VERIFY_MAX_S knob lowers the skip threshold", async () => {
    const h = freshHome();
    const prev = process.env.AP_IMPLEMENT_VERIFY_MAX_S;
    process.env.AP_IMPLEMENT_VERIFY_MAX_S = "60";
    try {
      const art = implementArtDir("vt-knob");
      mkdirSync(art, { recursive: true });
      writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
      writeFileSync(join(art, "worker-test-duration-1.txt"), "TEST_DURATION_S=100\n"); // > 60
      let called = false;
      const runner: TestRunner = { run: () => { called = true; return { code: 0, output: "" }; } };
      const { out } = await capture(() => verifyTestsWith("vt-knob", 1, deps(runner, "npm test")));
      expect(out).toContain("VERDICT=skipped\n");
      expect(called).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AP_IMPLEMENT_VERIFY_MAX_S; else process.env.AP_IMPLEMENT_VERIFY_MAX_S = prev;
    }
    h.cleanup();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/implement-verify-tests.test.ts`
Expected: FAIL — `parseWorkerDuration`/`shouldSkipVerify` not exported; verb emits no `WORKER_DURATION_S=`/`skipped`.

- [ ] **Step 3: Implement — pure helpers**

In `src/core/implementVerifyTests.ts`, change the `TestVerdict` union (line 9) to add `"skipped"`:

```ts
export type TestVerdict = "pass" | "fail" | "unverifiable" | "none" | "skipped";
```

Then add, immediately after the `classifyTestRun` function (after line 21):

```ts
/** Parse `TEST_DURATION_S=<int>` (the worker's self-reported test-suite wall-clock seconds) from a
 *  duration-file body. Returns the integer, or null when the marker is absent or unparseable — null
 *  is the fail-safe (the hub then verifies rather than skipping). Pure. */
export function parseWorkerDuration(body: string): number | null {
  const m = body.match(/^TEST_DURATION_S=([0-9]+)[ \t]*$/m);
  return m ? Number(m[1]) : null;
}

/** Decide whether the hub should SKIP its own re-run because the worker's suite already took longer
 *  than we are willing to spend (re-running would ~double the wall-clock and likely just hit the
 *  timeout). Skip iff a duration was reported (non-null) AND strictly exceeds maxS. A null duration
 *  NEVER skips (fail-safe: verify by default). Pure. */
export function shouldSkipVerify(workerDurationS: number | null, maxS: number): boolean {
  return workerDurationS !== null && workerDurationS > maxS;
}
```

- [ ] **Step 4: Implement — verb wiring**

In `src/commands/implement.ts`, extend the import from `../core/implementVerifyTests.js` (currently `import { classifyTestRun, liveTestRunner, type TestRunner } from "../core/implementVerifyTests.js";`) to:

```ts
import { classifyTestRun, liveTestRunner, parseWorkerDuration, shouldSkipVerify, type TestRunner, type TestVerdict } from "../core/implementVerifyTests.js";
```

Add `maxVerifyS()` right after `implementTestTimeout()`:

```ts
function maxVerifyS(): number { return Number(process.env.AP_IMPLEMENT_VERIFY_MAX_S) || implementTestTimeout(); }
```

Replace the whole `verifyTestsWith` function (its doc comment + body, currently lines 327-351) with:

```ts
/** Hub-side independent test re-run for round <round>. Runs the repo's detected test command in
 *  target_cwd (the worker's branch, in place) and classifies the hub's OWN exit code — UNLESS the
 *  worker's self-reported duration (worker-test-duration-<round>.txt) exceeds the verify budget
 *  (AP_IMPLEMENT_VERIFY_MAX_S, default = the run timeout), in which case it emits VERDICT=skipped
 *  without running (the hub trusts the worker's report rather than ~doubling the wall-clock). A
 *  missing/unparseable duration never skips (fail-safe: verify). Writes hub-test-output-<round>.log
 *  (only when a command actually ran) + hub-verify-<round>.tsv; prints
 *  TESTCMD=/HUB_RC=/WORKER_DURATION_S=/VERDICT= to stdout for the Stage 2 directive. rc 0 always on a
 *  completed run; rc 1 only when the art-dir / target_cwd.txt is missing. */
export async function verifyTestsWith(topic: string, round: number, d: VerifyTestsDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement verify-tests: art-dir missing: ${art}`); return 1; }
  const targetFile = join(art, "target_cwd.txt");
  if (!existsSync(targetFile)) { log.error(`implement verify-tests: target_cwd.txt missing under ${art}`); return 1; }
  const targetCwd = readField(targetFile);
  const testCmd = d.detect(targetCwd);
  const durFile = join(art, `worker-test-duration-${round}.txt`);
  const workerDur = existsSync(durFile) ? parseWorkerDuration(readFileSync(durFile, "utf8")) : null;
  let code: number | null = null;
  let verdict: TestVerdict;
  if (testCmd === "") {
    verdict = "none";                                   // no suite detected — nothing to run or skip
  } else if (shouldSkipVerify(workerDur, maxVerifyS())) {
    verdict = "skipped";                                // worker's suite over budget — trust its report
  } else {
    const r = d.runner.run(targetCwd, testCmd, implementTestTimeout());
    code = r.code;
    atomicWrite(join(art, `hub-test-output-${round}.log`), r.output);
    verdict = classifyTestRun(testCmd, code);
  }
  atomicWrite(join(art, `hub-verify-${round}.tsv`),
    `round=${round}\ntest_cmd=${testCmd}\nhub_rc=${code === null ? "" : code}\nworker_duration_s=${workerDur === null ? "" : workerDur}\nverdict=${verdict}\nverified_ts=${d.now()}\n`);
  process.stdout.write(`TESTCMD=${testCmd || "none"}\nHUB_RC=${code === null ? "" : code}\nWORKER_DURATION_S=${workerDur === null ? "" : workerDur}\nVERDICT=${verdict}\n`);
  log.ok(`implement verify-tests: round=${round} verdict=${verdict}${verdict === "skipped" ? ` (worker=${workerDur}s > ${maxVerifyS()}s)` : testCmd ? ` (rc=${code})` : ""}`);
  return 0;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/implement-verify-tests.test.ts`
Expected: PASS (existing 10 + the 4 pure + 4 verb duration cases). Then `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/implementVerifyTests.ts src/commands/implement.ts tests/implement-verify-tests.test.ts
git commit -m "feat(implement): duration-gate the hub test re-run (skip when worker suite exceeds budget)"
```

---

## Task 2: Worker logs its duration + directive `skipped` branch + rebuild

**Files:**
- Modify: `src/core/implementTurn.ts` (`composeRound1Prompt` PHASE 3 ~`:94-103`; `composeFixPrompt` final section ~`:147-152`)
- Modify: `commands/implement.md` (Stage 2 Step A ~`:168-184`)
- Modify: `tests/implement-turn.test.ts` (assert the duration instruction in the round-1 prompt)
- Rebuild: `dist/ap.cjs`

**Interfaces:**
- Consumes: Task 1's duration-file path convention `<art>/worker-test-duration-<round>.txt` and the `TEST_DURATION_S=<n>` marker; the verb's `VERDICT=skipped` + `WORKER_DURATION_S=` stdout keys.

- [ ] **Step 1: Write the failing test**

In `tests/implement-turn.test.ts`, add a test asserting the round-1 prompt instructs the worker to log its duration. If the file already imports `composeRound1Prompt`, reuse it; otherwise add the import. Append inside the existing top-level `describe` (or add a new one):

```ts
it("round-1 prompt tells the worker to log TEST_DURATION_S to the duration file", () => {
  const p = composeRound1Prompt({ designPath: "/a/design.md", planPath: "/a/plan.md", verifyPath: "/a/verify-report-1.md", round: 1, testCmd: "npm test" });
  expect(p).toContain("TEST_DURATION_S");
  expect(p).toContain("/a/worker-test-duration-1.txt");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/implement-turn.test.ts`
Expected: FAIL — the prompt does not yet mention `TEST_DURATION_S` / the duration file.

- [ ] **Step 3: Implement — worker brief (round-1)**

In `src/core/implementTurn.ts` `composeRound1Prompt`, after `const testLog = ...` (line 64) add:

```ts
  const durationLog = `${dirname(verifyPath)}/worker-test-duration-${round}.txt`;
```

Then in the returned array, in PHASE 3, insert these lines immediately AFTER the report-format lines (after the line `"  short summary.",` — line 103) and BEFORE the following `""`:

```ts
    "",
    "  Also record how long the test suite itself took, in whole wall-clock",
    "  seconds, and write it as `TEST_DURATION_S=<seconds>` (one line) to:",
    `    ${durationLog}`,
    "  The Hub reads this: if your suite ran longer than its verify budget it",
    "  trusts your report instead of independently re-running — so measure the",
    "  actual suite run.",
```

- [ ] **Step 4: Implement — worker brief (fix-round)**

In `composeFixPrompt`, after `const testLog = ...` (line 113) add:

```ts
  const durationLog = `${dirname(verifyPath)}/worker-test-duration-${round}.txt`;
```

Then insert, immediately AFTER the line `"  The report MUST start with \`VERDICT: PASS|PARTIAL|FAIL\`.",` (line 152) and BEFORE the following `""`:

```ts
    "  Also record the suite's wall-clock seconds as `TEST_DURATION_S=<seconds>`",
    `  (one line) to: ${durationLog}`,
```

- [ ] **Step 5: Implement — directive `skipped` branch**

In `commands/implement.md` Stage 2 Step A, change the intro sentence "and prints `TESTCMD=`/`HUB_RC=`/`VERDICT=`" (line 170-171) to:

```markdown
`VERDICT=` (plus `WORKER_DURATION_S=`, the worker's own reported test time)
```

Then add this bullet to the `Branch on VERDICT` list, immediately after the `pass` bullet (after line 184):

```markdown
- **`skipped`** — the worker reported (in `worker-test-duration-<ROUND>.txt`) that its own suite took
  longer than the hub's verify budget (`AP_IMPLEMENT_VERIFY_MAX_S`, default = `AP_IMPLEMENT_TEST_TIMEOUT_S`
  = 30 min), so the hub did NOT re-run — re-running would roughly double the wall-clock. Fall through
  to the read-based checks below using the worker's `test-output-<ROUND>.log`; do **not** auto-FAIL.
  Record in the cross-verify doc: "independent re-run skipped — worker suite took `WORKER_DURATION_S` s
  (> budget); relying on the worker's reported results." (A worker cannot force this to hide a failure
  beyond what trusting its log already does — the fallback is the pre-existing read-based path.)
```

- [ ] **Step 6: Run the prompt test + rebuild**

Run: `npx vitest run tests/implement-turn.test.ts` → PASS.
Run: `grep -n "skipped" commands/implement.md` → the new Step-A bullet is present.
Run: `npm run build` → dist/ap.cjs rebuilt, no error.

- [ ] **Step 7: Full gate**

Run: `npm run typecheck && npm run test && npm run lint && npm run build`
Expected: tsc clean; ALL vitest tests pass (existing + new); eslint clean; build clean.

- [ ] **Step 8: Commit**

```bash
git add src/core/implementTurn.ts commands/implement.md tests/implement-turn.test.ts dist/ap.cjs
git commit -m "feat(implement): worker logs TEST_DURATION_S; Stage 2 handles VERDICT=skipped; rebuild dist"
```

---

## Self-Review

**1. Spec coverage:** worker logs duration (Task 2 Steps 3-4) → verb reads + gates (Task 1 Step 4) → directive handles `skipped` (Task 2 Step 5). Fail-safe (missing → run) covered by `shouldSkipVerify(null,…)===false` + the no-duration verb test. Configurable threshold via `AP_IMPLEMENT_VERIFY_MAX_S` (default = run timeout) + the knob test. ✓
**2. Placeholder scan:** every code step has complete code; every run step has an exact command + expected result. ✓
**3. Type consistency:** `TestVerdict` gains `"skipped"` (Task 1 Step 3) and `verifyTestsWith` uses `let verdict: TestVerdict` (imported in Task 1 Step 4). The duration path `worker-test-duration-<round>.txt` and marker `TEST_DURATION_S=` match between the verb (Task 1), the worker brief (Task 2), and the tests. Stdout adds `WORKER_DURATION_S=` between `HUB_RC=` and `VERDICT=`; `.tsv` adds `worker_duration_s`. ✓
