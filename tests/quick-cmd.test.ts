// tests/quick-cmd.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { run as quickRun, initWith } from "../src/commands/quick.js";
import type { InitDeps } from "../src/commands/quick.js";

describe("quick dispatcher", () => {
  it("no verb / unknown verb → usage, rc 2", async () => {
    expect(await quickRun([])).toBe(2);
    expect(await quickRun(["frobnicate"])).toBe(2);
  });
});

import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { quickArtDir, quickExecDir } from "../src/core/quick.js";
import { forensicsQueueDir, workerDir } from "../src/core/paths.js";
import { outboxPath } from "../src/core/ipc.js";
import { formatJob, jobPath } from "../src/core/job.js";
import { runFlag } from "../src/core/forensics.js";

// Build an --args-file the way the dispatcher expects (first line tokenized).
function argsFile(home: string, line: string): string {
  const p = join(home, "args.txt");
  writeFileSync(p, line + "\n");
  return p;
}

describe("quick init", () => {
  let h: { home: string; cleanup: () => void };
  let outSpy: ReturnType<typeof captureStdout>;
  beforeEach(() => { h = freshHome(); outSpy = captureStdout(); });
  afterEach(() => { outSpy.restore(); h.cleanup(); });

  // Deterministic deps: provider present + on PATH, agent fixed — no env dependency.
  const okDeps: InitDeps = { haveCmd: () => true, agentBinary: () => "codex", pickRandomAgent: () => "bravo", livePanes: async () => new Map(), branchSha: () => "" };

  it("scaffolds _quick, validates provider, prints KV; rc 0", async () => {
    const rc = await initWith(["add", "oauth", "login", "--provider", "codex"], okDeps);
    expect(rc).toBe(0);
    const art = quickArtDir("add-oauth-login");
    expect(existsSync(join(art, "execute"))).toBe(true);
    expect(readFileSync(join(art, "topic.txt"), "utf8").trim()).toBe("add-oauth-login");
    expect(readFileSync(join(art, "selected-provider.txt"), "utf8").trim()).toBe("codex");
    expect(readFileSync(join(art, "agent.txt"), "utf8").trim()).toBe("bravo");
    expect(readFileSync(join(art, "execute", "finish.txt"), "utf8").trim()).toBe("yes");
    expect(outSpy.text()).toMatch(/^SLUG=add-oauth-login$/m);
    expect(outSpy.text()).toMatch(/^PROVIDER=codex$/m);
    expect(outSpy.text()).toMatch(/^AGENT=bravo$/m);
  });

  it("--no-finish opts out → finish.txt is no; rc 0", async () => {
    const rc = await initWith(["add", "oauth", "login", "--provider", "codex", "--no-finish"], okDeps);
    expect(rc).toBe(0);
    const art = quickArtDir("add-oauth-login");
    expect(readFileSync(join(art, "execute", "finish.txt"), "utf8").trim()).toBe("no");
  });

  it("--stash-wip is persisted + echoed, so the branch step never re-reads $ARGUMENTS", async () => {
    expect(await initWith(["fix", "the", "bug", "--stash-wip"], okDeps)).toBe(0);
    const exec = join(quickArtDir("fix-the-bug"), "execute");
    expect(readFileSync(join(exec, "stash-wip-requested.txt"), "utf8").trim()).toBe("yes");
    expect(outSpy.text()).toMatch(/^STASH_WIP=yes$/m);
    expect(readFileSync(join(quickArtDir("fix-the-bug"), "topic.txt"), "utf8").trim()).toBe("fix-the-bug");
  });

  it("no --stash-wip → STASH_WIP=no", async () => {
    expect(await initWith(["fix", "the", "bug"], okDeps)).toBe(0);
    expect(readFileSync(join(quickArtDir("fix-the-bug"), "execute", "stash-wip-requested.txt"), "utf8").trim()).toBe("no");
    expect(outSpy.text()).toMatch(/^STASH_WIP=no$/m);
  });

  it("empty topic → rc 1", async () => {
    expect(await quickRun(["init", "--args-file", argsFile(h.home, "--provider codex")])).toBe(1);
  });

  it("unknown provider → rc 3 (env-independent: reads shipped contracts.yaml)", async () => {
    // Under verbatim-tail (Task 4), only leading --flag pairs are peeled; a --provider after the
    // body is now worker of the verbatim topic. Lead with the flag so it parses as the provider.
    expect(await quickRun(["init", "--args-file", argsFile(h.home, "--provider nope do thing")])).toBe(3);
  });

  it("provider known but binary not on PATH → rc 3", async () => {
    const rc = await initWith(["do", "thing"], { ...okDeps, haveCmd: () => false });
    expect(rc).toBe(3);
  });

  it("a flag-only _quick (findings.log + issue.txt from a pre-init `quick flag`) never blocks init, and both records carry forward", async () => {
    expect(runFlag("quick", "flagged-topic", "spawn died before init")).toBe(0);
    const art = quickArtDir("flagged-topic");
    const log0 = readFileSync(join(art, "findings.log"), "utf8");
    const issue0 = readFileSync(join(art, "issue.txt"), "utf8");
    expect(log0).toMatch(/ flag\n$/);
    expect(issue0).toMatch(/^run_id=/m);
    expect(existsSync(join(art, "topic-text.txt"))).toBe(false); // nothing init writes is there yet
    expect(await initWith(["flagged", "topic", "--provider", "codex"], okDeps)).toBe(0);
    expect(readFileSync(join(art, "findings.log"), "utf8")).toBe(log0);
    expect(readFileSync(join(art, "issue.txt"), "utf8")).toBe(issue0);
    expect(readFileSync(join(art, "topic-text.txt"), "utf8")).toBe("flagged topic");
  });

  it("only the hub's task-brief.md present → in flight, rc 2 (the second init-written key)", async () => {
    const art = quickArtDir("briefed-topic");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "task-brief.md"), "# brief\n");
    expect(await initWith(["briefed", "topic", "--provider", "codex"], okDeps)).toBe(2);
  });

  it("a bare `quick branch` before init (execute/ only) does not block init", async () => {
    const exec = quickExecDir("branched-first");
    mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "target_cwd.txt"), "/proj\n");
    writeFileSync(join(exec, "branch-base.sha"), "base000\n");
    expect(await initWith(["branched", "first", "--provider", "codex"], okDeps)).toBe(0);
    expect(readFileSync(join(exec, "target_cwd.txt"), "utf8")).toBe("/proj\n"); // untouched
  });

  it("a torn init that wrote only topic.txt does not block (nothing of a run exists yet)", async () => {
    const art = quickArtDir("torn-topic");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "topic.txt"), "torn-topic\n");
    expect(await initWith(["torn", "topic", "--provider", "codex"], okDeps)).toBe(0);
    expect(existsSync(join(art, "topic-text.txt"))).toBe(true);
  });

  it("in-flight (a predecessor that reached a worker turn) → rc 2", async () => {
    expect(await initWith(["dup", "topic", "--provider", "codex"], okDeps)).toBe(0);
    writeFileSync(join(quickExecDir("dup-topic"), "turn-1.txt"), "OFFSET=0\n");
    expect(await initWith(["dup", "topic", "--provider", "codex"], okDeps)).toBe(2);
  });
});

import { branchWith } from "../src/commands/quick.js";
import { parseBranchArgs } from "../src/core/quick.js";
import type { Runner } from "../src/core/gitwork.js";

describe("quick branch (branchWith core)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function fake(): { r: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git rev-parse --git-dir") return { code: 0, stdout: ".git" };
      if (k === "git symbolic-ref HEAD") return { code: 0, stdout: "refs/heads/main" };
      if (k === "git rev-parse HEAD") return { code: 0, stdout: "base000" };
      if (k === "git status --porcelain") return { code: 0, stdout: "" };
      if (k === "git show-ref --verify --quiet refs/heads/feat/quick-auth") return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }

  it("writes execute/ snapshot files and creates the branch; rc 0", async () => {
    // pre-create _quick so atomicWrite's parent exists (init normally does this)
    const { quickExecDir } = await import("../src/core/quick.js");
    mkdtempSync(join(tmpdir(), "x-")); // noop to keep import order
    const { mkdirSync } = await import("node:fs");
    mkdirSync(quickExecDir("auth"), { recursive: true });

    const { r, calls } = fake();
    const rc = await branchWith("auth", "/proj", r);
    expect(rc).toBe(0);
    expect(calls).toContainEqual(["git", "checkout", "-q", "-b", "feat/quick-auth"]);
    const exec = quickExecDir("auth");
    expect(readFileSync(join(exec, "target_cwd.txt"), "utf8").trim()).toBe("/proj");
    expect(readFileSync(join(exec, "start-branch.txt"), "utf8").trim()).toBe("main");
    expect(readFileSync(join(exec, "branch-base.sha"), "utf8").trim()).toBe("base000");
    expect(readFileSync(join(exec, "branch.txt"), "utf8").trim()).toBe("feat/quick-auth");
  });

  it("not-git target → rc 1", async () => {
    const r: Runner = { run: () => ({ code: 128, stdout: "" }) };
    const { mkdirSync } = await import("node:fs");
    const { quickExecDir } = await import("../src/core/quick.js");
    mkdirSync(quickExecDir("nope"), { recursive: true });
    expect(await branchWith("nope", "/proj", r)).toBe(1);
  });

  it("squash-merged leftover branch → rc 1, no checkout, and NOTHING written (the run never started)", async () => {
    const { mkdirSync, existsSync } = await import("node:fs");
    const { quickExecDir } = await import("../src/core/quick.js");
    mkdirSync(quickExecDir("auth"), { recursive: true });
    const calls: string[][] = [];
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git rev-parse --git-dir") return { code: 0, stdout: ".git" };
      if (k === "git symbolic-ref HEAD") return { code: 0, stdout: "refs/heads/main" };
      if (k === "git rev-parse HEAD") return { code: 0, stdout: "base000" };
      if (k === "git status --porcelain") return { code: 0, stdout: "" };
      // The ref is there, but HEAD is not an ancestor of it — the squash-merge leftover.
      if (k === "git show-ref --verify --quiet refs/heads/feat/quick-auth") return { code: 0, stdout: "" };
      if (k === "git merge-base --is-ancestor HEAD refs/heads/feat/quick-auth") return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    } };
    const { rc, err } = await capture(() => branchWith("auth", "/proj", r));
    expect(rc).toBe(1);
    expect(err).toContain("feat/quick-auth");
    expect(err).toContain("diverged from the current HEAD");
    expect(err).toContain("git -C /proj branch -D feat/quick-auth");
    expect(calls.some((c) => c[1] === "checkout")).toBe(false);
    // ap touches nobody's branch.
    expect(calls.some((c) => c[1] === "branch" || c[1] === "update-ref")).toBe(false);
    // A run that refused must leave no record a later verb could read as a started run.
    for (const f of ["branch.txt", "target_cwd.txt", "start-branch.txt", "branch-base.sha"]) {
      expect(existsSync(join(quickExecDir("auth"), f))).toBe(false);
    }
  });
});

describe("quick branch --stash-wip", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); mkdirSync(quickExecDir("auth"), { recursive: true }); });
  afterEach(() => { h.cleanup(); });

  /** Fake git for a repo whose tree starts `dirty`. `git stash push` is modelled the way real git
   *  can misbehave: `pushRc` is its exit code, `stashed` whether it actually creates an entry,
   *  `cleans` whether the tree was emptied — INDEPENDENT knobs, which is the whole reason the
   *  outcome cannot be read off the rc. `preExisting` seeds a leftover entry under the same name
   *  from an aborted run. One entry slot is enough here (a real duplicate would sit at stash@{1});
   *  what the code keys on is the sha, and the two-entry ordering is pinned in quick-gitwork. */
  function fakeRepo(o: { dirty: boolean; pushRc?: number; stashed?: boolean; cleans?: boolean; preExisting?: boolean }): { r: Runner; calls: string[][] } {
    const calls: string[][] = [];
    let dirty = o.dirty;
    let entrySha = o.preExisting ? "olderrun" : "";
    let head = "base000";
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git rev-parse --git-dir") return { code: 0, stdout: ".git" };
      if (k === "git symbolic-ref HEAD") return { code: 0, stdout: "refs/heads/main" };
      if (k === "git rev-parse HEAD") return { code: 0, stdout: head };
      if (k.startsWith("git status --porcelain")) return { code: 0, stdout: dirty ? " M src/a.ts\n?? junk.txt\n" : "" };
      if (args[0] === "stash" && args[1] === "push") {
        if (o.stashed !== false) entrySha = "stash999";
        if (o.cleans !== false) dirty = false;
        return { code: o.pushRc ?? 0, stdout: "" };
      }
      if (k === "git stash list --format=%gd%x09%gs") return { code: 0, stdout: entrySha ? "stash@{0}\tOn main: ap-quick-auth-wip\n" : "" };
      if (k === "git rev-parse stash@{0}") return { code: 0, stdout: entrySha + "\n" };
      if (args[0] === "commit") { dirty = false; head = "wip111"; return { code: 0, stdout: "" }; }
      if (k === "git show-ref --verify --quiet refs/heads/feat/quick-auth") return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }

  const marker = () => join(quickExecDir("auth"), "stash-wip.txt");
  const snapshotted = (calls: string[][]) => calls.some((c) => c.join(" ") === "git commit -q -m chore: WIP before quick auth");

  it("REGRESSION PIN: no flag + dirty tree → the git call sequence of today, unchanged", async () => {
    const { r, calls } = fakeRepo({ dirty: true });
    expect(await branchWith("auth", "/proj", r)).toBe(0);
    expect(calls).toEqual([
      ["git", "rev-parse", "--git-dir"],
      ["git", "symbolic-ref", "HEAD"],
      ["git", "rev-parse", "HEAD"],
      ["git", "status", "--porcelain"],
      ["git", "add", "-A"],
      ["git", "commit", "-q", "-m", "chore: WIP before quick auth"],
      ["git", "rev-parse", "HEAD"],
      ["git", "show-ref", "--verify", "--quiet", "refs/heads/feat/quick-auth"],
      ["git", "checkout", "-q", "-b", "feat/quick-auth"],
    ]);
    expect(existsSync(marker())).toBe(false);
    expect(readFileSync(join(quickExecDir("auth"), "branch-base.sha"), "utf8").trim()).toBe("wip111");
  });

  it("SEQUENCE PIN: dirty + flag parks, PROVES the park, then snapshots a clean tree", async () => {
    const { r, calls } = fakeRepo({ dirty: true });
    expect(await branchWith("auth", "/proj", r, true)).toBe(0);
    expect(calls).toEqual([
      ["git", "status", "--porcelain", "--untracked-files=all"],            // dirty gate (all untracked, not the repo's status.showUntrackedFiles)
      ["git", "stash", "list", "--format=%gd%x09%gs"],                      // pre-push: what already carries our name
      ["git", "stash", "push", "--include-untracked", "-m", "ap-quick-auth-wip"],
      ["git", "stash", "list", "--format=%gd%x09%gs"],                      // entry really exists?
      ["git", "rev-parse", "stash@{0}"],                                    // its sha = the park's identity, and it must have CHANGED
      ["git", "status", "--porcelain", "--untracked-files=all"],            // tree really empty?
      ["git", "rev-parse", "--git-dir"],                                    // preSnapshot from here on
      ["git", "symbolic-ref", "HEAD"],
      ["git", "rev-parse", "HEAD"],
      ["git", "status", "--porcelain"],
      ["git", "show-ref", "--verify", "--quiet", "refs/heads/feat/quick-auth"],
      ["git", "checkout", "-q", "-b", "feat/quick-auth"],
    ]);
    expect(readFileSync(marker(), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
    expect(readFileSync(join(quickExecDir("auth"), "branch-base.sha"), "utf8").trim()).toBe("base000"); // clean HEAD
  });

  it("partial park (entry exists, tree still dirty): marker written AND the residue is snapshotted", async () => {
    const { r, calls } = fakeRepo({ dirty: true, cleans: false });
    expect(await branchWith("auth", "/proj", r, true)).toBe(0);
    expect(readFileSync(marker(), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
    expect(snapshotted(calls)).toBe(true);
    expect(readFileSync(join(quickExecDir("auth"), "branch-base.sha"), "utf8").trim()).toBe("wip111");
  });

  it("no park (rc 0 but nothing stashed): NO marker, no success claim, snapshot path proceeds", async () => {
    const { r, calls } = fakeRepo({ dirty: true, stashed: false, cleans: false });
    expect(existsSync(marker())).toBe(false);
    expect(await branchWith("auth", "/proj", r, true)).toBe(0);
    expect(existsSync(marker())).toBe(false);
    expect(calls.some((c) => c.join(" ") === "git rev-parse stash@{0}")).toBe(false);
    expect(snapshotted(calls)).toBe(true);
  });

  it("leftover same-named stash + a push that creates nothing: NOT adopted, no marker", async () => {
    const { r, calls } = fakeRepo({ dirty: true, preExisting: true, stashed: false, cleans: false });
    expect(await branchWith("auth", "/proj", r, true)).toBe(0);
    expect(existsSync(marker())).toBe(false);   // finish must never pop another run's stash
    expect(snapshotted(calls)).toBe(true);
  });

  it("new entry created alongside a same-named leftover: the NEW sha is what the marker records", async () => {
    const { r } = fakeRepo({ dirty: true, preExisting: true });
    expect(await branchWith("auth", "/proj", r, true)).toBe(0);
    expect(readFileSync(marker(), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
  });

  it("failed-with-entry (rc 1 but git left an entry): marker IS written so finish restores it", async () => {
    const { r, calls } = fakeRepo({ dirty: true, pushRc: 1, cleans: false });
    expect(await branchWith("auth", "/proj", r, true)).toBe(0);
    expect(readFileSync(marker(), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
    expect(snapshotted(calls)).toBe(true);   // the tree may still hold the same changes
  });

  it("clean + flag: no stash, no marker", async () => {
    const { r, calls } = fakeRepo({ dirty: false });
    expect(await branchWith("auth", "/proj", r, true)).toBe(0);
    expect(calls.some((c) => c[1] === "stash")).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  it("stash push fails + flag: warns, no marker, today's snapshot path proceeds", async () => {
    const { r, calls } = fakeRepo({ dirty: true, pushRc: 1, stashed: false, cleans: false });
    expect(await branchWith("auth", "/proj", r, true)).toBe(0);
    expect(existsSync(marker())).toBe(false);
    expect(calls).toContainEqual(["git", "add", "-A"]);
    expect(calls).toContainEqual(["git", "commit", "-q", "-m", "chore: WIP before quick auth"]);
    expect(readFileSync(join(quickExecDir("auth"), "branch-base.sha"), "utf8").trim()).toBe("wip111");
  });

  it("no state dir (branch run without an init): creates it instead of throwing after the tree was emptied", async () => {
    rmSync(quickExecDir("auth"), { recursive: true, force: true });
    const { r } = fakeRepo({ dirty: true });
    expect(await branchWith("auth", "/proj", r, true)).toBe(0);
    expect(readFileSync(marker(), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
  });

  it("dispatcher: --stash-wip parses on either side of the topic; flags alone are usage rc 2", async () => {
    expect(parseBranchArgs(["--stash-wip", "auth"])).toEqual({ topic: "auth", stashWip: true });
    expect(parseBranchArgs(["auth", "--stash-wip"])).toEqual({ topic: "auth", stashWip: true });
    expect(parseBranchArgs(["auth"])).toEqual({ topic: "auth", stashWip: false });
    expect(await quickRun(["branch", "--stash-wip"])).toBe(2);
  });
});

import { turnSendWith } from "../src/commands/quick.js";

describe("quick turn-send (turnSendWith core)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  async function scaffold(topic: string) {
    const { quickArtDir, quickExecDir } = await import("../src/core/quick.js");
    const { workerDir } = await import("../src/core/paths.js");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(quickExecDir(topic), { recursive: true });
    const art = quickArtDir(topic);
    writeFileSync(join(art, "agent.txt"), "bravo\n");
    writeFileSync(join(art, "selected-provider.txt"), "codex\n");
    writeFileSync(join(art, "task-brief.md"), "## Goal\nDo X");
    writeFileSync(join(quickExecDir(topic), "branch.txt"), "feat/quick-auth\n");
    const pd = workerDir("bravo", "codex", topic); // a spawned worker has an outbox (turn-send's not-found guard)
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "outbox.jsonl"), "");
  }

  it("round 1: writes OFFSET, prompt file, calls send; rc 0", async () => {
    await scaffold("auth");
    const sends: string[][] = [];
    const rc = await turnSendWith("auth", 1, {
      offsetFor: () => 42,
      send: async (args) => { sends.push(args); return 0; },
    });
    expect(rc).toBe(0);
    const { quickExecDir } = await import("../src/core/quick.js");
    const exec = quickExecDir("auth");
    expect(readFileSync(join(exec, "turn-1.txt"), "utf8")).toBe("OFFSET=42\n");
    expect(readFileSync(join(exec, "turn-prompt-1.md"), "utf8")).toContain("## Goal\nDo X");
    expect(sends[0]).toEqual(["bravo", "auth", `@${join(exec, "turn-prompt-1.md")}`]);
  });

  it("round 1 idempotency: existing turn-1.txt → rc 1", async () => {
    await scaffold("auth");
    const { quickExecDir } = await import("../src/core/quick.js");
    writeFileSync(join(quickExecDir("auth"), "turn-1.txt"), "OFFSET=0\n");
    expect(await turnSendWith("auth", 1, { offsetFor: () => 0, send: async () => 0 })).toBe(1);
  });

  it("round 2 without a fix bundle → rc 1", async () => {
    await scaffold("auth");
    expect(await turnSendWith("auth", 2, { offsetFor: () => 0, send: async () => 0 })).toBe(1);
  });
});

import { turnWaitWith } from "../src/commands/quick.js";
import { noSleepClock } from "./helpers/clock.js";

describe("quick turn-wait (turnWaitWith core)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  // The terminal-confirmation window is real wall time; these pins only care about the verdict, so
  // the window's sleep is injected away (the layer itself is pinned in tests/turn-confirm.test.ts).
  const noClock = noSleepClock;

  async function scaffold(topic: string, stateBody: string) {
    const { quickArtDir, quickExecDir } = await import("../src/core/quick.js");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(quickExecDir(topic), { recursive: true });
    writeFileSync(join(quickArtDir(topic), "agent.txt"), "bravo\n");
    writeFileSync(join(quickArtDir(topic), "selected-provider.txt"), "codex\n");
    writeFileSync(join(quickExecDir(topic), `turn-1.txt`), stateBody);
  }

  it("done → appends TS=ok; rc 0", async () => {
    await scaffold("auth", "OFFSET=10\n");
    const rc = await turnWaitWith("auth", 1, { wait: async () => ({ event: "done", summary: "ok" }), clock: noClock });
    expect(rc).toBe(0);
    const { quickExecDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickExecDir("auth"), "turn-1.txt"), "utf8")).toBe("OFFSET=10\nTS=ok\n");
  });

  it("question → captures payload + TS=question", async () => {
    await scaffold("auth", "OFFSET=0\n");
    await turnWaitWith("auth", 1, { wait: async () => ({ event: "question", message: "which db?" }), clock: noClock });
    const { quickExecDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickExecDir("auth"), "turn-1.txt"), "utf8")).toContain("TS=question");
    expect(readFileSync(join(quickExecDir("auth"), "question-1.txt"), "utf8")).toContain("which db?");
  });

  it("timeout (null) → TS=timeout", async () => {
    await scaffold("auth", "OFFSET=0\n");
    await turnWaitWith("auth", 1, { wait: async () => null, clock: noClock });
    const { quickExecDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickExecDir("auth"), "turn-1.txt"), "utf8")).toContain("TS=timeout");
  });

  it("missing OFFSET → rc 1", async () => {
    await scaffold("auth", "TS=stale\n");
    expect(await turnWaitWith("auth", 1, { wait: async () => null, clock: noClock })).toBe(1);
  });

  it("question: appends a bumped OFFSET so a re-arm resumes past it (no loop)", async () => {
    await scaffold("auth", "OFFSET=0\n");
    // Give the worker an outbox with known bytes so the bump is non-zero (outboxOffset = file size).
    const ob = outboxPath("bravo", "codex", "auth");
    mkdirSync(dirname(ob), { recursive: true });
    const body = '{"event":"question","message":"which db?"}\n';
    writeFileSync(ob, body);
    const N = Buffer.byteLength(body);
    const seen: number[] = [];
    const wait = async (_i: string, _m: string, _t: string, off: number) => {
      seen.push(off);
      return seen.length === 1 ? { event: "question", message: "which db?" } : { event: "done", summary: "ok" };
    };
    await turnWaitWith("auth", 1, { wait, clock: noClock });   // round 1: handles the question at offset 0
    await turnWaitWith("auth", 1, { wait, clock: noClock });   // re-arm on the SAME round must resume past it
    const state = readFileSync(join(quickExecDir("auth"), "turn-1.txt"), "utf8");
    expect(state).toContain(`OFFSET=${N}`);     // a bumped OFFSET line was appended on the question
    expect(seen).toEqual([0, N]);               // the re-arm read the LATEST offset, not 0 (no loop)
  });
});

describe("quick detect-test", () => {
  let outSpy: ReturnType<typeof captureStdout>;
  beforeEach(() => { outSpy = captureStdout(); });
  afterEach(() => { outSpy.restore(); });

  it("prints the detected command for a given cwd; rc 0", async () => {
    const r = mkdtempSync(join(tmpdir(), "dt2-")); writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    expect(await quickRun(["detect-test", r])).toBe(0);
    expect(outSpy.text().trim()).toBe("npm test");
  });
});

import { finishWith } from "../src/commands/quick.js";

describe("quick finish (finishWith core)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  async function scaffold(topic: string, finishFlag: string) {
    const { quickArtDir, quickExecDir } = await import("../src/core/quick.js");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(quickExecDir(topic), { recursive: true });
    const exec = quickExecDir(topic);
    writeFileSync(join(exec, "target_cwd.txt"), "/proj\n");
    writeFileSync(join(exec, "branch.txt"), "feat/quick-auth\n");
    writeFileSync(join(exec, "start-branch.txt"), "main\n");
    writeFileSync(join(exec, "finish.txt"), finishFlag + "\n");
    writeFileSync(join(quickArtDir(topic), "task-brief.md"), "## Goal\nX");
    writeFileSync(join(exec, "verify-result.txt"), "PASS (npm test)\n");
  }

  function fake(replies: Record<string, { code: number; stdout: string }>) {
    const calls: string[][] = [];
    return { calls, r: { run: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return replies[[cmd, ...args].join(" ")] ?? { code: 0, stdout: "" }; } } };
  }

  it("finish.txt=no → restore only, records branch-only; rc 0", async () => {
    await scaffold("auth", "no");
    const { calls, r } = fake({});
    expect(await finishWith("auth", r as any, true)).toBe(0);
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
    const { quickExecDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickExecDir("auth"), "finish-result.txt"), "utf8")).toContain("branch-only");
  });

  it("finish.txt=yes + remote → push/pr path, records outcome", async () => {
    await scaffold("auth", "yes");
    const { calls, r } = fake({
      "git remote": { code: 0, stdout: "origin\n" },
      "git push -q -u origin feat/quick-auth": { code: 0, stdout: "" },
      "git remote get-url origin": { code: 0, stdout: "url\n" },
    });
    expect(await finishWith("auth", r as any, true)).toBe(0);
    expect(calls.some((c) => c[0] === "gh")).toBe(true);
    const { quickExecDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickExecDir("auth"), "finish-result.txt"), "utf8")).toContain("pr-opened");
  });

  // The detached run's "push nothing, open no PR" was directive prose only; this is its mechanical
  // half. It DIVERTS to the branch-only arm rather than refusing outright, because that arm is what
  // restores the start branch and pops a --stash-wip park.
  it("finish.txt=yes but a detached job record is present → branch-only, nothing pushed", async () => {
    await scaffold("auth", "yes");
    const p = jobPath("auth");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, formatJob({
      command: "quick", topic: "auth", session: "ap-auth",
      hub: { agent: "alpha", model: "claude" },
      provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
      args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
    }));
    const { calls, r } = fake({
      "git remote": { code: 0, stdout: "origin\n" },
      "git remote get-url origin": { code: 0, stdout: "url\n" },
    });
    expect(await finishWith("auth", r as any, true)).toBe(0);
    expect(calls.some((c) => c[1] === "push")).toBe(false);
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
    const { quickExecDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickExecDir("auth"), "finish-result.txt"), "utf8")).toContain("branch-only");
  });

  /** A detached record for `auth` with whatever finish action it was launched (or tampered) with. */
  function seedJobFinish(finish: string): void {
    const p = jobPath("auth");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, formatJob({
      command: "quick", topic: "auth", session: "ap-auth",
      hub: { agent: "alpha", model: "claude" },
      provider: "codex", finish, budget_hours: 6, max_rounds: 5,
      args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
    }));
  }

  // `--finish` was removed 2026-08-18: the diversion is unconditional again, so what a record NAMES
  // — an older ap's 'pr', or a hand-edited 'merge' — never re-enables publication.
  it("a record naming any other finish action still diverts to branch-only", async () => {
    for (const finish of ["pr", "merge"]) {
      await scaffold("auth", "yes");
      seedJobFinish(finish);
      const { calls, r } = fake({
        "git remote": { code: 0, stdout: "origin\n" },
        "git remote get-url origin": { code: 0, stdout: "url\n" },
      });
      expect(await finishWith("auth", r as any, true)).toBe(0);
      expect(calls.some((c) => c[1] === "push")).toBe(false);
      expect(calls.some((c) => c[0] === "gh")).toBe(false);
    }
  });
});

// capture process.stdout.write + process.stderr.write for the duration of fn() (the log module
// writes to stderr, so warn/error wording is only observable here).
async function capture(fn: () => Promise<number>): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

describe("quick finish: no-branch guard", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  async function scaffold(branch: string, startBranch: string) {
    const exec = quickExecDir("auth");
    mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "target_cwd.txt"), "/proj\n");
    writeFileSync(join(exec, "branch.txt"), branch + "\n");
    writeFileSync(join(exec, "start-branch.txt"), startBranch + "\n");
    writeFileSync(join(exec, "finish.txt"), "yes\n");
    writeFileSync(join(quickArtDir("auth"), "task-brief.md"), "## Goal\nX");
    writeFileSync(join(exec, "verify-result.txt"), "PASS (npm test)\n");
    return exec;
  }

  /** `refRc` decides whether the recorded branch actually exists — `quick branch` records the branch
   *  the run ended on, so a missing ref is the branch that went away between branch and finish.
   *  `head` is where the run really is after the restore checkout (which can fail silently). */
  function fakeGit(refRc: number, head = "main"): { r: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git show-ref --verify --quiet refs/heads/feat/quick-auth") return { code: refRc, stdout: "" };
      if (k === "git symbolic-ref HEAD") return head ? { code: 0, stdout: `refs/heads/${head}\n` } : { code: 128, stdout: "" };
      if (k === "git remote") return { code: 0, stdout: "origin\n" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }

  function hubFlags(): string[] {
    const root = join(h.home, "forensics");
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((d) => readdirSync(join(root, d)).map((f) => readFileSync(join(root, d, f), "utf8")));
  }

  it("recorded branch has no ref: refuses, pushes NOTHING, records none/no-branch + a hub flag", async () => {
    const exec = await scaffold("feat/quick-auth", "main");
    const { r, calls } = fakeGit(1);
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(calls.some((c) => c[1] === "push")).toBe(false);
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("none\tno-branch\n");
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
    expect(hubFlags().join("")).toContain("finish-no-branch");
  });

  // Both refusal cases pin the COMMAND-level guard: without it the finisher's own guard would still
  // produce the none/no-branch record, but neither the restore checkout nor the flag.
  it("recorded branch IS the start branch: same refusal, no ref probe needed", async () => {
    const exec = await scaffold("main", "main");
    const { r, calls } = fakeGit(0);
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(calls.some((c) => c[1] === "push")).toBe(false);
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("none\tno-branch\n");
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
    expect(hubFlags().join("")).toContain("finish-no-branch");
  });

  it("a record that IS the start branch: recover names a branch to CREATE, not the one already checked out", async () => {
    await scaffold("main", "main");
    const { r } = fakeGit(0);
    const { err } = await capture(() => finishWith("auth", r, true));
    expect(err).toContain("git checkout -b feat/quick-auth");
    expect(err).not.toContain("git checkout -b main");
  });

  it("refusal warns (rc 0, not an error) and names the recorded branch in the recover line", async () => {
    await scaffold("feat/quick-auth", "main");
    const { r } = fakeGit(1);
    const { rc, err } = await capture(() => finishWith("auth", r, true));
    expect(rc).toBe(0);
    expect(err).toContain("[WARN]");
    expect(err).not.toContain("[FAIL]");
    expect(err).toContain("git checkout -b feat/quick-auth");
    expect(err).not.toContain("<branch>");
  });

  it("an unrecorded branch still names a concrete recover command (the topic-derived one)", async () => {
    await scaffold("", "main");
    const { r } = fakeGit(1);
    const { err } = await capture(() => finishWith("auth", r, true));
    expect(err).toContain("git checkout -b feat/quick-auth");
    expect(hubFlags().join("")).toContain("'(unrecorded)'");
  });

  it("the restore checkout failed: the flag names where HEAD actually is, not the start branch", async () => {
    const exec = await scaffold("feat/quick-auth", "main");
    const { r } = fakeGit(1, "feat/quick-auth");   // checkout blocked by a dirty tree
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(hubFlags().join("")).toContain("the work (if any) is on 'feat/quick-auth'");
    // The same read-back HEAD is persisted for the summary, which cannot re-probe git.
    expect(readFileSync(join(exec, "finish-head.txt"), "utf8")).toBe("feat/quick-auth\n");
  });

  it("detached HEAD after the refusal: reported as (detached), never as the start branch", async () => {
    const exec = await scaffold("feat/quick-auth", "main");
    const { r } = fakeGit(1, "");
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(hubFlags().join("")).toContain("the work (if any) is on '(detached)'");
    expect(readFileSync(join(exec, "finish-head.txt"), "utf8")).toBe("(detached)\n");
  });

  it("healthy distinct branch: the guard passes and the finish proceeds", async () => {
    const exec = await scaffold("feat/quick-auth", "main");
    const { r, calls } = fakeGit(0);
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(calls.some((c) => c.join(" ") === "git push -q -u origin feat/quick-auth")).toBe(true);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("pr\tpr-opened\n");
    expect(hubFlags()).toEqual([]);
  });
});

describe("quick branch: branch.txt records the branch the run ACTUALLY ended on", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); mkdirSync(quickExecDir("auth"), { recursive: true }); });
  afterEach(() => { h.cleanup(); });

  /** A clean repo on `head`. `refExists` seeds a leftover feat/quick-auth from an EARLIER run (the
   *  shape that makes the finish guard's ref probe pass), `checkoutOk` whether THIS run's checkout
   *  lands. An empty `head` is a detached HEAD. */
  function fakeRepo(o: { refExists?: boolean; checkoutOk?: boolean; head?: string } = {}): { r: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const head = o.head ?? "main";
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git rev-parse --git-dir") return { code: 0, stdout: ".git" };
      if (k === "git symbolic-ref HEAD") return head ? { code: 0, stdout: `refs/heads/${head}` } : { code: 128, stdout: "" };
      if (k === "git rev-parse HEAD") return { code: 0, stdout: "base000" };
      if (k === "git status --porcelain") return { code: 0, stdout: "" };
      if (k === "git show-ref --verify --quiet refs/heads/feat/quick-auth") return { code: o.refExists ? 0 : 1, stdout: "" };
      if (args[0] === "checkout" && args.includes("feat/quick-auth")) return { code: o.checkoutOk === false ? 1 : 0, stdout: "" };
      if (k === "git remote") return { code: 0, stdout: "origin\n" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }

  const branchTxt = () => readFileSync(join(quickExecDir("auth"), "branch.txt"), "utf8");

  it("checkout landed: the intended name, as before", async () => {
    const { r } = fakeRepo();
    expect(await branchWith("auth", "/proj", r)).toBe(0);
    expect(branchTxt()).toBe("feat/quick-auth\n");
  });

  it("checkout failed: the START branch is recorded, and the warn line still names both", async () => {
    const { r } = fakeRepo({ checkoutOk: false });
    const { rc, err } = await capture(() => branchWith("auth", "/proj", r));
    expect(rc).toBe(0);
    expect(branchTxt()).toBe("main\n");
    expect(err).toContain("quick branch: checkout feat/quick-auth failed; staying on main");
  });

  it("the trailing ok line still names the INTENDED branch — deliberately not a third visible change", async () => {
    const { r } = fakeRepo({ checkoutOk: false });
    const { err } = await capture(() => branchWith("auth", "/proj", r));
    expect(err).toContain("quick branch: feat/quick-auth (snapshot=clean");
  });

  it("checkout failed from a detached HEAD: recorded as (detached), never as the intended name", async () => {
    const { r } = fakeRepo({ checkoutOk: false, head: "" });
    expect(await branchWith("auth", "/proj", r)).toBe(0);
    expect(branchTxt()).toBe("(detached)\n");
  });

  it("STALE REF: a leftover feat/quick-auth + a failed checkout for THIS run → finish refuses, pushes NOTHING", async () => {
    // The A1-review reproduction: the leftover ref passes the finish guard's show-ref probe, so an
    // intended-name record hands it a PR whose head contains none of this run's work.
    const exec = quickExecDir("auth");
    const cut = fakeRepo({ refExists: true, checkoutOk: false });
    expect(await branchWith("auth", "/proj", cut.r)).toBe(0);
    expect(branchTxt()).toBe("main\n");

    writeFileSync(join(exec, "finish.txt"), "yes\n");
    writeFileSync(join(quickArtDir("auth"), "task-brief.md"), "## Goal\nX");
    writeFileSync(join(exec, "verify-result.txt"), "PASS (npm test)\n");
    const fin = fakeRepo({ refExists: true });   // the leftover ref is still there at finish time
    expect(await finishWith("auth", fin.r, true)).toBe(0);
    expect(fin.calls.some((c) => c[1] === "push")).toBe(false);
    expect(fin.calls.some((c) => c[0] === "gh")).toBe(false);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("none\tno-branch\n");
  });
});

describe("quick finish: --stash-wip restore", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  const STASH_LIST = "git stash list --format=%gd%x09%gs";

  async function scaffold(finishFlag: string, markerBody?: string) {
    const exec = quickExecDir("auth");
    mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "target_cwd.txt"), "/proj\n");
    writeFileSync(join(exec, "branch.txt"), "feat/quick-auth\n");
    writeFileSync(join(exec, "start-branch.txt"), "main\n");
    writeFileSync(join(exec, "finish.txt"), finishFlag + "\n");
    writeFileSync(join(quickArtDir("auth"), "task-brief.md"), "## Goal\nX");
    writeFileSync(join(exec, "verify-result.txt"), "PASS (npm test)\n");
    if (markerBody !== undefined) writeFileSync(join(exec, "stash-wip.txt"), markerBody);
    return exec;
  }

  /** `head`/`headRc` model where the start-branch checkout actually LANDED (it can fail silently),
   *  `listRc` an unreadable stash list, `sha` the entry's real identity. */
  function fakeGit(o: { entries?: string; popOk?: boolean; head?: string; headRc?: number; listRc?: number; sha?: string } = {}): { r: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git symbolic-ref HEAD") return { code: o.headRc ?? 0, stdout: o.headRc ? "" : `refs/heads/${o.head ?? "main"}\n` };
      if (k === STASH_LIST) return { code: o.listRc ?? 0, stdout: o.entries ?? "stash@{0}\tOn main: ap-quick-auth-wip\n" };
      if (k === "git rev-parse stash@{0}") return { code: 0, stdout: (o.sha ?? "stash999") + "\n" };
      if (args[0] === "stash" && args[1] === "pop") return { code: o.popOk === false ? 1 : 0, stdout: "" };
      if (k === "git remote") return { code: 0, stdout: "origin\n" };
      if (k === "git push -q -u origin feat/quick-auth") return { code: 0, stdout: "" };
      if (k === "git remote get-url origin") return { code: 0, stdout: "url\n" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }

  /** The hub flags restoreStashWip writes for /ap:review — under AP_HOME/forensics/<date>/. */
  function hubFlags(): string[] {
    const root = join(h.home, "forensics");
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((d) => readdirSync(join(root, d)).map((f) => readFileSync(join(root, d, f), "utf8")));
  }
  const popped = (calls: string[][]) => calls.some((c) => c[1] === "stash" && c[2] === "pop");

  it("branch-only path (--no-finish): pops after the start-branch checkout, clears the marker", async () => {
    const exec = await scaffold("no", "stash999\tap-quick-auth-wip\n");
    const { r, calls } = fakeGit();
    expect(await finishWith("auth", r, true)).toBe(0);
    const keys = calls.map((c) => c.join(" "));
    expect(keys.indexOf("git checkout -q main")).toBeLessThan(keys.indexOf("git stash pop stash@{0}"));
    expect(existsSync(join(exec, "stash-wip.txt"))).toBe(false);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("none\tbranch-only (kept feat/quick-auth)\n");
  });

  it("finish path: pops after the finisher restored the start branch, clears the marker", async () => {
    const exec = await scaffold("yes", "stash999\tap-quick-auth-wip\n");
    const { r, calls } = fakeGit();
    expect(await finishWith("auth", r, true)).toBe(0);
    const keys = calls.map((c) => c.join(" "));
    expect(keys.indexOf("git checkout -q main")).toBeLessThan(keys.indexOf("git stash pop stash@{0}"));
    expect(existsSync(join(exec, "stash-wip.txt"))).toBe(false);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("pr\tpr-opened\n");
  });

  it("pop conflict: stash NOT dropped, marker kept, stash-wip-kept recorded + flagged for /ap:review", async () => {
    const exec = await scaffold("no", "stash999\tap-quick-auth-wip\n");
    const { r, calls } = fakeGit({ popOk: false });
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(calls.some((c) => c[1] === "stash" && c[2] === "drop")).toBe(false);
    expect(readFileSync(join(exec, "stash-wip.txt"), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("none\tbranch-only (kept feat/quick-auth)\nstash-wip-kept\n");
    expect(hubFlags().join("")).toContain("stash-wip-kept: WIP still stashed as 'ap-quick-auth-wip' in /proj");
  });

  it("WRONG BRANCH (the start-branch checkout failed): refuses to pop, keeps stash + marker, flags it", async () => {
    const exec = await scaffold("no", "stash999\tap-quick-auth-wip\n");
    const { r, calls } = fakeGit({ head: "feat/quick-auth" });
    const { rc, err } = await capture(() => finishWith("auth", r, true));
    expect(rc).toBe(0);
    // The wording the stashPopOnBranch extraction promises to preserve, verbatim.
    expect(err).toContain("quick finish: HEAD is on 'feat/quick-auth', not the start branch 'main' — NOT popping");
    expect(popped(calls)).toBe(false);
    expect(readFileSync(join(exec, "stash-wip.txt"), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toContain("stash-wip-kept");
    expect(hubFlags().join("")).toContain("restore: git checkout main then git stash pop");
  });

  it("DETACHED HEAD (symbolic-ref fails): also not the start branch → no pop, marker kept", async () => {
    const exec = await scaffold("no", "stash999\tap-quick-auth-wip\n");
    const { r, calls } = fakeGit({ headRc: 128 });
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(popped(calls)).toBe(false);
    expect(existsSync(join(exec, "stash-wip.txt"))).toBe(true);
  });

  it("sha mismatch (a foreign same-named stash): no pop, marker kept", async () => {
    const exec = await scaffold("no", "stash999\tap-quick-auth-wip\n");
    const { r, calls } = fakeGit({ sha: "somebodyelse" });
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(popped(calls)).toBe(false);
    expect(readFileSync(join(exec, "stash-wip.txt"), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toContain("stash-wip-kept");
  });

  it("stash list unreadable: list-failed keeps the marker (a failed read is not an absence)", async () => {
    const exec = await scaffold("no", "stash999\tap-quick-auth-wip\n");
    const { r, calls } = fakeGit({ listRc: 128 });
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(popped(calls)).toBe(false);
    expect(readFileSync(join(exec, "stash-wip.txt"), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toContain("stash-wip-kept");
  });

  it("VERIFIED absence (list read fine, entry gone — user popped it): warns, clears the marker, no flag", async () => {
    const exec = await scaffold("no", "stash999\tap-quick-auth-wip\n");
    const { r, calls } = fakeGit({ entries: "stash@{0}\tOn main: something else\n" });
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(popped(calls)).toBe(false);
    expect(existsSync(join(exec, "stash-wip.txt"))).toBe(false);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("none\tbranch-only (kept feat/quick-auth)\n");
    expect(hubFlags()).toEqual([]);
  });

  it("the no-branch REFUSAL also restores the park — the refusal returns early, before the finish path", async () => {
    const exec = await scaffold("yes", "stash999\tap-quick-auth-wip\n");
    writeFileSync(join(exec, "branch.txt"), "main\n");   // what a failed checkout records
    const { r, calls } = fakeGit();
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("none\tno-branch\n");
    expect(calls).toContainEqual(["git", "stash", "pop", "stash@{0}"]);
    expect(existsSync(join(exec, "stash-wip.txt"))).toBe(false);
  });

  it("no marker: no stash calls at all (default path untouched)", async () => {
    await scaffold("no");
    const { r, calls } = fakeGit();
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(calls.some((c) => c[1] === "stash")).toBe(false);
  });

  it("marker with a sha but no message: falls back to the topic-derived stash name, still pops", async () => {
    await scaffold("no", "stash999\n");
    const { r, calls } = fakeGit();
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(calls).toContainEqual(["git", "stash", "pop", "stash@{0}"]);
  });

  it("marker with an unusable sha: identity cannot be proven → no pop, marker kept", async () => {
    const exec = await scaffold("no", "garbage\n");
    const { r, calls } = fakeGit();
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(popped(calls)).toBe(false);
    expect(existsSync(join(exec, "stash-wip.txt"))).toBe(true);
  });
});

// 0.5.64 provider fallback: quick's mirror of `implement set-provider`. The routing file is
// selected-provider.txt (what roundProtocol dispatches by); execute/provider.txt is init's record of
// what was REQUESTED and has no reader, so this verb deliberately leaves it alone.
describe("quick set-provider", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function seed(topic = "auth"): string {
    mkdirSync(quickExecDir(topic), { recursive: true });
    writeFileSync(join(quickArtDir(topic), "selected-provider.txt"), "codex\n");
    writeFileSync(join(quickExecDir(topic), "provider.txt"), "codex\n");
    return quickArtDir(topic);
  }
  function queueRecords(): string[] {
    const dir = forensicsQueueDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(dir, f), "utf8"));
  }

  it("rewrites selected-provider.txt and leaves execute/provider.txt alone", async () => {
    const art = seed();
    const { rc, out } = await captureRun(["set-provider", "auth", "claude"]);
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "selected-provider.txt"), "utf8")).toBe("claude\n");
    expect(readFileSync(join(quickExecDir("auth"), "provider.txt"), "utf8")).toBe("codex\n");
    expect(out).toBe("");
    expect(existsSync(join(art, "provider-fallback.txt"))).toBe(false);
    expect(queueRecords()).toHaveLength(0);
  });

  it("unknown provider → rc 2, routing file untouched", async () => {
    const art = seed();
    const { rc, err } = await captureRun(["set-provider", "auth", "gpt-9"]);
    expect(rc).toBe(2);
    expect(err).toContain("unknown provider 'gpt-9'");
    expect(readFileSync(join(art, "selected-provider.txt"), "utf8")).toBe("codex\n");
  });

  it("no art dir → rc 1 naming init; bad slug and bad arity → rc 2", async () => {
    expect((await captureRun(["set-provider", "auth", "claude"])).rc).toBe(1);
    expect((await captureRun(["set-provider", "auth", "claude"])).err).toContain("run quick init first");
    expect((await captureRun(["set-provider", "../etc", "claude"])).rc).toBe(2);
    expect((await captureRun(["set-provider", "auth"])).rc).toBe(2);
  });

  it("--reason records the switch: artifact line, run-issue flag, PROVIDER= stdout", async () => {
    const art = seed();
    const { rc, out } = await captureRun(["set-provider", "auth", "claude", "--reason", "timeout"]);
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "selected-provider.txt"), "utf8")).toBe("claude\n");
    expect(readFileSync(join(art, "provider-fallback.txt"), "utf8"))
      .toBe("PROVIDER_FALLBACK=codex->claude reason=timeout\n");
    expect(out).toContain("PROVIDER=claude");
    // command + art_dir are what route the record to the RUN's issue rather than a spawn-only one.
    const [rec] = queueRecords();
    expect(rec).toContain("kind: flag");
    expect(rec).toContain("command: quick");
    expect(rec).toContain(`art_dir: ${quickArtDir("auth")}`);
    expect(rec).toContain("PROVIDER_FALLBACK codex->claude reason=timeout");
  });

  // job status prints the line into a KEY=value stream and SUMMARY.md into a markdown bullet, so
  // free text is refused at the write point rather than escaped at each of the three readers.
  it.each(["error_event", "killed", "timeout\nPARKED=yes"])(
    "refuses --reason %j with rc 2, writing nothing", async (reason) => {
      const art = seed();
      const { rc, err } = await captureRun(["set-provider", "auth", "claude", "--reason", reason]);
      expect(rc).toBe(2);
      expect(err).toContain("accepted: pane_dead, timeout");
      expect(readFileSync(join(art, "selected-provider.txt"), "utf8")).toBe("codex\n");
      expect(existsSync(join(art, "provider-fallback.txt"))).toBe(false);
      expect(queueRecords()).toHaveLength(0);
    });

  // The point of the verb: the turn verbs resolve the worker dir through selected-provider.txt, so
  // after the fallback they must find `<agent>-claude` — the dir the re-spawn minted.
  it("turn-send after the fallback resolves the claude worker dir", async () => {
    seed();
    writeFileSync(join(quickArtDir("auth"), "agent.txt"), "bravo\n");
    writeFileSync(join(quickArtDir("auth"), "task-brief.md"), "## Goal\nDo X");
    writeFileSync(join(quickExecDir("auth"), "branch.txt"), "feat/quick-auth\n");
    const pd = workerDir("bravo", "claude", "auth");   // ONLY the claude worker exists
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "outbox.jsonl"), "");

    expect(await turnSendWith("auth", 1, { offsetFor: () => 0, send: async () => 0 })).toBe(1); // codex dir gone
    expect((await captureRun(["set-provider", "auth", "claude", "--reason", "pane_dead"])).rc).toBe(0);
    expect(await turnSendWith("auth", 1, { offsetFor: () => 0, send: async () => 0 })).toBe(0);
  });

  /** run() with stdout+stderr captured — the verb prints PROVIDER= and its refusals. */
  async function captureRun(args: string[]): Promise<{ rc: number; out: string; err: string }> {
    const out: string[] = []; const err: string[] = [];
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((x: string | Uint8Array) => { out.push(String(x)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((x: string | Uint8Array) => { err.push(String(x)); return true; }) as typeof process.stderr.write;
    try { const rc = await quickRun(args); return { rc, out: out.join(""), err: err.join("") }; }
    finally { process.stdout.write = so; process.stderr.write = se; }
  }
});

describe("quick summary", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  async function scaffold(topic: string) {
    const { quickArtDir, quickExecDir } = await import("../src/core/quick.js");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(quickExecDir(topic), { recursive: true });
    const art = quickArtDir(topic), exec = quickExecDir(topic);
    writeFileSync(join(art, "topic.txt"), topic + "\n");
    writeFileSync(join(art, "timing.txt"), "started=2026-05-29T06:00:00Z\n");
    writeFileSync(join(art, "selected-provider.txt"), "codex\n");
    writeFileSync(join(art, "agent.txt"), "bravo\n");
    writeFileSync(join(exec, "branch.txt"), "feat/quick-auth\n");
    writeFileSync(join(exec, "verify-result.txt"), "PASS (npm test)\n");
    writeFileSync(join(exec, "diff-stats.txt"), "2 files changed\n");
    writeFileSync(join(exec, "target_cwd.txt"), "/proj\n");
    writeFileSync(join(exec, "branch-base.sha"), "base000\n");
  }

  it("ok summary → SUMMARY.md with status ok; rc 0", async () => {
    await scaffold("auth");
    expect(await quickRun(["summary", "auth"])).toBe(0);
    const { quickArtDir } = await import("../src/core/quick.js");
    const md = readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8");
    expect(md).toContain("status: ok");
    expect(md).toContain("- Branch: feat/quick-auth");
  });

  it("reads the finish record: a no-branch refusal points at the recorded HEAD, not a checkout hint", async () => {
    await scaffold("auth");
    const exec = quickExecDir("auth");
    writeFileSync(join(exec, "branch.txt"), "main\n");            // what a failed checkout records
    writeFileSync(join(exec, "finish-result.txt"), "none\tno-branch\nstash-wip-kept\n");
    writeFileSync(join(exec, "finish-head.txt"), "main\n");
    expect(await quickRun(["summary", "auth"])).toBe(0);
    const md = readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8");
    expect(md).not.toContain("checkout");
    expect(md).toContain("- Nothing was pushed and no PR was opened — HEAD is on `main` in /proj (diff base: base000)");
    expect(md).toContain("- Branch: main");
  });

  it("a RE-RUN refused for no-branch: the summary names the feat branch HEAD is really on", async () => {
    // HEAD was already on feat/quick-auth when the run branched, so the branch EXISTS and holds the
    // work — the summary must not claim otherwise, and must keep the diff base.
    await scaffold("auth");
    const exec = quickExecDir("auth");
    writeFileSync(join(exec, "start-branch.txt"), "feat/quick-auth\n");
    writeFileSync(join(exec, "finish-result.txt"), "none\tno-branch\n");
    writeFileSync(join(exec, "finish-head.txt"), "feat/quick-auth\n");
    expect(await quickRun(["summary", "auth"])).toBe(0);
    const md = readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8");
    expect(md).toContain("HEAD is on `feat/quick-auth` in /proj (diff base: base000)");
    expect(md).not.toContain("No branch was cut");
  });

  it("aborted summary → SUMMARY.md (aborted) + RESUME.md", async () => {
    await scaffold("auth");
    expect(await quickRun(["summary", "auth", "--aborted", "build", "worker-turn-failed", "turn", "failed", "twice"])).toBe(0);
    const { quickArtDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8")).toContain("status: aborted");
    expect(readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8")).toContain("turn failed twice");
    expect(existsSync(join(quickArtDir("auth"), "RESUME.md"))).toBe(true);
    expect(readFileSync(join(quickArtDir("auth"), "RESUME.md"), "utf8")).not.toContain("Parked WIP");
  });

  // 0.5.64: the fallback is folded into the EXISTING provider string, not a new SummaryFacts field.
  it("after a provider fallback the Provider line names the switch", async () => {
    await scaffold("auth");
    writeFileSync(join(quickArtDir("auth"), "selected-provider.txt"), "claude\n");
    writeFileSync(join(quickArtDir("auth"), "provider-fallback.txt"), "PROVIDER_FALLBACK=codex->claude reason=pane_dead\n");
    expect(await quickRun(["summary", "auth"])).toBe(0);
    const md = readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8");
    expect(md).toContain("- Provider: claude (fallback from codex, reason=pane_dead)");
  });

  it("without the fallback file the Provider line is the plain provider", async () => {
    await scaffold("auth");
    expect(await quickRun(["summary", "auth"])).toBe(0);
    expect(readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8")).toContain("- Provider: codex\n");
  });

  // A fallback whose claude spawn ALSO fails aborts with the same spawn-failed reason as a plain
  // double-codex failure; without this bullet the two SUMMARYs are indistinguishable.
  it("an ABORTED run that fell back still names the switch; one that did not is unchanged", async () => {
    await scaffold("auth");
    writeFileSync(join(quickArtDir("auth"), "selected-provider.txt"), "claude\n");
    writeFileSync(join(quickArtDir("auth"), "provider-fallback.txt"), "PROVIDER_FALLBACK=codex->claude reason=timeout\n");
    expect(await quickRun(["summary", "auth", "--aborted", "build", "spawn-failed", "worker", "failed", "bootstrap"])).toBe(0);
    const md = readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8");
    expect(md).toContain("## Why aborted");
    expect(md).toContain("- Provider: claude (fallback from codex, reason=timeout)");

    await scaffold("plain");
    expect(await quickRun(["summary", "plain", "--aborted", "build", "spawn-failed", "worker", "failed", "bootstrap"])).toBe(0);
    expect(readFileSync(join(quickArtDir("plain"), "SUMMARY.md"), "utf8")).not.toContain("- Provider:");
  });

  it("aborted with a --stash-wip park → RESUME.md points at the stash, checkout FIRST", async () => {
    await scaffold("auth");
    writeFileSync(join(quickExecDir("auth"), "stash-wip.txt"), "stash999\tap-quick-auth-wip\n");
    writeFileSync(join(quickExecDir("auth"), "start-branch.txt"), "main\n");
    expect(await quickRun(["summary", "auth", "--aborted", "build", "worker-turn-failed", "died"])).toBe(0);
    const md = readFileSync(join(quickArtDir("auth"), "RESUME.md"), "utf8");
    expect(md).toContain("## Parked WIP");
    expect(md).toContain("stash 'ap-quick-auth-wip'");
    expect(md).toContain("git -C /proj checkout main  then  git stash pop <ref>");
  });
});

// ---- brief lint (2026-08-23-brief-path-correctness-design.md, C2) ----
// `quick branch` warn-lints the hub's task-brief for two classes of path citation that cannot
// resolve where the WORKER will stand, records its own verdict in execute/brief-lint.txt, and files
// exactly ONE forensics flag — for the state-relative class only. rc is untouched throughout.
describe("quick branch: brief lint", () => {
  let h: { home: string; cleanup: () => void };
  let target: string;
  beforeEach(() => {
    h = freshHome();
    mkdirSync(quickArtDir("auth"), { recursive: true });
    mkdirSync(quickExecDir("auth"), { recursive: true });
    // A target checkout that is NOT this repo: every repo-relative path is missing there.
    target = mkdtempSync(join(tmpdir(), "ap-brief-tgt-"));
  });
  afterEach(() => { rmSync(target, { recursive: true, force: true }); h.cleanup(); });

  function okRepo(): Runner {
    return { run(cmd, args) {
      const k = [cmd, ...args].join(" ");
      if (k === "git rev-parse --git-dir") return { code: 0, stdout: ".git" };
      if (k === "git symbolic-ref HEAD") return { code: 0, stdout: "refs/heads/main" };
      if (k === "git rev-parse HEAD") return { code: 0, stdout: "base000" };
      return { code: 0, stdout: "" };
    } };
  }
  function brief(body: string) { writeFileSync(join(quickArtDir("auth"), "task-brief.md"), body); }
  const lintFile = () => join(quickExecDir("auth"), "brief-lint.txt");
  /** Every forensics feed this run wrote, under the fresh AP_HOME. */
  function flags(): string[] {
    const root = join(h.home, "forensics");
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const d of readdirSync(root)) for (const f of readdirSync(join(root, d))) out.push(f);
    return out;
  }

  it("both classes: rc 0, both warns on stderr, both in brief-lint.txt, EXACTLY ONE flag", async () => {
    brief([
      "## Goal", "Rename the guard.", "",
      "## Acceptance check", "the repo's tests pass", "",
      "## Touch-points",
      "`src/core/implementScope.ts` (exists)",
      "read the cleaned topic from `_quick/topic-text.txt`",
    ].join("\n"));
    const { rc, err } = await capture(() => branchWith("auth", target, okRepo()));
    expect(rc).toBe(0);

    // 1. invisible: present in this checkout, absent in the target.
    expect(err).toContain("brief cites src/core/implementScope.ts, which exists in");
    expect(err).toContain(`NOT in the target ${target}`);
    // 2. state-relative: never correct, regardless of what exists anywhere.
    expect(err).toContain("brief cites the state path _quick/topic-text.txt RELATIVE");

    const rec = readFileSync(lintFile(), "utf8");
    expect(rec).toContain("INVISIBLE_IN_TARGET=1\nINVISIBLE_PATH=src/core/implementScope.ts\n");
    expect(rec).toContain("STATE_RELATIVE=1\nSTATE_RELATIVE_PATH=_quick/topic-text.txt\n");
    expect(rec).toContain(`TARGET_CWD=${target}\n`);

    // EXACTLY ONE flag, and it is the state-relative one. The invisible class warns and records
    // without a flag: a brief may legitimately cite a file that exists here and is about to be made
    // there, so flagging it would train /ap:review to ignore the channel.
    const f = flags();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/-auth-.*-flag-.*\.md$/);
    expect(readFileSync(join(forensicsQueueDir(), f[0]), "utf8")).toContain("brief-state-relative");
  });

  it("a bare state filename in prose warns, records, and files one flag", async () => {
    brief(["## Goal", "Read topic-text.txt next to this file before coding."].join("\n"));
    const { rc, err } = await capture(() => branchWith("auth", target, okRepo()));
    expect(rc).toBe(0);
    expect(err).toContain("brief cites the state path topic-text.txt RELATIVE");
    expect(readFileSync(lintFile(), "utf8")).toContain("STATE_RELATIVE_PATH=topic-text.txt\n");

    const f = flags();
    expect(f).toHaveLength(1);
    expect(readFileSync(join(forensicsQueueDir(), f[0]), "utf8")).toContain("topic-text.txt");
  });

  it("a prohibition-only relative state path warns and records without a flag", async () => {
    brief(["## Constraints", "Never touch .ap/worktrees/launch-the-refreshed (LIVE training run)."].join("\n"));
    const { rc, err } = await capture(() => branchWith("auth", target, okRepo()));
    expect(rc).toBe(0);
    expect(err).toContain("brief constrains the state path .ap/worktrees/launch-the-refreshed RELATIVE");
    expect(readFileSync(lintFile(), "utf8")).toContain(
      "STATE_RELATIVE=0\nCONSTRAINT_RELATIVE=1\nCONSTRAINT_RELATIVE_PATH=.ap/worktrees/launch-the-refreshed\n",
    );
    expect(flags()).toHaveLength(0);
  });

  it("mixed citation and prohibition files one flag naming only the citation path", async () => {
    brief([
      "## Goal", "Read the cleaned topic from _quick/topic-text.txt.",
      "## Constraints", "Do not touch .ap/worktrees/live-run.",
    ].join("\n"));
    const { rc, err } = await capture(() => branchWith("auth", target, okRepo()));
    expect(rc).toBe(0);
    expect(err).toContain("brief cites the state path _quick/topic-text.txt RELATIVE");
    expect(err).toContain("brief constrains the state path .ap/worktrees/live-run RELATIVE");

    const rec = readFileSync(lintFile(), "utf8");
    expect(rec).toContain("STATE_RELATIVE=1\nSTATE_RELATIVE_PATH=_quick/topic-text.txt\n");
    expect(rec).toContain("CONSTRAINT_RELATIVE=1\nCONSTRAINT_RELATIVE_PATH=.ap/worktrees/live-run\n");
    const f = flags();
    expect(f).toHaveLength(1);
    const flag = readFileSync(join(forensicsQueueDir(), f[0]), "utf8");
    expect(flag).toContain("_quick/topic-text.txt");
    expect(flag).not.toContain(".ap/worktrees/live-run");
  });

  it("a clean brief: no warns, no flag, but the verdict is still recorded", async () => {
    brief(["## Goal", "Rename the guard.", "", "## Touch-points", `${join(target, "new.ts")} (new)`].join("\n"));
    const { rc, err } = await capture(() => branchWith("auth", target, okRepo()));
    expect(rc).toBe(0);
    expect(err).not.toContain("brief cites");
    expect(readFileSync(lintFile(), "utf8")).toContain("INVISIBLE_IN_TARGET=0\nSTATE_RELATIVE=0\n");
    expect(flags()).toHaveLength(0);
  });

  it("an ABSOLUTE state path is not the state-relative class — that is the fix being asked for", async () => {
    brief(["## Goal", "g", "", "## Touch-points", `${join(h.home, "state", "abc", "auth", "_quick", "topic-text.txt")} (exists)`].join("\n"));
    const { rc, err } = await capture(() => branchWith("auth", target, okRepo()));
    expect(rc).toBe(0);
    expect(err).not.toContain("RELATIVE");
    expect(readFileSync(lintFile(), "utf8")).toContain("STATE_RELATIVE=0\n");
    expect(flags()).toHaveLength(0);
  });

  // The lint runs AFTER the target_cwd.txt write, so the not-a-git-repo abort (rc 1) records NOTHING
  // — no brief-lint.txt for a run that never started.
  it("not-git abort: rc 1 and no brief-lint.txt at all", async () => {
    brief(["## Touch-points", "`_quick/topic-text.txt`"].join("\n"));
    const dead: Runner = { run: () => ({ code: 128, stdout: "" }) };
    expect(await branchWith("auth", target, dead)).toBe(1);
    expect(existsSync(lintFile())).toBe(false);
    expect(flags()).toHaveLength(0);
  });

  it("no brief on disk: nothing is linted and nothing is recorded", async () => {
    expect(await branchWith("auth", target, okRepo())).toBe(0);
    expect(existsSync(lintFile())).toBe(false);
    expect(flags()).toHaveLength(0);
  });
});

import { dispatch } from "../src/core/dispatch.js";

describe("quick init: a consumed args file", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("names the missing path and the re-mint hint on stderr, rc 2 — never 'topic text is empty'", async () => {
    const gone = join(h.home, "consumed-args");
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { errs.push(String(s)); return true; };
    let rc = -1;
    try { rc = await dispatch(quickRun, ["init", "--args-file", gone]); }
    finally { (process.stderr as any).write = orig; }
    expect(rc).toBe(2);
    // toContain, not toBe: outside a git repo, repoRoot()'s child `git` echoes its own `fatal:` line
    // onto stderr first; the claim here is the message, not that nothing else was said.
    expect(errs.join("")).toContain(`args file not found: ${gone} (a one-shot args file is consumed by the first init that reads it; re-mint with --mint-args-file)\n`);
  });
});

import { randomUUID } from "node:crypto";
import { paneMetaWrite } from "../src/core/ipc.js";
import { topicDir, repoHash } from "../src/core/paths.js";
import { prepareWorkerState } from "../src/commands/spawn.js";
import { runnerAt } from "../src/core/gitwork.js";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

describe("quick init: a predecessor that initialised but never reached a worker turn", () => {
  let h: { home: string; cleanup: () => void };
  let outSpy: ReturnType<typeof captureStdout>;
  beforeEach(() => { h = freshHome(); outSpy = captureStdout(); });
  afterEach(() => { outSpy.restore(); h.cleanup(); });

  const TOPIC = "stale-topic";
  const ARGS = ["stale", "topic", "--provider", "codex"];
  /** tmux answered: the hub's own pane is in the snapshot. */
  const ANSWERED = () => new Map([["%0", randomUUID()]]);
  function deps(o: { panes?: Map<string, string>; sha?: string } = {}): InitDeps {
    return {
      haveCmd: () => true, agentBinary: () => "codex", pickRandomAgent: () => "charlie",
      livePanes: async () => o.panes ?? ANSWERED(), branchSha: () => o.sha ?? "base000",
    };
  }
  /** What init + branch leave behind before any turn: the init records plus the branch snapshot. */
  function seedPredecessor(opts: { branched: boolean } = { branched: true }): string {
    const art = quickArtDir(TOPIC); const exec = quickExecDir(TOPIC);
    mkdirSync(exec, { recursive: true });
    writeFileSync(join(art, "topic.txt"), TOPIC + "\n");
    writeFileSync(join(art, "topic-text.txt"), "stale topic (first attempt)");
    writeFileSync(join(art, "agent.txt"), "bravo\n");
    writeFileSync(join(art, "selected-provider.txt"), "codex\n");
    if (opts.branched) {
      writeFileSync(join(exec, "branch-base.sha"), "base000\n");
      writeFileSync(join(exec, "target_cwd.txt"), "/proj\n");
      writeFileSync(join(exec, "branch.txt"), "feat/quick-stale-topic\n");
    }
    return art;
  }
  /** A worker that REPORTED (last_event is an outbox event, not the platform's `spawn` seed). */
  function seedWorker(status: string, paneId = "%9", nonce: string = randomUUID(), lastEvent = "progress"): string {
    const wd = workerDir("bravo", "codex", TOPIC);
    mkdirSync(wd, { recursive: true });
    if (paneId) paneMetaWrite("bravo", "codex", TOPIC, paneId, nonce);
    writeFileSync(join(wd, "status.json"), `{"state":"${status}","last_event":"${lastEvent}"}`);
    return nonce;
  }
  const staleDirs = () => readdirSync(topicDir(TOPIC)).filter((n) => n.startsWith("_quick.stale-"));
  const archivedWorkers = () => { const d = join(h.home, "archive", repoHash(), TOPIC); return existsSync(d) ? readdirSync(d) : []; };

  it("no turn record, feat branch at its base, worker never spawned → archived to _quick.stale-<agent>-<utc-ts>, named on stdout, init proceeds", async () => {
    const art = seedPredecessor();
    expect(await initWith(ARGS, deps({ panes: new Map() }))).toBe(0); // no worker dir: the snapshot is not even consulted
    const [dir, ...more] = staleDirs();
    expect(more).toEqual([]);
    expect(dir).toMatch(/^_quick\.stale-bravo-\d{8}T\d{6}Z$/);
    expect(readFileSync(join(topicDir(TOPIC), dir, "topic-text.txt"), "utf8")).toBe("stale topic (first attempt)");
    expect(readFileSync(join(topicDir(TOPIC), dir, "execute", "branch-base.sha"), "utf8").trim()).toBe("base000");
    expect(readFileSync(join(art, "topic-text.txt"), "utf8")).toBe("stale topic");
    expect(readFileSync(join(art, "agent.txt"), "utf8").trim()).toBe("charlie");
    expect(existsSync(join(art, "execute", "branch-base.sha"))).toBe(false); // a fresh run, not a resumed one
    expect(outSpy.text()).toContain(`ARCHIVED_STALE=${join(topicDir(TOPIC), dir)}\n`);
    expect(outSpy.text()).not.toContain("ARCHIVED_STALE_WORKER=");
    expect(outSpy.text()).toMatch(/^SLUG=stale-topic$/m);
  });

  it("tmux answered and the recorded pane is gone, status idle → not live: _quick AND the worker dir are archived, the agent is free again", async () => {
    seedPredecessor();
    seedWorker("idle");
    expect(await initWith(ARGS, deps())).toBe(0);
    expect(staleDirs()).toHaveLength(1);
    expect(existsSync(workerDir("bravo", "codex", TOPIC))).toBe(false);
    const [w, ...more] = archivedWorkers();
    expect(more).toEqual([]);
    expect(w).toMatch(/^bravo-codex-\d{8}T\d{6}Z-stale$/);
    expect(outSpy.text()).toContain(`ARCHIVED_STALE_WORKER=${join(h.home, "archive", repoHash(), TOPIC, w)}\n`);
  });

  it("the recorded pane id is live under a DIFFERENT nonce (tmux recycled it) → gone → archived", async () => {
    seedPredecessor();
    seedWorker("idle", "%9");
    expect(await initWith(ARGS, deps({ panes: new Map([["%9", randomUUID()]]) }))).toBe(0);
    expect(staleDirs()).toHaveLength(1);
  });

  it("a spawn that died leaves status error (bootstrap-failed) with its pane gone → not live → archived", async () => {
    seedPredecessor();
    seedWorker("error", "%9", randomUUID(), "bootstrap-failed");
    expect(await initWith(ARGS, deps())).toBe(0);
    expect(staleDirs()).toHaveLength(1);
  });

  it("the branch step never ran (no branch-base.sha) → untouched, archived", async () => {
    seedPredecessor({ branched: false });
    expect(await initWith(ARGS, deps({ sha: "" }))).toBe(0);
    expect(staleDirs()).toHaveLength(1);
  });

  it("the feat branch ref is gone (probe answers \"\") → untouched, archived", async () => {
    seedPredecessor();
    expect(await initWith(ARGS, deps({ sha: "" }))).toBe(0);
    expect(staleDirs()).toHaveLength(1);
  });

  it("the branch probe is asked about the predecessor's own target and branch", async () => {
    seedPredecessor();
    let seen: string[] = [];
    expect(await initWith(ARGS, { ...deps(), branchSha: (cwd, branch) => { seen = [cwd, branch]; return "base000"; } })).toBe(0);
    expect(seen).toEqual(["/proj", "feat/quick-stale-topic"]);
  });

  it("a pre-init flag AND a stale predecessor: findings.log + issue.txt carry into the new run and stay in the archive", async () => {
    expect(runFlag("quick", TOPIC, "spawn died")).toBe(0);
    const art = seedPredecessor();
    const log0 = readFileSync(join(art, "findings.log"), "utf8");
    const issue0 = readFileSync(join(art, "issue.txt"), "utf8");
    expect(await initWith(ARGS, deps())).toBe(0);
    const [dir] = staleDirs();
    expect(readFileSync(join(art, "findings.log"), "utf8")).toBe(log0);
    expect(readFileSync(join(art, "issue.txt"), "utf8")).toBe(issue0);
    expect(readFileSync(join(topicDir(TOPIC), dir, "findings.log"), "utf8")).toBe(log0);
    expect(readFileSync(join(topicDir(TOPIC), dir, "issue.txt"), "utf8")).toBe(issue0);
    expect(readFileSync(join(art, "topic-text.txt"), "utf8")).toBe("stale topic");
  });

  it("ANY turn record keeps the refusal: rc 2, nothing archived, the predecessor untouched", async () => {
    const art = seedPredecessor();
    writeFileSync(join(quickExecDir(TOPIC), "turn-1.txt"), "OFFSET=0\n");
    expect(await initWith(ARGS, deps())).toBe(2);
    expect(staleDirs()).toEqual([]);
    expect(readFileSync(join(art, "topic-text.txt"), "utf8")).toBe("stale topic (first attempt)");
    expect(outSpy.text()).not.toContain("ARCHIVED_STALE");
  });

  it("the feat branch moved past its base keeps the refusal", async () => {
    seedPredecessor();
    expect(await initWith(ARGS, deps({ sha: "moved01" }))).toBe(2);
    expect(staleDirs()).toEqual([]);
  });

  it("a worker whose status is `working` (any case) keeps the refusal, pane or no pane", async () => {
    for (const state of ["working", "Working"]) {
      seedPredecessor();
      seedWorker(state);
      expect(await initWith(ARGS, deps())).toBe(2);
      expect(staleDirs()).toEqual([]);
      expect(existsSync(workerDir("bravo", "codex", TOPIC))).toBe(true);
      rmSync(workerDir("bravo", "codex", TOPIC), { recursive: true, force: true });
    }
  });

  it("a worker that still owns its pane keeps the refusal even with an idle status", async () => {
    seedPredecessor();
    const nonce = seedWorker("idle", "%9");
    expect(await initWith(ARGS, deps({ panes: new Map([["%9", nonce]]) }))).toBe(2);
    expect(staleDirs()).toEqual([]);
  });

  it("tmux gave no answer (empty snapshot) while a pane is recorded → cannot prove it gone → refusal", async () => {
    seedPredecessor();
    seedWorker("idle", "%9");
    expect(await initWith(ARGS, deps({ panes: new Map() }))).toBe(2);
    expect(staleDirs()).toEqual([]);
    expect(existsSync(workerDir("bravo", "codex", TOPIC))).toBe(true);
  });

  it("a pre-nonce pane.json whose id is live → cannot say whose → refusal", async () => {
    seedPredecessor();
    seedWorker("idle", "%9", "");
    expect(await initWith(ARGS, deps({ panes: new Map([["%9", randomUUID()]]) }))).toBe(2);
    expect(staleDirs()).toEqual([]);
  });

  it("a record that cannot name its agent, or its provider, is not this case: the refusal stands", async () => {
    for (const f of ["agent.txt", "selected-provider.txt"]) {
      const art = seedPredecessor();
      rmSync(join(art, f));
      expect(await initWith(ARGS, deps())).toBe(2);
      expect(staleDirs()).toEqual([]);
      rmSync(art, { recursive: true, force: true });
    }
  });

  it("A1: a detached job record for the topic (Stage 0: no worker dir yet) holds the refusal, record intact", async () => {
    const art = seedPredecessor();
    const p = jobPath(TOPIC);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, formatJob({
      command: "quick", topic: TOPIC, session: "ap-stale-topic", hub: { agent: "november", model: "claude" },
      provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5, args_file: "/tmp/args", started: "2026-09-02T00:00:00Z",
    }));
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { errs.push(String(s)); return true; };
    try { expect(await initWith(ARGS, deps())).toBe(2); }
    finally { (process.stderr as any).write = orig; }
    expect(staleDirs()).toEqual([]);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(join(art, "topic-text.txt"), "utf8")).toBe("stale topic (first attempt)");
    expect(outSpy.text()).not.toContain("ARCHIVED_STALE");
    expect(errs.join("")).toContain(`ap job stop ${TOPIC}`);   // `/ap:stop <topic>` refuses while the record exists
  });

  it("A2: a SIBLING worker dir (a job hub, not the recorded pair) with a live nonce-verified pane holds, busy or idle", async () => {
    for (const state of ["working", "idle"]) {
      seedPredecessor();
      const wd = workerDir("november", "claude", TOPIC);
      mkdirSync(wd, { recursive: true });
      const nonce = randomUUID();
      paneMetaWrite("november", "claude", TOPIC, "%4", nonce);
      writeFileSync(join(wd, "status.json"), `{"state":"${state}","last_event":"ack"}`);
      expect(await initWith(ARGS, deps({ panes: new Map([["%4", nonce]]) }))).toBe(2);
      expect(staleDirs()).toEqual([]);
      expect(existsSync(join(wd, "pane.json"))).toBe(true);
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("A3: a worker dir the REAL prepareWorkerState just seeded (idle/spawn, no pane.json: the spawn window) holds, dir intact", async () => {
    seedPredecessor();
    prepareWorkerState("bravo", "codex", TOPIC);
    const wd = workerDir("bravo", "codex", TOPIC);
    expect(existsSync(join(wd, "pane.json"))).toBe(false);
    expect(await initWith(ARGS, deps())).toBe(2);
    expect(staleDirs()).toEqual([]);
    expect(existsSync(join(wd, "identity.md"))).toBe(true);
    expect(readFileSync(join(wd, "status.json"), "utf8")).toMatch(/"last_event":"spawn"/);
    expect(archivedWorkers()).toEqual([]);
  });

  it("A4: a busy status (blocked / question) holds with no pane record, and holds even when its pane is proven gone", async () => {
    for (const state of ["blocked", "question"]) {
      seedPredecessor();
      seedWorker(state, "");           // no pane.json
      expect(await initWith(ARGS, deps())).toBe(2);
      expect(staleDirs()).toEqual([]);
      rmSync(workerDir("bravo", "codex", TOPIC), { recursive: true, force: true });
    }
    seedPredecessor();
    seedWorker("blocked", "%9");       // pane recorded; the snapshot answers without it
    expect(await initWith(ARGS, deps())).toBe(2);
    expect(staleDirs()).toEqual([]);
    expect(existsSync(workerDir("bravo", "codex", TOPIC))).toBe(true);
  });

  it("A: a reported worker with no pane record (never split) holds too — absence of a record is not death", async () => {
    seedPredecessor();
    seedWorker("idle", "");
    expect(await initWith(ARGS, deps())).toBe(2);
    expect(staleDirs()).toEqual([]);
  });

  it("C: the pool refusal (rc 1) precedes the archive — a non-zero init changes nothing", async () => {
    const art = seedPredecessor();
    expect(await initWith(ARGS, { ...deps(), pickRandomAgent: () => null })).toBe(1);
    expect(readFileSync(join(art, "topic-text.txt"), "utf8")).toBe("stale topic (first attempt)");
    expect(staleDirs()).toEqual([]);
    expect(outSpy.text()).not.toContain("ARCHIVED_STALE");
  });

  it("A: a dead worker is archived BY ITS DIR NAME, whatever its pane.json claims (even a traversal model): the topic dir stays put", async () => {
    seedPredecessor();
    const wd = join(topicDir(TOPIC), "weirdname");
    mkdirSync(wd, { recursive: true });
    writeFileSync(join(wd, "pane.json"), JSON.stringify({ pane_id: "%9", pane_nonce: randomUUID(), agent: "bravo", model: "../..", spawned_at: "2026-09-02T00:00:00Z" }) + "\n");
    writeFileSync(join(wd, "status.json"), '{"state":"idle","last_event":"done"}');
    expect(await initWith(ARGS, deps())).toBe(0);
    expect(existsSync(wd)).toBe(false);
    expect(archivedWorkers()).toEqual([expect.stringMatching(/^weirdname-\d{8}T\d{6}Z-stale$/)]);
    expect(existsSync(join(quickArtDir(TOPIC), "topic-text.txt"))).toBe(true);   // the topic dir and the new run are where they were
    expect(staleDirs()).toHaveLength(1);
  });

  it("A: EVERY proven-dead worker dir is archived, not just the recorded pair", async () => {
    seedPredecessor();
    seedWorker("idle", "%9", randomUUID(), "done");
    const wd2 = workerDir("november", "claude", TOPIC);
    mkdirSync(wd2, { recursive: true });
    paneMetaWrite("november", "claude", TOPIC, "%8", randomUUID());
    writeFileSync(join(wd2, "status.json"), '{"state":"done","last_event":"done"}');
    expect(await initWith(ARGS, deps())).toBe(0);
    expect(archivedWorkers().sort()).toEqual([expect.stringMatching(/^bravo-codex-\d{8}T\d{6}Z-stale$/), expect.stringMatching(/^november-claude-\d{8}T\d{6}Z-stale$/)]);
    expect(outSpy.text().match(/ARCHIVED_STALE_WORKER=/g)).toHaveLength(2);
    expect(existsSync(wd2)).toBe(false);
  });

  it("A: the platform's spawn seed (last_event spawn) holds even when its pane is proven gone — a spawn killed mid-way is not a death verdict", async () => {
    seedPredecessor();
    seedWorker("idle", "%9", randomUUID(), "spawn");
    expect(await initWith(ARGS, deps())).toBe(2);
    expect(staleDirs()).toEqual([]);
  });

  it("A: a zero-length status.json (the O_TRUNC crash remnant) reads as busy → hold", async () => {
    seedPredecessor();
    seedWorker("idle");
    writeFileSync(join(workerDir("bravo", "codex", TOPIC), "status.json"), "");
    expect(await initWith(ARGS, deps())).toBe(2);
    expect(staleDirs()).toEqual([]);
  });

  it("A: an empty worker dir (prepareWorkerState's first instant: no status, no pane) holds", async () => {
    seedPredecessor();
    mkdirSync(workerDir("bravo", "codex", TOPIC), { recursive: true });
    expect(await initWith(ARGS, deps())).toBe(2);
    expect(staleDirs()).toEqual([]);
  });

  it("agent.txt naming a traversal segment is not an agent: the refusal stands, nothing renamed", async () => {
    const art = seedPredecessor();
    writeFileSync(join(art, "agent.txt"), "../../x\n");
    expect(await initWith(ARGS, deps())).toBe(2);
    expect(staleDirs()).toEqual([]);
    expect(existsSync(join(art, "topic-text.txt"))).toBe(true);
  });
});

describe("quick init: a stale archive keeps the predecessor's git side effects recoverable (real git)", () => {
  let h: { home: string; cleanup: () => void };
  let outSpy: ReturnType<typeof captureStdout>;
  const roots: string[] = [];
  beforeEach(() => { h = freshHome(); outSpy = captureStdout(); });
  afterEach(() => { outSpy.restore(); h.cleanup(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

  const TOPIC = "retry-topic";
  const BRANCH = "feat/quick-retry-topic";
  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  }
  function repo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-retry-")));
    roots.push(root);
    git(root, "init", "-q");
    git(root, "symbolic-ref", "HEAD", "refs/heads/main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "ap tests");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "README.md"), "hello\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    return root;
  }
  const realDeps = (): InitDeps => ({
    haveCmd: () => true, agentBinary: () => "codex", pickRandomAgent: () => "bravo",
    livePanes: async () => new Map([["%0", randomUUID()]]),
    branchSha: (cwd, b) => { try { return git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`); } catch { return ""; } },
  });
  const head = (root: string) => git(root, "symbolic-ref", "--short", "HEAD");
  function commitWork(root: string): void { writeFileSync(join(root, "work.txt"), "done\n"); git(root, "add", "-A"); git(root, "commit", "-q", "-m", "work"); }

  it("B1: init → branch → spawn failed (no worker) → init → branch → commit → finish: `main` stays the start branch, finish ends on it, never `no-branch`", async () => {
    const root = repo();
    const args = ["retry", "topic", "--target", root];
    expect(await initWith(args, realDeps())).toBe(0);
    expect(await branchWith(TOPIC, root, runnerAt(root))).toBe(0);
    expect(head(root)).toBe(BRANCH);                                   // the predecessor's checkout stands
    expect(await initWith(args, realDeps())).toBe(0);                  // spawn failed twice, hub aborted without stop: retry
    expect(outSpy.text()).toContain("ARCHIVED_STALE=");
    const exec = quickExecDir(TOPIC);
    expect(readFileSync(join(exec, "start-branch.txt"), "utf8").trim()).toBe("main");   // carried
    expect(await branchWith(TOPIC, root, runnerAt(root))).toBe(0);
    expect(readFileSync(join(exec, "start-branch.txt"), "utf8").trim()).toBe("main");   // honoured, not re-snapshotted from HEAD
    expect(readFileSync(join(exec, "branch.txt"), "utf8").trim()).toBe(BRANCH);
    expect(head(root)).toBe(BRANCH);
    commitWork(root);
    expect(await finishWith(TOPIC, runnerAt(root), false)).toBe(0);
    const result = readFileSync(join(exec, "finish-result.txt"), "utf8");
    expect(result).not.toContain("no-branch");
    expect(result).toMatch(/^keep\t/);
    expect(head(root)).toBe("main");
  });

  it("B2: with --stash-wip, the carried marker lets the retry's finish pop the park: WIP file back, stash entry gone", async () => {
    const root = repo();
    const args = ["retry", "topic", "--target", root, "--stash-wip"];
    writeFileSync(join(root, "wip.txt"), "unfinished\n");
    expect(await initWith(args, realDeps())).toBe(0);
    expect(await branchWith(TOPIC, root, runnerAt(root), true)).toBe(0);
    expect(existsSync(join(root, "wip.txt"))).toBe(false);
    expect(git(root, "stash", "list")).toContain("ap-quick-retry-topic-wip");
    expect(await initWith(args, realDeps())).toBe(0);
    const exec = quickExecDir(TOPIC);
    expect(existsSync(join(exec, "stash-wip.txt"))).toBe(true);        // carried
    expect(await branchWith(TOPIC, root, runnerAt(root), true)).toBe(0); // clean tree: parks nothing, keeps the marker
    expect(existsSync(join(exec, "stash-wip.txt"))).toBe(true);
    commitWork(root);
    expect(await finishWith(TOPIC, runnerAt(root), false)).toBe(0);
    expect(git(root, "stash", "list")).not.toContain("ap-quick-retry-topic-wip");
    expect(readFileSync(join(root, "wip.txt"), "utf8")).toBe("unfinished\n");
    expect(head(root)).toBe("main");
  });

  it("B: HEAD on a foreign branch at retry → the start branch is re-snapshotted from HEAD; the carried value is NOT preferred", async () => {
    const root = repo();
    const args = ["retry", "topic", "--target", root];
    expect(await initWith(args, realDeps())).toBe(0);
    expect(await branchWith(TOPIC, root, runnerAt(root))).toBe(0);
    git(root, "checkout", "-q", "-b", "release");                     // the operator moved on before the retry
    expect(await initWith(args, realDeps())).toBe(0);
    const exec = quickExecDir(TOPIC);
    expect(readFileSync(join(exec, "start-branch.txt"), "utf8").trim()).toBe("main");      // carried ...
    expect(await branchWith(TOPIC, root, runnerAt(root))).toBe(0);
    expect(readFileSync(join(exec, "start-branch.txt"), "utf8").trim()).toBe("release");   // ... but HEAD was not on the run's branch
    commitWork(root);
    expect(await finishWith(TOPIC, runnerAt(root), false)).toBe(0);
    expect(head(root)).toBe("release");
  });

  it("B: a dirty tree at retry does NOT overwrite the carried park — the new changes take the WIP snapshot commit, the first park is restored at finish", async () => {
    const root = repo();
    const args = ["retry", "topic", "--target", root, "--stash-wip"];
    writeFileSync(join(root, "wip1.txt"), "first\n");
    expect(await initWith(args, realDeps())).toBe(0);
    expect(await branchWith(TOPIC, root, runnerAt(root), true)).toBe(0);
    const exec = quickExecDir(TOPIC);
    const marker = readFileSync(join(exec, "stash-wip.txt"), "utf8");
    writeFileSync(join(root, "wip2.txt"), "later\n");                  // the operator kept working
    expect(await initWith(args, realDeps())).toBe(0);
    expect(await branchWith(TOPIC, root, runnerAt(root), true)).toBe(0);
    expect(readFileSync(join(exec, "stash-wip.txt"), "utf8")).toBe(marker);                          // untouched
    expect(git(root, "stash", "list").split("\n").filter((l) => l.includes("ap-quick-retry-topic-wip"))).toHaveLength(1);
    expect(git(root, "log", "--oneline", "-1")).toContain("WIP before quick retry-topic");           // wip2 rode the snapshot commit
    commitWork(root);
    expect(await finishWith(TOPIC, runnerAt(root), false)).toBe(0);
    expect(readFileSync(join(root, "wip1.txt"), "utf8")).toBe("first\n");                           // the first park came back
    expect(git(root, "stash", "list")).not.toContain("ap-quick-retry-topic-wip");
    expect(git(root, "show", `${BRANCH}:wip2.txt`)).toBe("later");                                   // and wip2 is on the branch
    expect(head(root)).toBe("main");
  });
});
