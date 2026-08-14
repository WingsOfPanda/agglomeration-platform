// tests/gitwork-finishwork.test.ts — the deep finisher the three exported wrappers share.
import { describe, it, expect } from "vitest";
import { finishWork, finishBranch } from "../src/core/gitwork.js";
import type { Runner, RunResult, FinishWorkOpts } from "../src/core/gitwork.js";

function fakeRunner(replies: Record<string, RunResult>) {
  const calls: string[][] = [];
  const r: Runner = { run(cmd, args) { calls.push([cmd, ...args]); return replies[[cmd, ...args].join(" ")] ?? { code: 0, stdout: "" }; } };
  return { r, calls };
}
const REF = (b: string) => `git show-ref --verify --quiet refs/heads/${b}`;
const EXISTS = { [REF("feat/x")]: { code: 0, stdout: "" } };
const base = { branch: "feat/x", base: "main", hasGh: false, titlePrefix: "quick" as const };
const opts = (o: Partial<FinishWorkOpts> & { action: FinishWorkOpts["action"] }): FinishWorkOpts => ({ ...base, ...o });

describe("finishWork guard", () => {
  it("empty branch: refuses before touching git", () => {
    const { r, calls } = fakeRunner({});
    expect(finishWork(r, opts({ branch: "", action: "merge" }))).toEqual({ action: "none", outcome: "no-branch" });
    expect(calls.length).toBe(0);
  });
  it("branch === base: refuses without a ref probe", () => {
    const { r, calls } = fakeRunner({});
    expect(finishWork(r, opts({ branch: "main", action: "pr" }))).toEqual({ action: "none", outcome: "no-branch" });
    expect(calls.length).toBe(0);
  });
  it("ref missing: one show-ref, then nothing — no checkout, no push, no gh", () => {
    const { r, calls } = fakeRunner({ [REF("feat/x")]: { code: 1, stdout: "" } });
    for (const action of ["auto", "merge", "pr", "keep", "discard", "pr-merge"] as const) {
      expect(finishWork(r, opts({ action }))).toEqual({ action: "none", outcome: "no-branch" });
    }
    expect(calls.every((c) => c[1] === "show-ref")).toBe(true);
  });
});

describe("finishWork arms", () => {
  it("auto with no remote → keep/kept, base restored", () => {
    const { r, calls } = fakeRunner({ ...EXISTS, "git remote": { code: 0, stdout: "" } });
    expect(finishWork(r, opts({ action: "auto" }))).toEqual({ action: "keep", outcome: "kept" });
    expect(calls[calls.length - 1]).toEqual(["git", "checkout", "-q", "main"]);
  });
  it("auto with a remote → the pr arm", () => {
    const { r } = fakeRunner({ ...EXISTS, "git remote": { code: 0, stdout: "origin\n" } });
    expect(finishWork(r, opts({ action: "auto", hasGh: true }))).toEqual({ action: "pr", outcome: "pr-opened" });
  });
  it("merge → merged + branch -D, base checked out first", () => {
    const { r, calls } = fakeRunner({ ...EXISTS });
    expect(finishWork(r, opts({ action: "merge" }))).toEqual({ action: "merge", outcome: "merged" });
    const keys = calls.map((c) => c.join(" "));
    expect(keys.indexOf("git checkout -q main")).toBeLessThan(keys.indexOf("git merge --no-edit -q feat/x"));
    expect(calls).toContainEqual(["git", "branch", "-q", "-D", "feat/x"]);
  });
  it("merge conflict → merge-conflict-left + abort, branch kept", () => {
    const { r, calls } = fakeRunner({ ...EXISTS, "git merge --no-edit -q feat/x": { code: 1, stdout: "" } });
    expect(finishWork(r, opts({ action: "merge" }))).toEqual({ action: "merge", outcome: "merge-conflict-left" });
    expect(calls).toContainEqual(["git", "merge", "--abort"]);
    expect(calls.some((c) => c[1] === "branch")).toBe(false);
  });
  it("keep → kept (checkout only)", () => {
    const { r, calls } = fakeRunner({ ...EXISTS });
    expect(finishWork(r, opts({ action: "keep" }))).toEqual({ action: "keep", outcome: "kept" });
    expect(calls.some((c) => c[1] === "branch")).toBe(false);
  });
  it("discard → discarded + branch -D", () => {
    const { r, calls } = fakeRunner({ ...EXISTS });
    expect(finishWork(r, opts({ action: "discard" }))).toEqual({ action: "discard", outcome: "discarded" });
    expect(calls).toContainEqual(["git", "branch", "-q", "-D", "feat/x"]);
  });
});

describe("finishWork pr arm (pushAndPr)", () => {
  const pushable = { ...EXISTS, "git remote get-url origin": { code: 0, stdout: "git@h:o/r.git\n" } };

  it("push + gh ok → pr-opened; titlePrefix brands the default title and body", () => {
    const { r, calls } = fakeRunner(pushable);
    expect(finishWork(r, opts({ action: "pr", hasGh: true, titlePrefix: "implement" })).outcome).toBe("pr-opened");
    expect(calls.find((c) => c[0] === "gh")).toEqual(["gh", "pr", "create", "--repo", "git@h:o/r.git", "--base", "main", "--head", "feat/x",
      "--title", "implement: feat/x", "--body", "Automated implement branch. Review and merge into main."]);
    expect(calls[calls.length - 1]).toEqual(["git", "checkout", "-q", "main"]);
  });
  it("explicit title/body/originUrl win over the defaults (no get-url probe)", () => {
    const { r, calls } = fakeRunner(pushable);
    finishWork(r, opts({ action: "pr", hasGh: true, originUrl: "u", title: "T", body: "B" }));
    expect(calls.some((c) => c.join(" ") === "git remote get-url origin")).toBe(false);
    expect(calls.find((c) => c[0] === "gh")?.slice(-4)).toEqual(["--title", "T", "--body", "B"]);
  });
  it("no gh → pr-pushed-no-gh, no gh call, base still restored", () => {
    const { r, calls } = fakeRunner(pushable);
    expect(finishWork(r, opts({ action: "pr" })).outcome).toBe("pr-pushed-no-gh");
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
    expect(calls[calls.length - 1]).toEqual(["git", "checkout", "-q", "main"]);
  });
  it("gh pr create fails → pr-pushed-no-gh (the push landed)", () => {
    const { r } = fakeRunner({ ...pushable, "gh pr create --repo git@h:o/r.git --base main --head feat/x --title quick: feat/x --body Automated quick branch. Review and merge into main.": { code: 1, stdout: "" } });
    expect(finishWork(r, opts({ action: "pr", hasGh: true })).outcome).toBe("pr-pushed-no-gh");
  });
  it("push fails → pr-failed-kept, no url probe, no gh", () => {
    const { r, calls } = fakeRunner({ ...pushable, "git push -q -u origin feat/x": { code: 1, stdout: "" } });
    expect(finishWork(r, opts({ action: "pr", hasGh: true })).outcome).toBe("pr-failed-kept");
    expect(calls.some((c) => c[0] === "gh" || c.join(" ") === "git remote get-url origin")).toBe(false);
  });
});

describe("finishWork pr-merge arm", () => {
  it("remote + gh → pr-merged-pulled (the wrapper table pins the rest)", () => {
    const { r } = fakeRunner({ ...EXISTS, "git remote": { code: 0, stdout: "origin\n" }, "git remote get-url origin": { code: 0, stdout: "u\n" } });
    expect(finishWork(r, opts({ action: "pr-merge", hasGh: true, titlePrefix: "bridge" })))
      .toEqual({ action: "pr-merge", outcome: "pr-merged-pulled" });
  });
  it("no remote → local-merge, and the pr arm's outcomes are never reused here", () => {
    const { r, calls } = fakeRunner({ ...EXISTS, "git remote": { code: 0, stdout: "" } });
    expect(finishWork(r, opts({ action: "pr-merge", hasGh: true, titlePrefix: "bridge" })))
      .toEqual({ action: "local-merge", outcome: "local-merged-no-remote" });
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
  });
});

// The wrappers' guard mapping — a hand-rolled finishBranch body (the pre-collapse one, which had no
// guard) pushes a branch that does not exist and fails here.
describe("finishBranch wrapper", () => {
  it("ref missing → none/no-branch, nothing pushed", () => {
    const { r, calls } = fakeRunner({ [REF("feat/quick-auth")]: { code: 1, stdout: "" } });
    expect(finishBranch(r, { branch: "feat/quick-auth", startBranch: "main", hasGh: true }))
      .toEqual({ action: "none", outcome: "no-branch" });
    expect(calls.some((c) => c[1] === "push" || c[0] === "gh")).toBe(false);
  });
});
