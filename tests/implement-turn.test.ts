// tests/implement-turn.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { implementState, composeRound1Prompt, composeFixPrompt, blockers, WORKER_VERDICTS } from "../src/core/implementTurn.js";
import { PIN_MARKER } from "../src/core/implementVerifyTests.js";

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
  it("encodes planning, scoped implementation, and fresh verification without an external skill dependency", () => {
    expect(p).toContain("task-by-task implementation plan");
    expect(p).toContain("Keep each change scoped to its task");
    expect(p).toContain("Verify with fresh evidence");
    expect(p).not.toContain("superpowers:");
  });
});

describe("composeFixPrompt", () => {
  const bundle = "1. [bug] test foo crashes on null input\n2. [spec-gap] missing retry path";
  const p = composeFixPrompt(2, bundle, "/state/topic/_implement/verify-report-2.md", "");
  it("names the round + fix loop, embeds the bundle verbatim, and spells out issue routing", () => {
    expect(p).toContain("ROUND 2 of /ap:implement (fix loop)");
    expect(p).toContain("ISSUES TO ADDRESS:");
    expect(p).toContain(bundle);
    expect(p).toContain("supported root");
    expect(p).toContain("re-plan the gap");
    expect(p).toContain("code-review subagent");
    expect(p).toContain("commit's SHA");
    expect(p).not.toContain("superpowers:");
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

// ---------------------------------------------------------------------------
// Verdict honesty (PR B): the ENV line, the skipped-leg => PARTIAL rule, the MUTATION: requirement,
// and the regenerate-never-edit clause. Every expectation below is a LITERAL typed out here — never
// read back from the implementation's own constants (see the mirrored-gate guard at the bottom).
// ---------------------------------------------------------------------------

const ENV_LINE =
  "ENV: shell=<as observed>; suite=<cmd>; legs=<ran ... / skipped ... + why>; build=<generated or native artifacts present, or rebuilt by you>";
const PARTIAL_RULE = "If ANY leg was skipped for an environment reason, the verdict is PARTIAL";
const MUTATION_REQ = "MUTATION: <file:line> <the change you made to break it> -> <observed failure>";
const MIRROR_RULE = "never the implementation's own output read back at itself";
const REGENERATE_CLAUSE = "Never hand-edit a committed evidence/measurement record to satisfy an";

describe("verdict honesty — the report contract in both composers", () => {
  const r1 = composeRound1Prompt({
    designPath: "/a/design.md", planPath: "/a/plan.md", verifyPath: "/a/verify-report-1.md", round: 1, testCmd: "npm test",
  });
  const fx = composeFixPrompt(2, "1. [bug] boom", "/a/verify-report-2.md", "npm test");

  it("round-1 requires the ENV line, the skipped-leg => PARTIAL rule, and MUTATION evidence", () => {
    expect(r1).toContain("Line 2 of the report MUST be:");
    expect(r1).toContain(ENV_LINE);
    expect(r1).toContain(PARTIAL_RULE);
    expect(r1).toContain("a green default leg is not PASS");
    expect(r1).toContain(MUTATION_REQ);
    expect(r1).toContain("A gate you never watched fail is not evidence.");
    expect(r1).toContain(MIRROR_RULE);
  });

  it("the fix round requires the same ENV line, PARTIAL rule, and MUTATION evidence", () => {
    expect(fx).toContain("Line 2 of the report MUST be:");
    expect(fx).toContain(ENV_LINE);
    expect(fx).toContain(PARTIAL_RULE);
    expect(fx).toContain("a green default leg is not PASS");
    expect(fx).toContain(MUTATION_REQ);
    expect(fx).toContain("A gate you never watched fail is not evidence.");
    expect(fx).toContain(MIRROR_RULE);
  });

  it("the fix round's ROUTING forbids hand-editing a generated record", () => {
    expect(fx).toContain(REGENERATE_CLAUSE);
    expect(fx).toContain("re-run its producer and commit the regenerated record");
    expect(fx).toContain("halt");
  });
});

// MIRRORED-GATE GUARD. A gate built from the same const as its implementation moves with it: delete
// PARTIAL from WORKER_VERDICTS and an interpolated prompt + an interpolated assertion both change,
// and the suite stays green. So the composers keep the verdict line as a LITERAL, this test asserts
// that LITERAL, and the source is read to prove no composer interpolates the const into it.
describe("MIRRORED-GATE GUARD — the worker verdict line is a literal, never interpolated", () => {
  const src = readFileSync(join(process.cwd(), "src", "core", "implementTurn.ts"), "utf8");
  const r1 = composeRound1Prompt({
    designPath: "/a/design.md", planPath: "/a/plan.md", verifyPath: "/a/verify-report-1.md", round: 1, testCmd: "",
  });
  const fx = composeFixPrompt(2, "1. [bug] boom", "/a/verify-report-2.md", "");

  it("both composers emit the literal `VERDICT: PASS|PARTIAL|FAIL`", () => {
    expect(r1).toContain("VERDICT: PASS|PARTIAL|FAIL");
    expect(fx).toContain("VERDICT: PASS|PARTIAL|FAIL");
  });

  it("the composers' verdict line is hardcoded in the source, not built from WORKER_VERDICTS", () => {
    expect(src).toContain("VERDICT: PASS|PARTIAL|FAIL");
    expect(src, "a composer interpolates its verdict line — the gate would mirror the const").not.toMatch(/VERDICT: \$\{/);
    expect(src, "WORKER_VERDICTS is being joined into a prompt — keep the prompt literal").not.toMatch(/WORKER_VERDICTS\s*[.[]/);
  });
});

// Producer<->consumer contract, in the style of tests/implement-verify-tests.test.ts: the verdicts the
// composers offer the worker must each have a branch in the directive the hub follows. PARTIAL had
// none before this PR, so an honest PARTIAL was consumed as not-FAIL, i.e. as PASS.
describe("worker VERDICT <-> commands/implement.md directive contract", () => {
  const md = readFileSync(join(process.cwd(), "commands", "implement.md"), "utf8");
  const quick = readFileSync(join(process.cwd(), "commands", "quick.md"), "utf8");

  it("every worker verdict has a branch in implement.md", () => {
    for (const v of WORKER_VERDICTS) {
      expect(md, `implement.md has no branch for VERDICT: ${v}`).toContain(`VERDICT: ${v}`);
    }
  });

  it("Stage 2 Step B cannot promote a PARTIAL without running the skipped legs itself", () => {
    expect(md).toContain("VERDICT: PARTIAL");
    expect(md).toContain("running those legs YOURSELF");
    expect(md).toContain("`ENV:` line");
  });

  it("Stage 2 Step B cross-checks new gates and records the tally", () => {
    expect(md).toContain("MUTATION:");
    expect(md).toContain("gate added without mutation evidence");
    expect(md).toContain("NEW_GATES=<n> MUTATION_LINES=<n>");
  });

  it("Stage 2 Step B states the shell asymmetry the right way round", () => {
    expect(md).toContain("`bash -ic 'exec <binary>'`");
    expect(md).toMatch(/`~\/\.bashrc` \*\*is\*\* sourced and\s+only `~\/\.profile` is not/);
    expect(md).toMatch(/the hub's own re-run is `bash -c`\s+\(`src\/core\/implementVerifyTests\.ts`, `runBounded`\) and sources \*\*nothing\*\*/);
    // The design's dogfood acceptance line: a pinned re-run announces its pin as the log's first line.
    expect(md).toMatch(/`hub-test-output-<ROUND>\.log` opens with `PYTHONPATH_PIN=<pin>`/);
    // ...and the marker the directive names is the one the producer emits (the TEST_VERDICTS pattern).
    expect(md).toContain(`\`hub-test-output-<ROUND>.log\` opens with \`${PIN_MARKER}<pin>\``);
    // The absence of that line means "unpinned" only for a re-run that RAN: a spawn failure writes
    // the error as the whole log, marker or not.
    expect(md).toMatch(/before trusting a re-run that actually ran \(`VERDICT=pass\|fail`\)/);
  });

  it("Stage 3 carries the regenerate-never-edit rules", () => {
    expect(md).toContain("**Generated records — regenerate, never edit.**");
    expect(md).toContain('never write "do NOT\n  re-run"');
    expect(md).toContain("downgrade the round's claim");
    expect(md).toContain("cannot be its own baseline");
  });

  it("quick.md Stage 2 carries the PARTIAL VERIFY form and the regenerate rule", () => {
    expect(quick).toContain('VERIFY="PARTIAL (<cmd>) — legs skipped: <names>"');
    expect(quick).toContain('never "edit"/"update" the record itself');
  });
});
