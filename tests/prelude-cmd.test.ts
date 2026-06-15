import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freshHome } from "./helpers/tmpHome.js";
import { initWith, classifyRun, spawnAllWith, researchSendWith, researchWaitWith, synthPreliminaryRun, confidenceRun, adversarySendWith, adversaryWaitWith, synthFinalRun, forensicsRun as preludeForensicsRun, teardownWith as preludeTeardownWith, handoffExtractRun, type PreludeInitDeps, type PreludeSpawnAllDeps, type ResearchSendDeps, type ResearchWaitDeps } from "../src/commands/prelude.js";
import { preludeArtDir } from "../src/core/prelude.js";

function initDeps(over: Partial<PreludeInitDeps> = {}): PreludeInitDeps {
  return {
    activeProviders: () => ["codex", "claude"],
    isValidated: () => true,
    pickAgents: (_t, n) => ["alpha", "charlie", "golf"].slice(0, n),
    ...over,
  };
}

describe("prelude init", () => {
  it("scaffolds _prelude with topic.txt + roster.txt for N=2", async () => {
    const { cleanup } = freshHome();
    try {
      const rc = await initWith(["attention", "kernels"], initDeps());
      expect(rc).toBe(0);
      const art = preludeArtDir("attention-kernels");
      expect(existsSync(join(art, "topic.txt"))).toBe(true);
      expect(readFileSync(join(art, "topic.txt"), "utf8")).toBe("attention kernels");
      expect(readFileSync(join(art, "roster.txt"), "utf8")).toContain("codex\talpha");
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
      expect(readFileSync(join(preludeArtDir("x"), "roster.txt"), "utf8").split("\n").filter((l) => l.includes("\t")).length).toBe(3);
    } finally { cleanup(); }
  });
  it("rc2 when _prelude already exists", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const rc = await initWith(["x"], initDeps());
      expect(rc).toBe(2);
    } finally { cleanup(); }
  });
});

describe("prelude classify", () => {
  it("writes lit-track.txt = ON for an academic topic", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["attention", "models"], initDeps());
      const rc = await classifyRun(["attention-models"]);
      expect(rc).toBe(0);
      const lt = readFileSync(join(preludeArtDir("attention-models"), "lit-track.txt"), "utf8");
      expect(lt.startsWith("ON\n")).toBe(true);
      expect(lt).toContain("reason: auto-detect via keyword scan");
    } finally { cleanup(); }
  });
  it("rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try { expect(await classifyRun(["nope"])).toBe(1); } finally { cleanup(); }
  });
});

describe("prelude spawn-all", () => {
  it("preflights then spawns each roster worker; rc0 when all ok", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      const deps: PreludeSpawnAllDeps = {
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

describe("prelude research-send/wait", () => {
  it("send renders prompt to <inst>_research_prompt.md and writes the offset state", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      await classifyRun(["x"]);
      const art = preludeArtDir("x");
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
      const art = preludeArtDir("x");
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

async function seedFindings(art: string, draft: string): Promise<void> {
  writeFileSync(join(art, "findings-alpha.md"), "FlashAttention is fast. https://x.test/p . uncertain about batch.");
  writeFileSync(join(art, "findings-charlie.md"), "FlashAttention wins. https://x.test/p .");
  writeFileSync(join(art, "landscape-draft.md"), draft);
}
const DRAFT = [
  "## Approaches", "1. FlashAttention — fused", "## Tradeoff matrix",
  "| Priority | Best fit | Reason |", "| latency | FlashAttention | https://x.test/p |", "## Citations", "- https://x.test/p",
].join("\n");

describe("prelude synth-preliminary", () => {
  it("prints the draft path when all findings exist", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), "a"); writeFileSync(join(art, "findings-charlie.md"), "b");
      const rc = await synthPreliminaryRun(["x"]);
      expect(rc).toBe(0);
    } finally { cleanup(); }
  });
  it("rc1 when a worker's findings are missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      writeFileSync(join(preludeArtDir("x"), "findings-alpha.md"), "a"); // charlie missing
      expect(await synthPreliminaryRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("prelude confidence", () => {
  it("no-flag + not-all-hold writes adversary-skip.txt with user_decision: not-offered", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
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
      const art = preludeArtDir("x");
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
      const art = preludeArtDir("x");
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

describe("prelude adversary-send/wait", () => {
  it("send guards the draft, renders the prompt, writes offset state", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
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
  it("wait marks AS=ok on a done event with a non-empty critique", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
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
      const art = preludeArtDir("x");
      writeFileSync(join(art, "adversary-alpha.txt"), "OFFSET=0\n");
      writeFileSync(join(art, "adversary-alpha.md"), ""); // empty critique → missing (researchState would say "empty")
      const rc = await adversaryWaitWith("x", "alpha", "codex", { wait: async () => ({ event: "done" } as any), multiplier: () => "1" });
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toContain("AS=missing");
    } finally { cleanup(); }
  });
});

describe("prelude synth-final", () => {
  it("rc0 when adversary ran and all critiques exist", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
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
      const art = preludeArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: skip\n");
      expect(await synthFinalRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
  it("rc1 when adversary ran but a critique is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
      writeFileSync(join(art, "adversary-alpha.md"), "c"); // charlie missing
      expect(await synthFinalRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("prelude teardown", () => {
  it("archives _prelude, kills panes by id (not the whole TSV line), prints the dest", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "preflight-panes.txt"), "alpha\t%1\ncharlie\t%2\n");
      let dest = "";
      const killed: string[] = [];
      const rc = await preludeTeardownWith(["x"], {
        killPane: async (p) => { killed.push(p); },
        archiveTopic: () => { dest = "/archive/x/_prelude-T"; return dest; },
        stdout: (l) => { dest = l; },
      });
      expect(rc).toBe(0);
      expect(dest).toContain("_prelude");
      expect(killed).toEqual(["%1", "%2"]);   // pane id, not "alpha\t%1"
    } finally { cleanup(); }
  });

  it("--panes-only: kills partial panes, clears attempt files, preserves roster, no archive", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "preflight-panes.txt"), "alpha\t%1\ncharlie\t%2\n");
      writeFileSync(join(art, "spawn-results.tsv"), "alpha\tcodex\t0\n");
      const killed: string[] = [];
      let archived = false;
      const rc = await preludeTeardownWith(["x", "--panes-only"], {
        killPane: async (p) => { killed.push(p); },
        archiveTopic: () => { archived = true; return "/should/not/happen"; },
      });
      expect(rc).toBe(0);
      expect(killed).toEqual(["%1", "%2"]);                              // partial panes killed
      expect(archived).toBe(false);                                     // NO archive
      expect(existsSync(join(art, "preflight-panes.txt"))).toBe(false); // attempt files cleared
      expect(existsSync(join(art, "spawn-results.tsv"))).toBe(false);
      expect(existsSync(join(art, "roster.txt"))).toBe(true);           // state preserved for retry
    } finally { cleanup(); }
  });
});

describe("prelude forensics", () => {
  it("rc2 when no topic is given", async () => {
    expect(await preludeForensicsRun([])).toBe(2);
  });
});

describe("prelude handoff-extract", () => {
  it("rc2 on a missing art-dir / no topic.txt", async () => {
    const art = mkdtempSync(join(tmpdir(), "prelude-empty-"));
    expect(await handoffExtractRun([art])).toBe(2);
  });
});
