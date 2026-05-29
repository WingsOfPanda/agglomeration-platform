// tests/solo-cmd.test.ts
import { describe, it, expect } from "vitest";
import { run as soloRun } from "../src/commands/solo.js";

describe("solo dispatcher", () => {
  it("no verb / unknown verb → usage, rc 2", async () => {
    expect(await soloRun([])).toBe(2);
    expect(await soloRun(["frobnicate"])).toBe(2);
  });
});
