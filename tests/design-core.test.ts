// tests/design-core.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { designArtDir, designDraftDir, parseDesignArgs, designDocPath, formatListFile, parseListFile, verifyScopeFiles, lastTag, resolveDrilldownPath, designExportDocPath, exportDocTo } from "../src/core/design.js";

describe("design paths", () => {
  it("designArtDir / designDraftDir hang off the topic dir under _design", () => {
    process.env.AP_HOME = "/R";
    const art = designArtDir("design-auth");
    expect(art.endsWith(join("design-auth", "_design"))).toBe(true);
    expect(designDraftDir("design-auth")).toBe(join(art, "design-doc", ".draft"));
  });
});

describe("parseDesignArgs", () => {
  it("plain topic → no ensemble", () => {
    expect(parseDesignArgs(["compare", "LRU", "vs", "LFU"])).toEqual({ topicText: "compare LRU vs LFU", ensemble: false });
  });
  it("--ensemble is a token-exact boolean flag, stripped from the topic", () => {
    const r = parseDesignArgs(["--ensemble", "design", "auth"]);
    expect(r.ensemble).toBe(true);
    expect(r.topicText).toBe("design auth");
  });
  it("--ensemble-please is NOT the flag (token-exact)", () => {
    const r = parseDesignArgs(["--ensemble-please", "x"]);
    expect(r.ensemble).toBe(false);
    expect(r.topicText).toBe("--ensemble-please x");
  });
});

describe("designDocPath", () => {
  it("canonical design-doc path under design-doc/", () => {
    process.env.AP_HOME = "/R";
    expect(designDocPath("auth", "2026-05-29").endsWith(join("auth", "_design", "design-doc", "2026-05-29-auth-design.md"))).toBe(true);
  });
});

describe("list file", () => {
  it("format then parse round-trips provider/agent rows", () => {
    const rows = [{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }];
    const text = formatListFile(rows, "2026-05-29T00:00:00Z");
    expect(text).toContain("by /ap:design");
    expect(parseListFile(text)).toEqual(rows);
  });
  it("parse skips #/blank lines and rows missing a field", () => {
    expect(parseListFile("# h\ncodex\talpha\n\nbroken\n")).toEqual([{ provider: "codex", agent: "alpha" }]);
  });
});

describe("verifyScopeFiles", () => {
  it("N=2: only the other agent's _only_items.txt", () => {
    expect(verifyScopeFiles("alpha", ["alpha", "charlie"])).toEqual(["charlie_only_items.txt"]);
    expect(verifyScopeFiles("charlie", ["alpha", "charlie"])).toEqual(["alpha_only_items.txt"]);
  });
  it("N=3: other singles + pairs not containing target (skip consensus + own)", () => {
    expect(verifyScopeFiles("alpha", ["alpha", "charlie", "delta"]))
      .toEqual(["charlie_only_items.txt", "delta_only_items.txt", "charlie+delta_only.txt"]);
  });
});

describe("lastTag", () => {
  it("returns the last value of the tag; null when absent", () => {
    expect(lastTag("VS=skipped\n", "VS")).toBe("skipped");
    expect(lastTag("OFFSET=1\nVS=question\nOFFSET=9\nVS=ok\n", "VS")).toBe("ok");
    expect(lastTag("OFFSET=1\n", "VS")).toBeNull();
  });
});

describe("drilldown paths", () => {
  it("resolveDrilldownPath: plain, then -2/-3 collisions (no compounding)", () => {
    const sc = mkdtempSync(join(tmpdir(), "dd-")); mkdirSync(sc, { recursive: true });
    const p1 = resolveDrilldownPath(sc, "the section", "alpha");
    expect(p1.endsWith(join(sc, "drilldown-the-section-alpha.md").slice(-40)) || p1.endsWith("drilldown-the-section-alpha.md")).toBe(true);
    writeFileSync(p1, "x");
    const p2 = resolveDrilldownPath(sc, "the section", "alpha"); expect(p2.endsWith("drilldown-the-section-alpha-2.md")).toBe(true);
    writeFileSync(p2, "x");
    const p3 = resolveDrilldownPath(sc, "the section", "alpha"); expect(p3.endsWith("drilldown-the-section-alpha-3.md")).toBe(true);
  });
});

describe("design export-doc", () => {
  it("designExportDocPath composes <root>/docs/ap/specs/<basename>", () => {
    expect(designExportDocPath("/repo", "2026-06-01-x-design.md")).toBe(
      join("/repo", "docs", "ap", "specs", "2026-06-01-x-design.md"),
    );
  });

  it("exportDocTo copies the assembled doc into the specs dir and returns the dest", () => {
    const home = mkdtempSync(join(tmpdir(), "cs-home-"));
    const root = mkdtempSync(join(tmpdir(), "cs-root-"));
    process.env.AP_HOME = home;
    const ddir = join(designArtDir("export-topic"), "design-doc");
    mkdirSync(ddir, { recursive: true });
    writeFileSync(join(ddir, "2026-06-01-export-topic-design.md"), "# DOC\nbody\n");

    const dest = exportDocTo("export-topic", root);
    expect(dest).toBe(join(root, "docs", "ap", "specs", "2026-06-01-export-topic-design.md"));
    expect(existsSync(dest!)).toBe(true);
    expect(rf(dest!, "utf8")).toBe("# DOC\nbody\n");
  });

  it("exportDocTo returns null when no assembled doc exists", () => {
    const home = mkdtempSync(join(tmpdir(), "cs-home-"));
    const root = mkdtempSync(join(tmpdir(), "cs-root-"));
    process.env.AP_HOME = home;
    expect(exportDocTo("missing-topic", root)).toBeNull();
  });
});
