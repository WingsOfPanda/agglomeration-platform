import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as K from "../src/core/contracts.js";

afterEach(() => { delete process.env.CONSORT_HOME; });
function withContracts(yaml: string) {
  const h = mkdtempSync(join(tmpdir(), "ct-"));
  process.env.CONSORT_HOME = h;
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
  it("listInstruments: file order, excludes consult", () => {
    withContracts(SAMPLE);
    expect(K.listInstruments()).toEqual(["codex", "claude", "opencode"]);
  });
  it("binary / default_mode / modeArgs", () => {
    withContracts(SAMPLE);
    expect(K.instrumentBinary("codex")).toBe("codex");
    expect(K.instrumentBinary("nope")).toBeUndefined();
    expect(K.instrumentModeArgs("codex", "read-only")).toEqual(["--sandbox", "read-only"]);
    expect(K.instrumentModeArgs("opencode", "full")).toEqual(["-m", "deepseek/deepseek-v4-pro"]);
  });
  it("readyTimeout default 30; bootstrapSleep claude=12 else 8", () => {
    withContracts(SAMPLE);
    expect(K.instrumentReadyTimeout("codex")).toBe(90);
    expect(K.instrumentReadyTimeout("claude")).toBe(60);
    expect(K.instrumentBootstrapSleep("codex")).toBe(20);
    expect(K.instrumentBootstrapSleep("claude")).toBe(12);   // absent → claude default 12
    expect(K.instrumentBootstrapSleep("opencode")).toBe(15);
    expect(K.instrumentBootstrapSleep("unknownx")).toBe(8);
  });
  it("timeoutMultiplier keeps string, bad→1.0", () => {
    withContracts(SAMPLE);
    expect(K.instrumentTimeoutMultiplier("opencode")).toBe("2.5");
    expect(K.instrumentTimeoutMultiplier("codex")).toBe("1.0");
  });
  it("consultValidated safe default false", () => {
    withContracts(SAMPLE);
    expect(K.instrumentConsultValidated("codex")).toBe(true);
    expect(K.instrumentConsultValidated("opencode")).toBe(false);
    expect(K.instrumentConsultValidated("absent")).toBe(false);
  });
  it("consultTimeout defaults + bad-kind throws", () => {
    withContracts(SAMPLE);
    expect(K.consultTimeout("research")).toBe(600);
    expect(K.consultTimeout("adversary")).toBe(600); // absent → default
    expect(K.consultTimeout("experiment")).toBe(1800);
    expect(() => K.consultTimeout("bogus" as any)).toThrow();
  });
});
