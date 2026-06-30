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
