import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function freshHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "ap-test-"));
  process.env.AP_HOME = home;
  return { home, cleanup: () => { delete process.env.AP_HOME; rmSync(home, { recursive: true, force: true }); } };
}
