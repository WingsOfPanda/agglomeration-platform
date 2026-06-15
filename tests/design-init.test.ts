// tests/design-init.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { designArtDir, designDraftDir } from "../src/core/design.js";
import { initWith, type DesignInitDeps } from "../src/commands/design.js";

let prev: string | undefined;
beforeEach(() => { prev = process.env.AP_HOME; process.env.AP_HOME = mkdtempSync(join(tmpdir(), "si-")); });
afterEach(() => { if (prev === undefined) delete process.env.AP_HOME; else process.env.AP_HOME = prev; });

function deps(providers: string[], picks: string[]): DesignInitDeps {
  return {
    activeProviders: () => providers, isValidated: () => true, pickAgents: () => picks,
  };
}

describe("design init", () => {
  it("happy path: scaffold + list.txt + topic.txt + KV stdout (rc 0)", async () => {
    const rc = await initWith(["compare", "LRU", "vs", "LFU"], deps(["codex", "claude"], ["alpha", "charlie"]));
    expect(rc).toBe(0);
    const art = designArtDir("compare-lru-vs-lfu");
    expect(existsSync(designDraftDir("compare-lru-vs-lfu"))).toBe(true);
    expect(readFileSync(join(art, "topic.txt"), "utf8")).toBe("compare LRU vs LFU");
    const list = readFileSync(join(art, "list.txt"), "utf8");
    expect(list).toContain("codex\talpha");
    expect(list).toContain("claude\tcharlie");
  });
  it("empty topic → rc 1", async () => {
    expect(await initWith([], deps(["codex", "claude"], ["alpha", "charlie"]))).toBe(1);
  });
  it("N<2 validated providers → redirect, rc 1, no scaffold", async () => {
    const rc = await initWith(["x"], deps(["codex"], ["alpha"]));
    expect(rc).toBe(1);
    expect(existsSync(designArtDir("x"))).toBe(false);
  });
  it("caps the list to the first 3 providers", async () => {
    await initWith(["big"], deps(["codex", "claude", "agy", "opencode"], ["a", "b", "c"]));
    const list = readFileSync(join(designArtDir("big"), "list.txt"), "utf8");
    expect(list.trim().split("\n").filter((l) => !l.startsWith("#"))).toHaveLength(3);
  });
  it("in-flight (art dir exists) → rc 2", async () => {
    const d = deps(["codex", "claude"], ["alpha", "charlie"]);
    await initWith(["dup"], d);
    expect(await initWith(["dup"], d)).toBe(2);
  });
  it("writes skill.txt classified from the topic text", async () => {
    await initWith(["why", "is", "login", "broken"], deps(["codex", "claude"], ["alpha", "charlie"]));
    const art = designArtDir("why-is-login-broken");
    expect(readFileSync(join(art, "skill.txt"), "utf8")).toBe("systematic-debugging");
  });
  it("prints ART=<abs _design dir> on stdout", async () => {
    let out = "";
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { out += s; return true; };
    try {
      await initWith(["cache", "policy"], deps(["codex", "claude"], ["alpha", "charlie"]));
    } finally { (process.stdout as any).write = orig; }
    expect(out).toContain(`ART=${designArtDir("cache-policy")}`);
  });
});
