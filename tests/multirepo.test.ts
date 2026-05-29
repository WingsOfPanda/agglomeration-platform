// tests/multirepo.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMultiRepo } from "../src/core/multirepo.js";

function repo(root: string, name: string, marker?: "CLAUDE.md" | "AGENTS.md") {
  const d = join(root, name); mkdirSync(d, { recursive: true });
  if (marker) writeFileSync(join(d, marker), "x");
}

describe("detectMultiRepo", () => {
  it("matches siblings with a marker whose slug appears in the corpus (case-insensitive)", () => {
    const root = mkdtempSync(join(tmpdir(), "mr-"));
    repo(root, "api", "CLAUDE.md");
    repo(root, "web", "AGENTS.md");
    repo(root, "infra", "CLAUDE.md");      // present but not in corpus
    repo(root, "nomarker");                 // no marker → skipped
    mkdirSync(join(root, ".hidden"), { recursive: true });
    const hits = detectMultiRepo(root, "We touch the API and the Web frontend");
    expect(hits.map((h) => h.slug).sort()).toEqual(["api", "web"]);
    expect(hits.every((h) => h.marker.endsWith("CLAUDE.md") || h.marker.endsWith("AGENTS.md"))).toBe(true);
  });
  it("zero hits → []", () => {
    const root = mkdtempSync(join(tmpdir(), "mr0-"));
    repo(root, "api", "CLAUDE.md");
    expect(detectMultiRepo(root, "nothing relevant here")).toEqual([]);
  });
});
