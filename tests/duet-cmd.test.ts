// tests/duet-cmd.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { run as duetRun, initWith } from "../src/commands/duet.js";
import type { InitDeps } from "../src/commands/duet.js";
import { duetArtDir, duetExecDir } from "../src/core/duet.js";
import { freshHome } from "./helpers/tmpHome.js";

// Inline stdout capture (copied per file, like solo-cmd.test.ts).
function captureStdout() {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown) => { buf += String(chunk); return true; };
  return { text: () => buf, restore: () => { (process.stdout as unknown as { write: unknown }).write = orig; } };
}

const okDeps: InitDeps = {
  haveCmd: () => true,
  instrumentBinary: () => "codex",
  pickRandomInstrument: () => "viola",
  isGitRepo: () => true,
  headSha: () => "abc123",
};

describe("duet run() dispatch", () => {
  it("unknown verb → rc 2", async () => { expect(await duetRun(["nope"])).toBe(2); });
});

describe("duet init", () => {
  let h: { home: string; cleanup: () => void };
  let out: ReturnType<typeof captureStdout>;
  beforeEach(() => { h = freshHome(); out = captureStdout(); });
  afterEach(() => { out.restore(); h.cleanup(); });

  it("scaffolds _duet, writes state incl. target_cwd/mode, prints KV; rc 0", async () => {
    const repo = join(h.home, "repoB"); mkdirSync(repo, { recursive: true });
    const rc = await initWith(["--repo", repo, "add", "oauth"], okDeps);
    expect(rc).toBe(0);
    const art = duetArtDir("add-oauth"), exec = duetExecDir("add-oauth");
    expect(existsSync(join(exec))).toBe(true);
    expect(readFileSync(join(exec, "target_cwd.txt"), "utf8").trim()).toBe(repo);
    expect(readFileSync(join(exec, "mode.txt"), "utf8").trim()).toBe("branch");
    expect(readFileSync(join(art, "topic-text.txt"), "utf8")).toBe("add oauth");
    expect(out.text()).toMatch(/^SLUG=add-oauth$/m);
    expect(out.text()).toMatch(new RegExp(`^TARGET=${repo}$`, "m"));
    expect(out.text()).toMatch(/^MODE=branch$/m);
  });

  it("missing --repo → rc 1", async () => {
    expect(await initWith(["just", "a", "task"], okDeps)).toBe(1);
  });
  it("non-absolute --repo → rc 1", async () => {
    expect(await initWith(["--repo", "relative/path", "task"], okDeps)).toBe(1);
  });
  it("--repo with whitespace → rc 1", async () => {
    // (verbatim-tail can't deliver a spaced --repo token; reject defensively)
    expect(await initWith(["--repo", "/has space", "task"], okDeps)).toBe(1);
  });
  it("non-git --repo in branch mode → rc 1", async () => {
    const repo = join(h.home, "plain"); mkdirSync(repo, { recursive: true });
    expect(await initWith(["--repo", repo, "task"], { ...okDeps, isGitRepo: () => false })).toBe(1);
  });
  it("--in-place skips the git check and records mode=in-place", async () => {
    const repo = join(h.home, "plain2"); mkdirSync(repo, { recursive: true });
    const rc = await initWith(["--repo", repo, "--in-place", "quick fix"], { ...okDeps, isGitRepo: () => false });
    expect(rc).toBe(0);
    expect(readFileSync(join(duetExecDir("quick-fix"), "mode.txt"), "utf8").trim()).toBe("in-place");
  });
  it("already in flight → rc 2", async () => {
    const repo = join(h.home, "repoB"); mkdirSync(repo, { recursive: true });
    await initWith(["--repo", repo, "dup"], okDeps);
    expect(await initWith(["--repo", repo, "dup"], okDeps)).toBe(2);
  });
});

import { branchWith } from "../src/commands/duet.js";
import type { Runner } from "../src/core/gitwork.js";
import { writeFileSync } from "node:fs";

function fakeRunner(map: Record<string, { code?: number; stdout?: string }>): Runner {
  return { run: (cmd, args) => { const key = [cmd, ...args].join(" "); const r = map[key] ?? matchPrefix(map, key); return { code: r?.code ?? 0, stdout: r?.stdout ?? "" }; } };
}
function matchPrefix(map: Record<string, { code?: number; stdout?: string }>, key: string) {
  for (const k of Object.keys(map)) if (key.startsWith(k)) return map[k]; return undefined;
}

describe("duet branch", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => h.cleanup());

  function seedInit(slug: string, repo: string) {
    const exec = duetExecDir(slug); mkdirSync(exec, { recursive: true });
    writeFileSync(join(exec, "target_cwd.txt"), repo + "\n");
    writeFileSync(join(exec, "mode.txt"), "branch\n");
  }

  it("cuts feat/duet-<slug> and records start-branch/base; rc 0", async () => {
    seedInit("t", "/abs/repoB");
    const r = fakeRunner({
      "git rev-parse --git-dir": { code: 0 },
      "git symbolic-ref --short HEAD": { stdout: "main\n" },
      "git rev-parse HEAD": { stdout: "deadbeef\n" },
      "git status --porcelain": { stdout: "" },
      "git show-ref": { code: 1 },              // branch doesn't exist yet
      "git checkout -q -b feat/duet-t": { code: 0 },
    });
    const rc = await branchWith("t", "/abs/repoB", r);
    expect(rc).toBe(0);
    expect(readFileSync(join(duetExecDir("t"), "branch.txt"), "utf8").trim()).toBe("feat/duet-t");
    expect(readFileSync(join(duetExecDir("t"), "start-branch.txt"), "utf8").trim()).toBe("main");
  });

  it("refuses when repo B is already on another feat/duet-* branch (single-occupancy); rc 1", async () => {
    seedInit("t", "/abs/repoB");
    const r = fakeRunner({
      "git rev-parse --git-dir": { code: 0 },
      "git symbolic-ref --short HEAD": { stdout: "feat/duet-other\n" },
      "git rev-parse HEAD": { stdout: "deadbeef\n" },
      "git status --porcelain": { stdout: "" },
    });
    expect(await branchWith("t", "/abs/repoB", r)).toBe(1);
  });

  it("rc 1 when target is not a git repo", async () => {
    seedInit("t", "/abs/repoB");
    const r = fakeRunner({ "git rev-parse --git-dir": { code: 1 } });
    expect(await branchWith("t", "/abs/repoB", r)).toBe(1);
  });
});
