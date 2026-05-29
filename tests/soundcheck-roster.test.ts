import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { globalRoot } from "../src/core/paths.js";
import { run as soundcheck } from "../src/commands/soundcheck.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); process.env.CLAUDE_PLUGIN_ROOT = process.cwd(); });
afterEach(() => { env.cleanup(); });

function stageAvailable(lines: string[]): void {
  writeFileSync(join(globalRoot(), "providers-available.txt"), lines.join("\n") + (lines.length ? "\n" : ""));
}
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("soundcheck roster-plan", () => {
  it("emits validated detected + decision JSON", async () => {
    stageAvailable(["codex", "claude"]);
    const cap = captureStdout();
    const rc = await soundcheck(["roster-plan"]);
    cap.restore();
    expect(rc).toBe(0);
    const out = JSON.parse(cap.text());
    expect(out.detected).toEqual(["codex", "claude"]);
    expect(out.decision).toBe("prompt");
  });
  it("filters non-validated providers into skipped", async () => {
    stageAvailable(["codex", "fooai"]);
    const cap = captureStdout();
    await soundcheck(["roster-plan"]);
    cap.restore();
    const out = JSON.parse(cap.text());
    expect(out.detected).toEqual(["codex"]);
    expect(out.skipped).toEqual(["fooai (consult_validated: false)"]);
  });
});
