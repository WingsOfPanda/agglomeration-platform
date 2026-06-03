# rehearsal parity sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 8 confirmed issues from the rehearsal-vs-deep-research parity audit — one reliability seam, a degraded-spawn functional gap, a stale-file routing hazard, a timeout env-override contradiction, a consensus nit, and dropped DANGER/Security/Task-list/Intervention docs — shipping consort `0.1.11`.

**Architecture:** Five small, isolated `src/` changes (each in one function, with regression tests) + two prose tasks on `commands/rehearsal.md` (rebranded restorations) + a spec note + a release task. The frozen wire protocol is untouched; the stale-token gate stays green.

**Tech Stack:** TypeScript (Node/ESM), vitest, esbuild (committed bundle `dist/consort.cjs`).

**Spec:** `docs/superpowers/specs/2026-06-03-rehearsal-parity-sweep-design.md`

**Branch:** `feat/rehearsal-parity-sweep` (already created off `main`; the spec is already committed at `9a303be`).

---

### Task 1: A1 — single done-event contract in the experiment inbox (TDD)

**Files:**
- Modify: `src/core/ipc.ts:14-22` (`inboxWrite`)
- Modify: `src/commands/rehearsal.ts:~414` (the `inboxWrite(...)` call in `experiment-send`)
- Test: `tests/rehearsal-cmd.test.ts` (the experiment-send `describe` — the existing inbox test ~255-277 + one new case)

Context: `experiment-send` renders `experiment.md` (whose step 5 already specifies the exact done line `{"event":"done","summary":"experiment exp-NNN metric=<value> status=<status>",...}`) into `prompt.md`, then wraps it with the generic `inboxWrite`, which appends a SECOND `{"event":"done","summary":"<one-line summary>"}` instruction before `END_OF_INSTRUCTION`. The part then has two conflicting done contracts; the loop's Step 3 derives `exp-NNN` from the summary. Fix: let `inboxWrite` suppress its generic done block when the caller's body already owns the contract.

- [ ] **Step 1: Write the failing test additions**

In `tests/rehearsal-cmd.test.ts`, in the existing test `it("idle part -> rc 0: renders prompt.md, writes inbox + transitions state", ...)`, after the existing inbox assertions (the `expect(inbox).toContain("END_OF_INSTRUCTION");` line), add:

```ts
    // A1: the experiment template owns the SOLE done contract — no generic wrapper.
    expect(inbox).not.toContain("<one-line summary>");
    expect((inbox.match(/"event":"done"/g) ?? []).length).toBe(1);
    expect(inbox).toContain("experiment exp-001 metric=<value> status=<status>");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- tests/rehearsal-cmd.test.ts`
Expected: FAIL — current code appends the generic done block, so `<one-line summary>` IS present and `"event":"done"` appears TWICE.

- [ ] **Step 3: Implement the `inboxWrite` option**

In `src/core/ipc.ts`, replace `inboxWrite` (lines 14-22) with:

```ts
export function inboxWrite(i: string, m: string, t: string, task: string, opts?: { from?: string; noDoneInstruction?: boolean }): void {
  const from = opts?.from ?? "maestro";
  if (!SENDER_RE.test(from)) throw new Error(`inboxWrite: invalid sender name '${from}' (allowed: [a-zA-Z0-9_-])`);
  const outbox = outboxPath(i, m, t);
  // When the task body already specifies its own done-event contract (e.g. the rehearsal experiment
  // template's `summary="experiment exp-NNN metric=… status=…"`), the caller passes noDoneInstruction
  // to suppress this generic one — otherwise the part receives two conflicting done instructions and
  // the loop's exp-NNN derivation can read the wrong summary.
  const doneInstruction = opts?.noDoneInstruction
    ? ""
    : `When done, append a single JSONL line to ${outbox}:\n\n` +
      '`{"event":"done","summary":"<one-line summary>","ts":"<iso-timestamp>"}`\n\n';
  const body = `From: ${from}\n\n${task}\n\n${doneInstruction}END_OF_INSTRUCTION\n`;
  atomicWrite(inboxPath(i, m, t), body);
}
```

- [ ] **Step 4: Pass `noDoneInstruction` from experiment-send**

In `src/commands/rehearsal.ts`, find the experiment-send call (≈ line 414):

```ts
  inboxWrite(instrument, model, topic, prompt, { from: "maestro" });
```

Replace with:

```ts
  inboxWrite(instrument, model, topic, prompt, { from: "maestro", noDoneInstruction: true });
```

- [ ] **Step 5: Add a focused negative-case test**

In `tests/rehearsal-cmd.test.ts`, immediately after the test edited in Step 1, add:

```ts
  it("inbox carries exactly one done contract — the template's specific one, not the generic wrapper", async () => {
    const h = home();
    scaffold(h);
    await experimentSendWith([TOPIC, INST, "exp-001", "baseline", "a plain baseline"], deps(h));
    const inbox = readFileSync(inboxPath(INST, MODEL, TOPIC), "utf8");
    expect(inbox).toContain("END_OF_INSTRUCTION");
    expect(inbox).not.toContain("<one-line summary>");
    expect((inbox.match(/"event":"done"/g) ?? []).length).toBe(1);
  });
```

(`scaffold`, `home`, `deps`, `TOPIC`, `INST`, `MODEL`, `inboxPath`, `readFileSync` are already in scope in this file.)

- [ ] **Step 6: Run the tests + full gate**

Run: `npm run test -- tests/rehearsal-cmd.test.ts && npm run typecheck && npm run lint`
Expected: all green; `"event":"done"` now appears once, `<one-line summary>` absent.

- [ ] **Step 7: Commit**

```bash
git add src/core/ipc.ts src/commands/rehearsal.ts tests/rehearsal-cmd.test.ts
git commit -m "fix(rehearsal): single done-event contract in the experiment inbox

experiment-send rendered the experiment template (which already specifies
summary=\"experiment exp-NNN metric=… status=…\") then wrapped it with the
generic inboxWrite, appending a SECOND conflicting done instruction. The part
could follow the trailing generic one, breaking the loop's exp-NNN derivation.
inboxWrite gains noDoneInstruction; experiment-send uses it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: A2 — `drop-part` verb (prune parts.txt + kill the dropped preflight pane) (TDD)

**Files:**
- Modify: `src/commands/rehearsal.ts` (new `dropPartWith` + `DropPartDeps` + `liveDropPartDeps`; dispatch + usage)
- Test: `tests/rehearsal-cmd.test.ts` (new `describe("rehearsal drop-part", ...)`)

Context: On a Stage-2 partial spawn, the Phase-3 prose says "drop the failed instruments and continue," but nothing prunes `parts.txt` — `spawnAllWith` wrote the full roster up front, so Phase 4 seeds `state.txt` + a Monitor for a dead pane. `perform` already has `dropPartRun` (`src/commands/perform.ts:773-789`); this mirrors it for rehearsal's 1-col `parts.txt` and also best-effort kills the dropped instrument's preflight pane (`parsePanesFile` → `killNow`, exactly as `teardownWith` does at `rehearsal.ts:1246`).

- [ ] **Step 1: Write the failing tests**

In `tests/rehearsal-cmd.test.ts`, first ensure the import on line ~7-9 includes the new symbols. Add to an existing `import { ... } from "../src/commands/rehearsal.js";` line:

```ts
import { dropPartWith, type DropPartDeps } from "../src/commands/rehearsal.js";
```

Then add this `describe` block (near the other top-level `describe`s; `home`, `opts`, `rehearsalArtDir`, `mkdirSync`, `writeFileSync`, `readFileSync`, `join`, `TOPIC` are already in scope):

```ts
describe("rehearsal drop-part", () => {
  const noKill: DropPartDeps = { killPane: () => {} };
  it("prunes the named instrument from parts.txt and reports remaining N", async () => {
    const h = home();
    const art = rehearsalArtDir(TOPIC, opts(h));
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "parts.txt"), "rex\nkeeli\ncolt\n");
    expect(await dropPartWith([TOPIC, "keeli"], noKill, opts(h))).toBe(0);
    expect(readFileSync(join(art, "parts.txt"), "utf8")).toBe("rex\ncolt\n");
  });
  it("writes an empty parts.txt when the last instrument is dropped", async () => {
    const h = home();
    const art = rehearsalArtDir(TOPIC, opts(h));
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "parts.txt"), "rex\n");
    expect(await dropPartWith([TOPIC, "rex"], noKill, opts(h))).toBe(0);
    expect(readFileSync(join(art, "parts.txt"), "utf8")).toBe("");
  });
  it("rc 1 when parts.txt is missing", async () => {
    const h = home();
    expect(await dropPartWith([TOPIC, "rex"], noKill, opts(h))).toBe(1);
  });
  it("rc 1 when the instrument is not present", async () => {
    const h = home();
    const art = rehearsalArtDir(TOPIC, opts(h));
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "parts.txt"), "rex\n");
    expect(await dropPartWith([TOPIC, "ghost"], noKill, opts(h))).toBe(1);
  });
  it("rc 2 on bad usage", async () => {
    const h = home();
    expect(await dropPartWith([TOPIC], noKill, opts(h))).toBe(2);
  });
  it("best-effort kills the dropped instrument's preflight pane", async () => {
    const h = home();
    const art = rehearsalArtDir(TOPIC, opts(h));
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "parts.txt"), "rex\nkeeli\n");
    writeFileSync(join(art, "preflight-panes.txt"), "rex\t%5\nkeeli\t%6\n");
    const killed: string[] = [];
    await dropPartWith([TOPIC, "keeli"], { killPane: (p) => killed.push(p) }, opts(h));
    expect(killed).toEqual(["%6"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- tests/rehearsal-cmd.test.ts`
Expected: FAIL to compile/import — `dropPartWith` / `DropPartDeps` do not exist yet.

- [ ] **Step 3: Implement `dropPartWith`**

In `src/commands/rehearsal.ts`, add this function (place it after `spawnAllWith`, before the Phase-C experiment-send section ≈ line 233). `existsSync`, `readFileSync`, `join`, `atomicWrite`, `parsePanesFile`, `killNow`, `log`, `rehearsalArtDir`, `PathOpts` are already imported in this file:

```ts
export interface DropPartDeps { killPane(paneId: string): void; }
const liveDropPartDeps: DropPartDeps = { killPane: (p) => killNow(p) };

// ---- drop-part (Phase-3 degraded proceed) — prune parts.txt + kill the dropped part's preflight pane ----
// On a partial spawn the directive ships the rest: it drops a failed instrument by name so Phase 4's
// per-part loop (which iterates parts.txt verbatim) no longer seeds state + a Monitor for a dead pane.
// Mirrors perform's dropPartRun; rehearsal's parts.txt is 1-col (one instrument per line). Best-effort
// kills the dropped instrument's preflight pane so it does not linger until final teardown.
export async function dropPartWith(rest: string[], deps: DropPartDeps, opts?: PathOpts): Promise<number> {
  const [topic, instrument] = rest;
  if (!topic || !instrument || rest.length !== 2) { log.error("usage: rehearsal drop-part <topic> <instrument>"); return 2; }
  const art = rehearsalArtDir(topic, opts);
  const partsFile = join(art, "parts.txt");
  if (!existsSync(partsFile)) { log.error(`rehearsal drop-part: parts.txt missing`); return 1; }
  const kept: string[] = []; let dropped = false;
  for (const line of readFileSync(partsFile, "utf8").split("\n")) {
    if (line.length === 0) continue;
    if (line === instrument) { dropped = true; continue; }
    kept.push(line);
  }
  if (!dropped) { log.error(`rehearsal drop-part: no part for instrument=${instrument}`); return 1; }
  atomicWrite(partsFile, kept.length ? kept.join("\n") + "\n" : "");
  // Best-effort: kill the dropped instrument's preflight pane (never fatal).
  const panesFile = join(art, "preflight-panes.txt");
  if (existsSync(panesFile)) {
    try {
      const pane = parsePanesFile(readFileSync(panesFile, "utf8")).get(instrument);
      if (pane) deps.killPane(pane);
    } catch (e) { log.warn(`rehearsal drop-part: preflight pane kill failed (${(e as Error).message})`); }
  }
  log.ok(`rehearsal drop-part: dropped ${instrument}, ${kept.length} part(s) remain`);
  process.stdout.write(`N=${kept.length}\n`);
  return 0;
}
```

- [ ] **Step 4: Wire dispatch + usage**

In `src/commands/rehearsal.ts`, in the verb `switch` (≈ lines 1447-1463), add after the `spawn-all` case:

```ts
    case "drop-part": return dropPartWith(rest, liveDropPartDeps);
```

In `usage()` (line 44), add `drop-part` to the verb list:

```ts
  log.error("usage: rehearsal <init|metric|sota|spawn-all|drop-part|experiment-send|score|monitor|status-brief|finalize|refine|handoff-extract|teardown|fresh-part|forensics|abort|consensus> ...");
```

- [ ] **Step 5: Run the tests + full gate**

Run: `npm run test -- tests/rehearsal-cmd.test.ts && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/commands/rehearsal.ts tests/rehearsal-cmd.test.ts
git commit -m "fix(rehearsal): add drop-part verb for the degraded-spawn path

Degraded-proceed had no mechanical way to prune parts.txt, so Phase 4 seeded
state + a persistent Monitor for an instrument whose pane never came up.
drop-part prunes the 1-col parts.txt row (mirroring perform) and best-effort
kills the dropped instrument's preflight pane.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: A3 + A4 — spawn-all stale-clear + distinct preflight rc, and the timeout env-override (TDD)

**Files:**
- Modify: `src/commands/rehearsal.ts` (`spawnAllWith` ≈ 203-232; the experiment timeout default + `liveExperimentSendDeps`)
- Test: `tests/rehearsal-cmd.test.ts` (update any spawn-all rc expectations; add timeout-override tests)

Context (A3): `spawnAllWith` returns `2` on preflight/orphan/pick failure (before writing `spawn-results.tsv`, never clearing a stale one) AND on all-spawn-fail (after writing) — so the Phase-3 prose cannot distinguish "preflight twice = unrecoverable" from "spawn failed = offer degraded," and could read a stale `spawn-results.tsv`. Fix: clear the stale file up front; return rc `3` for preflight/setup-class failures. Context (A4): the spec twice says the experiment cap is "env-overridable" but the live dep reads only `contracts.yaml`; restore the env tier (mirrors `score.ts:549`).

- [ ] **Step 1: Write/adjust the failing tests**

First, in `tests/rehearsal-cmd.test.ts`, search for existing assertions on `spawnAllWith` that expect rc `2` for a **preflight** or **orphan** (missing-pane) or **pick (<2 instruments)** failure. Update each such expectation from `2` to `3`. (Leave assertions for all-spawn-failed / partial — those stay `2` / `1` from `spawnTally`.) If there are none, note that in the commit body.

Then add a timeout-override `describe` (imports: add `experimentTimeoutDefault` to the rehearsal import line, and `import { consultTimeout } from "../src/core/contracts.js";` near the top; `afterEach` is already imported):

```ts
describe("rehearsal experiment timeout env override", () => {
  const KEY = "CONSORT_REHEARSAL_EXPERIMENT_TIMEOUT_OVERRIDE";
  const orig = process.env[KEY];
  afterEach(() => { if (orig === undefined) delete process.env[KEY]; else process.env[KEY] = orig; });
  it("honors a positive-integer override", () => {
    process.env[KEY] = "900";
    expect(experimentTimeoutDefault()).toBe(900);
  });
  it("falls through to the contracts default on a non-positive / non-integer value", () => {
    process.env[KEY] = "0";
    expect(experimentTimeoutDefault()).toBe(consultTimeout("experiment"));
    process.env[KEY] = "abc";
    expect(experimentTimeoutDefault()).toBe(consultTimeout("experiment"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- tests/rehearsal-cmd.test.ts`
Expected: FAIL — `experimentTimeoutDefault` is not exported yet (and any updated rc-3 assertions fail against the current rc-2 code).

- [ ] **Step 3: Implement A3 (spawn-all)**

In `src/commands/rehearsal.ts` `spawnAllWith`, right after `const art = rehearsalArtDir(topic, opts);` (≈ line 207), add:

```ts
  // Clear any stale spawn-results.tsv from a prior attempt so a preflight-class failure cannot leave
  // last attempt's rows behind for the Phase-3 degraded prompt to misread.
  const staleResults = join(art, "spawn-results.tsv");
  if (existsSync(staleResults)) rmSync(staleResults);
```

Then change the three preflight/setup-class returns from `2` to `3`:
- line ≈ 210: `if (instruments.length < 2) { log.error(...); return 2; }` → `return 3;`
- line ≈ 215: `if (prc !== 0) { log.error(...); return 2; }` → `return 3;`
- line ≈ 218: `if (orphans.length) { log.error(...); return 2; }` → `return 3;`

Leave the no-topic usage guard (`return 2` at ≈ line 206) and the `spawnTally` return (0/1/2) unchanged. Update the JSDoc above the function to note: `all ok 0 / partial 1 / none ok 2; preflight/setup failures 3`.

- [ ] **Step 4: Implement A4 (timeout env tier)**

In `src/commands/rehearsal.ts`, add an exported helper near `liveExperimentSendDeps` (just above it):

```ts
/** Per-experiment wall-clock default: env override > contracts.yaml/1800. (The --timeout flag wins at
 *  the call site via `p.timeout ?? deps.consultTimeout()`, so the full chain is flag > env > default.) */
export function experimentTimeoutDefault(): number {
  const env = process.env.CONSORT_REHEARSAL_EXPERIMENT_TIMEOUT_OVERRIDE;
  return env && /^[1-9][0-9]*$/.test(env) ? Number(env) : consultTimeout("experiment");
}
```

Then in `liveExperimentSendDeps`, change:

```ts
  consultTimeout: () => consultTimeout("experiment"),
```

to:

```ts
  consultTimeout: () => experimentTimeoutDefault(),
```

- [ ] **Step 5: Run the tests + full gate**

Run: `npm run test -- tests/rehearsal-cmd.test.ts && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/commands/rehearsal.ts tests/rehearsal-cmd.test.ts
git commit -m "fix(rehearsal): distinct preflight rc + stale spawn-results clear + timeout env tier

spawn-all now clears any stale spawn-results.tsv up front and returns rc 3 for
preflight/setup-class failures (vs 1/2 for spawn-class), so the directive can
send preflight-double-fail straight to exit instead of the degraded prompt. The
experiment timeout default honors CONSORT_REHEARSAL_EXPERIMENT_TIMEOUT_OVERRIDE
(flag > env > 1800), making the spec's twice-stated env-overridable claim true.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: A5 — consensus numeric coercion (awk parity) (TDD)

**Files:**
- Modify: `src/core/rehearsalConsensus.ts:18` (`numEq`)
- Test: the existing consensus test file (find `tests/*consensus*.test.ts`; if none exists, create `tests/rehearsal-consensus.test.ts`)

Context: `numEq` uses `parseFloat`, so a degenerate NUMERIC token (`-`, `.`, `+` — all matched by the `/^-?[0-9.eE+-]+$/` class) yields `NaN`, and `NaN <= ε` is false → always "Contested". bash awk coerces such a token to `0`. Coerce `NaN → 0` to match.

- [ ] **Step 1: Write the failing test**

Locate the consensus test file (`grep -rl buildConsensus tests/`). Add this case (adjust the existing import of `buildConsensus` if the file already has one; otherwise create the file with `import { describe, it, expect } from "vitest";` and `import { buildConsensus } from "../src/core/rehearsalConsensus.js";`):

```ts
  it("treats a degenerate numeric token as 0 (awk parity) -> Agreed, not Contested", () => {
    const out = buildConsensus(
      { rex: { runtime_s: "-" }, keeli: { runtime_s: "0" } },
      { topic: "t", nowIso: "2026-06-03T00:00:00Z" },
    );
    const agreed = out.slice(out.indexOf("## Agreed"), out.indexOf("## Contested"));
    expect(agreed).toContain("runtime_s");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- <the consensus test file>`
Expected: FAIL — `parseFloat("-")` is `NaN`, so `runtime_s` is Contested, not Agreed.

- [ ] **Step 3: Implement the coercion**

In `src/core/rehearsalConsensus.ts`, replace line 18:

```ts
  const numEq = (a: string, b: string) => Math.abs(parseFloat(a) - parseFloat(b)) <= epsilon;
```

with:

```ts
  const num = (s: string): number => { const n = parseFloat(s); return Number.isNaN(n) ? 0 : n; };
  const numEq = (a: string, b: string) => Math.abs(num(a) - num(b)) <= epsilon;
```

- [ ] **Step 4: Run the tests + full gate**

Run: `npm run test -- <the consensus test file> && npm run typecheck && npm run lint`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/core/rehearsalConsensus.ts tests/
git commit -m "fix(rehearsal): consensus numeric coercion matches awk (NaN -> 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: B1 + B2 — restore dropped safety + observability docs (prose)

**Files:**
- Modify: `commands/rehearsal.md` (4 insertions; rebranded)

No code change. Read the file first to confirm current line positions (they drift). All prose is rebranded: `part` (not trooper), `Maestro` (not Yoda), `/consort:rehearsal`, `_rehearsal/`; drop clone-wars version wording.

- [ ] **Step 1: DANGER banner**

After the intro paragraph that ends `…(Phases 5-7: synthesis + teardown + handoff), now shipped.` and before the `Let \`CS="…"\`` line, insert:

```markdown
> **DANGER — read first.** Spawns codex **parts** under
> `--dangerously-bypass-approvals-and-sandbox`; parts write + execute arbitrary
> code in your repo. Sandboxing is **honor-system** (parts are told to stay inside
> their branch dir; not enforced). Net access is **permitted by default**. Do not
> run on machines with sensitive credentials, production data, or shared state.
> Use a scratch worktree if uncertain.
```

- [ ] **Step 2: Task list**

After the `## Flagging suspicions` section and before `## Phase 0 — args-file + init`, insert:

```markdown
## Task list (TaskCreate × 9 before Phase 0)

Create the task list with `TaskCreate`. Update statuses at the phase boundaries
below. Per-part rows are intentionally absent (N varies 2 or 3); the loop's
Step 5 may add a per-dispatch `<instrument> exp-NNN on <approach-label>` sub-row.

| # | subject | activeForm |
|---|---|---|
| 0   | `0 Args + init [maestro]`                 | `Staging args` |
| 1   | `1 Metric discussion [maestro + user]`    | `Locking the metric` |
| 1.5 | `1.5 SOTA sweep [maestro]`                | `Sweeping SOTA` |
| 2   | `2 Roster + time budget [maestro + user]` | `Sizing the roster` |
| 3   | `3 Spawn parts [maestro]`                 | `Spawning parts` |
| 4   | `4 Research loop [parts]`                 | `Running experiments` |
| 5   | `5 Synthesis [maestro]`                   | `Writing landscape doc` |
| 6   | `6 Teardown + archive [maestro]`          | `Tearing down` |
| 7   | `7 Present [maestro]`                     | `Presenting` |
```

- [ ] **Step 3: Phase 1.5 Security note**

At the end of `## Phase 1.5 — SOTA sweep` (after its sweep directive, before `## Phase 2`), insert:

```markdown

#### Security note

Web access in this phase relies on the Maestro's `WebSearch` / Tavily / AnySearch
tool availability and on part-side net access (permitted-by-default, honor-system —
not enforced). For a hard block, restrict at OS / firewall / network-namespace level
before invoking `/consort:rehearsal`; the command exposes no opt-out flag.
```

- [ ] **Step 4: Intervention patterns (tail section)**

At the very end of the file (after `## Phase 7 — Present`), append:

```markdown

## Intervention patterns

If you observe a part hanging, producing a garbage `result.json`, or exceeding cost
without a `cost_blown` status, you can send a clarifying prompt mid-loop via
`$CS send --from maestro <instrument> <TOPIC> "<prompt>"`. Part panes remain
attached; the Maestro regains control between every sub-step.
```

- [ ] **Step 5: Verify the stale-token gate + run tests**

Run: `npm run test -- tests/stale-tokens.test.ts`
Expected: PASS — no `trooper` / `Yoda` / `clone-wars` / `deep-research` / `cw_` introduced.

- [ ] **Step 6: Commit**

```bash
git add commands/rehearsal.md
git commit -m "docs(rehearsal): restore DANGER banner, Security note, Task list, Intervention patterns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: B3 + B4 + C1/C2 — parity-mechanics prose + intentional-divergence spec note

**Files:**
- Modify: `commands/rehearsal.md` (Phase 3 degraded/preflight branch; Step 3 monitor field; Phase 1.5 SOTA skip clause; Phase 6c handoff preamble + no-winner Open-questions; Step 4 halt.flag keys; Budget overrides tail section)
- Modify: `docs/superpowers/specs/2026-05-30-consort-rehearsal-design.md` (append the C1/C2 intentional-divergence note)

Read both files first to confirm line positions.

- [ ] **Step 1: Phase 3 — branch on the new rc + invoke drop-part**

Replace the `Branch on rc:` list in `## Phase 3 — Batch-spawn persistent codex parts` with:

```markdown
Branch on rc:
- **rc 0** → all parts ready. Continue (Phase 4 lands next).
- **rc 3 (preflight/setup), first failure** → teardown the partial set and retry `spawn-all` ONCE
  (cold-start tolerance).
- **rc 3, after retry** → preflight is unrecoverable: teardown + archive + exit. Do **NOT** show a
  degraded prompt (a pane-allocation failure that survives a retry will not be fixed by dropping parts).
- **rc 1 or 2 (spawn-class), first failure** → teardown the partial set and retry `spawn-all` ONCE.
- **rc 1 or 2, after retry** → read the FRESH `$ART/spawn-results.tsv` (`spawn-all` clears any stale one
  at start). If **< 2** parts have rc 0, abort (teardown + archive). Else **AskUserQuestion**: **Proceed
  degraded (<k>/<N>)** / **Abort**. On **Proceed degraded**, for EACH instrument whose `spawn-results.tsv`
  row has rc ≠ 0, run `$CS rehearsal drop-part <TOPIC> <instrument>` (prunes its `parts.txt` row and kills
  its preflight pane) **before** Phase 4, so Phase 4 seeds state + a Monitor only for live parts.
```

- [ ] **Step 2: Step 3 — monitor field name**

In `### Step 3 — Process the queued notification(s)`, the `done` / `error` bullet reads `…from the event JSON (\`instrument\` field + the \`summary\`-derived \`exp-NNN\`).`. Change `\`instrument\` field` to `\`part\` field` (the key `rehearsalMonitor` actually emits).

- [ ] **Step 3: Phase 1.5 — SOTA constraint skip clause**

In `## Phase 1.5 — SOTA sweep`, the query-shapes phrase `… and \`<topic> under <constraint>\``. Change it to `… and (only when \`metric.md\` has a \`hard_constraints\` value) \`<topic> under <constraint>\``.

- [ ] **Step 4: Phase 6c — handoff preamble + no-winner Open-questions**

In `## Phase 6c — Compose score-handoff.md`, the sentence `… **Write** \`$ART/score-handoff.md\` with the Write tool. Six sections IN ORDER:` — change to:

```markdown
As Maestro, **Write** `$ART/score-handoff.md` with the Write tool. Begin with a `# <topic>` H1, then a
`Source: <landscape doc path>` line and a `Generated: <UTC ISO>` line, then six sections IN ORDER:
```

In the **No-winner branch** paragraph, after the `**OMIT \`## Recipe\`** entirely.` sentence, add: ` \`## Open questions\` MAY still be emitted (conditional, as above) if planning decisions remain.`

- [ ] **Step 5: Step 4 — halt.flag optional keys**

In `### Step 4 — Completion check + DECISION POLICY`, the line listing `plus optional \`target_met\` / \`floor_met\` / \`k_so_far\` / \`k_required\` / \`plateau\``. Append the four documented-but-unread keys: ` / \`plateau_observed_n\` / \`final_leader\` / \`final_leader_metric\` / \`architectures_corroborated\``.

- [ ] **Step 6: Budget overrides (tail section)**

After the `## Intervention patterns` section added in Task 5 (end of file), append:

```markdown

## Budget overrides

`CONSORT_REHEARSAL_EXPERIMENT_TIMEOUT_OVERRIDE` (positive integer seconds) overrides the per-experiment
wall-clock cap that `experiment-send` embeds in the part's prompt. Precedence: the `--timeout` flag >
this env var > the `contracts.yaml` `experiment` default (1800s).
```

- [ ] **Step 7: C1/C2 — intentional-divergence note in the original design spec**

Append to `docs/superpowers/specs/2026-05-30-consort-rehearsal-design.md`:

```markdown

## 13. Intentional divergences from deep-research (do not re-flag)

- **Genericized shared-utility helper.** `config/prompt-templates/rehearsal/experiment.md` advertises a
  generic `{{ART_DIR}}/lib/` helper directory rather than clone-wars' concrete `arena_color_rotated(...)`
  signature. `arena.py` is still seeded into `lib/`; the README/docstring is the discovery path. Kept
  generic on purpose — not every research topic is a board game.
- **In-flight slug collision → hard error.** clone-wars auto-suffixes `-2..-999` so concurrent same-topic
  runs coexist; consort `init` hard-errors `rc 2` when the art dir already exists. Kept on purpose —
  teardown archives the topic dir (sequential reuse works); concurrent same-topic runs should pass an
  explicit `--slug`.
```

- [ ] **Step 8: Verify the stale-token gate + full gate**

Run: `npm run test -- tests/stale-tokens.test.ts && npm run typecheck && npm run lint`
Expected: PASS (the spec doc under `docs/` is not scanned; the prose in `commands/rehearsal.md` is rebranded).

- [ ] **Step 9: Commit**

```bash
git add commands/rehearsal.md docs/superpowers/specs/2026-05-30-consort-rehearsal-design.md
git commit -m "docs(rehearsal): parity-mechanics prose (drop-part/preflight branch, monitor field, halt keys) + intentional-divergence note

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Release — bump to 0.1.11 and rebuild the bundle

**Files:**
- Modify: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (the `version` field)
- Modify: `dist/consort.cjs` (regenerated; committed, never hand-edited)

- [ ] **Step 1: Confirm the current version, then bump all three manifests**

Run: `grep -rn '"version"' package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json`
Expected: each shows `"version": "0.1.10"`.

Edit each file, changing `"version": "0.1.10"` to `"version": "0.1.11"` (one occurrence per file).

- [ ] **Step 2: Rebuild the bundle**

Run: `npm run build`
Expected: esbuild writes `dist/consort.cjs` with no errors.

- [ ] **Step 3: Verify the fixes are in the bundle + the gate is green**

Run: `grep -c 'noDoneInstruction' dist/consort.cjs` — expect ≥ 1.
Run: `grep -c 'drop-part' dist/consort.cjs` — expect ≥ 1.
Run: `grep -c 'CONSORT_REHEARSAL_EXPERIMENT_TIMEOUT_OVERRIDE' dist/consort.cjs` — expect ≥ 1.
Run: `npm run typecheck && npm run test`
Expected: typecheck exits 0; full vitest suite passes (incl. `tests/stale-tokens.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json dist/consort.cjs
git commit -m "chore(release): 0.1.11 — rehearsal parity sweep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **Frozen protocol:** do not rename `inbox.md`, `END_OF_INSTRUCTION`, the `done` event, the `result.json`
  fields, or `CLAUDE_CODE_SESSION_ID`. A1 removes a *duplicate* generic done instruction — the `done`
  event name and `END_OF_INSTRUCTION` sentinel are unchanged.
- **Stale-token gate:** every restored prose line must use the consort rebrand (`part`/`Maestro`/
  `/consort:rehearsal`/`_rehearsal/`); no `clone-wars`/`cw_`/`trooper`/`commander`/`master-yoda`/
  `MISSION ACCOMPLISHED`/`@cw_`. The gate scans `src`/`config`/`commands`/`hooks`/`.claude-plugin` (not
  `docs/`).
- **Do not touch** `core/contracts.ts` (A4 is scoped to rehearsal's call site); the per-part-independent
  loop (no all-N wait-gate); or the `spawn -d` detach. Those are deliberate and out of scope.
- **Stray files:** ignore the untracked `target-user-analysis.{html,md}` in the repo root — not part of
  this work; do not stage them.
- If the harness LSP reports a phantom TS error, trust `npm run typecheck` (it is authoritative).
