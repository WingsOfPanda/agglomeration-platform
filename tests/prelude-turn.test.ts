import { describe, it, expect } from "vitest";
import { composePreludeResearchPrompt, composeAdversaryPrompt, litGuidance } from "../src/core/preludeTurn.js";

describe("litGuidance", () => {
  it("ON block prioritizes peer-reviewed papers", () => {
    expect(litGuidance("ON")).toMatch(/peer-reviewed/);
  });
  it("OFF block allows a brief SOTA section", () => {
    expect(litGuidance("OFF")).toMatch(/Not applicable|Brief SOTA/i);
  });
});

describe("composePreludeResearchPrompt", () => {
  const p = composePreludeResearchPrompt("attention kernels", "/art/findings-rex.md", litGuidance("ON"));
  it("contains topic, write-to, the lit-guidance, the done event, and the fence", () => {
    expect(p).toContain("attention kernels");
    expect(p).toContain("/art/findings-rex.md");
    expect(p).toContain("peer-reviewed");
    expect(p).toContain('{"event":"done"');
    expect(p.trimEnd().endsWith("END_OF_INSTRUCTION")).toBe(true);
  });
  it("frames it as landscape exposure, not recommendation", () => {
    expect(p).toMatch(/not a recommendation/i);
  });
});

describe("composeAdversaryPrompt", () => {
  const p = composeAdversaryPrompt("## Topic\nflash\n## Approaches\n1. A", "viola", "/art/adversary-viola.md");
  it("inlines the draft, names the instrument, targets the out-path, ends with the fence", () => {
    expect(p).toContain("## Approaches");
    expect(p).toContain("viola");
    expect(p).toContain("/art/adversary-viola.md");
    expect(p).toContain('{"event":"done"');
    expect(p.trimEnd().endsWith("END_OF_INSTRUCTION")).toBe(true);
  });
});
