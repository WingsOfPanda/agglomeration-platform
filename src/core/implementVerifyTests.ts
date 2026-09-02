// src/core/implementVerifyTests.ts — hub-side independent test re-run for /ap:implement (v1, in-place).
// The hub re-runs the repo's OWN test command (detectTestCommand) in the worker's target_cwd on the
// worker's branch, capturing the HUB's own exit code, so a worker can no longer pass on a forged or
// stale self-reported test log. v1 is IN-PLACE (no git worktree): target_cwd already has node_modules,
// so there is no dependency-reproduction step. Threat model = honest worker (defeats a forged log); it
// does NOT sandbox a committed test-code trojan (that needs containerization — out of v1 scope).
import { execFileSync } from "node:child_process";
import { haveCmd } from "./deps.js";
import { repoRoot } from "./paths.js";
import { pinFor } from "./provision.js";
import { pinExport } from "./tmux.js";

/** Every verdict the hub verify-tests verb can emit on stdout as `VERDICT=<v>`. Runtime-enumerable
 *  (not just a type) so a test can assert commands/implement.md documents a branch for each — the
 *  producer<->directive contract that guards against a silently-added verdict. */
export const TEST_VERDICTS = ["pass", "fail", "unverifiable", "none", "skipped"] as const;
export type TestVerdict = typeof TEST_VERDICTS[number];

/** Map a hub test re-run to a verdict. Pure.
 *  - testCmd === "" (no suite detected) -> "none"  (Stage 2 falls back to the worker's report)
 *  - exit 0                              -> "pass"
 *  - exit 124 (GNU timeout sent SIGTERM) -> "unverifiable"
 *  - exit 137 (timeout's --kill-after escalated to SIGKILL on a suite that ignored SIGTERM) ->
 *      "unverifiable" too — a killed-on-timeout run is a timeout, not a genuine test failure
 *  - null (the runner itself never RAN: spawn failure, no such binary) -> "unverifiable". A run that
 *      did not happen is not evidence of anything; calling it "fail" makes the hub report its own
 *      non-execution as an authoritative test failure and burns the fix-loop on a phantom regression.
 *  - any other non-zero                  -> "fail" */
export function classifyTestRun(testCmd: string, code: number | null): TestVerdict {
  if (testCmd === "") return "none";
  if (code === 0) return "pass";
  if (code === 124 || code === 137) return "unverifiable";
  if (code === null) return "unverifiable";
  return "fail";
}

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

/** `code` is null when the runner could not execute AT ALL (spawn failure) — distinct from any exit
 *  status the command itself produced. */
export interface TestRunResult { code: number | null; output: string; }
export interface TestRunner { run(cwd: string, testCmd: string, timeoutS: number): TestRunResult; }

/** Which binary bounds a hub test re-run: GNU `timeout` where it exists (Linux, the primary
 *  platform), else `gtimeout` (what Homebrew coreutils installs it as on macOS), else null — stock
 *  macOS ships neither, and a null tells `runBounded` to fall back to Node's own bound. Pure: the
 *  PATH probe is injected (live callers pass `haveCmd`). */
export function resolveTimeoutBin(have: (cmd: string) => boolean): string | null {
  if (have("timeout")) return "timeout";
  if (have("gtimeout")) return "gtimeout";
  return null;
}

/** Run `<testCmd> 2>&1` under bash in cwd, bounded to timeoutS, combined stdout+stderr captured.
 *
 *  With a `bin` (GNU timeout or gtimeout): `<bin> --kill-after=5 <timeoutS> bash -c -- "<cmd> 2>&1"`.
 *  timeout signals the spawned command's whole process group, so same-group test children (vitest
 *  workers, pytest-xdist, ...) are reaped; `--kill-after=5` escalates SIGTERM -> SIGKILL after 5s so
 *  a suite that ignores SIGTERM (exit 124 -> 137) can't linger.
 *
 *  With `bin === null` (no timeout binary anywhere on PATH): bash directly under Node's own
 *  `timeout`/`killSignal` bound. That is a DEGRADED bound — Node kills only the direct child, so
 *  test grandchildren can survive a timeout — but it still runs the suite, which is the whole point:
 *  the alternative is a hub that reports every round as failed because it never ran anything.
 *  `/ap:check` warns when this is the platform's only option.
 *
 *  Large maxBuffer — a full suite's output can exceed 1MB. NEVER throws; the three outcomes are
 *  distinguished by the thrown shape (all verified by execution): a `signal` means Node's bound
 *  killed it (status null, code ETIMEDOUT) -> 124, the same code GNU timeout uses; a numeric
 *  `status` is the command's own exit code; anything else (ENOENT and kin: status null, signal null,
 *  stdout/stderr null) means the runner never ran -> `code: null` with the spawn error as output, so
 *  the hub's log is never blank. */
export function runBounded(bin: string | null, cwd: string, testCmd: string, timeoutS: number, pin = ""): TestRunResult {
  const script = verifyScript(testCmd, pin);
  try {
    const output = bin !== null
      ? execFileSync(bin, ["--kill-after=5", String(timeoutS), "bash", "-c", "--", script], {
          cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
        })
      : execFileSync("bash", ["-c", "--", script], {
          cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
          timeout: timeoutS * 1000, killSignal: "SIGKILL",
        });
    return { code: 0, output };
  } catch (e: unknown) {
    const err = e as { status?: number | null; signal?: string | null; code?: string; message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
    const output = (err.stdout != null ? String(err.stdout) : "") + (err.stderr != null ? String(err.stderr) : "");
    if (err.signal) return { code: 124, output };
    if (typeof err.status === "number") return { code: err.status, output };
    return { code: null, output: output || `${err.message ?? "the hub could not run the test command"} (${err.code ?? "spawn failed"})\n` };
  }
}

/** The bash script a re-run executes. `pin` (src/core/provision.ts) is the worktree's PYTHONPATH
 *  entry list, exported FIRST so a site-packages shadow of the repo cannot make this in-place re-run
 *  test the main checkout while reporting on the worktree (issue #183 landed exactly here: the hub
 *  pane is spawned at the repo root and stays unpinned on purpose, so the pin has to ride the one
 *  child process whose cwd ap chooses). An empty pin is byte-identical to the script shipped before
 *  the pin existed. Pure, so the composition is testable without an exec. */
export function verifyScript(testCmd: string, pin: string): string {
  return pin ? `${pinExport(pin)}; ${testCmd} 2>&1` : `${testCmd} 2>&1`;
}

/** Live runner: resolve the bounding binary, derive the pin for THIS cwd, then `runBounded`. Never
 *  throws. The pin is "" unless `cwd` is a worktree ap created under the main checkout AND something
 *  in the operator's site-packages resolves the repo from that checkout. */
export const liveTestRunner: TestRunner = {
  run(cwd, testCmd, timeoutS) {
    return runBounded(resolveTimeoutBin(haveCmd), cwd, testCmd, timeoutS, pinFor(repoRoot(), cwd));
  },
};
