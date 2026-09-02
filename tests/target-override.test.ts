// tests/target-override.test.ts — `--target <abs>`: the flag that re-homes a run's WORKER without
// moving any of its state. A detached run points it at the worktree `job start` forked, so the
// worker's branch checkout never lands in the checkout the operator is still using; the flag is
// first-class rather than detached-only, which also closes the standing ask for a target override.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { parseImplementArgs, implementArtDir } from "../src/core/implement.js";
import { parseQuickArgs, parseBranchArgs, quickExecDir } from "../src/core/quick.js";
import { initWith as implementInit } from "../src/commands/implement.js";
import { initWith as quickInit, run as quickRun } from "../src/commands/quick.js";

const PASSING_DOC =
  "# Add OAuth Login\n\n## Goal\nShip OAuth.\n\n## Architecture\nA token exchange.\n\n" +
  "## Testing\nUnit + integration.\n\n## Success Criteria\nLogin works.\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** A throwaway git repo with one commit, plus a fresh AP_HOME. Not made the cwd: these verbs take
 *  the target as an argument, which is the whole point. */
function repo(): string {
  const h = freshHome();
  cleanups.push(h.cleanup);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-target-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "ap tests");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

async function capture(fn: () => Promise<number>): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

describe("parsing — the flag's VALUE is consumed, never left to be mistaken for content", () => {
  it("implement: --target and --target= both parse, and the doc positional survives", () => {
    expect(parseImplementArgs(["--target", "/wt", "doc.md"]).target).toBe("/wt");
    expect(parseImplementArgs(["--target=/wt", "doc.md"]).target).toBe("/wt");
    expect(parseImplementArgs(["--target", "/wt", "doc.md"]).rest).toBe("doc.md");
    expect(parseImplementArgs(["doc.md"]).target).toBeUndefined();
    // the unknown-flag guard that used to reject --target still rejects everything else
    expect(() => parseImplementArgs(["--nope", "doc.md"])).toThrow(/unknown flag/);
  });
  // A path does not start with `--`, so an unconsumed value would land in the topic text and change
  // the derived slug — the run would then be filed under a different topic than the job record.
  it("quick init: the target never leaks into the topic text", () => {
    const a = parseQuickArgs(["--target", "/wt", "fix", "the", "thing"]);
    expect(a.target).toBe("/wt");
    expect(a.topicText).toBe("fix the thing");
    expect(parseQuickArgs(["--target=/wt", "fix"]).target).toBe("/wt");
    expect(parseQuickArgs(["fix"]).target).toBeUndefined();
  });
  it("quick branch: the topic is still found on either side of the flags", () => {
    expect(parseBranchArgs(["--target", "/wt", "auth"])).toEqual({ topic: "auth", target: "/wt", stashWip: false });
    expect(parseBranchArgs(["auth", "--target", "/wt", "--stash-wip"])).toEqual({ topic: "auth", target: "/wt", stashWip: true });
    expect(parseBranchArgs(["auth"])).toEqual({ topic: "auth", target: undefined, stashWip: false });
    expect(parseBranchArgs(["--stash-wip"]).topic).toBe("");
  });
});

describe("implement init --target", () => {
  it("records the override as target_cwd.txt — everything downstream flows from that one file", async () => {
    const root = repo();
    const wt = join(root, "wt");
    git(root, "worktree", "add", "-q", "--detach", wt, "HEAD");
    const doc = join(root, "2026-08-18-add-oauth-design.md");
    writeFileSync(doc, PASSING_DOC);

    const { rc } = await capture(() => implementInit(["--target", wt, doc], { repoRoot: () => root }));
    expect(rc).toBe(0);
    expect(readFileSync(join(implementArtDir("add-oauth"), "target_cwd.txt"), "utf8")).toBe(wt + "\n");
  });

  it("with no --target, the repo root is still the target (attached runs are untouched)", async () => {
    const root = repo();
    const doc = join(root, "2026-08-18-add-oauth-design.md");
    writeFileSync(doc, PASSING_DOC);
    const { rc } = await capture(() => implementInit([doc], { repoRoot: () => root }));
    expect(rc).toBe(0);
    expect(readFileSync(join(implementArtDir("add-oauth"), "target_cwd.txt"), "utf8")).toBe(root + "\n");
  });

  // Every rejection happens BEFORE the art dir is created: a run whose target is unusable must not
  // leave a half-scaffolded topic behind that the next attempt then reports as already in flight.
  it.each([
    ["a relative path", () => "wt", "absolute"],
    ["a path that does not exist", (root: string) => join(root, "nope"), "does not exist"],
    ["a directory outside any git work tree", () => realpathSync(tmpdir()), "not inside a git work tree"],
  ])("refuses %s (rc 1), scaffolding nothing", async (_name, mk: (root: string) => string, wording) => {
    const root = repo();
    const doc = join(root, "2026-08-18-add-oauth-design.md");
    writeFileSync(doc, PASSING_DOC);
    const { rc, err } = await capture(() => implementInit(["--target", mk(root), doc], { repoRoot: () => root }));
    expect(rc).toBe(1);
    expect(err).toContain(wording);
    expect(existsSync(implementArtDir("add-oauth"))).toBe(false);
  });
});

describe("quick --target", () => {
  const deps = { haveCmd: () => true, agentBinary: () => "codex", pickRandomAgent: () => "alpha", livePanes: async () => new Map<string, string>(), branchSha: () => "" };

  it("init ECHOES the override as TARGET= — the directive passes it straight on to branch", async () => {
    const root = repo();
    const wt = join(root, "wt");
    git(root, "worktree", "add", "-q", "--detach", wt, "HEAD");
    const { rc, out } = await capture(() => quickInit(["--target", wt, "fix", "the", "thing"], deps));
    expect(rc).toBe(0);
    expect(out).toContain(`TARGET=${wt}`);
    expect(out).toContain("SLUG=fix-the-thing");   // the target did not pollute the slug
  });

  it("init refuses an unusable target before any state is written", async () => {
    const root = repo();
    const { rc, err } = await capture(() => quickInit(["--target", join(root, "nope"), "fix"], deps));
    expect(rc).toBe(1);
    expect(err).toContain("does not exist");
    expect(existsSync(quickExecDir("fix"))).toBe(false);
  });

  it("branch runs in the target and records it — the branch is created THERE, not in the root", async () => {
    const root = repo();
    const wt = join(root, "wt");
    git(root, "worktree", "add", "-q", "--detach", wt, "HEAD");
    mkdirSync(quickExecDir("auth"), { recursive: true });

    const { rc } = await capture(() => quickRun(["branch", "--target", wt, "auth"]));
    expect(rc).toBe(0);
    expect(readFileSync(join(quickExecDir("auth"), "target_cwd.txt"), "utf8")).toBe(wt + "\n");
    expect(git(wt, "symbolic-ref", "--short", "HEAD")).toBe("feat/quick-auth");
    // the main checkout never moved — the property the whole feature exists for
    expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("branch refuses an unusable target rather than falling back to the repo root", async () => {
    const root = repo();
    const { rc, err } = await capture(() => quickRun(["branch", "--target", join(root, "nope"), "auth"]));
    expect(rc).toBe(1);
    expect(err).toContain("does not exist");
    expect(existsSync(join(quickExecDir("auth"), "target_cwd.txt"))).toBe(false);
  });
});
