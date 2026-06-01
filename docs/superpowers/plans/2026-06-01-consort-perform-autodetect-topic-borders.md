# perform: test-command auto-detect, topic-length guard, pane-border hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/consort:perform` auto-detect the part's test command (instead of hardcoding `bash tests/run.sh`), validate topic length at init (restoring a dropped clone-wars guard), and harden `ensurePaneBorders` so a window-local `pane-border-status off` can't suppress part-pane labels.

**Architecture:** Three independent code areas in the perform/spawn surface. Pure helpers get unit tests; integration-shaped wiring is covered by the full suite acting as a gate plus the live dogfood. tmux is tested only as pure arg-array builders — never spawn real panes in unit tests. `dist/consort.cjs` is rebuilt and committed in the final task.

**Tech Stack:** TypeScript (NodeNext, `.js` import suffixes), esbuild → committed `dist/consort.cjs`, vitest, eslint. Test isolation via `CONSORT_HOME` temp dir (`tests/helpers/tmpHome.ts`).

**Spec:** `docs/superpowers/specs/2026-06-01-consort-perform-autodetect-topic-borders-design.md`

---

## Task 1: Auto-detect test command in perform's single-repo prompts

**Files:**
- Modify: `src/core/performTurn.ts` (BLOCKERS const → `blockers()`; `composeRound1Prompt` + `composeFixPrompt` signatures + bodies)
- Modify: `src/commands/perform.ts:174-192` (`turnSendWith` — detect + thread)
- Test: `tests/performTurn.test.ts` (add cases; create if absent)

- [ ] **Step 1: Write failing tests**

Add to `tests/performTurn.test.ts` (import the existing symbols as the file already does; add `blockers` to the import if the file imports named symbols from `../src/core/performTurn.js`):

```ts
import { describe, it, expect } from "vitest";
import { composeRound1Prompt, composeFixPrompt, blockers } from "../src/core/performTurn.js";

describe("perform test-command auto-detect", () => {
  it("round-1 prompt names the detected command and drops the hardcoded one", () => {
    const p = composeRound1Prompt({ designPath: "/a/design.md", planPath: "/a/plan.md", verifyPath: "/a/verify-report-1.md", round: 1, testCmd: "npm test" });
    expect(p).toContain("npm test");
    expect(p).not.toContain("bash tests/run.sh");
  });
  it("round-1 prompt falls back to generic wording when no command detected", () => {
    const p = composeRound1Prompt({ designPath: "/a/design.md", planPath: "/a/plan.md", verifyPath: "/a/verify-report-1.md", round: 1, testCmd: "" });
    expect(p).toContain("the repository's full test suite");
    expect(p).not.toContain("bash tests/run.sh");
    expect(p).not.toContain("()"); // no empty backtick command artifact
  });
  it("fix prompt names the detected command via blockers", () => {
    const p = composeFixPrompt(2, "ISSUE", "/a/verify-report-2.md", "make test");
    expect(p).toContain("make test");
    expect(p).not.toContain("bash tests/run.sh");
  });
  it("blockers() switches command vs generic on testCmd", () => {
    expect(blockers("pytest")).toContain("Running 'pytest' is your job");
    expect(blockers("")).toContain("Running your repository's test suite is your job");
    expect(blockers("")).not.toContain("bash tests/run.sh");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- performTurn`
Expected: FAIL — `blockers` not exported; `composeRound1Prompt`/`composeFixPrompt` reject the new arg / still emit `bash tests/run.sh`.

- [ ] **Step 3: Implement in `src/core/performTurn.ts`**

Replace the `BLOCKERS` const (lines 32-46) with a function:

```ts
function blockers(testCmd: string): string {
  const suiteLine = testCmd
    ? `  is NOT for running your test suite. Running '${testCmd}' is\n  your job. Banned values fail with rc=2.\n`
    : "  is NOT for running your test suite. Running your repository's test suite is\n  your job. Banned values fail with rc=2.\n";
  return (
    "BLOCKERS / QUESTIONS (read carefully):\n" +
    "- If a referenced path, file, checkpoint, git ref, env var, or\n" +
    "  command is NOT where the notes say it is, DO NOT search the\n" +
    "  filesystem yourself, DO NOT invent a workaround. Halt and ask by\n" +
    "  appending ONE question event to your outbox.jsonl, then stop:\n" +
    '    {"event":"question","message":"<why you are asking>",' +
    '"claim":{"kind":"<path|git|env|cmd|test>","value":"<the value to check>"},"ts":"<iso>"}\n' +
    '  Omit the "claim" object for a judgment question (no ground-truth to check).\n' +
    "- The Maestro verifies the claim and replies via your inbox.md, then re-engages you.\n" +
    "- After reading any inbox.md reply, acknowledge by appending an ack event:\n" +
    '    {"event":"ack","task_summary":"<what you read>","ts":"<iso>"}\n' +
    "- The 'test' kind runs a diagnostic command under a 30s timeout — it\n" +
    suiteLine
  );
}
export { blockers };
```

In `composeRound1Prompt`, add `testCmd: string` to the args type and use it. Change the signature line:

```ts
export function composeRound1Prompt(args: { designPath: string; planPath: string; verifyPath: string; round?: number; testCmd: string }): string {
  const { designPath, planPath, verifyPath, testCmd } = args;
```

Replace PHASE 2's hardcoded line (was line 79) with a command-aware line:

```ts
    "PHASE 2: Implement",
    `  Use the superpowers:subagent-driven-development skill. Walk ${planPath}`,
    "  task-by-task. Commit per task (Conventional Commits prefix). Run",
    testCmd
      ? `  the full test suite (\`${testCmd}\`) after each task and confirm green.`
      : "  the repository's full test suite after each task and confirm green.",
```

Replace the trailing `BLOCKERS,` in `composeRound1Prompt`'s array with `blockers(testCmd),`.

In `composeFixPrompt`, add `testCmd` as a 4th param and use `blockers(testCmd)`:

```ts
export function composeFixPrompt(round: number, bundleText: string, verifyPath: string, testCmd: string): string {
```

Replace the trailing `BLOCKERS,` in `composeFixPrompt`'s array with `blockers(testCmd),`.

- [ ] **Step 4: Thread detection in `src/commands/perform.ts`**

Add to the `solo` import (there is no existing solo import — add a new import near line 32):

```ts
import { detectTestCommand } from "../core/solo.js";
```

In `turnSendWith` (lines 174-192), after `const model = partModel(art);` (line 177), compute the command:

```ts
  const targetCwd = existsSync(join(art, "target_cwd.txt")) ? readFileSync(join(art, "target_cwd.txt"), "utf8").trim() : "";
  const testCmd = targetCwd ? detectTestCommand(targetCwd) : "";
```

Update the two compose calls (lines 185-186):

```ts
  if (round === 1) atomicWrite(promptFile, composeRound1Prompt({ designPath: join(art, "design.md"), planPath: join(art, "plan.md"), verifyPath: join(art, "verify-report-1.md"), round, testCmd }));
  else { const bundle = join(art, `fix-prompt-${round}.md`); if (!existsSync(bundle)) { log.error(`perform turn-send: fix-prompt-${round}.md not found at ${bundle}; the directive must write it first`); return 1; } atomicWrite(promptFile, composeFixPrompt(round, readFileSync(bundle, "utf8"), join(art, `verify-report-${round}.md`), testCmd)); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- performTurn && npm run typecheck`
Expected: PASS; typecheck clean (any other call sites of `composeRound1Prompt`/`composeFixPrompt` must now pass `testCmd` — grep `composeRound1Prompt\|composeFixPrompt` across `src` and `tests` and fix every call, e.g. existing tests must pass `testCmd: "..."` / a 4th arg).

- [ ] **Step 6: Commit**

```bash
git add src/core/performTurn.ts src/commands/perform.ts tests/performTurn.test.ts
git commit -m "feat(perform): auto-detect the part's test command (single-repo prompts)"
```

---

## Task 2: Validate topic length at perform init (parity restore)

**Files:**
- Modify: `src/core/perform.ts:24-31` (add `assertPerformTopic`)
- Modify: `src/commands/perform.ts:125-163` (`initWith` guard) + `:645` (wave-wait reuse)
- Test: `tests/perform.test.ts` (or the core-perform test file; add cases)

- [ ] **Step 1: Write failing tests**

Add (adjust import path to the existing core-perform test file; if none, create `tests/performTopic.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { assertPerformTopic } from "../src/core/perform.js";

describe("assertPerformTopic", () => {
  it("accepts valid slugs up to 32 chars", () => {
    expect(assertPerformTopic("iris-code-simplify")).toBe(true);
    expect(assertPerformTopic("a".repeat(32))).toBe(true);
    expect(assertPerformTopic("x1")).toBe(true);
  });
  it("rejects over-length, malformed, and empty slugs", () => {
    expect(assertPerformTopic("iris-code-simplify-sweep-2-tiers-bce")).toBe(false); // 36 chars
    expect(assertPerformTopic("a".repeat(33))).toBe(false);
    expect(assertPerformTopic("")).toBe(false);
    expect(assertPerformTopic("-leading")).toBe(false);
    expect(assertPerformTopic("Bad_Topic")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- performTopic` (or the chosen file)
Expected: FAIL — `assertPerformTopic` is not exported.

- [ ] **Step 3: Add the helper in `src/core/perform.ts`**

Immediately after `deriveTopicFromPath` (after line 31):

```ts
/** Topic-slug guard (port of the predecessor plugin's deploy topic assertion; same shape as
 *  spawn's 32-char cap). True iff `topic` matches ^[a-z0-9][a-z0-9-]{0,31}$ (1-32 chars, kebab,
 *  no leading dash). */
export function assertPerformTopic(topic: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(topic);
}
```

**Stale-token gate:** the docstring above must NOT contain `clone-wars` or `cw_` — `src/core/perform.ts` is scanned by `tests/stale-tokens.test.ts`. Use "the predecessor plugin" wording as shown.

- [ ] **Step 4: Wire the guard in `src/commands/perform.ts`**

Add `assertPerformTopic` to the existing `../core/perform.js` import block (lines 11-14).

In `initWith`, immediately after the empty-topic check (line 133), add:

```ts
  if (!assertPerformTopic(topic)) { log.error(`perform init: invalid topic slug '${topic}' (must match ^[a-z0-9][a-z0-9-]{0,31}$, <= 32 chars; pass a shorter --topic)`); return 2; }
```

In `waveWaitRun` (line 645), replace the inline topic regex with the helper (leave the
instrument/provider checks intact):

```ts
  if (!assertPerformTopic(topic) || !/^[a-z0-9_-]+$/.test(instrument) || !/^[a-z0-9_-]+$/.test(provider)) { log.error("perform wave-wait: bad topic/instrument/provider"); return 2; }
```

- [ ] **Step 5: Write the init-rejects-early integration test**

Add to `tests/perform.test.ts` (use the `tmpHome` helper pattern already in the suite; the key
assertion is rc 2 and that no art dir is created). Minimal shape:

```ts
import { initWith } from "../src/commands/perform.js";
// ... within a describe that sets CONSORT_HOME to a fresh temp dir and writes a design doc:
it("init rejects an over-length --topic with rc 2 and scaffolds nothing", async () => {
  const rc = await initWith(["--topic", "iris-code-simplify-sweep-2-tiers-bce", designPath], { repoRoot: () => repoRootStub });
  expect(rc).toBe(2);
  // no _perform art dir was created for the bad topic
});
```

(If wiring a full design-doc fixture is heavy, the `assertPerformTopic` unit test in Step 1 is the
load-bearing coverage; keep this integration test only if the suite already has an `initWith`
harness to copy. Do not invent a brittle fixture.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test -- performTopic perform && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/perform.ts src/commands/perform.ts tests/
git commit -m "fix(perform): validate topic length at init (restore dropped clone-wars guard)"
```

---

## Task 3: Harden ensurePaneBorders (window-scoped status + visible failure)

**Files:**
- Modify: `src/core/tmux.ts` (`ensurePaneBorders` return; new `windowBorderStatusArgs` + `ensureWindowBorderStatus`; `preflightLayout`)
- Modify: `src/commands/spawn.ts:43,~91` (warn on border failure; force status on the spawn window)
- Test: `tests/tmux.test.ts` (add `windowBorderStatusArgs` case)

- [ ] **Step 1: Write the failing test**

Add to `tests/tmux.test.ts`:

```ts
import { windowBorderStatusArgs } from "../src/core/tmux.js";

it("windowBorderStatusArgs sets pane-border-status top on the target window", () => {
  expect(windowBorderStatusArgs("%5")).toEqual(["set-option", "-w", "-t", "%5", "pane-border-status", "top"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tmux`
Expected: FAIL — `windowBorderStatusArgs` not exported.

- [ ] **Step 3: Implement in `src/core/tmux.ts`**

Add the pure builder near `paneBorderArgs` (after line 49):

```ts
/** Force pane-border-status on a specific window (by pane or window id) so a window-local
 *  `pane-border-status off` can't suppress the @cs_ part label that paneLabelSet stamped. */
export function windowBorderStatusArgs(target: string): string[] {
  return ["set-option", "-w", "-t", target, "pane-border-status", "top"];
}
```

Change `ensurePaneBorders` (lines 76-78) to report success, still tolerant:

```ts
export async function ensurePaneBorders(): Promise<boolean> {
  let ok = true;
  for (const a of paneBorderArgs()) { try { await tmux(a); } catch { ok = false; } }
  return ok;
}
```

Add the live wrapper (after `ensurePaneBorders`):

```ts
/** Set pane-border-status top on `target`'s window; false on tmux error (never throws). */
export async function ensureWindowBorderStatus(target: string): Promise<boolean> {
  try { await tmux(windowBorderStatusArgs(target)); return true; } catch { return false; }
}
```

In `preflightLayout`, after the split loop and `selectLayoutMainVertical(conductor)`
(after line 169), force the status on the conductor's window:

```ts
    await ensureWindowBorderStatus(conductor);
```

- [ ] **Step 4: Wire warnings in `src/commands/spawn.ts`**

Add `ensureWindowBorderStatus` to the `../core/tmux.js` import (line 12).

Replace line 43:

```ts
  if (!(await ensurePaneBorders())) log.warn("could not set pane-border globals; part labels may not render");
```

After the `if (targetPane) { … } else { … }` block resolves `pane` (immediately before
`paneMetaWrite(...)` at line 92), add:

```ts
    if (!(await ensureWindowBorderStatus(pane))) log.warn(`could not force pane-border-status on the spawn window; '${labelFor(instrument, model, topic)}' label may not render`);
```

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `npm test -- tmux && npm run typecheck && npm run lint`
Expected: PASS — `windowBorderStatusArgs` test green; `ensurePaneBorders`'s new `Promise<boolean>`
return type accepted at its sole call site (now used in spawn).

- [ ] **Step 6: Commit**

```bash
git add src/core/tmux.ts src/commands/spawn.ts tests/tmux.test.ts
git commit -m "fix(spawn): force pane-border-status on the spawn window + surface border failures"
```

---

## Task 4: Full gate, rebuild dist, final verification

**Files:**
- Modify: `dist/consort.cjs` (rebuilt)

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green, including `tests/stale-tokens.test.ts` (confirm no banned tokens —
`clone-wars`, `cw_`, `@cw_`, `master-yoda`, `MISSION ACCOMPLISHED`, `trooper`, `commander` —
crept into any new comment in `src`/`config`/`commands`/`hooks`/`.claude-plugin`).

- [ ] **Step 2: Rebuild dist**

Run: `npm run build`
Expected: `dist/consort.cjs` regenerated. Run `npm run build` a second time and confirm the file
is byte-stable (the bundle is deterministic).

- [ ] **Step 3: Sanity-check the bundled behavior**

Run a quick smoke against the new helpers through the bundle (no live tmux needed):

```bash
node -e "process.env.NODE_PATH=''" # noop guard
node dist/consort.cjs perform 2>&1 | head -1   # prints the perform usage line (rc 2) — confirms the bundle loads
```

Expected: the perform usage line prints (the dispatcher resolves; no module error).

- [ ] **Step 4: Commit dist**

```bash
git add dist/consort.cjs
git commit -m "build: rebuild dist for perform auto-detect + topic guard + border hardening"
```

---

## Self-Review notes (for the implementer)

- **Every call site:** after Task 1, grep `composeRound1Prompt` and `composeFixPrompt` across the
  whole repo (`src` + `tests`) — both signatures changed, so every caller (including pre-existing
  tests) must pass `testCmd`. Typecheck will catch misses; fix them in the same task.
- **No new banned tokens in comments** — the stale-token gate scans comments. The new
  `assertPerformTopic` docstring intentionally says "clone-wars" — that is in `src/core/perform.ts`
  which the gate **does** scan, so write it as "the predecessor plugin" or drop the name. (Verify
  against the gate; this has bitten prior implementers.)
- **Editor LSP false positives:** newly-added exports may show transient TS2305/2307 in the editor;
  `npm run typecheck` is authoritative.
- **dist policy:** Tasks 1-3 do NOT rebuild dist (vitest runs against `src`); only Task 4 rebuilds
  and commits it. A reviewer flagging "dist not rebuilt" during Tasks 1-3 is a false alarm.
