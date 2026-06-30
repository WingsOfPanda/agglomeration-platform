// tests/implement-verify-tests.test.ts — hub-side independent test re-run (v1, in-place).
import { describe, it, expect } from "vitest";
import { classifyTestRun } from "../src/core/implementVerifyTests.js";

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
