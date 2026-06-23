import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync as exists } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodePermissionCheck, run as check } from "../src/commands/check.js";

function cfg(content: string) {
  const f = join(mkdtempSync(join(tmpdir(), "oc-")), "opencode.json");
  writeFileSync(f, content);
  return f;
}

describe("opencode permission check (JSON.parse, not grep)", () => {
  it("allow → rc 0", () => { expect(opencodePermissionCheck(cfg(`{"permission":"allow"}`)).rc).toBe(0); });
  it("ask → rc 1 names value", () => { const r = opencodePermissionCheck(cfg(`{"permission":"ask"}`)); expect(r.rc).toBe(1); expect(r.message).toContain("'ask'"); });
  it("object form → rc 2", () => { expect(opencodePermissionCheck(cfg(`{"permission":{"bash":"allow"}}`)).rc).toBe(2); });
  it("nested per-agent only → rc 1 (no false positive)", () => { expect(opencodePermissionCheck(cfg(`{"agents":{"x":{"permission":"allow"}}}`)).rc).toBe(1); });
  it("mixed case Allow → rc 1", () => { expect(opencodePermissionCheck(cfg(`{"permission":"Allow"}`)).rc).toBe(1); });
  it("missing file → rc 1", () => { expect(opencodePermissionCheck("/nope/opencode.json").rc).toBe(1); });
});

describe("check ensures global config root", () => {
  it("does NOT copy config into ~/.ap (reads shipped instead)", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "sc-")), "nested-not-yet"); // does NOT exist
    const prev = process.env.AP_HOME; process.env.AP_HOME = home;
    process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
    try {
      await check([]);                                       // must not throw
      expect(exists(join(home, "contracts.yaml"))).toBe(false); // no longer auto-copied
      expect(exists(join(home, "agents.yaml"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AP_HOME; else process.env.AP_HOME = prev;
    }
  });
  it("migrateConfigShadow: a stale ~/.ap/contracts.yaml is backed up to .bak and removed", async () => {
    const home = mkdtempSync(join(tmpdir(), "mg-"));
    const prev = process.env.AP_HOME; process.env.AP_HOME = home;
    process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
    writeFileSync(join(home, "contracts.yaml"), "codex:\n  ready_timeout_s: 999\n"); // stale shadow
    try {
      await check([]);
      expect(exists(join(home, "contracts.yaml"))).toBe(false);    // shadow removed
      expect(exists(join(home, "contracts.yaml.bak"))).toBe(true); // backed up
    } finally {
      if (prev === undefined) delete process.env.AP_HOME; else process.env.AP_HOME = prev;
    }
  });
});
