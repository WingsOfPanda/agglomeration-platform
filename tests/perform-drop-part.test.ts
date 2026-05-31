// tests/perform-drop-part.test.ts — T8: perform drop-part verb (proceed-degraded multi-repo path).
// drop-part rewrites parts.txt, removing one part's row by instrument and reporting the new N on
// stdout. Restores the clone-wars deploy "ship the rest" behavior when one sub-repo persistently
// fails. CONSORT_HOME temp; byte-exact parts.txt asserts; stdout N= capture.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { performArtDir } from "../src/core/perform.js";
import { run } from "../src/commands/perform.js";

const TOPIC = "multi-svc";

// capture process.stdout.write + process.stderr.write for the duration of fn().
async function capture(fn: () => Promise<number>): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

describe("perform drop-part", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("drops one row, rewrites parts.txt, reports N", async () => {
    const art = performArtDir(TOPIC); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "parts.txt"), "viola\t/a\tcodex\ncello\t/b\tcodex\n");
    const { rc, out } = await capture(() => run(["drop-part", TOPIC, "viola"]));
    expect(rc).toBe(0);
    expect(out).toContain("N=1");
    expect(readFileSync(join(art, "parts.txt"), "utf8")).toBe("cello\t/b\tcodex\n");
  });

  it("dropping the last remaining part leaves an empty parts.txt, reports N=0", async () => {
    const art = performArtDir(TOPIC); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "parts.txt"), "cello\t/b\tcodex\n");
    const { rc, out } = await capture(() => run(["drop-part", TOPIC, "cello"]));
    expect(rc).toBe(0);
    expect(out).toContain("N=0");
    expect(readFileSync(join(art, "parts.txt"), "utf8")).toBe("");
  });

  it("rc 1 when parts.txt is missing", async () => {
    const art = performArtDir(TOPIC); mkdirSync(art, { recursive: true });
    // no parts.txt written
    const { rc } = await capture(() => run(["drop-part", TOPIC, "viola"]));
    expect(rc).toBe(1);
  });

  it("rc 1 when the instrument is absent, parts.txt untouched", async () => {
    const art = performArtDir(TOPIC); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "parts.txt"), "cello\t/b\tcodex\n");
    const { rc } = await capture(() => run(["drop-part", TOPIC, "ghost"]));
    expect(rc).toBe(1);
    expect(readFileSync(join(art, "parts.txt"), "utf8")).toBe("cello\t/b\tcodex\n");
  });

  it("rc 2 on bad usage (missing instrument)", async () => {
    const { rc } = await capture(() => run(["drop-part", TOPIC]));
    expect(rc).toBe(2);
  });
});
