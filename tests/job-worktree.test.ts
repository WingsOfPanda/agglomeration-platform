// tests/job-worktree.test.ts — the isolated worktree a detached run works in, against REAL git.
//
// The property under test is the one both dogfoods broke: a detached run must not check a branch out
// in the MAIN checkout. Branch checkout and the index are global to a checkout, so that froze the
// origin session out of its own repo for the run's duration. Nothing here goes near tmux — a shim
// earlier on PATH makes every tmux call fail, which is the same answer a tmux-less CI box gives.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { run, startWorktree, sweepWorktree } from "../src/commands/job.js";
import { formatJob, jobPath, worktreePathFor, type JobRecord } from "../src/core/job.js";
import { runnerAt } from "../src/core/gitwork.js";

const TOPIC = "demo";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** A throwaway repo with one commit on `main`, made the current directory, with a fresh AP_HOME and
 *  a tmux that always fails. `git init -b` is avoided so this works on older gits. */
function repo(opts: { empty?: boolean } = {}): string {
  const h = freshHome();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-wt-")));
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "ap tests");
  git(root, "config", "commit.gpgsign", "false");
  if (!opts.empty) {
    writeFileSync(join(root, "README.md"), "hello\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  const shim = join(h.home, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "tmux"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  const path0 = process.env.PATH;
  const cwd0 = process.cwd();
  process.env.PATH = `${shim}:${path0}`;
  process.chdir(root);
  cleanups.push(() => {
    process.chdir(cwd0);
    process.env.PATH = path0;
    // The worktree registration lives in the repo we are about to delete, so nothing survives it.
    rmSync(root, { recursive: true, force: true });
    h.cleanup();
  });
  return root;
}

async function capture(fn: () => Promise<number> | number): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

function record(root: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    command: "implement", topic: TOPIC, session: `ap-${TOPIC}`,
    hub: { agent: "alpha", model: "claude" },
    provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
    args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
    worktree: worktreePathFor(root, TOPIC), base_sha: git(root, "rev-parse", "HEAD"),
    start_branch: git(root, "symbolic-ref", "--short", "HEAD"),
    ...over,
  };
}
function seedJob(rec: JobRecord): void {
  const p = jobPath(rec.topic);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, formatJob(rec));
}

describe("startWorktree — the run gets its own checkout, the operator keeps theirs", () => {
  it("forks committed HEAD into <root>/.ap/worktrees/<topic>, on base/<topic>", async () => {
    const root = repo();
    const base = git(root, "rev-parse", "HEAD");
    const wt = (await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1))).rc === 0
      ? worktreePathFor(root, TOPIC) : "";
    expect(wt).toBe(join(root, ".ap", "worktrees", TOPIC));
    expect(git(wt, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(wt, "README.md"))).toBe(true);
    // Born on a branch, NOT detached (the 0.5.36 assertion this replaces): `implement branch` refuses
    // a detached-HEAD pre-snapshot, and the main checkout's branch cannot be checked out here.
    expect(git(wt, "symbolic-ref", "--short", "HEAD")).toBe(`base/${TOPIC}`);
    expect(git(root, "rev-parse", `base/${TOPIC}`)).toBe(base);
  });

  it("REFUSES when base/<topic> already exists — an interrupted stop left it behind", async () => {
    const root = repo();
    git(root, "branch", `base/${TOPIC}`);
    const { rc, err } = await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    expect(rc).toBe(1);
    expect(err).toContain(`branch base/${TOPIC} already exists`);
    expect(err).toContain(`branch -D base/${TOPIC}`);
    expect(existsSync(worktreePathFor(root, TOPIC))).toBe(false);
  });

  // Success criterion 1, end to end: the worker branches, and the origin's checkout does not move.
  it("the worker's branch checkout leaves the MAIN checkout on its own branch", async () => {
    const root = repo();
    await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    const wt = worktreePathFor(root, TOPIC);
    git(wt, "checkout", "-q", "-b", "feat/implement-demo");
    writeFileSync(join(wt, "new.txt"), "work\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "worker commit");

    expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
    // and the origin can still switch branches in its own repo for the whole run
    git(root, "checkout", "-q", "-b", "operator-side-quest");
    expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("operator-side-quest");
  });

  it("hardlink-clones node_modules when there is one (same inode, no copy)", async () => {
    const root = repo();
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    const cloned = join(worktreePathFor(root, TOPIC), "node_modules", "pkg", "index.js");
    expect(existsSync(cloned)).toBe(true);
    expect(statSync(cloned).ino).toBe(statSync(join(root, "node_modules", "pkg", "index.js")).ino);
  });

  // D2: the operator's uncommitted WIP stays out, and is neither stashed nor committed. Warning
  // loudly is the whole remedy — silently forking without it is how a run "loses" someone's edits.
  it("WARNS about an uncommitted main tree, and forks without it", async () => {
    const root = repo();
    writeFileSync(join(root, "README.md"), "hello\nMY UNCOMMITTED EDIT\n");
    const { err } = await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    expect(err).toContain("UNCOMMITTED changes and they are NOT in the worktree");
    expect(execFileSync("cat", [join(worktreePathFor(root, TOPIC), "README.md")], { encoding: "utf8" })).toBe("hello\n");
    expect(git(root, "status", "--porcelain")).toContain("README.md");   // untouched, not stashed
  });

  it("REFUSES when the path already exists — a kept-dirty leftover is named, with its remedy", async () => {
    const root = repo();
    mkdirSync(worktreePathFor(root, TOPIC), { recursive: true });
    const { rc, err } = await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    expect(rc).toBe(1);
    expect(err).toContain(worktreePathFor(root, TOPIC));
    expect(err).toContain("worktree remove");
  });

  it("REFUSES a repo with no commit to fork, rather than launching into the checkout", async () => {
    const root = repo({ empty: true });
    const { rc, err } = await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    expect(rc).toBe(1);
    expect(err).toContain("could not read HEAD");
    expect(existsSync(worktreePathFor(root, TOPIC))).toBe(false);
  });
});

describe("sweepWorktree — clean goes, dirty stays, foreign is never touched", () => {
  it("removes a clean worktree and prunes the registration; the BRANCH survives", async () => {
    const root = repo();
    await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    const wt = worktreePathFor(root, TOPIC);
    git(wt, "checkout", "-q", "-b", "feat/implement-demo");
    writeFileSync(join(wt, "new.txt"), "work\n");
    git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", "worker commit");

    const { rc } = await capture(() => (sweepWorktree(record(root), root, runnerAt(root)) ? 0 : 1));
    expect(rc).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(git(root, "worktree", "list")).not.toContain(wt);
    // Worktrees share the ref store, so the work is still reachable after its checkout is gone.
    expect(git(root, "rev-parse", "--verify", "feat/implement-demo")).toMatch(/^[0-9a-f]{40}$/);
    // The base branch is the worktree's, not the operator's: it goes when the worktree goes.
    expect(runnerAt(root).run("git", ["show-ref", "--verify", "--quiet", `refs/heads/base/${TOPIC}`]).code).not.toBe(0);
  });

  // The one unrecoverable act in the sweep, so it is the one thing the sweep refuses to do blind.
  it("KEEPS a base/<topic> that MOVED — somebody committed on it — and still completes", async () => {
    const root = repo();
    await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    const wt = worktreePathFor(root, TOPIC);
    writeFileSync(join(wt, "on-base.txt"), "committed on the base branch\n");
    git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", "straight onto base");
    const moved = git(wt, "rev-parse", "HEAD");

    const { rc, err } = await capture(() => (sweepWorktree(record(root), root, runnerAt(root)) ? 0 : 1));
    expect(rc).toBe(0);                                   // the worktree is gone; the branch is not the sweep's problem
    expect(existsSync(wt)).toBe(false);
    expect(git(root, "rev-parse", `base/${TOPIC}`)).toBe(moved);
    expect(err).toContain(`the branch base/${TOPIC} has MOVED`);
  });

  it("KEEPS a dirty worktree and names it — that is a crashed worker's unarchived work", async () => {
    const root = repo();
    await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    const wt = worktreePathFor(root, TOPIC);
    writeFileSync(join(wt, "half-done.txt"), "uncommitted\n");
    const { rc, err } = await capture(() => (sweepWorktree(record(root), root, runnerAt(root)) ? 0 : 1));
    expect(rc).toBe(1);
    expect(existsSync(join(wt, "half-done.txt"))).toBe(true);
    expect(err).toContain("UNCOMMITTED work in it and is being KEPT");
    expect(err).toContain("worktree remove --force");
  });

  it("NEVER removes a path outside .ap/worktrees, however the record got that way", async () => {
    const root = repo();
    const foreign = realpathSync(mkdtempSync(join(tmpdir(), "ap-not-ours-")));
    cleanups.push(() => rmSync(foreign, { recursive: true, force: true }));
    writeFileSync(join(foreign, "precious.txt"), "someone else's checkout\n");
    const { rc, err } = await capture(() => (sweepWorktree(record(root, { worktree: foreign }), root, runnerAt(root)) ? 0 : 1));
    expect(rc).toBe(1);
    expect(existsSync(join(foreign, "precious.txt"))).toBe(true);
    expect(err).toContain("will not remove a path it cannot prove it created");
  });

  it("is a no-op for a --no-worktree run and for a pre-0.5.36 record", async () => {
    const root = repo();
    expect((await capture(() => (sweepWorktree(record(root, { worktree: "" }), root, runnerAt(root)) ? 0 : 1))).rc).toBe(0);
    expect((await capture(() => (sweepWorktree(record(root, { worktree: undefined }), root, runnerAt(root)) ? 0 : 1))).rc).toBe(0);
  });

  it("completes when the recorded worktree is already gone (a hand-removed one)", async () => {
    const root = repo();
    await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    rmSync(worktreePathFor(root, TOPIC), { recursive: true, force: true });
    expect((await capture(() => (sweepWorktree(record(root), root, runnerAt(root)) ? 0 : 1))).rc).toBe(0);
    expect(git(root, "worktree", "list")).not.toContain(worktreePathFor(root, TOPIC));
  });
});

describe("job stop — the sweep and the FINISH hint, through the verb", () => {
  /** A run that produced `commits` commits on its branch, with its start branch moved by `drift`. */
  async function finishedRun(root: string, commits: number, drift: number, beforeDrift?: () => void): Promise<JobRecord> {
    const rec = record(root);
    await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    const wt = worktreePathFor(root, TOPIC);
    git(wt, "checkout", "-q", "-b", "feat/implement-demo");
    for (let i = 0; i < commits; i++) {
      writeFileSync(join(wt, `w${i}.txt`), "work\n");
      git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", `worker ${i}`);
    }
    beforeDrift?.();
    for (let i = 0; i < drift; i++) {
      writeFileSync(join(root, `m${i}.txt`), "meanwhile\n");
      git(root, "add", "-A"); git(root, "commit", "-q", "-m", `main ${i}`);
    }
    seedJob(rec);
    return rec;
  }

  it("prints the push+PR commands and how far the start branch drifted, then sweeps and clears the record", async () => {
    const root = repo();
    git(root, "branch", "-m", "trunk");
    await finishedRun(root, 2, 3, () => git(root, "tag", "trunk"));
    const { rc, out } = await capture(() => run(["stop", TOPIC]));
    expect(rc).toBe(0);
    expect(out).toContain("FINISH=pending");
    expect(out).toContain("BRANCH=feat/implement-demo");
    expect(out).toContain("COMMITS=2");
    expect(out).toContain("START_BRANCH=trunk");
    expect(out).toContain("DRIFT=3");
    expect(out).toContain("git push -u origin feat/implement-demo");
    expect(out).toContain("gh pr create --head feat/implement-demo");
    expect(existsSync(worktreePathFor(root, TOPIC))).toBe(false);
    expect(existsSync(jobPath(TOPIC))).toBe(false);
  });

  // The hint is the operator's map to work that has no other pointer, so it is printed on the
  // kept-dirty ending too — the one where they most need it.
  it("a dirty worktree keeps the record, exits 1, and still prints the hint", async () => {
    const root = repo();
    await finishedRun(root, 1, 0);
    writeFileSync(join(worktreePathFor(root, TOPIC), "scratch.txt"), "uncommitted\n");
    const { rc, out, err } = await capture(() => run(["stop", TOPIC]));
    expect(rc).toBe(1);
    expect(out).toContain("BRANCH=feat/implement-demo");
    expect(out).toContain("START_BRANCH=main");
    expect(out).toContain("DRIFT=0");
    expect(existsSync(jobPath(TOPIC))).toBe(true);      // the record is what a re-run acts on
    expect(existsSync(worktreePathFor(root, TOPIC))).toBe(true);
    expect(err).toContain("the job record is KEPT");
  });

  it("prints no hint for a run that produced no commits", async () => {
    const root = repo();
    await finishedRun(root, 0, 1);
    const { rc, out } = await capture(() => run(["stop", TOPIC]));
    expect(rc).toBe(0);
    expect(out).not.toContain("FINISH=pending");
  });

  // The hint no longer consults the recorded action: `--finish` was removed 2026-08-18, so every
  // detached run ends `keep` and a record naming anything else (an older ap's, or a hand-edited one)
  // still gets told where its commits are.
  it("prints the hint whatever the record's finish action says", async () => {
    const root = repo();
    const rec = await finishedRun(root, 2, 0);
    seedJob({ ...rec, finish: "pr" });
    const { out } = await capture(() => run(["stop", TOPIC]));
    expect(out).toContain("FINISH=pending");
    expect(out).toContain("COMMITS=2");
  });

  it("a pre-0.5.38 record keeps the hint but reports unknown start-branch drift", async () => {
    const root = repo();
    const rec = await finishedRun(root, 1, 0);
    seedJob({ ...rec, start_branch: undefined });
    const { rc, out } = await capture(() => run(["stop", TOPIC]));
    expect(rc).toBe(0);
    expect(out).toContain("FINISH=pending");
    expect(out).toContain("START_BRANCH=?");
    expect(out).toContain("DRIFT=?");
  });

  it("a pre-0.5.36 record (no worktree fields) stops exactly as it always did", async () => {
    const root = repo();
    seedJob(record(root, { worktree: undefined, base_sha: undefined }));
    const { rc, out } = await capture(() => run(["stop", TOPIC]));
    expect(rc).toBe(0);
    expect(out).not.toContain("FINISH=pending");
    expect(existsSync(jobPath(TOPIC))).toBe(false);
  });
});
