// tests/job-worktree.test.ts — the isolated worktree a detached run works in, against REAL git.
//
// The property under test is the one both dogfoods broke: a detached run must not check a branch out
// in the MAIN checkout. Branch checkout and the index are global to a checkout, so that froze the
// origin session out of its own repo for the run's duration. Nothing here goes near tmux — a shim
// earlier on PATH makes every tmux call fail, which is the same answer a tmux-less CI box gives.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { finishHint, run, startWorktree, sweepWorktree } from "../src/commands/job.js";
import { formatJob, jobPath, mainCheckoutRoot, worktreePathFor, type JobRecord } from "../src/core/job.js";
import { currentBranch, runnerAt, type Runner } from "../src/core/gitwork.js";

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

/** The REAL git runner with only `cp` scripted: attempt N takes exit code `codes[N]` (0 past the
 *  end) and its argv is recorded. Everything else — every git call startWorktree makes — is the
 *  genuine article, so the fallback chain is exercised without needing a BSD cp to test against. */
function cpScripted(root: string, codes: number[]): { r: Runner; calls: string[][] } {
  const real = runnerAt(root);
  const calls: string[][] = [];
  const r: Runner = {
    run(cmd, args) {
      if (cmd !== "cp") return real.run(cmd, args);
      calls.push(args);
      return { code: codes[calls.length - 1] ?? 0, stdout: "" };
    },
  };
  return { r, calls };
}

function record(root: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    command: "implement", topic: TOPIC, session: `ap-${TOPIC}`,
    hub: { agent: "alpha", model: "claude" },
    provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
    args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
    worktree: worktreePathFor(root, TOPIC), base_sha: git(root, "rev-parse", "HEAD"),
    start_branch: currentBranch(runnerAt(root)),
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

  it("clones node_modules when there is one (a shared inode where cp -al lands)", async () => {
    const root = repo();
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    const src = join(root, "node_modules", "pkg", "index.js");
    writeFileSync(src, "module.exports = 1;\n");
    const { err } = await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    const cloned = join(worktreePathFor(root, TOPIC), "node_modules", "pkg", "index.js");
    expect(existsSync(cloned)).toBe(true);
    // The hardlink mode is GNU cp's, and where it lands the inode is literally shared — no bytes
    // copied. A box whose cp has no -l (BSD/macOS) falls through to a copy and still gets the tree.
    if (err.includes("hardlink-cloned")) expect(statSync(cloned).ino).toBe(statSync(src).ino);
    else expect(readFileSync(cloned, "utf8")).toBe(readFileSync(src, "utf8"));
  });

  // A2: BSD cp has no -l at all, so a single `cp -al` meant every detached run on a mac lost its
  // dependency tree. The chain must fall back — and must NOT cost Linux its one-call happy path.
  it("Linux happy path: `cp -al` succeeds and is the ONLY cp call, argv verbatim", async () => {
    const root = repo();
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const { r, calls } = cpScripted(root, [0]);
    const { err } = await capture(() => (startWorktree(root, TOPIC, r) ? 0 : 1));
    expect(calls).toEqual([["-al", join(root, "node_modules"), join(worktreePathFor(root, TOPIC), "node_modules")]]);
    expect(err).toContain("job start: hardlink-cloned node_modules into the worktree");
  });

  it("falls -al -> -cR -> -R on a cp without -l, and names the mode that landed", async () => {
    const root = repo();
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const { r, calls } = cpScripted(root, [64, 1, 0]);
    const { err } = await capture(() => (startWorktree(root, TOPIC, r) ? 0 : 1));
    expect(calls.map((a) => a[0])).toEqual(["-al", "-cR", "-R"]);
    expect(err).toContain("job start: copied node_modules into the worktree");
    expect(err).not.toContain("could not clone node_modules");
  });

  it("APFS clonefile: -al fails, -cR lands, and -R is never reached", async () => {
    const root = repo();
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const { r, calls } = cpScripted(root, [64, 0]);
    const { err } = await capture(() => (startWorktree(root, TOPIC, r) ? 0 : 1));
    expect(calls.map((a) => a[0])).toEqual(["-al", "-cR"]);
    expect(err).toContain("job start: clone-copied node_modules into the worktree");
  });

  it("all three modes fail: warns, and the run still starts (the worker can install)", async () => {
    const root = repo();
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const { r, calls } = cpScripted(root, [1, 1, 1]);
    const { rc, err } = await capture(() => (startWorktree(root, TOPIC, r) ? 0 : 1));
    expect(calls.length).toBe(3);
    expect(rc).toBe(0);
    expect(err).toContain("could not clone node_modules");
    expect(err).toContain("the worker will have to install dependencies itself");
    expect(existsSync(worktreePathFor(root, TOPIC))).toBe(true);
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

  // W1: "the tree is dirty" is not the fact the operator needs — WHICH files is. Twice the invisible
  // file was the design doc the run was launched to implement.
  it("NAMES the uncommitted files, truncates past ten, and says what to do about them", async () => {
    const root = repo();
    writeFileSync(join(root, "docs-spec.md"), "the design this run will not see\n");
    const { err } = await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    expect(err).toContain("not in the worktree: docs-spec.md");
    expect(err).toContain(`'ap job stop ${TOPIC}'`);
    expect(err).not.toContain("+0 more");
  });

  it("with 12 dirty entries: ten are named and the rest are counted", async () => {
    const root = repo();
    for (let i = 0; i < 12; i++) writeFileSync(join(root, `f${i}.txt`), "wip\n");
    const { err } = await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    expect((err.match(/not in the worktree: /g) ?? []).length).toBe(10);
    expect(err).toContain("+2 more");
  });

  it("a RENAME reports its destination, and a quoted name is printed unescaped", async () => {
    const root = repo();
    git(root, "mv", "README.md", "RENAMED.md");
    writeFileSync(join(root, "désign.md"), "non-ascii\n");
    // core.quotePath is on by default: git prints "d\303\251sign.md", which matches nothing typeable.
    expect(git(root, "status", "--porcelain")).toContain("\\303");
    const { err } = await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    expect(err).toContain("not in the worktree: RENAMED.md");
    expect(err).not.toContain("README.md -> RENAMED.md");
    expect(err).toContain("not in the worktree: désign.md");
    expect(err).not.toContain("\\303");
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

// F6: `job` verbs are cwd-sensitive — every state path hashes repoRoot(), and from inside the run's
// worktree that is the WORKTREE's toplevel, not the main checkout. A healthy 0.62h/2h run read
// `BUDGET=unknown` rc 1 and would have parked as if its budget were exhausted.
describe("job verbs resolve ONE record from either checkout", () => {
  it("budget-check from inside the run's worktree reads the record seeded at the ROOT", async () => {
    const root = repo();
    await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    seedJob(record(root, { started: new Date().toISOString(), budget_hours: 2 }));
    expect(existsSync(jobPath(TOPIC))).toBe(true);           // seeded while cwd is the main checkout

    process.chdir(worktreePathFor(root, TOPIC));
    const { rc, out } = await capture(() => run(["budget-check", TOPIC]));
    expect(rc).toBe(0);
    expect(out).toContain("BUDGET=within");
    expect(out).not.toContain("BUDGET=unknown");
  });

  // The guard is the whole safety of the string surgery: a user's OWN worktree (the standard
  // parallel-session discipline) is three segments deep too, and re-homing it into some other repo's
  // state namespace would be a worse failure than the one this fixes.
  it("leaves a NON-provenanced worktree path exactly as git reported it", () => {
    const main = "/repo";
    expect(mainCheckoutRoot(join(main, ".ap", "worktrees", TOPIC))).toBe(main);
    // a user's own worktree, three segments deep but not under .ap/worktrees
    expect(mainCheckoutRoot("/repo/wt/feature/checkout")).toBe("/repo/wt/feature/checkout");
    expect(mainCheckoutRoot("/repo/a/b/c")).toBe("/repo/a/b/c");
    // a plain checkout, and the degenerate near-misses
    expect(mainCheckoutRoot(main)).toBe(main);
    expect(mainCheckoutRoot(join(main, ".ap", "worktrees"))).toBe(join(main, ".ap", "worktrees"));
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

// W2: DRIFT existed only in the FINISH hint at `job stop` — after the merge decision was already
// made. One dogfood branch sat through three merges of its starting branch and landed a conflict.
describe("job status — the worktree facts, DURING the run", () => {
  /** A seeded worktree run whose starting branch has moved `drift` commits since the fork. */
  async function startedRun(root: string, drift: number, over: Partial<JobRecord> = {}): Promise<void> {
    await capture(() => (startWorktree(root, TOPIC, runnerAt(root)) ? 0 : 1));
    const rec = record(root, over);
    for (let i = 0; i < drift; i++) {
      writeFileSync(join(root, `m${i}.txt`), "meanwhile\n");
      git(root, "add", "-A"); git(root, "commit", "-q", "-m", `main ${i}`);
    }
    seedJob(rec);
  }

  it("prints the worktree, the start branch and the drift — with the local-ref caveat", async () => {
    const root = repo();
    await startedRun(root, 2);
    const { rc, out } = await capture(() => run(["status", TOPIC]));
    expect(rc).toBe(0);
    expect(out).toContain(`WORKTREE=${worktreePathFor(root, TOPIC)}`);
    expect(out).toContain("START_BRANCH=main");
    // The caveat is load-bearing: ap makes ZERO network git calls, so a bare 0 on a branch whose
    // merges only exist on the forge would read as "not stale".
    expect(out).toContain("DRIFT=2 (local ref; ap never fetches)");
  });

  it("an unresolvable start branch prints ? — never 0, which would read as 'not stale'", async () => {
    const root = repo();
    await startedRun(root, 0, { start_branch: "" });
    const { out } = await capture(() => run(["status", TOPIC]));
    expect(out).toContain("DRIFT=? (local ref; ap never fetches)");
    expect(out).not.toContain("DRIFT=0");
    expect(out).toContain("START_BRANCH=?");
  });

  // Non-regression: a --no-worktree run has no fork to measure against, and its stdout is unchanged.
  it("prints none of the three lines for a --no-worktree run", async () => {
    const root = repo();
    seedJob(record(root, { worktree: "", base_sha: "", start_branch: "" }));
    const { rc, out } = await capture(() => run(["status", TOPIC]));
    expect(rc).toBe(0);
    expect(out).not.toContain("WORKTREE=");
    expect(out).not.toContain("START_BRANCH=");
    expect(out).not.toContain("DRIFT=");
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

  // A TAG sharing the start branch's name is what `git symbolic-ref --short HEAD` disambiguates
  // into `heads/<name>`. Recorded, that name sends the drift count at `refs/heads/heads/<name>` —
  // a ref no repo has — and the hint degrades to `?` on a perfectly countable run.
  it("a tag shadowing the start branch: the name is recorded clean and drift still counts", async () => {
    const root = repo();
    git(root, "branch", "-m", "trunk");
    git(root, "tag", "trunk");
    expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("heads/trunk");   // what ap must NOT record
    const rec = await finishedRun(root, 2, 3);
    expect(rec.start_branch).toBe("trunk");
    const { rc, out } = await capture(() => run(["stop", TOPIC]));
    expect(rc).toBe(0);
    expect(out).toContain("START_BRANCH=trunk");
    expect(out).toContain("DRIFT=3");
  });

  // The two lines degrade INDEPENDENTLY, as `commands/job.md` documents them: the name is known
  // from the record alone, so a count that cannot be taken must not also erase it.
  it("the drift count fails but the branch was recorded: the name still prints, the count is ?", async () => {
    const root = repo();
    const rec = await finishedRun(root, 2, 0);
    seedJob({ ...rec, start_branch: "deleted-since" });      // rev-list on a ref that is gone exits non-zero
    const { rc, out } = await capture(() => run(["stop", TOPIC]));
    expect(rc).toBe(0);
    expect(out).toContain("START_BRANCH=deleted-since");
    expect(out).toContain("DRIFT=?");
  });

  // rc 0 is not the same as a number: git can succeed and put something else on stdout. `COMMITS`
  // has always parsed rather than echoed; `DRIFT` does now too.
  it("a rc-0 count that is not a number prints ?, and so does an empty one", async () => {
    const root = repo();
    const rec = await finishedRun(root, 2, 0);
    const real = runnerAt(root);
    const driftSays = (stdout: string): Runner => ({
      run(cmd, args) {
        if (args[0] === "rev-list" && args[2]?.includes("..refs/heads/")) return { code: 0, stdout };
        return real.run(cmd, args);
      },
    });
    for (const stdout of ["warning: something\n", "  \n"]) {
      const { out } = await capture(() => { finishHint(rec, driftSays(stdout)); return 0; });
      expect(out).toContain("COMMITS=2");
      expect(out).toContain("START_BRANCH=main");
      expect(out).toContain("DRIFT=?");
    }
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
