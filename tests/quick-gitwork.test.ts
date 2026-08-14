// tests/quick-gitwork.test.ts
import { describe, it, expect } from "vitest";
import { classifyDirty, finishAutoAction } from "../src/core/gitwork.js";
import { preSnapshot, createOrResumeBranch, shortstat } from "../src/core/gitwork.js";
import { finishBranch, stashPush, stashPopByMessage, stashPopOnBranch, findStashRef } from "../src/core/gitwork.js";
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
    expect(preSnapshot(r, "quick", "auth")).toEqual({ branch: "main", baseSha: "base111", state: "clean" });
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
    expect(preSnapshot(r, "quick", "auth")).toEqual({ branch: "main", baseSha: "new222", state: "wip-committed" });
  });
  it("hook-blocked: commit fails, falls back to pre-attempt HEAD, not fatal", () => {
    const { r } = fakeRunner({
      "git rev-parse --git-dir": { code: 0, stdout: ".git" },
      "git symbolic-ref --short HEAD": { code: 0, stdout: "main" },
      "git rev-parse HEAD": { code: 0, stdout: "pre999" },
      "git status --porcelain": { code: 0, stdout: " M a.ts" },
      "git commit -q -m chore: WIP before quick auth": { code: 1, stdout: "" },
    });
    expect(preSnapshot(r, "quick", "auth")).toEqual({ branch: "main", baseSha: "pre999", state: "hook-blocked" });
  });
  it("threads the command label into the WIP message (implement)", () => {
    const { r } = fakeRunner({
      "git rev-parse --git-dir": { code: 0, stdout: ".git" },
      "git symbolic-ref --short HEAD": { code: 0, stdout: "main" },
      "git rev-parse HEAD": { code: 0, stdout: "pre999" },
      "git status --porcelain": { code: 0, stdout: " M a.ts" },
      "git commit -q -m chore: WIP before implement auth": { code: 1, stdout: "" },
    });
    expect(preSnapshot(r, "implement", "auth")).toEqual({ branch: "main", baseSha: "pre999", state: "hook-blocked" });
  });
  it("not-git: rev-parse fails", () => {
    const { r } = fakeRunner({ "git rev-parse --git-dir": { code: 128, stdout: "" } });
    expect(preSnapshot(r, "quick", "auth")).toEqual({ branch: "", baseSha: "", state: "not-git" });
  });
});

describe("stashPush / findStashRef / stashPopByMessage", () => {
  const LIST = "git stash list --format=%gd%x09%gs";
  const ENTRY = "stash@{0}\tOn main: ap-quick-auth-wip\n";
  const STATUS = "git status --porcelain --untracked-files=all";

  /** The stash as seen at one point in time: what `stash list` prints, and what each ref rev-parses
   *  to (absent → rc 128). `fakeStash` flips from `pre` to `post` when `git stash push` runs, which
   *  is what makes a push that CREATED nothing distinguishable from one that created an entry. */
  type StashState = { list: string; shas: Record<string, string> };
  const EMPTY: StashState = { list: "", shas: {} };
  const ours = (sha: string): StashState => ({ list: ENTRY, shas: { "stash@{0}": sha } });

  function fakeStash(o: { pre: StashState; post: StashState; pushRc?: number; dirtyAfter?: string }) {
    const calls: string[][] = [];
    let pushed = false;
    const now = (): StashState => (pushed ? o.post : o.pre);
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === LIST) return { code: 0, stdout: now().list };
      if (args[0] === "stash" && args[1] === "push") { pushed = true; return { code: o.pushRc ?? 0, stdout: "" }; }
      if (args[0] === "rev-parse") {
        const s = now().shas[args[1]];
        return s ? { code: 0, stdout: s + "\n" } : { code: 128, stdout: "" };
      }
      if (k === STATUS) return { code: 0, stdout: o.dirtyAfter ?? "" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }

  it("stashPush parked: a NEW entry exists and the tree came back clean", () => {
    const { r, calls } = fakeStash({ pre: EMPTY, post: ours("d00a77d") });
    expect(stashPush(r, "ap-quick-auth-wip")).toEqual({ outcome: "parked", sha: "d00a77d", entryExists: true });
    expect(calls[0]).toEqual(["git", "stash", "list", "--format=%gd%x09%gs"]);   // pre-push identity
    expect(calls[1]).toEqual(["git", "stash", "push", "--include-untracked", "-m", "ap-quick-auth-wip"]);
    // Identity comes from the located entry, never from refs/stash (which is just whatever is on top).
    expect(calls.some((c) => c.join(" ") === "git rev-parse refs/stash")).toBe(false);
  });
  it("stashPush partial: rc 0 + a new entry, but the tree is STILL dirty (git could not stash some paths)", () => {
    const { r } = fakeStash({ pre: EMPTY, post: ours("d00a77d"), dirtyAfter: "?? nested-repo/\n" });
    expect(stashPush(r, "ap-quick-auth-wip")).toEqual({ outcome: "partial", sha: "d00a77d", entryExists: true });
  });
  it("stashPush none: rc 0 but nothing was stashed ('No local changes to save')", () => {
    const { r, calls } = fakeStash({ pre: EMPTY, post: { list: "stash@{0}\tOn main: someone else\n", shas: {} } });
    expect(stashPush(r, "ap-quick-auth-wip")).toEqual({ outcome: "none", sha: "", entryExists: false });
    expect(calls.some((c) => c[1] === "rev-parse")).toBe(false);
  });
  it("stashPush none: a LEFTOVER same-named entry from an aborted run is never adopted as ours", () => {
    // The side door: an abandoned ap-quick-<topic>-wip entry plus a push that creates nothing (only
    // submodule content dirty). The scan finds the old entry; the unchanged sha is what exposes it.
    const { r } = fakeStash({ pre: ours("olderrun"), post: ours("olderrun"), dirtyAfter: " M sub\n" });
    expect(stashPush(r, "ap-quick-auth-wip")).toEqual({ outcome: "none", sha: "", entryExists: false });
    const failed = fakeStash({ pre: ours("olderrun"), post: ours("olderrun"), pushRc: 1 });
    expect(stashPush(failed.r, "ap-quick-auth-wip")).toEqual({ outcome: "failed", sha: "", entryExists: false });
  });
  it("stashPush parked: a new entry created ALONGSIDE a same-named leftover records the NEW sha", () => {
    const { r } = fakeStash({
      pre: ours("olderrun"),
      post: { list: ENTRY + "stash@{1}\tOn main: ap-quick-auth-wip\n", shas: { "stash@{0}": "newone", "stash@{1}": "olderrun" } },
    });
    expect(stashPush(r, "ap-quick-auth-wip")).toEqual({ outcome: "parked", sha: "newone", entryExists: true });
  });
  it("stashPush failed-with-entry: rc != 0 but git had already created the entry", () => {
    const { r } = fakeStash({ pre: EMPTY, post: ours("d00a77d"), pushRc: 1 });
    expect(stashPush(r, "ap-quick-auth-wip")).toEqual({ outcome: "failed-with-entry", sha: "d00a77d", entryExists: true });
  });
  it("stashPush failed-with-entry: rc 0 + entry whose sha will not resolve → empty sha, never 'parked'", () => {
    const { r } = fakeStash({ pre: EMPTY, post: { list: ENTRY, shas: {} } });
    expect(stashPush(r, "ap-quick-auth-wip")).toEqual({ outcome: "failed-with-entry", sha: "", entryExists: true });
  });
  it("stashPush failed: rc != 0 and no entry — nothing was stashed", () => {
    const { r, calls } = fakeStash({ pre: EMPTY, post: EMPTY, pushRc: 1 });
    expect(stashPush(r, "ap-quick-auth-wip")).toEqual({ outcome: "failed", sha: "", entryExists: false });
    expect(calls.some((c) => c[1] === "rev-parse")).toBe(false);
  });
  it("findStashRef: matches the 'On <branch>: <msg>' subject git actually records, at any index", () => {
    const list = "stash@{0}\tOn feat/x: someone elses stash\nstash@{2}\tOn main: ap-quick-auth-wip\n";
    expect(findStashRef(list, "ap-quick-auth-wip")).toBe("stash@{2}");
    expect(findStashRef("stash@{0}\tap-quick-auth-wip\n", "ap-quick-auth-wip")).toBe("stash@{0}"); // bare subject
    expect(findStashRef(list, "ap-quick-other-wip")).toBe("");
    expect(findStashRef("", "ap-quick-auth-wip")).toBe("");
  });
  it("stashPopByMessage: pops the located ref when its sha matches → popped", () => {
    const { r, calls } = fakeRunner({
      [LIST]: { code: 0, stdout: "stash@{1}\tOn main: ap-quick-auth-wip\n" },
      "git rev-parse stash@{1}": { code: 0, stdout: "d00a77d\n" },
    });
    expect(stashPopByMessage(r, "ap-quick-auth-wip", "d00a77d")).toBe("popped");
    expect(calls).toContainEqual(["git", "stash", "pop", "stash@{1}"]);
  });
  it("stashPopByMessage: a failing pop → conflict-kept (the entry stays)", () => {
    const { r, calls } = fakeRunner({
      [LIST]: { code: 0, stdout: ENTRY },
      "git rev-parse stash@{0}": { code: 0, stdout: "d00a77d\n" },
      "git stash pop stash@{0}": { code: 1, stdout: "" },
    });
    expect(stashPopByMessage(r, "ap-quick-auth-wip", "d00a77d")).toBe("conflict-kept");
    expect(calls.some((c) => c[1] === "stash" && c[2] === "drop")).toBe(false);
  });
  it("stashPopByMessage: no matching entry → not-found, no pop attempted", () => {
    const { r, calls } = fakeRunner({ [LIST]: { code: 0, stdout: "stash@{0}\tOn main: unrelated\n" } });
    expect(stashPopByMessage(r, "ap-quick-auth-wip", "d00a77d")).toBe("not-found");
    expect(calls.some((c) => c[2] === "pop")).toBe(false);
  });
  it("stashPopByMessage: a same-named FOREIGN entry (sha differs) → identity-mismatch, no pop", () => {
    const { r, calls } = fakeRunner({
      [LIST]: { code: 0, stdout: ENTRY },
      "git rev-parse stash@{0}": { code: 0, stdout: "somebodyelse\n" },
    });
    expect(stashPopByMessage(r, "ap-quick-auth-wip", "d00a77d")).toBe("identity-mismatch");
    expect(calls.some((c) => c[2] === "pop")).toBe(false);
  });
  it("stashPopByMessage: an unrecorded (empty) expected sha → identity-mismatch, no pop", () => {
    const { r, calls } = fakeRunner({ [LIST]: { code: 0, stdout: ENTRY } });
    expect(stashPopByMessage(r, "ap-quick-auth-wip", "")).toBe("identity-mismatch");
    expect(calls.some((c) => c[2] === "pop")).toBe(false);
  });
  it("stashPopByMessage: a FAILING stash list is list-failed, never a verified absence", () => {
    const { r, calls } = fakeRunner({ [LIST]: { code: 128, stdout: "" } });
    expect(stashPopByMessage(r, "ap-quick-auth-wip", "d00a77d")).toBe("list-failed");
    expect(calls.some((c) => c[2] === "pop")).toBe(false);
  });

  describe("stashPopOnBranch (the HEAD precondition)", () => {
    const HEAD = "git symbolic-ref --short HEAD";
    const onMain = { [HEAD]: { code: 0, stdout: "main\n" }, [LIST]: { code: 0, stdout: ENTRY }, "git rev-parse stash@{0}": { code: 0, stdout: "d00a77d\n" } };

    it("HEAD is another branch: wrong-head, the stash list is never even read", () => {
      const { r, calls } = fakeRunner({ ...onMain, [HEAD]: { code: 0, stdout: "feat/quick-auth\n" } });
      expect(stashPopOnBranch(r, "ap-quick-auth-wip", "d00a77d", "main")).toEqual({ outcome: "wrong-head", head: "feat/quick-auth" });
      expect(calls.some((c) => c[1] === "stash")).toBe(false);
    });
    it("detached HEAD: wrong-head with an empty head (the caller words it)", () => {
      const { r, calls } = fakeRunner({ ...onMain, [HEAD]: { code: 128, stdout: "" } });
      expect(stashPopOnBranch(r, "ap-quick-auth-wip", "d00a77d", "main")).toEqual({ outcome: "wrong-head", head: "" });
      expect(calls.some((c) => c[1] === "stash")).toBe(false);
    });
    it("HEAD is the required branch: passes every pop outcome through, with the head", () => {
      const { r, calls } = fakeRunner(onMain);
      expect(stashPopOnBranch(r, "ap-quick-auth-wip", "d00a77d", "main")).toEqual({ outcome: "popped", head: "main" });
      expect(calls).toContainEqual(["git", "stash", "pop", "stash@{0}"]);
      const conflict = fakeRunner({ ...onMain, "git stash pop stash@{0}": { code: 1, stdout: "" } });
      expect(stashPopOnBranch(conflict.r, "ap-quick-auth-wip", "d00a77d", "main").outcome).toBe("conflict-kept");
      const gone = fakeRunner({ ...onMain, [LIST]: { code: 0, stdout: "stash@{0}\tOn main: unrelated\n" } });
      expect(stashPopOnBranch(gone.r, "ap-quick-auth-wip", "d00a77d", "main").outcome).toBe("not-found");
      const unreadable = fakeRunner({ ...onMain, [LIST]: { code: 128, stdout: "" } });
      expect(stashPopOnBranch(unreadable.r, "ap-quick-auth-wip", "d00a77d", "main").outcome).toBe("list-failed");
      const foreign = fakeRunner({ ...onMain, "git rev-parse stash@{0}": { code: 0, stdout: "somebodyelse\n" } });
      expect(stashPopOnBranch(foreign.r, "ap-quick-auth-wip", "d00a77d", "main").outcome).toBe("identity-mismatch");
    });
  });
});

describe("createOrResumeBranch", () => {
  it("creates with checkout -b when the ref is absent", () => {
    const { r, calls } = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/quick-auth": { code: 1, stdout: "" } });
    expect(createOrResumeBranch(r, "feat/quick-auth")).toBe(true);
    expect(calls).toContainEqual(["git", "checkout", "-q", "-b", "feat/quick-auth"]);
  });
  it("resumes with checkout when the ref exists", () => {
    const { r, calls } = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/quick-auth": { code: 0, stdout: "" } });
    expect(createOrResumeBranch(r, "feat/quick-auth")).toBe(true);
    expect(calls).toContainEqual(["git", "checkout", "-q", "feat/quick-auth"]);
  });
});

describe("shortstat", () => {
  it("returns the trimmed diff --shortstat base..HEAD", () => {
    const { r } = fakeRunner({ "git diff --shortstat base..HEAD": { code: 0, stdout: " 2 files changed\n" } });
    expect(shortstat(r, "base")).toBe("2 files changed");
  });
});

describe("finishBranch", () => {
  it("no remote → keep, restores start branch", () => {
    const { r, calls } = fakeRunner({ "git remote": { code: 0, stdout: "" } });
    expect(finishBranch(r, { branch: "feat/quick-auth", startBranch: "main", hasGh: true }))
      .toEqual({ action: "keep", outcome: "kept" });
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
  });
  it("remote + gh → push + pr-opened, restores start branch", () => {
    const { r, calls } = fakeRunner({
      "git remote": { code: 0, stdout: "origin\n" },
      "git push -q -u origin feat/quick-auth": { code: 0, stdout: "" },
      "git remote get-url origin": { code: 0, stdout: "git@example:me/r.git\n" },
    });
    const res = finishBranch(r, { branch: "feat/quick-auth", startBranch: "main", hasGh: true, title: "quick: feat/quick-auth", body: "b" });
    expect(res).toEqual({ action: "pr", outcome: "pr-opened" });
    expect(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create")).toBe(true);
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
  });
  it("remote, push ok, gh absent → pr-pushed-no-gh", () => {
    const { r, calls } = fakeRunner({
      "git remote": { code: 0, stdout: "origin" },
      "git push -q -u origin feat/quick-auth": { code: 0, stdout: "" },
      "git remote get-url origin": { code: 0, stdout: "url" },
    });
    expect(finishBranch(r, { branch: "feat/quick-auth", startBranch: "main", hasGh: false }).outcome).toBe("pr-pushed-no-gh");
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
  });
  it("push fails → pr-failed-kept", () => {
    const { r } = fakeRunner({
      "git remote": { code: 0, stdout: "origin" },
      "git push -q -u origin feat/quick-auth": { code: 1, stdout: "" },
    });
    expect(finishBranch(r, { branch: "feat/quick-auth", startBranch: "main", hasGh: true }).outcome).toBe("pr-failed-kept");
  });
});
