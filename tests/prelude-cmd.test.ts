import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { initWith, classifyRun, type PreludeInitDeps } from "../src/commands/prelude.js";
import { preludeArtDir } from "../src/core/prelude.js";

function initDeps(over: Partial<PreludeInitDeps> = {}): PreludeInitDeps {
  return {
    activeProviders: () => ["codex", "claude"],
    isValidated: () => true,
    pickInstruments: (_t, n) => ["viola", "cello", "oboe"].slice(0, n),
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
      expect(readFileSync(join(art, "roster.txt"), "utf8")).toContain("codex\tviola");
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
