import { describe, it, expect } from "vitest";
import { taskNudge } from "../src/commands/send.js";

const INBOX = "/abs/state/alpha-claude/topic/inbox.md";
const PLAIN = `Read ${INBOX} and execute the task. Reply when done.`;

describe("taskNudge", () => {
  it("env unset -> legacy line, byte-identical", () => {
    expect(taskNudge(INBOX, "claude", {})).toBe(PLAIN);
  });

  it("AP_ULTRACODE=1 + claude -> keyword in the typed line", () => {
    expect(taskNudge(INBOX, "claude", { AP_ULTRACODE: "1" })).toBe(
      `Read ${INBOX} and execute the task with ultracode. Reply when done.`,
    );
  });

  it("AP_ULTRACODE=1 + non-claude providers -> legacy line", () => {
    for (const model of ["codex", "agy", "opencode"]) {
      expect(taskNudge(INBOX, model, { AP_ULTRACODE: "1" })).toBe(PLAIN);
    }
  });

  it("non-'1' values -> legacy line (strict '1' semantics)", () => {
    for (const v of ["0", "true", "yes", ""]) {
      expect(taskNudge(INBOX, "claude", { AP_ULTRACODE: v })).toBe(PLAIN);
    }
  });
});
