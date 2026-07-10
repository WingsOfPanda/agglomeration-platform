import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeExploreResearchPrompt, composeAdversaryPrompt, litGuidance, ADVERSARY_LENSES, researchLens } from "../src/core/exploreTurn.js";
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

describe("researchLens", () => {
  const GUARD = "This is an emphasis, not a boundary — you must still cover the WHOLE landscape; do not skip an approach because it sits outside your emphasis.";
  it("codex / claude / neutral lenses are pairwise distinct", () => {
    expect(researchLens("codex")).not.toBe(researchLens("claude"));
    expect(researchLens("codex")).not.toBe(researchLens("agy"));
    expect(researchLens("claude")).not.toBe(researchLens("agy"));
  });
  it("codex weights repo-code evidence; claude weights literature/web synthesis", () => {
    expect(researchLens("codex")).toMatch(/repo-code evidence/);
    expect(researchLens("claude")).toMatch(/literature and web synthesis/);
  });
  it("agy / opencode / unknown share the neutral default", () => {
    expect(researchLens("agy")).toBe(researchLens("opencode"));
    expect(researchLens("agy")).toBe(researchLens("no-such-provider"));
    expect(researchLens("agy")).toMatch(/No special emphasis/);
  });
  it("EVERY lens (including neutral) ends with the whole-landscape guard sentence", () => {
    for (const p of ["codex", "claude", "agy"]) {
      expect(researchLens(p).endsWith(GUARD)).toBe(true);
    }
  });
});

describe("composeExploreResearchPrompt", () => {
  const p = composeExploreResearchPrompt("attention kernels", "/art/findings-rex.md", litGuidance("ON"), researchLens("codex"));
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
  it("renders the lens block after Topic: and before Output requirements", () => {
    const lens = researchLens("codex");
    expect(p).toContain(lens);
    const iTopic = p.indexOf("Topic: attention kernels");
    const iLens = p.indexOf(lens);
    const iOut = p.indexOf("Output requirements");
    expect(iTopic).toBeGreaterThanOrEqual(0);
    expect(iLens).toBeGreaterThan(iTopic);
    expect(iOut).toBeGreaterThan(iLens);
  });
  it("stays peer-material-free (no adversary-only blocks leak in)", () => {
    expect(p).not.toContain("Raw evidence behind the draft");
    expect(p).not.toContain("Priority targets");
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
    inboxWrite("rex", "codex", "demo", composeExploreResearchPrompt("attn", "/art/findings-rex.md", litGuidance("ON"), researchLens("codex")));
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
