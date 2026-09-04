// tests/implement-integrate.test.ts — the fan-in (2026-09-04-parallel-slices-design.md, G): every
// arm over a fake `Runner`, so the whole merge loop is exercised with no repository.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { implementArtDir } from "../src/core/implement.js";
import { writeSlices, type SliceRow } from "../src/core/implementSlices.js";
import { integrateSlices, readIntegrate } from "../src/core/implementIntegrate.js";
import type { Runner } from "../src/core/gitwork.js";
import { integrateWith } from "../src/commands/implement.js";

const TOPIC = "add-oauth";
const ROWS: SliceRow[] = [
  { agent: "bravo", model: "codex", label: "wp2", status: "spawned", tasks: ["T2"], files: ["b.ts"] },
  { agent: "delta", model: "codex", label: "wp3", status: "spawned", tasks: ["T3"], files: ["d.ts"] },
];

/** A scripted git: `answers` keys are the joined argv, values the result. Unlisted calls succeed
 *  with empty stdout, which is what `merge` / `merge --abort` do when they work. */
function fakeRunner(answers: Record<string, { code?: number; stdout?: string }>, calls: string[][] = []): Runner {
  return {
    run(cmd, args) {
      calls.push([cmd, ...args]);
      const a = answers[args.join(" ")];
      return { code: a?.code ?? 0, stdout: a?.stdout ?? "" };
    },
  };
}
const onBranch = { "symbolic-ref HEAD": { stdout: "refs/heads/feat/implement-add-oauth\n" } };
const clean = { "status --porcelain -z --untracked-files=no": { stdout: "" } };
const hasCommits = {
  "rev-list --count HEAD..feat/implement-add-oauth-bravo": { stdout: "2\n" },
  "rev-list --count HEAD..feat/implement-add-oauth-delta": { stdout: "3\n" },
};

describe("integrateSlices — preconditions", () => {
  it("refuses a tree parked on another branch, naming both branches, without touching git further", () => {
    const calls: string[][] = [];
    const r = fakeRunner({ "symbolic-ref HEAD": { stdout: "refs/heads/base/add-oauth\n" } }, calls);
    const out = integrateSlices(TOPIC, ROWS, r);
    expect(out).toEqual({ ok: false, refusals: ["BRANCH=base/add-oauth", "EXPECTED=feat/implement-add-oauth"] });
    expect(calls.map((c) => c[1])).toEqual(["symbolic-ref"]);
  });

  it("refuses modified TRACKED files, one DIRTY= line each", () => {
    const r = fakeRunner({ ...onBranch, "status --porcelain -z --untracked-files=no": { stdout: " M src/a.ts\0M  src/b.ts\0" } });
    expect(integrateSlices(TOPIC, ROWS, r)).toEqual({ ok: false, refusals: ["DIRTY=src/a.ts", "DIRTY=src/b.ts"] });
  });
});

describe("integrateSlices — the per-row arms", () => {
  it("merges each branch that has commits, with --no-ff and a slice-named message", () => {
    const calls: string[][] = [];
    const r = fakeRunner({ ...onBranch, ...clean, ...hasCommits }, calls);
    const out = integrateSlices(TOPIC, ROWS, r);
    expect(out).toEqual({ ok: true, rc: 0, rows: [
      { agent: "bravo", label: "wp2", status: "merged" },
      { agent: "delta", label: "wp3", status: "merged" },
    ] });
    expect(calls.filter((c) => c[1] === "merge")).toEqual([
      ["git", "merge", "--no-ff", "--no-edit", "-m", "merge: slice wp2 (bravo)", "feat/implement-add-oauth-bravo"],
      ["git", "merge", "--no-ff", "--no-edit", "-m", "merge: slice wp3 (delta)", "feat/implement-add-oauth-delta"],
    ]);
  });

  it("a branch that never existed is skipped:no-branch, not merged", () => {
    const calls: string[][] = [];
    const r = fakeRunner({
      ...onBranch, ...clean, ...hasCommits,
      "show-ref --verify --quiet refs/heads/feat/implement-add-oauth-bravo": { code: 1 },
    }, calls);
    const out = integrateSlices(TOPIC, ROWS, r);
    expect(out).toMatchObject({ ok: true, rc: 0 });
    expect(out).toHaveProperty("rows.0.status", "skipped:no-branch");
    expect(calls.filter((c) => c[1] === "merge").length).toBe(1);
  });

  it("a branch with zero commits ahead is `empty` and never merged (`Already up to date` is rc 0)", () => {
    const calls: string[][] = [];
    const r = fakeRunner({ ...onBranch, ...clean, ...hasCommits, "rev-list --count HEAD..feat/implement-add-oauth-bravo": { stdout: "0\n" } }, calls);
    const out = integrateSlices(TOPIC, ROWS, r);
    expect(out).toHaveProperty("rows.0.status", "empty");
    expect(calls.filter((c) => c[1] === "merge").map((c) => c.at(-1))).toEqual(["feat/implement-add-oauth-delta"]);
  });

  it("a conflict aborts, records, and the loop CONTINUES when the abort restored the tree", () => {
    const calls: string[][] = [];
    const r = fakeRunner({
      ...onBranch, ...clean, ...hasCommits,
      "merge --no-ff --no-edit -m merge: slice wp2 (bravo) feat/implement-add-oauth-bravo": { code: 1 },
    }, calls);
    const out = integrateSlices(TOPIC, ROWS, r);
    expect(out).toEqual({ ok: true, rc: 0, rows: [
      { agent: "bravo", label: "wp2", status: "conflict" },
      { agent: "delta", label: "wp3", status: "merged" },
    ] });
    expect(calls.some((c) => c.join(" ") === "git merge --abort")).toBe(true);
  });

  it("an abort that could NOT restore the tree stops the loop: the rest is skipped:tree-dirty, rc 1", () => {
    let probes = 0;
    const r: Runner = {
      run(cmd, args) {
        const k = args.join(" ");
        if (k === "symbolic-ref HEAD") return { code: 0, stdout: "refs/heads/feat/implement-add-oauth\n" };
        // clean at the precondition, dirty at the post-abort re-probe
        if (k === "status --porcelain -z --untracked-files=no") return { code: 0, stdout: probes++ === 0 ? "" : "UU src/a.ts\0" };
        if (k.startsWith("rev-list")) return { code: 0, stdout: "2\n" };
        if (k.startsWith("merge --no-ff")) return { code: 1, stdout: "" };
        return { code: 0, stdout: "" };
      },
    };
    const out = integrateSlices(TOPIC, ROWS, r);
    expect(out).toEqual({ ok: true, rc: 1, rows: [
      { agent: "bravo", label: "wp2", status: "conflict" },
      { agent: "delta", label: "wp3", status: "skipped:tree-dirty" },
    ] });
  });
});

describe("implement integrate — the adapter", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function seed(): string {
    const art = implementArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "target_cwd.txt"), "/run\n");
    writeSlices(join(art, "slices.tsv"), ROWS);
    return art;
  }

  it("writes integrate-1.tsv and prints the four counts, rc 0", async () => {
    const art = seed();
    const cap = captureStdout();
    let rc: number;
    try {
      rc = await integrateWith(TOPIC, "1", { runnerFor: () => fakeRunner({
        ...onBranch, ...clean, ...hasCommits,
        "rev-list --count HEAD..feat/implement-add-oauth-delta": { stdout: "0\n" },
      }) });
    } finally { cap.restore(); }
    expect(rc).toBe(0);
    expect(cap.text()).toBe("MERGED=1\nCONFLICT=\nEMPTY=delta\nSKIPPED=\n");
    expect(readIntegrate(join(art, "integrate-1.tsv"))).toEqual([
      { agent: "bravo", label: "wp2", status: "merged" },
      { agent: "delta", label: "wp3", status: "empty" },
    ]);
  });

  it("a refused precondition prints its KEY=value lines, writes NO tsv, rc 1", async () => {
    const art = seed();
    const cap = captureStdout();
    let rc: number;
    try {
      rc = await integrateWith(TOPIC, "1", { runnerFor: () => fakeRunner({ "symbolic-ref HEAD": { stdout: "refs/heads/main\n" } }) });
    } finally { cap.restore(); }
    expect(rc).toBe(1);
    expect(cap.text()).toBe("BRANCH=main\nEXPECTED=feat/implement-add-oauth\n");
    expect(existsSync(join(art, "integrate-1.tsv"))).toBe(false);
  });

  it("readIntegrate round-trips what the verb wrote (the absorb turn's input)", async () => {
    const art = seed();
    const cap = captureStdout();
    try {
      await integrateWith(TOPIC, "1", { runnerFor: () => fakeRunner({
        ...onBranch, ...clean, ...hasCommits,
        "merge --no-ff --no-edit -m merge: slice wp3 (delta) feat/implement-add-oauth-delta": { code: 1 },
      }) });
    } finally { cap.restore(); }
    expect(readFileSync(join(art, "integrate-1.tsv"), "utf8")).toBe("bravo\twp2\tmerged\ndelta\twp3\tconflict\n");
  });
});
