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
import { outboxPath } from "../src/core/ipc.js";

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
  const okDeps: InitDeps = { haveCmd: () => true, agentBinary: () => "codex", pickRandomAgent: () => "bravo" };

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
    const rc = await initWith(["do", "thing"], { haveCmd: () => false, agentBinary: () => "codex", pickRandomAgent: () => "bravo" });
    expect(rc).toBe(3);
  });

  it("in-flight (art dir exists) → rc 2", async () => {
    expect(await initWith(["dup", "topic", "--provider", "codex"], okDeps)).toBe(0);
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
      if (k === "git symbolic-ref --short HEAD") return { code: 0, stdout: "main" };
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
      if (k === "git symbolic-ref --short HEAD") return { code: 0, stdout: "main" };
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
      ["git", "symbolic-ref", "--short", "HEAD"],
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
      ["git", "symbolic-ref", "--short", "HEAD"],
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

describe("quick turn-wait (turnWaitWith core)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  // The terminal-confirmation window is real wall time; these pins only care about the verdict, so
  // the window's sleep is injected away (the layer itself is pinned in tests/turn-confirm.test.ts).
  const noSleep = async () => {};

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
    const rc = await turnWaitWith("auth", 1, { wait: async () => ({ event: "done", summary: "ok" }), sleep: noSleep });
    expect(rc).toBe(0);
    const { quickExecDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickExecDir("auth"), "turn-1.txt"), "utf8")).toBe("OFFSET=10\nTS=ok\n");
  });

  it("question → captures payload + TS=question", async () => {
    await scaffold("auth", "OFFSET=0\n");
    await turnWaitWith("auth", 1, { wait: async () => ({ event: "question", message: "which db?" }), sleep: noSleep });
    const { quickExecDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickExecDir("auth"), "turn-1.txt"), "utf8")).toContain("TS=question");
    expect(readFileSync(join(quickExecDir("auth"), "question-1.txt"), "utf8")).toContain("which db?");
  });

  it("timeout (null) → TS=timeout", async () => {
    await scaffold("auth", "OFFSET=0\n");
    await turnWaitWith("auth", 1, { wait: async () => null, sleep: noSleep });
    const { quickExecDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickExecDir("auth"), "turn-1.txt"), "utf8")).toContain("TS=timeout");
  });

  it("missing OFFSET → rc 1", async () => {
    await scaffold("auth", "TS=stale\n");
    expect(await turnWaitWith("auth", 1, { wait: async () => null, sleep: noSleep })).toBe(1);
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
    await turnWaitWith("auth", 1, { wait, sleep: noSleep });   // round 1: handles the question at offset 0
    await turnWaitWith("auth", 1, { wait, sleep: noSleep });   // re-arm on the SAME round must resume past it
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
});

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

  /** `refRc` decides whether the recorded branch actually exists — `quick branch` writes branch.txt
   *  with the intended name even when the checkout failed, so a missing ref is the field shape. */
  function fakeGit(refRc: number): { r: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git show-ref --verify --quiet refs/heads/feat/quick-auth") return { code: refRc, stdout: "" };
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

  it("recorded branch IS the start branch: same refusal, no ref probe needed", async () => {
    const exec = await scaffold("main", "main");
    const { r, calls } = fakeGit(0);
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(calls.some((c) => c[1] === "push")).toBe(false);
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("none\tno-branch\n");
  });

  it("healthy distinct branch: the guard passes and the finish proceeds", async () => {
    const exec = await scaffold("feat/quick-auth", "main");
    const { r, calls } = fakeGit(0);
    expect(await finishWith("auth", r, true)).toBe(0);
    expect(calls.some((c) => c.join(" ") === "git push -q -u origin feat/quick-auth")).toBe(true);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe("pr\tpr-opened\n");
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
      if (k === "git symbolic-ref --short HEAD") return { code: o.headRc ?? 0, stdout: o.headRc ? "" : (o.head ?? "main") + "\n" };
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

  it("finish path: pops after finishBranch restored the start branch, clears the marker", async () => {
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
    expect(await finishWith("auth", r, true)).toBe(0);
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

  it("aborted summary → SUMMARY.md (aborted) + RESUME.md", async () => {
    await scaffold("auth");
    expect(await quickRun(["summary", "auth", "--aborted", "build", "worker-turn-failed", "turn", "failed", "twice"])).toBe(0);
    const { quickArtDir } = await import("../src/core/quick.js");
    expect(readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8")).toContain("status: aborted");
    expect(readFileSync(join(quickArtDir("auth"), "SUMMARY.md"), "utf8")).toContain("turn failed twice");
    expect(existsSync(join(quickArtDir("auth"), "RESUME.md"))).toBe(true);
    expect(readFileSync(join(quickArtDir("auth"), "RESUME.md"), "utf8")).not.toContain("Parked WIP");
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
