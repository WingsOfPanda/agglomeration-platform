import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { scoreArtDir } from "../src/core/score.js";
import { workerDir } from "../src/core/paths.js";
import { offsetResetRun } from "../src/commands/score.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

describe("score offset-reset", () => {
  it("research: removes state+question+findings+cascade; keeps verify.md", async () => {
    const art = scoreArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=5\n");
    writeFileSync(join(art, "research-alpha.done"), "ok\n");
    writeFileSync(join(art, "question-alpha.txt"), "{}\n");
    writeFileSync(join(art, "diff.md"), "x\n");
    writeFileSync(join(art, "alpha_only_items.txt"), "x\n");
    writeFileSync(join(art, "charlie_only_items.txt"), "x\n");
    writeFileSync(join(art, "adjudicated-draft.md"), "x\n");
    const pd = workerDir("alpha", "codex", "t"); mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "findings.md"), "stale\n");
    writeFileSync(join(pd, "verify.md"), "keep\n");

    expect(await offsetResetRun(["t", "alpha", "research"])).toBe(0);
    for (const f of ["research-alpha.txt", "research-alpha.done", "question-alpha.txt", "diff.md", "alpha_only_items.txt", "charlie_only_items.txt", "adjudicated-draft.md"])
      expect(existsSync(join(art, f))).toBe(false);
    expect(existsSync(join(pd, "findings.md"))).toBe(false);
    expect(existsSync(join(pd, "verify.md"))).toBe(true);
  });

  it("--keep-findings: removes only state+question, keeps cascade+worker files", async () => {
    const art = scoreArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "verify-alpha.txt"), "OFFSET=2\n");
    writeFileSync(join(art, "question-alpha.txt"), "{}\n");
    writeFileSync(join(art, "adjudicated-draft.md"), "x\n");
    const pd = workerDir("alpha", "codex", "t"); mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "verify.md"), "keep\n");
    expect(await offsetResetRun(["t", "alpha", "verify", "--keep-findings"])).toBe(0);
    expect(existsSync(join(art, "verify-alpha.txt"))).toBe(false);
    expect(existsSync(join(art, "question-alpha.txt"))).toBe(false);
    expect(existsSync(join(art, "adjudicated-draft.md"))).toBe(true);
    expect(existsSync(join(pd, "verify.md"))).toBe(true);
  });

  it("bad phase → 2; missing art → 1; idempotent on empty art → 0", async () => {
    expect(await offsetResetRun(["t", "alpha", "bogus"])).toBe(2);
    expect(await offsetResetRun(["t", "alpha", "research"])).toBe(1);
    mkdirSync(scoreArtDir("t"), { recursive: true });
    expect(await offsetResetRun(["t", "alpha", "research"])).toBe(0);
  });
});
