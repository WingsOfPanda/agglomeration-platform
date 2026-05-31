// tests/perform-verify-dag-repos.test.ts — T9: perform verify-dag-repos verb (prose-DAG rescue check).
// Pure verb: reads the topic's design.md, extracts the DAG repo slugs (dagSectionBody + parseDagLine),
// and reports per-slug `ok | missing-dir | missing-marker` against <hub>/<slug>. A repo is ok iff the
// dir exists AND has CLAUDE.md or AGENTS.md. rc 1 if any slug is bad, else 0. CONSORT_HOME temp; the
// freshHome home doubles as the --cwd hub. parseDagLine requires an em-dash separator (U+2014).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { performArtDir } from "../src/core/perform.js";
import { run } from "../src/commands/perform.js";

const TOPIC = "svc";

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

describe("perform verify-dag-repos", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("reports ok / missing-dir / missing-marker per slug", async () => {
    const art = performArtDir(TOPIC); mkdirSync(art, { recursive: true });
    // parseDagLine needs an em-dash separator; "alpha"/"beta" parse as node.repo.
    writeFileSync(join(art, "design.md"), "## Execution DAG\n1. alpha — first\n2. beta — second\n");
    const hub = h.home;                                   // the freshHome home doubles as the hub
    mkdirSync(join(hub, "alpha"), { recursive: true });
    writeFileSync(join(hub, "alpha", "CLAUDE.md"), "x");  // alpha = ok (dir + marker)
    mkdirSync(join(hub, "beta"), { recursive: true });    // beta = missing-marker (dir, no CLAUDE/AGENTS)
    // gamma is NOT in the DAG, so it is not checked
    const { rc, out } = await capture(() => run(["verify-dag-repos", TOPIC, "--cwd", hub]));
    expect(rc).toBe(1);                                   // beta is bad
    expect(out).toContain("REPO=alpha\tSTATUS=ok");
    expect(out).toContain("REPO=beta\tSTATUS=missing-marker");
  });

  it("reports missing-dir when the slug dir is absent and rc 1", async () => {
    const art = performArtDir(TOPIC); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "design.md"), "## Execution DAG\n1. alpha — first\n");
    const hub = h.home;                                   // no alpha/ dir created
    const { rc, out } = await capture(() => run(["verify-dag-repos", TOPIC, "--cwd", hub]));
    expect(rc).toBe(1);
    expect(out).toContain("REPO=alpha\tSTATUS=missing-dir");
  });

  it("rc 0 when every slug is ok (AGENTS.md also counts as a marker)", async () => {
    const art = performArtDir(TOPIC); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "design.md"), "## Execution DAG\n1. alpha — first\n2. beta — second\n");
    const hub = h.home;
    mkdirSync(join(hub, "alpha"), { recursive: true });
    writeFileSync(join(hub, "alpha", "CLAUDE.md"), "x");
    mkdirSync(join(hub, "beta"), { recursive: true });
    writeFileSync(join(hub, "beta", "AGENTS.md"), "x");   // AGENTS.md is also a valid marker
    const { rc, out } = await capture(() => run(["verify-dag-repos", TOPIC, "--cwd", hub]));
    expect(rc).toBe(0);
    expect(out).toContain("REPO=alpha\tSTATUS=ok");
    expect(out).toContain("REPO=beta\tSTATUS=ok");
  });

  it("--cwd=<hub> equals form is accepted", async () => {
    const art = performArtDir(TOPIC); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "design.md"), "## Execution DAG\n1. alpha — first\n");
    const hub = h.home;
    mkdirSync(join(hub, "alpha"), { recursive: true });
    writeFileSync(join(hub, "alpha", "AGENTS.md"), "x");
    const { rc, out } = await capture(() => run(["verify-dag-repos", TOPIC, `--cwd=${hub}`]));
    expect(rc).toBe(0);
    expect(out).toContain("REPO=alpha\tSTATUS=ok");
  });

  it("rc 1 when design.md is missing", async () => {
    const art = performArtDir(TOPIC); mkdirSync(art, { recursive: true });
    // no design.md written
    const { rc } = await capture(() => run(["verify-dag-repos", TOPIC, "--cwd", h.home]));
    expect(rc).toBe(1);
  });

  it("rc 2 on bad usage (missing topic)", async () => {
    const { rc } = await capture(() => run(["verify-dag-repos"]));
    expect(rc).toBe(2);
  });
});
