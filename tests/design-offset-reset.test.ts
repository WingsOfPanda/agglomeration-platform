import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { waitDeps } from "./helpers/phaseDeps.js";
import { designArtDir } from "../src/core/design.js";
import { workerDir } from "../src/core/paths.js";
import { offsetResetRun } from "../src/commands/design.js";
import { DESIGN_PHASES, phaseWait, type WaitDeps } from "../src/core/phaseTable.js";

/** design's research wait — the shared skeleton bound to its row (there is no per-phase wrapper). */
const researchWaitWith = (topic: string, agent: string, provider: string, d: WaitDeps): Promise<number> =>
  phaseWait(DESIGN_PHASES[0], topic, agent, provider, d);

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

describe("design offset-reset", () => {
  it("research (full cascade): deletes state+question+findings+cascade; keeps verify.md", async () => {
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=5\nFS=timeout\nAC=expired\nOFFSET=9\nFS=failed\n");
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
    // This mode destroyed the findings a re-armed wait would judge, so keeping the OFFSET would
    // only re-derive a terminal miss while blocking the re-SEND that is the actual recovery.
    for (const f of ["research-alpha.txt", "research-alpha.done", "question-alpha.txt", "diff.md", "alpha_only_items.txt", "charlie_only_items.txt", "adjudicated-draft.md"])
      expect(existsSync(join(art, f))).toBe(false);
    expect(existsSync(join(pd, "findings.md"))).toBe(false);
    expect(existsSync(join(pd, "verify.md"))).toBe(true);
  });

  it("--keep-findings: the state file is reduced to its LAST OFFSET= line (the busy-worker re-arm)", async () => {
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=5\nFS=timeout\nAC=expired\nOFFSET=9\nFS=failed\n");
    const pd = workerDir("alpha", "codex", "t"); mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "findings.md"), "still being written\n");
    expect(await offsetResetRun(["t", "alpha", "research", "--keep-findings"])).toBe(0);
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=9\n");
    expect(existsSync(join(pd, "findings.md"))).toBe(true);
  });

  it("a state file that never carried an OFFSET= is deleted in BOTH modes", async () => {
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "research-alpha.txt"), "FS=skipped\n");
    expect(await offsetResetRun(["t", "alpha", "research"])).toBe(0);
    expect(existsSync(join(art, "research-alpha.txt"))).toBe(false);
    writeFileSync(join(art, "research-alpha.txt"), "FS=skipped\n");
    expect(await offsetResetRun(["t", "alpha", "research", "--keep-findings"])).toBe(0);
    expect(existsSync(join(art, "research-alpha.txt"))).toBe(false);
  });

  it("the preserved OFFSET re-arms the wait (which used to die 'state file missing')", async () => {
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=12\nFS=timeout\n");
    mkdirSync(workerDir("alpha", "codex", "t"), { recursive: true });
    expect(await offsetResetRun(["t", "alpha", "research", "--keep-findings"])).toBe(0);
    let sawOffset: number | null = null;
    const rc = await researchWaitWith("t", "alpha", "codex", waitDeps({
      wait: async (_a, _p, _t, offset) => { sawOffset = offset; return { event: "error", fatal: "x" }; },
    }));
    expect(rc).toBe(0);
    expect(sawOffset).toBe(12);
  });

  it("--keep-findings: removes state+question+that agent's still-writing strikes, keeps cascade+worker files", async () => {
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "verify-alpha.txt"), "OFFSET=2\n");
    writeFileSync(join(art, "question-alpha.txt"), "{}\n");
    // Strike logs are per agent+ARTIFACT since 2026-07-31; the reset sweeps the agent's whole set.
    writeFileSync(join(art, "stillwriting-alpha-verify.md.txt"), "alpha 12\n");
    writeFileSync(join(art, "stillwriting-alpha-findings.md.txt"), "alpha 30\n");
    writeFileSync(join(art, "stillwriting-charlie-verify.md.txt"), "charlie 12\n");
    writeFileSync(join(art, "adjudicated-draft.md"), "x\n");
    const pd = workerDir("alpha", "codex", "t"); mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "verify.md"), "keep\n");
    expect(await offsetResetRun(["t", "alpha", "verify", "--keep-findings"])).toBe(0);
    expect(readFileSync(join(art, "verify-alpha.txt"), "utf8")).toBe("OFFSET=2\n"); // kept in BOTH modes

    expect(existsSync(join(art, "question-alpha.txt"))).toBe(false);
    // The reset re-arms the phase, so alpha's refusal strikes must not carry into the retry.
    expect(existsSync(join(art, "stillwriting-alpha-verify.md.txt"))).toBe(false);
    expect(existsSync(join(art, "stillwriting-alpha-findings.md.txt"))).toBe(false);
    expect(existsSync(join(art, "stillwriting-charlie-verify.md.txt"))).toBe(true); // per-agent, never a sweep
    expect(existsSync(join(art, "adjudicated-draft.md"))).toBe(true);
    expect(existsSync(join(pd, "verify.md"))).toBe(true);
  });

  it("bad phase → 2; missing art → 1; idempotent on empty art → 0", async () => {
    expect(await offsetResetRun(["t", "alpha", "bogus"])).toBe(2);
    expect(await offsetResetRun(["t", "alpha", "research"])).toBe(1);
    mkdirSync(designArtDir("t"), { recursive: true });
    expect(await offsetResetRun(["t", "alpha", "research"])).toBe(0);
  });
});
