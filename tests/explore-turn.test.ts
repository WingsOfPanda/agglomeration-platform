import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeExploreResearchPrompt, composeAdversaryPrompt, litGuidance, ADVERSARY_LENSES } from "../src/core/exploreTurn.js";
import { inboxWrite, inboxPath } from "../src/core/ipc.js";
import { workerDir } from "../src/core/paths.js";

describe("litGuidance", () => {
  it("ON block prioritizes peer-reviewed papers", () => {
    expect(litGuidance("ON")).toMatch(/peer-reviewed/);
  });
  it("OFF block allows a brief SOTA section", () => {
    expect(litGuidance("OFF")).toMatch(/Not applicable|Brief SOTA/i);
  });
});

describe("composeExploreResearchPrompt", () => {
  const p = composeExploreResearchPrompt("attention kernels", "/art/findings-rex.md", litGuidance("ON"));
  it("contains topic, write-to, and the lit-guidance", () => {
    expect(p).toContain("attention kernels");
    expect(p).toContain("/art/findings-rex.md");
    expect(p).toContain("peer-reviewed");
  });
  it("does NOT embed its own done-event line or END_OF_INSTRUCTION (inboxWrite owns them)", () => {
    // The template must not carry a done contract; inboxWrite appends exactly one. Embedding a
    // second here is the duplicate-END_OF_INSTRUCTION bug that desynced codex workers' done events.
    expect(p).not.toContain('{"event":"done"');
    expect(p).not.toContain("END_OF_INSTRUCTION");
  });
  it("frames it as landscape exposure, not recommendation", () => {
    expect(p).toMatch(/not a recommendation/i);
  });
});

describe("composeAdversaryPrompt", () => {
  const opts = { peerFindingsPaths: ["/art/findings-charlie.md"], lens: ADVERSARY_LENSES[0] };
  const p = composeAdversaryPrompt("## Topic\nflash\n## Approaches\n1. A", "alpha", "/art/adversary-alpha.md", opts);
  it("inlines the draft, names the agent, targets the out-path", () => {
    expect(p).toContain("## Approaches");
    expect(p).toContain("alpha");
    expect(p).toContain("/art/adversary-alpha.md");
  });
  it("lists every peer findings path under the raw-evidence block", () => {
    expect(p).toContain("Raw evidence behind the draft");
    expect(p).toContain("/art/findings-charlie.md");
  });
  it("distinct lenses produce different emphasis text; both retain the full attack-surface list", () => {
    const p0 = composeAdversaryPrompt("d", "alpha", "/o.md", { peerFindingsPaths: [], lens: ADVERSARY_LENSES[0] });
    const p1 = composeAdversaryPrompt("d", "alpha", "/o.md", { peerFindingsPaths: [], lens: ADVERSARY_LENSES[1] });
    expect(p0).not.toBe(p1);
    expect(p0).toContain("citation-fidelity");
    expect(p1).toContain("frame-exclusion");
    for (const px of [p0, p1]) {
      expect(px).toContain("Attack surface — prioritize these failure modes:");
      expect(px).toContain("Approaches that were missed or wrongly excluded from the landscape");
      expect(px).toContain("SOTA claims that are stale");
    }
  });
  it("does NOT embed its own done-event line or END_OF_INSTRUCTION (inboxWrite owns them)", () => {
    expect(p).not.toContain('{"event":"done"');
    expect(p).not.toContain("END_OF_INSTRUCTION");
  });
});

// Regression: the explore send path is `inboxWrite(i, m, t, composeX(...))`. Before the fix the
// templates embedded their own done line + END_OF_INSTRUCTION AND inboxWrite appended a second of
// each, so the inbox carried two of each — the malformed-inbox condition the forensics tied to
// codex workers missing their terminal `done` event. The inbox must carry exactly one of each.
describe("explore inbox carries a single done contract (no duplicate END_OF_INSTRUCTION)", () => {
  beforeEach(() => { process.env.CLAUDE_PLUGIN_ROOT = process.cwd(); });
  afterEach(() => { delete process.env.AP_HOME; });
  const count = (s: string, sub: string): number => s.split(sub).length - 1;
  function seedPart(i: string, m: string, t: string): void {
    process.env.AP_HOME = mkdtempSync(join(tmpdir(), "pt-"));
    const d = workerDir(i, m, t); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "outbox.jsonl"), "");
  }

  it("research prompt → exactly one END_OF_INSTRUCTION and one done line", () => {
    seedPart("rex", "codex", "demo");
    inboxWrite("rex", "codex", "demo", composeExploreResearchPrompt("attn", "/art/findings-rex.md", litGuidance("ON")));
    const txt = readFileSync(inboxPath("rex", "codex", "demo"), "utf8");
    expect(count(txt, "END_OF_INSTRUCTION")).toBe(1);
    expect(count(txt, '"event":"done"')).toBe(1);
    expect(txt.trimEnd().endsWith("END_OF_INSTRUCTION")).toBe(true);
  });

  it("adversary prompt → exactly one END_OF_INSTRUCTION and one done line", () => {
    seedPart("alpha", "codex", "demo");
    inboxWrite("alpha", "codex", "demo", composeAdversaryPrompt("## Approaches\n1. A", "alpha", "/art/adversary-alpha.md", { peerFindingsPaths: ["/art/findings-charlie.md"], lens: ADVERSARY_LENSES[1] }));
    const txt = readFileSync(inboxPath("alpha", "codex", "demo"), "utf8");
    expect(count(txt, "END_OF_INSTRUCTION")).toBe(1);
    expect(count(txt, '"event":"done"')).toBe(1);
  });
});
