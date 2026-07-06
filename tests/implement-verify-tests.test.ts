// tests/implement-verify-tests.test.ts — hub-side independent test re-run (v1, in-place).
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { implementArtDir } from "../src/core/implement.js";
import { classifyTestRun, parseWorkerDuration, shouldSkipVerify, liveTestRunner, TEST_VERDICTS, type TestRunner } from "../src/core/implementVerifyTests.js";
import { verifyTestsWith, type VerifyTestsDeps } from "../src/commands/implement.js";

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
  it("exit 124 (timeout) -> unverifiable", () => {
    expect(classifyTestRun("npm test", 124)).toBe("unverifiable");
  });
  it("any other non-zero (incl. null) -> fail", () => {
    expect(classifyTestRun("npm test", 1)).toBe("fail");
    expect(classifyTestRun("npm test", 127)).toBe("fail");
    expect(classifyTestRun("npm test", null)).toBe("fail");
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
// missing-command degradation, and stdout+stderr concatenation for real. Requires GNU `timeout` on
// PATH (present on Linux + the CI runner).
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
