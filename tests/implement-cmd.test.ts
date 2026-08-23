// tests/implement-cmd.test.ts — B2b: implement pre-snapshot / branch / scope-check / summary / finish /
// forensics / archive verbs. Fake Runner injection; AP_HOME temp; byte-exact state-file asserts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { implementArtDir, implementTopicDir } from "../src/core/implement.js";
import { formatJob, jobPath } from "../src/core/job.js";
import type { Runner, RunResult } from "../src/core/gitwork.js";
import { paneMetaWrite } from "../src/core/ipc.js";
import { workerDir } from "../src/core/paths.js";
import {
  preSnapshotWith, branchWith, scopeCheckWith, summaryWith, finishWith, archiveRun, run,
  turnSendWith, turnWaitWith,
} from "../src/commands/implement.js";

const TOPIC = "add-oauth";

// ---- fakeRunner: maps "cmd arg arg..." -> {code,stdout}; unscripted argv -> {code:0,stdout:""}. ----
function fakeRunner(script: Record<string, { code?: number; stdout?: string }>): Runner {
  return {
    run(cmd: string, args: string[]): RunResult {
      const key = [cmd, ...args].join(" ");
      const hit = script[key];
      return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "" };
    },
  };
}

// capture process.stdout.write + process.stderr.write for the duration of fn().
async function capture(fn: () => Promise<number>): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

function seedArt(): string {
  const art = implementArtDir(TOPIC);
  mkdirSync(art, { recursive: true });
  return art;
}
// single-repo iterTargets row: writes target_cwd.txt → one {slug:"main", cwd} row.
function seedTargetCwd(art: string, cwd: string): void {
  writeFileSync(join(art, "target_cwd.txt"), cwd + "\n");
}

describe("implement pre-snapshot", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("art-dir missing → rc 1", async () => {
    const { rc } = await capture(() => preSnapshotWith(TOPIC, {}, () => fakeRunner({})));
    expect(rc).toBe(1);
  });

  it("single-repo clean tree → baselines/main.tsv with state=clean + baseline_sha in key order, rc 0", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    // preSnapshot git calls: rev-parse --git-dir (ok), symbolic-ref (branch), rev-parse HEAD (sha),
    // status --porcelain (empty=clean) → state clean, baseSha = preSha.
    const r = fakeRunner({
      "git rev-parse --git-dir": { code: 0, stdout: ".git\n" },
      "git symbolic-ref HEAD": { code: 0, stdout: "refs/heads/main\n" },
      "git rev-parse HEAD": { code: 0, stdout: "ABC123\n" },
      "git status --porcelain": { code: 0, stdout: "" },
    });
    const { rc, out } = await capture(() => preSnapshotWith(TOPIC, {}, () => r));
    expect(rc).toBe(0);
    void out;
    const tsv = readFileSync(join(art, "baselines", "main.tsv"), "utf8");
    // exact key order, and the snapshot_ts line is dynamic — strip it for the byte-exact head.
    const head = tsv.split("\n").filter((l) => !l.startsWith("snapshot_ts=")).join("\n");
    expect(head).toBe("slug=main\ncwd=/repo/main\nbranch=main\nbaseline_sha=ABC123\nstate=clean\n");
    expect(tsv).toMatch(/^snapshot_ts=.+$/m);
  });

  it("not-git → rc 2", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    const r = fakeRunner({ "git rev-parse --git-dir": { code: 128, stdout: "" } });
    const { rc } = await capture(() => preSnapshotWith(TOPIC, {}, () => r));
    expect(rc).toBe(2);
  });
});

describe("implement branch", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("art-dir missing → rc 1", async () => {
    const { rc } = await capture(() => branchWith({ topic: TOPIC, noBranch: false }, {}, () => fakeRunner({})));
    expect(rc).toBe(1);
  });

  it("ref absent → creates feat/implement-<topic>, records it; branch-base.sha from baseline", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"), "slug=main\nbaseline_sha=ABC\n");
    const r = fakeRunner({
      "git show-ref --verify --quiet refs/heads/feat/implement-add-oauth": { code: 1, stdout: "" },
      "git checkout -q -b feat/implement-add-oauth": { code: 0, stdout: "" },
    });
    const { rc } = await capture(() => branchWith({ topic: TOPIC, noBranch: false }, {}, () => r));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "implement-branches.tsv"), "utf8")).toBe("main\tfeat/implement-add-oauth\n");
    expect(readFileSync(join(art, "branch-base.sha"), "utf8")).toBe("ABC\n");
    expect(readFileSync(join(art, "branch-mode.txt"), "utf8")).toBe("branch\n");
  });

  it("baseline branch IS the feat branch → rc 1, nothing written (the hub pre-checkout accident)", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"), "slug=main\nbranch=feat/implement-add-oauth\nbaseline_sha=ABC\n");
    let sawCheckout = false;
    const r: Runner = { run(cmd, args) { if (args[0] === "checkout") sawCheckout = true; return { code: 0, stdout: "" }; } };
    const { rc, err } = await capture(() => branchWith({ topic: TOPIC, noBranch: false }, {}, () => r));
    expect(rc).toBe(1);
    expect(err).toContain("HEAD was already feat/implement-add-oauth at pre-snapshot");
    expect(sawCheckout).toBe(false);
    for (const f of ["implement-branches.tsv", "branch-mode.txt", "branch-base.sha"]) expect(existsSync(join(art, f))).toBe(false);
  });

  it("detached-HEAD baseline → rc 1, nothing written (no start branch to restore)", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"), "slug=main\nbranch=(detached)\nbaseline_sha=ABC\n");
    const { rc, err } = await capture(() => branchWith({ topic: TOPIC, noBranch: false }, {}, () => fakeRunner({})));
    expect(rc).toBe(1);
    expect(err).toContain("detached HEAD");
    for (const f of ["implement-branches.tsv", "branch-mode.txt"]) expect(existsSync(join(art, f))).toBe(false);
  });

  it("--no-branch is never refused by the baseline check (staying put is the point)", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"), "slug=main\nbranch=feat/implement-add-oauth\n");
    const r = fakeRunner({ "git symbolic-ref HEAD": { code: 0, stdout: "refs/heads/feat/implement-add-oauth\n" } });
    const { rc } = await capture(() => branchWith({ topic: TOPIC, noBranch: true }, {}, () => r));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "branch-mode.txt"), "utf8")).toBe("no-branch\n");
  });

  it("--no-branch → records the current branch (symbolic-ref), no checkout -b", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    let sawCheckoutB = false;
    const r: Runner = {
      run(cmd, args) {
        const key = [cmd, ...args].join(" ");
        if (key === "git checkout -q -b feat/implement-add-oauth") sawCheckoutB = true;
        if (key === "git symbolic-ref HEAD") return { code: 0, stdout: "refs/heads/develop\n" };
        return { code: 0, stdout: "" };
      },
    };
    const { rc } = await capture(() => branchWith({ topic: TOPIC, noBranch: true }, {}, () => r));
    expect(rc).toBe(0);
    expect(sawCheckoutB).toBe(false);
    expect(readFileSync(join(art, "implement-branches.tsv"), "utf8")).toBe("main\tdevelop\n");
    expect(readFileSync(join(art, "branch-mode.txt"), "utf8")).toBe("no-branch\n");
  });

  it("squash-merged leftover branch → rc 1 from the RESUME arm, no checkout, nothing written", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"), "slug=main\nbranch=main\nbaseline_sha=ABC\n");
    const calls: string[][] = [];
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const key = [cmd, ...args].join(" ");
      // The ref exists (so the resume arm is taken) but HEAD is not an ancestor of it.
      if (key === "git merge-base --is-ancestor HEAD refs/heads/feat/implement-add-oauth") return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    } };
    const { rc, err } = await capture(() => branchWith({ topic: TOPIC, noBranch: false }, {}, () => r));
    expect(rc).toBe(1);
    expect(err).toContain("feat/implement-add-oauth");
    expect(err).toContain("diverged from the current HEAD");
    expect(err).toContain("git -C /repo/main branch -D feat/implement-add-oauth");
    expect(calls.some((c) => c[1] === "checkout")).toBe(false);
    expect(calls.some((c) => c[1] === "branch" || c[1] === "update-ref")).toBe(false);
    for (const f of ["implement-branches.tsv", "branch-mode.txt", "branch-base.sha"]) expect(existsSync(join(art, f))).toBe(false);
  });

  it("--branch=custom (ref absent) → records custom", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    const r = fakeRunner({
      "git show-ref --verify --quiet refs/heads/custom": { code: 1, stdout: "" },
      "git checkout -q -b custom": { code: 0, stdout: "" },
    });
    const { rc } = await capture(() => branchWith({ topic: TOPIC, noBranch: false, branchName: "custom" }, {}, () => r));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "implement-branches.tsv"), "utf8")).toBe("main\tcustom\n");
  });
});

describe("implement scope-check", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function seedScope(art: string): void {
    writeFileSync(join(art, "target_cwd.txt"), "/repo/main\n");
    writeFileSync(join(art, "branch-base.sha"), "BASE\n");
    writeFileSync(join(art, "design.md"),
      "# d\n\n## Components\n\n| File | Note |\n| --- | --- |\n| `src/a.ts` | x |\n");
  }

  it("missing inputs → rc 1", async () => {
    seedArt(); // no target_cwd.txt / branch-base.sha
    const { rc } = await capture(() => scopeCheckWith2(TOPIC, () => fakeRunner({})));
    expect(rc).toBe(1);
  });

  it("one out-of-scope path → scope-out-of-scope.txt + OOS_COUNT=1, rc 0", async () => {
    const art = seedArt();
    seedScope(art);
    const r = fakeRunner({
      "git diff --name-only BASE..HEAD": { code: 0, stdout: "src/a.ts\nelsewhere/rogue.ts\n" },
    });
    const { rc, out } = await capture(() => scopeCheckWith2(TOPIC, () => r));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "scope-out-of-scope.txt"), "utf8")).toBe("elsewhere/rogue.ts\n");
    expect(out).toContain("OOS_COUNT=1\n");
    expect(out).toContain(`OOS_PATH=${join(art, "scope-out-of-scope.txt")}\n`);
  });

  it("all in scope → OOS_COUNT=0, empty oos file, rc 0", async () => {
    const art = seedArt();
    seedScope(art);
    const r = fakeRunner({ "git diff --name-only BASE..HEAD": { code: 0, stdout: "src/a.ts\n" } });
    const { rc, out } = await capture(() => scopeCheckWith2(TOPIC, () => r));
    expect(rc).toBe(0);
    expect(out).toContain("OOS_COUNT=0\n");
    expect(readFileSync(join(art, "scope-out-of-scope.txt"), "utf8")).toBe("");
  });
});

describe("implement finish", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function seedFinish(art: string): void {
    seedTargetCwd(art, "/repo/main");
    writeFileSync(join(art, "implement-branches.tsv"), "main\tfeat/implement-foo\n");
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"), "slug=main\ncwd=/repo/main\nbranch=main\n");
  }

  it("art-dir missing → rc 1", async () => {
    const { rc } = await capture(() => finishWith2(TOPIC, "merge", () => fakeRunner({}), false));
    expect(rc).toBe(1);
  });

  it("bad action → rc 2 (rejected by finishRun before reaching finishWith)", async () => {
    const { rc } = await capture(() => run(["finish", TOPIC, "bogus"]));
    expect(rc).toBe(2);
  });

  it("merge action: show-ref ok + merge ok → finish-results.tsv === main\\tmerge\\tmerged, rc 0", async () => {
    const art = seedArt();
    seedFinish(art);
    const r = fakeRunner({
      "git show-ref --verify --quiet refs/heads/feat/implement-foo": { code: 0, stdout: "" },
      "git checkout -q main": { code: 0, stdout: "" },
      "git merge --no-edit -q feat/implement-foo": { code: 0, stdout: "" },
      "git branch -q -D feat/implement-foo": { code: 0, stdout: "" },
    });
    const { rc } = await capture(() => finishWith2(TOPIC, "merge", () => r, false));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tmerge\tmerged\n");
  });

  // The recorded mode is what tells a deliberate --no-branch run from the pre-checkout accident:
  // on disk both leave the work sitting on the baseline branch.
  function seedSameBranch(art: string): void {
    seedTargetCwd(art, "/repo/main");
    writeFileSync(join(art, "implement-branches.tsv"), "main\tmain\n");
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"), "slug=main\ncwd=/repo/main\nbranch=main\n");
  }

  it("mode no-branch recorded → outcome no-branch, no action attempted", async () => {
    const art = seedArt();
    seedSameBranch(art);
    writeFileSync(join(art, "branch-mode.txt"), "no-branch\n");
    let sawMerge = false;
    const r: Runner = { run(cmd, args) { if (args[0] === "merge") sawMerge = true; return { code: 0, stdout: "" }; } };
    const { rc, err } = await capture(() => finishWith2(TOPIC, "merge", () => r, false));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tmerge\tno-branch\n");
    expect(sawMerge).toBe(false);
    expect(err).not.toContain("NOTHING was merged");
  });

  it("mode no-branch never touches a branch it did not create (a drifted feat/ ref survives)", async () => {
    const art = seedArt();
    seedFinish(art); // recorded branch feat/implement-foo, baseline main — but the run was --no-branch
    writeFileSync(join(art, "branch-mode.txt"), "no-branch\n");
    const seen: string[] = [];
    const r: Runner = { run(cmd, args) { seen.push([cmd, ...args].join(" ")); return { code: 0, stdout: "" }; } };
    const { rc } = await capture(() => finishWith2(TOPIC, "merge", () => r, false));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tmerge\tno-branch\n");
    expect(seen).toEqual([]); // not even a show-ref: the recorded intent settles it
  });

  it("mode branch + branch === baseline → outcome same-branch, a loud warn, and a forensics flag", async () => {
    const art = seedArt();
    seedSameBranch(art);
    writeFileSync(join(art, "branch-mode.txt"), "branch\n");
    const { rc, out, err } = await capture(() => finishWith2(TOPIC, "pr", () => fakeRunner({}), true));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tpr\tsame-branch\n");
    expect(err).toContain("NOTHING was merged, pushed, or discarded");
    expect(err).toContain("recover:");
    expect(out).toMatch(/forensics\/.*-implement-flag-add-oauth\.md/); // reaches /ap:review
  });

  it("detached baseline → same-branch, never a merge into whatever HEAD was", async () => {
    const art = seedArt();
    seedTargetCwd(art, "/repo/main");
    writeFileSync(join(art, "implement-branches.tsv"), "main\tfeat/implement-foo\n");
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"), "slug=main\ncwd=/repo/main\nbranch=(detached)\n");
    writeFileSync(join(art, "branch-mode.txt"), "branch\n");
    let sawMerge = false;
    const r: Runner = { run(cmd, args) { if (args[0] === "merge") sawMerge = true; return { code: 0, stdout: "" }; } };
    const { rc, err } = await capture(() => finishWith2(TOPIC, "merge", () => r, false));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tmerge\tsame-branch\n");
    expect(sawMerge).toBe(false);
    expect(err).toContain("detached HEAD");
  });

  it("no branch-mode.txt (pre-0.5.14 art dir) + same branch → same-branch, not a silent no-branch", async () => {
    const art = seedArt();
    seedSameBranch(art);
    const { rc } = await capture(() => finishWith2(TOPIC, "merge", () => fakeRunner({}), false));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tmerge\tsame-branch\n");
  });

  // Same silence as same-branch, different cause and recovery — so it is counted and worded apart.
  it("the baseline checkout is refused → base-checkout-failed, its own flag, nothing merged", async () => {
    const art = seedArt();
    seedFinish(art); // branch feat/implement-foo, baseline main
    writeFileSync(join(art, "branch-mode.txt"), "branch\n");
    const r = fakeRunner({
      "git show-ref --verify --quiet refs/heads/feat/implement-foo": { code: 0, stdout: "" },
      "git checkout -q main": { code: 1, stdout: "" },
    });
    const { rc, out } = await capture(() => finishWith2(TOPIC, "merge", () => r, false));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tmerge\tbase-checkout-failed\n");
    expect(readFileSync(out.trim(), "utf8")).toContain(
      "finish merge: base-checkout-failed on 1 target(s) — the checkout of the baseline branch was refused (check the checkout's own error: e.g. a dirty tree, the baseline held by another worktree, or its ref gone), so NOTHING was merged or discarded; the work is still on the feature branch",
    );
  });

  it("mode branch + a recorded branch whose ref is gone → same-branch", async () => {
    const art = seedArt();
    seedFinish(art); // branch feat/implement-foo, baseline main
    writeFileSync(join(art, "branch-mode.txt"), "branch\n");
    const r = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/implement-foo": { code: 1, stdout: "" } });
    const { rc } = await capture(() => finishWith2(TOPIC, "keep", () => r, false));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tkeep\tsame-branch\n");
  });
});

// The detached run's "never merge, never push, never open a PR" was directive prose only. This is
// its mechanical half: the finish verb itself refuses, whatever a mis-instructed job hub was told.
describe("implement finish — a detached job in flight allows only 'keep'", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function seedJobRecord(finish = "keep"): void {
    const p = jobPath(TOPIC);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, formatJob({
      command: "implement", topic: TOPIC, session: `ap-${TOPIC}`,
      hub: { agent: "alpha", model: "claude" },
      provider: "codex", finish, budget_hours: 6, max_rounds: 5,
      args_file: "/tmp/args", started: "2026-08-18T00:00:00Z",
    }));
  }
  function seedFinish(art: string): void {
    seedTargetCwd(art, "/repo/main");
    writeFileSync(join(art, "implement-branches.tsv"), "main\tfeat/implement-foo\n");
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"), "slug=main\ncwd=/repo/main\nbranch=main\n");
  }
  function hubFlags(): string {
    const root = join(h.home, "forensics");
    if (!existsSync(root)) return "";
    return readdirSync(root).flatMap((d) => readdirSync(join(root, d)).map((f) => readFileSync(join(root, d, f), "utf8"))).join("");
  }

  for (const action of ["merge", "pr", "discard"] as const) {
    it(`${action} → rc 2, nothing published, and the refusal reaches the review feed`, async () => {
      const art = seedArt();
      seedFinish(art);
      seedJobRecord();
      const r = fakeRunner({});
      const { rc, err } = await capture(() => finishWith2(TOPIC, action, () => r, true));
      expect(rc).toBe(2);
      expect(err).toContain("detached job in flight");
      // The gate sits BEFORE the results file is truncated, so the previous run's record survives.
      expect(existsSync(join(art, "finish-results.tsv"))).toBe(false);
      expect(hubFlags()).toContain(`finish ${action}: REFUSED`);
    });
  }

  it("keep passes the gate and finishes normally", async () => {
    const art = seedArt();
    seedFinish(art);
    seedJobRecord();
    const r = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/implement-foo": { code: 1, stdout: "" } });
    const { rc } = await capture(() => finishWith2(TOPIC, "keep", () => r, true));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tkeep\tsame-branch\n");
  });

  // `--finish` was removed 2026-08-18, taking the recorded-action indirection with it: the gate is a
  // literal `keep` again, so what a record NAMES — an older ap's 'pr', or a hand-edited 'merge' —
  // unlocks nothing.
  it("a record naming any other finish action still allows only keep", async () => {
    const art = seedArt();
    seedFinish(art);
    seedJobRecord("pr");
    const r = fakeRunner({});
    for (const action of ["pr", "merge", "discard"] as const) {
      const { rc, err } = await capture(() => finishWith2(TOPIC, action, () => r, true));
      expect(rc).toBe(2);
      expect(err).toContain("only 'keep' is allowed");
    }
    expect(existsSync(join(art, "finish-results.tsv"))).toBe(false);
  });

  it("with no job record, merge is untouched by the gate", async () => {
    const art = seedArt();
    seedFinish(art);
    const r = fakeRunner({
      "git show-ref --verify --quiet refs/heads/feat/implement-foo": { code: 0, stdout: "" },
      "git checkout -q main": { code: 0, stdout: "" },
      "git merge --no-edit -q feat/implement-foo": { code: 0, stdout: "" },
    });
    const { rc } = await capture(() => finishWith2(TOPIC, "merge", () => r, false));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "finish-results.tsv"), "utf8")).toBe("main\tmerge\tmerged\n");
  });
});

describe("implement archive (real archiveTopic under AP_HOME)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("moves _implement under the archive root, rc 0", async () => {
    const art = seedArt(); // <topicDir>/_implement
    // seed a sibling worker dir with a status.json so finalizeArchived has something to touch.
    const workerDir = join(implementTopicDir(TOPIC), "lead-codex");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "status.json"), '{"state":"done"}');
    writeFileSync(join(art, "topic.txt"), TOPIC);
    const { rc } = await capture(() => archiveRun([TOPIC]));
    expect(rc).toBe(0);
    expect(existsSync(art)).toBe(false); // _implement moved away
  });

  it("missing topic → rc 2", async () => {
    const { rc } = await capture(() => archiveRun([]));
    expect(rc).toBe(2);
  });
});

describe("implement summary", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("clean tree → block printed, posts/main.tsv state=no-leftovers, rc 0", async () => {
    const art = seedArt();
    // real-ish cwd dir (must be a directory for isDir guard).
    const cwd = join(h.home, "repo-main");
    mkdirSync(cwd, { recursive: true });
    seedTargetCwd(art, cwd);
    mkdirSync(join(art, "baselines"), { recursive: true });
    writeFileSync(join(art, "baselines", "main.tsv"),
      `slug=main\ncwd=${cwd}\nbranch=main\nbaseline_sha=ABC\nstate=clean\nsnapshot_ts=2026-05-30T00:00:00Z\n`);
    const r = fakeRunner({
      "git symbolic-ref HEAD": { code: 0, stdout: "refs/heads/main\n" },
      "git status --porcelain": { code: 0, stdout: "" },          // empty → no-leftovers
      "git rev-parse HEAD": { code: 0, stdout: "DEF\n" },
      "git diff --shortstat ABC..HEAD": { code: 0, stdout: "" },
      "git log --reverse --oneline ABC..HEAD": { code: 0, stdout: "" },
    });
    const { rc, out } = await capture(() => summaryWith2(TOPIC, () => r, () => "2026-05-30T01:00:00Z"));
    expect(rc).toBe(0);
    expect(out).toContain(`=== main [${cwd}] ===`);
    const post = readFileSync(join(art, "posts", "main.tsv"), "utf8");
    expect(post).toContain("state=no-leftovers\n");
    expect(post).toContain("branch=main\n");
    expect(post).toContain("post_sha=DEF\n");
  });
});

// ---- thin wrappers that adapt the {runnerFor,...} Deps shape to the test's runnerFor callback. ----
async function scopeCheckWith2(topic: string, runnerFor: (cwd: string) => Runner): Promise<number> {
  return scopeCheckWith(topic, { runnerFor });
}
async function summaryWith2(topic: string, runnerFor: (cwd: string) => Runner, now: () => string): Promise<number> {
  return summaryWith(topic, { runnerFor, now });
}
async function finishWith2(topic: string, action: "merge" | "pr" | "keep" | "discard", runnerFor: (cwd: string) => Runner, hasGh: boolean): Promise<number> {
  return finishWith(topic, action, { runnerFor, hasGh });
}

// The first detached dogfood repaired provider.txt by hand: init writes ONE detection into
// provider.txt (routing) + auto_provider.txt (evidence), and every later override — the attached
// claude-confirm gate, a detached job.json — changed only the SPAWN, so the turn verbs kept routing
// at a lead-<wrong-model> dir that was never created.
describe("implement set-provider — the one mechanical way an override reaches provider.txt", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("rewrites provider.txt and leaves auto_provider.txt (the detection record) untouched", async () => {
    const art = seedArt();
    writeFileSync(join(art, "provider.txt"), "claude\n");
    writeFileSync(join(art, "auto_provider.txt"), "claude\n");
    const { rc } = await capture(() => run(["set-provider", TOPIC, "codex"]));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "provider.txt"), "utf8")).toBe("codex\n");
    expect(readFileSync(join(art, "auto_provider.txt"), "utf8")).toBe("claude\n");
  });

  it("a provider with no contracts.yaml entry is rc 2, and provider.txt is left alone", async () => {
    const art = seedArt();
    writeFileSync(join(art, "provider.txt"), "codex\n");
    const { rc, err } = await capture(() => run(["set-provider", TOPIC, "gpt-9"]));
    expect(rc).toBe(2);
    expect(err).toContain("unknown provider 'gpt-9'");
    expect(readFileSync(join(art, "provider.txt"), "utf8")).toBe("codex\n");
  });

  it("no art dir → rc 1 naming init", async () => {
    const { rc, err } = await capture(() => run(["set-provider", TOPIC, "codex"]));
    expect(rc).toBe(1);
    expect(err).toContain("run implement init first");
  });

  it("wrong arity is usage (rc 2)", async () => {
    expect((await capture(() => run(["set-provider", TOPIC]))).rc).toBe(2);
  });
});

// The other half of the same dogfood gap: dispatching to a phantom lead-<model> cost a manual
// repair, so both turn verbs now fail closed BEFORE any send or state write, naming the remedy.
describe("implement turn-send / turn-wait — provider.txt must match the spawned lead worker", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function seedSpawnedLead(model: string): void {
    mkdirSync(workerDir("lead", model, TOPIC), { recursive: true });
    paneMetaWrite("lead", model, TOPIC, "%7", "0dd00000-0000-4000-8000-000000000007");
  }
  const sendDeps = () => {
    const sent: string[][] = [];
    return { sent, d: { offsetFor: () => 0, send: async (a: string[]) => { sent.push(a); return 0; } } };
  };

  it("turn-send: mismatch → rc 1, the set-provider remedy on stderr, nothing sent, no state file", async () => {
    const art = seedArt();
    writeFileSync(join(art, "provider.txt"), "claude\n");
    seedSpawnedLead("codex");
    const { sent, d } = sendDeps();
    const { rc, err } = await capture(() => turnSendWith(TOPIC, 1, d));
    expect(rc).toBe(1);
    expect(err).toContain("provider.txt says 'claude' but the spawned lead worker is 'codex'");
    expect(err).toContain(`implement set-provider ${TOPIC} codex`);
    expect(sent).toEqual([]);
    expect(existsSync(join(art, "turn-lead-1.txt"))).toBe(false);
  });

  it("turn-wait: mismatch → rc 1 with the same remedy, before the wait is armed", async () => {
    const art = seedArt();
    writeFileSync(join(art, "provider.txt"), "claude\n");
    seedSpawnedLead("codex");
    const { rc, err } = await capture(() => turnWaitWith(TOPIC, 1, {
      multiplier: () => "1", now: () => 0,
      wait: async () => { throw new Error("the wait must never be armed on a mismatch"); },
    }));
    expect(rc).toBe(1);
    expect(err).toContain(`implement set-provider ${TOPIC} codex`);
  });

  it("a matching provider passes the gate — both verbs fail later, for unrelated reasons", async () => {
    const art = seedArt();
    writeFileSync(join(art, "provider.txt"), "codex\n");
    seedSpawnedLead("codex");
    const send = await capture(() => turnSendWith(TOPIC, 1, sendDeps().d));
    expect(send.err).not.toContain("provider.txt says");
    expect(send.err).toContain("outbox not found");          // the send gate, i.e. past the check
    const wait = await capture(() => turnWaitWith(TOPIC, 1, { multiplier: () => "1", now: () => 0 }));
    expect(wait.err).not.toContain("provider.txt says");
    expect(wait.err).toContain("run implement turn-send first");
    expect(existsSync(join(art, "turn-lead-1.txt"))).toBe(false);
  });

  it("no worker dir yet (nothing spawned) passes the gate", async () => {
    const art = seedArt();
    writeFileSync(join(art, "provider.txt"), "claude\n");
    const { err } = await capture(() => turnSendWith(TOPIC, 1, sendDeps().d));
    expect(err).not.toContain("provider.txt says");
  });
});
