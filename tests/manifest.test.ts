import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

describe("plugin manifests (installability gate)", () => {
  const marketplace = read(".claude-plugin/marketplace.json");
  const plugin = read(".claude-plugin/plugin.json");
  const pkg = read("package.json");

  it("marketplace has a non-empty plugins array", () => {
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
  });

  it("each marketplace plugin source resolves to an existing directory", () => {
    for (const p of marketplace.plugins) {
      const dir = join(ROOT, p.source);
      expect(existsSync(dir), `source ${p.source} missing`).toBe(true);
      expect(statSync(dir).isDirectory(), `source ${p.source} not a dir`).toBe(true);
    }
  });

  it("plugin UserPromptSubmit hook references an existing dist/ap.cjs", () => {
    const cmd = plugin.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? "";
    expect(cmd).toContain("dist/ap.cjs");
    expect(existsSync(join(ROOT, "dist", "ap.cjs"))).toBe(true);
  });

  it("version is in sync across package.json, marketplace, and plugin manifests", () => {
    for (const p of marketplace.plugins) {
      expect(p.version, `marketplace ${p.name} version`).toBe(pkg.version);
    }
    expect(plugin.version).toBe(pkg.version);
  });

  it("plugin name is consistent (ap)", () => {
    expect(plugin.name).toBe("ap");
    expect(marketplace.plugins.some((p: any) => p.name === "ap")).toBe(true);
  });
});
