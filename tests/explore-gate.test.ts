import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { exploreArtDir } from "../src/core/explore.js";
import { exploreWaitGateRun } from "../src/commands/explore.js";

describe("explore wait-gate (verb)", () => {
  let env: { home: string; cleanup: () => void };
  beforeEach(() => { env = freshHome(); });
  afterEach(() => { env.cleanup(); });

  function seedList(topic: string): string {
    const art = exploreArtDir(topic); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "list.txt"), "# generated\ncodex\talpha\nclaude\tcharlie\n");
    return art;
  }

  it("research phase (FS): rc 0 only when every worker terminal", async () => {
    const art = seedList("t");
    for (const inst of ["alpha", "charlie"]) {
      writeFileSync(join(art, `research-${inst}.txt`), "OFFSET=1\nFS=ok\n");
      writeFileSync(join(art, `research-${inst}.done`), "");
    }
    expect(await exploreWaitGateRun(["t", "research"])).toBe(0);
  });

  it("research phase: rc 1 when one worker is still pending (no .done)", async () => {
    const art = seedList("t");
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=1\nFS=ok\n");
    writeFileSync(join(art, "research-alpha.done"), "");
    expect(await exploreWaitGateRun(["t", "research"])).toBe(1);
  });

  it("adversary phase (AS): rc 1 when one worker's last line is a question", async () => {
    const art = seedList("t");
    writeFileSync(join(art, "adversary-alpha.txt"), "OFFSET=1\nAS=ok\n");
    writeFileSync(join(art, "adversary-alpha.done"), "");
    writeFileSync(join(art, "adversary-charlie.txt"), "OFFSET=2\nAS=question\n");
    writeFileSync(join(art, "adversary-charlie.done"), "");
    expect(await exploreWaitGateRun(["t", "adversary"])).toBe(1);
  });

  it("adversary phase: rc 0 when all terminal (AS=ok / AS=missing both count)", async () => {
    const art = seedList("t");
    writeFileSync(join(art, "adversary-alpha.txt"), "OFFSET=1\nAS=ok\n");
    writeFileSync(join(art, "adversary-alpha.done"), "");
    writeFileSync(join(art, "adversary-charlie.txt"), "OFFSET=2\nAS=missing\n");
    writeFileSync(join(art, "adversary-charlie.done"), "");
    expect(await exploreWaitGateRun(["t", "adversary"])).toBe(0);
  });

  it("openq phase (QS): rc 0 when all terminal — ok and skipped rows both count", async () => {
    const art = seedList("t");
    writeFileSync(join(art, "openq-alpha.txt"), "OFFSET=1\nQS=ok\n");
    writeFileSync(join(art, "openq-alpha.done"), "");
    writeFileSync(join(art, "openq-charlie.txt"), "QS=skipped\n");
    writeFileSync(join(art, "openq-charlie.done"), "");
    expect(await exploreWaitGateRun(["t", "openq"])).toBe(0);
  });

  it("openq phase: rc 1 while one worker is pending (no .done) or in question", async () => {
    const art = seedList("t");
    writeFileSync(join(art, "openq-alpha.txt"), "OFFSET=1\nQS=ok\n");
    writeFileSync(join(art, "openq-alpha.done"), "");
    writeFileSync(join(art, "openq-charlie.txt"), "OFFSET=2\n"); // pending: no QS line, no .done
    expect(await exploreWaitGateRun(["t", "openq"])).toBe(1);
    writeFileSync(join(art, "openq-charlie.txt"), "OFFSET=2\nQS=question\n");
    writeFileSync(join(art, "openq-charlie.done"), "");
    expect(await exploreWaitGateRun(["t", "openq"])).toBe(1); // question is not terminal
  });

  it("crossverify phase (VS): skipped and ok rows both terminal → rc 0", async () => {
    const art = seedList("t");
    writeFileSync(join(art, "crossverify-alpha.txt"), "OFFSET=1\nVS=ok\n");
    writeFileSync(join(art, "crossverify-alpha.done"), "");
    writeFileSync(join(art, "crossverify-charlie.txt"), "VS=skipped\n");
    writeFileSync(join(art, "crossverify-charlie.done"), "");
    expect(await exploreWaitGateRun(["t", "crossverify"])).toBe(0);
  });

  it("rebuttal phase (RS): rc 1 while pending or in question", async () => {
    const art = seedList("t");
    writeFileSync(join(art, "rebuttal-alpha.txt"), "OFFSET=1\nRS=ok\n");
    writeFileSync(join(art, "rebuttal-alpha.done"), "");
    writeFileSync(join(art, "rebuttal-charlie.txt"), "OFFSET=2\n"); // pending
    expect(await exploreWaitGateRun(["t", "rebuttal"])).toBe(1);
    writeFileSync(join(art, "rebuttal-charlie.txt"), "OFFSET=2\nRS=question\n");
    writeFileSync(join(art, "rebuttal-charlie.done"), "");
    expect(await exploreWaitGateRun(["t", "rebuttal"])).toBe(1); // question is not terminal
  });

  it("gap phase (GS): rc 0 when all terminal (ok / timeout / skipped)", async () => {
    const art = seedList("t");
    writeFileSync(join(art, "gap-alpha.txt"), "OFFSET=1\nGS=timeout\n");
    writeFileSync(join(art, "gap-alpha.done"), "");
    writeFileSync(join(art, "gap-charlie.txt"), "GS=skipped\n");
    writeFileSync(join(art, "gap-charlie.done"), "");
    expect(await exploreWaitGateRun(["t", "gap"])).toBe(0);
  });

  it("bad/absent phase and missing list → rc 2", async () => {
    expect(await exploreWaitGateRun(["t"])).toBe(2);
    expect(await exploreWaitGateRun(["t", "verify"])).toBe(2);
    expect(await exploreWaitGateRun(["t", "research"])).toBe(2);
  });
});
