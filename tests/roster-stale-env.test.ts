import { describe, it, expect, afterEach } from "vitest";
import { classifyStale } from "../src/commands/roster.js";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// guards the threshold semantics the roster call-site must pass through from the env
const ORIG = process.env.CONSORT_STALE_THRESHOLD_S;
afterEach(() => { if (ORIG === undefined) delete process.env.CONSORT_STALE_THRESHOLD_S; else process.env.CONSORT_STALE_THRESHOLD_S = ORIG; });

function agedOutbox(ageSec: number): string {
  const f = join(mkdtempSync(join(tmpdir(), "ob-")), "outbox.jsonl");
  writeFileSync(f, "{}\n");
  const t = Date.now() / 1000 - ageSec; utimesSync(f, t, t);
  return f;
}

describe("classifyStale honors a custom threshold (L11 semantics)", () => {
  it("a 300s-old working part is 'working' under a 600 threshold but 'stale' under 180", () => {
    const ob = agedOutbox(300);
    expect(classifyStale("working", ob, 600)).toBe("working");
    expect(classifyStale("working", ob, 180)).toBe("stale");
  });
});
