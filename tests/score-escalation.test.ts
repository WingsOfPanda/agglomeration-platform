// tests/score-escalation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { scoreArtDir } from "../src/core/score.js";
import { partDir } from "../src/core/paths.js";
import { outboxPath } from "../src/core/ipc.js";
import { researchSendWith, researchWaitWith, diffRun, spawnAllWith } from "../src/commands/score.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

/** Seed a minimal initialised topic: _score/topic.txt + roster.txt. */
function seedTopic(topic: string, rows: Array<{ provider: string; instrument: string }>): string {
  const art = scoreArtDir(topic);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "topic.txt"), topic.replace(/-/g, " "));
  writeFileSync(join(art, "roster.txt"), rows.map((r) => `${r.provider}\t${r.instrument}`).join("\n") + "\n");
  return art;
}

describe("score research-send", () => {
  it("writes the prompt + OFFSET state, then calls send (rc 0)", async () => {
    const art = seedTopic("cache-policy", [{ provider: "codex", instrument: "viola" }]);
    const calls: string[][] = [];
    const rc = await researchSendWith("cache-policy", "viola", "codex", {
      offsetFor: () => 42,
      send: async (args) => { calls.push(args); return 0; },
    });
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "research-viola.txt"), "utf8")).toBe("OFFSET=42\n");
    const prompt = readFileSync(join(art, "viola_research_prompt.md"), "utf8");
    expect(prompt).toContain("## Claims");
    expect(prompt).toContain(join(partDir("viola", "codex", "cache-policy"), "findings.md"));
    expect(calls[0]).toEqual(["--from", "maestro", "viola", "cache-policy", `@${join(art, "viola_research_prompt.md")}`]);
  });

  it("refuses if the state file already exists (rc 1)", async () => {
    const art = seedTopic("cache-policy", [{ provider: "codex", instrument: "viola" }]);
    writeFileSync(join(art, "research-viola.txt"), "OFFSET=0\n");
    const rc = await researchSendWith("cache-policy", "viola", "codex", { offsetFor: () => 0, send: async () => 0 });
    expect(rc).toBe(1);
  });

  it("send failure keeps the state file and returns rc 1", async () => {
    const art = seedTopic("cache-policy", [{ provider: "codex", instrument: "viola" }]);
    const rc = await researchSendWith("cache-policy", "viola", "codex", { offsetFor: () => 7, send: async () => 1 });
    expect(rc).toBe(1);
    expect(existsSync(join(art, "research-viola.txt"))).toBe(true);
  });
});

describe("score research-wait", () => {
  function seedState(topic: string, instrument: string, provider: string, offset = 0): string {
    const art = scoreArtDir(topic);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, `research-${instrument}.txt`), `OFFSET=${offset}\n`);
    mkdirSync(partDir(instrument, provider, topic), { recursive: true });
    return art;
  }
  const dep = (ev: any, mult = "1.0") => ({ wait: async () => ev, multiplier: () => mult });

  it("done + cited findings → FS=ok + .done sentinel (rc 0)", async () => {
    const art = seedState("t", "viola", "codex");
    writeFileSync(join(partDir("viola", "codex", "t"), "findings.md"), "## Claims\n1. [a:1] x\n");
    const rc = await researchWaitWith("t", "viola", "codex", dep({ event: "done", summary: "ok" }));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "research-viola.txt"), "utf8")).toContain("FS=ok");
    expect(existsSync(join(art, "research-viola.done"))).toBe(true);
  });

  it("done with no findings.md → FS=missing", async () => {
    const art = seedState("t", "viola", "codex");
    await researchWaitWith("t", "viola", "codex", dep({ event: "done", summary: "ok" }));
    expect(readFileSync(join(art, "research-viola.txt"), "utf8")).toContain("FS=missing");
  });

  it("timeout (null) → FS=timeout; error → FS=failed", async () => {
    const art = seedState("t", "viola", "codex");
    await researchWaitWith("t", "viola", "codex", dep(null));
    expect(readFileSync(join(art, "research-viola.txt"), "utf8")).toContain("FS=timeout");
    writeFileSync(join(art, "research-viola.txt"), "OFFSET=0\n"); // reset
    await researchWaitWith("t", "viola", "codex", dep({ event: "error", reason: "x" }));
    expect(readFileSync(join(art, "research-viola.txt"), "utf8")).toContain("FS=failed");
  });

  it("question → captures payload, appends bumped OFFSET + FS=question", async () => {
    const art = seedState("t", "viola", "codex", 5);
    writeFileSync(outboxPath("viola", "codex", "t"), "0123456789ABC"); // size 13 → bumped offset
    await researchWaitWith("t", "viola", "codex", dep({ event: "question", message: "which db?" }));
    const state = readFileSync(join(art, "research-viola.txt"), "utf8");
    expect(state).toContain("FS=question");
    expect(state).toMatch(/OFFSET=13/); // bumped to current outbox size
    expect(readFileSync(join(art, "question-viola.txt"), "utf8")).toContain("which db?");
  });

  it("missing state file → rc 1", async () => {
    mkdirSync(scoreArtDir("t"), { recursive: true });
    expect(await researchWaitWith("t", "viola", "codex", dep(null))).toBe(1);
  });
});

describe("score diff", () => {
  function seedFindings(topic: string, rows: Array<{ provider: string; instrument: string; findings: string }>): string {
    const art = scoreArtDir(topic);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "roster.txt"), rows.map((r) => `${r.provider}\t${r.instrument}`).join("\n") + "\n");
    for (const r of rows) {
      mkdirSync(partDir(r.instrument, r.provider, topic), { recursive: true });
      writeFileSync(join(partDir(r.instrument, r.provider, topic), "findings.md"), r.findings);
    }
    return art;
  }

  it("N=2: writes diff.md + two *_only_items.txt (rc 0)", async () => {
    const art = seedFindings("t", [
      { provider: "codex", instrument: "viola", findings: "## Claims\n1. [a:1] shared\n2. [b:1] viola-only\n" },
      { provider: "claude", instrument: "cello", findings: "## Claims\n1. [a:1] shared\n3. [c:1] cello-only\n" },
    ]);
    const rc = await diffRun(["t"]);
    expect(rc).toBe(0);
    expect(existsSync(join(art, "diff.md"))).toBe(true);
    expect(existsSync(join(art, "viola_only_items.txt"))).toBe(true);
    expect(existsSync(join(art, "cello_only_items.txt"))).toBe(true);
    expect(readFileSync(join(art, "diff.md"), "utf8")).toContain("## Agreed");
  });

  it("refuses if diff.md already exists (rc 1)", async () => {
    const art = seedFindings("t", [
      { provider: "codex", instrument: "viola", findings: "## Claims\n1. [a:1] x\n" },
      { provider: "claude", instrument: "cello", findings: "## Claims\n1. [a:1] x\n" },
    ]);
    writeFileSync(join(art, "diff.md"), "stale\n");
    expect(await diffRun(["t"])).toBe(1);
  });

  it("missing a part's findings.md → rc 1", async () => {
    const art = scoreArtDir("t");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "roster.txt"), "codex\tviola\nclaude\tcello\n");
    mkdirSync(partDir("viola", "codex", "t"), { recursive: true });
    writeFileSync(join(partDir("viola", "codex", "t"), "findings.md"), "## Claims\n1. [a:1] x\n");
    expect(await diffRun(["t"])).toBe(1); // cello findings.md absent
  });
});

describe("score spawn-all", () => {
  function seedRoster(topic: string, rows: Array<{ provider: string; instrument: string }>): string {
    const art = scoreArtDir(topic);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "roster.txt"), rows.map((r) => `${r.provider}\t${r.instrument}`).join("\n") + "\n");
    return art;
  }
  // fake preflight writes the panes file the way the real one does
  const fakePreflight = (art: string, rows: Array<{ instrument: string }>) => async (_args: string[]) => {
    writeFileSync(join(art, "preflight-panes.txt"), rows.map((r, i) => `${r.instrument}\t%${i + 1}`).join("\n") + "\n");
    return 0;
  };

  it("all parts ok → spawn-results.tsv + rc 0; preflight gets the i:p roster arg", async () => {
    const rows = [{ provider: "codex", instrument: "viola" }, { provider: "claude", instrument: "cello" }];
    const art = seedRoster("t", rows);
    const pfArgs: string[][] = [];
    const spawnArgs: string[][] = [];
    const rc = await spawnAllWith("t", {
      preflight: async (a) => { pfArgs.push(a); return fakePreflight(art, rows)(a); },
      spawn: async (a) => { spawnArgs.push(a); return 0; },
      repoRoot: () => "/repo",
    });
    expect(rc).toBe(0);
    expect(pfArgs[0]).toContain("--roster");
    expect(pfArgs[0][pfArgs[0].indexOf("--roster") + 1]).toBe("viola:codex,cello:claude");
    expect(readFileSync(join(art, "spawn-results.tsv"), "utf8")).toBe("viola\tcodex\t0\t\ncello\tclaude\t0\t\n");
    expect(spawnArgs.every((a) => a.includes("--target-pane") && a.includes("--cwd") && a.includes("/repo"))).toBe(true);
  });

  it("partial failure → rc 1", async () => {
    const rows = [{ provider: "codex", instrument: "viola" }, { provider: "claude", instrument: "cello" }];
    const art = seedRoster("t", rows);
    const rc = await spawnAllWith("t", {
      preflight: fakePreflight(art, rows),
      spawn: async (a) => (a[0] === "cello" ? 1 : 0),
      repoRoot: () => "/repo",
    });
    expect(rc).toBe(1);
    expect(readFileSync(join(art, "spawn-results.tsv"), "utf8")).toContain("cello\tclaude\t1\tspawn-failed");
  });

  it("preflight failure → rc 2 (no spawns)", async () => {
    const rows = [{ provider: "codex", instrument: "viola" }, { provider: "claude", instrument: "cello" }];
    seedRoster("t", rows);
    let spawned = 0;
    const rc = await spawnAllWith("t", { preflight: async () => 1, spawn: async () => { spawned++; return 0; }, repoRoot: () => "/repo" });
    expect(rc).toBe(2);
    expect(spawned).toBe(0);
  });

  it("roster with <2 parts → rc 2", async () => {
    seedRoster("t", [{ provider: "codex", instrument: "viola" }]);
    expect(await spawnAllWith("t", { preflight: async () => 0, spawn: async () => 0, repoRoot: () => "/repo" })).toBe(2);
  });
});
