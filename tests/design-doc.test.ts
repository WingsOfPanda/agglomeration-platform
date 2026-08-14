// tests/design-doc.test.ts
import { describe, it, expect } from "vitest";
import { SECTIONS_SINGLE, sectionTitle, assembleDoc, synthesizeSeeds } from "../src/core/designDoc.js";

describe("section model", () => {
  it("single = 6 ordered keys", () => {
    expect(SECTIONS_SINGLE).toEqual(["problem", "goal", "architecture", "components", "testing", "success-criteria"]);
    expect(sectionTitle("success-criteria")).toBe("Success Criteria");
  });
});

describe("assembleDoc", () => {
  const drafts = new Map([["goal", "## Goal\n\ng"], ["architecture", "## Architecture\n\na"]]);
  it("single: H1, no header, missing drafts get _(missing draft)_", () => {
    const doc = assembleDoc({ title: "Cache Policy", drafts });
    expect(doc.startsWith("# Cache Policy\n\n")).toBe(true);
    expect(doc).not.toContain("**Date:**");
    expect(doc).toContain("## Goal\n\ng\n");
    expect(doc).toContain("## Problem\n\n_(missing draft)_\n\n");
  });
});

describe("synthesizeSeeds", () => {
  // Tag-first convention (clone-wars seeds match `^- \[Goal` etc.): the steer-tag leads the line.
  const adj = [
    "## Cross-verified",
    "- [Goal] ship the thing [src/a.ts:1]",
    "- [Architecture] use a queue [src/b.ts:2]",
    "- [Components] src/queue.ts is new [src/b.ts:9]",
    "- [Testing] pin the queue drain [src/d.ts:4]",
    "- [Success Criteria] p99 under 50ms [src/e.ts:5]",
    "- [src/c.ts:3] covers the test path",
    "## Contested",
  ].join("\n");
  const seeds = synthesizeSeeds(adj);
  const get = (s: string): string => seeds.find((x) => x.section === s)!.body;
  it("produces the 6 single-repo sections in order", () => {
    expect(seeds.map((s) => s.section)).toEqual(
      ["problem", "goal", "architecture", "components", "testing", "success-criteria"]);
  });
  it("each tagged line lands in exactly ONE section — problem no longer swallows the corpus", () => {
    const claims: Record<string, string> = {
      goal: "[Goal] ship the thing", architecture: "[Architecture] use a queue",
      components: "[Components] src/queue.ts is new", testing: "[Testing] pin the queue drain",
      "success-criteria": "[Success Criteria] p99 under 50ms",
    };
    expect(get("problem")).toContain("## Problem");
    for (const [section, claim] of Object.entries(claims)) {
      expect(get(section)).toContain(claim);
      for (const other of seeds.filter((s) => s.section !== section)) expect(other.body).not.toContain(claim);
    }
  });
  it("testing also matches an untagged 'test' word; unmatched section → rebranded placeholder", () => {
    expect(get("testing")).toContain("covers the test path");
    expect(get("problem")).toMatch(/no seed content matched/);
    expect(get("problem")).not.toMatch(/yoda|step 11/i);
  });
  it("a citation is not a tag — the terminator keeps `[problem.md:3]`-shaped lines out of the seeds", () => {
    const s = synthesizeSeeds("- [problem.md:3] the cache never expires\n- [components/Button.tsx:10] renders twice\n");
    for (const seed of s) expect(seed.body).toMatch(/no seed content matched/);
  });
  it("`[Goal]`, `[Goal:` and `[Goal something]` still route (the terminator, not the whole word)", () => {
    for (const line of ["- [Goal] a", "- [Goal: a", "- [Goal something] a"])
      expect(synthesizeSeeds(line).find((x) => x.section === "goal")!.body).toContain(line);
    // Deliberate tolerance change: the pluralized tag no longer routes.
    expect(synthesizeSeeds("- [Goals] a").find((x) => x.section === "goal")!.body).toMatch(/no seed content matched/);
  });
  it("problem takes its own [Problem] tag, and nothing else", () => {
    const s = synthesizeSeeds("- [Problem] the cache never expires [a:1]\n- [Goal] expire it [b:2]\n");
    const body = s.find((x) => x.section === "problem")!.body;
    expect(body).toContain("[Problem] the cache never expires");
    expect(body).not.toContain("[Goal] expire it");
  });
  it("an untagged corpus seeds the PLACEHOLDER everywhere (the 65KB problem.md dump)", () => {
    // adjudicate renders every claim as `- [<cite>] …`; those all used to land in problem.md.
    const corpus = Array.from({ length: 50 }, (_, i) => `- [src/f${i}.ts:${i}] some adjudicated claim`).join("\n");
    for (const s of synthesizeSeeds(corpus)) expect(s.body).toMatch(/no seed content matched/);
  });
  it("the 'test' heuristic only claims lines no tag took", () => {
    const s = synthesizeSeeds("- [Architecture] the test harness runs in-process [a:1]\n- [x:2] latest tests are green\n");
    expect(s.find((x) => x.section === "testing")!.body).not.toContain("[Architecture] the test harness");
    expect(s.find((x) => x.section === "testing")!.body).toContain("latest tests are green");
    expect(s.find((x) => x.section === "architecture")!.body).toContain("[Architecture] the test harness");
  });
});
