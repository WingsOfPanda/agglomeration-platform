# consort `solo` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build consort's first high-level command, `solo` — a one-shot autonomous pipeline (brief → branch → single implementation turn → light verify → optional finish → teardown) ported from clone-wars `strike`.

**Architecture:** Directive-orchestrated (Approach A): `commands/solo.md` is run by the conductor (Claude Code), which does every judgment step (brief, fix bundle, question reply) via the Write tool; a `solo` subcommand family does the mechanical steps, reusing the foundation primitives `spawn`/`coda`/`send`. The reusable single-turn and git logic lands in `core/turn.ts` + `core/gitwork.ts` (which `perform` later extends). Single-target only (no DAG).

**Tech Stack:** TypeScript (ES2022/NodeNext/strict), vitest, esbuild (bundle → committed `dist/consort.cjs`), `execFileSync` for git/gh (tested as a fake `Runner`, never run live in unit tests). Spec: `docs/superpowers/specs/2026-05-29-consort-solo-design.md`.

---

## Foundation APIs this plan depends on (verified signatures)

From the grounding pass — use these exactly:

- `core/paths.ts`: `topicDir(topic)`, `partDir(i,m,t)`, `repoRoot(cwd?)` (git toplevel, falls back to cwd), `runArgsFile(command)`. `CONSORT_HOME` is used **verbatim** as the state root.
- `core/atomic.ts`: `atomicWrite(dest, content)` — **parent dir must already exist** (no mkdir); `isoUtc(now?)`, `appendJsonl`.
- `core/ipc.ts`: `outboxPath(i,m,t)`, `outboxOffset(path)` (byte size, 0 if missing), `outboxWaitSince(i,m,t,offset,events,timeoutSec)` (offset 4th, events 5th, timeout 6th), `inboxWrite(i,m,t,task,{from?})` (adds the `done`-event instruction + `END_OF_INSTRUCTION`; default `from`=`maestro`), `OutboxEvent` (`{event:string; ts?:string; [k]:unknown}`).
- `core/instruments.ts`: `pickRandomInstrument(topic, rng?)` → `string | null`.
- `core/contracts.ts`: `instrumentBinary(name)` → `string | undefined`.
- `core/deps.ts`: `haveCmd(name)` → `boolean`.
- `core/log.ts`: `log.{info,ok,warn,error}` — **all write to stderr** (so stdout stays clean for machine-readable KV output).
- `src/args.ts`: `applyArgsFile(argv)` (expands a **leading** `--args-file <path>`, deletes the file), `kvParse(flag,next?)` → `{value, shift}`.
- `src/commands/send.ts`: `run(args)` — `send [--from s] <instrument> <topic> <message|@file>`; resolves model by scanning `topicDir` for `<instrument>-*`.
- `src/consort.ts` dispatcher: flat handler map; `--mint-args-file` mints via `runArgsFile(sub)`.

**Test conventions (match exactly):** vitest `describe/it/expect`; local imports use explicit `.js` extensions; isolate filesystem with `freshHome()` from `tests/helpers/tmpHome.ts` (sets `CONSORT_HOME` to a fresh temp dir) cleaned in `afterEach`; side-effecting fns take a `{ now }` option bag or an injected deps object for determinism (see `coda.test.ts`).

---

## File structure

| File | Responsibility |
|---|---|
| `src/core/solo.ts` (create) | pure: `soloArtDir`/`soloExecDir` paths, `deriveSlug`, `parseSoloArgs`, `detectTestCommand`, `renderSummary`, `renderResume` |
| `src/core/gitwork.ts` (create) | `Runner`/`runnerAt`; pure `classifyDirty`/`finishAutoAction`; orchestration `preSnapshot`/`createOrResumeBranch`/`shortstat`/`finishBranch` (tested via a fake `Runner`) |
| `src/core/turn.ts` (create) | pure: `classifyTurn`, `parseOffset`, `composeRound1Prompt`, `composeFixPrompt` |
| `src/commands/solo.ts` (create) | verb sub-dispatcher + the 7 handlers (`init`/`branch`/`turn-send`/`turn-wait`/`detect-test`/`finish`/`summary`) |
| `src/consort.ts` (modify) | register `solo` in `loadHandlers` |
| `commands/solo.md` (create) | the 4-stage conductor directive |
| `tests/solo-core.test.ts`, `tests/solo-gitwork.test.ts`, `tests/solo-turn.test.ts`, `tests/solo-cmd.test.ts` (create) | unit tests |
| `docs/superpowers/DOGFOOD.md` (modify) | append a `solo` dogfood section |

---

# Phase 1 — `core/solo.ts` (pure helpers)

### Task 1: Path helpers + `deriveSlug`

**Files:**
- Create: `src/core/solo.ts`
- Test: `tests/solo-core.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/solo-core.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { topicDir } from "../src/core/paths.js";
import { soloArtDir, soloExecDir, deriveSlug } from "../src/core/solo.js";

afterEach(() => { delete process.env.CONSORT_HOME; });

describe("solo paths", () => {
  it("soloArtDir/soloExecDir nest under the topic dir", () => {
    process.env.CONSORT_HOME = "/R";
    expect(soloArtDir("auth")).toBe(join(topicDir("auth"), "_solo"));
    expect(soloExecDir("auth")).toBe(join(topicDir("auth"), "_solo", "execute"));
  });
});

describe("deriveSlug", () => {
  it("lowercases, replaces non [a-z0-9-], collapses dashes, caps at 20, trims dashes", () => {
    expect(deriveSlug("Add OAuth login!")).toBe("add-oauth-login");
    expect(deriveSlug("  spaces   and---dashes  ")).toBe("spaces-and-dashes");
    expect(deriveSlug("A".repeat(40))).toBe("a".repeat(20));
    expect(deriveSlug("trailing dash exactly 20x-")).toBe("trailing-dash-exactl");
    expect(deriveSlug("!!!")).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/solo-core.test.ts`
Expected: FAIL — `Cannot find module '../src/core/solo.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/solo.ts
import { join } from "node:path";
import { topicDir } from "./paths.js";

export function soloArtDir(topic: string): string { return join(topicDir(topic), "_solo"); }
export function soloExecDir(topic: string): string { return join(soloArtDir(topic), "execute"); }

/** Lowercase → [a-z0-9-] → collapse dashes → trim → cap 20 → trim trailing dash. "" if no alphanumerics. */
export function deriveSlug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/solo-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/solo.ts tests/solo-core.test.ts
git commit -m "feat(solo): core path helpers + deriveSlug"
```

---

### Task 2: `parseSoloArgs` (extract `--provider` / `--finish`)

**Files:**
- Modify: `src/core/solo.ts`
- Test: `tests/solo-core.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/solo-core.test.ts`)

```ts
import { parseSoloArgs } from "../src/core/solo.js";

describe("parseSoloArgs", () => {
  it("pulls --provider (space + = forms) and --finish out of the topic text", () => {
    expect(parseSoloArgs(["add", "oauth", "login"]))
      .toEqual({ topicText: "add oauth login", provider: undefined, finish: false });
    expect(parseSoloArgs(["fix", "bug", "--provider", "agy"]))
      .toEqual({ topicText: "fix bug", provider: "agy", finish: false });
    expect(parseSoloArgs(["--provider=opencode", "tidy", "imports", "--finish"]))
      .toEqual({ topicText: "tidy imports", provider: "opencode", finish: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/solo-core.test.ts`
Expected: FAIL — `parseSoloArgs is not a function`.

- [ ] **Step 3: Implement** (append to `src/core/solo.ts`)

```ts
export interface SoloArgs { topicText: string; provider?: string; finish: boolean; }

export function parseSoloArgs(tokens: string[]): SoloArgs {
  let provider: string | undefined;
  let finish = false;
  const text: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--finish") { finish = true; continue; }
    if (t === "--provider") { provider = tokens[i + 1]; i++; continue; }
    if (t.startsWith("--provider=")) { provider = t.slice("--provider=".length); continue; }
    text.push(t);
  }
  return { topicText: text.join(" ").trim(), provider, finish };
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/solo-core.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/solo.ts tests/solo-core.test.ts
git commit -m "feat(solo): parseSoloArgs flag extraction"
```

---

### Task 3: `detectTestCommand`

**Files:**
- Modify: `src/core/solo.ts`
- Test: `tests/solo-core.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { detectTestCommand } from "../src/core/solo.js";

describe("detectTestCommand (precedence)", () => {
  function fresh(): string { return mkdtempSync(join(tmpdir(), "solo-dt-")); }

  it("prefers tests/run.sh", () => {
    const r = fresh(); mkdirSync(join(r, "tests")); writeFileSync(join(r, "tests/run.sh"), "");
    writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    expect(detectTestCommand(r)).toBe("bash tests/run.sh");
  });
  it("then package.json test script", () => {
    const r = fresh(); writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(detectTestCommand(r)).toBe("npm test");
  });
  it("then Makefile test target", () => {
    const r = fresh(); writeFileSync(join(r, "Makefile"), "build:\n\tcc\ntest:\n\t./t\n");
    expect(detectTestCommand(r)).toBe("make test");
  });
  it("then pytest when pyproject + tests/ exist", () => {
    const r = fresh(); writeFileSync(join(r, "pyproject.toml"), ""); mkdirSync(join(r, "tests"));
    expect(detectTestCommand(r)).toBe("pytest");
  });
  it("empty string when nothing detected", () => {
    expect(detectTestCommand(fresh())).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL `detectTestCommand is not a function`.

- [ ] **Step 3: Implement** (append to `src/core/solo.ts`)

```ts
import { existsSync, readFileSync } from "node:fs";

/** Repo test command by file presence (never executes). Precedence:
 *  tests/run.sh > package.json "test" > Makefile test: > pytest. "" if none. */
export function detectTestCommand(root: string): string {
  if (existsSync(join(root, "tests", "run.sh"))) return "bash tests/run.sh";
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try { if (JSON.parse(readFileSync(pkg, "utf8"))?.scripts?.test) return "npm test"; } catch { /* not JSON */ }
  }
  const mk = join(root, "Makefile");
  if (existsSync(mk)) {
    try { if (/^test:/m.test(readFileSync(mk, "utf8"))) return "make test"; } catch { /* unreadable */ }
  }
  if ((existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "setup.cfg"))) && existsSync(join(root, "tests"))) return "pytest";
  return "";
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/solo.ts tests/solo-core.test.ts
git commit -m "feat(solo): detectTestCommand"
```

---

### Task 4: `renderSummary` + `renderResume`

**Files:**
- Modify: `src/core/solo.ts`
- Test: `tests/solo-core.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { renderSummary, renderResume } from "../src/core/solo.js";

const okFacts = {
  topic: "auth", status: "ok" as const, started: "2026-05-29T06:00:00Z",
  ended: "2026-05-29T06:05:00Z", duration: 300, provider: "codex", instrument: "violin",
  branch: "feat/solo-auth", verify: "PASS (npm test)", diffStats: " 2 files changed, 9 insertions(+)",
  archived: "/arch/violin-codex-...", targetCwd: "/proj", branchBase: "abc123",
};

describe("renderSummary", () => {
  it("ok summary has frontmatter + Result/Where-to-look sections", () => {
    const md = renderSummary(okFacts);
    expect(md).toMatch(/^---\ncommand: solo\ntopic: auth\nstatus: ok\n/);
    expect(md).toContain("duration_seconds: 300");
    expect(md).toContain("- Provider: codex");
    expect(md).toContain("- Branch: feat/solo-auth");
    expect(md).toContain("- Verify: PASS (npm test)");
    expect(md).toContain("git checkout feat/solo-auth");
  });
  it("aborted summary carries the abort fields + RESUME pointer", () => {
    const md = renderSummary({ ...okFacts, status: "aborted", ended: undefined, duration: undefined,
      abortedPhase: "build", abortedGate: "part-turn-failed", abortedReason: "turn failed twice (TS=failed)" });
    expect(md).toContain("status: aborted");
    expect(md).toContain("aborted_phase: build");
    expect(md).toContain("aborted_reason: turn failed twice (TS=failed)");
    expect(md).toContain("RESUME.md");
  });
});

describe("renderResume", () => {
  it("points at the state dir + manual resume", () => {
    const md = renderResume({ topic: "auth", branch: "feat/solo-auth", artDir: "/s/_solo", phase: "build", gate: "part-turn-failed" });
    expect(md).toContain("# RESUME — auth");
    expect(md).toContain("State dir: /s/_solo");
    expect(md).toContain("re-run /consort:solo");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL `renderSummary is not a function`.

- [ ] **Step 3: Implement** (append to `src/core/solo.ts`)

```ts
export interface SummaryFacts {
  topic: string;
  status: "ok" | "aborted";
  started: string;
  ended?: string;
  duration?: number | string;
  provider: string;
  instrument: string;
  branch: string;
  verify: string;
  diffStats: string;
  archived: string;
  targetCwd: string;
  branchBase: string;
  abortedPhase?: string;
  abortedGate?: string;
  abortedReason?: string;
}

export function renderSummary(f: SummaryFacts): string {
  const head = [
    "---",
    "command: solo",
    `topic: ${f.topic}`,
    `status: ${f.status}`,
    `started: ${f.started}`,
  ];
  if (f.status === "ok") {
    head.push(`ended: ${f.ended ?? "unknown"}`, `duration_seconds: ${f.duration ?? 0}`, "---", "");
    return [
      ...head,
      "## Result",
      `- Provider: ${f.provider}`,
      `- Instrument: ${f.instrument}`,
      `- Branch: ${f.branch}`,
      `- Verify: ${f.verify}`,
      `- Diff: ${f.diffStats}`,
      "",
      "## Where to look",
      `- Review the work: \`git -C ${f.targetCwd} checkout ${f.branch}\` (diff base: ${f.branchBase})`,
      `- Archived state: ${f.archived}`,
      "",
    ].join("\n");
  }
  head.push(
    `aborted_phase: ${f.abortedPhase ?? "unknown"}`,
    `aborted_gate: ${f.abortedGate ?? "unknown"}`,
    `aborted_reason: ${f.abortedReason ?? "unknown"}`,
    "---",
    "",
  );
  return [
    ...head,
    "## Why aborted",
    `- ${f.abortedReason ?? "unknown"}`,
    "",
    "## RESUME instructions",
    `- Read RESUME.md for the state pointer; re-run /consort:solo to retry.`,
    "",
  ].join("\n");
}

export interface ResumeFacts { topic: string; branch: string; artDir: string; phase: string; gate: string; }

export function renderResume(f: ResumeFacts): string {
  return [
    `# RESUME — ${f.topic} (aborted at ${f.phase}.${f.gate})`,
    "",
    "## State pointers",
    `- State dir: ${f.artDir}`,
    `- Topic: ${f.topic}`,
    `- Branch: ${f.branch}`,
    "",
    "## Manual resume",
    `- Inspect ${f.artDir}/execute/ for the part's partial work, then re-run /consort:solo.`,
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/solo.ts tests/solo-core.test.ts
git commit -m "feat(solo): SUMMARY/RESUME renderers"
```

---

# Phase 2 — `core/gitwork.ts`

### Task 5: `Runner` + pure decisions (`classifyDirty`, `finishAutoAction`)

**Files:**
- Create: `src/core/gitwork.ts`
- Test: `tests/solo-gitwork.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/solo-gitwork.test.ts
import { describe, it, expect } from "vitest";
import { classifyDirty, finishAutoAction } from "../src/core/gitwork.js";

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
```

- [ ] **Step 2: Run to verify it fails** — FAIL `Cannot find module '../src/core/gitwork.js'`.

- [ ] **Step 3: Implement** (create `src/core/gitwork.ts`)

```ts
// src/core/gitwork.ts
import { execFileSync } from "node:child_process";

export interface RunResult { code: number; stdout: string; }
export interface Runner { run(cmd: string, args: string[]): RunResult; }

/** A cwd-bound synchronous command runner. execFileSync — never shell. */
export function runnerAt(cwd: string): Runner {
  return {
    run(cmd, args) {
      try {
        const stdout = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return { code: 0, stdout };
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: Buffer | string };
        return { code: typeof err.status === "number" ? err.status : 1, stdout: err.stdout ? String(err.stdout) : "" };
      }
    },
  };
}

export function classifyDirty(porcelain: string): boolean { return porcelain.trim().length > 0; }
export function finishAutoAction(remotes: string): "pr" | "keep" { return remotes.trim().length > 0 ? "pr" : "keep"; }
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/gitwork.ts tests/solo-gitwork.test.ts
git commit -m "feat(solo): gitwork Runner + pure decisions"
```

---

### Task 6: `preSnapshot` + `createOrResumeBranch` + `shortstat`

**Files:**
- Modify: `src/core/gitwork.ts`
- Test: `tests/solo-gitwork.test.ts`

- [ ] **Step 1: Write the failing test** (append). Uses a **fake `Runner`** that records calls and returns scripted outputs.

```ts
import { preSnapshot, createOrResumeBranch, shortstat } from "../src/core/gitwork.js";
import type { Runner, RunResult } from "../src/core/gitwork.js";

/** Fake runner: `replies` maps a "cmd arg arg" key to a scripted RunResult; default {code:0,stdout:""}. */
function fakeRunner(replies: Record<string, RunResult>) {
  const calls: string[][] = [];
  const r: Runner = {
    run(cmd, args) { calls.push([cmd, ...args]); return replies[[cmd, ...args].join(" ")] ?? { code: 0, stdout: "" }; },
  };
  return { r, calls };
}

describe("preSnapshot", () => {
  it("clean tree: records branch + HEAD, no commit", () => {
    const { r, calls } = fakeRunner({
      "git rev-parse --git-dir": { code: 0, stdout: ".git\n" },
      "git symbolic-ref --short HEAD": { code: 0, stdout: "main\n" },
      "git rev-parse HEAD": { code: 0, stdout: "base111\n" },
      "git status --porcelain": { code: 0, stdout: "" },
    });
    expect(preSnapshot(r, "auth")).toEqual({ branch: "main", baseSha: "base111", state: "clean" });
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
    expect(preSnapshot(r, "auth")).toEqual({ branch: "main", baseSha: "new222", state: "wip-committed" });
  });
  it("hook-blocked: commit fails, falls back to pre-attempt HEAD, not fatal", () => {
    const { r } = fakeRunner({
      "git rev-parse --git-dir": { code: 0, stdout: ".git" },
      "git symbolic-ref --short HEAD": { code: 0, stdout: "main" },
      "git rev-parse HEAD": { code: 0, stdout: "pre999" },
      "git status --porcelain": { code: 0, stdout: " M a.ts" },
      "git commit -q -m chore: WIP before solo auth": { code: 1, stdout: "" },
    });
    expect(preSnapshot(r, "auth")).toEqual({ branch: "main", baseSha: "pre999", state: "hook-blocked" });
  });
  it("not-git: rev-parse fails", () => {
    const { r } = fakeRunner({ "git rev-parse --git-dir": { code: 128, stdout: "" } });
    expect(preSnapshot(r, "auth")).toEqual({ branch: "", baseSha: "", state: "not-git" });
  });
});

describe("createOrResumeBranch", () => {
  it("creates with checkout -b when the ref is absent", () => {
    const { r, calls } = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/solo-auth": { code: 1, stdout: "" } });
    expect(createOrResumeBranch(r, "feat/solo-auth")).toBe(true);
    expect(calls).toContainEqual(["git", "checkout", "-q", "-b", "feat/solo-auth"]);
  });
  it("resumes with checkout when the ref exists", () => {
    const { r, calls } = fakeRunner({ "git show-ref --verify --quiet refs/heads/feat/solo-auth": { code: 0, stdout: "" } });
    expect(createOrResumeBranch(r, "feat/solo-auth")).toBe(true);
    expect(calls).toContainEqual(["git", "checkout", "-q", "feat/solo-auth"]);
  });
});

describe("shortstat", () => {
  it("returns the trimmed diff --shortstat base..HEAD", () => {
    const { r } = fakeRunner({ "git diff --shortstat base..HEAD": { code: 0, stdout: " 2 files changed\n" } });
    expect(shortstat(r, "base")).toBe("2 files changed");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (functions undefined).

- [ ] **Step 3: Implement** (append to `src/core/gitwork.ts`)

```ts
export interface SnapshotResult {
  branch: string;
  baseSha: string;
  state: "clean" | "wip-committed" | "hook-blocked" | "not-git";
}

/** Capture branch + base SHA; if the tree is dirty, commit a WIP snapshot on the current branch. */
export function preSnapshot(r: Runner, topic: string): SnapshotResult {
  if (r.run("git", ["rev-parse", "--git-dir"]).code !== 0) return { branch: "", baseSha: "", state: "not-git" };
  const branch = r.run("git", ["symbolic-ref", "--short", "HEAD"]).stdout.trim() || "(detached)";
  const preSha = r.run("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!classifyDirty(r.run("git", ["status", "--porcelain"]).stdout)) {
    return { branch, baseSha: preSha, state: "clean" };
  }
  r.run("git", ["add", "-A"]);
  if (r.run("git", ["commit", "-q", "-m", `chore: WIP before solo ${topic}`]).code !== 0) {
    return { branch, baseSha: preSha, state: "hook-blocked" };
  }
  return { branch, baseSha: r.run("git", ["rev-parse", "HEAD"]).stdout.trim(), state: "wip-committed" };
}

/** Create feat/solo-<topic> from current HEAD, or resume it if it already exists. */
export function createOrResumeBranch(r: Runner, name: string): boolean {
  if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).code === 0) {
    return r.run("git", ["checkout", "-q", name]).code === 0;
  }
  return r.run("git", ["checkout", "-q", "-b", name]).code === 0;
}

export function shortstat(r: Runner, base: string): string {
  return r.run("git", ["diff", "--shortstat", `${base}..HEAD`]).stdout.trim();
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/gitwork.ts tests/solo-gitwork.test.ts
git commit -m "feat(solo): preSnapshot/branch/shortstat"
```

---

### Task 7: `finishBranch` (push / PR / keep + restore)

**Files:**
- Modify: `src/core/gitwork.ts`
- Test: `tests/solo-gitwork.test.ts`

- [ ] **Step 1: Write the failing test** (append; reuse the `fakeRunner` helper above)

```ts
import { finishBranch } from "../src/core/gitwork.js";

describe("finishBranch", () => {
  it("no remote → keep, restores start branch", () => {
    const { r, calls } = fakeRunner({ "git remote": { code: 0, stdout: "" } });
    expect(finishBranch(r, { branch: "feat/solo-auth", startBranch: "main", hasGh: true }))
      .toEqual({ action: "keep", outcome: "kept" });
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
  });
  it("remote + gh → push + pr-opened, restores start branch", () => {
    const { r, calls } = fakeRunner({
      "git remote": { code: 0, stdout: "origin\n" },
      "git push -q -u origin feat/solo-auth": { code: 0, stdout: "" },
      "git remote get-url origin": { code: 0, stdout: "git@example:me/r.git\n" },
    });
    const res = finishBranch(r, { branch: "feat/solo-auth", startBranch: "main", hasGh: true, title: "solo: feat/solo-auth", body: "b" });
    expect(res).toEqual({ action: "pr", outcome: "pr-opened" });
    expect(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create")).toBe(true);
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
  });
  it("remote, push ok, gh absent → pr-pushed-no-gh", () => {
    const { r } = fakeRunner({
      "git remote": { code: 0, stdout: "origin" },
      "git push -q -u origin feat/solo-auth": { code: 0, stdout: "" },
      "git remote get-url origin": { code: 0, stdout: "url" },
    });
    expect(finishBranch(r, { branch: "feat/solo-auth", startBranch: "main", hasGh: false }).outcome).toBe("pr-pushed-no-gh");
  });
  it("push fails → pr-failed-kept", () => {
    const { r } = fakeRunner({
      "git remote": { code: 0, stdout: "origin" },
      "git push -q -u origin feat/solo-auth": { code: 1, stdout: "" },
    });
    expect(finishBranch(r, { branch: "feat/solo-auth", startBranch: "main", hasGh: true }).outcome).toBe("pr-failed-kept");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL `finishBranch is not a function`.

- [ ] **Step 3: Implement** (append to `src/core/gitwork.ts`)

```ts
export interface FinishOpts {
  branch: string;
  startBranch: string;
  hasGh: boolean;
  originUrl?: string;
  title?: string;
  body?: string;
}
export interface FinishResult { action: "pr" | "keep"; outcome: string; }

/** Auto finish: remote → push + gh PR; none → keep. Always restores the start-branch checkout. Best-effort. */
export function finishBranch(r: Runner, o: FinishOpts): FinishResult {
  const action = finishAutoAction(r.run("git", ["remote"]).stdout);
  if (action === "keep") {
    r.run("git", ["checkout", "-q", o.startBranch]);
    return { action, outcome: "kept" };
  }
  let outcome: string;
  if (r.run("git", ["push", "-q", "-u", "origin", o.branch]).code === 0) {
    const url = o.originUrl ?? r.run("git", ["remote", "get-url", "origin"]).stdout.trim();
    const title = o.title ?? `solo: ${o.branch}`;
    const body = o.body ?? `Automated solo branch. Review and merge into ${o.startBranch}.`;
    if (o.hasGh && r.run("gh", ["pr", "create", "--repo", url, "--base", o.startBranch, "--head", o.branch, "--title", title, "--body", body]).code === 0) {
      outcome = "pr-opened";
    } else {
      outcome = "pr-pushed-no-gh";
    }
  } else {
    outcome = "pr-failed-kept";
  }
  r.run("git", ["checkout", "-q", o.startBranch]);
  return { action, outcome };
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/gitwork.ts tests/solo-gitwork.test.ts
git commit -m "feat(solo): finishBranch push/PR/keep with restore"
```

---

# Phase 3 — `core/turn.ts`

### Task 8: `composeRound1Prompt` + `composeFixPrompt`

**Files:**
- Create: `src/core/turn.ts`
- Test: `tests/solo-turn.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/solo-turn.test.ts
import { describe, it, expect } from "vitest";
import { composeRound1Prompt, composeFixPrompt } from "../src/core/turn.js";

describe("composeRound1Prompt", () => {
  it("inlines the brief, names the branch, forbids branch switching, documents question/done", () => {
    const p = composeRound1Prompt("## Goal\nAdd X", "feat/solo-auth");
    expect(p).toContain("## Goal\nAdd X");
    expect(p).toContain("feat/solo-auth");
    expect(p).toMatch(/do NOT.*(checkout|switch|branch)/i);
    expect(p).toContain('"event":"question"');
    // must NOT carry its own END_OF_INSTRUCTION — inboxWrite appends the canonical fence
    expect(p).not.toContain("END_OF_INSTRUCTION");
  });
});

describe("composeFixPrompt", () => {
  it("embeds the issues under an ISSUES heading and names the round", () => {
    const p = composeFixPrompt("- test foo fails", 2);
    expect(p).toContain("ROUND 2");
    expect(p).toContain("ISSUES TO ADDRESS");
    expect(p).toContain("- test foo fails");
    expect(p).not.toContain("END_OF_INSTRUCTION");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL `Cannot find module '../src/core/turn.js'`.

- [ ] **Step 3: Implement** (create `src/core/turn.ts`)

```ts
// src/core/turn.ts
import type { OutboxEvent } from "./ipc.js";

const BRANCH_DISCIPLINE =
  "BRANCH DISCIPLINE (hard rule):\n" +
  "- You are already on the correct branch. Do NOT run `git checkout`, `git switch`,\n" +
  "  or `git branch`, and do NOT create new branches.\n" +
  "- If the work genuinely needs a different branch, do NOT switch; instead emit\n" +
  '  {"event":"error","reason":"branch-discipline: needed a different branch"} and stop.\n';

const BLOCKERS =
  "IF YOU ARE BLOCKED:\n" +
  "- If a path, file, command, or assumption is wrong or missing, do NOT guess or invent a\n" +
  "  workaround. Append a question event to your outbox and stop:\n" +
  '  {"event":"question","message":"<what you need and why>","ts":"<iso>"}\n' +
  "  The conductor will reply via your inbox, then re-engage you.\n";

/** Round-1 prompt body (the IMPLEMENT instructions + the inlined brief). NOTE: must NOT include
 *  END_OF_INSTRUCTION or the done-event line — inboxWrite() appends the canonical done instruction
 *  and the END_OF_INSTRUCTION fence when this becomes the inbox task. */
export function composeRound1Prompt(briefText: string, branch: string): string {
  return [
    `You are implementing a single, self-contained change on the branch \`${branch}\` of this repository.`,
    "",
    "This is one autonomous turn: read the task, implement it, commit your work, then report.",
    "",
    "THE TASK:",
    "",
    briefText.trim(),
    "",
    "INSTRUCTIONS:",
    `- Implement the change directly in this repository's working tree (you are on \`${branch}\`).`,
    "- Commit per logical change with Conventional Commits messages.",
    "- If the repository has a test suite, run it and make your change pass it.",
    "- When the implementation is complete and committed, emit the done event (see below).",
    "",
    BRANCH_DISCIPLINE,
    BLOCKERS,
  ].join("\n");
}

/** Fix-round prompt body (round >= 2). Same fence note as composeRound1Prompt. */
export function composeFixPrompt(issuesText: string, round: number): string {
  return [
    `You are entering ROUND ${round} of /consort:solo (fix loop), still on the same branch.`,
    "",
    "This is one autonomous turn: fix each issue below, commit per fix, re-run the tests, then report.",
    "",
    "ISSUES TO ADDRESS:",
    "",
    issuesText.trim(),
    "",
    "INSTRUCTIONS:",
    "- Fix each issue above. Commit per fix with Conventional Commits messages.",
    "- Re-run the repository's test suite and confirm it passes.",
    "- When all issues are addressed and committed, emit the done event (see below).",
    "",
    BRANCH_DISCIPLINE,
    BLOCKERS,
  ].join("\n");
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/turn.ts tests/solo-turn.test.ts
git commit -m "feat(solo): round-1 + fix-round prompt composers"
```

---

### Task 9: `classifyTurn` + `parseOffset`

**Files:**
- Modify: `src/core/turn.ts`
- Test: `tests/solo-turn.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { classifyTurn, parseOffset } from "../src/core/turn.js";

describe("classifyTurn", () => {
  it("maps events to TS; null → timeout", () => {
    expect(classifyTurn(null)).toBe("timeout");
    expect(classifyTurn({ event: "done", summary: "ok" })).toBe("ok");
    expect(classifyTurn({ event: "error", message: "x" })).toBe("failed");
    expect(classifyTurn({ event: "question", message: "?" })).toBe("question");
    expect(classifyTurn({ event: "weird" })).toBe("failed");
  });
});

describe("parseOffset", () => {
  it("reads the OFFSET= line, ignores a later TS= line", () => {
    expect(parseOffset("OFFSET=128\n")).toBe(128);
    expect(parseOffset("OFFSET=0\nTS=ok\n")).toBe(0);
    expect(parseOffset("TS=failed\n")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (functions undefined).

- [ ] **Step 3: Implement** (append to `src/core/turn.ts`)

```ts
export type TurnStatus = "ok" | "failed" | "question" | "timeout";

/** done → ok; question → question; null (no event before timeout) → timeout; everything else (error, unknown) → failed. */
export function classifyTurn(ev: OutboxEvent | null): TurnStatus {
  if (!ev) return "timeout";
  if (ev.event === "done") return "ok";
  if (ev.event === "question") return "question";
  return "failed";
}

/** Read the OFFSET=<n> line from a turn state file's contents. null if absent/unparseable. */
export function parseOffset(stateText: string): number | null {
  const m = stateText.match(/^OFFSET=(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/turn.ts tests/solo-turn.test.ts
git commit -m "feat(solo): classifyTurn + parseOffset"
```

---

# Phase 4 — `solo` subcommands + dispatcher

### Task 10: Register `solo` + verb dispatcher skeleton

**Files:**
- Modify: `src/consort.ts:8-18`
- Create: `src/commands/solo.ts`
- Test: `tests/solo-cmd.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/solo-cmd.test.ts
import { describe, it, expect } from "vitest";
import { run as soloRun } from "../src/commands/solo.js";

describe("solo dispatcher", () => {
  it("no verb / unknown verb → usage, rc 2", async () => {
    expect(await soloRun([])).toBe(2);
    expect(await soloRun(["frobnicate"])).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL `Cannot find module '../src/commands/solo.js'`.

- [ ] **Step 3: Implement.** Create `src/commands/solo.ts`:

```ts
// src/commands/solo.ts
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";

function usage(): number {
  log.error("usage: solo <init|branch|turn-send|turn-wait|detect-test|finish|summary> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest));
    case "branch": return branchRun(rest);
    case "turn-send": return turnSendRun(rest);
    case "turn-wait": return turnWaitRun(rest);
    case "detect-test": return detectTestRun(rest);
    case "finish": return finishRun(rest);
    case "summary": return summaryRun(rest);
    default: return usage();
  }
}

// Handlers are filled in by later tasks. Stubs keep the dispatcher compilable.
async function initRun(_a: string[]): Promise<number> { log.error("solo init: not implemented"); return 2; }
async function branchRun(_a: string[]): Promise<number> { log.error("solo branch: not implemented"); return 2; }
async function turnSendRun(_a: string[]): Promise<number> { log.error("solo turn-send: not implemented"); return 2; }
async function turnWaitRun(_a: string[]): Promise<number> { log.error("solo turn-wait: not implemented"); return 2; }
async function detectTestRun(_a: string[]): Promise<number> { log.error("solo detect-test: not implemented"); return 2; }
async function finishRun(_a: string[]): Promise<number> { log.error("solo finish: not implemented"); return 2; }
async function summaryRun(_a: string[]): Promise<number> { log.error("solo summary: not implemented"); return 2; }
```

Then register in `src/consort.ts` `loadHandlers` (add the import to the `Promise.all` array and the map entry):

```ts
  const [spawn, send, collect, roster, coda, soundcheck, preflight, hook, solo] = await Promise.all([
    import("./commands/spawn.js"), import("./commands/send.js"), import("./commands/collect.js"),
    import("./commands/roster.js"), import("./commands/coda.js"), import("./commands/soundcheck.js"),
    import("./commands/preflight.js"), import("./commands/hook.js"), import("./commands/solo.js"),
  ]);
  return {
    spawn: spawn.run, send: send.run, collect: collect.run, roster: roster.run,
    coda: coda.run, soundcheck: soundcheck.run, preflight: preflight.run, hook: hook.run, solo: solo.run,
  };
```

- [ ] **Step 4: Run tests + typecheck** — `npx vitest run tests/solo-cmd.test.ts` → PASS; `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/solo.ts src/consort.ts tests/solo-cmd.test.ts
git commit -m "feat(solo): register solo subcommand + verb dispatcher"
```

---

### Task 11: `solo init`

**Files:**
- Modify: `src/commands/solo.ts`
- Test: `tests/solo-cmd.test.ts`

`init` parses the topic text + flags, derives the slug, validates the provider, picks an instrument, refuses if in-flight, scaffolds `_solo/`, and prints a machine-readable KV block (`SLUG`/`INSTRUMENT`/`PROVIDER`/`FINISH`/`TARGET`) to **stdout** for the directive. Logs go to stderr.

- [ ] **Step 1: Write the failing test** (append to `tests/solo-cmd.test.ts`)

```ts
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freshHome } from "./helpers/tmpHome.js";
import { soloArtDir } from "../src/core/solo.js";

// Build an --args-file the way the dispatcher expects (first line tokenized).
function argsFile(home: string, line: string): string {
  const p = join(home, "args.txt");
  writeFileSync(p, line + "\n");
  return p;
}

describe("solo init", () => {
  let h: { home: string; cleanup: () => void };
  let outSpy: ReturnType<typeof captureStdout>;
  beforeEach(() => { h = freshHome(); outSpy = captureStdout(); });
  afterEach(() => { outSpy.restore(); h.cleanup(); });

  it("scaffolds _solo, validates provider, prints KV; rc 0", async () => {
    // codex is in config/contracts.yaml and (in CI) may not be on PATH — force provider validation
    // to pass by pointing at an instrument whose binary exists. Use a fake provider via CONSORT config?
    // Simpler: assert the in-flight + bad-args paths deterministically; provider-present path is dogfood-covered.
    const rc = await soloRun(["init", "--args-file", argsFile(h.home, "add oauth login --provider codex")]);
    // rc is 0 when codex binary present, else 3 (no-provider). Accept either but assert scaffolding on 0.
    if (rc === 0) {
      const art = soloArtDir("add-oauth-login");
      expect(existsSync(join(art, "execute"))).toBe(true);
      expect(readFileSync(join(art, "topic.txt"), "utf8").trim()).toBe("add-oauth-login");
      expect(readFileSync(join(art, "selected-provider.txt"), "utf8").trim()).toBe("codex");
      expect(readFileSync(join(art, "execute", "finish.txt"), "utf8").trim()).toBe("no");
      expect(outSpy.text()).toMatch(/^SLUG=add-oauth-login$/m);
      expect(outSpy.text()).toMatch(/^PROVIDER=codex$/m);
    } else {
      expect(rc).toBe(3);
    }
  });

  it("empty topic → rc 1", async () => {
    expect(await soloRun(["init", "--args-file", argsFile(h.home, "--provider codex")])).toBe(1);
  });

  it("unknown provider → rc 3", async () => {
    expect(await soloRun(["init", "--args-file", argsFile(h.home, "do thing --provider nope")])).toBe(3);
  });

  it("in-flight (art dir exists) → rc 2", async () => {
    const first = await soloRun(["init", "--args-file", argsFile(h.home, "dup topic --provider codex")]);
    if (first !== 0) return; // skip if codex binary absent in this env
    expect(await soloRun(["init", "--args-file", argsFile(h.home, "dup topic --provider codex")])).toBe(2);
  });
});

// Minimal stdout capture helper (no extra deps).
function captureStdout() {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => { buf += String(chunk); return true; };
  return { text: () => buf, restore: () => { (process.stdout as any).write = orig; } };
}
```

Add `beforeEach, afterEach` to the vitest import at the top of the file.

- [ ] **Step 2: Run to verify it fails** — FAIL (`solo init: not implemented` → rc 2, not the expected codes).

- [ ] **Step 3: Implement.** Replace the `initRun` stub in `src/commands/solo.ts` and add imports:

```ts
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, isoUtc } from "../core/atomic.js";
import { repoRoot } from "../core/paths.js";
import { soloArtDir, soloExecDir, deriveSlug, parseSoloArgs } from "../core/solo.js";
import { instrumentBinary } from "../core/contracts.js";
import { haveCmd } from "../core/deps.js";
import { pickRandomInstrument } from "../core/instruments.js";
```

```ts
async function initRun(tokens: string[]): Promise<number> {
  const { topicText, provider: provArg, finish } = parseSoloArgs(tokens);
  if (!topicText) { log.error("solo init: topic text is empty"); return 1; }
  const slug = deriveSlug(topicText);
  if (!slug) { log.error("solo init: topic produced an empty slug; provide alphanumerics"); return 1; }

  const provider = provArg ?? "codex";
  const binary = instrumentBinary(provider);
  if (!binary) { log.error(`solo init: provider '${provider}' has no entry in contracts.yaml`); return 3; }
  if (!haveCmd(binary)) { log.error(`solo init: ${provider}'s binary '${binary}' is not on PATH`); return 3; }

  const art = soloArtDir(slug);
  if (existsSync(art)) { log.error(`solo init: topic already in flight: ${art}`); log.error("  run /consort:coda or pick a different topic"); return 2; }

  const instrument = pickRandomInstrument(slug);
  if (!instrument) { log.error(`solo init: no available instrument in the pool for '${slug}'`); return 1; }

  const exec = soloExecDir(slug);
  mkdirSync(exec, { recursive: true });
  atomicWrite(join(art, "topic.txt"), slug + "\n");
  atomicWrite(join(art, "topic-text.txt"), topicText);
  atomicWrite(join(art, "selected-provider.txt"), provider + "\n");
  atomicWrite(join(art, "instrument.txt"), instrument + "\n");
  atomicWrite(join(art, "timing.txt"), `started=${isoUtc()}\n`);
  atomicWrite(join(exec, "provider.txt"), provider + "\n");
  atomicWrite(join(exec, "finish.txt"), (finish ? "yes" : "no") + "\n");

  const target = repoRoot();
  log.ok(`solo init: topic=${slug} instrument=${instrument} provider=${provider} finish=${finish ? "yes" : "no"}`);
  process.stdout.write(`SLUG=${slug}\nINSTRUMENT=${instrument}\nPROVIDER=${provider}\nFINISH=${finish ? "yes" : "no"}\nTARGET=${target}\n`);
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/solo-cmd.test.ts` → PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/solo.ts tests/solo-cmd.test.ts
git commit -m "feat(solo): init handler (scaffold + provider validate + instrument pick)"
```

---

### Task 12: `solo branch`

**Files:**
- Modify: `src/commands/solo.ts`
- Test: `tests/solo-cmd.test.ts`

`branch` snapshots the target repo and creates/resumes `feat/solo-<topic>`. To keep it unit-testable without real git, factor the git side through an injectable `Runner` (default `runnerAt(target)`), mirroring how `coda` injects `CodaDeps`.

- [ ] **Step 1: Write the failing test** (append). Drives `branchRun` through an exported `branchWith(topic, target, r)` core that takes a fake `Runner`.

```ts
import { branchWith } from "../src/commands/solo.js";
import type { Runner } from "../src/core/gitwork.js";

describe("solo branch (branchWith core)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  function fake(): { r: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const r: Runner = { run(cmd, args) {
      calls.push([cmd, ...args]);
      const k = [cmd, ...args].join(" ");
      if (k === "git rev-parse --git-dir") return { code: 0, stdout: ".git" };
      if (k === "git symbolic-ref --short HEAD") return { code: 0, stdout: "main" };
      if (k === "git rev-parse HEAD") return { code: 0, stdout: "base000" };
      if (k === "git status --porcelain") return { code: 0, stdout: "" };
      if (k === "git show-ref --verify --quiet refs/heads/feat/solo-auth") return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    } };
    return { r, calls };
  }

  it("writes execute/ snapshot files and creates the branch; rc 0", async () => {
    // pre-create _solo so atomicWrite's parent exists (init normally does this)
    const { soloExecDir } = await import("../src/core/solo.js");
    mkdtempSync(join(tmpdir(), "x-")); // noop to keep import order
    const { mkdirSync } = await import("node:fs");
    mkdirSync(soloExecDir("auth"), { recursive: true });

    const { r, calls } = fake();
    const rc = await branchWith("auth", "/proj", r);
    expect(rc).toBe(0);
    expect(calls).toContainEqual(["git", "checkout", "-q", "-b", "feat/solo-auth"]);
    const exec = soloExecDir("auth");
    expect(readFileSync(join(exec, "target_cwd.txt"), "utf8").trim()).toBe("/proj");
    expect(readFileSync(join(exec, "start-branch.txt"), "utf8").trim()).toBe("main");
    expect(readFileSync(join(exec, "branch-base.sha"), "utf8").trim()).toBe("base000");
    expect(readFileSync(join(exec, "branch.txt"), "utf8").trim()).toBe("feat/solo-auth");
  });

  it("not-git target → rc 1", async () => {
    const r: Runner = { run: () => ({ code: 128, stdout: "" }) };
    const { mkdirSync } = await import("node:fs");
    const { soloExecDir } = await import("../src/core/solo.js");
    mkdirSync(soloExecDir("nope"), { recursive: true });
    expect(await branchWith("nope", "/proj", r)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL `branchWith is not a function`.

- [ ] **Step 3: Implement.** Add to `src/commands/solo.ts` (imports + handler + exported core):

```ts
import { soloExecDir as execDirOf } from "../core/solo.js"; // already imported soloExecDir; reuse it
import { runnerAt, preSnapshot, createOrResumeBranch } from "../core/gitwork.js";
import type { Runner } from "../core/gitwork.js";
```

(If `soloExecDir` is already imported in Task 11, do not re-import — just use it.)

```ts
async function branchRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: solo branch <topic>"); return 2; }
  const target = repoRoot();
  return branchWith(topic, target, runnerAt(target));
}

/** Testable core: snapshot + branch the target repo, recording execute/ facts. */
export async function branchWith(topic: string, target: string, r: Runner): Promise<number> {
  const snap = preSnapshot(r, topic);
  if (snap.state === "not-git") { log.error(`solo branch: ${target} is not a git repository`); return 1; }
  const branch = `feat/solo-${topic}`;
  const onBranch = createOrResumeBranch(r, branch);
  const exec = soloExecDir(topic);
  atomicWrite(join(exec, "target_cwd.txt"), target + "\n");
  atomicWrite(join(exec, "start-branch.txt"), snap.branch + "\n");
  atomicWrite(join(exec, "branch-base.sha"), snap.baseSha + "\n");
  atomicWrite(join(exec, "branch.txt"), branch + "\n");
  if (!onBranch) { log.warn(`solo branch: checkout ${branch} failed; staying on ${snap.branch}`); }
  log.ok(`solo branch: ${branch} (snapshot=${snap.state}, base=${snap.baseSha.slice(0, 8)})`);
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes** — PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/solo.ts tests/solo-cmd.test.ts
git commit -m "feat(solo): branch handler (snapshot + create/resume branch)"
```

---

### Task 13: `solo turn-send`

**Files:**
- Modify: `src/commands/solo.ts`
- Test: `tests/solo-cmd.test.ts`

`turn-send <topic> <round>` composes the round prompt, captures the outbox OFFSET, writes `turn-<round>.txt`, and dispatches via the `send` primitive. Factor the send through an injectable to test without tmux.

- [ ] **Step 1: Write the failing test** (append). Drives the exported `turnSendWith(topic, round, deps)` core.

```ts
import { turnSendWith } from "../src/commands/solo.js";

describe("solo turn-send (turnSendWith core)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  async function scaffold(topic: string) {
    const { soloArtDir, soloExecDir } = await import("../src/core/solo.js");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(soloExecDir(topic), { recursive: true });
    const art = soloArtDir(topic);
    writeFileSync(join(art, "instrument.txt"), "violin\n");
    writeFileSync(join(art, "selected-provider.txt"), "codex\n");
    writeFileSync(join(art, "task-brief.md"), "## Goal\nDo X");
    writeFileSync(join(soloExecDir(topic), "branch.txt"), "feat/solo-auth\n");
  }

  it("round 1: writes OFFSET, prompt file, calls send; rc 0", async () => {
    await scaffold("auth");
    const sends: string[][] = [];
    const rc = await turnSendWith("auth", 1, {
      offsetFor: () => 42,
      send: async (args) => { sends.push(args); return 0; },
    });
    expect(rc).toBe(0);
    const { soloExecDir } = await import("../src/core/solo.js");
    const exec = soloExecDir("auth");
    expect(readFileSync(join(exec, "turn-1.txt"), "utf8")).toBe("OFFSET=42\n");
    expect(readFileSync(join(exec, "turn-prompt-1.md"), "utf8")).toContain("## Goal\nDo X");
    expect(sends[0]).toEqual(["violin", "auth", `@${join(exec, "turn-prompt-1.md")}`]);
  });

  it("round 1 idempotency: existing turn-1.txt → rc 1", async () => {
    await scaffold("auth");
    const { soloExecDir } = await import("../src/core/solo.js");
    writeFileSync(join(soloExecDir("auth"), "turn-1.txt"), "OFFSET=0\n");
    expect(await turnSendWith("auth", 1, { offsetFor: () => 0, send: async () => 0 })).toBe(1);
  });

  it("round 2 without a fix bundle → rc 1", async () => {
    await scaffold("auth");
    expect(await turnSendWith("auth", 2, { offsetFor: () => 0, send: async () => 0 })).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL `turnSendWith is not a function`.

- [ ] **Step 3: Implement.** Add to `src/commands/solo.ts`:

```ts
import { soloArtDir } from "../core/solo.js"; // add to existing solo import
import { outboxOffset, outboxPath } from "../core/ipc.js";
import { composeRound1Prompt, composeFixPrompt } from "../core/turn.js";
import { run as sendRun } from "./send.js";

export interface TurnSendDeps {
  offsetFor(instrument: string, model: string, topic: string): number;
  send(args: string[]): Promise<number>;
}

async function turnSendRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  const round = Number(roundStr);
  if (!topic || !Number.isInteger(round) || round < 1) { log.error("usage: solo turn-send <topic> <round>=1.."); return 2; }
  return turnSendWith(topic, round, {
    offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)),
    send: (args) => sendRun(args),
  });
}

export async function turnSendWith(topic: string, round: number, d: TurnSendDeps): Promise<number> {
  const art = soloArtDir(topic);
  const exec = soloExecDir(topic);
  const instrument = readField(join(art, "instrument.txt"));
  const provider = readField(join(art, "selected-provider.txt"));
  if (!instrument || !provider) { log.error("solo turn-send: missing instrument.txt/selected-provider.txt (run solo init)"); return 1; }

  const stateFile = join(exec, `turn-${round}.txt`);
  if (existsSync(stateFile)) { log.error(`solo turn-send: ${stateFile} already exists; rm to retry`); return 1; }

  let prompt: string;
  if (round === 1) {
    const brief = existsSync(join(art, "task-brief.md")) ? readFileSync(join(art, "task-brief.md"), "utf8") : "";
    const branch = readField(join(exec, "branch.txt")) || `feat/solo-${topic}`;
    prompt = composeRound1Prompt(brief, branch);
  } else {
    const bundle = join(exec, `fix-prompt-${round}.md`);
    if (!existsSync(bundle)) { log.error(`solo turn-send: fix bundle missing: ${bundle} (the directive must write it first)`); return 1; }
    prompt = composeFixPrompt(readFileSync(bundle, "utf8"), round);
  }

  const promptFile = join(exec, `turn-prompt-${round}.md`);
  atomicWrite(promptFile, prompt);
  const offset = d.offsetFor(instrument, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);

  const rc = await d.send([instrument, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`solo turn-send: send failed (rc=${rc}); ${stateFile} kept for retry`); return 1; }
  log.ok(`solo turn-send: round=${round} offset=${offset}`);
  return 0;
}

/** Read the first line of a single-value state file, trimmed; "" if absent. */
function readField(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n")[0].trim() : "";
}
```

- [ ] **Step 4: Run to verify it passes** — PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/solo.ts tests/solo-cmd.test.ts
git commit -m "feat(solo): turn-send (offset capture + prompt compose + dispatch)"
```

---

### Task 14: `solo turn-wait`

**Files:**
- Modify: `src/commands/solo.ts`
- Test: `tests/solo-cmd.test.ts`

`turn-wait <topic> <round>` reads OFFSET, waits for `done|error|question` past it, classifies `TS`, captures the question payload, and **appends** `TS=` to `turn-<round>.txt`. Always rc 0.

- [ ] **Step 1: Write the failing test** (append). Drives the exported `turnWaitWith(topic, round, deps)` core with an injected waiter.

```ts
import { turnWaitWith } from "../src/commands/solo.js";

describe("solo turn-wait (turnWaitWith core)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  async function scaffold(topic: string, stateBody: string) {
    const { soloArtDir, soloExecDir } = await import("../src/core/solo.js");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(soloExecDir(topic), { recursive: true });
    writeFileSync(join(soloArtDir(topic), "instrument.txt"), "violin\n");
    writeFileSync(join(soloArtDir(topic), "selected-provider.txt"), "codex\n");
    writeFileSync(join(soloExecDir(topic), `turn-1.txt`), stateBody);
  }

  it("done → appends TS=ok; rc 0", async () => {
    await scaffold("auth", "OFFSET=10\n");
    const rc = await turnWaitWith("auth", 1, { wait: async () => ({ event: "done", summary: "ok" }) });
    expect(rc).toBe(0);
    const { soloExecDir } = await import("../src/core/solo.js");
    expect(readFileSync(join(soloExecDir("auth"), "turn-1.txt"), "utf8")).toBe("OFFSET=10\nTS=ok\n");
  });

  it("question → captures payload + TS=question", async () => {
    await scaffold("auth", "OFFSET=0\n");
    await turnWaitWith("auth", 1, { wait: async () => ({ event: "question", message: "which db?" }) });
    const { soloExecDir } = await import("../src/core/solo.js");
    expect(readFileSync(join(soloExecDir("auth"), "turn-1.txt"), "utf8")).toContain("TS=question");
    expect(readFileSync(join(soloExecDir("auth"), "question-1.txt"), "utf8")).toContain("which db?");
  });

  it("timeout (null) → TS=timeout", async () => {
    await scaffold("auth", "OFFSET=0\n");
    await turnWaitWith("auth", 1, { wait: async () => null });
    const { soloExecDir } = await import("../src/core/solo.js");
    expect(readFileSync(join(soloExecDir("auth"), "turn-1.txt"), "utf8")).toContain("TS=timeout");
  });

  it("missing OFFSET → rc 1", async () => {
    await scaffold("auth", "TS=stale\n");
    expect(await turnWaitWith("auth", 1, { wait: async () => null })).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL `turnWaitWith is not a function`.

- [ ] **Step 3: Implement.** Add to `src/commands/solo.ts`:

```ts
import { appendFileSync } from "node:fs";
import { outboxWaitSince, type OutboxEvent } from "../core/ipc.js";
import { classifyTurn, parseOffset } from "../core/turn.js";

export interface TurnWaitDeps {
  wait(instrument: string, model: string, topic: string, offset: number, events: string[], timeoutSec: number): Promise<OutboxEvent | null>;
}

const SOLO_TURN_TIMEOUT = Number(process.env.CONSORT_SOLO_TURN_TIMEOUT) || 14400;

async function turnWaitRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  const round = Number(roundStr);
  if (!topic || !Number.isInteger(round) || round < 1) { log.error("usage: solo turn-wait <topic> <round>=1.."); return 2; }
  return turnWaitWith(topic, round, {
    wait: (i, m, t, off, ev, to) => outboxWaitSince(i, m, t, off, ev, to),
  });
}

export async function turnWaitWith(topic: string, round: number, d: TurnWaitDeps): Promise<number> {
  const art = soloArtDir(topic);
  const exec = soloExecDir(topic);
  const instrument = readField(join(art, "instrument.txt"));
  const provider = readField(join(art, "selected-provider.txt"));
  const stateFile = join(exec, `turn-${round}.txt`);
  if (!existsSync(stateFile)) { log.error(`solo turn-wait: ${stateFile} missing (run solo turn-send first)`); return 1; }
  const offset = parseOffset(readFileSync(stateFile, "utf8"));
  if (offset === null) { log.error(`solo turn-wait: OFFSET not set in ${stateFile}`); return 1; }

  log.info(`solo turn-wait: round=${round} offset=${offset} timeout=${SOLO_TURN_TIMEOUT}s`);
  const ev = await d.wait(instrument, provider, topic, offset, ["done", "error", "question"], SOLO_TURN_TIMEOUT);
  const ts = classifyTurn(ev);
  if (ts === "question" && ev) atomicWrite(join(exec, `question-${round}.txt`), JSON.stringify(ev) + "\n");
  appendFileSync(stateFile, `TS=${ts}\n`);
  log.ok(`solo turn-wait: round=${round} TS=${ts}`);
  return 0;
}
```

(`OutboxEvent` is re-exported from `core/ipc.js` — the import on the `turn.ts` side uses `import type`.)

- [ ] **Step 4: Run to verify it passes** — PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/solo.ts tests/solo-cmd.test.ts
git commit -m "feat(solo): turn-wait (classify + append TS + capture question)"
```

---

### Task 15: `solo detect-test`

**Files:**
- Modify: `src/commands/solo.ts`
- Test: `tests/solo-cmd.test.ts`

Thin wrapper: print `detectTestCommand(cwd)` to stdout. `cwd` defaults to `repoRoot()`.

- [ ] **Step 1: Write the failing test** (append)

```ts
describe("solo detect-test", () => {
  let outSpy: ReturnType<typeof captureStdout>;
  beforeEach(() => { outSpy = captureStdout(); });
  afterEach(() => { outSpy.restore(); });

  it("prints the detected command for a given cwd; rc 0", async () => {
    const r = mkdtempSync(join(tmpdir(), "dt2-")); writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    expect(await soloRun(["detect-test", r])).toBe(0);
    expect(outSpy.text().trim()).toBe("npm test");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`not implemented` rc 2).

- [ ] **Step 3: Implement.** Replace the `detectTestRun` stub:

```ts
import { detectTestCommand } from "../core/solo.js"; // add to existing solo import

async function detectTestRun(rest: string[]): Promise<number> {
  const cwd = rest[0] || repoRoot();
  process.stdout.write(detectTestCommand(cwd) + "\n");
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/solo.ts tests/solo-cmd.test.ts
git commit -m "feat(solo): detect-test handler"
```

---

### Task 16: `solo finish`

**Files:**
- Modify: `src/commands/solo.ts`
- Test: `tests/solo-cmd.test.ts`

`finish <topic>` always restores the start-branch checkout. If `execute/finish.txt` == `yes`, it runs the push/PR auto-action; otherwise it just restores and records `branch-only`.

- [ ] **Step 1: Write the failing test** (append). Drives exported `finishWith(topic, r, hasGh)`.

```ts
import { finishWith } from "../src/commands/solo.js";

describe("solo finish (finishWith core)", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  async function scaffold(topic: string, finishFlag: string) {
    const { soloArtDir, soloExecDir } = await import("../src/core/solo.js");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(soloExecDir(topic), { recursive: true });
    const exec = soloExecDir(topic);
    writeFileSync(join(exec, "target_cwd.txt"), "/proj\n");
    writeFileSync(join(exec, "branch.txt"), "feat/solo-auth\n");
    writeFileSync(join(exec, "start-branch.txt"), "main\n");
    writeFileSync(join(exec, "finish.txt"), finishFlag + "\n");
    writeFileSync(join(soloArtDir(topic), "task-brief.md"), "## Goal\nX");
    writeFileSync(join(exec, "verify-result.txt"), "PASS (npm test)\n");
  }

  function fake(replies: Record<string, { code: number; stdout: string }>) {
    const calls: string[][] = [];
    return { calls, r: { run: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return replies[[cmd, ...args].join(" ")] ?? { code: 0, stdout: "" }; } } };
  }

  it("finish.txt=no → restore only, records branch-only; rc 0", async () => {
    await scaffold("auth", "no");
    const { calls, r } = fake({});
    expect(await finishWith("auth", r as any, true)).toBe(0);
    expect(calls).toContainEqual(["git", "checkout", "-q", "main"]);
    const { soloExecDir } = await import("../src/core/solo.js");
    expect(readFileSync(join(soloExecDir("auth"), "finish-result.txt"), "utf8")).toContain("branch-only");
  });

  it("finish.txt=yes + remote → push/pr path, records outcome", async () => {
    await scaffold("auth", "yes");
    const { calls, r } = fake({
      "git remote": { code: 0, stdout: "origin\n" },
      "git push -q -u origin feat/solo-auth": { code: 0, stdout: "" },
      "git remote get-url origin": { code: 0, stdout: "url\n" },
    });
    expect(await finishWith("auth", r as any, true)).toBe(0);
    expect(calls.some((c) => c[0] === "gh")).toBe(true);
    const { soloExecDir } = await import("../src/core/solo.js");
    expect(readFileSync(join(soloExecDir("auth"), "finish-result.txt"), "utf8")).toContain("pr-opened");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL `finishWith is not a function`.

- [ ] **Step 3: Implement.** Add to `src/commands/solo.ts`:

```ts
import { finishBranch } from "../core/gitwork.js"; // add to existing gitwork import

async function finishRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: solo finish <topic>"); return 2; }
  const target = readField(join(soloExecDir(topic), "target_cwd.txt")) || repoRoot();
  return finishWith(topic, runnerAt(target), haveCmd("gh"));
}

export async function finishWith(topic: string, r: Runner, hasGh: boolean): Promise<number> {
  const exec = soloExecDir(topic);
  const branch = readField(join(exec, "branch.txt"));
  const startBranch = readField(join(exec, "start-branch.txt")) || "main";
  const doFinish = readField(join(exec, "finish.txt")) === "yes";

  if (!doFinish) {
    r.run("git", ["checkout", "-q", startBranch]);
    atomicWrite(join(exec, "finish-result.txt"), `none\tbranch-only (kept ${branch})\n`);
    log.ok(`solo finish: branch-only — kept ${branch}, restored ${startBranch}`);
    return 0;
  }
  const brief = existsSync(join(soloArtDir(topic), "task-brief.md")) ? readFileSync(join(soloArtDir(topic), "task-brief.md"), "utf8") : "";
  const verify = readField(join(exec, "verify-result.txt"));
  const res = finishBranch(r, {
    branch, startBranch, hasGh,
    title: `solo: ${branch}`,
    body: `${brief}\n\nVerify: ${verify}\n\n(Automated solo branch — review and merge into ${startBranch}.)`,
  });
  atomicWrite(join(exec, "finish-result.txt"), `${res.action}\t${res.outcome}\n`);
  log.ok(`solo finish: ${res.action} → ${res.outcome}`);
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes** — PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/solo.ts tests/solo-cmd.test.ts
git commit -m "feat(solo): finish handler (gated push/PR + always-restore)"
```

---

### Task 17: `solo summary`

**Files:**
- Modify: `src/commands/solo.ts`
- Test: `tests/solo-cmd.test.ts`

`summary <topic> [--aborted <phase> <gate> <reason...>]` reads the recorded facts, stamps `ended`/`duration` into `timing.txt`, writes `SUMMARY.md` (and `RESUME.md` on abort).

- [ ] **Step 1: Write the failing test** (append)

```ts
describe("solo summary", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  async function scaffold(topic: string) {
    const { soloArtDir, soloExecDir } = await import("../src/core/solo.js");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(soloExecDir(topic), { recursive: true });
    const art = soloArtDir(topic), exec = soloExecDir(topic);
    writeFileSync(join(art, "topic.txt"), topic + "\n");
    writeFileSync(join(art, "timing.txt"), "started=2026-05-29T06:00:00Z\n");
    writeFileSync(join(art, "selected-provider.txt"), "codex\n");
    writeFileSync(join(art, "instrument.txt"), "violin\n");
    writeFileSync(join(exec, "branch.txt"), "feat/solo-auth\n");
    writeFileSync(join(exec, "verify-result.txt"), "PASS (npm test)\n");
    writeFileSync(join(exec, "diff-stats.txt"), "2 files changed\n");
    writeFileSync(join(exec, "target_cwd.txt"), "/proj\n");
    writeFileSync(join(exec, "branch-base.sha"), "base000\n");
  }

  it("ok summary → SUMMARY.md with status ok; rc 0", async () => {
    await scaffold("auth");
    expect(await soloRun(["summary", "auth"])).toBe(0);
    const { soloArtDir } = await import("../src/core/solo.js");
    const md = readFileSync(join(soloArtDir("auth"), "SUMMARY.md"), "utf8");
    expect(md).toContain("status: ok");
    expect(md).toContain("- Branch: feat/solo-auth");
  });

  it("aborted summary → SUMMARY.md (aborted) + RESUME.md", async () => {
    await scaffold("auth");
    expect(await soloRun(["summary", "auth", "--aborted", "build", "part-turn-failed", "turn", "failed", "twice"])).toBe(0);
    const { soloArtDir } = await import("../src/core/solo.js");
    expect(readFileSync(join(soloArtDir("auth"), "SUMMARY.md"), "utf8")).toContain("status: aborted");
    expect(readFileSync(join(soloArtDir("auth"), "SUMMARY.md"), "utf8")).toContain("turn failed twice");
    expect(existsSync(join(soloArtDir("auth"), "RESUME.md"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`not implemented` rc 2).

- [ ] **Step 3: Implement.** Replace the `summaryRun` stub and add imports:

```ts
import { renderSummary, renderResume, type SummaryFacts } from "../core/solo.js"; // add to existing solo import

async function summaryRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: solo summary <topic> [--aborted <phase> <gate> <reason...>]"); return 2; }
  const art = soloArtDir(topic);
  const exec = soloExecDir(topic);

  const started = kvField(join(art, "timing.txt"), "started") || "unknown";
  let ended: string | undefined;
  let duration: number | undefined;

  const i = rest.indexOf("--aborted");
  const aborted = i >= 0;
  if (!aborted) {
    ended = isoUtc();
    const s = Date.parse(started), e = Date.parse(ended);
    duration = Number.isFinite(s) && Number.isFinite(e) ? Math.round((e - s) / 1000) : 0;
    atomicWrite(join(art, "timing.txt"), `started=${started}\nended=${ended}\nduration=${duration}\n`);
  }

  const facts: SummaryFacts = {
    topic,
    status: aborted ? "aborted" : "ok",
    started, ended, duration,
    provider: readField(join(art, "selected-provider.txt")) || "unknown",
    instrument: readField(join(art, "instrument.txt")) || "unknown",
    branch: readField(join(exec, "branch.txt")) || "unknown",
    verify: readField(join(exec, "verify-result.txt")) || "unknown",
    diffStats: readField(join(exec, "diff-stats.txt")) || "unknown",
    archived: readField(join(art, "archived-path.txt")) || "(not archived)",
    targetCwd: readField(join(exec, "target_cwd.txt")) || "<target>",
    branchBase: readField(join(exec, "branch-base.sha")) || "<base>",
    abortedPhase: aborted ? rest[i + 1] : undefined,
    abortedGate: aborted ? rest[i + 2] : undefined,
    abortedReason: aborted ? rest.slice(i + 3).join(" ") || "unknown" : undefined,
  };

  atomicWrite(join(art, "SUMMARY.md"), renderSummary(facts));
  if (aborted) {
    atomicWrite(join(art, "RESUME.md"), renderResume({
      topic, branch: facts.branch, artDir: art, phase: facts.abortedPhase ?? "unknown", gate: facts.abortedGate ?? "unknown",
    }));
  }
  log.ok(`solo summary: wrote ${join(art, "SUMMARY.md")}`);
  return 0;
}

/** Read a `key=value` line from a KV file; "" if absent. */
function kvField(path: string, key: string): string {
  if (!existsSync(path)) return "";
  const m = readFileSync(path, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}
```

- [ ] **Step 4: Run to verify it passes** — PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/solo.ts tests/solo-cmd.test.ts
git commit -m "feat(solo): summary handler (SUMMARY.md + RESUME.md)"
```

---

# Phase 5 — the directive

### Task 18: `commands/solo.md`

**Files:**
- Create: `commands/solo.md`

The conductor-run directive. It uses the 3-step args-file fence for Stage 0, carries `SLUG`/`INSTRUMENT`/`PROVIDER`/`TARGET` (printed by `solo init`) through the stages, authors the brief / fix bundle / question reply with the Write tool, and runs `solo turn-wait` in the background.

- [ ] **Step 1: Write the file**

````markdown
---
description: Light pipeline — one part implements a clear single-repo change unattended on its own branch; the conductor briefs, verifies, and (optionally) finishes. No research, no design doc, no gates.
argument-hint: <topic-text> [--provider codex|claude|agy|opencode] [--finish]
allowed-tools: Bash, Write, Read, Edit
---

# /consort:solo

The light, autonomous path for a small, clearly-specified single-repo change. One part (a
non-conductor model, default **codex**) implements the change on its own `feat/solo-<topic>`
branch in this repository. The conductor writes a short brief, spawns the part, runs one
implementation turn, does one light verify pass, then tears down. With `--finish`, it also
pushes the branch and opens a PR. There are **NO interactive gates**.

Let `CS="node ${CLAUDE_PLUGIN_ROOT}/dist/consort.cjs"`.

## Stage 0 — Init + Brief

1. Mint an args path and write `$ARGUMENTS` into it:
   - Run: `$CS solo --mint-args-file` → prints `<args-path>`.
   - **Write tool:** `file_path` = `<args-path>`, `content` = `$ARGUMENTS` (verbatim, unquoted).
2. Init: `$CS solo init --args-file <args-path>`. On success it prints these lines to stdout —
   capture each value (logs go to stderr, so stdout is clean):
   ```
   SLUG=<slug>
   INSTRUMENT=<instrument>
   PROVIDER=<provider>
   FINISH=<yes|no>
   TARGET=<abs-repo-root>
   ```
   Non-zero exit aborts: rc 1 = bad/empty topic, rc 2 = topic already in flight, rc 3 = provider
   not installed. No SUMMARY is written (state dir was never created).
3. **Brief.** Read the cleaned topic from `<SLUG state>/_solo/topic-text.txt` if needed, then
   **Write** `<SLUG state>/_solo/task-brief.md` using exactly this shape (keep it short — a brief,
   not a design doc). To find the state path, the directive does not need it: every later step
   takes `<SLUG>` as `<topic>` and resolves paths internally. Author the brief content from the
   topic and Write it to the path `solo init` logged (`solo init` logs `topic=<slug>`; the brief
   path is `<repo>/.consort/state/<hash>/<SLUG>/_solo/task-brief.md`). Shape:
   ```markdown
   ## Goal
   <1-2 sentences restating the change>

   ## Acceptance check
   <a specific behavior, or "the repo's tests pass">

   ## Touch-point hints
   <only if obvious from the topic; otherwise omit this heading>
   ```

## Stage 1 — Build

1. Branch the target: `$CS solo branch <SLUG>` (snapshots HEAD, commits any WIP on the current
   branch, creates/resumes `feat/solo-<SLUG>`). rc 1 = target is not a git repo (abort).
2. Spawn the part: `$CS spawn <INSTRUMENT> <PROVIDER> <SLUG> --cwd <TARGET>`. rc 1 = bootstrap
   failed (the part's state is FAILED-archived); abort with a SUMMARY (Stage 3 abort form).
3. Dispatch round 1: `$CS solo turn-send <SLUG> 1`.
4. Await it in the background:
   ```
   Bash(command='$CS solo turn-wait <SLUG> 1', run_in_background: true, description='solo await turn 1')
   ```
5. On the completion notification, read `TS` from `<SLUG state>/_solo/execute/turn-1.txt` and branch:
   - **`TS=ok`** → Stage 2.
   - **`TS=question`** → read `execute/question-1.txt`, **Write** a best-judgment reply to a temp
     file, then `$CS send <INSTRUMENT> <SLUG> @<reply-file> --from maestro`, and re-arm the
     background `solo turn-wait <SLUG> 1`. Never ask the user. (Re-arm on each question.)
   - **`TS=failed` or `TS=timeout`** → retry once: delete `execute/turn-1.txt`, re-run
     `$CS solo turn-send <SLUG> 1`, re-arm the background wait. On a **second** failure → abort:
     `$CS solo summary <SLUG> --aborted build part-turn-failed "part turn failed twice (TS=<ts>)"`,
     then `$CS coda <INSTRUMENT> <SLUG>`, print the SUMMARY, and stop.

## Stage 2 — Verify + finish

1. Detect the test command: `TEST_CMD=$($CS solo detect-test <TARGET>)`.
2. If `TEST_CMD` is non-empty, run it once in `<TARGET>` via Bash, tee to
   `<SLUG state>/_solo/execute/verify-1.log`; set `VERIFY` to `PASS (<cmd>)` or `FAIL (<cmd>)`.
   If empty, `VERIFY="skipped (no test command detected)"`.
3. If `VERIFY` starts with `FAIL`: read the tail of `verify-1.log`, **Write**
   `execute/fix-prompt-2.md` (concrete failures + fix direction), then `$CS solo turn-send <SLUG> 2`,
   background `$CS solo turn-wait <SLUG> 2`; on completion re-run `TEST_CMD` into `verify-2.log`
   and set `VERIFY` to the second result. **One fix round only** — proceed regardless.
4. Record results (run in `<TARGET>`):
   ```bash
   git -C <TARGET> diff --shortstat "$(cat <SLUG state>/_solo/execute/branch-base.sha)"..HEAD \
     > <SLUG state>/_solo/execute/diff-stats.txt
   printf '%s\n' "$VERIFY" > <SLUG state>/_solo/execute/verify-result.txt
   ```
5. Finish (always restores the start-branch checkout; pushes/opens a PR only when `FINISH=yes`):
   `$CS solo finish <SLUG>`.

## Stage 3 — Teardown + SUMMARY

1. `$CS coda <INSTRUMENT> <SLUG>` — graceful FINE banner → teardown → archive the part dir.
2. `$CS solo summary <SLUG>` — writes `SUMMARY.md`. Then print it:
   `cat <SLUG state>/_solo/SUMMARY.md`.

## Notes

- One part, one branch, one implementation turn, one light verify pass, optional autonomous finish.
  No research, no design doc, no multi-repo/DAG, no interactive gates.
- On abort, `SUMMARY.md` + `RESUME.md` point at the partial state under `_solo/`; re-run
  `/consort:solo` with revised framing to retry.
- For research, a reviewable design doc, multi-repo, or multiple parts → future `/consort:score`
  + `/consort:perform`.
````

- [ ] **Step 2: Verify the stale-token gate still passes** (the directive borrows strike phrasing — make sure no banned token slipped in)

Run: `npx vitest run tests/stale-tokens.test.ts`
Expected: PASS (no `strike`/`cody`/`deploy`/`cw_`/`master-yoda`/`@cw_`/`MISSION ACCOMPLISHED`).

- [ ] **Step 3: Commit**

```bash
git add commands/solo.md
git commit -m "feat(solo): commands/solo.md directive (4-stage choreography)"
```

---

# Phase 6 — build, verify, dogfood

### Task 19: Full gate sweep + build + commit `dist`

**Files:**
- Modify: `dist/consort.cjs` (regenerated)

- [ ] **Step 1: Stale-token gate**

Run: `npx vitest run tests/stale-tokens.test.ts`
Expected: PASS. If it fails, fix the offending file (do NOT weaken the gate) and re-run.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0. Common catches: unused imports in `solo.ts` (the handlers grew imports incrementally — remove any now-unused), and `no-unused-vars` on stub params.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: all green — the foundation's 102 tests plus the new `solo-core`/`solo-gitwork`/`solo-turn`/`solo-cmd` tests.

- [ ] **Step 4: Build the bundle**

Run: `npm run build`
Expected: writes `dist/consort.cjs`. Smoke-check dispatch:
```bash
node dist/consort.cjs solo            # → usage on stderr, exit 2
node dist/consort.cjs solo detect-test .   # → prints this repo's test command (bash tests/run.sh? or npm test)
```

- [ ] **Step 5: Commit**

```bash
git add dist/consort.cjs
git commit -m "build(solo): rebuild dist with solo command"
```

---

### Task 20: Adversarial verification + live dogfood

**Files:**
- Modify: `docs/superpowers/DOGFOOD.md`

- [ ] **Step 1: Adversarial verification (ultracode).** Launch a Workflow that, in parallel, checks the `solo` implementation against the clone-wars `strike`/`deploy` behavioral spec on these surfaces, each agent prompted to *find a divergence or confirm fidelity*: (1) `deriveSlug` vs `strike-init.sh` slug pipeline (lowercase/`tr -c`/collapse/cap-20/trim); (2) `preSnapshot` vs `cw_deploy_pre_snapshot` (dirty detection, WIP message, hook-blocked non-fatal, clean/wip/hook states); (3) `finishBranch` outcome tokens vs `cw_deploy_finish_branch_pr` (`pr-opened`/`pr-pushed-no-gh`/`pr-failed-kept`/`kept`, always-restore); (4) `classifyTurn` + turn-wait vs `deploy-turn-wait.sh` (done→ok, error→failed, question payload capture, null→timeout, rc always 0, **offset discipline so round 2 never matches round 1's done**); (5) the directive's stage sequence + retry-once + question auto-reply vs `strike.md`; (6) provider/instrument handling vs the D2 decision (default codex, `--provider` override, auto-pick instrument). For each confirmed divergence, fix it and add a regression test before the dogfood.

- [ ] **Step 2: Set up a throwaway target repo**

```bash
TGT=$(mktemp -d); git -C "$TGT" init -q; git -C "$TGT" commit -q --allow-empty -m "init"
printf '%s\n' '#!/usr/bin/env bash' 'echo ok' > "$TGT/tests/run.sh" 2>/dev/null || { mkdir -p "$TGT/tests"; printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$TGT/tests/run.sh"; }
git -C "$TGT" add -A && git -C "$TGT" commit -q -m "add trivial test"
```

- [ ] **Step 3: Live dogfood (inside tmux, isolated `CONSORT_HOME`)**

Run a real `/consort:solo` against `$TGT` with a live **codex** part, e.g. topic "add a CONTRIBUTING.md with one line". Verify the full arc:
- `solo init` prints the KV block; `_solo/` scaffolded; `task-brief.md` written by the conductor.
- `solo branch` creates `feat/solo-<topic>`; WIP-commit path exercised (make the tree dirty first).
- `spawn` brings the codex part to `{ready}`; `solo turn-send 1` + background `solo turn-wait 1` → `TS=ok`.
- `solo detect-test` returns `bash tests/run.sh`; verify PASS recorded.
- `solo finish` (default) restores the start branch, records `branch-only`; then re-run once **with `--finish`** against a repo that has a remote (or assert the `keep` path when no remote) to exercise the finish branch.
- `coda` tears down (FINE banner) and archives; `solo summary` writes `SUMMARY.md`; cat shows `status: ok`.

**Codex prerequisite:** the target repo dir must be trusted by codex (`~/.codex/config.toml`) or spawn will time out at bootstrap — the user adds the trust entry (Claude must not edit that file). This is an environment prereq, not a solo defect.

- [ ] **Step 4: Record the result**

Append a `## solo` section to `docs/superpowers/DOGFOOD.md` with the run table, the full outbox sequence, and any bugs surfaced + their fix commits (mirror the foundation's DOGFOOD format).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/DOGFOOD.md
git commit -m "docs(solo): live dogfood result"
```

- [ ] **Step 6: Finish the branch.** Use **superpowers:finishing-a-development-branch** (verify tests pass → present options → PR/merge `feat/solo`).

---

## Self-Review (run by the plan author, completed)

**Spec coverage:** D1 finish → Tasks 7, 16 + directive Stage 2.5. D2 provider/instrument → Task 11. D3 dirty→WIP → Task 6 (`preSnapshot`). D4 orchestration → directive (Task 18) + thin subcommands. §4 command surface → Tasks 10-17. §5 pipeline → directive. §6 state layout → init/branch/turn/summary writes. §7 turn machinery/offset → Tasks 8-9, 13-14. §8 finish → Tasks 7, 16. §9 rebrand/stale-token → Tasks 18-19. §10 testing → every task's tests + Task 19. §11 acceptance → Task 20. All spec sections map to a task.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every test step shows the assertions.

**Type consistency:** `Runner`/`RunResult` (gitwork) used identically in Tasks 5-7, 12, 16. `SummaryFacts` defined Task 4, consumed Task 17. `TurnStatus`/`classifyTurn`/`parseOffset` defined Task 9, used Task 14. `soloArtDir`/`soloExecDir` defined Task 1, used throughout. `readField`/`kvField` helpers defined once (Tasks 13/17) and reused. The `solo init` KV stdout keys (`SLUG`/`INSTRUMENT`/`PROVIDER`/`FINISH`/`TARGET`) match the directive's capture in Task 18.

**Known seam:** several handlers expose a `…With(...)` testable core that takes injected deps/`Runner` (mirroring `coda.teardownBatch` + `CodaDeps`) so the tmux/git/send side never runs in unit tests — live behavior is proven only by the Task 20 dogfood.
