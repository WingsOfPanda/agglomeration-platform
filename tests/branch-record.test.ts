// tests/branch-record.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { branchNameFor, readBranchRecord, sliceBranchFor } from "../src/core/branchRecord.js";

describe("branchNameFor", () => {
  it("spells each command's branch exactly as its call sites did", () => {
    expect(branchNameFor("quick", "auth")).toBe("feat/quick-auth");
    expect(branchNameFor("implement", "add-oauth")).toBe("feat/implement-add-oauth");
    expect(branchNameFor("bridge", "t")).toBe("feat/bridge-t");
  });

  // parallel-slices C: a hyphen, not a slash — git refuses `feat/implement-x` beside
  // `feat/implement-x/y` in one ref store.
  it("a slice branch is the implement branch plus -<agent>", () => {
    expect(sliceBranchFor("add-oauth", "alpha")).toBe("feat/implement-add-oauth-alpha");
    expect(sliceBranchFor("add-oauth", "alpha").startsWith(branchNameFor("implement", "add-oauth") + "-")).toBe(true);
  });

  it("an empty topic is the command's branch PREFIX (bridge's single-occupancy match)", () => {
    expect(branchNameFor("bridge", "")).toBe("feat/bridge-");
    expect("feat/bridge-other".startsWith(branchNameFor("bridge", ""))).toBe(true);
    expect("feat/quick-other".startsWith(branchNameFor("bridge", ""))).toBe(false);
  });
});

describe("readBranchRecord", () => {
  let h: { home: string; cleanup: () => void };
  let dir: string;
  beforeEach(() => { h = freshHome(); dir = join(h.home, "state"); mkdirSync(join(dir, "baselines"), { recursive: true }); });
  afterEach(() => { h.cleanup(); });

  const write = (rel: string, body: string) => writeFileSync(join(dir, rel), body);

  it("quick: the three execute/ files, and no mode of its own", () => {
    write("branch.txt", "feat/quick-auth\n");
    write("start-branch.txt", "main\n");
    write("branch-base.sha", "base000\n");
    expect(readBranchRecord("quick", { dir })).toEqual({
      branch: "feat/quick-auth", startBranch: "main", baseSha: "base000", mode: "branch",
    });
  });

  it("quick: a stray mode.txt cannot flip the mode — only bridge has one", () => {
    write("mode.txt", "in-place\n");
    expect(readBranchRecord("quick", { dir }).mode).toBe("branch");
  });

  it("bridge: mode.txt decides in-place; anything else (including absent) is branch", () => {
    write("branch.txt", "feat/bridge-t\n");
    write("start-branch.txt", "develop\n");
    write("branch-base.sha", "base1\n");
    expect(readBranchRecord("bridge", { dir })).toEqual({
      branch: "feat/bridge-t", startBranch: "develop", baseSha: "base1", mode: "branch",
    });
    write("mode.txt", "in-place\n");
    expect(readBranchRecord("bridge", { dir }).mode).toBe("in-place");
    write("mode.txt", "branch\n");
    expect(readBranchRecord("bridge", { dir }).mode).toBe("branch");
  });

  it("implement: per-slug rows — the map row and the baseline of THIS slug, not another's", () => {
    write("implement-branches.tsv", "app\tfeat/implement-add-oauth\nlib\tfeat/implement-other\n");
    write(join("baselines", "app.tsv"), "slug=app\ncwd=/proj\nbranch=main\nbaseline_sha=aaa\nstate=clean\n");
    write(join("baselines", "lib.tsv"), "slug=lib\ncwd=/lib\nbranch=develop\nbaseline_sha=bbb\nstate=clean\n");
    write("branch-base.sha", "aaa\n");
    write("branch-mode.txt", "branch\n");
    expect(readBranchRecord("implement", { dir, slug: "app" })).toEqual({
      branch: "feat/implement-add-oauth", startBranch: "main", baseSha: "aaa", mode: "branch",
    });
    expect(readBranchRecord("implement", { dir, slug: "lib" }).startBranch).toBe("develop");
  });

  it("implement: a slug with no row reads as unrecorded, never as another slug's branch", () => {
    write("implement-branches.tsv", "app\tfeat/implement-add-oauth\n");
    expect(readBranchRecord("implement", { dir, slug: "gone" }).branch).toBe("");
  });

  it("implement: --no-branch is the recorded mode; a missing mode file reads as branch", () => {
    expect(readBranchRecord("implement", { dir, slug: "app" }).mode).toBe("branch");
    write("branch-mode.txt", "no-branch\n");
    expect(readBranchRecord("implement", { dir, slug: "app" }).mode).toBe("no-branch");
  });

  it("missing files: every field is the empty record, and each consumer words its own default", () => {
    const empty = { branch: "", startBranch: "", baseSha: "", mode: "branch" };
    expect(readBranchRecord("quick", { dir })).toEqual(empty);
    expect(readBranchRecord("bridge", { dir })).toEqual(empty);
    expect(readBranchRecord("implement", { dir, slug: "app" })).toEqual(empty);
  });

  it("(detached) passes through verbatim — it is a recorded fact, not an absence", () => {
    write("start-branch.txt", "(detached)\n");
    write("branch.txt", "(detached)\n");
    expect(readBranchRecord("quick", { dir })).toMatchObject({ branch: "(detached)", startBranch: "(detached)" });
    write(join("baselines", "app.tsv"), "slug=app\nbranch=(detached)\nbaseline_sha=aaa\n");
    expect(readBranchRecord("implement", { dir, slug: "app" }).startBranch).toBe("(detached)");
  });
});
