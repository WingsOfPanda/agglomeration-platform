// tests/finish-keep-on-branch.test.ts — issue #165: a finish must NEVER restore the start branch in
// a target that IS the run's own worktree, where a detached job may still be executing out of the
// feature branch. Two halves here: the shared guard (core/job `keepOnBranch`) and quick's branch-only
// arm, which does its own direct checkout and never reaches the shared finisher. The finisher's keep
// arm lives in gitwork-finishwork.test.ts, implement's routing in implement-cmd.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { finishWith } from "../src/commands/quick.js";
import { quickArtDir, quickExecDir } from "../src/core/quick.js";
import { formatJob, jobPath, keepOnBranch } from "../src/core/job.js";
import type { Runner } from "../src/core/gitwork.js";

const TOPIC = "auth";
const BRANCH = "feat/quick-auth";

/** A job record for TOPIC. `worktree: undefined` writes the pre-0.5.36 shape — the field absent
 *  entirely — which must read exactly like the `--no-worktree` `""`. */
function seedJob(worktree: string | undefined): void {
  const p = jobPath(TOPIC);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, formatJob({
    command: "quick", topic: TOPIC, session: `ap-${TOPIC}`,
    hub: { agent: "alpha", model: "claude" },
    provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
    args_file: "/tmp/args", started: "2026-08-29T00:00:00Z",
    worktree,
  }));
}

describe("keepOnBranch — the guard both finish paths share", () => {
  let h: { home: string; cleanup: () => void };
  let root: string, wt: string;
  beforeEach(() => {
    h = freshHome();
    root = mkdtempSync(join(tmpdir(), "ap-wt-"));
    wt = join(root, ".ap", "worktrees", TOPIC);
    mkdirSync(wt, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); h.cleanup(); });

  it("a provenanced worktree that IS the target → true", () => {
    seedJob(wt);
    expect(keepOnBranch(TOPIC, wt)).toBe(true);
  });

  // The review's third finding: record-existence alone would strand a --no-worktree operator on the
  // feature branch, in their OWN checkout, with their --stash-wip park behind the wrong-HEAD guard.
  it("--no-worktree (worktree: \"\") → false, however live the record is", () => {
    seedJob("");
    expect(keepOnBranch(TOPIC, wt)).toBe(false);
  });

  it("a pre-0.5.36 record (no worktree field at all) → false", () => {
    seedJob(undefined);
    expect(keepOnBranch(TOPIC, wt)).toBe(false);
  });

  it("the record names a DIFFERENT worktree than the finish target → false", () => {
    const other = join(root, ".ap", "worktrees", "other-topic");
    mkdirSync(other, { recursive: true });
    seedJob(other);
    expect(keepOnBranch(TOPIC, wt)).toBe(false);
  });

  it("a real, matching, but NON-provenanced path (a plain checkout) → false", () => {
    const plain = join(root, "checkout");
    mkdirSync(plain, { recursive: true });
    seedJob(plain);
    expect(keepOnBranch(TOPIC, plain)).toBe(false);
  });

  it("no record, and a torn record, both → false", () => {
    expect(keepOnBranch(TOPIC, wt)).toBe(false);
    const p = jobPath(TOPIC);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not json\n");
    expect(keepOnBranch(TOPIC, wt)).toBe(false);
  });

  it("equality is CANONICAL: a symlinked target still matches the recorded worktree", () => {
    const link = join(root, "link-to-wt");
    symlinkSync(wt, link);
    seedJob(wt);
    expect(keepOnBranch(TOPIC, link)).toBe(true);
  });

  it("an empty target (no target_cwd recorded) → false, without reading the record", () => {
    seedJob(wt);
    expect(keepOnBranch(TOPIC, "")).toBe(false);
  });

  it("a recorded worktree that no longer exists on disk → false (realpath throws)", () => {
    seedJob(wt);
    rmSync(wt, { recursive: true, force: true });
    expect(keepOnBranch(TOPIC, wt)).toBe(false);
  });
});

describe("quick finish branch-only arm — a live job's worktree keeps its branch", () => {
  let h: { home: string; cleanup: () => void };
  let root: string, wt: string;
  beforeEach(() => {
    h = freshHome();
    root = mkdtempSync(join(tmpdir(), "ap-wt-"));
    wt = join(root, ".ap", "worktrees", TOPIC);
    mkdirSync(wt, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); h.cleanup(); });

  /** The exec state a detached quick run leaves at finish time: finish.txt=no (the branch-only arm),
   *  the run's branch, and the target the run actually worked in. */
  function scaffold(target: string, markerBody?: string): string {
    const exec = quickExecDir(TOPIC);
    mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "target_cwd.txt"), target + "\n");
    writeFileSync(join(exec, "branch.txt"), BRANCH + "\n");
    writeFileSync(join(exec, "start-branch.txt"), "main\n");
    writeFileSync(join(exec, "finish.txt"), "no\n");
    writeFileSync(join(quickArtDir(TOPIC), "task-brief.md"), "## Goal\nX");
    writeFileSync(join(exec, "verify-result.txt"), "PASS (npm test)\n");
    if (markerBody !== undefined) writeFileSync(join(exec, "stash-wip.txt"), markerBody);
    return exec;
  }

  const STASH_LIST = "git stash list --format=%gd%x09%gs";
  /** `head` is where HEAD really is — for a guarded finish that is the FEAT branch, because nothing
   *  checked the start branch out. */
  function fakeGit(head: string): { r: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git symbolic-ref HEAD") return { code: 0, stdout: `refs/heads/${head}\n` };
      if (k === STASH_LIST) return { code: 0, stdout: `stash@{0}\tOn ${head}: ap-quick-auth-wip\n` };
      if (k === "git rev-parse stash@{0}") return { code: 0, stdout: "stash999\n" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }
  const checkedOutStart = (calls: string[][]) => calls.some((c) => c.join(" ") === "git checkout -q main");
  function hubFlags(): string {
    const dir = join(h.home, "forensics");
    if (!existsSync(dir)) return "";
    return readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).map((f) => readFileSync(join(dir, d, f), "utf8"))).join("");
  }

  it("the target IS the record's provenanced worktree → NO start-branch checkout, kept-on-branch recorded", async () => {
    const exec = scaffold(wt);
    seedJob(wt);
    const { r, calls } = fakeGit(BRANCH);
    const { rc, err } = await capture(() => finishWith(TOPIC, r, true));
    expect(rc).toBe(0);
    expect(checkedOutStart(calls)).toBe(false);
    expect(calls.some((c) => c[1] === "checkout")).toBe(false);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe(`none\tkept-on-branch (kept ${BRANCH})\n`);
    // The reason has to be IN the log, not just in the record: the operator reads this line.
    expect(err).toContain("kept-on-branch");
    expect(err).toContain("a live detached job runs from this worktree");
    expect(err).toContain("NOT restoring 'main'");
  });

  it("--no-worktree record (worktree: \"\") → the start branch is restored, exactly as today", async () => {
    const exec = scaffold(wt);
    seedJob("");
    const { r, calls } = fakeGit("main");
    expect(await finishWith(TOPIC, r, true)).toBe(0);
    expect(checkedOutStart(calls)).toBe(true);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe(`none\tbranch-only (kept ${BRANCH})\n`);
  });

  it("no record at all → the start branch is restored, exactly as today", async () => {
    const exec = scaffold(wt);
    const { r, calls } = fakeGit("main");
    expect(await finishWith(TOPIC, r, true)).toBe(0);
    expect(checkedOutStart(calls)).toBe(true);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe(`none\tbranch-only (kept ${BRANCH})\n`);
  });

  it("the record's worktree is not this target → the start branch is restored", async () => {
    const other = join(root, ".ap", "worktrees", "other-topic");
    mkdirSync(other, { recursive: true });
    const exec = scaffold(wt);
    seedJob(other);
    const { r, calls } = fakeGit("main");
    expect(await finishWith(TOPIC, r, true)).toBe(0);
    expect(checkedOutStart(calls)).toBe(true);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe(`none\tbranch-only (kept ${BRANCH})\n`);
  });

  it("a matching but non-provenanced target (the operator's own checkout) → the start branch is restored", async () => {
    const plain = join(root, "checkout");
    mkdirSync(plain, { recursive: true });
    const exec = scaffold(plain);
    seedJob(plain);
    const { r, calls } = fakeGit("main");
    expect(await finishWith(TOPIC, r, true)).toBe(0);
    expect(checkedOutStart(calls)).toBe(true);
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe(`none\tbranch-only (kept ${BRANCH})\n`);
  });

  // The skip composes with --stash-wip rather than bypassing it: restoreStashWip still runs, and its
  // wrong-HEAD protection is exactly right here — HEAD is (deliberately) not the start branch, so the
  // park stays stashed, the marker stays, and the kept flag reaches /ap:review.
  it("stash-wip + the guard → NOT popped, marker kept, stash-wip-kept recorded and flagged", async () => {
    const exec = scaffold(wt, "stash999\tap-quick-auth-wip\n");
    seedJob(wt);
    const { r, calls } = fakeGit(BRANCH);
    const { rc, err } = await capture(() => finishWith(TOPIC, r, true));
    expect(rc).toBe(0);
    expect(calls.some((c) => c[1] === "stash" && c[2] === "pop")).toBe(false);
    expect(readFileSync(join(exec, "stash-wip.txt"), "utf8")).toBe("stash999\tap-quick-auth-wip\n");
    expect(readFileSync(join(exec, "finish-result.txt"), "utf8")).toBe(`none\tkept-on-branch (kept ${BRANCH})\nstash-wip-kept\n`);
    expect(err).toContain(`quick finish: HEAD is on '${BRANCH}', not the start branch 'main' — NOT popping`);
    expect(hubFlags()).toContain(`stash-wip-kept: WIP still stashed as 'ap-quick-auth-wip' in ${wt}`);
  });
});

// capture process.stdout.write + process.stderr.write for the duration of fn() (log writes to stderr).
async function capture(fn: () => Promise<number>): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}
