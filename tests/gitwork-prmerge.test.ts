import { describe, it, expect } from "vitest";
import { finishBranchPrMerge } from "../src/core/gitwork.js";
import type { Runner } from "../src/core/gitwork.js";

// Fake Runner keyed on the "cmd arg arg..." string; prefix-matched, default code 0.
function fakeRunner(map: Record<string, { code?: number; stdout?: string }>, log?: string[]): Runner {
  return {
    run: (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (log) log.push(key);
      let hit = map[key];
      if (!hit) for (const k of Object.keys(map)) { if (key.startsWith(k)) { hit = map[k]; break; } }
      return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "" };
    },
  };
}
const BRANCH_EXISTS = { "git show-ref --verify --quiet refs/heads/feat/bridge-x": { code: 0 } };

describe("finishBranchPrMerge", () => {
  const opts = { branch: "feat/bridge-x", base: "main", hasGh: true, title: "bridge: feat/bridge-x", body: "b" };

  it("happy path (remote + gh): push → pr create → checkout base → pr merge → pull --ff-only", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "git@x:y.git\n" } }, log);
    const res = finishBranchPrMerge(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-merged-pulled" });
    const seq = log.join(" | ");
    expect(seq).toMatch(/git push -q -u origin feat\/bridge-x/);
    expect(seq).toMatch(/gh pr create .*--base main --head feat\/bridge-x/);
    expect(seq).toMatch(/git checkout -q main/);
    expect(seq).toMatch(/gh pr merge feat\/bridge-x --merge --delete-branch/);
    expect(seq).toMatch(/git pull --ff-only origin main/);
  });

  it("no remote → local merge into base, no gh/pr", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "" } }, log);
    const res = finishBranchPrMerge(r, opts);
    expect(res).toEqual({ action: "local-merge", outcome: "local-merged-no-remote" });
    expect(log.join(" | ")).not.toMatch(/gh /);
    expect(log.join(" | ")).toMatch(/git merge --no-edit -q feat\/bridge-x/);
  });

  it("no gh → push only, base not merged", () => {
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" } });
    const res = finishBranchPrMerge(r, { ...opts, hasGh: false });
    expect(res).toEqual({ action: "push-only", outcome: "pushed-no-gh" });
  });

  it("pr merge blocked → PR left open", () => {
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "gh pr merge": { code: 1 } });
    const res = finishBranchPrMerge(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-open-merge-blocked" });
  });

  it("pull can't fast-forward → reported, remote merge already done", () => {
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "git pull --ff-only": { code: 1 } });
    const res = finishBranchPrMerge(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-merged-pull-failed" });
  });

  it("no branch (ref missing) → none", () => {
    const r = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/bridge-x": { code: 1 }, "git remote": { stdout: "origin\n" } });
    const res = finishBranchPrMerge(r, opts);
    expect(res).toEqual({ action: "none", outcome: "no-branch" });
  });

  it("pr create fails + no existing PR → pr-create-failed (existence checked, no merge)", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "gh pr create": { code: 1 }, "gh pr view": { code: 1 } }, log);
    const res = finishBranchPrMerge(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-create-failed" });
    const seq = log.join(" | ");
    expect(seq).toMatch(/gh pr view feat\/bridge-x --repo u --json number/);
    expect(seq).not.toMatch(/gh pr merge/);
  });

  it("pr create fails but a PR already exists → merges it (worker self-created the PR)", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "gh pr create": { code: 1 }, "gh pr view": { code: 0 } }, log);
    const res = finishBranchPrMerge(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-merged-pulled" });
    const seq = log.join(" | ");
    expect(seq).toMatch(/gh pr view feat\/bridge-x --repo u --json number/);
    expect(seq).toMatch(/gh pr merge feat\/bridge-x --merge --delete-branch/);
  });
});
