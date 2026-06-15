// tests/design-escalation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { designArtDir } from "../src/core/design.js";
import { workerDir } from "../src/core/paths.js";
import { outboxPath } from "../src/core/ipc.js";
import { researchSendWith, researchWaitWith, diffRun, spawnAllWith, verifySendWith, verifyWaitWith, adjudicateRun, synthesizeRun, walkStateRun, drilldownWith, forensicsRun, archiveRun } from "../src/commands/design.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

/** Seed a minimal initialised topic: _design/topic.txt + list.txt. */
function seedTopic(topic: string, rows: Array<{ provider: string; agent: string }>): string {
  const art = designArtDir(topic);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "topic.txt"), topic.replace(/-/g, " "));
  writeFileSync(join(art, "list.txt"), rows.map((r) => `${r.provider}\t${r.agent}`).join("\n") + "\n");
  return art;
}

describe("design research-send", () => {
  it("writes the prompt + OFFSET state, then calls send (rc 0)", async () => {
    const art = seedTopic("cache-policy", [{ provider: "codex", agent: "alpha" }]);
    const calls: string[][] = [];
    const rc = await researchSendWith("cache-policy", "alpha", "codex", {
      offsetFor: () => 42,
      send: async (args) => { calls.push(args); return 0; },
    });
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=42\n");
    const prompt = readFileSync(join(art, "alpha_research_prompt.md"), "utf8");
    expect(prompt).toContain("## Claims");
    expect(prompt).toContain(join(workerDir("alpha", "codex", "cache-policy"), "findings.md"));
    expect(calls[0]).toEqual(["--from", "hub", "alpha", "cache-policy", `@${join(art, "alpha_research_prompt.md")}`]);
  });

  it("refuses if the state file already exists (rc 1)", async () => {
    const art = seedTopic("cache-policy", [{ provider: "codex", agent: "alpha" }]);
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\n");
    const rc = await researchSendWith("cache-policy", "alpha", "codex", { offsetFor: () => 0, send: async () => 0 });
    expect(rc).toBe(1);
  });

  it("send failure keeps the state file and returns rc 1", async () => {
    const art = seedTopic("cache-policy", [{ provider: "codex", agent: "alpha" }]);
    const rc = await researchSendWith("cache-policy", "alpha", "codex", { offsetFor: () => 7, send: async () => 1 });
    expect(rc).toBe(1);
    expect(existsSync(join(art, "research-alpha.txt"))).toBe(true);
  });
});

describe("design research-wait", () => {
  function seedState(topic: string, agent: string, provider: string, offset = 0): string {
    const art = designArtDir(topic);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, `research-${agent}.txt`), `OFFSET=${offset}\n`);
    mkdirSync(workerDir(agent, provider, topic), { recursive: true });
    return art;
  }
  const dep = (ev: any, mult = "1.0") => ({ wait: async () => ev, multiplier: () => mult });

  it("done + cited findings → FS=ok + .done sentinel (rc 0)", async () => {
    const art = seedState("t", "alpha", "codex");
    writeFileSync(join(workerDir("alpha", "codex", "t"), "findings.md"), "## Claims\n1. [a:1] x\n");
    const rc = await researchWaitWith("t", "alpha", "codex", dep({ event: "done", summary: "ok" }));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=ok");
    expect(existsSync(join(art, "research-alpha.done"))).toBe(true);
  });

  it("done with no findings.md → FS=missing", async () => {
    const art = seedState("t", "alpha", "codex");
    await researchWaitWith("t", "alpha", "codex", dep({ event: "done", summary: "ok" }));
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=missing");
  });

  it("timeout (null) → FS=timeout; error → FS=failed", async () => {
    const art = seedState("t", "alpha", "codex");
    await researchWaitWith("t", "alpha", "codex", dep(null));
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=timeout");
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\n"); // reset
    await researchWaitWith("t", "alpha", "codex", dep({ event: "error", reason: "x" }));
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=failed");
  });

  it("question → captures payload, appends bumped OFFSET + FS=question", async () => {
    const art = seedState("t", "alpha", "codex", 5);
    writeFileSync(outboxPath("alpha", "codex", "t"), "0123456789ABC"); // size 13 → bumped offset
    await researchWaitWith("t", "alpha", "codex", dep({ event: "question", message: "which db?" }));
    const state = readFileSync(join(art, "research-alpha.txt"), "utf8");
    expect(state).toContain("FS=question");
    expect(state).toMatch(/OFFSET=13/); // bumped to current outbox size
    expect(readFileSync(join(art, "question-alpha.txt"), "utf8")).toContain("which db?");
  });

  it("missing state file → rc 1", async () => {
    mkdirSync(designArtDir("t"), { recursive: true });
    expect(await researchWaitWith("t", "alpha", "codex", dep(null))).toBe(1);
  });
});

describe("design diff", () => {
  function seedFindings(topic: string, rows: Array<{ provider: string; agent: string; findings: string }>): string {
    const art = designArtDir(topic);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "list.txt"), rows.map((r) => `${r.provider}\t${r.agent}`).join("\n") + "\n");
    for (const r of rows) {
      mkdirSync(workerDir(r.agent, r.provider, topic), { recursive: true });
      writeFileSync(join(workerDir(r.agent, r.provider, topic), "findings.md"), r.findings);
    }
    return art;
  }

  it("N=2: writes diff.md + two *_only_items.txt (rc 0)", async () => {
    const art = seedFindings("t", [
      { provider: "codex", agent: "alpha", findings: "## Claims\n1. [a:1] shared\n2. [b:1] alpha-only\n" },
      { provider: "claude", agent: "charlie", findings: "## Claims\n1. [a:1] shared\n3. [c:1] charlie-only\n" },
    ]);
    const rc = await diffRun(["t"]);
    expect(rc).toBe(0);
    expect(existsSync(join(art, "diff.md"))).toBe(true);
    expect(existsSync(join(art, "alpha_only_items.txt"))).toBe(true);
    expect(existsSync(join(art, "charlie_only_items.txt"))).toBe(true);
    expect(readFileSync(join(art, "diff.md"), "utf8")).toContain("## Agreed");
  });

  it("refuses if diff.md already exists (rc 1)", async () => {
    const art = seedFindings("t", [
      { provider: "codex", agent: "alpha", findings: "## Claims\n1. [a:1] x\n" },
      { provider: "claude", agent: "charlie", findings: "## Claims\n1. [a:1] x\n" },
    ]);
    writeFileSync(join(art, "diff.md"), "stale\n");
    expect(await diffRun(["t"])).toBe(1);
  });

  it("missing a worker's findings.md → rc 1", async () => {
    const art = designArtDir("t");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "list.txt"), "codex\talpha\nclaude\tcharlie\n");
    mkdirSync(workerDir("alpha", "codex", "t"), { recursive: true });
    writeFileSync(join(workerDir("alpha", "codex", "t"), "findings.md"), "## Claims\n1. [a:1] x\n");
    expect(await diffRun(["t"])).toBe(1); // charlie findings.md absent
  });
});

describe("design spawn-all", () => {
  function seedList(topic: string, rows: Array<{ provider: string; agent: string }>): string {
    const art = designArtDir(topic);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "list.txt"), rows.map((r) => `${r.provider}\t${r.agent}`).join("\n") + "\n");
    return art;
  }
  // fake preflight writes the panes file the way the real one does
  const fakePreflight = (art: string, rows: Array<{ agent: string }>) => async (_args: string[]) => {
    writeFileSync(join(art, "preflight-panes.txt"), rows.map((r, i) => `${r.agent}\t%${i + 1}`).join("\n") + "\n");
    return 0;
  };

  it("all workers ok → spawn-results.tsv + rc 0; preflight gets the i:p list arg", async () => {
    const rows = [{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }];
    const art = seedList("t", rows);
    const pfArgs: string[][] = [];
    const spawnArgs: string[][] = [];
    const rc = await spawnAllWith("t", {
      preflight: async (a) => { pfArgs.push(a); return fakePreflight(art, rows)(a); },
      spawn: async (a) => { spawnArgs.push(a); return 0; },
      repoRoot: () => "/repo",
    });
    expect(rc).toBe(0);
    expect(pfArgs[0]).toContain("--list");
    expect(pfArgs[0][pfArgs[0].indexOf("--list") + 1]).toBe("alpha:codex,charlie:claude");
    expect(readFileSync(join(art, "spawn-results.tsv"), "utf8")).toBe("alpha\tcodex\t0\t\ncharlie\tclaude\t0\t\n");
    expect(spawnArgs.every((a) => a.includes("--target-pane") && a.includes("--cwd") && a.includes("/repo"))).toBe(true);
  });

  it("partial failure → rc 1", async () => {
    const rows = [{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }];
    const art = seedList("t", rows);
    const rc = await spawnAllWith("t", {
      preflight: fakePreflight(art, rows),
      spawn: async (a) => (a[0] === "charlie" ? 1 : 0),
      repoRoot: () => "/repo",
    });
    expect(rc).toBe(1);
    expect(readFileSync(join(art, "spawn-results.tsv"), "utf8")).toContain("charlie\tclaude\t1\tspawn-failed");
  });

  it("preflight failure → rc 2 (no spawns)", async () => {
    const rows = [{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }];
    seedList("t", rows);
    let spawned = 0;
    const rc = await spawnAllWith("t", { preflight: async () => 1, spawn: async () => { spawned++; return 0; }, repoRoot: () => "/repo" });
    expect(rc).toBe(2);
    expect(spawned).toBe(0);
  });

  it("list with <2 workers → rc 2", async () => {
    seedList("t", [{ provider: "codex", agent: "alpha" }]);
    expect(await spawnAllWith("t", { preflight: async () => 0, spawn: async () => 0, repoRoot: () => "/repo" })).toBe(2);
  });
});

describe("design verify-send", () => {
  function seedV(topic: string, rows: Array<{ provider: string; agent: string }>, buckets: Record<string, string>): string {
    const art = designArtDir(topic);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "list.txt"), rows.map((r) => `${r.provider}\t${r.agent}`).join("\n") + "\n");
    writeFileSync(join(art, "topic.txt"), topic);
    for (const [f, c] of Object.entries(buckets)) writeFileSync(join(art, f), c);
    return art;
  }
  const rows = [{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }];

  it("N=2: scope = other's bucket; composes + sends (rc 0)", async () => {
    const art = seedV("t", rows, { "alpha_only_items.txt": "[a:1] vc\n", "charlie_only_items.txt": "[b:2] cc\n" });
    const calls: string[][] = [];
    const rc = await verifySendWith("t", "alpha", "codex", { offsetFor: () => 7, send: async (a) => { calls.push(a); return 0; } });
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "verify-claims-alpha.txt"), "utf8")).toContain("[b:2] cc"); // charlie's, not alpha's
    expect(readFileSync(join(art, "verify-alpha.txt"), "utf8")).toBe("OFFSET=7\n");
    expect(calls[0]).toContain("@" + join(art, "alpha_verify_prompt.md"));
  });

  it("empty scope → VS=skipped, no send (rc 0)", async () => {
    const art = seedV("t", rows, { "alpha_only_items.txt": "", "charlie_only_items.txt": "" });
    let sent = 0;
    const rc = await verifySendWith("t", "charlie", "claude", { offsetFor: () => 0, send: async () => { sent++; return 0; } });
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "verify-charlie.txt"), "utf8")).toBe("VS=skipped\n");
    expect(sent).toBe(0);
  });

  it("refuses if verify-<inst>.txt exists (rc 1)", async () => {
    const art = seedV("t", rows, { "alpha_only_items.txt": "x\n", "charlie_only_items.txt": "y\n" });
    writeFileSync(join(art, "verify-alpha.txt"), "OFFSET=0\n");
    expect(await verifySendWith("t", "alpha", "codex", { offsetFor: () => 0, send: async () => 0 })).toBe(1);
  });
});

describe("design verify-wait", () => {
  function seedVw(topic: string, agent: string, provider: string, body: string): string {
    const art = designArtDir(topic); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, `verify-${agent}.txt`), body);
    mkdirSync(workerDir(agent, provider, topic), { recursive: true });
    return art;
  }
  const dep = (ev: any) => ({ wait: async () => ev, multiplier: () => "1.0" });

  it("VS=skipped short-circuit: writes .done, no wait (rc 0)", async () => {
    const art = seedVw("t", "alpha", "codex", "VS=skipped\n");
    let waited = 0;
    const rc = await verifyWaitWith("t", "alpha", "codex", { wait: async () => { waited++; return null; }, multiplier: () => "1.0" });
    expect(rc).toBe(0); expect(waited).toBe(0);
    expect(existsSync(join(art, "verify-alpha.done"))).toBe(true);
  });

  it("done + non-empty verify.md → VS=ok", async () => {
    const art = seedVw("t", "alpha", "codex", "OFFSET=0\n");
    writeFileSync(join(workerDir("alpha", "codex", "t"), "verify.md"), "## Verdicts\n1. AGREE [a:1] x\n");
    await verifyWaitWith("t", "alpha", "codex", dep({ event: "done", summary: "ok" }));
    expect(readFileSync(join(art, "verify-alpha.txt"), "utf8")).toContain("VS=ok");
  });

  it("question → bumped OFFSET + VS=question + payload", async () => {
    const art = seedVw("t", "alpha", "codex", "OFFSET=3\n");
    writeFileSync(outboxPath("alpha", "codex", "t"), "0123456789"); // size 10
    await verifyWaitWith("t", "alpha", "codex", dep({ event: "question", message: "scope?" }));
    const s = readFileSync(join(art, "verify-alpha.txt"), "utf8");
    expect(s).toContain("VS=question"); expect(s).toMatch(/OFFSET=10/);
    expect(readFileSync(join(art, "question-alpha.txt"), "utf8")).toContain("scope?");
  });
});

describe("design adjudicate", () => {
  it("N=2: writes adjudicated-draft.md with the 4 sections; leaves adjudicated.md untouched", async () => {
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "list.txt"), "codex\talpha\nclaude\tcharlie\n");
    writeFileSync(join(art, "alpha_only_items.txt"), "[a:1] alpha claim\n");
    writeFileSync(join(art, "charlie_only_items.txt"), "[b:2] charlie claim\n");
    for (const [inst, prov] of [["alpha", "codex"], ["charlie", "claude"]]) {
      mkdirSync(workerDir(inst, prov, "t"), { recursive: true });
      writeFileSync(join(workerDir(inst, prov, "t"), "verify.md"), "## Verdicts\n1. AGREE [b:2] charlie claim\n   confirmed\n");
      writeFileSync(join(art, `verify-${inst}.txt`), "OFFSET=0\nVS=ok\n");
    }
    const rc = await adjudicateRun(["t"]);
    expect(rc).toBe(0);
    const draft = readFileSync(join(art, "adjudicated-draft.md"), "utf8");
    expect(draft).toContain("## Cross-verified");
    expect(draft).toContain("## Adjudicated");
    expect(draft).toContain("## Contested");
    expect(draft).toContain("## Not-verified");
    expect(existsSync(join(art, "adjudicated.md"))).toBe(false);
  });
});

describe("design synthesize", () => {
  it("refuses when adjudicated.md missing (rc 1)", async () => {
    mkdirSync(designArtDir("t"), { recursive: true });
    expect(await synthesizeRun(["t"])).toBe(1);
  });
  it("refuses while a '- PENDING:' line remains (rc 1)", async () => {
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "adjudicated.md"), "## Cross-verified\n- PENDING: [a:1] x\n");
    expect(await synthesizeRun(["t"])).toBe(1);
  });
  it("seeds the 6 .draft/*.md (rc 0)", async () => {
    const art = designArtDir("t"); mkdirSync(join(art, "design-doc", ".draft"), { recursive: true });
    writeFileSync(join(art, "adjudicated.md"), "## Cross-verified\n- [Goal] ship it [a:1]\n");
    expect(await synthesizeRun(["t"])).toBe(0);
    expect(readFileSync(join(art, "design-doc", ".draft", "goal.md"), "utf8")).toContain("[Goal] ship it");
    expect(existsSync(join(art, "design-doc", ".draft", "success-criteria.md"))).toBe(true);
  });
});

describe("design walk-state", () => {
  it("prints section\\tstatus (skipped detected) to stdout", async () => {
    const dd = join(designArtDir("t"), "design-doc", ".draft"); mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, "goal.md"), "## Goal\n\nship it\n");
    writeFileSync(join(dd, "problem.md"), "_(skipped)_");
    let out = ""; const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { out += s; return true; };
    try { await walkStateRun(["t"]); } finally { (process.stdout as any).write = orig; }
    expect(out).toContain("goal\tapproved");
    expect(out).toContain("problem\tskipped");
  });
});

describe("design drilldown", () => {
  it("dispatches K=1, writes a non-empty file → rc 0; resolves the scratch path", async () => {
    const art = designArtDir("t"); const dd = join(art, "drilldowns"); mkdirSync(join(dd, "_scratch"), { recursive: true });
    writeFileSync(join(art, "doc.md"), "# doc\n");
    mkdirSync(workerDir("alpha", "codex", "t"), { recursive: true });
    const sends: string[][] = [];
    const rc = await drilldownWith(
      ["t", "Architecture", dd, "", join(art, "doc.md"), "alpha", "codex"],
      { offsetFor: () => 0, send: async (a) => { sends.push(a); // simulate the worker writing its drill file
          a[a.length - 1].slice(1); /* @<promptfile> not the out path */ return 0; },
        wait: async () => ({ event: "done" }), multiplier: () => "1.0" },
      { writeProbe: (p: string) => writeFileSync(p, "notes\n") }, // test hook: create the out file the worker would write
    );
    expect(rc).toBe(0);
    expect(sends[0]).toContain("--from"); expect(sends[0]).toContain("hub");
    expect(existsSync(join(dd, "_scratch", "drilldown-architecture-alpha.md"))).toBe(true);
  });
  it("all-empty round → rc 1; bad arg count → rc 2", async () => {
    const art = designArtDir("t"); const dd = join(art, "drilldowns"); mkdirSync(join(dd, "_scratch"), { recursive: true });
    writeFileSync(join(art, "doc.md"), "# doc\n"); mkdirSync(workerDir("alpha", "codex", "t"), { recursive: true });
    const rc = await drilldownWith(["t", "Arch", dd, "", join(art, "doc.md"), "alpha", "codex"],
      { offsetFor: () => 0, send: async () => 0, wait: async () => ({ event: "done" }), multiplier: () => "1.0" }, {});
    expect(rc).toBe(1); // no file written
    expect(await drilldownWith(["t", "Arch"], { offsetFor: () => 0, send: async () => 0, wait: async () => null, multiplier: () => "1.0" }, {})).toBe(2);
  });
});

describe("design forensics + archive", () => {
  it("forensics prints a path when there are findings, else empty (rc 0)", async () => {
    const art = designArtDir("t"); mkdirSync(join(art, "design-doc"), { recursive: true });
    writeFileSync(join(art, "design-doc", "audit.log"), "ISSUE=no_goal_section\n");
    let out = ""; const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { out += s; return true; };
    let rc = 0; try { rc = await forensicsRun(["t"]); } finally { (process.stdout as any).write = orig; }
    expect(rc).toBe(0);
    expect(out).toMatch(/forensics[/\\]2\d{3}-\d\d-\d\d[/\\].*-design-t\.md/);
  });
  it("archive moves _design and rmdirs the topic (rc 0)", async () => {
    const art = designArtDir("t"); mkdirSync(join(art, "design-doc"), { recursive: true });
    writeFileSync(join(art, "topic.txt"), "t");
    expect(await archiveRun(["t"])).toBe(0);
    expect(existsSync(art)).toBe(false); // moved to archive
  });
});
