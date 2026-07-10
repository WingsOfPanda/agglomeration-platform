import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freshHome } from "./helpers/tmpHome.js";
import { initWith, classifyRun, spawnAllWith, researchSendWith, researchWaitWith, openqCollateRun, openqSendWith, openqWaitWith, crossverifySendWith, crossverifyWaitWith, synthPreliminaryRun, confidenceRun, annotateRun, adversarySendWith, adversaryWaitWith, synthFinalRun, verdictTallyRun, diffExploreRun, forensicsRun as exploreForensicsRun, teardownWith as exploreTeardownWith, handoffExtractRun, type ExploreInitDeps, type ExploreSpawnAllDeps, type ResearchSendDeps, type ResearchWaitDeps } from "../src/commands/explore.js";
import { exploreArtDir } from "../src/core/explore.js";

function initDeps(over: Partial<ExploreInitDeps> = {}): ExploreInitDeps {
  return {
    activeProviders: () => ["codex", "claude"],
    isValidated: () => true,
    pickAgents: (_t, n) => ["alpha", "charlie", "golf"].slice(0, n),
    ...over,
  };
}

describe("explore init", () => {
  it("scaffolds _explore with topic.txt + list.txt for N=2", async () => {
    const { cleanup } = freshHome();
    try {
      const rc = await initWith(["attention", "kernels"], initDeps());
      expect(rc).toBe(0);
      const art = exploreArtDir("attention-kernels");
      expect(existsSync(join(art, "topic.txt"))).toBe(true);
      expect(readFileSync(join(art, "topic.txt"), "utf8")).toBe("attention kernels");
      expect(readFileSync(join(art, "list.txt"), "utf8")).toContain("codex\talpha");
    } finally { cleanup(); }
  });
  it("rc1 when fewer than 2 validated providers", async () => {
    const { cleanup } = freshHome();
    try {
      const rc = await initWith(["x"], initDeps({ activeProviders: () => ["codex"] }));
      expect(rc).toBe(1);
    } finally { cleanup(); }
  });
  it("caps to 3 providers", async () => {
    const { cleanup } = freshHome();
    try {
      const rc = await initWith(["x"], initDeps({ activeProviders: () => ["a", "b", "c", "d"] }));
      expect(rc).toBe(0);
      expect(readFileSync(join(exploreArtDir("x"), "list.txt"), "utf8").split("\n").filter((l) => l.includes("\t")).length).toBe(3);
    } finally { cleanup(); }
  });
  it("rc2 when _explore already exists", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const rc = await initWith(["x"], initDeps());
      expect(rc).toBe(2);
    } finally { cleanup(); }
  });
});

describe("explore classify", () => {
  it("writes lit-track.txt = ON for an academic topic", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["attention", "models"], initDeps());
      const rc = await classifyRun(["attention-models"]);
      expect(rc).toBe(0);
      const lt = readFileSync(join(exploreArtDir("attention-models"), "lit-track.txt"), "utf8");
      expect(lt.startsWith("ON\n")).toBe(true);
      expect(lt).toContain("reason: auto-detect via keyword scan");
    } finally { cleanup(); }
  });
  it("rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try { expect(await classifyRun(["nope"])).toBe(1); } finally { cleanup(); }
  });
});

describe("explore spawn-all", () => {
  it("preflights then spawns each list worker; rc0 when all ok", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      const deps: ExploreSpawnAllDeps = {
        preflight: async () => { writeFileSync(join(art, "preflight-panes.txt"), "alpha\t%1\ncharlie\t%2\n"); return 0; },
        spawn: async () => 0,
        repoRoot: () => "/repo",
      };
      const rc = await spawnAllWith("x", deps);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "spawn-results.tsv"), "utf8")).toContain("alpha\tcodex\t0");
    } finally { cleanup(); }
  });
});

describe("explore research-send/wait", () => {
  it("send renders prompt to <inst>_research_prompt.md and writes the offset state", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      await classifyRun(["x"]);
      const art = exploreArtDir("x");
      let sent: string[] = [];
      const deps: ResearchSendDeps = { offsetFor: () => 7, send: async (a) => { sent = a; return 0; } };
      const rc = await researchSendWith("x", "alpha", "codex", deps);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("OFFSET=7");
      const prompt = readFileSync(join(art, "alpha_research_prompt.md"), "utf8");
      expect(prompt).toContain(join(art, "findings-alpha.md"));
      expect(sent).toEqual(["--from", "hub", "alpha", "x", `@${join(art, "alpha_research_prompt.md")}`]);
    } finally { cleanup(); }
  });
  it("send weights the prompt by provider: codex gets the code lens, claude the literature lens", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // list: alpha(codex), charlie(claude)
      await classifyRun(["x"]);
      const art = exploreArtDir("x");
      const deps: ResearchSendDeps = { offsetFor: () => 0, send: async () => 0 };
      expect(await researchSendWith("x", "alpha", "codex", deps)).toBe(0);
      expect(await researchSendWith("x", "charlie", "claude", deps)).toBe(0);
      const pAlpha = readFileSync(join(art, "alpha_research_prompt.md"), "utf8");
      const pCharlie = readFileSync(join(art, "charlie_research_prompt.md"), "utf8");
      expect(pAlpha).toContain("repo-code evidence");
      expect(pCharlie).toContain("literature and web synthesis");
      const guard = "This is an emphasis, not a boundary";
      expect(pAlpha).toContain(guard);
      expect(pCharlie).toContain(guard);
    } finally { cleanup(); }
  });
  it("wait classifies a done event with findings as FS=ok and writes the .done sentinel", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\n");
      writeFileSync(join(art, "findings-alpha.md"), "## Claims\n1. [src/a.ts:1] x\n");
      const deps: ResearchWaitDeps = { wait: async () => ({ event: "done" } as any), multiplier: () => "1" };
      const rc = await researchWaitWith("x", "alpha", "codex", deps);
      expect(rc).toBe(0);
      expect(existsSync(join(art, "research-alpha.done"))).toBe(true);
      expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=ok");
    } finally { cleanup(); }
  });
});

describe("explore openq-collate", () => {
  it("collates open questions and writes per-target claims files (swap at N=2)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // alpha, charlie
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), "## Open questions\n- qa1\n- qa2\n## Notes\nn\n");
      writeFileSync(join(art, "findings-charlie.md"), "## Open questions\n- qc1\n## Notes\nn\n");
      const rc = await openqCollateRun(["x"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "open-questions.md"), "utf8")).toContain("qa1");
      expect(readFileSync(join(art, "openq-claims-charlie.txt"), "utf8")).toBe("alpha\tqa1\nalpha\tqa2\n");
      expect(readFileSync(join(art, "openq-claims-alpha.txt"), "utf8")).toBe("charlie\tqc1\n");
    } finally { cleanup(); }
  });
  it("prints OPENQ=none and writes no claims files when no findings carry questions", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), "## Summary\ns\n");
      writeFileSync(join(art, "findings-charlie.md"), "## Summary\ns\n");
      expect(await openqCollateRun(["x"])).toBe(0);
      expect(existsSync(join(art, "open-questions.md"))).toBe(false);
      expect(existsSync(join(art, "openq-claims-alpha.txt"))).toBe(false);
      expect(existsSync(join(art, "openq-claims-charlie.txt"))).toBe(false);
    } finally { cleanup(); }
  });
  it("rc2 without a topic; rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try {
      expect(await openqCollateRun([])).toBe(2);
      expect(await openqCollateRun(["nope"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore openq-send/wait", () => {
  it("send FS guard: research FS=timeout → QS=skipped, no send", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=timeout\n");
      writeFileSync(join(art, "openq-claims-alpha.txt"), "charlie\tq?\n");
      let sendCalled = false;
      const rc = await openqSendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => { sendCalled = true; return 0; } });
      expect(rc).toBe(0);
      expect(sendCalled).toBe(false);
      expect(readFileSync(join(art, "openq-alpha.txt"), "utf8")).toBe("QS=skipped\n");
    } finally { cleanup(); }
  });
  it("send zero-questions skip: missing claims file → QS=skipped, no send", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      let sendCalled = false;
      const rc = await openqSendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => { sendCalled = true; return 0; } });
      expect(rc).toBe(0);
      expect(sendCalled).toBe(false);
      expect(readFileSync(join(art, "openq-alpha.txt"), "utf8")).toBe("QS=skipped\n");
    } finally { cleanup(); }
  });
  it("send happy path: prompt rendered from claims, OFFSET captured, send invoked with @prompt-file", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      writeFileSync(join(art, "openq-claims-alpha.txt"), "charlie\tIs batch viable?\n");
      let sent: string[] = [];
      const rc = await openqSendWith("x", "alpha", "codex", { offsetFor: () => 9, send: async (a) => { sent = a; return 0; } });
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "openq-alpha.txt"), "utf8")).toContain("OFFSET=9");
      const prompt = readFileSync(join(art, "alpha_openq_prompt.md"), "utf8");
      expect(prompt).toContain("1. (from charlie) Is batch viable?");
      expect(prompt).toContain(join(art, "openq-alpha.md"));
      expect(sent).toEqual(["--from", "hub", "alpha", "x", `@${join(art, "alpha_openq_prompt.md")}`]);
    } finally { cleanup(); }
  });
  it("send rc1 when its state file already exists", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "openq-alpha.txt"), "QS=skipped\n");
      expect(await openqSendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => 0 })).toBe(1);
    } finally { cleanup(); }
  });
  it("wait fast-path: QS=skipped writes .done, rc 0, no OFFSET error", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "openq-alpha.txt"), "QS=skipped\n");
      const rc = await openqWaitWith("x", "alpha", "codex", {
        wait: async () => { throw new Error("wait must not be called for a skipped worker"); },
        multiplier: () => "1",
      });
      expect(rc).toBe(0);
      expect(existsSync(join(art, "openq-alpha.done"))).toBe(true);
    } finally { cleanup(); }
  });
  it("wait: done + non-empty answers → QS=ok; done + empty → QS=missing; no event → QS=timeout", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "openq-alpha.txt"), "OFFSET=0\n");
      writeFileSync(join(art, "openq-alpha.md"), "## Q1 x\nanswer");
      expect(await openqWaitWith("x", "alpha", "codex", { wait: async () => ({ event: "done" } as any), multiplier: () => "1" })).toBe(0);
      expect(readFileSync(join(art, "openq-alpha.txt"), "utf8")).toContain("QS=ok");
      expect(existsSync(join(art, "openq-alpha.done"))).toBe(true);

      writeFileSync(join(art, "openq-charlie.txt"), "OFFSET=0\n");
      writeFileSync(join(art, "openq-charlie.md"), "");
      expect(await openqWaitWith("x", "charlie", "claude", { wait: async () => ({ event: "done" } as any), multiplier: () => "1" })).toBe(0);
      expect(readFileSync(join(art, "openq-charlie.txt"), "utf8")).toContain("QS=missing");

      writeFileSync(join(art, "openq-golf.txt"), "OFFSET=0\n");
      expect(await openqWaitWith("x", "golf", "codex", { wait: async () => null, multiplier: () => "1" })).toBe(0);
      expect(readFileSync(join(art, "openq-golf.txt"), "utf8")).toContain("QS=timeout");
    } finally { cleanup(); }
  });
  it("wait question event: captures the payload and bumps OFFSET via recordWaitOutcome", async () => {
    const { cleanup } = freshHome();
    try {
      process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "openq-alpha.txt"), "OFFSET=0\n");
      const rc = await openqWaitWith("x", "alpha", "codex", { wait: async () => ({ event: "question", message: "m" } as any), multiplier: () => "1" });
      expect(rc).toBe(0);
      const st = readFileSync(join(art, "openq-alpha.txt"), "utf8");
      expect(st).toContain("QS=question");
      expect(readFileSync(join(art, "question-alpha.txt"), "utf8")).toContain('"question"');
    } finally { cleanup(); delete process.env.CLAUDE_PLUGIN_ROOT; }
  });
});

async function seedFindings(art: string, draft: string): Promise<void> {
  writeFileSync(join(art, "findings-alpha.md"), "FlashAttention is fast. https://x.test/p . uncertain about batch.");
  writeFileSync(join(art, "findings-charlie.md"), "FlashAttention wins. https://x.test/p .");
  writeFileSync(join(art, "landscape-draft.md"), draft);
}
const DRAFT = [
  "## Approaches", "1. FlashAttention — fused", "## Tradeoff matrix",
  "| Priority | Best fit | Reason |", "| latency | FlashAttention | https://x.test/p |", "## Citations", "- https://x.test/p",
].join("\n");

describe("explore synth-preliminary", () => {
  it("prints the draft path when all findings exist", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), "a"); writeFileSync(join(art, "findings-charlie.md"), "b");
      const rc = await synthPreliminaryRun(["x"]);
      expect(rc).toBe(0);
    } finally { cleanup(); }
  });
  it("rc1 when a worker's findings are missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      writeFileSync(join(exploreArtDir("x"), "findings-alpha.md"), "a"); // charlie missing
      expect(await synthPreliminaryRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore confidence", () => {
  it("no-flag + not-all-hold writes adversary-skip.txt with user_decision: not-offered", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      await seedFindings(art, DRAFT + "\nCONTESTED: foo"); // S3 fails -> not all hold
      const rc = await confidenceRun(["x"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "adversary-skip.txt"), "utf8")).toContain("user_decision: not-offered");
    } finally { cleanup(); }
  });
  it("--decision skip writes the record with that decision", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      await seedFindings(art, DRAFT);
      const rc = await confidenceRun(["x", "--decision", "skip"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "adversary-skip.txt"), "utf8")).toContain("user_decision: skip");
    } finally { cleanup(); }
  });
  it("ALL_HOLD=true + no flag writes nothing (two-call: Hub asks before --decision)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      // header-less matrix with a /-anchored Reason cell so the strict S4 holds; alpha finding has
      // "uncertain" (S5); both findings cite https://x.test/p (S1/S2); no CONTESTED (S3) -> all hold.
      const allHold = [
        "## Approaches", "1. FlashAttention — fused", "## Tradeoff matrix",
        "| latency | FlashAttention | /p see https://x.test/p |", "## Citations", "- https://x.test/p",
      ].join("\n");
      await seedFindings(art, allHold);
      const rc = await confidenceRun(["x"]);
      expect(rc).toBe(0);
      expect(existsSync(join(art, "adversary-skip.txt"))).toBe(false);
    } finally { cleanup(); }
  });
  it("prints S1=..S5= per-signal lines to stdout with ALL_HOLD= as the LAST line", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      await seedFindings(art, DRAFT + "\nCONTESTED: foo"); // S3 fails
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
      try {
        expect(await confidenceRun(["x"])).toBe(0);
      } finally { spy.mockRestore(); }
      const lines = chunks.join("").trim().split("\n");
      expect(lines).toContain("S3=false");
      for (const n of [1, 2, 4, 5]) expect(lines.some((l) => new RegExp(`^S${n}=(true|false)$`).test(l))).toBe(true);
      expect(lines[lines.length - 1]).toBe("ALL_HOLD=false"); // directive-parse compatibility: last line
      expect(lines.slice(0, 5)).toEqual(lines.filter((l) => /^S[1-5]=/.test(l))); // S-lines come first, in order
    } finally { cleanup(); }
  });
});

describe("explore annotate", () => {
  it("annotates a solo citation + uncited row, writes marker + annotations.json", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      // alpha+charlie both cite https://x.test/p (corroborated); https://x.test/solo is solo (alpha only).
      writeFileSync(join(art, "findings-alpha.md"), "https://x.test/p and https://x.test/solo . uncertain.");
      writeFileSync(join(art, "findings-charlie.md"), "https://x.test/p only.");
      writeFileSync(join(art, "landscape-draft.md"), [
        "## Findings by worker", "See https://x.test/solo here.",
        "## Tradeoff matrix", "| latency | One | plain prose reason |",
      ].join("\n"));
      const rc = await annotateRun(["x"]);
      expect(rc).toBe(0);
      const out = readFileSync(join(art, "landscape-draft.md"), "utf8");
      expect(out).toContain("https://x.test/solo [unverified]");
      expect(out).toContain("plain prose reason [no citation]");
      expect(existsSync(join(art, "annotate-applied.txt"))).toBe(true);
      expect(readFileSync(join(art, "annotations.json"), "utf8")).toContain("\"n_unverified\"");
    } finally { cleanup(); }
  });
  it("is a no-op when annotate-applied.txt already exists", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      await seedFindings(art, DRAFT);
      writeFileSync(join(art, "annotate-applied.txt"), "applied: earlier\n");
      const before = readFileSync(join(art, "landscape-draft.md"), "utf8");
      const rc = await annotateRun(["x"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "landscape-draft.md"), "utf8")).toBe(before); // untouched
    } finally { cleanup(); }
  });
  it("rc1 when the draft is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      expect(await annotateRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore adversary-send/wait", () => {
  it("send guards the draft, renders the prompt, writes offset state", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      let sent: string[] = [];
      const rc = await adversarySendWith("x", "alpha", "codex", { offsetFor: () => 3, send: async (a) => { sent = a; return 0; } });
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "alpha_adversary_prompt.md"), "utf8")).toContain(join(art, "adversary-alpha.md"));
      expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toContain("OFFSET=3");
      expect(sent[0]).toBe("--from");
    } finally { cleanup(); }
  });
  it("send rc1 when the draft is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      expect(await adversarySendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => 0 })).toBe(1);
    } finally { cleanup(); }
  });
  it("send lists peer findings paths and assigns a distinct lens per list index", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // list: alpha(codex), charlie(claude)
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      const deps: ResearchSendDeps = { offsetFor: () => 0, send: async () => 0 };
      expect(await adversarySendWith("x", "alpha", "codex", deps)).toBe(0);
      expect(await adversarySendWith("x", "charlie", "claude", deps)).toBe(0);
      const pAlpha = readFileSync(join(art, "alpha_adversary_prompt.md"), "utf8");
      const pCharlie = readFileSync(join(art, "charlie_adversary_prompt.md"), "utf8");
      expect(pAlpha).toContain(join(art, "findings-charlie.md"));   // peers only
      expect(pAlpha).not.toContain(join(art, "findings-alpha.md"));
      expect(pCharlie).toContain(join(art, "findings-alpha.md"));
      expect(pAlpha).toContain("citation-fidelity");                 // index 0 lens
      expect(pCharlie).toContain("frame-exclusion");                 // index 1 lens
      expect(pAlpha).not.toBe(pCharlie);
    } finally { cleanup(); }
  });
  it("send rc1 when the agent is not in list.txt", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      writeFileSync(join(exploreArtDir("x"), "landscape-draft.md"), "d");
      expect(await adversarySendWith("x", "zulu", "codex", { offsetFor: () => 0, send: async () => 0 })).toBe(1);
    } finally { cleanup(); }
  });
  it("wait marks AS=ok on a done event with a non-empty critique", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.txt"), "OFFSET=0\n");
      writeFileSync(join(art, "adversary-alpha.md"), "## Verdict\naccept");
      const rc = await adversaryWaitWith("x", "alpha", "codex", { wait: async () => ({ event: "done" } as any), multiplier: () => "1" });
      expect(rc).toBe(0);
      expect(existsSync(join(art, "adversary-alpha.done"))).toBe(true);
      expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toContain("AS=ok");
    } finally { cleanup(); }
  });
  it("wait marks AS=missing on a done event with an EMPTY critique (locks verifyState, not researchState)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.txt"), "OFFSET=0\n");
      writeFileSync(join(art, "adversary-alpha.md"), ""); // empty critique → missing (researchState would say "empty")
      const rc = await adversaryWaitWith("x", "alpha", "codex", { wait: async () => ({ event: "done" } as any), multiplier: () => "1" });
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toContain("AS=missing");
    } finally { cleanup(); }
  });
  for (const bad of ["timeout", "failed"] as const) {
    it(`send soft-skips (AS=skipped, no send) when research ended FS=${bad}`, async () => {
      const { cleanup } = freshHome();
      try {
        await initWith(["x"], initDeps());
        const art = exploreArtDir("x");
        writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
        writeFileSync(join(art, "research-alpha.txt"), `OFFSET=0\nFS=${bad}\n`);
        let sendCalled = false;
        const rc = await adversarySendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => { sendCalled = true; return 0; } });
        expect(rc).toBe(0);
        expect(sendCalled).toBe(false);
        expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toBe("AS=skipped\n");
        expect(existsSync(join(art, "alpha_adversary_prompt.md"))).toBe(false);
      } finally { cleanup(); }
    });
  }
  it("send soft-skips (AS=skipped, no send) when research is ok but the openq turn ended QS=timeout", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      writeFileSync(join(art, "openq-alpha.txt"), "OFFSET=3\nQS=timeout\n");
      let sendCalled = false;
      const rc = await adversarySendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => { sendCalled = true; return 0; } });
      expect(rc).toBe(0);
      expect(sendCalled).toBe(false);
      expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toBe("AS=skipped\n");
    } finally { cleanup(); }
  });
  it("send proceeds when research is ok and the openq turn was QS=skipped (nothing was sent to it)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      writeFileSync(join(art, "openq-alpha.txt"), "QS=skipped\n");
      let sendCalled = false;
      const rc = await adversarySendWith("x", "alpha", "codex", { offsetFor: () => 4, send: async () => { sendCalled = true; return 0; } });
      expect(rc).toBe(0);
      expect(sendCalled).toBe(true);
    } finally { cleanup(); }
  });
  it("send proceeds normally when research ended FS=ok", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      let sendCalled = false;
      const rc = await adversarySendWith("x", "alpha", "codex", { offsetFor: () => 5, send: async () => { sendCalled = true; return 0; } });
      expect(rc).toBe(0);
      expect(sendCalled).toBe(true);
      expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toContain("OFFSET=5");
    } finally { cleanup(); }
  });
  it("send passes annotations.json solo tokens as Priority targets (unverified + approaches-flagged, deduped)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      writeFileSync(join(art, "annotations.json"), JSON.stringify({
        topic: "x",
        counts: { n_unverified: 2, n_no_citation: 1, n_approaches_flagged: 1 },
        items: [
          { kind: "unverified", token: "https://x.test/solo", lineIndex: 1 },
          { kind: "unverified", token: "https://x.test/solo", lineIndex: 4 },
          { kind: "approaches-flagged", token: "src/a.ts:1", lineIndex: 2 },
          { kind: "no-citation", lineIndex: 3 },
        ],
      }));
      const rc = await adversarySendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => 0 });
      expect(rc).toBe(0);
      const prompt = readFileSync(join(art, "alpha_adversary_prompt.md"), "utf8");
      expect(prompt).toContain("Priority targets");
      expect(prompt.split("- https://x.test/solo").length - 1).toBe(1); // deduped
      expect(prompt).toContain("- src/a.ts:1");
    } finally { cleanup(); }
  });
  it("send omits the Priority targets block when annotations.json is missing or malformed", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      expect(await adversarySendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => 0 })).toBe(0);
      expect(readFileSync(join(art, "alpha_adversary_prompt.md"), "utf8")).not.toContain("Priority targets");

      writeFileSync(join(art, "annotations.json"), "{not json");
      expect(await adversarySendWith("x", "charlie", "claude", { offsetFor: () => 0, send: async () => 0 })).toBe(0);
      expect(readFileSync(join(art, "charlie_adversary_prompt.md"), "utf8")).not.toContain("Priority targets");
    } finally { cleanup(); }
  });
  it("wait fast-path: AS=skipped state (no OFFSET) writes .done and rc 0 without waiting", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.txt"), "AS=skipped\n");
      const rc = await adversaryWaitWith("x", "alpha", "codex", {
        wait: async () => { throw new Error("wait must not be called for a skipped worker"); },
        multiplier: () => "1",
      });
      expect(rc).toBe(0);
      expect(existsSync(join(art, "adversary-alpha.done"))).toBe(true);
      expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toBe("AS=skipped\n"); // no extra lines
    } finally { cleanup(); }
  });
});

describe("explore synth-final", () => {
  it("rc0 when adversary ran and all critiques exist", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "topic.txt"), "x"); writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
      writeFileSync(join(art, "adversary-alpha.md"), "c"); writeFileSync(join(art, "adversary-charlie.md"), "c");
      expect(await synthFinalRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
  it("rc0 with only the draft when user_decision: skip", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: skip\n");
      expect(await synthFinalRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
  it("rc1 when adversary ran but a critique is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
      writeFileSync(join(art, "adversary-alpha.md"), "c"); // charlie missing
      expect(await synthFinalRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
  it("rc0 when a worker's critique is absent but its state says AS=skipped", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
      writeFileSync(join(art, "adversary-alpha.md"), "c");           // alpha critiqued
      writeFileSync(join(art, "adversary-charlie.txt"), "AS=skipped\n"); // charlie skipped, no .md
      expect(await synthFinalRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
});

describe("explore verdict-tally", () => {
  function cap(): { text: () => string; restore: () => void } {
    const c: string[] = [];
    const s = vi.spyOn(process.stdout, "write").mockImplementation(((x: unknown) => { c.push(String(x)); return true; }) as never);
    return { text: () => c.join(""), restore: () => s.mockRestore() };
  }
  it("prints one VERDICT= line per list row and a TALLY= majority (tie → most severe)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // list: alpha(codex), charlie(claude)
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.md"), "# c\n## Verdict\nneeds-attention\n## Material findings\n");
      writeFileSync(join(art, "adversary-charlie.md"), "# c\n## Verdict\naccept\n");
      const out = cap();
      try { expect(await verdictTallyRun(["x"])).toBe(0); } finally { out.restore(); }
      const lines = out.text().trim().split("\n");
      expect(lines).toEqual(["VERDICT=alpha:needs-attention", "VERDICT=charlie:accept", "TALLY=needs-attention"]);
    } finally { cleanup(); }
  });
  it("AS=skipped rows report skipped and never enter the majority", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.md"), "## Verdict\naccept\n");
      writeFileSync(join(art, "adversary-charlie.txt"), "AS=skipped\n"); // no .md
      const out = cap();
      try { expect(await verdictTallyRun(["x"])).toBe(0); } finally { out.restore(); }
      const lines = out.text().trim().split("\n");
      expect(lines).toEqual(["VERDICT=alpha:accept", "VERDICT=charlie:skipped", "TALLY=accept"]);
    } finally { cleanup(); }
  });
  it("missing or heading-less critique reports malformed; all-uncountable → TALLY=unavailable", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.md"), "no heading here\n");
      // charlie has neither .txt nor .md → malformed too
      const out = cap();
      try { expect(await verdictTallyRun(["x"])).toBe(0); } finally { out.restore(); }
      const lines = out.text().trim().split("\n");
      expect(lines).toEqual(["VERDICT=alpha:malformed", "VERDICT=charlie:malformed", "TALLY=unavailable"]);
    } finally { cleanup(); }
  });
  it("rc2 without a topic; rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try {
      expect(await verdictTallyRun([])).toBe(2);
      expect(await verdictTallyRun(["nope"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore teardown", () => {
  it("archives _explore, kills panes by id (not the whole TSV line), prints the dest", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "preflight-panes.txt"), "alpha\t%1\ncharlie\t%2\n");
      let dest = "";
      const killed: string[] = [];
      const rc = await exploreTeardownWith(["x"], {
        killPane: async (p) => { killed.push(p); },
        archiveTopic: () => { dest = "/archive/x/_explore-T"; return dest; },
        stdout: (l) => { dest = l; },
      });
      expect(rc).toBe(0);
      expect(dest).toContain("_explore");
      expect(killed).toEqual(["%1", "%2"]);   // pane id, not "alpha\t%1"
    } finally { cleanup(); }
  });

  it("--panes-only: kills partial panes, clears attempt files, preserves list, no archive", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "preflight-panes.txt"), "alpha\t%1\ncharlie\t%2\n");
      writeFileSync(join(art, "spawn-results.tsv"), "alpha\tcodex\t0\n");
      const killed: string[] = [];
      let archived = false;
      const rc = await exploreTeardownWith(["x", "--panes-only"], {
        killPane: async (p) => { killed.push(p); },
        archiveTopic: () => { archived = true; return "/should/not/happen"; },
      });
      expect(rc).toBe(0);
      expect(killed).toEqual(["%1", "%2"]);                              // partial panes killed
      expect(archived).toBe(false);                                     // NO archive
      expect(existsSync(join(art, "preflight-panes.txt"))).toBe(false); // attempt files cleared
      expect(existsSync(join(art, "spawn-results.tsv"))).toBe(false);
      expect(existsSync(join(art, "list.txt"))).toBe(true);           // state preserved for retry
    } finally { cleanup(); }
  });
});

describe("explore forensics", () => {
  it("rc2 when no topic is given", async () => {
    expect(await exploreForensicsRun([])).toBe(2);
  });
});

describe("explore handoff-extract", () => {
  it("rc2 on a missing art-dir / no topic.txt", async () => {
    const art = mkdtempSync(join(tmpdir(), "explore-empty-"));
    expect(await handoffExtractRun([art])).toBe(2);
  });
});

describe("explore diff", () => {
  const approaches = (...items: string[]) =>
    "## Approaches\n" + items.map((c, i) => `${i + 1}. ${c}`).join("\n") + "\n";
  it("writes diff.md + buckets from explore-schema findings", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // list: alpha(codex), charlie(claude)
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), approaches("[src/a.ts:10] Shared — both", "[src/only-a.ts:1] AlphaOnly — solo"));
      writeFileSync(join(art, "findings-charlie.md"), approaches("[src/a.ts:10] Shared — both", "[paper:arxiv:9] CharlieOnly — solo"));
      expect(await diffExploreRun(["x"])).toBe(0);
      expect(readFileSync(join(art, "alpha_only_items.txt"), "utf8")).toBe("[src/only-a.ts:1] AlphaOnly — solo\n");
      expect(readFileSync(join(art, "charlie_only_items.txt"), "utf8")).toBe("[paper:arxiv:9] CharlieOnly — solo\n");
      expect(readFileSync(join(art, "diff.md"), "utf8")).toContain("## Agreed\n- [src/a.ts:10] Shared — both | Shared — both\n");
    } finally { cleanup(); }
  });
  it("rc 1 when diff.md already exists or a findings file is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      expect(await diffExploreRun(["x"])).toBe(1); // findings missing
      writeFileSync(join(art, "findings-alpha.md"), approaches("[a.ts:1] A — a"));
      writeFileSync(join(art, "findings-charlie.md"), approaches("[a.ts:1] A — a"));
      expect(await diffExploreRun(["x"])).toBe(0);
      expect(await diffExploreRun(["x"])).toBe(1); // diff.md exists; rm to retry
    } finally { cleanup(); }
  });
});

describe("explore crossverify-send/wait", () => {
  function seedBuckets(art: string) {
    writeFileSync(join(art, "alpha_only_items.txt"), "[src/only-a.ts:1] AlphaOnly — solo\n");
    writeFileSync(join(art, "charlie_only_items.txt"), "[paper:arxiv:9] CharlieOnly — solo\n");
  }
  it("send FS guard: research FS=timeout → VS=skipped, no send", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      seedBuckets(art);
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=timeout\n");
      const send = vi.fn(async () => 0);
      expect(await crossverifySendWith("x", "alpha", "codex", { offsetFor: () => 0, send })).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "crossverify-alpha.txt"), "utf8")).toBe("VS=skipped\n");
    } finally { cleanup(); }
  });
  it("send empty peer scope → VS=skipped, claims file written empty, no send", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "alpha_only_items.txt"), "");
      writeFileSync(join(art, "charlie_only_items.txt"), "");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      const send = vi.fn(async () => 0);
      expect(await crossverifySendWith("x", "alpha", "codex", { offsetFor: () => 0, send })).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "crossverify-alpha.txt"), "utf8")).toBe("VS=skipped\n");
      expect(readFileSync(join(art, "crossverify-claims-alpha.txt"), "utf8")).toBe("");
    } finally { cleanup(); }
  });
  it("send happy path: scoped to PEER buckets only, OFFSET captured, @prompt-file send", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      seedBuckets(art);
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      let sent: string[] = [];
      expect(await crossverifySendWith("x", "alpha", "codex", { offsetFor: () => 7, send: async (a) => { sent = a; return 0; } })).toBe(0);
      expect(readFileSync(join(art, "crossverify-alpha.txt"), "utf8")).toBe("OFFSET=7\n");
      const claims = readFileSync(join(art, "crossverify-claims-alpha.txt"), "utf8");
      expect(claims).toBe("[paper:arxiv:9] CharlieOnly — solo\n"); // charlie's bucket, never alpha's own
      const prompt = readFileSync(join(art, "alpha_crossverify_prompt.md"), "utf8");
      expect(prompt).toContain("AGREE");
      expect(prompt).toContain(join(art, "crossverify-alpha.md"));
      expect(prompt).not.toContain("END_OF_INSTRUCTION");
      expect(sent).toEqual(["--from", "hub", "alpha", "x", `@${join(art, "alpha_crossverify_prompt.md")}`]);
    } finally { cleanup(); }
  });
  it("send rc1 when its state file already exists; rc1 when a bucket is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      expect(await crossverifySendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => 0 })).toBe(1); // charlie bucket missing (run explore diff first)
      writeFileSync(join(art, "crossverify-alpha.txt"), "OFFSET=0\n");
      expect(await crossverifySendWith("x", "alpha", "codex", { offsetFor: () => 0, send: async () => 0 })).toBe(1); // state exists
    } finally { cleanup(); }
  });
  it("wait fast-path: VS=skipped writes .done, rc 0; wait outcomes ok/timeout; question bumps OFFSET", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "crossverify-alpha.txt"), "VS=skipped\n");
      expect(await crossverifyWaitWith("x", "alpha", "codex", { wait: async () => null, multiplier: () => "1" })).toBe(0);
      expect(existsSync(join(art, "crossverify-alpha.done"))).toBe(true);
      // done + non-empty verdicts → VS=ok
      writeFileSync(join(art, "crossverify-charlie.txt"), "OFFSET=0\n");
      writeFileSync(join(art, "crossverify-charlie.md"), "# Verify\n## Verdicts\n1. AGREE ...\n");
      expect(await crossverifyWaitWith("x", "charlie", "claude", { wait: async () => ({ event: "done" } as any), multiplier: () => "1" })).toBe(0);
      expect(readFileSync(join(art, "crossverify-charlie.txt"), "utf8")).toContain("VS=ok");
      // no event → VS=timeout
      writeFileSync(join(art, "crossverify-golf.txt"), "OFFSET=0\n");
      expect(await crossverifyWaitWith("x", "golf", "claude", { wait: async () => null, multiplier: () => "1" })).toBe(0);
      expect(readFileSync(join(art, "crossverify-golf.txt"), "utf8")).toContain("VS=timeout");
      // question event → payload captured + OFFSET re-armed (recordWaitOutcome contract)
      writeFileSync(join(art, "crossverify-hotel.txt"), "OFFSET=0\n");
      const q = { event: "question", message: "which bucket?" };
      expect(await crossverifyWaitWith("x", "hotel", "claude", { wait: async () => (q as any), multiplier: () => "1" })).toBe(0);
      expect(readFileSync(join(art, "question-hotel.txt"), "utf8")).toContain("which bucket?");
      const state = readFileSync(join(art, "crossverify-hotel.txt"), "utf8");
      expect(state).toContain("VS=question");
      expect(state.match(/OFFSET=/g)!.length).toBe(2); // re-armed past the question event
    } finally { cleanup(); }
  });
});
