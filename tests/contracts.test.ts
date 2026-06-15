import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as K from "../src/core/contracts.js";

afterEach(() => { delete process.env.AP_HOME; });
function withContracts(yaml: string) {
  const h = mkdtempSync(join(tmpdir(), "ct-"));
  process.env.AP_HOME = h;
  writeFileSync(join(h, "contracts.yaml"), yaml);
  return h;
}
const SAMPLE = `
codex:
  binary: codex
  modes: { full: [--dangerously-bypass-approvals-and-sandbox], read-only: [--sandbox, read-only] }
  default_mode: full
  ready_timeout_s: 90
  bootstrap_sleep_s: 20
  consult_validated: true
claude:
  binary: claude
  modes: { full: [--permission-mode, auto] }
  ready_timeout_s: 60
  consult_validated: true
opencode:
  binary: opencode
  modes: { full: [-m, deepseek/deepseek-v4-pro] }
  ready_timeout_s: 60
  bootstrap_sleep_s: 15
  timeout_multiplier: 2.5
  consult_validated: false
consult:
  research_timeout_s: 600
  verify_timeout_s: 300
`;

describe("contracts", () => {
  it("listAgents: file order, excludes consult", () => {
    withContracts(SAMPLE);
    expect(K.listAgents()).toEqual(["codex", "claude", "opencode"]);
  });
  it("binary / default_mode / modeArgs", () => {
    withContracts(SAMPLE);
    expect(K.agentBinary("codex")).toBe("codex");
    expect(K.agentBinary("nope")).toBeUndefined();
    expect(K.agentModeArgs("codex", "read-only")).toEqual(["--sandbox", "read-only"]);
    expect(K.agentModeArgs("opencode", "full")).toEqual(["-m", "deepseek/deepseek-v4-pro"]);
  });
  it("readyTimeout default 30; bootstrapSleep claude=12 else 8", () => {
    withContracts(SAMPLE);
    expect(K.agentReadyTimeout("codex")).toBe(90);
    expect(K.agentReadyTimeout("claude")).toBe(60);
    expect(K.agentBootstrapSleep("codex")).toBe(20);
    expect(K.agentBootstrapSleep("claude")).toBe(12);   // absent → claude default 12
    expect(K.agentBootstrapSleep("opencode")).toBe(15);
    expect(K.agentBootstrapSleep("unknownx")).toBe(8);
  });
  it("timeoutMultiplier keeps string, bad→1.0", () => {
    withContracts(SAMPLE);
    expect(K.agentTimeoutMultiplier("opencode")).toBe("2.5");
    expect(K.agentTimeoutMultiplier("codex")).toBe("1.0");
  });
  it("consultValidated safe default false", () => {
    withContracts(SAMPLE);
    expect(K.agentConsultValidated("codex")).toBe(true);
    expect(K.agentConsultValidated("opencode")).toBe(false);
    expect(K.agentConsultValidated("absent")).toBe(false);
  });
  it("consultTimeout defaults + bad-kind throws", () => {
    withContracts(SAMPLE);
    expect(K.consultTimeout("research")).toBe(600);
    expect(K.consultTimeout("adversary")).toBe(600); // absent → default
    expect(K.consultTimeout("experiment")).toBe(1800);
    expect(() => K.consultTimeout("bogus" as any)).toThrow();
  });
});
