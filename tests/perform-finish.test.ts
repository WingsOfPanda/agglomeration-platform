// tests/perform-finish.test.ts — D5: per-repo finish-one verb (single target, APPEND, no truncate).
// finishWith (apply-to-all, truncate) coverage lives in tests/perform-cmd.test.ts and must stay green.
// CONSORT_HOME temp isolation via freshHome; fake Runner injection (no real git/tmux).
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { performArtDir } from "../src/core/perform.js";
import { finishOneWith } from "../src/commands/perform.js";
import type { Runner } from "../src/core/gitwork.js";

describe("perform finish-one", () => {
  it("finish-one finishes the single 'main' target and APPENDS to finish-results.tsv", async () => {
    const h = freshHome();
    const art = performArtDir("fin1");
    mkdirSync(join(art, "baselines"), { recursive: true });
    const mainCwd = join(h.home, "repo");
    writeFileSync(join(art, "target_cwd.txt"), mainCwd + "\n");
    writeFileSync(join(art, "perform-branches.tsv"), "main\tfeat/perform-fin1\n");
    writeFileSync(join(art, "baselines", "main.tsv"), "branch=main\n");
    // Directive truncates first, then per-repo finish-one appends.
    writeFileSync(join(art, "finish-results.tsv"), "");
    const deps = { runnerFor: (_c: string): Runner => ({ run: () => ({ code: 0, stdout: "" }) }), hasGh: false };
    expect(await finishOneWith("fin1", "main", "keep", deps as any)).toBe(0);
    const rows = readFileSync(join(art, "finish-results.tsv"), "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^main\tkeep\t/);
    h.cleanup();
  });

  it("finish-one rc 1 for an unknown slug", async () => {
    const h = freshHome();
    const art = performArtDir("fin2");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), join(h.home, "repo") + "\n");
    const deps = { runnerFor: (_c: string): Runner => ({ run: () => ({ code: 0, stdout: "" }) }), hasGh: false };
    expect(await finishOneWith("fin2", "nope", "keep", deps as any)).toBe(1);
    h.cleanup();
  });
});
