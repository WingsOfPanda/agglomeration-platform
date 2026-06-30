# /ap:implement hub-runs-tests (v1, in-place) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/ap:implement` hub independently re-run the repo's test suite to verify the worker's work, instead of trusting the worker's self-reported `test-output-<round>.log`.

**Architecture:** Add a new mechanical verb `implement verify-tests <topic> <round>` that runs the repo's own detected test command (`detectTestCommand`) **in-place** in the worker's `target_cwd` on the worker's branch (no git worktree — `node_modules`/`.env` are already present there), capturing the **hub's own exit code**. The `commands/implement.md` Stage 2 directive calls it first and gates the cross-verify VERDICT on that exit code. The worker's brief and the IPC protocol are untouched.

**Tech Stack:** TypeScript (NodeNext, strict), esbuild single-bundle (`dist/ap.cjs`, committed), vitest, `node:child_process` `execFileSync` + GNU `timeout`.

**Design provenance:** `/ap:explore` landscape + `design-handoff.md` (archived at `~/.ap/archive/b1eff9a5…/in-ap-implement-an-o/_explore-20260630T131220Z/`), the adversarial-verification workflow (2026-06-30), and the in-place v1 decision recorded in memory `ap-implement-brief-verify-handoff-gap`. This plan stands in for the `/ap:design` spec (the user chose to write the plan directly); the rationale above is the spec.

## Global Constraints

- `dist/` is committed (zero-build install): after changing `src/`, run `npm run build` and commit the refreshed `dist/ap.cjs`.
- Atomic writes for all state files (tmp-in-same-dir + rename) — use the existing `atomicWrite` helper; never write to `/tmp` then rename.
- Errors to **stderr** (`log.error`), never stdout; machine-readable `KEY=value` lines to **stdout**.
- No emojis in shipped output (grep-ability).
- The **frozen wire protocol is untouched** (no new event names/fields; `ready/ack/progress/done/error/question`, `END_OF_INSTRUCTION` unchanged). This feature is hub-side only.
- tmux/process execution is the only subprocess surface and is **never** spawned in unit tests — test pure functions + verbs with an **injected runner**; the live `execFileSync` runner is exercised only by the live dogfood.
- Test isolation: each test sets a fresh `AP_HOME` via `freshHome()` from `tests/helpers/tmpHome.ts`.
- Threat model for v1 = **honest worker**: the hub re-run defeats a forged/stale self-reported test log. It does **not** sandbox a committed test-code trojan (that needs containerization — explicitly out of v1 scope).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/implementVerifyTests.ts` (**create**) | Pure verdict classifier `classifyTestRun` + the `TestRunner` interface + the live `execFileSync`-based runner. One responsibility: run the repo's test command in a cwd and classify the exit code. |
| `src/commands/implement.ts` (**modify**) | Add `verifyTestsWith`/`verifyTestsRun` + register `verify-tests` in the `run()` switch + update `usage()`. |
| `commands/implement.md` (**modify**) | Stage 2 calls `verify-tests` first and gates the cross-verify VERDICT on `HUB_RC`/`VERDICT`. |
| `tests/implement-verify-tests.test.ts` (**create**) | Unit tests: `classifyTestRun` (pure) + `verifyTestsWith` (injected runner + temp `AP_HOME`). |
| `dist/ap.cjs` (**rebuild + commit**) | Refreshed esbuild bundle. |

---

## Task 1: Pure verdict classifier + test runner module

**Files:**
- Create: `src/core/implementVerifyTests.ts`
- Test: `tests/implement-verify-tests.test.ts` (the `classifyTestRun` describe block; the verb block is added in Task 2)

**Interfaces:**
- Produces: `classifyTestRun(testCmd: string, code: number | null): TestVerdict` where `type TestVerdict = "pass" | "fail" | "unverifiable" | "none"`; `interface TestRunResult { code: number; output: string }`; `interface TestRunner { run(cwd: string, testCmd: string, timeoutS: number): TestRunResult }`; `const liveTestRunner: TestRunner`.

- [ ] **Step 1: Write the failing test**

Create `tests/implement-verify-tests.test.ts` with the classifier block:

```ts
// tests/implement-verify-tests.test.ts — hub-side independent test re-run (v1, in-place).
import { describe, it, expect } from "vitest";
import { classifyTestRun } from "../src/core/implementVerifyTests.js";

describe("classifyTestRun (pure)", () => {
  it("no command detected -> none", () => {
    expect(classifyTestRun("", 0)).toBe("none");
    expect(classifyTestRun("", null)).toBe("none");
  });
  it("exit 0 -> pass", () => {
    expect(classifyTestRun("npm test", 0)).toBe("pass");
  });
  it("exit 124 (timeout) -> unverifiable", () => {
    expect(classifyTestRun("npm test", 124)).toBe("unverifiable");
  });
  it("any other non-zero (incl. null) -> fail", () => {
    expect(classifyTestRun("npm test", 1)).toBe("fail");
    expect(classifyTestRun("npm test", 127)).toBe("fail");
    expect(classifyTestRun("npm test", null)).toBe("fail");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/implement-verify-tests.test.ts`
Expected: FAIL — cannot resolve `../src/core/implementVerifyTests.js` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/implementVerifyTests.ts`:

```ts
// src/core/implementVerifyTests.ts — hub-side independent test re-run for /ap:implement (v1, in-place).
// The hub re-runs the repo's OWN test command (detectTestCommand) in the worker's target_cwd on the
// worker's branch, capturing the HUB's own exit code, so a worker can no longer pass on a forged or
// stale self-reported test log. v1 is IN-PLACE (no git worktree): target_cwd already has node_modules,
// so there is no dependency-reproduction step. Threat model = honest worker (defeats a forged log); it
// does NOT sandbox a committed test-code trojan (that needs containerization — out of v1 scope).
import { execFileSync } from "node:child_process";

export type TestVerdict = "pass" | "fail" | "unverifiable" | "none";

/** Map a hub test re-run to a verdict. Pure.
 *  - testCmd === "" (no suite detected) -> "none"  (Stage 2 falls back to the worker's report)
 *  - exit 0                              -> "pass"
 *  - exit 124 (GNU timeout killed it)    -> "unverifiable"
 *  - any other non-zero (incl. null)     -> "fail" */
export function classifyTestRun(testCmd: string, code: number | null): TestVerdict {
  if (testCmd === "") return "none";
  if (code === 0) return "pass";
  if (code === 124) return "unverifiable";
  return "fail";
}

export interface TestRunResult { code: number; output: string; }
export interface TestRunner { run(cwd: string, testCmd: string, timeoutS: number): TestRunResult; }

/** Live runner: `timeout <timeoutS> bash -c -- "<testCmd>"` in cwd; combined stdout+stderr captured,
 *  exit code returned (124 on timeout). Large maxBuffer — a full suite's output can exceed 1MB.
 *  Never throws: a non-zero exit is returned as {code, output}, not raised. */
export const liveTestRunner: TestRunner = {
  run(cwd, testCmd, timeoutS) {
    try {
      const output = execFileSync("timeout", [String(timeoutS), "bash", "-c", "--", testCmd], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
      });
      return { code: 0, output };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      const output = (err.stdout != null ? String(err.stdout) : "") + (err.stderr != null ? String(err.stderr) : "");
      return { code: typeof err.status === "number" ? err.status : 1, output };
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/implement-verify-tests.test.ts`
Expected: PASS (4 tests in the `classifyTestRun (pure)` block).

- [ ] **Step 5: Commit**

```bash
git add src/core/implementVerifyTests.ts tests/implement-verify-tests.test.ts
git commit -m "feat(implement): add pure test-run classifier + live runner for hub-side verify"
```

---

## Task 2: The `verify-tests` verb

**Files:**
- Modify: `src/commands/implement.ts` (imports near top; new `verifyTestsRun`/`verifyTestsWith`; `run()` switch ~`src/commands/implement.ts:88-104`; `usage()` ~`src/commands/implement.ts:43-46`)
- Test: `tests/implement-verify-tests.test.ts` (add the verb describe block)

**Interfaces:**
- Consumes: `classifyTestRun`, `liveTestRunner`, `TestRunner` from `../core/implementVerifyTests.js`; `detectTestCommand` (already imported from `../core/quick.js`); `readField` (already imported from `../core/fsread.js`); `atomicWrite`, `isoUtc`, `implementArtDir` (already imported).
- Produces: `export interface VerifyTestsDeps { runner: TestRunner; detect(root: string): string; now(): string }`; `export async function verifyTestsWith(topic: string, round: number, d: VerifyTestsDeps): Promise<number>`. Stdout contract: `TESTCMD=<cmd|none>\nHUB_RC=<code|>\nVERDICT=<pass|fail|unverifiable|none>\n`. Side effects: writes `$ART/hub-test-output-<round>.log` (only when a command ran) and `$ART/hub-verify-<round>.tsv`.

- [ ] **Step 1: Write the failing test**

Append to `tests/implement-verify-tests.test.ts` (after the `classifyTestRun` block) — and add the new imports at the top of the file:

```ts
// add to the imports already at the top of tests/implement-verify-tests.test.ts:
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { implementArtDir } from "../src/core/implement.js";
import { verifyTestsWith, type VerifyTestsDeps } from "../src/commands/implement.js";
import type { TestRunner } from "../src/core/implementVerifyTests.js";

async function capture(fn: () => Promise<number>): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

function deps(runner: TestRunner, testCmd: string): VerifyTestsDeps {
  return { runner, detect: (_root: string) => testCmd, now: () => "2026-06-30T00:00:00Z" };
}

describe("implement verify-tests (in-place hub re-run)", () => {
  it("green run -> VERDICT=pass, writes hub-test-output + hub-verify.tsv, rc 0", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-pass");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    const runner: TestRunner = { run: (_cwd, _cmd, _to) => ({ code: 0, output: "Test Files 10 passed\n" }) };
    const { rc, out } = await capture(() => verifyTestsWith("vt-pass", 1, deps(runner, "npm test")));
    expect(rc).toBe(0);
    expect(out).toContain("TESTCMD=npm test\n");
    expect(out).toContain("HUB_RC=0\n");
    expect(out).toContain("VERDICT=pass\n");
    expect(readFileSync(join(art, "hub-test-output-1.log"), "utf8")).toBe("Test Files 10 passed\n");
    expect(readFileSync(join(art, "hub-verify-1.tsv"), "utf8")).toContain("verdict=pass");
    h.cleanup();
  });

  it("failing run -> VERDICT=fail, HUB_RC carries the code", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-fail");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    const runner: TestRunner = { run: () => ({ code: 1, output: "1 failed\n" }) };
    const { rc, out } = await capture(() => verifyTestsWith("vt-fail", 2, deps(runner, "npm test")));
    expect(rc).toBe(0);
    expect(out).toContain("HUB_RC=1\n");
    expect(out).toContain("VERDICT=fail\n");
    expect(readFileSync(join(art, "hub-test-output-2.log"), "utf8")).toBe("1 failed\n");
    h.cleanup();
  });

  it("timeout (124) -> VERDICT=unverifiable", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-timeout");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    const runner: TestRunner = { run: () => ({ code: 124, output: "...partial...\n" }) };
    const { out } = await capture(() => verifyTestsWith("vt-timeout", 1, deps(runner, "npm test")));
    expect(out).toContain("VERDICT=unverifiable\n");
    h.cleanup();
  });

  it("no test command -> VERDICT=none, no hub-test-output, runner NOT called", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-none");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    let called = false;
    const runner: TestRunner = { run: () => { called = true; return { code: 0, output: "" }; } };
    const { out } = await capture(() => verifyTestsWith("vt-none", 1, deps(runner, "")));
    expect(out).toContain("TESTCMD=none\n");
    expect(out).toContain("VERDICT=none\n");
    expect(called).toBe(false);
    expect(existsSync(join(art, "hub-test-output-1.log"))).toBe(false);
    h.cleanup();
  });

  it("missing target_cwd.txt -> rc 1", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-notarget");
    mkdirSync(art, { recursive: true });
    const runner: TestRunner = { run: () => ({ code: 0, output: "" }) };
    expect(await verifyTestsWith("vt-notarget", 1, deps(runner, "npm test"))).toBe(1);
    h.cleanup();
  });

  it("missing art-dir -> rc 1", async () => {
    const h = freshHome();
    const runner: TestRunner = { run: () => ({ code: 0, output: "" }) };
    expect(await verifyTestsWith("vt-noart", 1, deps(runner, "npm test"))).toBe(1);
    h.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/implement-verify-tests.test.ts`
Expected: FAIL — `verifyTestsWith` / `VerifyTestsDeps` are not exported from `../src/commands/implement.js`.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/implement.ts`, add to the existing import from `../core/implementVerifyTests.js` (new import line, place it near the other `../core/*` imports):

```ts
import { classifyTestRun, liveTestRunner, type TestRunner } from "../core/implementVerifyTests.js";
```

Add the verb body (place it after `scopeCheckWith`, before the `summary` section):

```ts
// ---- verify-tests (v1 hub-side independent test re-run, IN-PLACE in target_cwd) ----
export interface VerifyTestsDeps { runner: TestRunner; detect(root: string): string; now(): string; }
const liveVerifyTestsDeps: VerifyTestsDeps = { runner: liveTestRunner, detect: detectTestCommand, now: isoUtc };
function implementTestTimeout(): number { return Number(process.env.AP_IMPLEMENT_TEST_TIMEOUT_S) || 1800; }
async function verifyTestsRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  if (!topic || !roundStr) { log.error("usage: implement verify-tests <topic> <round>"); return 2; }
  if (!/^[1-9][0-9]*$/.test(roundStr)) { log.error(`implement verify-tests: round must be a positive integer (got: ${roundStr})`); return 2; }
  return verifyTestsWith(topic, Number(roundStr), liveVerifyTestsDeps);
}
/** Hub-side independent test re-run for round <round>. Runs the repo's detected test command in
 *  target_cwd (the worker's branch, in place) and classifies the hub's OWN exit code. Writes
 *  hub-test-output-<round>.log (only when a command ran) + hub-verify-<round>.tsv; prints
 *  TESTCMD=/HUB_RC=/VERDICT= to stdout for the Stage 2 directive. rc 0 always on a completed run;
 *  rc 1 only when the art-dir / target_cwd.txt is missing. */
export async function verifyTestsWith(topic: string, round: number, d: VerifyTestsDeps): Promise<number> {
  const art = implementArtDir(topic);
  if (!existsSync(art)) { log.error(`implement verify-tests: art-dir missing: ${art}`); return 1; }
  const targetFile = join(art, "target_cwd.txt");
  if (!existsSync(targetFile)) { log.error(`implement verify-tests: target_cwd.txt missing under ${art}`); return 1; }
  const targetCwd = readField(targetFile);
  const testCmd = d.detect(targetCwd);
  let code: number | null = null;
  if (testCmd !== "") {
    const r = d.runner.run(targetCwd, testCmd, implementTestTimeout());
    code = r.code;
    atomicWrite(join(art, `hub-test-output-${round}.log`), r.output);
  }
  const verdict = classifyTestRun(testCmd, code);
  atomicWrite(join(art, `hub-verify-${round}.tsv`),
    `round=${round}\ntest_cmd=${testCmd}\nhub_rc=${code === null ? "" : code}\nverdict=${verdict}\nverified_ts=${d.now()}\n`);
  process.stdout.write(`TESTCMD=${testCmd || "none"}\nHUB_RC=${code === null ? "" : code}\nVERDICT=${verdict}\n`);
  log.ok(`implement verify-tests: round=${round} verdict=${verdict}${testCmd ? ` (rc=${code})` : ""}`);
  return 0;
}
```

Register the verb in the `run()` switch (after `case "scope-check":`):

```ts
    case "verify-tests": return verifyTestsRun(rest);
```

Update `usage()` to list it:

```ts
  log.error("usage: implement <init|audit|pre-snapshot|branch|turn-send|turn-wait|reset-status|scope-check|verify-tests|summary|finish|forensics|archive|find-latest-doc> ...");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/implement-verify-tests.test.ts`
Expected: PASS (the `classifyTestRun` block + all 6 verb tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/implement.ts tests/implement-verify-tests.test.ts
git commit -m "feat(implement): add verify-tests verb (in-place hub-side test re-run)"
```

---

## Task 3: Wire Stage 2 to gate on the hub re-run + rebuild dist

**Files:**
- Modify: `commands/implement.md` (Stage 2, currently `commands/implement.md:166-184`)
- Rebuild: `dist/ap.cjs`

**Interfaces:**
- Consumes: the `verify-tests` verb stdout contract from Task 2 (`TESTCMD=`/`HUB_RC=`/`VERDICT=`).

- [ ] **Step 1: Replace the Stage 2 opening with a hub-re-run gate**

In `commands/implement.md`, replace the block from the `## Stage 2 — cross-verify (Hub)` heading through the `up to 3 spot-checks ...` bullet (the current `commands/implement.md:166-174`) with:

```markdown
## Stage 2 — cross-verify (Hub)

**Step A — independent test re-run (do this FIRST; the hub runs the tests itself).** Run
`$CS implement verify-tests <TOPIC> <ROUND>`. It runs the repo's own test command
(`detectTestCommand`) **in `TARGET_CWD` on the worker's branch** and prints `TESTCMD=`/`HUB_RC=`/
`VERDICT=` (and writes `$ART/hub-test-output-<ROUND>.log`). The default suite budget is 30 min
(`AP_IMPLEMENT_TEST_TIMEOUT_S=1800`). Branch on `VERDICT`:
- **`fail`** — the worker's green claim is contradicted by the hub's OWN run. This is authoritative
  over the worker's `test-output-<ROUND>.log`: read the `$ART/hub-test-output-<ROUND>.log` tail to
  identify the failing tests, set `VERDICT: FAIL`, and go to Stage 3 with one `[bug]` per failing
  test. (Exception — judgment: if the hub log shows an **environment** error such as
  `command not found` / missing toolchain rather than real test failures, treat it as `unverifiable`
  below, not a FAIL, to avoid a needless fix round.)
- **`unverifiable`** (`HUB_RC=124` timeout, or an environment error) — note it in the cross-verify
  doc; fall through to the read-based checks below, do **not** auto-FAIL.
- **`none`** (`TESTCMD=none`, no suite detected) — no hub re-run is possible; fall through to the
  read-based checks, and record "tests not independently verified" in the cross-verify doc.
- **`pass`** — the suite is green on the hub's own run; continue to the read-based checks below for
  spec/scope coverage.

**Step B — read-based cross-verify.** Invoke `superpowers:verification-before-completion`. Read (capped):
- `$ART/verify-report-<ROUND>.md` (the worker's self-verify),
- `$ART/hub-test-output-<ROUND>.log` (the HUB's own run — authoritative) and, only as the worker's
  claim, `$ART/test-output-<ROUND>.log`,
- `git -C "$TARGET_CWD" log --oneline "$(cat "$ART/branch-base.sha")"..HEAD` and
  `git -C "$TARGET_CWD" diff --stat "$(cat "$ART/branch-base.sha")"..HEAD`,
- up to 3 spot-checks: Read the highest-stakes diff hunk per critical requirement (paths from
  `git diff` are relative to `TARGET_CWD`; prefix them).
```

(The remainder of Stage 2 — "Write the verdict to `$ART/cross-verify-<ROUND>.md` …" onward — is unchanged.)

- [ ] **Step 2: Verify the directive references the new verb**

Run: `grep -n "verify-tests" commands/implement.md`
Expected: at least one line in Stage 2 (`$CS implement verify-tests <TOPIC> <ROUND>`).

- [ ] **Step 3: Rebuild the committed bundle**

Run: `npm run build`
Expected: esbuild writes `dist/ap.cjs` with no error.

- [ ] **Step 4: Smoke-test the verb through the bundle**

Run:
```bash
node dist/ap.cjs implement verify-tests 2>&1 | head -1
```
Expected: `usage: implement verify-tests <topic> <round>` (rc 2 — confirms the verb is dispatched, not "unknown verb").

- [ ] **Step 5: Full gate**

Run: `npm run typecheck && npm run test && npm run lint && npm run build`
Expected: tsc clean; all vitest tests pass (existing suite + the new `implement-verify-tests.test.ts`); eslint clean; build clean.

- [ ] **Step 6: Commit**

```bash
git add commands/implement.md dist/ap.cjs
git commit -m "feat(implement): gate Stage 2 cross-verify on hub's own test re-run; rebuild dist"
```

---

## Self-Review

**1. Spec coverage** (against the Goal + design provenance):
- "Hub independently re-runs the suite" → Task 1 (runner) + Task 2 (verb) + Task 3 (Stage 2 gate). ✓
- "In-place, no worktree, no dep reproduction" → `verifyTestsWith` runs in `target_cwd` directly; no `gitwork.ts` change. ✓
- "Gate on the hub's own exit code, not the worker's log" → Stage 2 Step A branches on `VERDICT`/`HUB_RC`; the worker's `test-output` is demoted to "claim". ✓
- "No suite detected → fall back, don't auto-FAIL" → `VERDICT=none` path. ✓
- "Timeout/env error → unverifiable, don't auto-FAIL" → `124`→`unverifiable` + the directive's env-error judgment clause. ✓
- "Frozen protocol untouched" → no IPC/event changes; hub-side verb only. ✓
- "forensics-friendly hub log name" → `hub-test-output-<round>.log` (globbed by `forensics.ts:111`). ✓
- Out of scope (correctly absent): git worktree isolation, baseline-differential FAIL→PASS, VERDICT-line parsing in `implementState`, brief rewrite — all deferred to a later pass per the v1 decision.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N"; every code step has complete code; every run step has an exact command + expected output. ✓

**3. Type consistency:** `TestVerdict`, `TestRunner`, `TestRunResult`, `VerifyTestsDeps`, `classifyTestRun`, `liveTestRunner`, `verifyTestsWith` are named identically across Tasks 1–2 and the test file. The stdout keys `TESTCMD`/`HUB_RC`/`VERDICT` match between the verb (Task 2) and the directive (Task 3). The `.tsv` keys (`round`/`test_cmd`/`hub_rc`/`verdict`/`verified_ts`) are self-consistent. ✓
