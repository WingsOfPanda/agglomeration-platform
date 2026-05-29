// tests/solo-gitwork.test.ts
import { describe, it, expect } from "vitest";
import { classifyDirty, finishAutoAction } from "../src/core/gitwork.js";
import { preSnapshot, createOrResumeBranch, shortstat } from "../src/core/gitwork.js";
import type { Runner, RunResult } from "../src/core/gitwork.js";

/** Fake runner: `replies` maps a "cmd arg arg" key to a scripted RunResult; default {code:0,stdout:""}. */
function fakeRunner(replies: Record<string, RunResult>) {
  const calls: string[][] = [];
  const r: Runner = {
    run(cmd, args) { calls.push([cmd, ...args]); return replies[[cmd, ...args].join(" ")] ?? { code: 0, stdout: "" }; },
  };
  return { r, calls };
}

describe("gitwork pure decisions", () => {
  it("classifyDirty: any porcelain output is dirty", () => {
    expect(classifyDirty("")).toBe(false);
    expect(classifyDirty("   \n ")).toBe(false);
    expect(classifyDirty(" M src/a.ts\n?? new.ts\n")).toBe(true);
  });
  it("finishAutoAction: a remote means pr, none means keep", () => {
    expect(finishAutoAction("origin\n")).toBe("pr");
    expect(finishAutoAction("")).toBe("keep");
    expect(finishAutoAction("   ")).toBe("keep");
  });
});

describe("preSnapshot", () => {
  it("clean tree: records branch + HEAD, no commit", () => {
    const { r, calls } = fakeRunner({
      "git rev-parse --git-dir": { code: 0, stdout: ".git\n" },
      "git symbolic-ref --short HEAD": { code: 0, stdout: "main\n" },
      "git rev-parse HEAD": { code: 0, stdout: "base111\n" },
      "git status --porcelain": { code: 0, stdout: "" },
    });
    expect(preSnapshot(r, "auth")).toEqual({ branch: "main", baseSha: "base111", state: "clean" });
    expect(calls.some((c) => c[1] === "commit")).toBe(false);
  });
  it("dirty tree: add -A + WIP commit, records new HEAD", () => {
    let head = "old";
    const r: Runner = {
      run(cmd, args) {
        const k = [cmd, ...args].join(" ");
        if (k === "git rev-parse --git-dir") return { code: 0, stdout: ".git" };
        if (k === "git symbolic-ref --short HEAD") return { code: 0, stdout: "main" };
        if (k === "git rev-parse HEAD") return { code: 0, stdout: head };
        if (k === "git status --porcelain") return { code: 0, stdout: " M a.ts" };
        if (k === "git add -A") return { code: 0, stdout: "" };
        if (cmd === "git" && args[0] === "commit") { head = "new222"; return { code: 0, stdout: "" }; }
        return { code: 0, stdout: "" };
      },
    };
    expect(preSnapshot(r, "auth")).toEqual({ branch: "main", baseSha: "new222", state: "wip-committed" });
  });
  it("hook-blocked: commit fails, falls back to pre-attempt HEAD, not fatal", () => {
    const { r } = fakeRunner({
      "git rev-parse --git-dir": { code: 0, stdout: ".git" },
      "git symbolic-ref --short HEAD": { code: 0, stdout: "main" },
      "git rev-parse HEAD": { code: 0, stdout: "pre999" },
      "git status --porcelain": { code: 0, stdout: " M a.ts" },
      "git commit -q -m chore: WIP before solo auth": { code: 1, stdout: "" },
    });
    expect(preSnapshot(r, "auth")).toEqual({ branch: "main", baseSha: "pre999", state: "hook-blocked" });
  });
  it("not-git: rev-parse fails", () => {
    const { r } = fakeRunner({ "git rev-parse --git-dir": { code: 128, stdout: "" } });
    expect(preSnapshot(r, "auth")).toEqual({ branch: "", baseSha: "", state: "not-git" });
  });
});

describe("createOrResumeBranch", () => {
  it("creates with checkout -b when the ref is absent", () => {
    const { r, calls } = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/solo-auth": { code: 1, stdout: "" } });
    expect(createOrResumeBranch(r, "feat/solo-auth")).toBe(true);
    expect(calls).toContainEqual(["git", "checkout", "-q", "-b", "feat/solo-auth"]);
  });
  it("resumes with checkout when the ref exists", () => {
    const { r, calls } = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/solo-auth": { code: 0, stdout: "" } });
    expect(createOrResumeBranch(r, "feat/solo-auth")).toBe(true);
    expect(calls).toContainEqual(["git", "checkout", "-q", "feat/solo-auth"]);
  });
});

describe("shortstat", () => {
  it("returns the trimmed diff --shortstat base..HEAD", () => {
    const { r } = fakeRunner({ "git diff --shortstat base..HEAD": { code: 0, stdout: " 2 files changed\n" } });
    expect(shortstat(r, "base")).toBe("2 files changed");
  });
});
