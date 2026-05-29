// tests/multirepo.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMultiRepo, validateTargets } from "../src/core/multirepo.js";

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

describe("validateTargets", () => {
  it("accepts real sibling dirs with a marker; resolves RepoHit[]", () => {
    const root = mkdtempSync(join(tmpdir(), "vt1-"));
    repo(root, "api", "CLAUDE.md"); repo(root, "web", "AGENTS.md");
    const r = validateTargets(root, ["api", "web"]);
    expect(r.errors).toEqual([]);
    expect(r.ok.map((h) => h.slug)).toEqual(["api", "web"]);
    expect(r.ok[0].marker.endsWith(join("api", "CLAUDE.md"))).toBe(true);
  });
  it("rejects a path-traversal slug and a missing dir", () => {
    const root = mkdtempSync(join(tmpdir(), "vt2-"));
    repo(root, "api", "CLAUDE.md");
    const r = validateTargets(root, ["../escape", "ghost"]);
    expect(r.ok).toEqual([]);
    expect(r.errors.length).toBe(2);
  });
  it("rejects a sibling dir with no marker, and dedups", () => {
    const root = mkdtempSync(join(tmpdir(), "vt3-"));
    repo(root, "api", "CLAUDE.md"); repo(root, "nomark");
    const r = validateTargets(root, ["api", "api", "nomark"]);
    expect(r.ok.map((h) => h.slug)).toEqual(["api"]);
    expect(r.errors.some((e) => /duplicate/.test(e))).toBe(true);
    expect(r.errors.some((e) => /nomark/.test(e))).toBe(true);
  });
});
