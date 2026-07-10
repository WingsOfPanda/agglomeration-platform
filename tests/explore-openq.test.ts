import { describe, it, expect } from "vitest";
import { parseOpenQuestions, assignOpenQuestions, formatOpenqClaims, parseOpenqClaims, composeOpenqPrompt } from "../src/core/exploreOpenq.js";
import type { ListRow } from "../src/core/design.js";

const FINDINGS = [
  "# Findings: x", "## Summary", "s",
  "## Open questions",
  "- Is batch inference viable at p99 targets?",
  "- Does the kernel fuse under ROCm?",
  "not a bullet — ignored",
  "## Notes", "- this bullet is OUTSIDE the section",
].join("\n");

describe("parseOpenQuestions", () => {
  it("extracts the `- ` bullets under ## Open questions, stopping at the next heading", () => {
    expect(parseOpenQuestions(FINDINGS)).toEqual([
      "Is batch inference viable at p99 targets?",
      "Does the kernel fuse under ROCm?",
    ]);
  });
  it("missing section → []", () => {
    expect(parseOpenQuestions("# Findings\n## Summary\ns\n")).toEqual([]);
  });
  it("section with zero bullets → []", () => {
    expect(parseOpenQuestions("## Open questions\n\n## Notes\n- x\n")).toEqual([]);
  });
  it("empty text → []", () => {
    expect(parseOpenQuestions("")).toEqual([]);
  });
});

const rows2: ListRow[] = [{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }];
const rows3: ListRow[] = [...rows2, { provider: "opencode", agent: "golf" }];

describe("assignOpenQuestions", () => {
  it("N=2 swaps: alpha's questions go to charlie and vice versa", () => {
    const m = assignOpenQuestions(rows2, new Map([["alpha", ["qa"]], ["charlie", ["qc"]]]));
    expect(m.get("charlie")).toEqual([{ from: "alpha", question: "qa" }]);
    expect(m.get("alpha")).toEqual([{ from: "charlie", question: "qc" }]);
  });
  it("N=3 rotates by list order: a→b, b→c, c→a", () => {
    const m = assignOpenQuestions(rows3, new Map([["alpha", ["qa"]], ["charlie", ["qc"]], ["golf", ["qg"]]]));
    expect(m.get("charlie")).toEqual([{ from: "alpha", question: "qa" }]);
    expect(m.get("golf")).toEqual([{ from: "charlie", question: "qc" }]);
    expect(m.get("alpha")).toEqual([{ from: "golf", question: "qg" }]);
  });
  it("a worker with zero questions still RECEIVES its peer's questions", () => {
    const m = assignOpenQuestions(rows2, new Map([["charlie", ["qc"]]]));
    expect(m.get("alpha")).toEqual([{ from: "charlie", question: "qc" }]);
    expect(m.has("charlie")).toBe(false); // alpha contributed nothing
  });
  it("all-empty input → empty map", () => {
    expect(assignOpenQuestions(rows2, new Map()).size).toBe(0);
    expect(assignOpenQuestions(rows2, new Map([["alpha", []]])).size).toBe(0);
  });
});

describe("openq claims TSV round-trip", () => {
  it("format → parse is identity; malformed lines are dropped", () => {
    const list = [{ from: "alpha", question: "q one?" }, { from: "charlie", question: "q\ttwo?" }];
    const parsed = parseOpenqClaims(formatOpenqClaims(list));
    expect(parsed[0]).toEqual({ from: "alpha", question: "q one?" });
    expect(parsed[1].from).toBe("charlie"); // tab inside the question survives (first-tab split)
    expect(parseOpenqClaims("no-tab-line\n")).toEqual([]);
    expect(parseOpenqClaims("")).toEqual([]);
  });
});

describe("composeOpenqPrompt", () => {
  const p = composeOpenqPrompt(
    [{ from: "alpha", question: "Is batch viable?" }, { from: "golf", question: "ROCm fuse?" }],
    "/art/openq-charlie.md",
  );
  it("numbers the questions with their from-agent and targets the answers path", () => {
    expect(p).toContain("1. (from alpha) Is batch viable?");
    expect(p).toContain("2. (from golf) ROCm fuse?");
    expect(p).toContain("/art/openq-charlie.md");
  });
  it("instructs honest non-answers over padding", () => {
    expect(p).toMatch(/cannot answer|cannot resolve/i);
  });
  it("does NOT embed its own done-event line or END_OF_INSTRUCTION (inboxWrite owns them)", () => {
    expect(p).not.toContain('{"event":"done"');
    expect(p).not.toContain("END_OF_INSTRUCTION");
  });
});
