// tests/explore-grill.test.ts — the frame round (Phase 0.5) and the grill drill turn (Phase 8c),
// 2026-08-30 spec. The send/wait SKELETON the drill row inherits is exercised table-driven in
// explore-cmd.test.ts; here we pin what is genuinely this feature's: the two pure helpers, the
// drill prompt, the research prompt's frame block (and its byte-identity without one), and the
// drill verb's prepare/skip paths.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { sendDeps, waitDeps } from "./helpers/phaseDeps.js";
import { GRILL_MAX_ROUNDS, FRAME_HEADINGS, frameBlock, parseFacts, composeDrillPrompt } from "../src/core/exploreGrill.js";
import { composeExploreResearchPrompt } from "../src/core/exploreTurn.js";
import { drillSendWith } from "../src/commands/explore.js";
import { exploreArtDir } from "../src/core/explore.js";
import { PHASES, phaseWait } from "../src/core/phaseTable.js";
import { END_OF_ARTIFACT } from "../src/core/artifact.js";

const DRILL = PHASES.find((p) => p.phase === "drill")!;

describe("exploreGrill helpers", () => {
  it("the round cap is 3 and the frame headings are the four the directive writes", () => {
    expect(GRILL_MAX_ROUNDS).toBe(3);
    expect([...FRAME_HEADINGS]).toEqual(["Scope", "Constraints", "Good means", "Decided"]);
  });

  it("frameBlock: empty / whitespace-only → '' (the no-frame run must add nothing)", () => {
    expect(frameBlock("")).toBe("");
    expect(frameBlock("   \n\n  ")).toBe("");
  });

  it("frameBlock: labels the body as user-settled constraints and passes it through verbatim", () => {
    const body = "# Frame: kernels\n## Scope\n- inference only\n## Decided\n- CUDA, not ROCm";
    expect(frameBlock("\n" + body + "\n\n")).toBe(
      "Framing (user-settled — treat as constraints, do not re-litigate):\n" + body,
    );
  });

  it("parseFacts: '- ' bullets only; blank text, prose and bare dashes contribute nothing", () => {
    expect(parseFacts("")).toEqual([]);
    expect(parseFacts("some prose\n-\n-nospace\n")).toEqual([]);
    expect(parseFacts("- does X ship Y?\nprose\n-   spaced   \n* other\n")).toEqual(["does X ship Y?", "spaced"]);
  });

  it("composeDrillPrompt: every fact numbered F1..Fn, the escape sentence, and the artifact contract", () => {
    const p = composeDrillPrompt("  attention kernels  ", ["does X ship Y?", "what is the p99?"], "/art/drill-alpha.md");
    expect(p).toContain("Topic: attention kernels");
    expect(p).toContain("F1. does X ship Y?");
    expect(p).toContain("F2. what is the p99?");
    expect(p).toContain("cannot resolve, because <reason>");
    expect(p).toContain(`Make the LAST line of that file the literal sentinel: ${END_OF_ARTIFACT}`);
    expect(p).toContain("/art/drill-alpha.md");
    // The composer never appends the wire lines — send -> inboxWrite owns both.
    expect(p).not.toContain("END_OF_INSTRUCTION");
  });
});

describe("composeExploreResearchPrompt frame block", () => {
  const args = ["topic", "/art/findings-alpha.md", "lit", "the lens", "/art/selfassess-alpha.md"] as const;

  it("no frame → byte-identical to the 5-arg call (the 0.5.60 prompt)", () => {
    expect(composeExploreResearchPrompt(...args, "")).toBe(composeExploreResearchPrompt(...args));
    expect(composeExploreResearchPrompt(...args, "  \n ")).toBe(composeExploreResearchPrompt(...args));
  });

  it("a frame is inserted right after the Research lens line, before the output requirements", () => {
    const p = composeExploreResearchPrompt(...args, "## Scope\n- inference only");
    expect(p).toContain(
      "Research lens: the lens\n\nFraming (user-settled — treat as constraints, do not re-litigate):\n" +
      "## Scope\n- inference only\n\nOutput requirements",
    );
  });
});

describe("explore drill-send", () => {
  const TOPIC = "x", AGENT = "alpha", PROVIDER = "codex";
  let h: { home: string; cleanup: () => void };
  let art: string;
  beforeEach(() => {
    h = freshHome();
    art = exploreArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
  });
  afterEach(() => { h.cleanup(); });

  it("routed facts → prompt file carries them and the drill artifact path", async () => {
    writeFileSync(join(art, `grill-facts-${AGENT}.txt`), "- does X ship Y?\n- what is the p99?\n");
    const send = vi.fn(async () => 0);
    expect(await drillSendWith(TOPIC, AGENT, PROVIDER, sendDeps({ offsetFor: () => 3, send }))).toBe(0);
    const prompt = readFileSync(join(art, `${AGENT}_drill_prompt.md`), "utf8");
    expect(prompt).toContain("F1. does X ship Y?");
    expect(prompt).toContain("F2. what is the p99?");
    expect(prompt).toContain(join(art, `drill-${AGENT}.md`));
    expect(send).toHaveBeenCalled();
  });

  it("no facts file (the mop-up pass) → DS=skipped, rc 0, no send, no prompt", async () => {
    const send = vi.fn(async () => 0);
    expect(await drillSendWith(TOPIC, AGENT, PROVIDER, sendDeps({ send }))).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(readFileSync(join(art, `drill-${AGENT}.txt`), "utf8")).toBe("DS=skipped\n");
    expect(existsSync(join(art, `${AGENT}_drill_prompt.md`))).toBe(false);
  });

  it("a facts file with no bullets skips exactly like a missing one", async () => {
    writeFileSync(join(art, `grill-facts-${AGENT}.txt`), "\nnothing routed\n");
    const send = vi.fn(async () => 0);
    expect(await drillSendWith(TOPIC, AGENT, PROVIDER, sendDeps({ send }))).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(readFileSync(join(art, `drill-${AGENT}.txt`), "utf8")).toBe("DS=skipped\n");
  });

  it("one drill turn per worker: a second send is refused (rc 1) naming the cap", async () => {
    writeFileSync(join(art, `grill-facts-${AGENT}.txt`), "- does X ship Y?\n");
    expect(await drillSendWith(TOPIC, AGENT, PROVIDER, sendDeps())).toBe(0);
    const send = vi.fn(async () => 0);
    expect(await drillSendWith(TOPIC, AGENT, PROVIDER, sendDeps({ send }))).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("drill-wait classification", () => {
  const TOPIC = "x", PROVIDER = "codex";
  let h: { home: string; cleanup: () => void };
  let art: string;
  beforeEach(() => {
    h = freshHome();
    art = exploreArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
  });
  afterEach(() => { h.cleanup(); });

  it("done + complete artifact → DS=ok; no event → DS=timeout; both drop the .done marker", async () => {
    writeFileSync(join(art, "drill-alpha.txt"), "OFFSET=0\n");
    writeFileSync(join(art, "drill-alpha.md"), `## F1 q\nyes [src/k.ts:9]\n${END_OF_ARTIFACT}\n`);
    expect(await phaseWait(DRILL, TOPIC, "alpha", PROVIDER, waitDeps({ wait: async () => ({ event: "done" } as any) }))).toBe(0);
    expect(readFileSync(join(art, "drill-alpha.txt"), "utf8")).toContain("DS=ok");

    writeFileSync(join(art, "drill-charlie.txt"), "OFFSET=0\n");
    expect(await phaseWait(DRILL, TOPIC, "charlie", PROVIDER, waitDeps({ wait: async () => null }))).toBe(0);
    expect(readFileSync(join(art, "drill-charlie.txt"), "utf8")).toContain("DS=timeout");
    for (const a of ["alpha", "charlie"]) expect(existsSync(join(art, `drill-${a}.done`))).toBe(true);
  });

  it("DS=skipped fast-path drops the .done marker without ever waiting (the mop-up's gate leg)", async () => {
    writeFileSync(join(art, "drill-alpha.txt"), "DS=skipped\n");
    const wait = vi.fn(async () => null);
    expect(await phaseWait(DRILL, TOPIC, "alpha", PROVIDER, waitDeps({ wait }))).toBe(0);
    expect(wait).not.toHaveBeenCalled();
    expect(existsSync(join(art, "drill-alpha.done"))).toBe(true);
  });

  it("a question records DS=question and re-arms the offset (Intervention Pattern 1)", async () => {
    writeFileSync(join(art, "drill-alpha.txt"), "OFFSET=0\n");
    const ev = { event: "question", message: "which constraint wins?" };
    expect(await phaseWait(DRILL, TOPIC, "alpha", PROVIDER, waitDeps({ wait: async () => ev as any }))).toBe(0);
    const state = readFileSync(join(art, "drill-alpha.txt"), "utf8");
    expect(state).toContain("DS=question");
    expect(state.match(/OFFSET=/g)!.length).toBe(2);
    expect(readFileSync(join(art, "question-alpha.txt"), "utf8")).toContain("which constraint wins?");
  });
});
