// tests/implement-turn-slices.test.ts — the parallel-slices prompt composers and the per-turn
// evidence resolver (2026-09-04-parallel-slices-design.md, B / E / G / J).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  composeRound1Prompt, composeFixPrompt,
  composePlanPrompt, composeGrillPrompt, composeSliceRound1Prompt, composePreludePrompt,
  composeAbsorbPrompt, evidencePathFor, NAMED_ROUNDS,
} from "../src/core/implementTurn.js";

const ART = "/state/topic/_implement";

// The two shipped composers now share a skeleton with the slice/prelude ones. This fixture was
// captured from 0.5.70 BEFORE that extraction: byte-identity is the whole point of the refactor,
// so it is asserted, not assumed.
describe("BYTE-IDENTITY — the extraction did not move composeRound1Prompt / composeFixPrompt", () => {
  const fixture: Record<string, string> = JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "implement-prompts-0.5.70.json"), "utf8"),
  );
  it("every captured round-1 / fix body still matches byte for byte", () => {
    for (const testCmd of ["", "npm test"]) {
      for (const round of [1, 3]) {
        expect(composeRound1Prompt({
          designPath: `${ART}/design.md`, planPath: `${ART}/plan.md`,
          verifyPath: `${ART}/verify-report-${round}.md`, round, testCmd,
        })).toBe(fixture[`round1|round=${round}|cmd=${testCmd}`]);
        expect(composeFixPrompt(round, "1. [bug] boom\n2. [spec-gap] gap", `${ART}/verify-report-${round}.md`, testCmd))
          .toBe(fixture[`fix|round=${round}|cmd=${testCmd}`]);
      }
    }
    expect(composeRound1Prompt({ designPath: "/d/design.md", planPath: "/d/plan.md", verifyPath: "/d/verify-report-1.md", testCmd: "npm test" }))
      .toBe(fixture["round1|default-round|cmd=npm test"]);
  });
});

describe("composePlanPrompt (spec B — the plan turn)", () => {
  const p = composePlanPrompt({ designPath: `${ART}/design.md`, planPath: `${ART}/plan.md`, maxSlices: 6 });

  it("is PHASE 1 alone: read the design, write the plan, emit done, implement nothing", () => {
    expect(p).toContain("PHASE 1: Plan");
    expect(p).toContain(`${ART}/design.md`);
    expect(p).toContain(`${ART}/plan.md`);
    expect(p).toContain("Do NOT implement anything");
    expect(p).toContain("When the plan is written, emit done.");
    expect(p).not.toContain("PHASE 2: Implement");
    expect(p).not.toContain("PHASE 3: Self-verify");
  });

  it("carries the task contract: the heading shape, files: and depends: with their rules", () => {
    expect(p).toContain("### T1: <title>");
    expect(p).toContain("files: src/core/gate.ts, src/core/gateKinds.ts");
    expect(p).toContain("depends: none");
    expect(p).toContain("depends: T1");
    expect(p).toContain("as repo-relative paths. No absolute paths, no globs (`*`, `?`, `[`);");
    expect(p).toContain("a directory ends with `/`");
    expect(p).toContain("or `none`");
  });

  it("carries the `## Slices` proposal contract and what a good split is", () => {
    expect(p).toContain("## Slices");
    expect(p).toContain("prelude: T1, T2");
    expect(p).toContain("slice: T3, T5");
    expect(p).toContain("names the tasks other tasks depend on");
    expect(p).toContain("`prelude: none`");
    expect(p).toContain("Tasks that share a file go on");
    expect(p).toContain("at least a real hour of work");
    expect(p).toContain("At most 6 `slice:` lines");
    expect(p).toContain("ONE `slice:` line when the");
    expect(p).toContain("The Hub DECIDES the grouping");
  });

  it("honors the maxSlices argument", () => {
    expect(composePlanPrompt({ designPath: "/d", planPath: "/p", maxSlices: 3 })).toContain("At most 3 `slice:` lines");
  });

  it("carries NO fence and NO done-event line (inboxWrite appends them)", () => {
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
  });
});

describe("composeGrillPrompt (spec B — the one grill turn)", () => {
  const refusalLines = ["OVERLAP=wp3:wp4:src/core/gate.ts", "DEP=T5->T4"];
  const p = composeGrillPrompt({
    hubText: "I wanted T3+T5 apart from T4 because they are two packages.",
    planPath: `${ART}/plan.md`,
    refusalLines,
  });

  it("carries the refusal lines VERBATIM and the hub's text", () => {
    for (const l of refusalLines) expect(p).toContain(l);
    expect(p).toContain("I wanted T3+T5 apart from T4 because they are two packages.");
  });

  it("restates the plan contract briefly", () => {
    expect(p).toContain("### T<n>: <title>");
    expect(p).toContain("`files:`");
    expect(p).toContain("`depends:`");
    expect(p).toContain("`## Slices`");
  });

  it("orders a re-cut of the tasks, not an implementation", () => {
    expect(p).toContain(`${ART}/plan.md`);
    expect(p).toContain("RE-CUT THE TASKS");
    expect(p).toContain("so the check passes,");
    expect(p).toContain("then emit done.");
    expect(p).toContain("Do NOT implement anything");
    expect(p).not.toContain("PHASE 2: Implement");
  });

  it("carries NO fence and NO done-event line", () => {
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
  });
});

describe("composeSliceRound1Prompt (spec E — a slice worker's round 1)", () => {
  const mandateText = "slice wp3 (agent bravo)\ntasks: T3 (shard schema), T5 (manifest)\nfiles:\n  /w/topic.bravo/src/train/shards.ts";
  const p = composeSliceRound1Prompt({
    designPath: `${ART}/design.md`, planPath: `${ART}/plan.md`, mandateText,
    verifyPath: `${ART}/verify-report-bravo-1.md`,
    testLog: `${ART}/test-output-bravo-1.log`,
    durationLog: `${ART}/worker-test-duration-bravo-1.txt`,
    testCmd: "npm test",
  });

  it("opens with the SLICE block: the mandate, the peers sentence, the out-of-slice rule", () => {
    expect(p.startsWith("YOUR SLICE:\n")).toBe(true);
    expect(p).toContain(mandateText);
    expect(p).toContain("IN PARALLEL on this topic");
    expect(p).toContain("never create, edit, or delete a file outside the");
    expect(p).toContain("`## Out-of-slice changes needed`");
    expect(p).toContain("file, the line, and the exact change");
    expect(p.indexOf("YOUR SLICE:")).toBeLessThan(p.indexOf("You are entering ROUND 1 of /ap:implement."));
  });

  it("replaces PHASE 1 with the do-not-re-plan scope", () => {
    expect(p).toContain(`${ART}/plan.md is already written; your tasks are the ones named above`);
    expect(p).toContain("do not re-plan, do not touch other tasks");
    expect(p).not.toContain("PHASE 1: Plan");
    expect(p).not.toContain("Produce a comprehensive, task-by-task implementation plan");
  });

  it("softens PHASE 2's suite rule to list, not fix, out-of-slice failures", () => {
    expect(p).toContain("the suite (`npm test` as detected in your worktree) after each task;");
    expect(p).toContain("failures in tests you did not touch that name files outside your slice");
    expect(p).toContain("are not yours to fix — list them in the report.");
    expect(p).not.toContain("the full test suite (`npm test`) after each task and confirm green.");
  });

  // MUTATION: restore the derived `${dirname(verifyPath)}/test-output-1.log` here and this goes red —
  // every slice would tee into ONE log and overwrite its peers' evidence.
  it("uses the EXPLICIT log paths, never the per-round derivation", () => {
    expect(p).toContain(`${ART}/test-output-bravo-1.log`);
    expect(p).toContain(`${ART}/worker-test-duration-bravo-1.txt`);
    expect(p).not.toContain(`${ART}/test-output-1.log`);
    expect(p).not.toContain(`${ART}/worker-test-duration-1.txt`);
  });

  it("keeps PHASE 3, the single-done line, BRANCH DISCIPLINE and blockers unchanged", () => {
    expect(p).toContain("PHASE 3: Self-verify");
    expect(p).toContain(`${ART}/verify-report-bravo-1.md`);
    expect(p).toContain("VERDICT: PASS|PARTIAL|FAIL");
    expect(p).toContain("Emit `done` exactly ONCE, after the verify report is written.");
    expect(p).toMatch(/do NOT run 'git checkout', 'git switch'/i);
    expect(p).toContain('{"event":"question"');
    expect(p).toContain("Running 'npm test' is your job");
  });

  it("carries NO fence and NO done-event line", () => {
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
  });
});

describe("composePreludePrompt (spec E — the serial prelude)", () => {
  const p = composePreludePrompt({
    designPath: `${ART}/design.md`, planPath: `${ART}/plan.md`, preludeIds: ["T1", "T2"],
    verifyPath: `${ART}/verify-report-prelude.md`,
    testLog: `${ART}/test-output-prelude.log`,
    durationLog: `${ART}/worker-test-duration-prelude.txt`,
    testCmd: "npm test",
  });

  it("replaces PHASE 1 with the prelude scope and names the slices that follow", () => {
    expect(p).toContain(`${ART}/plan.md is written. Your scope is ONLY tasks T1, T2; the rest will`);
    expect(p).toContain("be implemented by parallel slice workers after you emit done.");
    expect(p).not.toContain("PHASE 1: Plan");
  });

  // MUTATION: drop this replacement (restore "Walk <planPath> task-by-task") and this goes red — the
  // lead would implement the WHOLE plan serially while the slices are about to.
  it("replaces PHASE 2's first sentence with the ONLY-these-tasks walk", () => {
    expect(p).toContain(`Walk ONLY tasks T1, T2 of ${ART}/plan.md task-by-task.`);
    expect(p).not.toContain(`Walk ${ART}/plan.md task-by-task.`);
  });

  it("has no SLICE block, uses the explicit stage-named logs, keeps PHASE 3", () => {
    expect(p.startsWith("You are entering ROUND 1 of /ap:implement.")).toBe(true);
    expect(p).not.toContain("YOUR SLICE:");
    expect(p).toContain(`${ART}/test-output-prelude.log`);
    expect(p).toContain(`${ART}/worker-test-duration-prelude.txt`);
    expect(p).toContain(`${ART}/verify-report-prelude.md`);
    expect(p).toContain("PHASE 3: Self-verify");
  });

  it("carries NO fence and NO done-event line", () => {
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
  });
});

describe("composeAbsorbPrompt (spec G — what the slices left)", () => {
  const issuesText = [
    "- [slice] tasks T4 (slice wp4) were not implemented (turn-failed): implement them per plan.md",
    "- [integration] feat/implement-topic-bravo (slice wp3) conflicts with this branch",
    "- [spec-gap] src/core/gate.ts:42 — out-of-slice change requested by slice wp4: widen the enum",
  ].join("\n");
  const p = composeAbsorbPrompt({
    designPath: `${ART}/design.md`, planPath: `${ART}/plan.md`, issuesText,
    verifyPath: `${ART}/verify-report-absorb.md`,
    testLog: `${ART}/test-output-absorb.log`,
    durationLog: `${ART}/worker-test-duration-absorb.txt`,
    testCmd: "",
  });

  it("embeds the ISSUES block verbatim with the design and plan paths interpolated", () => {
    expect(p).toContain("ISSUES TO ABSORB:");
    expect(p).toContain(issuesText);
    expect(p).toContain(`${ART}/design.md`);
    expect(p).toContain(`${ART}/plan.md`);
  });

  it("routes all three tags", () => {
    expect(p).toContain("[slice]");
    expect(p).toContain("implement them, and");
    expect(p).toContain("[integration]");
    expect(p).toContain("`git merge <branch>`");
    expect(p).toContain("keeping BOTH intents");
    expect(p).toContain("[spec-gap]");
    expect(p).toContain("Apply the exact change named, at the file and line named.");
  });

  it("keeps the round-1 PHASE 2/3 shape, reporting to verify-report-absorb.md", () => {
    expect(p).toContain("PHASE 2: Implement");
    expect(p).toContain("commit per issue");
    expect(p).toContain("PHASE 3: Self-verify");
    expect(p).toContain(`${ART}/verify-report-absorb.md`);
    expect(p).toContain(`${ART}/test-output-absorb.log`);
    expect(p).toContain(`${ART}/worker-test-duration-absorb.txt`);
    expect(p).toContain("VERDICT: PASS|PARTIAL|FAIL");
    expect(p).toContain("Emit `done` exactly ONCE, after the verify report is written.");
    expect(p).toMatch(/do NOT run 'git checkout', 'git switch'/i);
    expect(p).toContain('{"event":"question"');
  });

  it("carries NO fence and NO done-event line", () => {
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
  });
});

describe("evidencePathFor / NAMED_ROUNDS (spec J — completion evidence per turn)", () => {
  it("names the four named lead turns", () => {
    expect([...NAMED_ROUNDS]).toEqual(["plan", "grill", "prelude", "absorb"]);
  });

  // MUTATION: return `verify-report-plan.md` for `plan` and this goes red — the hold would key on a
  // file the plan turn never writes and fail every healthy plan turn after 30 min.
  it("the plan and grill turns resolve to plan.md — they write no verify report", () => {
    expect(evidencePathFor(ART, "plan", "lead")).toBe(`${ART}/plan.md`);
    expect(evidencePathFor(ART, "grill", "lead")).toBe(`${ART}/plan.md`);
  });

  it("the prelude and absorb turns resolve to their stage-named report", () => {
    expect(evidencePathFor(ART, "prelude", "lead")).toBe(`${ART}/verify-report-prelude.md`);
    expect(evidencePathFor(ART, "absorb", "lead")).toBe(`${ART}/verify-report-absorb.md`);
  });

  it("a numbered lead round resolves to the round report (0.5.68's name), number or string", () => {
    expect(evidencePathFor(ART, 1, "lead")).toBe(`${ART}/verify-report-1.md`);
    expect(evidencePathFor(ART, 3, "lead")).toBe(`${ART}/verify-report-3.md`);
    expect(evidencePathFor(ART, "2", "lead")).toBe(`${ART}/verify-report-2.md`);
  });

  it("a slice resolves to its per-agent report", () => {
    expect(evidencePathFor(ART, 1, "bravo")).toBe(`${ART}/verify-report-bravo-1.md`);
    expect(evidencePathFor(ART, "1", "delta")).toBe(`${ART}/verify-report-delta-1.md`);
  });
});
