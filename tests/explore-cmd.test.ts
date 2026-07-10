import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freshHome } from "./helpers/tmpHome.js";
import { initWith, classifyRun, spawnAllWith, researchSendWith, researchWaitWith, openqCollateRun, synthPreliminaryRun, confidenceRun, annotateRun, adversarySendWith, adversaryWaitWith, synthFinalRun, forensicsRun as exploreForensicsRun, teardownWith as exploreTeardownWith, handoffExtractRun, type ExploreInitDeps, type ExploreSpawnAllDeps, type ResearchSendDeps, type ResearchWaitDeps } from "../src/commands/explore.js";
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
