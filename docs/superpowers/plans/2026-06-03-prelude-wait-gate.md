# prelude wait-gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/consort:prelude` advance past its research-wait (Phase 4) and adversary-wait (Phase 7→8) barriers only when ALL N parts are terminal, by porting score's `wait-gate` to prelude's two stages.

**Architecture:** Reuse the pure `gateState` helper already in `src/core/scoreTurn.ts` (widen its `key` type to also accept `"AS"`). Add a thin `prelude wait-gate <TOPIC> <research|adversary>` verb (`preludeWaitGateRun`) mirroring score's `waitGateRun`, with the phase→status-key map research→`FS`, adversary→`AS`. Harden the two advisory prose gates in `commands/prelude.md` to require the verb's rc 0. `rehearsal` is intentionally per-part-independent and is NOT touched.

**Tech Stack:** TypeScript (ESM), vitest, esbuild single committed bundle. Pure helper unit-tested; verb tested with a temp `CONSORT_HOME` (`tests/helpers/tmpHome.ts`).

**Spec:** `docs/superpowers/specs/2026-06-03-prelude-wait-gate-design.md`
**Branch:** `fix/prelude-wait-gate` (created; spec committed at `bfd5d3b`).

---

## File Structure

- `src/core/scoreTurn.ts` — widen `gateState`'s `key` param `"FS" | "VS"` → `"FS" | "VS" | "AS"` (1 line; body is key-agnostic).
- `src/commands/prelude.ts` — add `gateState` to the `../core/scoreTurn.js` import; add `preludeWaitGateRun`; wire `case "wait-gate"`; add `wait-gate` to `usage()`.
- `commands/prelude.md` — harden the two gate sentences (line 142 research, line 242 adversary).
- `tests/score-gate.test.ts` — add one `AS`-key pure `gateState` case.
- `tests/prelude-gate.test.ts` — new: verb-level rc tests for both phases.
- `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` — bump `0.1.8` → `0.1.9`.
- `dist/consort.cjs` — rebuilt.

Conventions confirmed in-repo: prelude's `research-wait` writes `research-<inst>.txt` (`FS=` line via `researchState`) + `research-<inst>.done` (`prelude.ts:230,232`); `adversary-wait` writes `adversary-<inst>.txt` (`AS=` line via `verifyState`) + `adversary-<inst>.done` (`prelude.ts:345,347`). `roster.txt` is `# comment` + `<provider>\t<instrument>` rows (`parseRosterFile`). `preludeArtDir(topic)` resolves under `CONSORT_HOME` (`src/core/prelude.ts:9`). `prelude.ts:25` already imports `parseLatestOffset, scaledTimeout, researchState, verifyState` from `../core/scoreTurn.js`.

---

### Task 1: Widen `gateState` to accept the `AS` key

**Files:**
- Modify: `src/core/scoreTurn.ts` (the `gateState` signature, ~line 121)
- Test: `tests/score-gate.test.ts` (add one case to the `describe("gateState (pure)", ...)` block)

- [ ] **Step 1: Add the failing (type-level) test**

In `tests/score-gate.test.ts`, add this `it(...)` inside the existing `describe("gateState (pure)", () => { ... })` block:

```ts
  it("verify-style AS key: terminal / question / pending", () => {
    const out = gateState([
      { instrument: "viola", doneExists: true, stateText: "OFFSET=2\nAS=ok\n" },
      { instrument: "cello", doneExists: true, stateText: "OFFSET=4\nAS=question\n" },
      { instrument: "oboe", doneExists: false, stateText: null },
    ], "AS");
    expect(out.map((s) => s.status)).toEqual(["terminal", "question", "pending"]);
  });
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `cd /home/liupan/CC/consort && npm run typecheck`
Expected: FAIL — `error TS2345: Argument of type '"AS"' is not assignable to parameter of type '"FS" | "VS"'.` at the new test's `gateState(..., "AS")` call. (Note: `npx vitest run` would PASS at runtime because esbuild strips types and `gateState`'s body is key-agnostic — the typecheck is the gate that fails here.)

- [ ] **Step 3: Widen the key union**

In `src/core/scoreTurn.ts`, change the `gateState` signature's `key` parameter type from `"FS" | "VS"` to `"FS" | "VS" | "AS"`:

```ts
export function gateState(
  parts: Array<{ instrument: string; doneExists: boolean; stateText: string | null }>,
  key: "FS" | "VS" | "AS",
): Array<{ instrument: string; status: GateStatus }> {
```

(Leave the function body unchanged — it already filters lines by `\`${key}=\``, so it is key-agnostic.)

- [ ] **Step 4: Run typecheck + the test to verify they pass**

Run: `cd /home/liupan/CC/consort && npm run typecheck && npx vitest run tests/score-gate.test.ts`
Expected: typecheck clean; all `score-gate` tests PASS (the new `AS` case included).

- [ ] **Step 5: Commit**

```bash
cd /home/liupan/CC/consort
git add src/core/scoreTurn.ts tests/score-gate.test.ts
git commit -m "feat(score): widen gateState key to FS|VS|AS for prelude reuse"
```

---

### Task 2: `prelude wait-gate` verb + dispatch + usage + tests

**Files:**
- Modify: `src/commands/prelude.ts` (import `gateState`; add `preludeWaitGateRun`; add `case "wait-gate"`; extend `usage()`)
- Test: `tests/prelude-gate.test.ts` (new)

- [ ] **Step 1: Write the failing verb test**

Create `tests/prelude-gate.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { preludeArtDir } from "../src/core/prelude.js";
import { preludeWaitGateRun } from "../src/commands/prelude.js";

describe("prelude wait-gate (verb)", () => {
  let env: { home: string; cleanup: () => void };
  beforeEach(() => { env = freshHome(); });
  afterEach(() => { env.cleanup(); });

  function seedRoster(topic: string): string {
    const art = preludeArtDir(topic); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "roster.txt"), "# generated\ncodex\tviola\nclaude\tcello\n");
    return art;
  }

  it("research phase (FS): rc 0 only when every part terminal", async () => {
    const art = seedRoster("t");
    for (const inst of ["viola", "cello"]) {
      writeFileSync(join(art, `research-${inst}.txt`), "OFFSET=1\nFS=ok\n");
      writeFileSync(join(art, `research-${inst}.done`), "");
    }
    expect(await preludeWaitGateRun(["t", "research"])).toBe(0);
  });

  it("research phase: rc 1 when one part is still pending (no .done)", async () => {
    const art = seedRoster("t");
    writeFileSync(join(art, "research-viola.txt"), "OFFSET=1\nFS=ok\n");
    writeFileSync(join(art, "research-viola.done"), "");
    expect(await preludeWaitGateRun(["t", "research"])).toBe(1);
  });

  it("adversary phase (AS): rc 1 when one part's last line is a question", async () => {
    const art = seedRoster("t");
    writeFileSync(join(art, "adversary-viola.txt"), "OFFSET=1\nAS=ok\n");
    writeFileSync(join(art, "adversary-viola.done"), "");
    writeFileSync(join(art, "adversary-cello.txt"), "OFFSET=2\nAS=question\n");
    writeFileSync(join(art, "adversary-cello.done"), "");
    expect(await preludeWaitGateRun(["t", "adversary"])).toBe(1);
  });

  it("adversary phase: rc 0 when all terminal (AS=ok / AS=missing both count)", async () => {
    const art = seedRoster("t");
    writeFileSync(join(art, "adversary-viola.txt"), "OFFSET=1\nAS=ok\n");
    writeFileSync(join(art, "adversary-viola.done"), "");
    writeFileSync(join(art, "adversary-cello.txt"), "OFFSET=2\nAS=missing\n");
    writeFileSync(join(art, "adversary-cello.done"), "");
    expect(await preludeWaitGateRun(["t", "adversary"])).toBe(0);
  });

  it("bad/absent phase and missing roster → rc 2", async () => {
    expect(await preludeWaitGateRun(["t"])).toBe(2);          // missing phase
    expect(await preludeWaitGateRun(["t", "verify"])).toBe(2); // score's phase, not prelude's
    expect(await preludeWaitGateRun(["t", "research"])).toBe(2); // no art/roster yet
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/liupan/CC/consort && npx vitest run tests/prelude-gate.test.ts`
Expected: FAIL — `preludeWaitGateRun` is not exported.

- [ ] **Step 3: Add the import**

In `src/commands/prelude.ts`, find line 25 (`import { parseLatestOffset, scaledTimeout, researchState, verifyState } from "../core/scoreTurn.js";`) and add `gateState`:

```ts
import { parseLatestOffset, scaledTimeout, researchState, verifyState, gateState } from "../core/scoreTurn.js";
```

- [ ] **Step 4: Implement the verb**

In `src/commands/prelude.ts`, add this function next to `adversaryWaitWith` (after ~line 350). `existsSync`, `readFileSync`, `join`, `parseRosterFile`, `preludeArtDir`, and `log` are already imported in this file.

```ts
export async function preludeWaitGateRun(rest: string[]): Promise<number> {
  const [topic, phase] = rest;
  if (!topic || !phase) { log.error("usage: prelude wait-gate <topic> <research|adversary>"); return 2; }
  if (phase !== "research" && phase !== "adversary") { log.error(`prelude wait-gate: phase must be research|adversary (got ${phase})`); return 2; }
  const art = preludeArtDir(topic);
  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error(`prelude wait-gate: roster.txt missing at ${art}`); return 2; }
  const rows = parseRosterFile(readFileSync(rosterPath, "utf8"));
  if (rows.length === 0) { log.error("prelude wait-gate: roster.txt has no parts"); return 2; }
  const key = phase === "research" ? "FS" : "AS";
  const parts = rows.map((r) => {
    const stateFile = join(art, `${phase}-${r.instrument}.txt`);
    return {
      instrument: r.instrument,
      doneExists: existsSync(join(art, `${phase}-${r.instrument}.done`)),
      stateText: existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null,
    };
  });
  const states = gateState(parts, key);
  for (const s of states) process.stdout.write(`${s.instrument}\t${s.status}\n`);
  return states.every((s) => s.status === "terminal") ? 0 : 1;
}
```

- [ ] **Step 5: Wire dispatch + usage**

In `src/commands/prelude.ts`, in the `switch (verb)` block (next to `case "adversary-wait":`), add:

```ts
    case "wait-gate": return preludeWaitGateRun(rest);
```

And in the `usage()` string (lines 33-34), insert `wait-gate` after `research-wait|`:

```ts
  log.error("usage: prelude <init|classify|spawn-all|research-send|research-wait|wait-gate|synth-preliminary|" +
    "confidence|adversary-send|adversary-wait|synth-final|forensics|teardown|handoff-extract> ...");
```

- [ ] **Step 6: Run to verify it passes + typecheck**

Run: `cd /home/liupan/CC/consort && npm run typecheck && npx vitest run tests/prelude-gate.test.ts`
Expected: typecheck clean; all `prelude-gate` tests PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
cd /home/liupan/CC/consort
git add src/commands/prelude.ts tests/prelude-gate.test.ts
git commit -m "feat(prelude): wait-gate verb (rc 0 only when every part is terminal)"
```

---

### Task 3: Harden the two advisory gates in `commands/prelude.md`

**Files:**
- Modify: `commands/prelude.md` (line 142 research gate; line 242 adversary gate)

- [ ] **Step 1: Replace the research gate sentence (Phase 4)**

In `commands/prelude.md`, find this exact bold sentence (line 142):

```
**Proceed when all N parts have written their `research-<instrument>.done` sentinel.**
```

Replace it with:

```
**Do not proceed until `$CS prelude wait-gate <TOPIC> research` exits 0** — it prints `<INST>\t<terminal|question|pending>` per part and returns 0 only when every part is terminal. rc 1 means at least one part is still `pending` (researching) or `question` (needs a relay): keep handling notifications / relay, then re-run the gate.
```

(Leave the following sentence — "The `FS=` value is informational — do **NOT** gate on `FS=ok` ..." — unchanged; it still applies, since `terminal` includes `FS=empty`/`FS=malformed`.)

- [ ] **Step 2: Replace the adversary gate sentence (Phase 7→8)**

In `commands/prelude.md`, find this exact bold sentence (line 242):

```
**Proceed when all N `$ART/adversary-<instrument>.done` sentinels exist.**
```

Replace it with:

```
**Do not proceed until `$CS prelude wait-gate <TOPIC> adversary` exits 0** — it prints `<INST>\t<terminal|question|pending>` per part; rc 1 means some part is still `pending`/`question`, so keep handling / relay and re-run. Only on rc 0 continue.
```

(Leave the following "The `AS=` value is ..." text unchanged.)

- [ ] **Step 3: Verify the references landed and the suite stays green**

Run:
```bash
cd /home/liupan/CC/consort
grep -n "wait-gate <TOPIC> research" commands/prelude.md && grep -n "wait-gate <TOPIC> adversary" commands/prelude.md
npm run test 2>&1 | grep -E "Test Files|Tests " | grep -v FAIL
```
Expected: each grep prints one line; the suite shows `Tests NNNN passed (NNNN)` with zero failures (the stale-token gate runs in the suite — confirm green; a `Verdict: FAIL` stderr line from a negative-path soundcheck test is expected and is NOT a failure).

- [ ] **Step 4: Commit**

```bash
cd /home/liupan/CC/consort
git add commands/prelude.md
git commit -m "docs(prelude): gate Phase 4/7 on wait-gate rc 0 (restore the all-N wait)"
```

---

### Task 4: Version bump, full gate, rebuild & commit dist

**Files:**
- Modify: `package.json:3`, `.claude-plugin/plugin.json:3`, `.claude-plugin/marketplace.json` (plugins[0] version) — `0.1.8` → `0.1.9`
- Modify: `dist/consort.cjs` (rebuilt)

- [ ] **Step 1: Bump version to 0.1.9 in all three manifests**

Set `"version": "0.1.9",` in: `package.json` (top-level), `.claude-plugin/plugin.json` (top-level), `.claude-plugin/marketplace.json` (the entry under `plugins[0]`).

- [ ] **Step 2: Confirm all three read 0.1.9**

Run: `cd /home/liupan/CC/consort && grep -h '"version"' package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json`
Expected: three lines, each `"version": "0.1.9",`.

- [ ] **Step 3: Full gate**

Run: `cd /home/liupan/CC/consort && npm run typecheck && npm run test && npm run lint`
Expected: typecheck clean; vitest `Test Files NN passed (NN)` / `Tests NNNN passed (NNNN)` with zero failures (ignore the expected stderr `Verdict: FAIL` line from a negative-path soundcheck test — trust the final summary); lint clean.

- [ ] **Step 4: Rebuild the bundle**

Run: `cd /home/liupan/CC/consort && npm run build`
Expected: `esbuild → dist/consort.cjs <size>` and `Done`.

- [ ] **Step 5: Sanity-check the verb reached the bundle**

Run: `cd /home/liupan/CC/consort && grep -c "prelude wait-gate" dist/consort.cjs`
Expected: a non-zero count (the verb's usage/error strings are bundled).

- [ ] **Step 6: Commit**

```bash
cd /home/liupan/CC/consort
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json dist/consort.cjs
git commit -m "chore(release): 0.1.9 — prelude wait-gate (all-N gate at both barrier stages)"
```

---

## Notes for the executor

- **Frozen protocol:** the verb only READS frozen state filenames (`<phase>-<inst>.txt`, `<phase>-<inst>.done`, `roster.txt`); it renames/creates nothing on the wire. Do NOT touch event names / sentinel / JSON fields / `contracts.yaml` / `CLAUDE_CODE_SESSION_ID`.
- **Stale-token gate:** introduce no banned token (`clone-wars`/`cw_`/`master-yoda`/`MISSION ACCOMPLISHED`/`@cw_`); it runs in `npm run test`.
- **Scope:** `prelude` only. Do NOT modify `rehearsal` (verified correctly per-part-independent — an all-N barrier there would be a bug).
- **DRY:** the verb composes the shared pure `gateState` — do not duplicate the status logic in `prelude.ts`. (A thin per-command wrapper around a shared core matches the existing score/prelude convention.)
- The live dogfood (a real `prelude` run where one part lags) is the manual end-to-end check, done after merge — not part of these automated tasks.
