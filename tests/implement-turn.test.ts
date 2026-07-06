// tests/implement-turn.test.ts
import { describe, it, expect } from "vitest";
import { implementState, composeRound1Prompt, composeFixPrompt, blockers } from "../src/core/implementTurn.js";

describe("implement test-command auto-detect", () => {
  it("round-1 prompt names the detected command and drops the hardcoded one", () => {
    const p = composeRound1Prompt({ designPath: "/a/design.md", planPath: "/a/plan.md", verifyPath: "/a/verify-report-1.md", round: 1, testCmd: "npm test" });
    expect(p).toContain("npm test");
    expect(p).not.toContain("bash tests/run.sh");
  });
  it("round-1 prompt falls back to generic wording when no command detected", () => {
    const p = composeRound1Prompt({ designPath: "/a/design.md", planPath: "/a/plan.md", verifyPath: "/a/verify-report-1.md", round: 1, testCmd: "" });
    expect(p).toContain("the repository's full test suite");
    expect(p).not.toContain("bash tests/run.sh");
    expect(p).not.toContain("()"); // no empty backtick command artifact
  });
  it("fix prompt names the detected command via blockers", () => {
    const p = composeFixPrompt(2, "ISSUE", "/a/verify-report-2.md", "make test");
    expect(p).toContain("make test");
    expect(p).not.toContain("bash tests/run.sh");
  });
  it("blockers() switches command vs generic on testCmd", () => {
    expect(blockers("pytest")).toContain("Running 'pytest' is your job");
    expect(blockers("")).toContain("Running your repository's test suite is your job");
    expect(blockers("")).not.toContain("bash tests/run.sh");
  });
  it("blockers() carries the objection clause (OBJECTION: marker, omit claim)", () => {
    expect(blockers("")).toContain('"OBJECTION:"');
    expect(blockers("")).toMatch(/PLAN ITSELF is wrong/);
    expect(blockers("pytest")).toContain('"OBJECTION:"');
  });
});

describe("implementState", () => {
  it("null event (no terminal before timeout) -> timeout", () => {
    expect(implementState(null, "VERDICT: PASS\n")).toBe("timeout");
    expect(implementState(null, null)).toBe("timeout");
  });
  it("question event -> question (verify text ignored)", () => {
    expect(implementState({ event: "question", message: "?" }, null)).toBe("question");
    expect(implementState({ event: "question", message: "?" }, "VERDICT: PASS\n")).toBe("question");
  });
  it("done event -> ok iff verify-report present AND non-empty (the -f && -s test), else failed", () => {
    expect(implementState({ event: "done", summary: "Round 1 complete" }, "VERDICT: PASS\n")).toBe("ok");
    expect(implementState({ event: "done", summary: "Round 1 complete" }, "")).toBe("failed");
    expect(implementState({ event: "done", summary: "Round 1 complete" }, null)).toBe("failed");
  });
  it("error event -> failed; unknown event -> failed (the * catch-all)", () => {
    expect(implementState({ event: "error", reason: "boom" }, "VERDICT: PASS\n")).toBe("failed");
    expect(implementState({ event: "weird" }, "VERDICT: PASS\n")).toBe("failed");
  });
});

describe("composeRound1Prompt", () => {
  const p = composeRound1Prompt({
    designPath: "/state/topic/_implement/design.md",
    planPath: "/state/topic/_implement/plan.md",
    verifyPath: "/state/topic/_implement/verify-report-1.md",
    testCmd: "",
  });
  it("names ROUND 1, the three phases, and the design/plan/verify paths", () => {
    expect(p).toContain("ROUND 1 of /ap:implement");
    expect(p).toContain("PHASE 1: Plan");
    expect(p).toContain("PHASE 2: Implement");
    expect(p).toContain("PHASE 3: Self-verify");
    expect(p).toContain("/state/topic/_implement/design.md");
    expect(p).toContain("/state/topic/_implement/plan.md");
    expect(p).toContain("/state/topic/_implement/verify-report-1.md");
  });
  it("requires the VERDICT line and tees the per-round test-output log into the verify dir", () => {
    expect(p).toContain("VERDICT: PASS|PARTIAL|FAIL");
    expect(p).toContain("/state/topic/_implement/test-output-1.log");
  });
  it("is branch-disciplined and documents the halt-and-ask question protocol", () => {
    expect(p).toMatch(/do NOT run 'git checkout', 'git switch'/i);
    expect(p).toContain('"event":"error","reason":"branch-discipline');
    expect(p).not.toContain("worker-ask.sh");
    expect(p).not.toContain("inbox-ack.sh");
    expect(p).toContain('{"event":"question"');
    expect(p).toContain('{"event":"ack"');
  });
  it("carries NO canonical fence and NO done-event line (inboxWrite appends them)", () => {
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
  });
  it("carries no stale rebrand tokens", () => {
    expect(p).not.toMatch(/clone-wars/);
    expect(p).not.toMatch(/cw_/);
    expect(p).not.toMatch(/master[ -]?yoda/i);
    expect(p).not.toMatch(/trooper|commander/i);
  });
  it("honors a custom round number in the test-output log name", () => {
    const r3 = composeRound1Prompt({ designPath: "/d", planPath: "/p", verifyPath: "/v/verify-report-3.md", round: 3, testCmd: "" });
    expect(r3).toContain("ROUND 3 of /ap:implement");
    expect(r3).toContain("/v/test-output-3.log");
  });
  it("round-1 prompt tells the worker to log TEST_DURATION_S to the duration file", () => {
    const p = composeRound1Prompt({ designPath: "/a/design.md", planPath: "/a/plan.md", verifyPath: "/a/verify-report-1.md", round: 1, testCmd: "npm test" });
    expect(p).toContain("TEST_DURATION_S");
    expect(p).toContain("/a/worker-test-duration-1.txt");
  });
});

describe("composeFixPrompt", () => {
  const bundle = "1. [bug] test foo crashes on null input\n2. [spec-gap] missing retry path";
  const p = composeFixPrompt(2, bundle, "/state/topic/_implement/verify-report-2.md", "");
  it("names the round + fix loop, embeds the bundle verbatim under ISSUES, names the routing skills", () => {
    expect(p).toContain("ROUND 2 of /ap:implement (fix loop)");
    expect(p).toContain("ISSUES TO ADDRESS:");
    expect(p).toContain(bundle);
    expect(p).toMatch(/systematic-debugging/);
    expect(p).toMatch(/writing-plans/);
    expect(p).toMatch(/requesting-code-review/);
  });
  it("tees the per-round test-output log into the verify dir and requires the VERDICT line", () => {
    expect(p).toContain("/state/topic/_implement/test-output-2.log");
    expect(p).toContain("VERDICT: PASS|PARTIAL|FAIL");
  });
  it("embeds the bundle WITHOUT trimming (the bash cats it raw)", () => {
    const padded = "  leading + trailing spaces  ";
    expect(composeFixPrompt(2, padded, "/v/verify-report-2.md", "")).toContain(padded);
  });
  it("is branch-disciplined, documents the ask protocol, carries no fence/done-line", () => {
    expect(p).toMatch(/do NOT run 'git checkout', 'git switch'/i);
    expect(p).not.toContain("worker-ask.sh");
    expect(p).not.toContain("inbox-ack.sh");
    expect(p).toContain('{"event":"question"');
    expect(p).toContain('{"event":"ack"');
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
  });
  it("carries no stale rebrand tokens", () => {
    expect(p).not.toMatch(/clone-wars/);
    expect(p).not.toMatch(/cw_/);
    expect(p).not.toMatch(/master[ -]?yoda/i);
    expect(p).not.toMatch(/trooper|commander/i);
  });
});
