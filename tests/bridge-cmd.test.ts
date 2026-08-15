// tests/bridge-cmd.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { run as bridgeRun, initWith } from "../src/commands/bridge.js";
import type { InitDeps } from "../src/commands/bridge.js";
import { bridgeArtDir, bridgeExecDir } from "../src/core/bridge.js";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";

const okDeps: InitDeps = {
  haveCmd: () => true,
  agentBinary: () => "codex",
  pickRandomAgent: () => "alpha",
  isGitRepo: () => true,
  headSha: () => "abc123",
};

describe("bridge run() dispatch", () => {
  it("unknown verb → rc 2", async () => { expect(await bridgeRun(["nope"])).toBe(2); });
});

describe("bridge init", () => {
  let h: { home: string; cleanup: () => void };
  let out: ReturnType<typeof captureStdout>;
  beforeEach(() => { h = freshHome(); out = captureStdout(); });
  afterEach(() => { out.restore(); h.cleanup(); });

  it("scaffolds _bridge, writes state incl. target_cwd/mode, prints KV; rc 0", async () => {
    const repo = join(h.home, "repoB"); mkdirSync(repo, { recursive: true });
    const rc = await initWith(["--repo", repo, "add", "oauth"], okDeps);
    expect(rc).toBe(0);
    const art = bridgeArtDir("add-oauth"), exec = bridgeExecDir("add-oauth");
    expect(existsSync(join(exec))).toBe(true);
    expect(readFileSync(join(exec, "target_cwd.txt"), "utf8").trim()).toBe(repo);
    expect(readFileSync(join(exec, "mode.txt"), "utf8").trim()).toBe("branch");
    expect(readFileSync(join(art, "topic-text.txt"), "utf8")).toBe("add oauth");
    expect(out.text()).toMatch(/^SLUG=add-oauth$/m);
    expect(out.text()).toMatch(new RegExp(`^TARGET=${repo}$`, "m"));
    expect(out.text()).toMatch(/^MODE=branch$/m);
  });

  it("missing --repo → rc 1", async () => {
    expect(await initWith(["just", "a", "task"], okDeps)).toBe(1);
  });
  it("non-absolute --repo → rc 1", async () => {
    expect(await initWith(["--repo", "relative/path", "task"], okDeps)).toBe(1);
  });
  it("--repo with whitespace → rc 1", async () => {
    // (verbatim-tail can't deliver a spaced --repo token; reject defensively)
    expect(await initWith(["--repo", "/has space", "task"], okDeps)).toBe(1);
  });
  it("non-git --repo in branch mode → rc 1", async () => {
    const repo = join(h.home, "plain"); mkdirSync(repo, { recursive: true });
    expect(await initWith(["--repo", repo, "task"], { ...okDeps, isGitRepo: () => false })).toBe(1);
  });
  it("--in-place skips the git check and records mode=in-place", async () => {
    const repo = join(h.home, "plain2"); mkdirSync(repo, { recursive: true });
    const rc = await initWith(["--repo", repo, "--in-place", "quick fix"], { ...okDeps, isGitRepo: () => false });
    expect(rc).toBe(0);
    expect(readFileSync(join(bridgeExecDir("quick-fix"), "mode.txt"), "utf8").trim()).toBe("in-place");
  });
  it("already in flight → rc 2", async () => {
    const repo = join(h.home, "repoB"); mkdirSync(repo, { recursive: true });
    await initWith(["--repo", repo, "dup"], okDeps);
    expect(await initWith(["--repo", repo, "dup"], okDeps)).toBe(2);
  });
});

import { branchWith } from "../src/commands/bridge.js";
import type { Runner } from "../src/core/gitwork.js";
import { writeFileSync } from "node:fs";

function fakeRunner(map: Record<string, { code?: number; stdout?: string }>): Runner {
  return { run: (cmd, args) => { const key = [cmd, ...args].join(" "); const r = map[key] ?? matchPrefix(map, key); return { code: r?.code ?? 0, stdout: r?.stdout ?? "" }; } };
}
function matchPrefix(map: Record<string, { code?: number; stdout?: string }>, key: string) {
  for (const k of Object.keys(map)) if (key.startsWith(k)) return map[k]; return undefined;
}

describe("bridge branch", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => h.cleanup());

  function seedInit(slug: string, repo: string) {
    const exec = bridgeExecDir(slug); mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "target_cwd.txt"), repo + "\n");
    writeFileSync(join(exec, "mode.txt"), "branch\n");
  }

  it("cuts feat/bridge-<slug> and records start-branch/base; rc 0", async () => {
    seedInit("t", "/abs/repoB");
    const r = fakeRunner({
      "git rev-parse --git-dir": { code: 0 },
      "git symbolic-ref --short HEAD": { stdout: "main\n" },
      "git rev-parse HEAD": { stdout: "deadbeef\n" },
      "git status --porcelain": { stdout: "" },
      "git show-ref": { code: 1 },              // branch doesn't exist yet
      "git checkout -q -b feat/bridge-t": { code: 0 },
    });
    const rc = await branchWith("t", "/abs/repoB", r);
    expect(rc).toBe(0);
    expect(readFileSync(join(bridgeExecDir("t"), "branch.txt"), "utf8").trim()).toBe("feat/bridge-t");
    expect(readFileSync(join(bridgeExecDir("t"), "start-branch.txt"), "utf8").trim()).toBe("main");
  });

  it("refuses when repo B is already on another feat/bridge-* branch (single-occupancy); rc 1", async () => {
    seedInit("t", "/abs/repoB");
    const r = fakeRunner({
      "git rev-parse --git-dir": { code: 0 },
      "git symbolic-ref --short HEAD": { stdout: "feat/bridge-other\n" },
      "git rev-parse HEAD": { stdout: "deadbeef\n" },
      "git status --porcelain": { stdout: "" },
    });
    expect(await branchWith("t", "/abs/repoB", r)).toBe(1);
  });

  it("ALLOWS repo B already on THIS run's branch — single-occupancy must not block a resume", async () => {
    seedInit("t", "/abs/repoB");
    const r = fakeRunner({
      "git rev-parse --git-dir": { code: 0 },
      "git symbolic-ref --short HEAD": { stdout: "feat/bridge-t\n" },
      "git rev-parse HEAD": { stdout: "deadbeef\n" },
      "git status --porcelain": { stdout: "" },
      "git show-ref": { code: 0 },               // the branch is already there
    });
    expect(await branchWith("t", "/abs/repoB", r)).toBe(0);
    expect(readFileSync(join(bridgeExecDir("t"), "branch.txt"), "utf8").trim()).toBe("feat/bridge-t");
  });

  it("rc 1 when target is not a git repo", async () => {
    seedInit("t", "/abs/repoB");
    const r = fakeRunner({ "git rev-parse --git-dir": { code: 1 } });
    expect(await branchWith("t", "/abs/repoB", r)).toBe(1);
  });
});

import { roundSendWith, roundWaitWith } from "../src/commands/bridge.js";
import type { TurnSendDeps, TurnWaitDeps } from "../src/commands/bridge.js";
import type { OutboxEvent } from "../src/core/ipc.js";
import { noSleepClock } from "./helpers/clock.js";
import { workerDir } from "../src/core/paths.js";

function seedPart(slug: string, repo: string) {
  const art = bridgeArtDir(slug), exec = bridgeExecDir(slug);
  mkdirSync(exec, { recursive: true });
  writeFileSync(join(art, "agent.txt"), "alpha\n");
  writeFileSync(join(art, "selected-provider.txt"), "codex\n");
  writeFileSync(join(art, "topic-text.txt"), "implement X");
  writeFileSync(join(exec, "target_cwd.txt"), repo + "\n");
  writeFileSync(join(exec, "branch.txt"), `feat/bridge-${slug}\n`);
  // outbox must exist for the guard
  const pd = workerDir("alpha", "codex", slug); mkdirSync(pd, { recursive: true }); writeFileSync(join(pd, "outbox.jsonl"), "");
}

describe("bridge round-send / round-wait", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => h.cleanup());

  it("round-send 1 records OFFSET and sends the composed brief", async () => {
    seedPart("t", "/abs/repoB");
    let sent: string[] | undefined;
    const deps: TurnSendDeps = { offsetFor: () => 0, send: async (a) => { sent = a; return 0; } };
    const rc = await roundSendWith("t", 1, deps);
    expect(rc).toBe(0);
    expect(readFileSync(join(bridgeExecDir("t"), "round-1.txt"), "utf8")).toContain("OFFSET=0");
    expect(sent?.[0]).toBe("alpha");
    expect(sent?.[2]).toMatch(/^@.*round-prompt-1\.md$/);
    expect(readFileSync(join(bridgeExecDir("t"), "round-prompt-1.md"), "utf8")).toContain("implement X");
  });

  it("round-send 2 requires followup-2.md (rc 1 if missing)", async () => {
    seedPart("t", "/abs/repoB");
    const deps: TurnSendDeps = { offsetFor: () => 0, send: async () => 0 };
    expect(await roundSendWith("t", 2, deps)).toBe(1);
  });

  it("round-wait classifies done→ok and writes TS=ok", async () => {
    seedPart("t", "/abs/repoB");
    writeFileSync(join(bridgeExecDir("t"), "round-1.txt"), "OFFSET=0\n");
    const deps: TurnWaitDeps = { wait: async () => ({ event: "done", summary: "x", ts: "now" } as OutboxEvent), clock: noSleepClock };
    expect(await roundWaitWith("t", 1, deps)).toBe(0);
    expect(readFileSync(join(bridgeExecDir("t"), "round-1.txt"), "utf8")).toContain("TS=ok");
  });

  it("round-wait on a question writes question-N.txt and APPENDS a bumped OFFSET + TS=question", async () => {
    seedPart("t", "/abs/repoB");
    writeFileSync(join(bridgeExecDir("t"), "round-1.txt"), "OFFSET=0\n");
    // make the outbox non-empty so the bumped offset differs
    writeFileSync(join(workerDir("alpha", "codex", "t"), "outbox.jsonl"), '{"event":"question","question":"?","ts":"now"}\n');
    const deps: TurnWaitDeps = { wait: async () => ({ event: "question", question: "?", ts: "now" } as unknown as OutboxEvent), clock: noSleepClock };
    expect(await roundWaitWith("t", 1, deps)).toBe(0);
    const st = readFileSync(join(bridgeExecDir("t"), "round-1.txt"), "utf8");
    expect(st).toMatch(/TS=question/);
    expect((st.match(/OFFSET=/g) || []).length).toBe(2); // original + bumped
    expect(existsSync(join(bridgeExecDir("t"), "question-1.txt"))).toBe(true);
  });
});

import { finishWith } from "../src/commands/bridge.js";

describe("bridge finish", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => h.cleanup());

  it("fails closed (rc 1) when target_cwd.txt is absent — never pushes the conductor repo", async () => {
    const { run: finishRun } = await import("../src/commands/bridge.js");
    bridgeExecDir("t"); mkdirSync(bridgeExecDir("t"), { recursive: true }); // exec dir but NO target_cwd.txt
    expect(await finishRun(["finish", "t"])).toBe(1);
  });

  it("branch mode: writes diff-stats + finish-result via finishBranchPrMerge (pr-merged-pulled)", async () => {
    const exec = bridgeExecDir("t"); mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "mode.txt"), "branch\n");
    writeFileSync(join(exec, "branch.txt"), "feat/bridge-t\n");
    writeFileSync(join(exec, "start-branch.txt"), "main\n");
    writeFileSync(join(exec, "branch-base.sha"), "base1\n");
    writeFileSync(join(exec, "verify-result.txt"), "PASS\n");
    writeFileSync(join(bridgeArtDir("t"), "topic-text.txt"), "the task");
    let prTitle = "";
    const r: Runner = { run: (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key.startsWith("git diff --shortstat")) return { code: 0, stdout: " 1 file changed\n" };
      if (key === "git remote") return { code: 0, stdout: "origin\n" };
      if (key.startsWith("git remote get-url")) return { code: 0, stdout: "git@x:y.git\n" };
      if (key.startsWith("git show-ref")) return { code: 0, stdout: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") { prTitle = args[args.indexOf("--title") + 1]; return { code: 0, stdout: "" }; }
      return { code: 0, stdout: "" }; // push, checkout, gh pr merge, pull all succeed
    } };
    const rc = await finishWith("t", r, true);
    expect(rc).toBe(0);
    expect(prTitle).toBe("bridge: feat/bridge-t");
    expect(readFileSync(join(exec, "diff-stats.txt"), "utf8")).toContain("1 file changed");
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toContain("pr-merged-pulled");
  });

  it("in-place mode: no branch ops, records in-place finish-result", async () => {
    const exec = bridgeExecDir("t"); mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "mode.txt"), "in-place\n");
    const r: Runner = { run: () => ({ code: 0, stdout: "" }) };
    expect(await finishWith("t", r, true)).toBe(0);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toContain("in-place");
  });
});

describe("bridge summary", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => h.cleanup());

  it("the Mode field echoes mode.txt VERBATIM — a corrupt value must be visible, not normalized", async () => {
    const exec = bridgeExecDir("t"); mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "mode.txt"), "in-plce\n");   // hand-edited typo: neither branch nor in-place
    writeFileSync(join(exec, "branch.txt"), "feat/bridge-t\n");
    writeFileSync(join(bridgeArtDir("t"), "topic-text.txt"), "the task");
    const { run: bridgeRun } = await import("../src/commands/bridge.js");
    expect(await bridgeRun(["summary", "t", "--aborted", "build", "spawn-failed", "died"])).toBe(0);
    expect(readFileSync(join(bridgeArtDir("t"), "SUMMARY.md"), "utf8")).toContain("- Mode: in-plce");
    expect(readFileSync(join(bridgeArtDir("t"), "RESUME.md"), "utf8")).toContain("(mode: in-plce)");
  });
});

// capture process.stderr.write for the duration of fn() — the log module writes there, so the
// warn/ok wording is only observable this way (stdout has its own helper, captureStdout).
async function capture(fn: () => Promise<number>): Promise<{ rc: number; err: string }> {
  const err: string[] = [];
  const se = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, err: err.join("") }; }
  finally { process.stderr.write = se; }
}

describe("bridge branch: branch.txt records the branch the run ACTUALLY ended on", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); mkdirSync(bridgeExecDir("t"), { recursive: true }); });
  afterEach(() => h.cleanup());

  /** A clean repo B on `head`. `refExists` seeds a leftover feat/bridge-t from an EARLIER run (the
   *  shape that makes the finish guard's ref probe pass), `checkoutOk` whether THIS run's checkout
   *  lands. An empty `head` is a detached HEAD. */
  function fakeRepo(o: { refExists?: boolean; checkoutOk?: boolean; head?: string } = {}): { r: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const head = o.head ?? "main";
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git rev-parse --git-dir") return { code: 0, stdout: ".git" };
      if (k === "git symbolic-ref --short HEAD") return head ? { code: 0, stdout: head } : { code: 128, stdout: "" };
      if (k === "git rev-parse HEAD") return { code: 0, stdout: "base000" };
      if (k === "git status --porcelain") return { code: 0, stdout: "" };
      if (k === "git show-ref --verify --quiet refs/heads/feat/bridge-t") return { code: o.refExists ? 0 : 1, stdout: "" };
      if (args[0] === "checkout" && args.includes("feat/bridge-t")) return { code: o.checkoutOk === false ? 1 : 0, stdout: "" };
      if (k === "git remote") return { code: 0, stdout: "origin\n" };
      if (k === "git remote get-url origin") return { code: 0, stdout: "git@x:y.git\n" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }

  const branchTxt = () => readFileSync(join(bridgeExecDir("t"), "branch.txt"), "utf8");

  function seedFinish() {
    const exec = bridgeExecDir("t");
    writeFileSync(join(exec, "mode.txt"), "branch\n");
    writeFileSync(join(exec, "verify-result.txt"), "PASS\n");
    writeFileSync(join(bridgeArtDir("t"), "topic-text.txt"), "the task");
  }

  it("checkout landed: the intended name, as before", async () => {
    const { r } = fakeRepo();
    expect(await branchWith("t", "/abs/repoB", r)).toBe(0);
    expect(branchTxt()).toBe("feat/bridge-t\n");
  });

  it("checkout failed: the START branch is recorded, and the warn line still names both", async () => {
    const { r } = fakeRepo({ checkoutOk: false });
    const { rc, err } = await capture(() => branchWith("t", "/abs/repoB", r));
    expect(rc).toBe(0);
    expect(branchTxt()).toBe("main\n");
    expect(err).toContain("bridge branch: checkout feat/bridge-t failed; staying on main");
  });

  it("checkout failed from a detached HEAD: recorded as (detached), never as the intended name", async () => {
    const { r } = fakeRepo({ checkoutOk: false, head: "" });
    expect(await branchWith("t", "/abs/repoB", r)).toBe(0);
    expect(branchTxt()).toBe("(detached)\n");
  });

  it("the ok line keeps naming the INTENDED branch even when the checkout failed", async () => {
    const { r } = fakeRepo({ checkoutOk: false });
    const { err } = await capture(() => branchWith("t", "/abs/repoB", r));
    expect(err).toContain("bridge branch: feat/bridge-t (snapshot=clean");
  });

  it("STALE REF: a leftover feat/bridge-t + a failed checkout for THIS run → finish refuses, MERGES nothing", async () => {
    // Where bridge's defect bites hardest: its finish MERGES the PR, so an intended-name record
    // hands the leftover ref to finishBranchPrMerge and ships a merge containing none of this run's work.
    const exec = bridgeExecDir("t");
    const cut = fakeRepo({ refExists: true, checkoutOk: false });
    expect(await branchWith("t", "/abs/repoB", cut.r)).toBe(0);
    expect(branchTxt()).toBe("main\n");

    seedFinish();
    const fin = fakeRepo({ refExists: true });   // the leftover ref is still there at finish time
    expect(await finishWith("t", fin.r, true)).toBe(0);
    expect(fin.calls.some((c) => c[1] === "push")).toBe(false);
    expect(fin.calls.some((c) => c[0] === "gh")).toBe(false);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("none\tno-branch\n");
    expect(hubFlags(h.home).join("")).toContain("finish-no-branch");
  });

  it("OVER-REFUSAL GUARD: a stale ref whose checkout SUCCEEDS is a resume — it still merges", async () => {
    const exec = bridgeExecDir("t");
    const cut = fakeRepo({ refExists: true });
    expect(await branchWith("t", "/abs/repoB", cut.r)).toBe(0);
    expect(branchTxt()).toBe("feat/bridge-t\n");

    seedFinish();
    const fin = fakeRepo({ refExists: true });
    expect(await finishWith("t", fin.r, true)).toBe(0);
    expect(fin.calls.some((c) => c.join(" ") === "git push -q -u origin feat/bridge-t")).toBe(true);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("pr-merge\tpr-merged-pulled\n");
    expect(hubFlags(h.home)).toEqual([]);
  });

  it("the round-1 brief names the REAL branch — the worker is never told it is somewhere it is not", async () => {
    const { r } = fakeRepo({ checkoutOk: false });
    expect(await branchWith("t", "/abs/repoB", r)).toBe(0);
    const art = bridgeArtDir("t"), exec = bridgeExecDir("t");
    writeFileSync(join(art, "agent.txt"), "alpha\n");
    writeFileSync(join(art, "selected-provider.txt"), "codex\n");
    writeFileSync(join(art, "topic-text.txt"), "implement X");
    writeFileSync(join(exec, "target_cwd.txt"), "/abs/repoB\n");
    const pd = workerDir("alpha", "codex", "t"); mkdirSync(pd, { recursive: true }); writeFileSync(join(pd, "outbox.jsonl"), "");
    expect(await roundSendWith("t", 1, { offsetFor: () => 0, send: async () => 0 })).toBe(0);
    const prompt = readFileSync(join(exec, "round-prompt-1.md"), "utf8");
    expect(prompt).toContain("You are on the branch `main`");
    expect(prompt).not.toContain("feat/bridge-t");   // BRANCH_DISCIPLINE tells it NOT to checkout
  });

  it("a failed checkout's record reaches SUMMARY and RESUME: both name the REAL branch", async () => {
    const { r } = fakeRepo({ checkoutOk: false });
    expect(await branchWith("t", "/abs/repoB", r)).toBe(0);
    writeFileSync(join(bridgeExecDir("t"), "mode.txt"), "branch\n");
    writeFileSync(join(bridgeArtDir("t"), "topic-text.txt"), "the task");
    const { run: bridgeRun } = await import("../src/commands/bridge.js");
    expect(await bridgeRun(["summary", "t", "--aborted", "round", "wait", "worker died"])).toBe(0);
    expect(readFileSync(join(bridgeArtDir("t"), "SUMMARY.md"), "utf8")).toContain("- Branch: main");
    expect(readFileSync(join(bridgeArtDir("t"), "RESUME.md"), "utf8")).toContain("the worker's work is on main");
  });
});

/** Every hub flag written under this run's AP_HOME. */
function hubFlags(home: string): string[] {
  const root = join(home, "forensics");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((d) => readdirSync(join(root, d)).map((f) => readFileSync(join(root, d, f), "utf8")));
}

describe("bridge finish: the no-branch refusal is flagged for /ap:review", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => h.cleanup());

  /** `refRc` decides whether the recorded branch still exists; `head` is where the run really is —
   *  the refusal arm performs no checkout, so this is whatever the branch step left behind. */
  function seed(branch: string, startBranch: string, refRc: number, head = "main"): { r: Runner; calls: string[][] } {
    const exec = bridgeExecDir("t"); mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "mode.txt"), "branch\n");
    if (branch) writeFileSync(join(exec, "branch.txt"), branch + "\n");
    writeFileSync(join(exec, "start-branch.txt"), startBranch + "\n");
    writeFileSync(join(exec, "verify-result.txt"), "PASS\n");
    writeFileSync(join(bridgeArtDir("t"), "topic-text.txt"), "the task");
    const calls: string[][] = [];
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k.startsWith("git show-ref")) return { code: refRc, stdout: "" };
      if (k === "git symbolic-ref --short HEAD") return head ? { code: 0, stdout: head + "\n" } : { code: 128, stdout: "" };
      if (k === "git remote") return { code: 0, stdout: "origin\n" };
      if (k === "git remote get-url origin") return { code: 0, stdout: "git@x:y.git\n" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }

  it("the recorded branch's ref went away: flagged, naming both branches and the REAL head", async () => {
    const { r } = seed("feat/bridge-t", "main", 1, "feat/bridge-t");
    expect(await finishWith("t", r, true)).toBe(0);
    expect(hubFlags(h.home).join("")).toContain(
      "finish-no-branch: the recorded branch 'feat/bridge-t' is missing or is the start branch 'main' — nothing was pushed, no PR opened; the work (if any) is on 'feat/bridge-t'",
    );
  });

  it("a detached HEAD is reported as (detached), never as the start branch", async () => {
    const { r } = seed("feat/bridge-t", "main", 1, "");
    expect(await finishWith("t", r, true)).toBe(0);
    expect(hubFlags(h.home).join("")).toContain("the work (if any) is on '(detached)'");
  });

  it("nothing recorded at all: the flag says so rather than naming an empty branch", async () => {
    const { r } = seed("", "main", 1);
    expect(await finishWith("t", r, true)).toBe(0);
    expect(hubFlags(h.home).join("")).toContain("'(unrecorded)'");
  });

  it("a healthy pr-merge finish writes NO flag — the refusal is the only flagged outcome", async () => {
    const { r } = seed("feat/bridge-t", "main", 0);
    expect(await finishWith("t", r, true)).toBe(0);
    expect(readFileSync(join(bridgeExecDir("t"), "finish-result.txt"), "utf8")).toBe("pr-merge\tpr-merged-pulled\n");
    expect(hubFlags(h.home)).toEqual([]);
  });

  it("an in-place finish writes NO flag — that arm never reaches the finisher", async () => {
    const exec = bridgeExecDir("t"); mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "mode.txt"), "in-place\n");
    const r: Runner = { run: () => ({ code: 0, stdout: "" }) };
    expect(await finishWith("t", r, true)).toBe(0);
    expect(hubFlags(h.home)).toEqual([]);
  });
});
