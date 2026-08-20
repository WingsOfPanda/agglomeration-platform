// tests/implement-verify-tests.test.ts — hub-side independent test re-run (v1, in-place).
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { implementArtDir } from "../src/core/implement.js";
import { classifyTestRun, parseWorkerDuration, shouldSkipVerify, liveTestRunner, resolveTimeoutBin, runBounded, TEST_VERDICTS, type TestRunner } from "../src/core/implementVerifyTests.js";
import { verifyTestsWith, type VerifyTestsDeps } from "../src/commands/implement.js";
import { haveCmd } from "../src/core/deps.js";

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

describe("classifyTestRun (pure)", () => {
  it("no command detected -> none", () => {
    expect(classifyTestRun("", 0)).toBe("none");
    expect(classifyTestRun("", null)).toBe("none");
  });
  it("exit 0 -> pass", () => {
    expect(classifyTestRun("npm test", 0)).toBe("pass");
  });
  it("exit 124 (timeout SIGTERM) -> unverifiable", () => {
    expect(classifyTestRun("npm test", 124)).toBe("unverifiable");
  });
  it("exit 137 (timeout --kill-after SIGKILL) -> unverifiable (a kill-on-timeout is a timeout)", () => {
    expect(classifyTestRun("npm test", 137)).toBe("unverifiable");
  });
  it("any other non-zero -> fail", () => {
    expect(classifyTestRun("npm test", 1)).toBe("fail");
    expect(classifyTestRun("npm test", 127)).toBe("fail");
    expect(classifyTestRun("npm test", 143)).toBe("fail");   // external SIGTERM (not a timeout signal)
  });
  // A run that never happened is not evidence. Classifying a spawn failure (no timeout binary on
  // PATH — every stock mac) as "fail" made the hub report its own non-execution as an authoritative
  // test failure, every round, on an EMPTY hub log.
  it("null (the runner could not run at all) -> unverifiable, never fail", () => {
    expect(classifyTestRun("npm test", null)).toBe("unverifiable");
  });
});

describe("resolveTimeoutBin (pure, injected PATH probe)", () => {
  const have = (...present: string[]) => (cmd: string) => present.includes(cmd);
  it("prefers GNU timeout when it is there", () => {
    expect(resolveTimeoutBin(have("timeout", "gtimeout"))).toBe("timeout");
    expect(resolveTimeoutBin(have("timeout"))).toBe("timeout");
  });
  it("falls back to gtimeout (Homebrew coreutils on macOS)", () => {
    expect(resolveTimeoutBin(have("gtimeout"))).toBe("gtimeout");
  });
  it("neither -> null (stock macOS): the caller uses Node's own bound", () => {
    expect(resolveTimeoutBin(have())).toBeNull();
  });
});

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

  // The #143 shape: on a box with no timeout binary the hub's runner never executed, and the verb
  // used to publish that as an authoritative FAIL on an EMPTY log. It is now an empty HUB_RC= and
  // unverifiable, with the spawn error in the log where the operator will see it.
  it("runner could not run at all (code null) -> VERDICT=unverifiable, empty HUB_RC, log has the error", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-spawnfail");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    const runner: TestRunner = { run: () => ({ code: null, output: "spawnSync timeout ENOENT (ENOENT)\n" }) };
    const { rc, out } = await capture(() => verifyTestsWith("vt-spawnfail", 3, deps(runner, "npm test")));
    expect(rc).toBe(0);
    expect(out).toContain("HUB_RC=\n");
    expect(out).toContain("VERDICT=unverifiable\n");
    expect(readFileSync(join(art, "hub-test-output-3.log"), "utf8")).toContain("ENOENT");
    expect(readFileSync(join(art, "hub-verify-3.tsv"), "utf8")).toContain("hub_rc=\n");
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

// The LIVE runner (real `timeout bash -c` exec) is what actually gates every implement verdict; the
// verb tests above all inject a fake, so these exercise the exit-code capture, timeout (124) contract,
// missing-command degradation, and stdout+stderr concatenation for real. These pass with OR without
// a timeout binary on PATH: without one the runner falls back to Node's own bound, which reports a
// kill as the same 124.
describe("liveTestRunner (real exec)", () => {
  const cwd = () => mkdtempSync(join(tmpdir(), "ltr-"));

  it("exit 0 -> code 0, empty output", () => {
    expect(liveTestRunner.run(cwd(), "true", 10)).toEqual({ code: 0, output: "" });
  });
  it("non-zero exit code is carried faithfully (not flattened to 1)", () => {
    expect(liveTestRunner.run(cwd(), "exit 3", 10).code).toBe(3);
  });
  it("captures stdout on the success path", () => {
    const r = liveTestRunner.run(cwd(), "echo HELLO", 10);
    expect(r.code).toBe(0);
    expect(r.output).toContain("HELLO");
  });
  it("captures BOTH stdout and stderr on the failure path", () => {
    const r = liveTestRunner.run(cwd(), "echo OUT; echo ERR >&2; exit 1", 10);
    expect(r.code).toBe(1);
    expect(r.output).toContain("OUT");
    expect(r.output).toContain("ERR");
  });
  it("timeout maps to code 124 (the GNU-timeout contract classifyTestRun relies on)", () => {
    const r = liveTestRunner.run(cwd(), "sleep 5", 1);
    expect(r.code).toBe(124);
    expect(classifyTestRun("sleep 5", r.code)).toBe("unverifiable");
  });
  it("a missing test command degrades to 127 (distinct from timeout, never throws)", () => {
    const r = liveTestRunner.run(cwd(), "definitely_not_a_real_command_zzz", 10);
    expect(r.code).toBe(127);
    expect(r.code).not.toBe(124);
    expect(classifyTestRun("x", r.code)).toBe("fail");
  });
  it("runs in the given cwd", () => {
    const d = cwd();
    writeFileSync(join(d, "marker.txt"), "");
    expect(liveTestRunner.run(d, "test -f marker.txt && echo FOUND", 10).output).toContain("FOUND");
  });
});

// Every branch of the bound, by execution. The catch discipline below is written against error
// shapes READ OFF REAL THROWS, not remembered: ENOENT -> {status: null, signal: null, code:
// "ENOENT", stdout: null}; Node's own bound firing -> {status: null, signal: "SIGKILL", code:
// "ETIMEDOUT"} with the partial stdout attached; an ordinary non-zero exit -> {status: <n>}.
describe("runBounded (real exec, every branch)", () => {
  const cwd = () => mkdtempSync(join(tmpdir(), "rb-"));
  const realBin = resolveTimeoutBin(haveCmd);

  // Linux is the primary platform and its happy path must not move: with a bounding binary, the
  // argv is exactly what shipped before. Asserted through a RECORDING SHIM so the assertion is the
  // argv itself and holds on a box with no GNU timeout at all.
  it("with a bin: the argv is byte-identical to the pre-change GNU timeout command line", () => {
    const d = cwd();
    const record = join(d, "argv.txt");
    const shim = join(d, "timeout-shim");
    writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > ${record}\necho SHIMMED\n`);
    chmodSync(shim, 0o755);
    const r = runBounded(shim, d, "npm test", 30);
    expect(r.code).toBe(0);
    expect(r.output).toContain("SHIMMED");
    expect(readFileSync(record, "utf8").split("\n").slice(0, -1))
      .toEqual(["--kill-after=5", "30", "bash", "-c", "--", "npm test 2>&1"]);
  });

  it.skipIf(realBin === null)("with this machine's real timeout binary: exit 7 -> code 7", () => {
    expect(runBounded(realBin, cwd(), "exit 7", 30).code).toBe(7);
  });

  it.skipIf(realBin === null)("with this machine's real timeout binary: over the bound -> 124", () => {
    expect(runBounded(realBin, cwd(), "sleep 60", 1).code).toBe(124);
  });

  it("no bin (stock macOS): the suite still RUNS under Node's bound", () => {
    const r = runBounded(null, cwd(), "echo hi; exit 0", 30);
    expect(r.code).toBe(0);
    expect(r.output).toContain("hi");
  });

  it("no bin: the command's own exit code is still carried faithfully", () => {
    expect(runBounded(null, cwd(), "exit 7", 30).code).toBe(7);
  });

  // Node kills with a SIGNAL and no status; mapping that onto 124 is what lets classifyTestRun stay
  // a single timeout case across both bounds.
  it("no bin: a run over the bound is killed and reported as 124, exactly like GNU timeout", () => {
    const r = runBounded(null, cwd(), "sleep 60", 1);
    expect(r.code).toBe(124);
    expect(classifyTestRun("npm test", r.code)).toBe("unverifiable");
  });

  it("a bin that does not exist -> code null and a NON-EMPTY log, never a fail verdict", () => {
    const r = runBounded("ap-no-such-bin-xyz", cwd(), "npm test", 30);
    expect(r.code).toBeNull();
    expect(r.output).toContain("ENOENT");
    expect(classifyTestRun("npm test", r.code)).toBe("unverifiable");
  });
});

// Producer<->consumer contract: the machine-readable stdout the verb prints must stay in lockstep with
// the commands/implement.md directive that greps it. Renaming a key or adding a verdict passes every
// other test while silently breaking the directive — this project's recurring drift bug class.
describe("verify-tests stdout <-> implement.md directive contract", () => {
  const md = readFileSync(join(process.cwd(), "commands", "implement.md"), "utf8");

  it("every TestVerdict value is documented as a branch in implement.md Stage 2", () => {
    for (const v of TEST_VERDICTS) {
      expect(md, `implement.md has no branch for VERDICT=${v}`).toContain(`\`${v}\``);
    }
  });

  it("every KEY= token the verb prints is referenced in implement.md", async () => {
    const h = freshHome();
    const art = implementArtDir("vt-contract");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    const runner: TestRunner = { run: () => ({ code: 0, output: "ok\n" }) };
    const { out } = await capture(() => verifyTestsWith("vt-contract", 1, deps(runner, "npm test")));
    const keys = [...out.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]);
    expect(keys).toContain("VERDICT");   // sanity: the verb actually emitted keyed lines
    for (const k of new Set(keys)) {
      expect(md, `implement.md never references the verb's ${k}= stdout key`).toContain(`${k}=`);
    }
    h.cleanup();
  });
});

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
