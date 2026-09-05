// tests/implement-slice-check.test.ts — the `slice-check` adapter: what it writes when the hub's
// grouping stands, what it records when it does not, and the two counts that take the serial path
// (2026-09-04-parallel-slices-design.md, B). The RULES themselves are pinned in
// tests/implement-slices.test.ts; this is the verb around them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { implementArtDir } from "../src/core/implement.js";
import { readSlices } from "../src/core/implementSlices.js";
import { sliceCheckWith, type SliceCheckDeps } from "../src/commands/implement.js";

const TOPIC = "add-oauth";
const PLAN = [
  "### T1: gate kind", "files: src/core/gate.ts", "depends: none",
  "### T2: shards", "files: src/train/shards.ts", "depends: T1",
  "### T3: planes", "files: src/model/planes.ts", "depends: T1",
  "## Slices", "prelude: T1", "slice: T2", "slice: T3",
].join("\n") + "\n";
const SLICE_PLAN = "# Slice plan\n## prelude\ntasks: T1\n## slice wp2\ntasks: T2\n## slice wp3\ntasks: T3\n";
/** The same three tasks with nothing depending on anything: an empty prelude still splits. */
const FLAT_PLAN = PLAN.replace("depends: T1", "depends: none").replace("depends: T1", "depends: none");

/** The art dir plus a run worktree that really holds the plan's files, so `MISSING=` (warn-only,
 *  and asserted on its own below) does not appear in the count lines every other case reads. */
function seed(plan = PLAN, slicePlan = SLICE_PLAN): string {
  const art = implementArtDir(TOPIC);
  mkdirSync(art, { recursive: true });
  const run = join(art, "run-worktree");
  for (const f of ["src/core/gate.ts", "src/train/shards.ts", "src/model/planes.ts"]) {
    mkdirSync(join(run, dirname(f)), { recursive: true });
    writeFileSync(join(run, f), "");
  }
  writeFileSync(join(art, "target_cwd.txt"), run + "\n");
  writeFileSync(join(art, "provider.txt"), "codex\n");
  writeFileSync(join(art, "plan.md"), plan);
  writeFileSync(join(art, "slice-plan.md"), slicePlan);
  return art;
}
const deps = (agents: string[] = ["bravo", "delta"]): SliceCheckDeps =>
  ({ agentsFor: (_t, n) => agents.slice(0, n), root: () => "/repo" });

async function check(d: SliceCheckDeps = deps()): Promise<{ rc: number; out: string }> {
  const cap = captureStdout();
  try { return { rc: await sliceCheckWith(TOPIC, d), out: cap.text() }; } finally { cap.restore(); }
}

describe("implement slice-check — the accepted grouping", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("writes the roster, one mandate per slice and prelude.txt, and prints the three counts", async () => {
    const art = seed();
    const { rc, out } = await check();
    expect(rc).toBe(0);
    expect(out).toBe("SLICES=2\nPRELUDE=1\nAGENTS=bravo,delta\n");
    expect(readSlices(join(art, "slices.tsv"))).toEqual([
      { agent: "bravo", model: "codex", label: "wp2", status: "planned", tasks: ["T2"], files: ["src/train/shards.ts"] },
      { agent: "delta", model: "codex", label: "wp3", status: "planned", tasks: ["T3"], files: ["src/model/planes.ts"] },
    ]);
    // The mandate names the task by TITLE and its files as absolute paths under THAT slice's tree.
    const mandate = readFileSync(join(art, "slice-bravo.md"), "utf8");
    expect(mandate).toContain("# Slice wp2");
    expect(mandate).toContain("- T2: shards");
    expect(mandate).toContain("/repo/.ap/worktrees/add-oauth.bravo/src/train/shards.ts");
    expect(readFileSync(join(art, "prelude.txt"), "utf8")).toBe("T1\n");
  });

  it("an empty prelude writes no prelude.txt and prints PRELUDE=0", async () => {
    const art = seed(FLAT_PLAN, "## slice wp1\ntasks: T1, T2\n## slice wp3\ntasks: T3\n");
    const { rc, out } = await check();
    expect(rc).toBe(0);
    expect(out).toContain("PRELUDE=0\n");
    expect(existsSync(join(art, "prelude.txt"))).toBe(false);
  });

  it("the roster's model is the run's provider.txt, whatever it says", async () => {
    const art = seed();
    writeFileSync(join(art, "provider.txt"), "claude\n");
    await check();
    expect(readSlices(join(art, "slices.tsv")).map((r) => r.model)).toEqual(["claude", "claude"]);
  });

  it("SLICES=1 and SLICES=0 are rc 0 — the directive takes the serial path", async () => {
    seed(PLAN.replace("slice: T2\nslice: T3", "slice: T2, T3"), "## prelude\ntasks: T1\n## slice all\ntasks: T2, T3\n");
    expect((await check()).out).toContain("SLICES=1\n");
    h.cleanup(); h = freshHome();
    seed(PLAN, "## prelude\ntasks: T1, T2, T3\n");
    const { rc, out } = await check();
    expect(rc).toBe(0);
    expect(out).toBe("SLICES=0\nPRELUDE=1\nAGENTS=\n");
  });
});

describe("implement slice-check — the refusal", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("prints every refusal, records them for the grill turn, and writes NO roster", async () => {
    // T2 depends on T1, which the hub left in another slice: the classic cross-slice dependency.
    const art = seed(PLAN, "## slice wp1\ntasks: T1\n## slice wp2\ntasks: T2\n## slice wp3\ntasks: T3\n");
    const { rc, out } = await check(deps(["bravo", "delta", "echo"]));
    expect(rc).toBe(1);
    expect(out).toContain("DEP=T2->T1\n");
    expect(out).toContain("DEP=T3->T1\n");
    expect(readFileSync(join(art, "slice-refusals.txt"), "utf8")).toBe("DEP=T2->T1\nDEP=T3->T1\n");
    expect(existsSync(join(art, "slices.tsv"))).toBe(false);
    expect(existsSync(join(art, "slice-bravo.md"))).toBe(false);
  });

  it("warns on a file the run worktree does not have, and still accepts the grouping", async () => {
    const art = seed();
    writeFileSync(join(art, "target_cwd.txt"), join(art, "empty-worktree") + "\n");
    const { rc, out } = await check();
    expect(rc).toBe(0);
    expect(out).toContain("MISSING=T1:src/core/gate.ts\n");
    expect(existsSync(join(art, "slices.tsv"))).toBe(true);
  });

  it("a live roster is not re-checked (pickAgents is random — it would rename live workers)", async () => {
    const art = seed();
    writeFileSync(join(art, "slices.tsv"), "bravo\tcodex\twp2\tspawned\tT2\tsrc/train/shards.ts\n");
    const { rc, out } = await check();
    expect(rc).toBe(1);
    expect(out).toBe("SLICES_EXIST\n");
    expect(readFileSync(join(art, "slices.tsv"), "utf8")).toContain("spawned");   // untouched
  });

  it("refuses rc 1 with no plan.md and with no slice-plan.md", async () => {
    const art = implementArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
    expect(await sliceCheckWith(TOPIC, deps())).toBe(1);
    writeFileSync(join(art, "plan.md"), PLAN);
    expect(await sliceCheckWith(TOPIC, deps())).toBe(1);
  });
});
