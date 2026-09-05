// tests/implement-spawn-slices.test.ts — the fan-out (2026-09-04-parallel-slices-design.md, C / D):
// the worktree arg arrays, the fail-closed refusals, `--retry` reuse, the sequential order, the
// rc-3 retry and the codex->claude fallback — all over a fake `Runner` and a scripted `spawn`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { implementArtDir } from "../src/core/implement.js";
import { outboxPath } from "../src/core/ipc.js";
import { jobPath, formatJob, type JobRecord } from "../src/core/job.js";
import { readSlices, writeSlices, type AbandonReason, type SliceRow } from "../src/core/implementSlices.js";
import type { Runner } from "../src/core/gitwork.js";
import { abandonSliceWith, liveSpawnSlicesDeps, run, spawnSlicesWith, type SpawnSlicesAdapterDeps } from "../src/commands/implement.js";

const TOPIC = "add-oauth";
/** The MAIN checkout, a real temp path per test so an existing slice tree can be staged on disk. */
let ROOT = "/repo";
const TREE = (agent: string): string => join(ROOT, ".ap", "worktrees", `${TOPIC}.${agent}`);
const BRANCH = (agent: string): string => `feat/implement-${TOPIC}-${agent}`;

const REC: JobRecord = {
  command: "implement", topic: TOPIC, session: "ap-add-oauth",
  hub: { agent: "alpha", model: "claude" }, provider: "codex", finish: "keep",
  budget_hours: 6, max_rounds: 5, args_file: "/tmp/args", started: "2026-09-04T00:00:00Z",
  worktree: "/repo/.ap/worktrees/add-oauth",
};
const planned = (...agents: string[]): SliceRow[] =>
  agents.map((agent, i) => ({ agent, model: "codex", label: `wp${i}`, status: "planned", tasks: [`T${i}`], files: [`f${i}.ts`] }));

function seed(rows: SliceRow[], rec: JobRecord | null = REC): string {
  const art = implementArtDir(TOPIC);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "target_cwd.txt"), "/run\n");
  writeSlices(join(art, "slices.tsv"), rows);
  if (rec) { mkdirSync(dirname(jobPath(TOPIC)), { recursive: true }); writeFileSync(jobPath(TOPIC), formatJob(rec)); }
  return art;
}
/** A worker dir for `agent`, as a spawn that died past the stamp arm leaves one. */
function seedWorkerDir(agent: string, model = "codex"): void {
  const outbox = outboxPath(agent, model, TOPIC);
  mkdirSync(dirname(outbox), { recursive: true });
  writeFileSync(outbox, "");
  writeFileSync(join(dirname(outbox), "pane.json"), JSON.stringify({ pane_id: "%1", pane_nonce: "n", agent, model }) + "\n");
}

interface Script {
  /** rc per `spawn` call, in order; the default is 0. */
  spawnRcs?: number[];
  /** git answers keyed by joined argv. */
  git?: Record<string, { code?: number; stdout?: string }>;
  /** rows of the hub's window; the default is the 100 a detached session is created with. */
  windowRows?: number;
  /** paths `existsSync` should already see (the worktrees `--retry` reuses). */
}
interface Recorded {
  git: string[][]; spawns: string[][]; stops: string[]; provisions: string[]; flags: string[];
  /** `add:<agent>` / `spawn-start:<agent>` / `spawn-end:<agent>` / `layout` in the order they
   *  happened — the sequentiality gate. Both spawn EDGES, because a single `spawn:` mark cannot
   *  tell a loop from a `Promise.all`: every iteration's synchronous prefix runs before any of them
   *  suspends. */
  order: string[];
}

function mk(s: Script = {}): { deps: SpawnSlicesAdapterDeps; rec: Recorded } {
  const rec: Recorded = { git: [], spawns: [], stops: [], provisions: [], flags: [], order: [] };
  const rcs = [...(s.spawnRcs ?? [])];
  const runner = (tag: string): Runner => ({
    run(cmd, args) {
      rec.git.push([tag, cmd, ...args]);
      if (args[0] === "worktree") rec.order.push(`add:${args[4].split("/").at(-1)!.split(".").at(-1)}`);
      const a = s.git?.[args.join(" ")];
      return { code: a?.code ?? 0, stdout: a?.stdout ?? "" };
    },
  });
  const deps: SpawnSlicesAdapterDeps = (topic, _root, _runCwd) => ({
    root: ROOT, rootRunner: runner("root"), runRunner: runner("run"),
    windowRows: async () => s.windowRows ?? 100,
    layout: async () => { rec.order.push("layout"); },
    spawn: async (argv) => {
      rec.spawns.push(argv);
      rec.order.push(`spawn-start:${argv[0]}`);
      await Promise.resolve(); await Promise.resolve();   // a real spawn suspends; a fake that never does hides concurrency
      rec.order.push(`spawn-end:${argv[0]}`);
      return rcs.length ? rcs.shift()! : 0;
    },
    stop: async (agent) => { rec.stops.push(`${agent} ${topic}`); return 0; },
    provision: (w) => { rec.provisions.push(w); },
    flag: (n) => { rec.flags.push(n); },
  });
  return { deps, rec };
}
const HEAD = { "rev-parse HEAD": { stdout: "abc123\n" } };

async function spawnIt(retry = false, s: Script = {}): Promise<{ rc: number; out: string; rec: Recorded }> {
  const { deps, rec } = mk({ ...s, git: { ...HEAD, ...(s.git ?? {}) } });
  const cap = captureStdout();
  try { return { rc: await spawnSlicesWith(TOPIC, retry, deps), out: cap.text(), rec }; } finally { cap.restore(); }
}

describe("implement spawn-slices — the refusals (nothing is spawned)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); ROOT = join(h.home, "repo"); });
  afterEach(() => { h.cleanup(); });

  it("rc 2 with no job record: slices are detached-only", async () => {
    seed(planned("bravo"), null);
    const { rc, rec } = await spawnIt();
    expect(rc).toBe(2);
    expect(rec.spawns).toEqual([]);
  });

  it("rc 2 on a --no-worktree job: a slice never forks the operator's live checkout", async () => {
    seed(planned("bravo"), { ...REC, worktree: "" });
    const { rc, rec } = await spawnIt();
    expect(rc).toBe(2);
    expect(rec.spawns).toEqual([]);
  });

  it("rc 1 with a DIRTY= line per modified tracked file in the run worktree", async () => {
    seed(planned("bravo"));
    const { rc, out, rec } = await spawnIt(false, { git: { "status --porcelain -z --untracked-files=no": { stdout: " M a.ts\0M  b.ts\0" } } });
    expect(rc).toBe(1);
    expect(out).toBe("DIRTY=a.ts\nDIRTY=b.ts\n");
    expect(rec.spawns).toEqual([]);
  });

  it("rc 1 when a PLANNED row's branch already exists — and the OTHER row is not spawned either", async () => {
    const art = seed(planned("bravo", "delta"));
    const { rc, out, rec } = await spawnIt(false, {
      git: { [`rev-parse --verify refs/heads/${BRANCH("bravo")}`]: { stdout: "deadbee\n" } },
    });
    expect(rc).toBe(1);
    expect(out).toBe("SLICE_BRANCH_EXISTS=bravo\n");
    expect(rec.spawns).toEqual([]);
    expect(readSlices(join(art, "slices.tsv")).map((r) => r.status)).toEqual(["planned", "planned"]);
  });

  it("--retry refuses a reused row whose tree was removed while its branch survived", async () => {
    // `git worktree add -b <branch>` is FATAL against a branch that already exists, so this half-
    // cleared state has to be refused before the loop, not discovered inside it.
    const art = seed([{ ...planned("bravo")[0], status: "failed-spawn" }]);
    writeFileSync(join(art, "slice-fork.txt"), "abc123\n");
    const { rc, out } = await spawnIt(true, {
      git: { [`rev-parse --verify refs/heads/${BRANCH("bravo")}`]: { stdout: "abc123\n" } },
    });
    expect(rc).toBe(1);
    expect(out).toBe("SLICE_TREE_MOVED=bravo\n");
  });

  it("--retry refuses a reused row whose tree survived without its branch", async () => {
    const art = seed([{ ...planned("bravo")[0], status: "failed-spawn" }]);
    writeFileSync(join(art, "slice-fork.txt"), "abc123\n");
    mkdirSync(TREE("bravo"), { recursive: true });
    const { rc, out } = await spawnIt(true);
    expect(rc).toBe(1);
    expect(out).toBe("SLICE_TREE_MOVED=bravo\n");
  });

  it("rc 1 when the hub's window cannot hold the lead plus every slice at 8 rows", async () => {
    const art = seed(planned("bravo", "delta", "echo"));
    const { rc, out, rec } = await spawnIt(false, { windowRows: 30 });   // need = 4*8 + 3
    expect(rc).toBe(1);
    expect(out).toBe("WINDOW_TOO_SMALL=rows=30,need=35\n");
    expect(rec.git.filter((c) => c[2] === "worktree")).toEqual([]);
    expect(rec.provisions).toEqual([]);
    expect(rec.spawns).toEqual([]);
    expect(readSlices(join(art, "slices.tsv")).map((r) => r.status)).toEqual(["planned", "planned", "planned"]);
  });

  it("--retry refuses a reused branch that has moved off the recorded fork sha", async () => {
    const art = seed([{ ...planned("bravo")[0], status: "failed-spawn" }]);
    writeFileSync(join(art, "slice-fork.txt"), "abc123\n");
    const { rc, out, rec } = await spawnIt(true, {
      git: { [`rev-parse --verify refs/heads/${BRANCH("bravo")}`]: { stdout: "0ther99\n" } },
    });
    expect(rc).toBe(1);
    expect(out).toBe("SLICE_TREE_MOVED=bravo\n");
    expect(rec.spawns).toEqual([]);
  });
});

describe("implement spawn-slices — the loop", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); ROOT = join(h.home, "repo"); });
  afterEach(() => { h.cleanup(); });

  it("one worktree per slice off the run's HEAD, provisioned, then spawned with --role slice", async () => {
    const art = seed(planned("bravo", "delta"));
    const { rc, out, rec } = await spawnIt();
    expect(rc).toBe(0);
    expect(out).toBe("SPAWNED=2\nFALLBACK=\nFAILED=\n");
    // The `add` runs through the runner bound to the MAIN root; HEAD is read in the RUN worktree.
    expect(rec.git.filter((c) => c[2] === "worktree")).toEqual([
      ["root", "git", "worktree", "add", "-b", BRANCH("bravo"), TREE("bravo"), "abc123"],
      ["root", "git", "worktree", "add", "-b", BRANCH("delta"), TREE("delta"), "abc123"],
    ]);
    expect(rec.git.find((c) => c[3] === "HEAD")?.[0]).toBe("run");
    expect(rec.provisions).toEqual([TREE("bravo"), TREE("delta")]);
    // No `--session`: the verb runs inside the hub's session, so spawn splits the hub's own window.
    expect(rec.spawns).toEqual([
      ["bravo", "codex", TOPIC, "--role", "slice", "--cwd", TREE("bravo")],
      ["delta", "codex", TOPIC, "--role", "slice", "--cwd", TREE("delta")],
    ]);
    expect(readSlices(join(art, "slices.tsv")).map((r) => r.status)).toEqual(["spawned", "spawned"]);
    expect(readFileSync(join(art, "slice-fork.txt"), "utf8")).toBe("abc123\n");
  });

  it("spawns ONE AT A TIME: a slice's tree is made and its pane spawned before the next starts", async () => {
    seed(planned("bravo", "delta", "echo"));
    const { rec } = await spawnIt();
    // No INTERLEAVING: each spawn ends before the next row's worktree is made (D12 — six codex
    // bootstraps at once on a loaded box is the failure this ordering exists to prevent).
    expect(rec.order).toEqual([
      "add:bravo", "spawn-start:bravo", "spawn-end:bravo", "layout",
      "add:delta", "spawn-start:delta", "spawn-end:delta", "layout",
      "add:echo", "spawn-start:echo", "spawn-end:echo", "layout",
    ]);
  });

  it("a window tmux cannot measure does NOT refuse — an unreadable height is not a small window", async () => {
    seed(planned("bravo", "delta"));
    const { rc, out, rec } = await spawnIt(false, { windowRows: 0 });
    expect(rc).toBe(0);
    expect(out).toBe("SPAWNED=2\nFALLBACK=\nFAILED=\n");
    expect(rec.spawns.map((a) => a[0])).toEqual(["bravo", "delta"]);
  });

  it("re-lays the window after each pane that CAME UP, and never after one that did not", async () => {
    seed(planned("bravo", "delta"));
    const { rec } = await spawnIt(false, { spawnRcs: [0, 1] });
    expect(rec.order).toEqual([
      "add:bravo", "spawn-start:bravo", "spawn-end:bravo", "layout",
      "add:delta", "spawn-start:delta", "spawn-end:delta",
    ]);
  });

  it("a cold-start retry re-lays ONCE, after the attempt that came up", async () => {
    seed(planned("bravo"));
    const { rec } = await spawnIt(false, { spawnRcs: [3, 0] });
    expect(rec.order.filter((o) => o === "layout")).toEqual(["layout"]);
    expect(rec.order.at(-1)).toBe("layout");
  });

  it("rc 3 buys ONE retry of the same spawn; a second rc 3 on codex falls back to claude", async () => {
    const art = seed(planned("bravo"));
    const { rc, out, rec } = await spawnIt(false, { spawnRcs: [3, 3, 0] });
    expect(rc).toBe(0);
    expect(out).toBe("SPAWNED=1\nFALLBACK=bravo\nFAILED=\n");
    expect(rec.spawns.map((a) => a[1])).toEqual(["codex", "codex", "claude"]);
    expect(rec.flags).toEqual(["slice-provider-fallback: bravo codex->claude"]);
    // The row's MODEL is rewritten, so every later turn verb addresses the claude worker dir.
    expect(readSlices(join(art, "slices.tsv"))[0]).toMatchObject({ model: "claude", status: "spawned" });
  });

  it("claude dying twice as well is failed-spawn, and the run's provider.txt is never touched", async () => {
    const art = seed(planned("bravo"));
    writeFileSync(join(art, "provider.txt"), "codex\n");
    const { rc, out, rec } = await spawnIt(false, { spawnRcs: [3, 3, 3, 3] });
    expect(rc).toBe(2);
    // FALLBACK= is empty: the switch to claude happened (flag + roster model) but nothing came up.
    expect(out).toBe("SPAWNED=0\nFALLBACK=\nFAILED=bravo\n");
    expect(rec.flags).toEqual(["slice-provider-fallback: bravo codex->claude"]);
    expect(readSlices(join(art, "slices.tsv"))[0].model).toBe("claude");
    expect(rec.spawns.length).toBe(4);
    expect(readSlices(join(art, "slices.tsv"))[0].status).toBe("failed-spawn");
    expect(readFileSync(join(art, "provider.txt"), "utf8")).toBe("codex\n");
  });

  it("any other non-zero rc is failed-spawn with NO retry and NO fallback", async () => {
    const art = seed(planned("bravo"));
    const { rc, rec } = await spawnIt(false, { spawnRcs: [1] });
    expect(rc).toBe(2);
    expect(rec.spawns.length).toBe(1);
    expect(rec.flags).toEqual([]);
    expect(readSlices(join(art, "slices.tsv"))[0]).toMatchObject({ model: "codex", status: "failed-spawn" });
  });

  it("a spawn that THROWS is recorded failed-spawn and the loop carries on to the next slice", async () => {
    const art = seed(planned("bravo", "delta"));
    const { deps, rec } = mk({ git: HEAD });
    const wrapped: SpawnSlicesAdapterDeps = (...a) => {
      const d = deps(...a);
      return { ...d, spawn: async (argv) => { if (argv[0] === "bravo") throw new Error("spawn_error"); return d.spawn(argv); } };
    };
    const cap = captureStdout();
    let rc: number;
    try { rc = await spawnSlicesWith(TOPIC, false, wrapped); } finally { cap.restore(); }
    expect(rc).toBe(1);   // partial
    expect(cap.text()).toBe("SPAWNED=1\nFALLBACK=\nFAILED=bravo\n");
    expect(readSlices(join(art, "slices.tsv")).map((r) => r.status)).toEqual(["failed-spawn", "spawned"]);
    expect(rec.spawns.map((s) => s[0])).toEqual(["delta"]);
  });

  it("a failed `worktree add` is failed-spawn: nothing is provisioned and nothing is spawned", async () => {
    const art = seed(planned("bravo"));
    const { rc, rec } = await spawnIt(false, { git: { [`worktree add -b ${BRANCH("bravo")} ${TREE("bravo")} abc123`]: { code: 128 } } });
    expect(rc).toBe(2);
    expect(rec.provisions).toEqual([]);
    expect(rec.spawns).toEqual([]);
    expect(readSlices(join(art, "slices.tsv"))[0].status).toBe("failed-spawn");
  });

  it("--retry tears down a leftover worker dir before re-spawning (agentInUse would refuse it)", async () => {
    const art = seed([{ ...planned("bravo")[0], status: "failed-spawn" }]);
    writeFileSync(join(art, "slice-fork.txt"), "abc123\n");
    seedWorkerDir("bravo");
    const { rc, rec } = await spawnIt(true);
    expect(rc).toBe(0);
    expect(rec.stops).toEqual([`bravo ${TOPIC}`]);
    expect(readSlices(join(art, "slices.tsv"))[0].status).toBe("spawned");
  });

  it("without --retry a failed-spawn row is left alone — and rc 2 says nothing is up (D3)", async () => {
    const art = seed([{ ...planned("bravo")[0], status: "failed-spawn" }]);
    const { rc, out, rec } = await spawnIt(false);
    expect(rc).toBe(2);            // nothing attempted AND no row is spawned: the serial-path cue
    expect(out).toBe("SPAWNED=0\nFALLBACK=\nFAILED=\n");
    expect(rec.spawns).toEqual([]);
    expect(readSlices(join(art, "slices.tsv"))[0].status).toBe("failed-spawn");
  });

  it("a re-run over a wave that IS up attempts nothing and is rc 0, not the serial-path cue", async () => {
    seed([{ ...planned("bravo")[0], status: "spawned" }, { ...planned("delta")[0], status: "failed-spawn" }]);
    const { rc, rec } = await spawnIt(false);
    expect(rc).toBe(0);
    expect(rec.spawns).toEqual([]);
  });

  it("a partial wave is rc 1 and a wave where nothing came up is rc 2 (the serial-path cue)", async () => {
    seed(planned("bravo", "delta"));
    expect((await spawnIt(false, { spawnRcs: [0, 1] })).rc).toBe(1);
    h.cleanup(); h = freshHome();
    seed(planned("bravo", "delta"));
    expect((await spawnIt(false, { spawnRcs: [1, 1] })).rc).toBe(2);
  });

  it("--retry after a `worktree add` that never ran (no tree, no branch) forks afresh", async () => {
    const art = seed([{ ...planned("bravo")[0], status: "failed-spawn" }]);
    writeFileSync(join(art, "slice-fork.txt"), "abc123\n");
    const { rc, rec } = await spawnIt(true);
    expect(rc).toBe(0);
    expect(rec.git.filter((c) => c[2] === "worktree")).toEqual([
      ["root", "git", "worktree", "add", "-b", BRANCH("bravo"), TREE("bravo"), "abc123"],
    ]);
  });

  it("an existing tree under --retry is REUSED: no second worktree add, no re-provision", async () => {
    const art = seed([{ ...planned("bravo")[0], status: "failed-spawn" }]);
    writeFileSync(join(art, "slice-fork.txt"), "abc123\n");
    mkdirSync(TREE("bravo"), { recursive: true });
    // The realistic reuse state is the PAIR the first pass left: the tree AND its branch, at the fork sha.
    const { rc, rec } = await spawnIt(true, { git: { [`rev-parse --verify refs/heads/${BRANCH("bravo")}`]: { stdout: "abc123\n" } } });
    expect(rc).toBe(0);
    expect(rec.git.filter((c) => c[2] === "worktree")).toEqual([]);
    expect(rec.provisions).toEqual([]);
    expect(rec.order).toEqual(["spawn-start:bravo", "spawn-end:bravo", "layout"]);
  });
});

describe("implement abandon-slice", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); ROOT = join(h.home, "repo"); });
  afterEach(() => { h.cleanup(); });

  async function abandon(agent: string, reason: string): Promise<{ rc: number; out: string; stops: string[] }> {
    const stops: string[] = [];
    const cap = captureStdout();
    try {
      const rc = await abandonSliceWith(TOPIC, agent, reason as AbandonReason, { stop: async (a, t) => { stops.push(`${a} ${t}`); return 0; } });
      return { rc, out: cap.text(), stops };
    } finally { cap.restore(); }
  }

  it("a SPAWNED row is torn down per agent and recorded abandoned:<reason>", async () => {
    const art = seed([{ ...planned("bravo")[0], status: "spawned" }, ...planned("delta")]);
    const { rc, out, stops } = await abandon("bravo", "turn-failed");
    expect(rc).toBe(0);
    expect(out).toBe("ABANDONED=bravo\nREASON=turn-failed\n");
    expect(stops).toEqual([`bravo ${TOPIC}`]);
    const rows = readSlices(join(art, "slices.tsv"));
    expect(rows.map((r) => r.status)).toEqual(["abandoned:turn-failed", "planned"]);   // only that row moves
  });

  it("a row that never got a pane is recorded WITHOUT a teardown", async () => {
    const art = seed([{ ...planned("bravo")[0], status: "failed-spawn" }]);
    const { rc, stops } = await abandon("bravo", "spawn-failed");
    expect(rc).toBe(0);
    expect(stops).toEqual([]);
    expect(readSlices(join(art, "slices.tsv"))[0].status).toBe("abandoned:spawn-failed");
  });

  it("rc 1 for an agent with no roster row, and rc 2 for a reason outside the closed set", async () => {
    seed(planned("bravo"));
    expect((await abandon("echo", "turn-failed")).rc).toBe(1);
    expect(await run(["abandon-slice", TOPIC, "bravo", "gave-up"])).toBe(2);
    expect(await run(["abandon-slice", TOPIC, "bravo"])).toBe(2);
  });
});

describe("liveSpawnSlicesDeps — the wiring every other test replaces with a fake", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("binds rootRunner to the MAIN root, runRunner to the run worktree, and provisions FROM the root", () => {
    // The hazard C names: a runner bound to the wrong cwd forks the wrong HEAD, and a
    // `provisionWorktree` given the run worktree instead of the main checkout silently drops the
    // shadow/pin report. Nothing in the core can see it — the core takes whatever adapter it is given.
    const root = join(h.home, "main"), runCwd = join(h.home, "run"), tree = join(h.home, "slice");
    for (const d of [root, runCwd, tree]) mkdirSync(d, { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "marker.txt"), "main\n");
    writeFileSync(join(root, "id.txt"), "root\n");
    writeFileSync(join(runCwd, "id.txt"), "run\n");

    const d = liveSpawnSlicesDeps(TOPIC, root, runCwd);
    expect(d.root).toBe(root);
    expect(typeof d.windowRows).toBe("function");
    expect(typeof d.layout).toBe("function");
    expect(d.rootRunner.run("cat", ["id.txt"]).stdout).toBe("root\n");
    expect(d.runRunner.run("cat", ["id.txt"]).stdout).toBe("run\n");
    d.provision(tree);
    expect(readFileSync(join(tree, "node_modules", "marker.txt"), "utf8")).toBe("main\n");
  });
});
