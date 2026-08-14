// tests/design-walk.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkSectionState, auditIssueToSection, parseWalkVerdict } from "../src/core/designWalk.js";

describe("auditIssueToSection", () => {
  it("maps each known issue code", () => {
    expect(auditIssueToSection("no_goal_section")).toBe("goal");
    expect(auditIssueToSection("no_arch_section")).toBe("architecture");
    expect(auditIssueToSection("no_testing_section")).toBe("testing");
    expect(auditIssueToSection("no_success_section")).toBe("success-criteria");
    expect(auditIssueToSection("tbd_marker")).toBe("ASK");
    expect(auditIssueToSection("todo_marker")).toBe("ASK");
    expect(auditIssueToSection("unresolved_placeholder")).toBe("architecture");
    expect(auditIssueToSection("something_unknown")).toBe("");
  });
});

describe("parseWalkVerdict", () => {
  it("accepts the two verdict words (trimmed), rejects anything else", () => {
    expect(parseWalkVerdict("approved\n")).toBe("approved");
    expect(parseWalkVerdict("  skipped  ")).toBe("skipped");
    expect(parseWalkVerdict("")).toBe(null);
    expect(parseWalkVerdict("APPROVED")).toBe(null);
    expect(parseWalkVerdict("approved by hub")).toBe(null);
  });
});

describe("walkSectionState", () => {
  it("names sorted; --with-status reports each marker's recorded verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "walk-"));
    writeFileSync(join(dir, "goal.state"), "approved\n");
    writeFileSync(join(dir, "components.state"), "skipped\n");
    expect(walkSectionState(dir)).toEqual(["components", "goal"]);
    expect(walkSectionState(dir, { withStatus: true })).toEqual([
      { name: "components", status: "skipped" },
      { name: "goal", status: "approved" },
    ]);
  });
  it("drafts settle nothing: a drafted-but-unmarked section is pending (absent), even a _(skipped)_ body", () => {
    const dir = mkdtempSync(join(tmpdir(), "walk-"));
    writeFileSync(join(dir, "goal.md"), "## Goal\n\nreal content\n");
    writeFileSync(join(dir, "components.md"), "_(skipped)_\n");
    expect(walkSectionState(dir)).toEqual([]);
    expect(walkSectionState(dir, { withStatus: true })).toEqual([]);
  });
  it("a garbage marker is not a verdict — omitted, not guessed", () => {
    const dir = mkdtempSync(join(tmpdir(), "walk-"));
    writeFileSync(join(dir, "goal.state"), "approved\n");
    writeFileSync(join(dir, "testing.state"), "maybe\n");
    expect(walkSectionState(dir)).toEqual(["goal"]);
  });
  it("missing dir → []", () => { expect(walkSectionState("/no/such/dir")).toEqual([]); });
});
