# consort `score` — Phase D: cross-verify → adjudicate → synthesize → design walk → audit (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the single-repo escalation pipeline — cross-verify each part's rivals' claims,
adjudicate the verdicts into a 5-tier draft, resolve PENDING, synthesize per-section seeds, drive the
interactive design walk, and assemble through the deploy-audit gate — ending in a **live dogfood** that
takes a real ensemble all the way to a perform-ready design doc.

**Architecture:** Adds the verify half to `core/scoreTurn.ts` (mirror of the research half), a pure
verify-scope helper + synthesize-seed builder, and four `score` subcommands (`verify-send`,
`verify-wait`, `adjudicate`, `synthesize`) that wire the already-built pure modules
(`scoreAdjudicate.adjudicate`, `scoreDoc`, `audit`, `scoreWalk`) onto the foundation IPC primitives.
The interactive walk + audit-retry are directive-driven (`commands/score.md` Stages 7–12); the CLI only
exposes mechanical helpers (`synthesize`, `assemble`, `walk-state`). Mechanical work in the CLI, judgment
(Read/Write/Edit/AskUserQuestion) in the directive (D10).

**Tech Stack:** TypeScript (ES2022/NodeNext/strict), vitest, esbuild → committed `dist/consort.cjs`.
Behavioral source: clone-wars `bin/consult-verify-send.sh`, `lib/consult-wait.sh` (verify branch),
`bin/consult-adjudicate.sh`, `bin/consult-synthesize.sh`, `bin/consult-walk-assemble.sh`,
`lib/consult-walk.sh`, `config/prompt-templates/consult/verify.md`, `lib/consult.sh`
(`cw_consult_write_adjudicated`).

---

## Scope (this plan)

**In (single-repo):** `score verify-send`, `score verify-wait` (`VS=` machine + `VS=skipped`
short-circuit + question relay), `score adjudicate`, `score synthesize`, `score walk-state` (resume),
`score assemble` extended to emit `SECTION=` on audit FAIL; `core/scoreTurn.ts` verify half;
`core/score.ts` `verifyScopeFiles` + `lastTag`; `core/scoreDoc.ts` `synthesizeSeeds`;
`commands/score.md` Stages 7–12 (replace the Phase C "Phase C ends here" stub); rebuilt `dist`; a full
escalated single-repo dogfood.

**Out:** multi-repo detect + execution-DAG + 8-section walk (**Phase E**); drilldown, forensics,
teardown, `present` (**Phase F**). The walk drafts only the **6 single-repo sections**; the 2 multi
extras stay Phase E. `score assemble` already exists (Phase B) — only extended, not rebuilt.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/scoreTurn.ts` | add `composeVerifyPrompt`, `verifyState` | modify |
| `src/core/score.ts` | add `verifyScopeFiles`, `lastTag` | modify |
| `src/core/scoreDoc.ts` | add `synthesizeSeeds` (+ `SECTION_HEADINGS` if useful) | modify |
| `src/commands/score.ts` | add `verify-send`/`verify-wait`/`adjudicate`/`synthesize`/`walk-state`; extend `assemble` (`SECTION=`) | modify |
| `commands/score.md` | Stages 7–12 (replace the Phase C stub) | modify |
| `tests/score-turn.test.ts` | verify-half cases | modify |
| `tests/score-core.test.ts` | `verifyScopeFiles`, `lastTag` | modify |
| `tests/score-doc.test.ts` | `synthesizeSeeds` | modify |
| `tests/score-escalation.test.ts` | verify-send/wait/adjudicate/synthesize/walk-state | modify |
| `tests/score-assemble.test.ts` | `SECTION=` emission | modify |
| `dist/consort.cjs` | rebuilt | regenerate |
| `docs/superpowers/DOGFOOD.md` | Phase D section | modify |

## Deliberate deviations (faithful behavior; do not "fix")

1. **`VS=skipped` is written by `verify-send`** (empty scope), and `verify-wait` short-circuits on it
   (touch `.done`, no wait) — exactly `consult-wait.sh:43-48`. `verifyState` itself only ever returns
   ok/missing/failed/timeout/question.
2. **verify done → `ok` iff `verify.md` is non-empty, else `missing`** (the `-s` test); no claim-parse
   refinement (research's 4-way is research-only).
3. **Question payload = raw event JSON** (as in research); the relay is directive logic (D5).
4. **`score assemble` gains additive `SECTION=` lines** on FAIL (after the existing `ISSUE=` lines) so
   the directive routes re-walks without hard-coding the `auditIssueToSection` map. The Phase B
   `ISSUE=`/rc contract is unchanged.
5. **synthesize seeds the 6 single-repo sections only** (byte-faithful: clone-wars synthesize never
   seeds the 2 multi extras — they're drafted fresh in the walk; Phase E).

---

### Task 1: `core/scoreTurn.ts` — verify-phase composer + state

**Files:** Modify `src/core/scoreTurn.ts`; Test `tests/score-turn.test.ts`

Port `config/prompt-templates/consult/verify.md` (rebranded, no `END_OF_INSTRUCTION`/done-line) and the
verify branch of `cw_consult_wait`. `composeVerifyPrompt` numbers the items (`nl -ba -w1 -s'. '`).

- [ ] **Step 1: Add failing tests (append to `tests/score-turn.test.ts`)**

```ts
import { composeVerifyPrompt, verifyState } from "../src/core/scoreTurn.js";

describe("verifyState", () => {
  it("null → timeout; question → question; error → failed", () => {
    expect(verifyState(null, "x")).toBe("timeout");
    expect(verifyState({ event: "question", message: "?" }, null)).toBe("question");
    expect(verifyState({ event: "error", reason: "x" }, "x")).toBe("failed");
  });
  it("done → ok iff verify.md non-empty, else missing", () => {
    expect(verifyState({ event: "done", summary: "ok" }, "## Verdicts\n1. AGREE [a:1] x\n")).toBe("ok");
    expect(verifyState({ event: "done", summary: "ok" }, "")).toBe("missing");
    expect(verifyState({ event: "done", summary: "ok" }, null)).toBe("missing");
  });
});

describe("composeVerifyPrompt", () => {
  const p = composeVerifyPrompt("[a:1] claim one\n[b:2] claim two", "/s/viola-codex/verify.md");
  it("numbers the items, names AGREE/DISPUTE/UNCERTAIN + the write path, no fence/rebrand tokens", () => {
    expect(p).toContain("1. [a:1] claim one");
    expect(p).toContain("2. [b:2] claim two");
    expect(p).toMatch(/AGREE/); expect(p).toMatch(/DISPUTE/); expect(p).toMatch(/UNCERTAIN/);
    expect(p).toContain("/s/viola-codex/verify.md");
    expect(p).toContain("## Verdicts");
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
    expect(p).not.toMatch(/master[ -]?yoda|trooper|commander/i);
    expect(p).toContain('"event":"question"');
  });
});
```

- [ ] **Step 2: Run to confirm fail** — `npx vitest run tests/score-turn.test.ts -t verify` → FAIL (not exported).

- [ ] **Step 3: Implement (append to `src/core/scoreTurn.ts`)**

```ts
/** Verify wait outcome → VS= value, ported from cw_consult_wait verify branch (lib/consult-wait.sh):
 *  null → timeout; question → question; done → ok iff verify.md non-empty (the `-s` test) else missing;
 *  any other event → failed. (VS=skipped is written by verify-send on empty scope, not here.) */
export function verifyState(ev: OutboxEvent | null, verifyText: string | null): "ok" | "missing" | "failed" | "timeout" | "question" {
  if (!ev) return "timeout";
  if (ev.event === "question") return "question";
  if (ev.event === "done") return verifyText !== null && verifyText.length > 0 ? "ok" : "missing";
  return "failed";
}

/** Verify-phase prompt body (port of config/prompt-templates/consult/verify.md, rebranded).
 *  Numbers the items (nl -ba -w1 -s'. '). No END_OF_INSTRUCTION/done-line — inboxWrite appends them. */
export function composeVerifyPrompt(itemsText: string, verifyPath: string): string {
  const items = itemsText.split("\n").filter((l) => l.length > 0).map((l, i) => `${i + 1}. ${l}`).join("\n");
  return [
    "You researched a topic in your previous turn. Below are claims the OTHER researchers raised that",
    "you did not. For EACH item, do ONE of:",
    "",
    "  AGREE     — confirm with your own evidence (cite a file/line/source)",
    "  DISPUTE   — explain why it's wrong, with counter-evidence",
    "  UNCERTAIN — you cannot tell from available evidence; say so",
    "",
    "Items to verify:",
    items,
    "",
    `Write your verdicts to ${verifyPath} in this exact format:`,
    "",
    "  # Verify",
    "  ## Verdicts",
    "  1. <TAG> <original [citation] and text>",
    "     <one-line evidence>",
    "  2. ...",
    "",
    "Where <TAG> is one of: AGREE / DISPUTE / UNCERTAIN.",
    "",
    "Verification methods: use any tool in your environment. WebSearch / fetch are authorized when an",
    "item cites a URL, references external standards/docs, or makes a claim local repo evidence cannot",
    "resolve. For URL-cited items, fetching the source is the default. For file-cited items prefer the",
    "local file. If a tool is unavailable, mark the item UNCERTAIN and note the gap — never fabricate.",
    "",
    RESEARCH_BLOCKERS,
  ].join("\n");
}
```

(`RESEARCH_BLOCKERS` already exists in this module — reuse it; the question protocol is identical.)

- [ ] **Step 4: Run** — `npx vitest run tests/score-turn.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(score): scoreTurn verify half (composeVerifyPrompt, verifyState)"`

---

### Task 2: `core/score.ts` — `verifyScopeFiles` + `lastTag`

**Files:** Modify `src/core/score.ts`; Test `tests/score-core.test.ts`

`verifyScopeFiles` (port of `consult-verify-send.sh:64-87`): the bucket filenames where `target` is NOT
a member — every other instrument's `_only_items.txt`, plus (N≥3) every pair `<a>+<b>_only.txt` with
`target ∉ {a,b}`. Order: singles (roster order, skip target), then pairs (i<j). `lastTag` reads the
last `^<TAG>=<val>$` line (for VS= / reused for FS=).

- [ ] **Step 1: Add failing tests (append to `tests/score-core.test.ts`)**

```ts
import { verifyScopeFiles, lastTag } from "../src/core/score.js";

describe("verifyScopeFiles", () => {
  it("N=2: only the other instrument's _only_items.txt", () => {
    expect(verifyScopeFiles("viola", ["viola", "cello"])).toEqual(["cello_only_items.txt"]);
    expect(verifyScopeFiles("cello", ["viola", "cello"])).toEqual(["viola_only_items.txt"]);
  });
  it("N=3: other singles + pairs not containing target (skip consensus + own)", () => {
    expect(verifyScopeFiles("viola", ["viola", "cello", "harp"]))
      .toEqual(["cello_only_items.txt", "harp_only_items.txt", "cello+harp_only.txt"]);
  });
});

describe("lastTag", () => {
  it("returns the last value of the tag; null when absent", () => {
    expect(lastTag("VS=skipped\n", "VS")).toBe("skipped");
    expect(lastTag("OFFSET=1\nVS=question\nOFFSET=9\nVS=ok\n", "VS")).toBe("ok");
    expect(lastTag("OFFSET=1\n", "VS")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm fail** — `npx vitest run tests/score-core.test.ts -t verifyScopeFiles` → FAIL.

- [ ] **Step 3: Implement (append to `src/core/score.ts`)**

```ts
/** Bucket filenames whose verdicts `target` should verify — every file where target is NOT a member
 *  (port of consult-verify-send.sh): others' `<c>_only_items.txt`, then (N>=3) `<a>+<b>_only.txt` with
 *  target ∉ {a,b}. consensus.txt is always excluded (target is a member). */
export function verifyScopeFiles(target: string, instruments: string[]): string[] {
  const out: string[] = [];
  for (const c of instruments) if (c !== target) out.push(`${c}_only_items.txt`);
  if (instruments.length >= 3) {
    for (let i = 0; i < instruments.length; i++) {
      for (let j = i + 1; j < instruments.length; j++) {
        const a = instruments[i], b = instruments[j];
        if (a !== target && b !== target) out.push(`${a}+${b}_only.txt`);
      }
    }
  }
  return out;
}

/** Last `^<tag>=<value>$` value in a KV state file's text; null if absent. */
export function lastTag(text: string, tag: string): string | null {
  const re = new RegExp(`^${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(.*)$`, "gm");
  const ms = [...text.matchAll(re)];
  return ms.length ? ms[ms.length - 1][1].trim() : null;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): verifyScopeFiles + lastTag helpers"`

---

### Task 3: `core/scoreDoc.ts` — `synthesizeSeeds`

**Files:** Modify `src/core/scoreDoc.ts`; Test `tests/score-doc.test.ts`

Port `consult-synthesize.sh:53-91` — 6 single-repo seed drafts from `adjudicated.md`. Each: heading +
blank + seed comment + matched lines (placeholder if none). Patterns: problem `^- \[` (case-sensitive);
goal/architecture/components/success-criteria `^- \[<Tag>` (case-insensitive); testing `^- \[Testing`
OR `^- .*\btest` (case-insensitive). Rebrand the placeholder ("Yoda"→"Maestro", "Step 11"→"the walk").

- [ ] **Step 1: Add failing tests (append to `tests/score-doc.test.ts`)**

```ts
import { synthesizeSeeds } from "../src/core/scoreDoc.js";

describe("synthesizeSeeds", () => {
  const adj = [
    "## Cross-verified",
    "- [src/a.ts:1] [Goal] ship the thing",
    "- [src/b.ts:2] [Architecture] use a queue",
    "- [src/c.ts:3] covers the test path",
    "## Contested",
  ].join("\n");
  const seeds = synthesizeSeeds(adj);
  const get = (s: string) => seeds.find((x) => x.section === s)!.body;
  it("produces the 6 single-repo sections in order", () => {
    expect(seeds.map((s) => s.section)).toEqual(
      ["problem", "goal", "architecture", "components", "testing", "success-criteria"]);
  });
  it("problem gets every bracketed claim; goal/architecture get their tagged lines", () => {
    expect(get("problem")).toContain("## Problem");
    expect(get("problem")).toContain("[Goal] ship the thing");
    expect(get("goal")).toContain("[Goal] ship the thing");
    expect(get("architecture")).toContain("[Architecture] use a queue");
  });
  it("testing matches [Testing] or a 'test' word; empty match → rebranded placeholder", () => {
    expect(get("testing")).toContain("covers the test path");
    expect(get("components")).toMatch(/no seed content matched/);
    expect(get("components")).not.toMatch(/yoda|step 11/i);
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement (append to `src/core/scoreDoc.ts`)**

```ts
const SEED_SPECS: { section: string; heading: string; comment: string; match: (l: string) => boolean }[] = [
  { section: "problem", heading: "## Problem", comment: "<!-- seed: cross-verified facts about the current state -->",
    match: (l) => /^- \[/.test(l) },
  { section: "goal", heading: "## Goal", comment: "<!-- seed: claims tagged [Goal] -->",
    match: (l) => /^- \[Goal/i.test(l) },
  { section: "architecture", heading: "## Architecture", comment: "<!-- seed: claims tagged [Architecture] -->",
    match: (l) => /^- \[Architecture/i.test(l) },
  { section: "components", heading: "## Components", comment: "<!-- seed: claims tagged [Components] -->",
    match: (l) => /^- \[Components/i.test(l) },
  { section: "testing", heading: "## Testing", comment: "<!-- seed: claims tagged [Testing] or containing \"test\" -->",
    match: (l) => /^- \[Testing/i.test(l) || /^- .*\btest/i.test(l) },
  { section: "success-criteria", heading: "## Success Criteria", comment: "<!-- seed: claims tagged [Success Criteria] -->",
    match: (l) => /^- \[Success/i.test(l) },
];
const SEED_PLACEHOLDER = "_(no seed content matched; Maestro drafts from scratch in the design walk)_";

/** Port of consult-synthesize.sh — 6 single-repo seed drafts from adjudicated.md content. */
export function synthesizeSeeds(adjText: string): { section: string; body: string }[] {
  const lines = adjText.split("\n");
  return SEED_SPECS.map((spec) => {
    const matched = lines.filter(spec.match);
    const body = `${spec.heading}\n\n${spec.comment}\n` +
      (matched.length ? matched.join("\n") + "\n" : SEED_PLACEHOLDER + "\n");
    return { section: spec.section, body };
  });
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): synthesizeSeeds (port of consult-synthesize)"`

---

### Task 4: `score verify-send`

**Files:** Modify `src/commands/score.ts`; Test `tests/score-escalation.test.ts`

Port `consult-verify-send.sh`: refuse if `verify-<inst>.txt` exists; compute scope via
`verifyScopeFiles`; for each scope file error if missing, include if non-empty; concat → `verify-claims-<inst>.txt`;
empty → write `VS=skipped` (no send, rc 0); else compose verify prompt, capture offset, send.

- [ ] **Step 1: Add failing tests (append to `tests/score-escalation.test.ts`)**

```ts
import { verifySendWith } from "../src/commands/score.js";

describe("score verify-send", () => {
  function seed(topic: string, rows: Array<{ provider: string; instrument: string }>, buckets: Record<string, string>): string {
    const art = scoreArtDir(topic);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "roster.txt"), rows.map((r) => `${r.provider}\t${r.instrument}`).join("\n") + "\n");
    writeFileSync(join(art, "topic.txt"), topic);
    for (const [f, c] of Object.entries(buckets)) writeFileSync(join(art, f), c);
    return art;
  }
  const rows = [{ provider: "codex", instrument: "viola" }, { provider: "claude", instrument: "cello" }];

  it("N=2: scope = other's bucket; composes + sends (rc 0)", async () => {
    const art = seed("t", rows, { "viola_only_items.txt": "[a:1] vc\n", "cello_only_items.txt": "[b:2] cc\n" });
    const calls: string[][] = [];
    const rc = await verifySendWith("t", "viola", "codex", { offsetFor: () => 7, send: async (a) => { calls.push(a); return 0; } });
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "verify-claims-viola.txt"), "utf8")).toContain("[b:2] cc"); // cello's, not viola's
    expect(readFileSync(join(art, "verify-viola.txt"), "utf8")).toBe("OFFSET=7\n");
    expect(calls[0]).toContain("@" + join(art, "viola_verify_prompt.md"));
  });

  it("empty scope → VS=skipped, no send (rc 0)", async () => {
    const art = seed("t", rows, { "viola_only_items.txt": "", "cello_only_items.txt": "" });
    let sent = 0;
    const rc = await verifySendWith("t", "cello", "claude", { offsetFor: () => 0, send: async () => { sent++; return 0; } });
    expect(rc).toBe(0);
    expect(readFileSync(join(art, "verify-cello.txt"), "utf8")).toBe("VS=skipped\n");
    expect(sent).toBe(0);
  });

  it("refuses if verify-<inst>.txt exists (rc 1)", async () => {
    const art = seed("t", rows, { "viola_only_items.txt": "x\n", "cello_only_items.txt": "y\n" });
    writeFileSync(join(art, "verify-viola.txt"), "OFFSET=0\n");
    expect(await verifySendWith("t", "viola", "codex", { offsetFor: () => 0, send: async () => 0 })).toBe(1);
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL (not exported).

- [ ] **Step 3: Implement** — add imports (`composeVerifyPrompt` from scoreTurn; `verifyScopeFiles` from
score), dispatch `case "verify-send"`, and:

```ts
async function verifySendRun(rest: string[]): Promise<number> {
  const [topic, instrument, provider] = rest;
  if (!topic || !instrument || !provider) { log.error("usage: score verify-send <topic> <instrument> <provider>"); return 2; }
  return verifySendWith(topic, instrument, provider, liveResearchSendDeps); // same {offsetFor, send} shape
}

export async function verifySendWith(topic: string, instrument: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = scoreArtDir(topic);
  if (!existsSync(art)) { log.error(`score verify-send: ${art} not found`); return 1; }
  const stateFile = join(art, `verify-${instrument}.txt`);
  if (existsSync(stateFile)) { log.error(`score verify-send: ${stateFile} exists; rm to retry`); return 1; }

  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error("score verify-send: roster.txt missing — run score init first"); return 1; }
  const instruments = parseRosterFile(readFileSync(rosterPath, "utf8")).map((r) => r.instrument);
  if (instruments.length < 2) { log.error(`score verify-send: need >=2 parts, got ${instruments.length}`); return 1; }
  if (!instruments.includes(instrument)) { log.error(`score verify-send: ${instrument} not in roster.txt`); return 1; }

  const parts: string[] = [];
  for (const f of verifyScopeFiles(instrument, instruments)) {
    const p = join(art, f);
    if (!existsSync(p)) { log.error(`score verify-send: expected bucket missing: ${p} (run score diff first)`); return 1; }
    const c = readFileSync(p, "utf8");
    if (c.split("\n").some((l) => l.length > 0)) parts.push(c.replace(/\n+$/, ""));
  }
  const items = parts.join("\n");
  const claimsFile = join(art, `verify-claims-${instrument}.txt`);
  atomicWrite(claimsFile, items ? items + "\n" : "");

  if (!items) { atomicWrite(stateFile, "VS=skipped\n"); log.ok(`score verify-send: ${instrument} VS=skipped (no claims to verify)`); return 0; }

  const verifyPath = join(partDir(instrument, provider, topic), "verify.md");
  const promptFile = join(art, `${instrument}_verify_prompt.md`);
  atomicWrite(promptFile, composeVerifyPrompt(items, verifyPath));

  const offset = d.offsetFor(instrument, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "maestro", instrument, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`score verify-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`score verify-send: ${instrument} offset=${offset}`);
  return 0;
}
```

- [ ] **Step 4: Run** `npx vitest run tests/score-escalation.test.ts -t verify-send` → PASS.
- [ ] **Step 5: Commit** — `"feat(score): verify-send subcommand (scope from buckets, VS=skipped on empty)"`

---

### Task 5: `score verify-wait`

**Files:** Modify `src/commands/score.ts`; Test `tests/score-escalation.test.ts`

Mirror `research-wait` with the verify branch: `VS=skipped` short-circuit (touch `.done`, no wait);
else `verifyState` → append `VS=`; question → capture + bump offset + `VS=question`; always `.done`.

- [ ] **Step 1: Add failing tests (append to `tests/score-escalation.test.ts`)**

```ts
import { verifyWaitWith } from "../src/commands/score.js";

describe("score verify-wait", () => {
  function seedV(topic: string, instrument: string, provider: string, body: string): string {
    const art = scoreArtDir(topic); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, `verify-${instrument}.txt`), body);
    mkdirSync(partDir(instrument, provider, topic), { recursive: true });
    return art;
  }
  const dep = (ev: any) => ({ wait: async () => ev, multiplier: () => "1.0" });

  it("VS=skipped short-circuit: writes .done, no wait (rc 0)", async () => {
    const art = seedV("t", "viola", "codex", "VS=skipped\n");
    let waited = 0;
    const rc = await verifyWaitWith("t", "viola", "codex", { wait: async () => { waited++; return null; }, multiplier: () => "1.0" });
    expect(rc).toBe(0); expect(waited).toBe(0);
    expect(existsSync(join(art, "verify-viola.done"))).toBe(true);
  });

  it("done + non-empty verify.md → VS=ok", async () => {
    const art = seedV("t", "viola", "codex", "OFFSET=0\n");
    writeFileSync(join(partDir("viola", "codex", "t"), "verify.md"), "## Verdicts\n1. AGREE [a:1] x\n");
    await verifyWaitWith("t", "viola", "codex", dep({ event: "done", summary: "ok" }));
    expect(readFileSync(join(art, "verify-viola.txt"), "utf8")).toContain("VS=ok");
  });

  it("question → bumped OFFSET + VS=question + payload", async () => {
    const art = seedV("t", "viola", "codex", "OFFSET=3\n");
    writeFileSync(outboxPath("viola", "codex", "t"), "0123456789"); // size 10
    await verifyWaitWith("t", "viola", "codex", dep({ event: "question", message: "scope?" }));
    const s = readFileSync(join(art, "verify-viola.txt"), "utf8");
    expect(s).toContain("VS=question"); expect(s).toMatch(/OFFSET=10/);
    expect(readFileSync(join(art, "question-viola.txt"), "utf8")).toContain("scope?");
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement** — add dispatch `case "verify-wait"`, import `verifyState` from scoreTurn, and:

```ts
async function verifyWaitRun(rest: string[]): Promise<number> {
  const [topic, instrument, provider] = rest;
  if (!topic || !instrument || !provider) { log.error("usage: score verify-wait <topic> <instrument> <provider>"); return 2; }
  return verifyWaitWith(topic, instrument, provider, liveResearchWaitDeps); // same {wait, multiplier}
}

export async function verifyWaitWith(topic: string, instrument: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = scoreArtDir(topic);
  const stateFile = join(art, `verify-${instrument}.txt`);
  if (!existsSync(stateFile)) { log.error(`score verify-wait: ${stateFile} missing (run score verify-send first)`); return 1; }
  const text = readFileSync(stateFile, "utf8");

  if (lastTag(text, "VS") === "skipped") { // empty-scope short-circuit
    writeFileSync(join(art, `verify-${instrument}.done`), "");
    log.ok(`score verify-wait: ${instrument} VS=skipped (already)`);
    return 0;
  }
  const offset = parseLatestOffset(text);
  if (offset === null) { log.error(`score verify-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("verify"), d.multiplier(provider));
  log.info(`score verify-wait: ${instrument} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(instrument, provider, topic, offset, ["done", "error", "question"], timeout);

  const verifyPath = join(partDir(instrument, provider, topic), "verify.md");
  const verifyText = existsSync(verifyPath) ? readFileSync(verifyPath, "utf8") : null;
  const vs = verifyState(ev, verifyText);

  if (vs === "question" && ev) {
    atomicWrite(join(art, `question-${instrument}.txt`), JSON.stringify(ev) + "\n");
    const bumped = outboxOffset(outboxPath(instrument, provider, topic));
    appendFileSync(stateFile, `OFFSET=${bumped}\nVS=question\n`);
  } else {
    appendFileSync(stateFile, `VS=${vs}\n`);
  }
  writeFileSync(join(art, `verify-${instrument}.done`), "");
  log.ok(`score verify-wait: ${instrument} VS=${vs}`);
  return 0;
}
```

(Import `lastTag` from `../core/score.js`.)

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): verify-wait subcommand (VS= machine + skipped short-circuit + question)"`

---

### Task 6: `score adjudicate`

**Files:** Modify `src/commands/score.ts`; Test `tests/score-escalation.test.ts`

Port `consult-adjudicate.sh`: gather `{parts, verify, vs, buckets}` from disk → `adjudicate()` →
write `adjudicated-draft.md`. Never touch `adjudicated.md`.

- [ ] **Step 1: Add failing test (append to `tests/score-escalation.test.ts`)**

```ts
import { adjudicateRun } from "../src/commands/score.js";

describe("score adjudicate", () => {
  it("N=2: writes adjudicated-draft.md with the 4 sections; leaves adjudicated.md untouched", async () => {
    const art = scoreArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "roster.txt"), "codex\tviola\nclaude\tcello\n");
    writeFileSync(join(art, "viola_only_items.txt"), "[a:1] viola claim\n");
    writeFileSync(join(art, "cello_only_items.txt"), "[b:2] cello claim\n");
    for (const [inst, prov] of [["viola", "codex"], ["cello", "claude"]]) {
      mkdirSync(partDir(inst, prov, "t"), { recursive: true });
      writeFileSync(join(partDir(inst, prov, "t"), "verify.md"), "## Verdicts\n1. AGREE [b:2] cello claim\n   confirmed\n");
      writeFileSync(join(art, `verify-${inst}.txt`), "OFFSET=0\nVS=ok\n");
    }
    const rc = await adjudicateRun(["t"]);
    expect(rc).toBe(0);
    const draft = readFileSync(join(art, "adjudicated-draft.md"), "utf8");
    expect(draft).toContain("## Cross-verified");
    expect(draft).toContain("## Adjudicated");
    expect(draft).toContain("## Contested");
    expect(draft).toContain("## Not-verified");
    expect(existsSync(join(art, "adjudicated.md"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement** — import `adjudicate, type AdjudicateInput, type AdjPart` from `../core/scoreDiff.js`?
**No** — from `../core/scoreAdjudicate.js`. Add dispatch `case "adjudicate"`, and:

```ts
export async function adjudicateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score adjudicate <topic>"); return 2; }
  const art = scoreArtDir(topic);
  if (!existsSync(art)) { log.error(`score adjudicate: ${art} not found`); return 1; }
  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error("score adjudicate: roster.txt missing"); return 1; }
  const rows = parseRosterFile(readFileSync(rosterPath, "utf8"));
  if (rows.length < 2) { log.error(`score adjudicate: need >=2 parts, got ${rows.length}`); return 1; }

  const instruments = rows.map((r) => r.instrument);
  const readIfExists = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const verify: Record<string, string> = {};
  const vs: Record<string, string> = {};
  for (const r of rows) {
    verify[r.instrument] = readIfExists(join(partDir(r.instrument, r.provider, topic), "verify.md"));
    vs[r.instrument] = lastTag(readIfExists(join(art, `verify-${r.instrument}.txt`)), "VS") ?? "skipped";
  }
  const buckets: Record<string, string> = {};
  const addBucket = (f: string): void => { buckets[f] = readIfExists(join(art, f)); };
  for (const c of instruments) addBucket(`${c}_only_items.txt`);
  if (instruments.length >= 3) {
    addBucket("consensus.txt");
    for (let i = 0; i < instruments.length; i++) for (let j = i + 1; j < instruments.length; j++) addBucket(`${instruments[i]}+${instruments[j]}_only.txt`);
  }

  const input: AdjudicateInput = { parts: rows.map((r) => ({ instrument: r.instrument, provider: r.provider })), verify, vs, buckets };
  atomicWrite(join(art, "adjudicated-draft.md"), adjudicate(input));
  log.ok(`score adjudicate: wrote ${join(art, "adjudicated-draft.md")}`);
  log.info("  cp adjudicated-draft.md -> adjudicated.md, then resolve every '- PENDING:' line");
  return 0;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): adjudicate subcommand (gather verify/vs/buckets -> adjudicated-draft.md)"`

---

### Task 7: `score synthesize`

**Files:** Modify `src/commands/score.ts`; Test `tests/score-escalation.test.ts`

Port `consult-synthesize.sh`: refuse if `adjudicated.md` missing or has any `^- PENDING:`; else write the
6 seed drafts via `synthesizeSeeds` into `.draft/`.

- [ ] **Step 1: Add failing tests (append to `tests/score-escalation.test.ts`)**

```ts
import { synthesizeRun } from "../src/commands/score.js";

describe("score synthesize", () => {
  it("refuses when adjudicated.md missing (rc 1)", async () => {
    mkdirSync(scoreArtDir("t"), { recursive: true });
    expect(await synthesizeRun(["t"])).toBe(1);
  });
  it("refuses while a '- PENDING:' line remains (rc 1)", async () => {
    const art = scoreArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "adjudicated.md"), "## Cross-verified\n- PENDING: [a:1] x\n");
    expect(await synthesizeRun(["t"])).toBe(1);
  });
  it("seeds the 6 .draft/*.md (rc 0)", async () => {
    const art = scoreArtDir("t"); mkdirSync(join(art, "design-doc", ".draft"), { recursive: true });
    writeFileSync(join(art, "adjudicated.md"), "## Cross-verified\n- [a:1] [Goal] ship it\n");
    expect(await synthesizeRun(["t"])).toBe(0);
    expect(readFileSync(join(art, "design-doc", ".draft", "goal.md"), "utf8")).toContain("[Goal] ship it");
    expect(existsSync(join(art, "design-doc", ".draft", "success-criteria.md"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement** — import `synthesizeSeeds` from `../core/scoreDoc.js`; dispatch `case "synthesize"`:

```ts
export async function synthesizeRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score synthesize <topic>"); return 2; }
  const art = scoreArtDir(topic);
  const adj = join(art, "adjudicated.md");
  if (!existsSync(adj)) { log.error(`score synthesize: ${adj} missing — cp adjudicated-draft.md -> adjudicated.md and resolve PENDINGs first`); return 1; }
  const adjText = readFileSync(adj, "utf8");
  if (adjText.split("\n").some((l) => /^- PENDING:/.test(l))) { log.error("score synthesize: adjudicated.md still has '- PENDING:' lines; resolve them first"); return 1; }

  const draftDir = scoreDraftDir(topic);
  mkdirSync(draftDir, { recursive: true });
  const seeds = synthesizeSeeds(adjText);
  for (const s of seeds) atomicWrite(join(draftDir, `${s.section}.md`), s.body);
  log.ok(`score synthesize: wrote ${seeds.length} seed drafts to ${draftDir}`);
  return 0;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): synthesize subcommand (seed .draft sections from adjudicated.md)"`

---

### Task 8: `score walk-state` + extend `score assemble` (`SECTION=`)

**Files:** Modify `src/commands/score.ts`; Test `tests/score-escalation.test.ts`, `tests/score-assemble.test.ts`

`walk-state` prints `<section>\t<approved|skipped>` per `.draft/*.md` (resume; via `walkSectionState`).
`assemble` (existing) gains additive `SECTION=<mapped>` stderr lines on FAIL via `auditIssueToSection`.

- [ ] **Step 1: Add failing tests**

`tests/score-escalation.test.ts`:
```ts
import { walkStateRun } from "../src/commands/score.js";

describe("score walk-state", () => {
  it("prints section\\tstatus (skipped detected) to stdout", async () => {
    const dd = join(scoreArtDir("t"), "design-doc", ".draft"); mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, "goal.md"), "## Goal\n\nship it\n");
    writeFileSync(join(dd, "problem.md"), "_(skipped)_");
    let out = ""; const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { out += s; return true; };
    try { await walkStateRun(["t"]); } finally { (process.stdout as any).write = orig; }
    expect(out).toContain("goal\tapproved");
    expect(out).toContain("problem\tskipped");
  });
});
```

`tests/score-assemble.test.ts` (add to the FAIL case — locate the existing audit-FAIL test and add):
```ts
  it("emits SECTION= mapping lines alongside ISSUE= on audit FAIL", async () => {
    // (reuse the existing FAIL fixture that drops a required section, e.g. a heading-less goal.md)
    // ...assemble run that FAILs...
    // expect stderr to contain both "ISSUE=no_goal_section" and "SECTION=goal"
  });
```
(Implement against the existing FAIL fixture in that file — capture `process.stderr.write`, assert both
lines present.)

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement**

Dispatch: `case "walk-state": return walkStateRun(rest);`. Import `walkSectionState, auditIssueToSection`
from `../core/scoreWalk.js`.

```ts
export async function walkStateRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score walk-state <topic>"); return 2; }
  const states = walkSectionState(scoreDraftDir(topic), { withStatus: true });
  for (const s of states) process.stdout.write(`${s.name}\t${s.status}\n`);
  return 0;
}
```

In `assembleRun`, in the `result.verdict === "FAIL"` branch, after emitting the `ISSUE=` lines add:
```ts
    for (const i of result.issues) process.stderr.write(`SECTION=${auditIssueToSection(i)}\n`);
```

- [ ] **Step 4: Run** `npx vitest run tests/score-escalation.test.ts tests/score-assemble.test.ts` → PASS.
- [ ] **Step 5: Commit** — `"feat(score): walk-state subcommand + assemble emits SECTION= on audit FAIL"`

---

### Task 9: `commands/score.md` Stages 7–12 + rebuild + stale gate

**Files:** Modify `commands/score.md`; regenerate `dist/consort.cjs`; verify `tests/stale-tokens.test.ts`.

Replace the Phase C "Phase C ends here" blockquote (after Stage 6) with Stages 7–12. The directive does
only Read/Write/Edit/AskUserQuestion/background-wait; all mechanical work is the CLI.

- [ ] **Step 1: Replace the "Phase C ends here" blockquote with Stages 7–12**

```markdown
## Stage 7 — cross-verify dispatch (per part)

Read the diff roster (`$ART/roster.txt`). For each part, dispatch its verify turn:

```bash
grep -v '^#' "$ART/roster.txt" | while IFS=$'\t' read -r PROV INST; do
  [ -n "$PROV" ] && [ -n "$INST" ] && $CS score verify-send <TOPIC> "$INST" "$PROV"
done
```

`verify-send` computes each part's scope (the bucket files where it is NOT a member), writes
`verify-claims-<inst>.txt`, and either sends the verify prompt (`OFFSET=` captured) or writes
`VS=skipped` when there's nothing for that part to verify (no send).

## Stage 8 — cross-verify wait + question relay (per part)

For each part, background `$CS score verify-wait <TOPIC> <INST> <PROV>`. On each completion, read the
**last** `VS=` line (`grep '^VS=' "$ART/verify-<INST>.txt" | tail -1 | cut -d= -f2`):
- **`VS=ok` / `VS=skipped` / `VS=missing`** — terminal.
- **`VS=question`** — same classify+relay as Stage 5 (read `$ART/question-<INST>.txt` + the part's
  `verify.md`; AskUserQuestion if critical else self-answer; `$CS send --from maestro <INST> <TOPIC>
  @<reply>`; `rm -f $ART/verify-<INST>.done`; re-arm the background `verify-wait`).
- **`VS=failed` / `VS=timeout`** — record; the part's verdicts are absent (adjudicate marks the rival's
  claims `Not-verified`).
Proceed when every part is terminal (no `VS=question` outstanding).

## Stage 9 — adjudicate + resolve PENDING

1. `$CS score adjudicate <TOPIC>` → writes `$ART/adjudicated-draft.md` (5-tier for N≥3, 4-section for N=2).
2. `cp "$ART/adjudicated-draft.md" "$ART/adjudicated.md"`.
3. **Read** `$ART/adjudicated.md`. For **every** `- PENDING:` line: read the cited source, decide, and
   **Edit** the line in place — rewrite the `PENDING` prefix to `CONFIRMED`/`REFUTED`, or move the item
   under `## Contested`. **Done only when no `- PENDING:` line remains** (`synthesize` refuses otherwise).
   You may also tag claims `[Goal]`/`[Architecture]`/`[Components]`/`[Testing]`/`[Success Criteria]` to
   steer the synthesize seeds.

## Stage 10 — multi-repo detection

`MODE=single` here (Phase D is single-repo; `--targets` stopped at Stage 1). Multi-repo detection + the
8-section walk land in **Phase E** — skip to Stage 11.

## Stage 11 — interactive per-section design walk

1. Seed the drafts: `$CS score synthesize <TOPIC>` (refuses while any `- PENDING:` remains, or if
   `adjudicated.md` is missing). Writes 6 `.draft/<section>.md`.
2. Resume check: `$CS score walk-state <TOPIC>` prints `<section>\t<approved|skipped>` for any drafts
   already settled — skip those.
3. **Walk the 6 sections in order** (problem, goal, architecture, components, testing, success-criteria).
   For each, **Read** `$ART/design-doc/.draft/<section>.md` (the seed) + `$ART/adjudicated.md` + the
   parts' `findings.md`, then **draft the section** and **Write** it to the `.draft/<section>.md` path.
   Present the draft in chat, then **AskUserQuestion**: Approve / Revise / Skip.
   - **Approve** → keep the draft, next section.
   - **Revise** → take free-form direction via a follow-up, re-draft, re-present (cap at 4 revises;
     after the cap, force-approve the current draft and move on).
   - **Skip** → Write `_(skipped)_` as the whole draft body. **Skip is NOT offered for the four
     audit-required sections** (goal, architecture, testing, success-criteria) — they must be drafted.

## Stage 12 — assemble + deploy-audit gate (retry loop)

1. `$CS score assemble <TOPIC>`.
   - **rc 0** → it prints the design-doc path. Go to Stage 13 (Phase F) — for now, **present** the doc
     and point at `/consort:perform <path>` (once perform ships).
   - **rc 1** (audit FAIL) → it printed `ISSUE=<code>` + `SECTION=<mapped>` lines to stderr. For each
     `SECTION=`:
     - a **section name** (goal/architecture/testing/success-criteria/components/problem) → re-walk
       that one section (Stage 11 for it), then re-assemble.
     - `ASK` (a TBD/TODO/fill-in marker) → AskUserQuestion which section carries the marker, re-walk it.
     - `header` (`execution-dag` only arises in multi-repo) → not reachable in single-repo; treat as
       unknown.
     - empty (`""`, unknown code) → surface the raw `ISSUE=` to the user and stop.
   - Re-assemble after each fix; loop until rc 0 (bound the loop to a few attempts per section, then
     surface remaining ISSUEs and stop).

> **Phase D ends at the assembled, audit-passing single-repo doc.** Drilldown, forensics, `coda`
> teardown, and the `present` handoff land in **Phase F**; multi-repo + the execution DAG in **Phase E**.
> The parts are still live — `/consort:coda <instrument> <TOPIC>` each to tear down (Phase F automates it).
```

Also update the closing Notes "later phases" bullet to: "Stages 7–12 (cross-verify → adjudicate →
synthesize → design walk → audit) ship in Phase D; multi-repo + execution-DAG (Phase E) and
drilldown/forensics/teardown/present (Phase F) remain."

- [ ] **Step 2: Rebuild** — `npm run build` (commit the refreshed `dist/consort.cjs`).
- [ ] **Step 3: Stale-token gate + full suite** — `npx vitest run tests/stale-tokens.test.ts && npm run test`.
  If the verify prompt / synthesize placeholder / directive leaked any banned token, **fix the file**.
- [ ] **Step 4: Commit** — `"feat(score): score.md Stages 7-12 (verify -> adjudicate -> walk -> audit) + rebuild dist"`

---

### Task 10: Full gate + live dogfood + DOGFOOD.md

**Files:** verify gates; modify `docs/superpowers/DOGFOOD.md`.

- [ ] **Step 1: Full gate** — `npm run typecheck && npm run lint && npm run test` (all green;
  `score-turn`/`score-core`/`score-doc`/`score-escalation`/`score-assemble` extended).

- [ ] **Step 2: Live dogfood (inside tmux, isolated home).** Continue a real escalated single-repo run
  past Phase C's diff:
  1. `score init --ensemble <bounded repo topic>`, `score spawn-all`, `score research-send`×N,
     background `score research-wait`×N, `score diff` (Phase C — proven).
  2. `score verify-send`×N → background `score verify-wait`×N → confirm `VS=ok`/`VS=skipped`; handle any
     question relay (re-arm resumes past the question).
  3. `score adjudicate` → `cp` → resolve every `- PENDING:` in `adjudicated.md` (Edit).
  4. `score synthesize` → `score walk-state` → walk the 6 sections (Approve each; drive a Revise once to
     exercise the loop).
  5. `score assemble` → audit PASS (drive at least one audit-FAIL → `SECTION=` → re-walk → re-assemble
     if it bounces). Read + present the final design-doc.
  6. `coda` each part.

- [ ] **Step 3: Verify artifacts** — `verify-*.txt` end in terminal `VS=`; `adjudicated.md` has no
  `- PENDING:`; 6 `.draft/*.md` exist; the canonical `design-doc/<date>-<slug>-design.md` exists and
  `audit.log` says `VERDICT=PASS`.

- [ ] **Step 4: Append the Phase D dogfood section to `docs/superpowers/DOGFOOD.md`** — topic, parts,
  the `VS=` outcomes, PENDING-resolution count, walk decisions, the audit-retry (if any), PASS/FAIL.

- [ ] **Step 5: Commit** — `"docs(score): Phase D live dogfood (verify -> adjudicate -> walk -> audit-pass)"`

---

## Final review (after all tasks)

Holistic reviewer over the Phase D diff. Confirm: `verifyScopeFiles` order matches
`consult-verify-send.sh`; `adjudicate` gathers buckets in the same key shape `scoreAdjudicate` reads;
`synthesize` refuses correctly and seeds the 6 single-repo sections only; the `VS=skipped` short-circuit
+ question re-arm work; `assemble`'s `SECTION=` is additive (Phase B `ISSUE=` contract intact); the walk
never offers Skip on the four required sections; no frozen-protocol term renamed; stale-token gate green;
`dist` in sync. Then keep the branch (user's "PR later") and continue to **Phase E**.
