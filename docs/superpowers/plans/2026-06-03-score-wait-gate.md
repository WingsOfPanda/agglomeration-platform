# score wait-gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/consort:score` advance past the research-wait and cross-verify stages only when ALL N ensemble parts are terminal, via a mechanical `score wait-gate <TOPIC> <phase>` verb plus restored clone-wars prose.

**Architecture:** A pure `gateState` helper in `src/core/scoreTurn.ts` maps each part's pre-read `.done`/state-file inputs to `terminal | question | pending`. A thin `waitGateRun` verb in `src/commands/score.ts` reads `roster.txt` + per-part state files, prints `<INST>\t<status>` per part, and returns rc 0 iff all terminal (rc 1 if any pending/question, rc 2 on usage errors). `commands/score.md` Stage 5 (research) and Stage 8 (verify) instruct the Maestro to gate on `wait-gate` rc 0.

**Tech Stack:** TypeScript (ESM), vitest, esbuild single committed bundle. Pure helpers unit-tested; verbs tested with a temp `CONSORT_HOME` (`tests/helpers/tmpHome.ts`).

**Spec:** `docs/superpowers/specs/2026-06-03-score-wait-gate-design.md`
**Branch:** `fix/score-wait-gate` (created; spec committed at `0084901`).

---

## File Structure

- `src/core/scoreTurn.ts` — add `GateStatus` type + pure `gateState(parts, key)` (alongside the existing `researchState`/`verifyState`/`FsState`). No fs/IPC.
- `src/commands/score.ts` — add `waitGateRun(rest)` verb; wire `case "wait-gate"`; add `wait-gate` to `usage()`; import `gateState`.
- `commands/score.md` — Stage 5 + Stage 8 prose (restore the all-N gate, anchored on `wait-gate`).
- `tests/score-gate.test.ts` — new: unit tests for `gateState` (pure) + verb-level rc tests for `waitGateRun` (temp home).
- `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` — bump `0.1.7` → `0.1.8`.
- `dist/consort.cjs` — rebuilt.

Conventions confirmed in-repo: `roster.txt` is `# comment` + `<provider>\t<instrument>` rows (`parseRosterFile`, `src/core/score.ts:62`); per-part files are `<phase>-<INST>.txt` (status lines `FS=`/`VS=`) and `<phase>-<INST>.done` (written by `research-wait`/`verify-wait`); `scoreArtDir(topic)` resolves under `CONSORT_HOME`.

---

### Task 1: Pure `gateState` helper

**Files:**
- Create: `tests/score-gate.test.ts`
- Modify: `src/core/scoreTurn.ts` (add after `verifyState`, ~line 113)

- [ ] **Step 1: Write the failing test**

Create `tests/score-gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { gateState } from "../src/core/scoreTurn.js";

describe("gateState (pure)", () => {
  it("all parts done with a non-question last line → terminal", () => {
    const out = gateState([
      { instrument: "viola", doneExists: true, stateText: "OFFSET=5\nFS=ok\n" },
      { instrument: "cello", doneExists: true, stateText: "OFFSET=3\nFS=empty\n" },
    ], "FS");
    expect(out).toEqual([
      { instrument: "viola", status: "terminal" },
      { instrument: "cello", status: "terminal" },
    ]);
  });

  it("missing .done marker → pending (still running)", () => {
    const out = gateState([
      { instrument: "viola", doneExists: true, stateText: "FS=ok\n" },
      { instrument: "cello", doneExists: false, stateText: null },
    ], "FS");
    expect(out.map((s) => s.status)).toEqual(["terminal", "pending"]);
  });

  it("last status line is question → question (even with .done present)", () => {
    const out = gateState([
      { instrument: "cello", doneExists: true, stateText: "OFFSET=3\nFS=question\n" },
    ], "FS");
    expect(out[0].status).toBe("question");
  });

  it("re-arm: question then a terminal value — last line wins → terminal", () => {
    const out = gateState([
      { instrument: "cello", doneExists: true, stateText: "OFFSET=3\nFS=question\nFS=ok\n" },
    ], "FS");
    expect(out[0].status).toBe("terminal");
  });

  it("terminal then question — last line wins → question", () => {
    const out = gateState([
      { instrument: "cello", doneExists: true, stateText: "FS=ok\nOFFSET=7\nFS=question\n" },
    ], "FS");
    expect(out[0].status).toBe("question");
  });

  it("verify phase uses the VS= key", () => {
    const out = gateState([
      { instrument: "viola", doneExists: true, stateText: "OFFSET=2\nVS=skipped\n" },
      { instrument: "cello", doneExists: true, stateText: "OFFSET=4\nVS=question\n" },
    ], "VS");
    expect(out.map((s) => s.status)).toEqual(["terminal", "question"]);
  });

  it("done present but no status line yet → pending", () => {
    const out = gateState([
      { instrument: "viola", doneExists: true, stateText: "OFFSET=5\n" },
    ], "FS");
    expect(out[0].status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/liupan/CC/consort && npx vitest run tests/score-gate.test.ts`
Expected: FAIL — `gateState` is not exported (import error / not a function).

- [ ] **Step 3: Implement `gateState`**

In `src/core/scoreTurn.ts`, add immediately after the `verifyState` function (after ~line 113):

```ts
export type GateStatus = "terminal" | "question" | "pending";

/** Per-part readiness for the research/verify wait gate. `key` is the status-line prefix
 *  (`FS` for research, `VS` for verify). A part is `terminal` once its `.done` marker exists and
 *  its LAST `<key>=` line is a non-`question` value; `question` while its last `<key>=` line is
 *  `question` (transient — awaiting a relay+re-arm); otherwise `pending` (still running). Pure:
 *  callers pass the pre-read `.done` existence and `.txt` text so this stays IPC-free and testable. */
export function gateState(
  parts: Array<{ instrument: string; doneExists: boolean; stateText: string | null }>,
  key: "FS" | "VS",
): Array<{ instrument: string; status: GateStatus }> {
  return parts.map((p) => {
    const matches = (p.stateText ?? "").split("\n").filter((l) => l.startsWith(`${key}=`));
    const last = matches.length ? matches[matches.length - 1].slice(key.length + 1).trim() : null;
    const status: GateStatus =
      last === "question" ? "question"
        : p.doneExists && last !== null ? "terminal"
          : "pending";
    return { instrument: p.instrument, status };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/liupan/CC/consort && npx vitest run tests/score-gate.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/liupan/CC/consort
git add src/core/scoreTurn.ts tests/score-gate.test.ts
git commit -m "feat(score): pure gateState helper for the all-N wait gate"
```

---

### Task 2: `waitGateRun` verb + dispatch + usage

**Files:**
- Modify: `src/commands/score.ts` (import `gateState`; add `waitGateRun`; add `case "wait-gate"`; extend `usage()`)
- Test: `tests/score-gate.test.ts` (append a `score wait-gate (verb)` describe block)

- [ ] **Step 1: Write the failing verb test**

Append to `tests/score-gate.test.ts` (add these imports at the top of the file alongside the existing import, then the new describe block at the end):

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach } from "vitest";
import { freshHome } from "./helpers/tmpHome.js";
import { scoreArtDir } from "../src/core/score.js";
import { waitGateRun } from "../src/commands/score.js";

describe("score wait-gate (verb)", () => {
  let env: { home: string; cleanup: () => void };
  beforeEach(() => { env = freshHome(); });
  afterEach(() => { env.cleanup(); });

  function seedRoster(topic: string): string {
    const art = scoreArtDir(topic); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "roster.txt"), "# generated\ncodex\tviola\nclaude\tcello\n");
    return art;
  }

  it("rc 0 only when every part is terminal", async () => {
    const art = seedRoster("t");
    for (const inst of ["viola", "cello"]) {
      writeFileSync(join(art, `research-${inst}.txt`), "OFFSET=1\nFS=ok\n");
      writeFileSync(join(art, `research-${inst}.done`), "");
    }
    expect(await waitGateRun(["t", "research"])).toBe(0);
  });

  it("rc 1 when one part is still pending (no .done)", async () => {
    const art = seedRoster("t");
    writeFileSync(join(art, "research-viola.txt"), "OFFSET=1\nFS=ok\n");
    writeFileSync(join(art, "research-viola.done"), "");
    // cello: never sent → no files → pending
    expect(await waitGateRun(["t", "research"])).toBe(1);
  });

  it("rc 1 when one part's last line is a question", async () => {
    const art = seedRoster("t");
    writeFileSync(join(art, "research-viola.txt"), "OFFSET=1\nFS=ok\n");
    writeFileSync(join(art, "research-viola.done"), "");
    writeFileSync(join(art, "research-cello.txt"), "OFFSET=2\nFS=question\n");
    writeFileSync(join(art, "research-cello.done"), "");
    expect(await waitGateRun(["t", "research"])).toBe(1);
  });

  it("bad/absent phase and missing roster → rc 2", async () => {
    expect(await waitGateRun(["t"])).toBe(2);            // missing phase
    expect(await waitGateRun(["t", "bogus"])).toBe(2);   // bad phase
    expect(await waitGateRun(["t", "research"])).toBe(2); // no art/roster yet
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/liupan/CC/consort && npx vitest run tests/score-gate.test.ts -t "wait-gate"`
Expected: FAIL — `waitGateRun` is not exported.

- [ ] **Step 3: Add the import**

In `src/commands/score.ts`, find the import from `../core/scoreTurn.js` (line 23, beginning `import { composeResearchPrompt, researchState, ...`) and add `gateState` to that import list.

- [ ] **Step 4: Implement `waitGateRun`**

In `src/commands/score.ts`, add this function next to `walkStateRun` (after ~line 468). `existsSync`, `readFileSync`, `join`, `parseRosterFile`, `scoreArtDir`, and `log` are already imported in this file.

```ts
export async function waitGateRun(rest: string[]): Promise<number> {
  const [topic, phase] = rest;
  if (!topic || !phase) { log.error("usage: score wait-gate <topic> <research|verify>"); return 2; }
  if (phase !== "research" && phase !== "verify") { log.error(`score wait-gate: phase must be research|verify (got ${phase})`); return 2; }
  const art = scoreArtDir(topic);
  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error(`score wait-gate: roster.txt missing at ${art}`); return 2; }
  const rows = parseRosterFile(readFileSync(rosterPath, "utf8"));
  if (rows.length === 0) { log.error("score wait-gate: roster.txt has no parts"); return 2; }
  const key = phase === "research" ? "FS" : "VS";
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

In `src/commands/score.ts`, in the `switch (verb)` block (next to `case "walk-state":`), add:

```ts
    case "wait-gate": return waitGateRun(rest);
```

And in the `usage()` string (line 35), insert `wait-gate` into the verb list — change `...|research-wait|diff|...` to `...|research-wait|wait-gate|diff|...`.

- [ ] **Step 6: Run to verify it passes + typecheck**

Run: `cd /home/liupan/CC/consort && npm run typecheck && npx vitest run tests/score-gate.test.ts`
Expected: typecheck clean; all `score-gate` tests PASS (pure + verb).

- [ ] **Step 7: Commit**

```bash
cd /home/liupan/CC/consort
git add src/commands/score.ts tests/score-gate.test.ts
git commit -m "feat(score): wait-gate verb (rc 0 only when every part is terminal)"
```

---

### Task 3: Restore the all-N gate prose (Stage 5 + Stage 8)

**Files:**
- Modify: `commands/score.md` (Stage 5 research-wait gate; Stage 8 verify-wait gate)

- [ ] **Step 1: Replace the Stage 5 gate sentence**

In `commands/score.md`, find this exact sentence (the start of the paragraph after the FS branch list, ~line 169):

```
**Proceed only when every part is terminal** (no `FS=question` outstanding).
```

Replace it with:

```
You launched **N** background waits — expect **N** completion notifications, one per part. On each,
read that part's last `FS=` line and handle it (relaying any `FS=question` via the loop above, which
re-arms that part). **Do not proceed until `$CS score wait-gate <TOPIC> research` exits 0** — it
prints `<INST>\t<terminal|question|pending>` for every part and returns 0 only when all are
`terminal`. rc 1 means at least one part is still `pending` (researching) or `question` (needs a
relay): keep handling notifications / relay, then re-run the gate. Only on rc 0 proceed.
```

(Leave the following text — "Then build the **diff roster** = ..." — unchanged; it continues the paragraph.)

- [ ] **Step 2: Replace the Stage 8 gate sentence**

In `commands/score.md`, find this exact line (~line 207):

```
Proceed when every part is terminal (no `VS=question` outstanding).
```

Replace it with:

```
Expect **N** completion notifications (one per part); handle each, relaying any `VS=question`. **Do
not proceed until `$CS score wait-gate <TOPIC> verify` exits 0** — it prints
`<INST>\t<terminal|question|pending>` per part; rc 1 means some part is still `pending`/`question`,
so keep handling / relay and re-run. Only on rc 0 continue.
```

- [ ] **Step 3: Verify the prose references landed and the suite stays green**

Run:
```bash
cd /home/liupan/CC/consort
grep -n "wait-gate <TOPIC> research" commands/score.md && grep -n "wait-gate <TOPIC> verify" commands/score.md
npm run test 2>&1 | grep -E "Test Files|Tests " | grep -v FAIL
```
Expected: both greps print a line (Stage 5 + Stage 8 each reference the gate); suite shows `Tests NNNN passed` with zero failures (the stale-token gate is part of the suite — confirm it passes; a `Verdict: FAIL` stderr line from a negative-path test is expected and is NOT a failure).

- [ ] **Step 4: Commit**

```bash
cd /home/liupan/CC/consort
git add commands/score.md
git commit -m "docs(score): gate Stage 5/8 on wait-gate rc 0 (restore the all-N wait)"
```

---

### Task 4: Version bump, full gate, rebuild & commit dist

**Files:**
- Modify: `package.json:3`, `.claude-plugin/plugin.json:3`, `.claude-plugin/marketplace.json` (plugins[0] version) — `0.1.7` → `0.1.8`
- Modify: `dist/consort.cjs` (rebuilt)

- [ ] **Step 1: Bump version to 0.1.8 in all three manifests**

Set `"version": "0.1.8",` in: `package.json` (top-level), `.claude-plugin/plugin.json` (top-level), `.claude-plugin/marketplace.json` (the entry under `plugins[0]`).

- [ ] **Step 2: Confirm all three read 0.1.8**

Run: `cd /home/liupan/CC/consort && grep -h '"version"' package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json`
Expected: three lines, each `"version": "0.1.8",`.

- [ ] **Step 3: Full gate**

Run: `cd /home/liupan/CC/consort && npm run typecheck && npm run test && npm run lint`
Expected: typecheck clean; vitest `Test Files NN passed (NN)` / `Tests NNNN passed (NNNN)` with zero failures (ignore the expected stderr `Verdict: FAIL` line from a negative-path soundcheck test — trust the final summary); lint clean.

- [ ] **Step 4: Rebuild the bundle**

Run: `cd /home/liupan/CC/consort && npm run build`
Expected: `esbuild → dist/consort.cjs <size>` and `Done`.

- [ ] **Step 5: Sanity-check the verb reached the bundle**

Run: `cd /home/liupan/CC/consort && grep -c "wait-gate" dist/consort.cjs`
Expected: non-zero count.

- [ ] **Step 6: Commit**

```bash
cd /home/liupan/CC/consort
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json dist/consort.cjs
git commit -m "chore(release): 0.1.8 — score wait-gate (all-N ensemble gate)"
```

---

## Notes for the executor

- **Frozen protocol:** the verb only READS frozen state filenames (`<phase>-<INST>.txt`, `<phase>-<INST>.done`); it renames/creates nothing on the wire. Do NOT touch event names / sentinel / JSON fields / `contracts.yaml` / `CLAUDE_CODE_SESSION_ID`.
- **Stale-token gate:** introduce no banned token (`clone-wars`/`cw_`/`master-yoda`/`MISSION ACCOMPLISHED`/`@cw_`); it runs in `npm run test`.
- **Scope:** `score` only. Do NOT modify `prelude`/`rehearsal` (a separate investigation per the spec).
- **DRY:** the verb composes the pure `gateState` — do not duplicate the status logic in `score.ts`.
- The live dogfood (a real `--ensemble` run where one part lags) is the manual end-to-end check, done after merge — not part of these automated tasks.
