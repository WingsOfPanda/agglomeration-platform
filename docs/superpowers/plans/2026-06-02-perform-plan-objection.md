# perform Plan-Objection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third `objection` route to `perform`'s frozen question protocol so a part can flag a wrong plan (message prefixed `OBJECTION:`) and the Maestro can drive a Revise/Override/Abort decision — across both the single-repo turn path and the multi-repo wave path.

**Architecture:** The objection rides *inside* the existing frozen `question` event via an `OBJECTION:` message marker on the no-claim side (claim-wins precedence preserved). Pure helpers (`performQuestions.ts`) detect/strip the marker and carry a new `ROUTE=objection`; the wait verbs (`turnWaitWith`, `waveWaitWith`) persist a bumped offset + an `OBJECTIONS=` cap counter to per-dispatch state files; the orchestration (`commands/perform.md`) renders the objection and authors the reply prose via the existing `send` primitive. No new CLI verb; no wire-protocol change.

**Tech Stack:** TypeScript (Node/ESM), esbuild single-bundle (`dist/consort.cjs`, committed), Vitest. Spec: `docs/superpowers/specs/2026-06-02-perform-plan-objection-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/performQuestions.ts` | pure question payload extract/parse/verify | widen `ClaimRoute`; three-way parse; `OBJECTION:` detect+strip in extract |
| `src/core/performTurn.ts` | part prompt composers | `blockers()` objection clause; `composeDagUnitPrompt` gains `blockers("")` |
| `src/commands/perform.ts` | perform verbs | `latestObjections` helper; `turnWaitWith` cap; `waveWaitWith`/`waveWaitRun` gain `<dispatch>`+`<since>`, `question` event, per-dispatch offset file |
| `commands/perform.md` | Maestro orchestration prose | Stage 1.3 objection branch; Stage 3a/3b/3d `TS=question` handling (suite-as-gate, no automated control-flow test) |
| `tests/perform-questions.test.ts` | unit | objection route detection/strip cases |
| `tests/perform-turn.test.ts` | unit | `blockers()`/`composeDagUnitPrompt` objection assertions |
| `tests/perform-turn-cmd.test.ts` | unit | `turnWaitWith` `OBJECTIONS=` cap cases |
| `tests/perform-wave-wait.test.ts` | unit | new signature sweep + `question`/offset/re-arm cases |
| `dist/consort.cjs` | committed bundle | rebuilt in Task 6 |

**Implementation order is bottom-up:** pure helpers (T1) → prompts (T2) → single-repo wait cap (T3) → multi-repo wave wiring (T4) → orchestration doc (T5) → gate + bundle (T6). Each of T1–T5 is independently committable and keeps the suite green.

---

### Task 1: `performQuestions.ts` — widen the route to `objection`

**Files:**
- Modify: `src/core/performQuestions.ts:27` (ClaimRoute type), `:50` (parse), `:168-177` (extract)
- Test: `tests/perform-questions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to `tests/perform-questions.test.ts` (after the existing `describe("extractQuestionPayload", ...)`, before `describe("round-trip: ...")`):

```typescript
describe("objection route (OBJECTION: marker on the no-claim side)", () => {
  const dec = (msg: string) =>
    parseQuestionPayload(extractQuestionPayload({ event: "question", message: msg }, 0)!).text;

  it("parseQuestionPayload reads ROUTE=objection", () => {
    expect(parseQuestionPayload("TEXT=x\nCLAIM_KIND=\nCLAIM_VALUE=\nROUTE=objection\n").route).toBe("objection");
  });
  it("parseQuestionPayload: unknown ROUTE still defaults to escalate after the widening", () => {
    expect(parseQuestionPayload("TEXT=x\nROUTE=bogus\n").route).toBe("escalate");
  });
  it("extract: no claim + OBJECTION: message → objection route, marker + one space stripped", () => {
    expect(extractQuestionPayload({ event: "question", message: "OBJECTION: the slice is wrong" }, 5))
      .toBe("TEXT=the slice is wrong\nCLAIM_KIND=\nCLAIM_VALUE=\nROUTE=objection\nASKED_AT=5\n");
  });
  it("extract: claim wins even when the message starts with OBJECTION:", () => {
    expect(extractQuestionPayload({ event: "question", message: "OBJECTION: x", claim: { kind: "path", value: "/x" } }, 5))
      .toBe("TEXT=OBJECTION: x\nCLAIM_KIND=path\nCLAIM_VALUE=/x\nROUTE=verify\nASKED_AT=5\n");
  });
  it("marker is anchored + case-sensitive; near-misses route to escalate", () => {
    expect(extractQuestionPayload({ event: "question", message: " OBJECTION: x" }, 5)).toContain("ROUTE=escalate\n");
    expect(extractQuestionPayload({ event: "question", message: "I think OBJECTION: x" }, 5)).toContain("ROUTE=escalate\n");
    expect(extractQuestionPayload({ event: "question", message: "objection: x" }, 5)).toContain("ROUTE=escalate\n");
  });
  it("strip is exact: one marker + at most one following space, via round-tripped decoded text", () => {
    expect(dec("OBJECTION: hi")).toBe("hi");
    expect(dec("OBJECTION:hi")).toBe("hi");
    expect(dec("OBJECTION:  hi")).toBe(" hi");                 // only one space stripped, one survives
    expect(dec("OBJECTION: a OBJECTION: b")).toBe("a OBJECTION: b"); // only the leading marker stripped
  });
  it("empty prose after the marker → objection route with empty TEXT", () => {
    const p1 = extractQuestionPayload({ event: "question", message: "OBJECTION:" }, 0)!;
    expect(p1).toContain("ROUTE=objection\n");
    expect(parseQuestionPayload(p1).text).toBe("");
    const p2 = extractQuestionPayload({ event: "question", message: "OBJECTION: " }, 0)!;
    expect(parseQuestionPayload(p2).text).toBe("");
  });
  it("round-trip extract→parse preserves objection route + stripped multiline text", () => {
    const payload = extractQuestionPayload({ event: "question", message: "OBJECTION: nope\nsecond line" }, 0)!;
    const p = parseQuestionPayload(payload);
    expect(p.route).toBe("objection");
    expect(p.text).toBe("nope\nsecond line");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/perform-questions.test.ts`
Expected: FAIL — the objection cases fail because `extractQuestionPayload` still emits `ROUTE=escalate` for an `OBJECTION:` message and `parseQuestionPayload` narrows `objection` to `escalate`.

- [ ] **Step 3: Widen the `ClaimRoute` type**

In `src/core/performQuestions.ts:27` replace:

```typescript
export type ClaimRoute = "verify" | "escalate";
```

with:

```typescript
export type ClaimRoute = "verify" | "escalate" | "objection";
```

- [ ] **Step 4: Make `parseQuestionPayload`'s route branch three-way**

In `src/core/performQuestions.ts:50` replace:

```typescript
  const route: ClaimRoute = (first("ROUTE") ?? "escalate") === "verify" ? "verify" : "escalate";
```

with:

```typescript
  const rawRoute = first("ROUTE") ?? "escalate";
  const route: ClaimRoute = rawRoute === "verify" ? "verify" : rawRoute === "objection" ? "objection" : "escalate";
```

- [ ] **Step 5: Detect + strip the `OBJECTION:` marker in `extractQuestionPayload`**

In `src/core/performQuestions.ts:168-177` replace the whole function body:

```typescript
export function extractQuestionPayload(ev: OutboxEvent, askedAt: number): string | null {
  if (!validateQuestionLine(ev)) return null;
  const message = ev.message as string;
  const encoded = message.split("\n").join("%0A");
  const claim = ev.claim as { kind?: string; value?: string } | undefined;
  const kind = claim && typeof claim.kind === "string" ? claim.kind : "";
  const value = claim && typeof claim.value === "string" ? claim.value : "";
  const route = claim ? "verify" : "escalate";
  return `TEXT=${encoded}\nCLAIM_KIND=${kind}\nCLAIM_VALUE=${value}\nROUTE=${route}\nASKED_AT=${askedAt}\n`;
}
```

with:

```typescript
export function extractQuestionPayload(ev: OutboxEvent, askedAt: number): string | null {
  if (!validateQuestionLine(ev)) return null;
  let message = ev.message as string;
  const claim = ev.claim as { kind?: string; value?: string } | undefined;
  // Claim-wins precedence: a claim is always `verify`; the OBJECTION: marker is consulted ONLY on
  // the no-claim side, widening the prior two-way discriminant on its else branch only.
  const route: ClaimRoute = claim ? "verify" : /^OBJECTION:/.test(message) ? "objection" : "escalate";
  if (route === "objection") message = message.replace(/^OBJECTION: ?/, ""); // strip one marker + at most one space
  const encoded = message.split("\n").join("%0A");
  const kind = claim && typeof claim.kind === "string" ? claim.kind : "";
  const value = claim && typeof claim.value === "string" ? claim.value : "";
  return `TEXT=${encoded}\nCLAIM_KIND=${kind}\nCLAIM_VALUE=${value}\nROUTE=${route}\nASKED_AT=${askedAt}\n`;
}
```

Note: `validateQuestionLine(ev)` still runs against the **raw** message, so `"OBJECTION:"` (non-empty) passes validation and strips to `""` — the empty-prose case the tests pin.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/perform-questions.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 7: Commit**

```bash
git add src/core/performQuestions.ts tests/perform-questions.test.ts
git commit -m "feat(perform): add objection route to the question protocol (OBJECTION: marker)"
```

---

### Task 2: `performTurn.ts` — teach parts the objection clause

**Files:**
- Modify: `src/core/performTurn.ts` (`blockers()` ~line 32-51; `composeDagUnitPrompt` ~line 108-144)
- Test: `tests/perform-turn.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/perform-turn.test.ts`, inside the existing `describe("perform test-command auto-detect", ...)` block, append after the `blockers()` test (line 26):

```typescript
  it("blockers() carries the objection clause (OBJECTION: marker, omit claim)", () => {
    expect(blockers("")).toContain('"OBJECTION:"');
    expect(blockers("")).toMatch(/PLAN ITSELF is wrong/);
    expect(blockers("pytest")).toContain('"OBJECTION:"');
  });
```

In the same file, inside `describe("composeDagUnitPrompt", ...)`, append after the branch-discipline test (line 114):

```typescript
  it("carries the blockers/objection protocol so DAG parts can ask AND object", () => {
    expect(p).toContain("BLOCKERS / QUESTIONS");
    expect(p).toContain('{"event":"question"');
    expect(p).toContain('"OBJECTION:"');
    expect(p).toContain('{"event":"ack"');
    // still carries the terminal done/error reporting block, before the question protocol
    expect(p).toContain('{"event":"done"}');
    expect(p).toContain('{"event":"error", "reason":"..."}');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/perform-turn.test.ts`
Expected: FAIL — `blockers()` has no `OBJECTION:` text; `composeDagUnitPrompt` has no `BLOCKERS / QUESTIONS` block.

- [ ] **Step 3: Add the objection clause to `blockers()`**

In `src/core/performTurn.ts`, in the `blockers()` return expression, insert the objection clause immediately **after** the `Omit the "claim" object ...` line and **before** the `- The Maestro verifies the claim ...` line:

```typescript
    '  Omit the "claim" object for a judgment question (no ground-truth to check).\n' +
    "- If you believe the PLAN ITSELF is wrong — a design flaw, a contradiction,\n" +
    "  or an approach that will not work (NOT a missing referent) — do NOT\n" +
    "  silently implement it. Halt and append ONE question whose message begins\n" +
    '  "OBJECTION:" explaining why, OMIT the "claim" object, then stop. The\n' +
    "  Maestro will revise the plan or tell you to proceed.\n" +
    "- The Maestro verifies the claim and replies via your inbox.md, then re-engages you.\n" +
```

- [ ] **Step 4: Append `blockers("")` to `composeDagUnitPrompt`**

In `src/core/performTurn.ts` `composeDagUnitPrompt`, the array currently ends:

```typescript
    "- If your work genuinely needs a fresh branch, abort with",
    '  {"event":"error","reason":"branch-discipline: needed new branch"}',
    "  and let the conductor decide.",
  ].join("\n");
```

Insert `blockers("")` **before** the `BRANCH DISCIPLINE (hard rule):` line (per the spec's explicit placement: after the done/error reporting line, before BRANCH DISCIPLINE). Locate this block in the array:

```typescript
    'Report status via outbox: emit {"event":"done"} when all tasks are',
    'complete and verified. Emit {"event":"error", "reason":"..."} on any',
    "unrecoverable failure.",
    "",
    "BRANCH DISCIPLINE (hard rule):",
```

and change it to:

```typescript
    'Report status via outbox: emit {"event":"done"} when all tasks are',
    'complete and verified. Emit {"event":"error", "reason":"..."} on any',
    "unrecoverable failure.",
    "",
    blockers(""),
    "",
    "BRANCH DISCIPLINE (hard rule):",
```

`blockers` is already defined and exported above `composeDagUnitPrompt` in the same file, so it is in scope. (Note: this places `blockers` *before* BRANCH DISCIPLINE per the spec text; `composeRound1Prompt` lists them in the opposite order, but order does not affect behavior or any test — both blocks are present.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/perform-turn.test.ts`
Expected: PASS. The existing `composeDagUnitPrompt` "carries no stale rebrand tokens" test still passes (`OBJECTION:` introduces none).

- [ ] **Step 6: Commit**

```bash
git add src/core/performTurn.ts tests/perform-turn.test.ts
git commit -m "feat(perform): invite plan objections in part prompts (single + DAG)"
```

---

### Task 3: `turnWaitWith` — persist the single-repo objection cap

**Files:**
- Modify: `src/commands/perform.ts` (import line 22; new helper ~line 42; `turnWaitWith` ~line 221-228)
- Test: `tests/perform-turn-cmd.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/perform-turn-cmd.test.ts`, inside `describe("perform turn-wait (rc 0 always; TS= carries the outcome)", ...)`, append after the existing "question with no message" test (line 184):

```typescript
  it("objection question (no claim, OBJECTION: message) → ROUTE=objection payload + OBJECTIONS=1", async () => {
    const art = seedWait();
    writeFileSync(outboxPath("tutti", "codex", TOPIC), '{"event":"question","message":"OBJECTION: bad plan"}\n');
    await turnWaitWith(TOPIC, 1, waitDeps({ wait: async () => ({ event: "question", message: "OBJECTION: bad plan" }) }));
    const stateText = readFileSync(join(art, "turn-tutti-1.txt"), "utf8");
    expect(stateText).toContain("TS=question\n");
    expect(stateText).toContain("OBJECTIONS=1\n");
    const payload = readFileSync(join(art, "question-tutti-1.txt"), "utf8");
    expect(payload).toContain("ROUTE=objection\n");
    expect(payload).toContain("TEXT=bad plan\n");
  });

  it("objection cap increments across re-arms (persisted, latest-line-wins)", async () => {
    const art = seedWait();
    writeFileSync(join(art, "turn-tutti-1.txt"), "OFFSET=10\nOBJECTIONS=1\n"); // a prior objection this round
    writeFileSync(outboxPath("tutti", "codex", TOPIC), '{"event":"question","message":"OBJECTION: still bad"}\n');
    await turnWaitWith(TOPIC, 1, waitDeps({ wait: async () => ({ event: "question", message: "OBJECTION: still bad" }) }));
    expect(readFileSync(join(art, "turn-tutti-1.txt"), "utf8")).toContain("OBJECTIONS=2\n");
  });

  it("escalate question (no claim, no marker) → TS=question but NO OBJECTIONS line", async () => {
    const art = seedWait();
    writeFileSync(outboxPath("tutti", "codex", TOPIC), '{"event":"question","message":"which fallback?"}\n');
    await turnWaitWith(TOPIC, 1, waitDeps({ wait: async () => ({ event: "question", message: "which fallback?" }) }));
    const stateText = readFileSync(join(art, "turn-tutti-1.txt"), "utf8");
    expect(stateText).toContain("TS=question\n");
    expect(stateText).not.toContain("OBJECTIONS=");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/perform-turn-cmd.test.ts`
Expected: FAIL — no `OBJECTIONS=` line is written today.

- [ ] **Step 3: Import `parseQuestionPayload`**

In `src/commands/perform.ts:22` replace:

```typescript
import { extractQuestionPayload } from "../core/performQuestions.js";
```

with:

```typescript
import { extractQuestionPayload, parseQuestionPayload } from "../core/performQuestions.js";
```

- [ ] **Step 4: Add the `latestObjections` helper**

In `src/commands/perform.ts`, immediately after the `partModel` function (ends ~line 42), add:

```typescript
/** The LAST `OBJECTIONS=<n>` count persisted in a per-dispatch state file (0 if absent). The
 *  objection cap reads + increments this on every re-arm so the count survives the background-task
 *  re-entry that drives the re-armed wait. Latest-line-wins, mirroring parseLatestOffset. */
function latestObjections(stateFile: string): number {
  if (!existsSync(stateFile)) return 0;
  const ms = [...readFileSync(stateFile, "utf8").matchAll(/^OBJECTIONS=(\d+)\s*$/gm)];
  return ms.length ? Number(ms[ms.length - 1][1]) : 0;
}
```

- [ ] **Step 5: Append `OBJECTIONS=` on an objection in `turnWaitWith`**

In `src/commands/perform.ts` `turnWaitWith`, the question branch (lines 221-228) currently reads:

```typescript
  if (ts === "question" && ev) {
    const payload = extractQuestionPayload(ev, d.now());
    if (payload !== null) {
      atomicWrite(join(art, `question-${PART}-${round}.txt`), payload);
      const bumped = outboxOffset(outboxPath(PART, model, topic));
      appendFileSync(stateFile, `OFFSET=${bumped}\nTS=question\n`);
    } else { ts = "failed"; appendFileSync(stateFile, "TS=failed\n"); log.warn("[turn-wait] malformed question (no message); downgraded to failed"); }
  } else appendFileSync(stateFile, `TS=${ts}\n`);
```

Change the `if (payload !== null)` body to compute and append the cap line:

```typescript
  if (ts === "question" && ev) {
    const payload = extractQuestionPayload(ev, d.now());
    if (payload !== null) {
      atomicWrite(join(art, `question-${PART}-${round}.txt`), payload);
      const bumped = outboxOffset(outboxPath(PART, model, topic));
      const objLine = parseQuestionPayload(payload).route === "objection"
        ? `OBJECTIONS=${latestObjections(stateFile) + 1}\n` : "";
      appendFileSync(stateFile, `OFFSET=${bumped}\nTS=question\n${objLine}`);
    } else { ts = "failed"; appendFileSync(stateFile, "TS=failed\n"); log.warn("[turn-wait] malformed question (no message); downgraded to failed"); }
  } else appendFileSync(stateFile, `TS=${ts}\n`);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/perform-turn-cmd.test.ts`
Expected: PASS (existing verify-question test still green; the three new cases pass).

- [ ] **Step 7: Commit**

```bash
git add src/commands/perform.ts tests/perform-turn-cmd.test.ts
git commit -m "feat(perform): persist the single-repo objection cap (OBJECTIONS=)"
```

---

### Task 4: `waveWaitWith`/`waveWaitRun` — multi-repo parity (dispatch + question route)

**Files:**
- Modify: `src/commands/perform.ts` (`waveWaitRun` ~line 647-651; `waveWaitWith` ~line 653-667)
- Test: `tests/perform-wave-wait.test.ts`

**Depends on Task 3** (same file): this task's `waveWaitWith` reuses the `latestObjections` helper and the `parseQuestionPayload` import added in Task 3. Do Task 3 first.

- [ ] **Step 1: Update the existing wave-wait tests for the new signature, then add the new cases**

`waveWaitWith` gains a required `dispatch` positional (5th) and an optional `since` (last). Edit `tests/perform-wave-wait.test.ts`:

1. **Add imports.** Change line 7-12 imports to also pull the outbox helpers:

```typescript
import { performArtDir } from "../src/core/perform.js";
import { scaledTimeout, parseLatestOffset } from "../src/core/scoreTurn.js";
import { outboxPath, outboxOffset, outboxWaitSince } from "../src/core/ipc.js";
import type { OutboxEvent } from "../src/core/ipc.js";
import { dirname } from "node:path";
import {
  run as performRun, waveWaitWith, type PerformWaitDeps,
} from "../src/commands/perform.js";
```

2. **Sweep every `waveWaitWith(TOPIC, INSTR, PROVIDER, d)` call to insert `0` (dispatch) before `d`.** There are 8 such calls (lines 48, 59, 69, 78, 87, 95, 107, 116) plus the missing-art-dir call at 123. Each becomes `waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d)` (and line 123: `waveWaitWith("no-such-topic", INSTR, PROVIDER, 0, d)`).

3. **Update the wait-call assertion (lines 93-102)** so the event-set includes `question` and the call passes dispatch:

```typescript
  it("wait is called with offset===0 and events [done,error,question] on first dispatch", async () => {
    const { d, calls } = waitDeps({ event: "done" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(calls).toHaveLength(1);
    expect(calls[0].off).toBe(0);
    expect(calls[0].ev).toEqual(["done", "error", "question"]);
    expect(calls[0].i).toBe(INSTR);
    expect(calls[0].m).toBe(PROVIDER);
    expect(calls[0].t).toBe(TOPIC);
  });
```

4. **The field-order pin (lines 104-111) is unchanged for `TS=ok`** — only insert the dispatch arg in the call:

```typescript
  it("field order: TS / INSTRUMENT / PROVIDER / TOPIC then extras (TS=ok unchanged)", async () => {
    const art = performArtDir(TOPIC);
    const { d } = waitDeps({ event: "done" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(readFileSync(waveFile(art), "utf8")).toBe(
      `TS=ok\nINSTRUMENT=${INSTR}\nPROVIDER=${PROVIDER}\nTOPIC=${TOPIC}\nEVENT=done\n`,
    );
  });
```

5. **Fix the two runner-arg-validation tests (lines 126-132)** — the verb now requires `<dispatch>`:

```typescript
  it("runner arg validation: missing provider → rc 2", async () => {
    expect(await performRun(["wave-wait", TOPIC, INSTR])).toBe(2);
  });

  it("runner arg validation: missing dispatch → rc 2", async () => {
    expect(await performRun(["wave-wait", TOPIC, INSTR, PROVIDER])).toBe(2);
  });

  it("runner arg validation: bad topic 'Bad_Topic' (with dispatch) → rc 2", async () => {
    expect(await performRun(["wave-wait", "Bad_Topic", INSTR, PROVIDER, "0"])).toBe(2);
  });
```

6. **Add the new behavior cases** (append inside the `describe` block):

```typescript
  it("question event with OBJECTION: → TS=question, payload + per-dispatch offset file (wave identity)", async () => {
    const art = performArtDir(TOPIC);
    const ob = outboxPath(INSTR, PROVIDER, TOPIC);
    mkdirSync(dirname(ob), { recursive: true });
    writeFileSync(ob, '{"event":"question","message":"OBJECTION: bad slice"}\n'); // seed so the bump is non-zero
    const { d } = waitDeps({ event: "question", message: "OBJECTION: bad slice" });
    const rc = await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(rc).toBe(0);
    expect(readFileSync(waveFile(art), "utf8")).toBe(
      `TS=question\nINSTRUMENT=${INSTR}\nPROVIDER=${PROVIDER}\nTOPIC=${TOPIC}\nEVENT=question\n`,
    );
    expect(readFileSync(join(art, `question-${INSTR}-0.txt`), "utf8")).toContain("ROUTE=objection\n");
    const dispatchText = readFileSync(join(art, `wave-${INSTR}-0.txt`), "utf8");
    expect(dispatchText).toContain("TS=question\n");
    expect(dispatchText).toContain("OBJECTIONS=1\n");
    const bumped = parseLatestOffset(dispatchText);
    expect(bumped).toBe(outboxOffset(ob));     // wave-path identity, not PART/model
    expect(bumped!).toBeGreaterThan(0);
  });

  it("start offset: defaults to 0 on first dispatch; <since> overrides", async () => {
    const { d, calls } = waitDeps({ event: "done" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);          // no since, no dispatch file
    expect(calls[0].off).toBe(0);
    const { d: d2, calls: c2 } = waitDeps({ event: "done" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 1, d2, 42);     // since overrides
    expect(c2[0].off).toBe(42);
  });

  it("escalate question (no claim, no marker) → TS=question but NO OBJECTIONS line", async () => {
    const art = performArtDir(TOPIC);
    const ob = outboxPath(INSTR, PROVIDER, TOPIC);
    mkdirSync(dirname(ob), { recursive: true });
    writeFileSync(ob, '{"event":"question","message":"which fallback?"}\n');
    const { d } = waitDeps({ event: "question", message: "which fallback?" });
    await waveWaitWith(TOPIC, INSTR, PROVIDER, 0, d);
    expect(readFileSync(join(art, `wave-${INSTR}-0.txt`), "utf8")).not.toContain("OBJECTIONS=");
  });

  it("real outboxWaitSince: reading PAST a handled question returns the terminal done, not the question", async () => {
    const ob = outboxPath(INSTR, PROVIDER, TOPIC);
    mkdirSync(dirname(ob), { recursive: true });
    const qLine = '{"event":"question","message":"OBJECTION: x"}\n';
    writeFileSync(ob, qLine + '{"event":"done","summary":"ok"}\n');
    const hit = await outboxWaitSince(INSTR, PROVIDER, TOPIC, Buffer.byteLength(qLine), ["done", "error", "question"], 5);
    expect(hit?.event).toBe("done");
  });

  it("real outboxWaitSince: a handled question BELOW the offset is not re-returned", async () => {
    const ob = outboxPath(INSTR, PROVIDER, TOPIC);
    mkdirSync(dirname(ob), { recursive: true });
    const qLine = '{"event":"question","message":"OBJECTION: x"}\n';
    writeFileSync(ob, qLine); // only the handled question, nothing after it
    const hit = await outboxWaitSince(INSTR, PROVIDER, TOPIC, Buffer.byteLength(qLine), ["done", "error", "question"], 1);
    expect(hit).toBeNull(); // nothing past the bump → no re-handle (1s poll, then null)
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/perform-wave-wait.test.ts`
Expected: FAIL — `waveWaitWith` does not accept a `dispatch` arg, does not wait on `question`, and writes no per-dispatch offset file.

- [ ] **Step 3: Update `waveWaitRun`**

The top-level `usage()` (line 48) lists verb *names* only (no per-verb arg lists), so it needs no change — `wave-wait` already appears there. The full arg list lives in `waveWaitRun`'s own usage line, updated below.

Replace `waveWaitRun` (lines 647-651):

```typescript
async function waveWaitRun(rest: string[]): Promise<number> {
  const [topic, instrument, provider] = rest;
  if (!topic || !instrument || !provider) { log.error("usage: perform wave-wait <topic> <instrument> <provider>"); return 2; }
  if (!assertPerformTopic(topic) || !/^[a-z0-9_-]+$/.test(instrument) || !/^[a-z0-9_-]+$/.test(provider)) { log.error("perform wave-wait: bad topic/instrument/provider"); return 2; }
  return waveWaitWith(topic, instrument, provider, liveWaitDeps);
}
```

with:

```typescript
async function waveWaitRun(rest: string[]): Promise<number> {
  const [topic, instrument, provider, dispatchStr, sinceStr] = rest;
  if (!topic || !instrument || !provider || !dispatchStr) { log.error("usage: perform wave-wait <topic> <instrument> <provider> <dispatch> [<since>]"); return 2; }
  if (!assertPerformTopic(topic) || !/^[a-z0-9_-]+$/.test(instrument) || !/^[a-z0-9_-]+$/.test(provider)) { log.error("perform wave-wait: bad topic/instrument/provider"); return 2; }
  if (!/^[0-9]+$/.test(dispatchStr)) { log.error("perform wave-wait: dispatch must be a non-negative integer"); return 2; }
  if (sinceStr !== undefined && !/^[0-9]+$/.test(sinceStr)) { log.error("perform wave-wait: since must be a non-negative integer"); return 2; }
  return waveWaitWith(topic, instrument, provider, Number(dispatchStr), liveWaitDeps, sinceStr !== undefined ? Number(sinceStr) : undefined);
}
```

- [ ] **Step 4: Rewrite `waveWaitWith` to read the dispatch offset, wait on `question`, and write the per-dispatch state**

Replace `waveWaitWith` (lines 653-667):

```typescript
export async function waveWaitWith(topic: string, instrument: string, provider: string, d: PerformWaitDeps): Promise<number> {
  const art = performArtDir(topic);
  if (!existsSync(art)) { log.error(`perform wave-wait: _perform art-dir missing for ${topic}`); return 1; }
  const timeout = scaledTimeout(PERFORM_WAVE_TIMEOUT(), d.multiplier(provider));
  log.info(`[wave-wait] ${instrument} timeout=${timeout}s`);
  const ev = await d.wait(instrument, provider, topic, 0, ["done", "error"], timeout);
  let ts: string; const extra: string[] = [];
  if (ev === null) { ts = "timeout"; extra.push(`TIMEOUT_S=${timeout}`); log.warn(`[wave-wait] ${instrument} TS=timeout`); }
  else if (ev.event === "done") { ts = "ok"; extra.push("EVENT=done"); log.ok(`[wave-wait] ${instrument} TS=ok`); }
  else if (ev.event === "error") { ts = "failed"; extra.push("EVENT=error", `REASON=${typeof ev.reason === "string" ? ev.reason : ""}`); log.error(`[wave-wait] ${instrument} TS=failed`); }
  else { ts = "failed"; extra.push("EVENT=unknown"); log.error(`[wave-wait] ${instrument} TS=failed (unknown event)`); }
  atomicWrite(join(art, `wave-${instrument}.txt`), `TS=${ts}\nINSTRUMENT=${instrument}\nPROVIDER=${provider}\nTOPIC=${topic}\n` + extra.map((l) => l + "\n").join(""));
  writeFileSync(join(art, `wave-${instrument}.done`), "");
  return 0;
}
```

with:

```typescript
export async function waveWaitWith(topic: string, instrument: string, provider: string, dispatch: number, d: PerformWaitDeps, since?: number): Promise<number> {
  const art = performArtDir(topic);
  if (!existsSync(art)) { log.error(`perform wave-wait: _perform art-dir missing for ${topic}`); return 1; }
  const dispatchFile = join(art, `wave-${instrument}-${dispatch}.txt`);
  // Start offset: an explicit <since> (a re-arm past a handled question) wins; else the latest
  // OFFSET= persisted for this dispatch; else 0 (first wait of the dispatch).
  const startOffset = since ?? (existsSync(dispatchFile) ? (parseLatestOffset(readFileSync(dispatchFile, "utf8")) ?? 0) : 0);
  const timeout = scaledTimeout(PERFORM_WAVE_TIMEOUT(), d.multiplier(provider));
  log.info(`[wave-wait] ${instrument} dispatch=${dispatch} offset=${startOffset} timeout=${timeout}s`);
  const ev = await d.wait(instrument, provider, topic, startOffset, ["done", "error", "question"], timeout);
  let ts: string; const extra: string[] = [];
  if (ev === null) { ts = "timeout"; extra.push(`TIMEOUT_S=${timeout}`); log.warn(`[wave-wait] ${instrument} TS=timeout`); }
  else if (ev.event === "done") { ts = "ok"; extra.push("EVENT=done"); log.ok(`[wave-wait] ${instrument} TS=ok`); }
  else if (ev.event === "error") { ts = "failed"; extra.push("EVENT=error", `REASON=${typeof ev.reason === "string" ? ev.reason : ""}`); log.error(`[wave-wait] ${instrument} TS=failed`); }
  else if (ev.event === "question") {
    const payload = extractQuestionPayload(ev, d.now());
    if (payload !== null) {
      ts = "question";
      atomicWrite(join(art, `question-${instrument}-${dispatch}.txt`), payload);
      const bumped = outboxOffset(outboxPath(instrument, provider, topic)); // wave-path identity
      const objLine = parseQuestionPayload(payload).route === "objection"
        ? `OBJECTIONS=${latestObjections(dispatchFile) + 1}\n` : "";
      appendFileSync(dispatchFile, `OFFSET=${bumped}\nTS=question\n${objLine}`);
      extra.push("EVENT=question");
      log.ok(`[wave-wait] ${instrument} TS=question`);
    } else { ts = "failed"; extra.push("EVENT=question-malformed"); log.warn(`[wave-wait] ${instrument} malformed question; TS=failed`); }
  }
  else { ts = "failed"; extra.push("EVENT=unknown"); log.error(`[wave-wait] ${instrument} TS=failed (unknown event)`); }
  atomicWrite(join(art, `wave-${instrument}.txt`), `TS=${ts}\nINSTRUMENT=${instrument}\nPROVIDER=${provider}\nTOPIC=${topic}\n` + extra.map((l) => l + "\n").join(""));
  writeFileSync(join(art, `wave-${instrument}.done`), "");
  return 0;
}
```

Key invariants this preserves: `wave-${instrument}.txt` keeps its byte layout for ok/error/timeout (the offset lives only in `wave-${instrument}-${dispatch}.txt`); the bump uses `outboxPath(instrument, provider, topic)` (wave identity, not `PART`/`model`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/perform-wave-wait.test.ts`
Expected: PASS (all swept + new cases).

- [ ] **Step 6: Run the whole suite to catch any other caller of `waveWaitWith`**

Run: `npm run test`
Expected: PASS. (`liveWaitDeps` and `PerformWaitDeps` are unchanged; only callers of `waveWaitWith`/the verb changed. The orchestration in `commands/perform.md` is not yet updated — that is Task 5 — but no compiled code calls `waveWaitWith` with the old arity.)

- [ ] **Step 7: Commit**

```bash
git add src/commands/perform.ts tests/perform-wave-wait.test.ts
git commit -m "feat(perform): wave-path question route + per-dispatch offset/cap parity"
```

---

### Task 5: `commands/perform.md` — Maestro orchestration (suite-as-gate)

**Files:**
- Modify: `commands/perform.md` Stage 1 step 3 (single-repo, ~lines 183-196); Stage 3a (~lines 256-275); Stage 3b (~lines 288-332); Stage 3d (~lines 355-380)

These are uncompiled prose: there is **no automated control-flow test**. The gate is the stale-token test (Task 6) plus the manual-review checklist below; the real exercise is the live dogfood.

- [ ] **Step 1: Single-repo — add the `ROUTE=objection` branch (Stage 1 step 3)**

In the `TS=question` block (after the `ROUTE=escalate` bullet, before the **Re-arm** bullet), insert:

```markdown
     - **`ROUTE=objection`** — the part believes the plan is wrong. Read the latest `OBJECTIONS=`
       line from `$ART/turn-tutti-<ROUND>.txt`.
       - If `OBJECTIONS >= 3` (the cap of 2 is exceeded): **force-escalate** — handle exactly like
         `ROUTE=escalate` above (AskUserQuestion with the decoded `TEXT`; deliver the answer). Do
         NOT offer Revise/Override again.
       - Otherwise render the decoded `TEXT` (if it is empty, render "the part objects to the plan
         (no detail given)") and **AskUserQuestion** ("Revise the plan / Override (proceed as
         planned) / Abort"):
         - *Revise* — **Edit** `$ART/design.md` and/or `$ART/plan.md` to address the objection, then
           write a reply to a temp file (`From: maestro`, then "Plan updated — re-read the plan and
           continue.") and deliver it: `$CS send --from maestro tutti "$TOPIC" @<reply-file>`.
         - *Override* — write a reply (`From: maestro`, then "Proceeding as planned: <your reason>.
           Resume implementation.") and deliver it the same way.
         - *Abort* — `$CS coda <TOPIC>` then `$CS perform archive <TOPIC>`; stop.
```

Confirm the existing **Re-arm** bullet (re-run the background `turn-wait <TOPIC> <ROUND>`) is reached by all three routes (verify/escalate/objection), so the just-handled question sits below the bumped `OFFSET=`.

- [ ] **Step 2: Multi-repo — thread the `<dispatch>` token into the wave verb (Stage 3b)**

In Stage 3b, where the per-wave barrier fires `wave-wait` (the background `Bash(command='$CS perform wave-wait ...')`), initialize a per-part dispatch counter when the part is first dispatched in a wave (`DISPATCH=0`) and pass it:

```markdown
   Bash(command='$CS perform wave-wait "$TOPIC" "$INSTRUMENT" "$PROVIDER" "$DISPATCH"', run_in_background: true,
        description="maestro await <INSTRUMENT> wave <W> dispatch <DISPATCH>")
```

- [ ] **Step 3: Multi-repo — add the `TS=question` branch + barrier reconciliation (Stage 3b)**

Where the barrier reads each part's first `TS=` line from `$ART/wave-<instrument>.txt`, replace the two-way ok/failed partition with a three-way one and add the question handler:

```markdown
On each wave-completion notification, read every part's first `TS=` from `$ART/wave-<instrument>.txt`
and partition into { ok, failed|timeout, question }:
- For each **`TS=question`** part:
  1. Read `$ART/question-<instrument>-<DISPATCH>.txt` (KV: `TEXT=`/`CLAIM_KIND=`/`CLAIM_VALUE=`/`ROUTE=`).
  2. Handle by `ROUTE`, exactly as single-repo Stage 1 step 3 (verify → mechanical reply; escalate →
     AskUserQuestion; objection → read `OBJECTIONS=` from `$ART/wave-<instrument>-<DISPATCH>.txt`,
     cap-of-2 then Revise/Override/Abort). Deliver the reply via `$CS send`.
  3. Read the bumped offset (`OFFSET=`) from `$ART/wave-<instrument>-<DISPATCH>.txt`, increment the
     part's dispatch token (`DISPATCH=$((DISPATCH+1))`), and re-fire in the background:
     `$CS perform wave-wait "$TOPIC" "<instrument>" "<provider>" "$DISPATCH" "<bumped-offset>"`.
  4. Keep this part **out** of the completion set — it is still in flight.
- The wave is **complete only when every part is terminal** (`ok` | `failed` | `timeout`). Parts that
  are already `TS=ok` wait at the barrier until the questioning part terminates.
- Evaluate the `WAVE_RETRY` proceed-degraded ladder **only after** all parts reach a terminal `TS=`.
```

- [ ] **Step 4: Multi-repo — make Stage 3a and Stage 3d non-deaf to `TS=question`**

In Stage 3a, add one sentence so any `TS=question` from a preflight/early wave routes through the Stage 3b handler. In Stage 3d (the fix-loop barrier), add the **same** `TS=question` branch as Step 3 (read payload, handle by route with the cap, re-arm with an incremented `<DISPATCH>` + the bumped offset, keep the part out of the completion set until terminal) so a fix-round objection does not hang the loop:

```markdown
On the fix-round completion, read `$ART/wave-<instrument>.txt`. A **`TS=question`** is handled like
Stage 3b's question branch (route dispatch + cap + per-dispatch re-arm); only a terminal `TS=ok`
re-runs Stage 3c verification, and `TS=failed`/`timeout` continues the existing round ladder.
```

- [ ] **Step 5: Manual-review checklist (the gate for this task)**

Verify by reading the edited `commands/perform.md`:
- [ ] Stage 1 step 3 has all three routes (verify/escalate/objection); objection has the cap check and Revise/Override/Abort.
- [ ] Stage 3b passes `<DISPATCH>` to `wave-wait` and re-arms with `<DISPATCH+1>` + the bumped offset.
- [ ] Stage 3b declares the wave complete only when all parts are terminal; `WAVE_RETRY` is evaluated after.
- [ ] Stage 3a and Stage 3d both route `TS=question` through the handler.
- [ ] No banned tokens introduced (`clone-wars`/`cw_`/`master-yoda`/`MISSION ACCOMPLISHED`/`@cw_`).

- [ ] **Step 6: Run the stale-token gate + full suite (nothing should regress)**

Run: `npx vitest run tests/stale-tokens.test.ts && npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add commands/perform.md
git commit -m "feat(perform): orchestrate objections (Stage 1.3 + wave Stages 3a/3b/3d)"
```

---

### Task 6: Full gate + bundle rebuild

**Files:**
- Modify: `dist/consort.cjs` (rebuilt)

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: typecheck clean, lint clean, all test files pass.

- [ ] **Step 2: Rebuild the committed bundle**

Run: `npm run build`
Expected: esbuild writes `dist/consort.cjs` with no error.

- [ ] **Step 3: Smoke-test the new verb wiring**

Run: `node dist/consort.cjs perform wave-wait`
Expected: prints `usage: perform wave-wait <topic> <instrument> <provider> <dispatch> [<since>]` to stderr and exits rc 2.

- [ ] **Step 4: Commit the rebuilt bundle**

```bash
git add dist/consort.cjs
git commit -m "build(perform): rebuild dist with the plan-objection channel"
```

- [ ] **Step 5: Final verification**

Run: `npm run typecheck && npm run lint && npm run test && npm run build && git status --short`
Expected: all green; `git status --short` shows only the two untracked `target-user-analysis.*` files (unrelated; do **not** commit them).

---

## Notes for the implementer

- **Do not commit** `target-user-analysis.md` / `target-user-analysis.html` — they are an unrelated leftover; every `git add` in this plan names explicit paths to avoid sweeping them in.
- **Frozen protocol:** never add/rename an event or a frozen JSON field. `OBJECTION:`, `ROUTE=objection`, `OBJECTIONS=`, and `<dispatch>` are conductor-only — content inside the frozen `message`, or KV inside `_perform/` state files. Keep new comments free of banned tokens.
- **The live dogfood** (a real single-repo then multi-repo perform run where a part emits `{"event":"question","message":"OBJECTION: ..."}`) is the true test of the Task 5 prose; it is a post-merge manual step, not part of the automated gate.
