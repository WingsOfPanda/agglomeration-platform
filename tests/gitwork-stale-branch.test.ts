// tests/gitwork-stale-branch.test.ts — createOrResumeBranch's three outcomes, against REAL git.
//
// The property under test cannot be faked: it is what `git merge-base --is-ancestor` says about a
// branch a SQUASH merge left behind. A squash merge puts the branch's CONTENT in main as one new
// commit and leaves the branch's own commits unreachable from main, so ancestry — not content — is
// the only local signal that the branch is finished. A scripted runner would just replay whatever
// answer the test author assumed, which is the assumption under test.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrResumeBranch, currentBranch, runnerAt } from "../src/core/gitwork.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
/** HEAD read through git itself, not through the code under test: the no-checkout assertion must not
 *  be able to pass because the helper it shares with the implementation agreed with it. */
function headRef(root: string): string {
  return git(root, "symbolic-ref", "HEAD");
}
function commit(root: string, file: string, body: string, message: string): void {
  writeFileSync(join(root, file), body);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** A throwaway repo with one commit on `main`. `git init -b` is avoided so this works on older gits. */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-stale-")));
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "ap tests");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "README.md", "hello\n", "init");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("createOrResumeBranch against real git", () => {
  it("ref absent -> created, and HEAD is on the new branch", () => {
    const root = repo();
    expect(createOrResumeBranch(runnerAt(root), "feat/quick-t")).toBe("created");
    expect(headRef(root)).toBe("refs/heads/feat/quick-t");
  });

  it("ref exists AT HEAD -> resumed (the same-topic continuation, the common case)", () => {
    const root = repo();
    git(root, "branch", "feat/quick-t");
    expect(createOrResumeBranch(runnerAt(root), "feat/quick-t")).toBe("resumed");
    expect(headRef(root)).toBe("refs/heads/feat/quick-t");
  });

  it("branch AHEAD of HEAD -> resumed: work carried forward from where we stand is a continuation", () => {
    const root = repo();
    git(root, "checkout", "-q", "-b", "feat/quick-t");
    commit(root, "a.txt", "wip\n", "wip on the branch");
    git(root, "checkout", "-q", "main");
    expect(createOrResumeBranch(runnerAt(root), "feat/quick-t")).toBe("resumed");
    expect(headRef(root)).toBe("refs/heads/feat/quick-t");
  });

  it("start branch advanced past the fork point -> stale, and NO checkout happened", () => {
    const root = repo();
    git(root, "branch", "feat/quick-t");
    commit(root, "b.txt", "moved on\n", "main moves ahead");
    expect(currentBranch(runnerAt(root))).toBe("main");
    expect(createOrResumeBranch(runnerAt(root), "feat/quick-t")).toBe("stale");
    // The load-bearing half: the refusal is worthless if the checkout already happened.
    expect(headRef(root)).toBe("refs/heads/main");
  });

  it("SQUASH-MERGE reproduction: the leftover branch of a merged run -> stale, HEAD untouched", () => {
    const root = repo();
    git(root, "checkout", "-q", "-b", "feat/quick-topic");
    commit(root, "feature.txt", "the feature\n", "implement the feature");
    git(root, "checkout", "-q", "main");
    // The operator's merge style: content lands on main as ONE new commit, and the branch's own
    // commit stays unreachable from main. `git cherry`/patch-id sees no match for it either.
    git(root, "merge", "--squash", "feat/quick-topic");
    git(root, "commit", "-q", "-m", "squash: implement the feature");
    // Content is in main...
    expect(git(root, "show", "HEAD:feature.txt")).toBe("the feature");
    // ...but the branch is NOT an ancestor of it, which is what makes a re-run inherit merged work.
    expect(git(root, "branch", "--merged", "HEAD")).not.toContain("feat/quick-topic");

    expect(createOrResumeBranch(runnerAt(root), "feat/quick-topic")).toBe("stale");
    expect(headRef(root)).toBe("refs/heads/main");
    // ap destroys nothing: the operator's branch and its commit are exactly where they were.
    expect(git(root, "rev-parse", "--verify", "refs/heads/feat/quick-topic")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a failed checkout is `failed`, not `resumed`: a dirty tree that would be clobbered", () => {
    const root = repo();
    git(root, "checkout", "-q", "-b", "feat/quick-t");
    commit(root, "shared.txt", "branch version\n", "branch writes shared.txt");
    git(root, "checkout", "-q", "main");
    // Uncommitted local edit to the same path git would have to overwrite to switch branches.
    writeFileSync(join(root, "shared.txt"), "local uncommitted version\n");
    expect(createOrResumeBranch(runnerAt(root), "feat/quick-t")).toBe("failed");
    expect(headRef(root)).toBe("refs/heads/main");
  });
});
