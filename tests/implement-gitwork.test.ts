import { describe, it, expect } from "vitest";
import { finishWork } from "../src/core/gitwork.js";
import type { Runner, RunResult } from "../src/core/gitwork.js";

function fakeRunner(replies: Record<string, RunResult>) {
  const calls: string[][] = [];
  const r: Runner = { run(cmd, args) { calls.push([cmd, ...args]); return replies[[cmd, ...args].join(" ")] ?? { code: 0, stdout: "" }; } };
  return { r, calls };
}
const REF = (b: string) => `git show-ref --verify --quiet refs/heads/${b}`;

describe("finishWork under implement's options (branch action + implement: PR branding)", () => {
  it("no-branch: empty branch / branch===start / show-ref fails → no checkout/merge", () => {
    const a = fakeRunner({}); expect(finishWork(a.r, { branch: "", base: "main", action: "merge", hasGh: false, titlePrefix: "implement" }).outcome).toBe("no-branch");
    expect(a.calls.length).toBe(0);
    const b = fakeRunner({}); expect(finishWork(b.r, { branch: "main", base: "main", action: "merge", hasGh: false, titlePrefix: "implement" }).outcome).toBe("no-branch");
    const c = fakeRunner({ [REF("feat/x")]: { code: 1, stdout: "" } }); expect(finishWork(c.r, { branch: "feat/x", base: "main", action: "merge", hasGh: false, titlePrefix: "implement" }).outcome).toBe("no-branch");
    expect(c.calls.some((x) => x[1] === "merge" || x[1] === "checkout")).toBe(false);
  });
  it("merge success → merged + branch -D, checkout start first", () => {
    const { r, calls } = fakeRunner({ [REF("feat/x")]: { code: 0, stdout: "" }, "git merge --no-edit -q feat/x": { code: 0, stdout: "" } });
    expect(finishWork(r, { branch: "feat/x", base: "main", action: "merge", hasGh: false, titlePrefix: "implement" }).outcome).toBe("merged");
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
    expect(calls).toContainEqual(["git", "branch", "-q", "-D", "feat/x"]);
  });
  it("merge conflict → merge-conflict-left + abort, no -D", () => {
    const { r, calls } = fakeRunner({ [REF("feat/x")]: { code: 0, stdout: "" }, "git merge --no-edit -q feat/x": { code: 1, stdout: "" } });
    expect(finishWork(r, { branch: "feat/x", base: "main", action: "merge", hasGh: false, titlePrefix: "implement" }).outcome).toBe("merge-conflict-left");
    expect(calls).toContainEqual(["git", "merge", "--abort"]);
    expect(calls.some((x) => x[1] === "branch" && x[2] === "-q" && x[3] === "-D")).toBe(false);
  });
  it("keep → kept (checkout start only)", () => {
    const { r, calls } = fakeRunner({ [REF("feat/x")]: { code: 0, stdout: "" } });
    expect(finishWork(r, { branch: "feat/x", base: "main", action: "keep", hasGh: false, titlePrefix: "implement" }).outcome).toBe("kept");
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
    expect(calls.some((x) => x[1] === "branch")).toBe(false);
  });
  it("discard → discarded + branch -D", () => {
    const { r, calls } = fakeRunner({ [REF("feat/x")]: { code: 0, stdout: "" } });
    expect(finishWork(r, { branch: "feat/x", base: "main", action: "discard", hasGh: false, titlePrefix: "implement" }).outcome).toBe("discarded");
    expect(calls).toContainEqual(["git", "branch", "-q", "-D", "feat/x"]);
  });
  it("pr: push ok + gh ok → pr-opened with implement: title", () => {
    const { r, calls } = fakeRunner({ [REF("feat/x")]: { code: 0, stdout: "" }, "git push -q -u origin feat/x": { code: 0, stdout: "" }, "git remote get-url origin": { code: 0, stdout: "git@h:o/r.git\n" } });
    expect(finishWork(r, { branch: "feat/x", base: "main", action: "pr", hasGh: true, titlePrefix: "implement" }).outcome).toBe("pr-opened");
    const gh = calls.find((x) => x[0] === "gh");
    expect(gh).toEqual(["gh", "pr", "create", "--repo", "git@h:o/r.git", "--base", "main", "--head", "feat/x", "--title", "implement: feat/x", "--body", "Automated implement branch. Review and merge into main."]);
    expect(calls[calls.length - 1]).toEqual(["git", "checkout", "-q", "main"]);
  });
  it("pr: push ok, no gh → pr-pushed-no-gh (no gh call)", () => {
    const { r, calls } = fakeRunner({ [REF("feat/x")]: { code: 0, stdout: "" }, "git push -q -u origin feat/x": { code: 0, stdout: "" } });
    expect(finishWork(r, { branch: "feat/x", base: "main", action: "pr", hasGh: false, titlePrefix: "implement" }).outcome).toBe("pr-pushed-no-gh");
    expect(calls.some((x) => x[0] === "gh")).toBe(false);
  });
  it("pr: push fail → pr-failed-kept", () => {
    const { r } = fakeRunner({ [REF("feat/x")]: { code: 0, stdout: "" }, "git push -q -u origin feat/x": { code: 1, stdout: "" } });
    expect(finishWork(r, { branch: "feat/x", base: "main", action: "pr", hasGh: true, titlePrefix: "implement" }).outcome).toBe("pr-failed-kept");
  });
});
