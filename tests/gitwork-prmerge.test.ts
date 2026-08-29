import { describe, it, expect } from "vitest";
import { finishWork } from "../src/core/gitwork.js";
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

describe("finishWork under bridge's options (pr-merge action + bridge: PR branding)", () => {
  const opts = { branch: "feat/bridge-x", base: "main", action: "pr-merge" as const, hasGh: true, titlePrefix: "bridge" as const, title: "bridge: feat/bridge-x", body: "b" };

  it("happy path (remote + gh): push → pr create → checkout base → pr merge → pull --ff-only", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "git@x:y.git\n" } }, log);
    const res = finishWork(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-merged-pulled" });
    const seq = log.join(" | ");
    expect(seq).toMatch(/git push -q -u origin feat\/bridge-x/);
    expect(seq).toMatch(/gh pr create .*--base main --head feat\/bridge-x/);
    expect(seq).toMatch(/git checkout -q main/);
    expect(seq).toMatch(/gh pr merge feat\/bridge-x --merge --delete-branch/);
    expect(seq).toMatch(/git pull --ff-only origin main/);
  });

  it("default title/body: bridge branding, spelled out in full", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" } }, log);
    finishWork(r, { branch: "feat/bridge-x", base: "main", action: "pr-merge", hasGh: true, titlePrefix: "bridge" });
    expect(log).toContain("gh pr create --repo u --base main --head feat/bridge-x --title bridge: feat/bridge-x --body Automated bridge branch. Merged into main.");
  });

  it("no remote → local merge into base, no gh/pr", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "" } }, log);
    const res = finishWork(r, opts);
    expect(res).toEqual({ action: "local-merge", outcome: "local-merged-no-remote" });
    expect(log.join(" | ")).not.toMatch(/gh /);
    expect(log.join(" | ")).toMatch(/git merge --no-edit -q feat\/bridge-x/);
  });

  it("no gh → push only, base not merged", () => {
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" } });
    const res = finishWork(r, { ...opts, hasGh: false });
    expect(res).toEqual({ action: "push-only", outcome: "pushed-no-gh" });
  });

  it("pr merge blocked → PR left open", () => {
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "gh pr merge": { code: 1 } });
    const res = finishWork(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-open-merge-blocked" });
  });

  it("pull can't fast-forward → reported, remote merge already done", () => {
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "git pull --ff-only": { code: 1 } });
    const res = finishWork(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-merged-pull-failed" });
  });

  it("no branch (ref missing) → none", () => {
    const r = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/bridge-x": { code: 1 }, "git remote": { stdout: "origin\n" } });
    const res = finishWork(r, opts);
    expect(res).toEqual({ action: "none", outcome: "no-branch" });
  });

  it("pr create fails + no existing PR → pr-create-failed (existence checked, no merge)", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "gh pr create": { code: 1 }, "gh pr view": { code: 1 } }, log);
    const res = finishWork(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-create-failed" });
    const seq = log.join(" | ");
    expect(seq).toMatch(/gh pr view feat\/bridge-x --repo u --json number/);
    expect(seq).not.toMatch(/gh pr merge/);
  });

  // The two load-bearing checkouts in this arm: refused, the finisher stops before the step that
  // would decide an outcome — otherwise `gh pr merge` lands and `git pull --ff-only` fast-forwards
  // the FEATURE branch, recording pr-merged-pulled over a base that never moved.
  it("base checkout refused (remote + gh) → base-checkout-failed, no gh pr merge, no pull", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "git checkout -q main": { code: 1 } }, log);
    const res = finishWork(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "base-checkout-failed" });
    const seq = log.join(" | ");
    expect(seq).toMatch(/git push -q -u origin feat\/bridge-x/);   // the push and the PR did happen
    expect(seq).toMatch(/gh pr create /);
    expect(seq).not.toMatch(/gh pr merge/);
    expect(seq).not.toMatch(/git pull/);
  });

  it("a post-checkout hook failing after the switch still merges the PR (rc is not the switch)", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "git checkout -q main": { code: 1 }, "git symbolic-ref HEAD": { stdout: "refs/heads/main\n" } }, log);
    expect(finishWork(r, opts)).toEqual({ action: "pr-merge", outcome: "pr-merged-pulled" });
    expect(log.join(" | ")).toMatch(/gh pr merge feat\/bridge-x --merge --delete-branch/);
  });

  it("base checkout refused (no remote) → base-checkout-failed, nothing merged into base", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "" }, "git checkout -q main": { code: 1 } }, log);
    const res = finishWork(r, opts);
    expect(res).toEqual({ action: "local-merge", outcome: "base-checkout-failed" });
    expect(log.join(" | ")).not.toMatch(/git merge|git branch/);
  });

  it("pr create fails but a PR already exists → merges it (worker self-created the PR)", () => {
    const log: string[] = [];
    const r = fakeRunner({ ...BRANCH_EXISTS, "git remote": { stdout: "origin\n" }, "git remote get-url origin": { stdout: "u\n" }, "gh pr create": { code: 1 }, "gh pr view": { code: 0 } }, log);
    const res = finishWork(r, opts);
    expect(res).toEqual({ action: "pr-merge", outcome: "pr-merged-pulled" });
    const seq = log.join(" | ");
    expect(seq).toMatch(/gh pr view feat\/bridge-x --repo u --json number/);
    expect(seq).toMatch(/gh pr merge feat\/bridge-x --merge --delete-branch/);
  });
});
