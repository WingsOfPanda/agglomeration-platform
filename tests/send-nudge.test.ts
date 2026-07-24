import { describe, it, expect } from "vitest";
import { taskNudge } from "../src/commands/send.js";

const INBOX = "/abs/state/alpha-claude/topic/inbox.md";
const PLAIN = `Read ${INBOX} and execute the task. Reply when done.`;
const ULTRA = `Read ${INBOX} and execute the task with ultracode. Reply when done.`;

describe("taskNudge", () => {
  it("claude + env unset -> ultracode by default", () => {
    expect(taskNudge(INBOX, "claude", {})).toBe(ULTRA);
  });

  it("claude + AP_ULTRACODE=0 -> plain line (the opt-out)", () => {
    expect(taskNudge(INBOX, "claude", { AP_ULTRACODE: "0" })).toBe(PLAIN);
  });

  it("claude + non-'0' values -> ultracode (off iff exactly '0')", () => {
    for (const v of ["1", "true", ""]) {
      expect(taskNudge(INBOX, "claude", { AP_ULTRACODE: v })).toBe(ULTRA);
    }
  });

  it("non-claude providers -> plain line regardless of env", () => {
    for (const model of ["codex", "agy", "opencode"]) {
      for (const env of [{}, { AP_ULTRACODE: "1" }, { AP_ULTRACODE: "0" }]) {
        expect(taskNudge(INBOX, model, env)).toBe(PLAIN);
      }
    }
  });
});
