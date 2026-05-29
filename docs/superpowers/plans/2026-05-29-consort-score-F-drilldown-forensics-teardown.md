# consort `score` — Phase F: drilldown + forensics + teardown + archive + present (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete `score` — the post-doc wind-down: optional drilldown rounds while parts are live,
best-effort forensics capture + a Maestro reflection, `coda` teardown, `archiveTopic('score')`, and the
present + `perform` handoff — ending in the final acceptance dogfood. After Phase F the whole command is
done and `feat/score` is PR-ready.

**Architecture:** Phase F **reuses** the built machinery — `coda` (teardown: FINE banner → 9s grace →
killNow → per-part `stateArchive`), `archiveTopic(topic,'score')` (finalize status → move `_score` incl.
`drilldowns/` → rmdir topic), the FINE banner. It **builds** the missing pieces: a forensics **art-dir
scraper** in `core/forensics.ts` (consort only has spawn-bootstrap `captureFailure`), the **drilldown**
surface (path helper + prompt composer + wait classifier + `score drilldown` verb), and two thin verbs
(`score forensics`, `score archive`) so the directive invokes them by topic. `score.md` Stages 13–16
orchestrate it. The CLI stays 100% mechanical; all judgment (drill subject/focus, the `## Maestro
reflection`) is Maestro prose.

**Tech Stack:** TypeScript (ES2022/NodeNext/strict), vitest, esbuild → committed `dist/consort.cjs`.
Behavioral source: clone-wars `bin/consult-drilldown.sh` + `config/prompt-templates/consult/drilldown.md`,
`lib/forensics.sh` + `bin/forensics-capture.sh`, `bin/consult-teardown.sh`/`consult-archive.sh`,
`commands/consult.md` Steps 13–16.

---

## Scope (this plan — completes `score`)

**In:** the forensics art-dir scraper + render + `captureArtDir` (best-effort, writes under
`~/.consort/forensics/`, survives teardown), the drilldown path/prompt/wait helpers + `score drilldown`
verb, thin `score forensics`/`score archive` verbs, `score.md` Stages 13 (drilldown loop), 14a
(forensics + `## Maestro reflection`), 14b (coda teardown), 15 (archive), 16 (present + perform handoff);
rebuilt `dist`; the **final acceptance dogfood**.

**Out:** the DAG executor (perform); `playback`/`review-forensics`/`forensics-mark-reviewed` (separate
future command); the preflight-orphan reap self-heal (clone-wars v0.61.2 — a partial-spawn edge case;
noted as deferred polish, not built here). `present` stays **Maestro prose**, not a CLI verb (the doc
path is already printed by `score assemble`).

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/forensics.ts` | add `Finding`, pure scrapers, `scrapeArtDir`, `renderArtForensics`, `captureArtDir` | modify |
| `src/core/score.ts` | add `scoreDrilldownScratchDir`, `resolveDrilldownPath` | modify |
| `src/core/scoreTurn.ts` | add `composeDrilldownPrompt`, `drilldownState` | modify |
| `src/commands/score.ts` | add `drilldown`/`forensics`/`archive` verbs | modify |
| `commands/score.md` | Stages 13–16 (replace the Phase E end-stub) | modify |
| `tests/forensics.test.ts` | scraper + render + captureArtDir cases | modify |
| `tests/score-core.test.ts` | `resolveDrilldownPath` collision cases | modify |
| `tests/score-turn.test.ts` | `composeDrilldownPrompt` + `drilldownState` | modify |
| `tests/score-escalation.test.ts` | `drilldown`/`forensics`/`archive` verbs | modify |
| `dist/consort.cjs` | rebuilt | regenerate |
| `docs/superpowers/DOGFOOD.md` | Phase F section | modify |

## Deliberate constraints (from the grounding; do NOT violate)

1. **Best-effort forensics never blocks the wind-down.** Every fs op in `captureArtDir` (scrape, mkdir,
   render, write) is individually try/caught → on any failure return `""` and write nothing. A throwing
   `readFileSync`/`mkdirSync` mid-scrape would abort teardown.
2. **Forensics lives OUTSIDE the per-project state tree** — under `globalRoot()/forensics/<date>/<time>-<command>-<topicSlug>.md`
   (a sibling of `state/`), so it survives teardown + archive.
3. **Outbox event matching is `JSON.parse(line)` + `obj.event === …`** (skip non-JSON), NOT the
   clone-wars anchored regex (CLAUDE.md rule).
4. **`## Maestro reflection` idempotency:** the writer and the skip-guard use the *exact* same header
   string, or re-runs double-append. (clone-wars `## Yoda reflection` → `## Maestro reflection`.)
5. **Drilldown collision counter:** strip the prior `-N` (regex `/-[0-9]+$/`) before re-appending
   `-2..-99`, and resolve the path **before** dispatch (so parallel parts in one round don't clobber).
   Throw at `>99`.
6. **Drilldown success = terminal event AND non-empty file.** A `done`/`error` with an empty/absent file
   is `missing`, not `ok` (don't report a false rc 0 on an all-empty round). Capture the outbox offset
   **before** the send.
7. **Reuse `coda` + `archiveTopic('score')` — do NOT rewrite teardown/archive.** The wind-down invokes
   them. `troopers.txt` is a FROZEN state filename (coda reads it); `state`/`archived`/`archived_ts` are
   frozen status fields.
8. **`present` is a forward pointer:** "run `/consort:perform <doc>` (once perform ships)" — perform is
   out of scope; do not implement any handoff logic.
9. **Stale-token gate:** banner is `FINE` (already in `colors.ts`), conductor is `Maestro`, header is
   `## Maestro reflection`, handoff is `/consort:perform`. No `clone-wars`/`cw_`/`@cw_`/`trooper`/`commander`/`master-yoda`/`MISSION ACCOMPLISHED` in new src/commands.

---

### Task 1: `core/forensics.ts` — pure art-dir scrapers

**Files:** Modify `src/core/forensics.ts`; Test `tests/forensics.test.ts`

Port `lib/forensics.sh`'s scrape functions as pure text scrapers (`Finding[]`), deduped. Outbox via
`JSON.parse`. Labels use **part** (not trooper). These are the mechanical signal extractors.

- [ ] **Step 1: Add failing tests (append to `tests/forensics.test.ts`)**

```ts
import { scrapeAuditLog, scrapeOutbox, scrapeStatus, scrapeSpawnResults, scrapeLogs, scrapeArtDir, type Finding } from "../src/core/forensics.js";

describe("forensics scrapers", () => {
  it("audit.log → ^ISSUE= lines", () => {
    expect(scrapeAuditLog("VERDICT=FAIL\nISSUE=no_goal_section\nISSUE=tbd_marker\n"))
      .toEqual([{ source: "audit_log", key: "ISSUE=no_goal_section", context: "audit.log" },
                { source: "audit_log", key: "ISSUE=tbd_marker", context: "audit.log" }]);
  });
  it("outbox → error/question events via JSON.parse, labelled by part; skips non-JSON + done", () => {
    const ob = '{"event":"done","summary":"ok"}\nnot json\n{"event":"error","reason":"boom"}\n{"event":"question","message":"?"}\n';
    const f = scrapeOutbox(ob, "viola");
    expect(f.map((x) => x.source)).toEqual(["outbox", "outbox"]);
    expect(f.every((x) => x.context === "part=viola")).toBe(true);
    expect(f[0].key).toContain('"event":"error"');
  });
  it("status.json state=error; spawn-results rc!=0; logs [error]/log_error", () => {
    expect(scrapeStatus('{"state":"error","updated":"x"}', "cello")).toEqual([{ source: "status", key: "state=error", context: "part=cello" }]);
    expect(scrapeStatus('{"state":"ready"}', "cello")).toEqual([]);
    expect(scrapeSpawnResults("viola\tcodex\t0\t\ncello\tclaude\t1\tspawn-failed\n").map((x) => x.context)).toEqual(["part=cello"]);
    expect(scrapeLogs("all good\n[error] boom\nplain\n", "dispatch.log").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL (not exported).

- [ ] **Step 3: Implement (append to `src/core/forensics.ts`)**

```ts
export interface Finding { source: string; key: string; context: string; }

/** audit.log: each `^ISSUE=` line. */
export function scrapeAuditLog(text: string): Finding[] {
  return text.split("\n").filter((l) => /^ISSUE=/.test(l)).map((l) => ({ source: "audit_log", key: l, context: "audit.log" }));
}
/** outbox.jsonl: JSON.parse each line (skip non-JSON), keep event error|question, label by part. */
export function scrapeOutbox(text: string, part: string): Finding[] {
  const out: Finding[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o.event === "error" || o.event === "question") out.push({ source: "outbox", key: l.trim(), context: `part=${part}` }); }
    catch { /* skip non-JSON */ }
  }
  return out;
}
/** status.json: state==='error'. */
export function scrapeStatus(text: string, part: string): Finding[] {
  try { if (JSON.parse(text).state === "error") return [{ source: "status", key: "state=error", context: `part=${part}` }]; } catch { /* */ }
  return [];
}
/** spawn-results.tsv: rows with rc != 0 (skip blank/#). */
export function scrapeSpawnResults(text: string): Finding[] {
  const out: Finding[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim() || l.startsWith("#")) continue;
    const [inst, , rc, reason] = l.split("\t");
    if (inst && rc && rc !== "0") out.push({ source: "spawn_results", key: `rc=${rc} reason=${reason ?? ""}`.trim(), context: `part=${inst}` });
  }
  return out;
}
/** dispatch.log / session-summary.md: lines with [error] or log_error. */
export function scrapeLogs(text: string, basename: string): Finding[] {
  return text.split("\n").filter((l) => l.includes("[error]") || l.includes("log_error")).map((l) => ({ source: "session_log", key: l.trim(), context: basename }));
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): forensics pure art-dir scrapers (audit/outbox/status/spawn/logs)"`

---

### Task 2: `core/forensics.ts` — `scrapeArtDir` + `renderArtForensics`

**Files:** Modify `src/core/forensics.ts`; Test `tests/forensics.test.ts`

`scrapeArtDir` walks an `_score` art dir (best-effort; each read try/caught), runs the Task-1 scrapers
over `audit.log` (in `design-doc/`), every `*/outbox.jsonl` + `*/status.json` (the sibling part dirs),
`spawn-results.tsv`, and `*.log`/`session-summary.md`, dedups (`!seen`), returns `Finding[]`.
`renderArtForensics` emits the YAML-frontmatter + `## Mechanical findings` markdown.

- [ ] **Step 1: Add failing tests (append to `tests/forensics.test.ts`)**

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderArtForensics } from "../src/core/forensics.js";

describe("scrapeArtDir + render", () => {
  it("collects findings across the art dir + sibling part dirs, deduped", () => {
    const topicDir = mkdtempSync(join(tmpdir(), "fz-"));
    const art = join(topicDir, "_score"); mkdirSync(join(art, "design-doc"), { recursive: true });
    writeFileSync(join(art, "design-doc", "audit.log"), "VERDICT=FAIL\nISSUE=no_goal_section\n");
    writeFileSync(join(art, "spawn-results.tsv"), "viola\tcodex\t1\tspawn-failed\n");
    const part = join(topicDir, "viola-codex"); mkdirSync(part, { recursive: true });
    writeFileSync(join(part, "outbox.jsonl"), '{"event":"error","reason":"x"}\n');
    writeFileSync(join(part, "status.json"), '{"state":"error"}');
    const f = scrapeArtDir(art);
    expect(f.some((x) => x.source === "audit_log")).toBe(true);
    expect(f.some((x) => x.source === "outbox" && x.context === "part=viola-codex")).toBe(true);
    expect(f.some((x) => x.source === "status")).toBe(true);
    expect(f.some((x) => x.source === "spawn_results")).toBe(true);
  });
  it("render emits frontmatter + bullets", () => {
    const md = renderArtForensics({ command: "score", topicSlug: "t", repoHash: "abc", artDir: "/a", invokedAt: "2026-05-29T00:00:00Z" },
      [{ source: "audit_log", key: "ISSUE=no_goal_section", context: "audit.log" }]);
    expect(md).toContain("command: score");
    expect(md).toContain("n_findings_mechanical: 1");
    expect(md).toContain("## Mechanical findings");
    expect(md).toContain("- **audit_log** ISSUE=no_goal_section _(source: audit.log)_");
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement (append to `src/core/forensics.ts`; ensure `readFileSync`/`readdirSync`/`existsSync` imported)**

```ts
/** Best-effort walk of an _score art dir + its sibling part dirs → deduped Finding[]. Each read is
 *  individually guarded; any failure contributes nothing (never throws). Outbox/status part label =
 *  the part dir's basename. */
export function scrapeArtDir(artDir: string): Finding[] {
  const out: Finding[] = [];
  const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  const a = read(join(artDir, "design-doc", "audit.log")); if (a !== null) out.push(...scrapeAuditLog(a));
  const sr = read(join(artDir, "spawn-results.tsv")); if (sr !== null) out.push(...scrapeSpawnResults(sr));
  try { for (const f of readdirSync(artDir)) { if (f.endsWith(".log") || f === "session-summary.md") { const t = read(join(artDir, f)); if (t !== null) out.push(...scrapeLogs(t, f)); } } } catch { /* */ }
  // sibling part dirs live under the TOPIC dir (parent of _score): <topic>/<inst>-<model>/
  const topicDir = dirname(artDir);
  try {
    for (const d of readdirSync(topicDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith("_") || d.name.startsWith(".")) continue;
      const ob = read(join(topicDir, d.name, "outbox.jsonl")); if (ob !== null) out.push(...scrapeOutbox(ob, d.name));
      const st = read(join(topicDir, d.name, "status.json")); if (st !== null) out.push(...scrapeStatus(st, d.name));
    }
  } catch { /* */ }
  const seen = new Set<string>();
  return out.filter((f) => { const k = `${f.source}|${f.key}|${f.context}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export interface ForensicsMeta { command: string; topicSlug: string; repoHash: string; artDir: string; invokedAt: string; }

/** YAML frontmatter + `## Mechanical findings` bullets. */
export function renderArtForensics(meta: ForensicsMeta, findings: Finding[]): string {
  const fm = [
    "---", `command: ${meta.command}`, `topic: ${meta.topicSlug}`, `topic_slug: ${meta.topicSlug}`,
    `repo_hash: ${meta.repoHash}`, `art_dir: ${meta.artDir}`, `invoked_at: ${meta.invokedAt}`,
    `n_findings_mechanical: ${findings.length}`, "---", "",
  ].join("\n");
  const body = "## Mechanical findings\n\n" + findings.map((f) => `- **${f.source}** ${f.key} _(source: ${f.context})_`).join("\n") + "\n";
  return fm + body;
}
```
(Add `dirname` to the `node:path` import; `readdirSync` to the `node:fs` import.)

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): forensics scrapeArtDir + renderArtForensics"`

---

### Task 3: `core/forensics.ts` — `captureArtDir` entrypoint

**Files:** Modify `src/core/forensics.ts`; Test `tests/forensics.test.ts`

The best-effort capture: scrape → if 0 findings or ANY failure → `""` (write nothing); else write the
rendered markdown to `globalRoot()/forensics/<date>/<time>-<command>-<topicSlug>.md` (UTC; atomic) and
return the path. The whole body is wrapped so it never throws.

- [ ] **Step 1: Add failing tests (append to `tests/forensics.test.ts`)**

```ts
import { captureArtDir } from "../src/core/forensics.js";
import { existsSync, readFileSync as rfs } from "node:fs";

describe("captureArtDir", () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.CONSORT_HOME; });
  afterEach(() => { if (prev === undefined) delete process.env.CONSORT_HOME; else process.env.CONSORT_HOME = prev; });

  it("zero findings → '' and no file", () => {
    const home = mkdtempSync(join(tmpdir(), "fh-")); process.env.CONSORT_HOME = home;
    const art = join(mkdtempSync(join(tmpdir(), "fa-")), "clean", "_score"); mkdirSync(art, { recursive: true });
    expect(captureArtDir({ artDir: art, command: "score", now: new Date("2026-05-29T12:00:00Z") })).toBe("");
  });
  it("findings → writes under <home>/forensics/<date>/, returns the path", () => {
    const home = mkdtempSync(join(tmpdir(), "fh-")); process.env.CONSORT_HOME = home;
    const topicDir = join(mkdtempSync(join(tmpdir(), "ft-")), "mytopic"); const art = join(topicDir, "_score");
    mkdirSync(join(art, "design-doc"), { recursive: true });
    writeFileSync(join(art, "design-doc", "audit.log"), "ISSUE=no_goal_section\n");
    const p = captureArtDir({ artDir: art, command: "score", now: new Date("2026-05-29T12:34:56Z") });
    expect(p).toContain(join(home, "forensics", "2026-05-29"));
    expect(p).toMatch(/12-34-56-score-mytopic\.md$/);
    expect(existsSync(p)).toBe(true);
    expect(rfs(p, "utf8")).toContain("ISSUE=no_goal_section");
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement (append to `src/core/forensics.ts`; import `globalRoot`, `repoHash` from `./paths.js`, `atomicWrite` from `./atomic.js`, `mkdirSync` from `node:fs`, `basename`/`dirname` from `node:path`)**

```ts
/** Best-effort forensics capture for an art dir. Returns the written path, or "" on zero findings or
 *  ANY failure (writes nothing). Never throws — guards the entire body. Path lives under
 *  globalRoot()/forensics/<UTC-date>/<UTC-time>-<command>-<topicSlug>.md, OUTSIDE the per-project
 *  state tree so it survives teardown + archive. */
export function captureArtDir(opts: { artDir: string; command: string; now?: Date }): string {
  try {
    const findings = scrapeArtDir(opts.artDir);
    if (findings.length === 0) return "";
    const now = opts.now ?? new Date();
    const iso = now.toISOString();        // YYYY-MM-DDTHH:MM:SS.sssZ
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 19).replace(/:/g, "-");
    const topicSlug = basename(dirname(opts.artDir));
    let hash = "unknown"; try { hash = repoHash(); } catch { /* keep unknown */ }
    const dir = join(globalRoot(), "forensics", date);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${time}-${opts.command}-${topicSlug}.md`);
    const md = renderArtForensics({ command: opts.command, topicSlug, repoHash: hash, artDir: opts.artDir, invokedAt: iso.replace(/\.\d{3}Z$/, "Z") }, findings);
    atomicWrite(path, md);
    return path;
  } catch { return ""; }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/forensics.test.ts && npm run typecheck` → PASS/clean.
- [ ] **Step 5: Commit** — `"feat(score): captureArtDir (best-effort forensics under ~/.consort/forensics)"`

---

### Task 4: `core/score.ts` — drilldown path helpers

**Files:** Modify `src/core/score.ts`; Test `tests/score-core.test.ts`

`scoreDrilldownScratchDir(topic)` → `_score/drilldowns/_scratch`. `resolveDrilldownPath(scratchDir,
slug, instrument, subproject?)` → the collision-resolved path (strip prior `-N`, append `-2..-99`,
throw at `>99`). slug = `title.toLowerCase().replace(/ /g,"-")`.

- [ ] **Step 1: Add failing tests (append to `tests/score-core.test.ts`)**

```ts
import { scoreDrilldownScratchDir, resolveDrilldownPath } from "../src/core/score.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os";

describe("drilldown paths", () => {
  it("scratch dir hangs off _score/drilldowns/_scratch", () => {
    process.env.CONSORT_HOME = "/R";
    expect(scoreDrilldownScratchDir("t").endsWith(join("t", "_score", "drilldowns", "_scratch"))).toBe(true);
  });
  it("resolveDrilldownPath: plain, then -2/-3 collisions (no compounding), subproject infix", () => {
    const sc = mkdtempSync(join(tmpdir(), "dd-")); mkdirSync(sc, { recursive: true });
    const p1 = resolveDrilldownPath(sc, "the section", "viola");
    expect(p1.endsWith(join(sc, "drilldown-the-section-viola.md").slice(-40)) || p1.endsWith("drilldown-the-section-viola.md")).toBe(true);
    writeFileSync(p1, "x");
    const p2 = resolveDrilldownPath(sc, "the section", "viola"); expect(p2.endsWith("drilldown-the-section-viola-2.md")).toBe(true);
    writeFileSync(p2, "x");
    const p3 = resolveDrilldownPath(sc, "the section", "viola"); expect(p3.endsWith("drilldown-the-section-viola-3.md")).toBe(true);
    expect(resolveDrilldownPath(sc, "arch", "cello", "api").endsWith("drilldown-arch-api-cello.md")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement (append to `src/core/score.ts`; ensure `existsSync` from `node:fs` imported)**

```ts
/** `_score/drilldowns/_scratch` — per-part drill output, kept out of design-doc/ so the doc dir stays clean. */
export function scoreDrilldownScratchDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(scoreArtDir(topic, opts), "drilldowns", "_scratch");
}

/** Collision-resolved drill output path (port of consult-drilldown.sh resolve_out_path). Strips any
 *  prior `-N` before re-appending `-2..-99`, so re-runs don't compound; throws past 99. */
export function resolveDrilldownPath(scratchDir: string, section: string, instrument: string, subproject?: string): string {
  const slug = section.toLowerCase().replace(/ /g, "-");
  const base = `drilldown-${slug}${subproject ? `-${subproject}` : ""}-${instrument}`;
  let cand = base;
  let n = 2;
  while (existsSync(join(scratchDir, `${cand}.md`))) {
    cand = `${cand.replace(/-[0-9]+$/, "")}-${n}`;
    if (++n > 100) throw new Error("resolveDrilldownPath: too many same-section drilldown collisions");
  }
  return join(scratchDir, `${cand}.md`);
}
```
(Note: `++n > 100` means the first appended suffix is `-2` and the cap rejects after `-99` is taken —
the throw fires when a 100th distinct name would be needed, matching clone-wars' `n>99` abort.)

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): drilldown path helpers (scratch dir + collision-resolved path)"`

---

### Task 5: `core/scoreTurn.ts` — `composeDrilldownPrompt` + `drilldownState`

**Files:** Modify `src/core/scoreTurn.ts`; Test `tests/score-turn.test.ts`

Port `consult/drilldown.md` (rebranded; no `END_OF_INSTRUCTION`/done-line — `inboxWrite` appends them).
`drilldownState` mirrors the await contract: terminal event + non-empty file → `ok`; terminal + empty/absent
→ `missing`; null → `timeout` (drilldown waits `[done,error]` only — no question relay).

- [ ] **Step 1: Add failing tests (append to `tests/score-turn.test.ts`)**

```ts
import { composeDrilldownPrompt, drilldownState } from "../src/core/scoreTurn.js";

describe("composeDrilldownPrompt", () => {
  it("names the section, design doc, focus, out path; default focus; no fence/rebrand tokens", () => {
    const p = composeDrilldownPrompt({ section: "Architecture", designDocPath: "/d/doc.md", focus: "", outPath: "/o/dd.md" });
    expect(p).toContain("Architecture");
    expect(p).toContain("/d/doc.md");
    expect(p).toContain("/o/dd.md");
    expect(p).toMatch(/Provide more depth, citations, and concrete trade-offs for the Architecture section\./);
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toMatch(/master[ -]?yoda|trooper|commander/i);
    expect(composeDrilldownPrompt({ section: "Testing", designDocPath: "/d", focus: "edge cases", outPath: "/o" })).toContain("edge cases");
  });
});

describe("drilldownState", () => {
  it("terminal + non-empty file → ok; terminal + empty → missing; null → timeout", () => {
    expect(drilldownState({ event: "done" }, "notes\n")).toBe("ok");
    expect(drilldownState({ event: "done" }, "")).toBe("missing");
    expect(drilldownState({ event: "error", reason: "x" }, null)).toBe("missing");
    expect(drilldownState(null, "notes")).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement (append to `src/core/scoreTurn.ts`)**

```ts
/** Drilldown wait outcome → state (port of consult-drilldown.sh await_drill): a terminal done|error
 *  event with a NON-EMPTY drill file → ok; terminal with an empty/absent file → missing (NOT success);
 *  no terminal event before timeout → timeout. Drilldown does not relay questions. */
export function drilldownState(ev: OutboxEvent | null, fileText: string | null): "ok" | "missing" | "timeout" {
  if (!ev) return "timeout";
  return fileText !== null && fileText.length > 0 ? "ok" : "missing";
}

/** Drilldown prompt body (port of config/prompt-templates/consult/drilldown.md, rebranded). No
 *  END_OF_INSTRUCTION/done-line — inboxWrite appends them. */
export function composeDrilldownPrompt(opts: { section: string; designDocPath: string; focus: string; outPath: string }): string {
  const focus = opts.focus.trim() || `Provide more depth, citations, and concrete trade-offs for the ${opts.section} section.`;
  return [
    `You are drilling deeper into the **${opts.section}** section of a design doc derived from the`,
    "investigation you just completed.",
    "",
    `Read the design doc you produced: ${opts.designDocPath}`,
    "",
    `Focus: ${focus}`,
    "",
    "Write your expanded notes (with [citation] anchors) to:",
    `  ${opts.outPath}`,
  ].join("\n");
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): composeDrilldownPrompt + drilldownState"`

---

### Task 6: `score drilldown` verb

**Files:** Modify `src/commands/score.ts`; Test `tests/score-escalation.test.ts`

Port `bin/consult-drilldown.sh`: positional `<topic> <section> <dd-dir> <focus> <design-doc> <i1> <m1>
[<i2> <m2>] [<subproject>]` (arg counts 7/8/9/10; else rc 2). Validate topic/dd-dir/design-doc. Resolve
each part's out-path BEFORE dispatch; capture offset BEFORE send; fire sends; await `[done,error]`;
classify via `drilldownState`. rc 0 if ≥1 part produced a non-empty file, rc 1 if all empty/timeout.
Reuse `ResearchSendDeps`/`ResearchWaitDeps`. Timeout = `CONSORT_DRILLDOWN_TIMEOUT_S` env > 90, scaled.

- [ ] **Step 1: Add failing test (append to `tests/score-escalation.test.ts`)**

```ts
import { drilldownWith } from "../src/commands/score.js";

describe("score drilldown", () => {
  it("dispatches K=1, writes a non-empty file → rc 0; resolves the scratch path", async () => {
    const art = scoreArtDir("t"); const dd = join(art, "drilldowns"); mkdirSync(join(dd, "_scratch"), { recursive: true });
    writeFileSync(join(art, "doc.md"), "# doc\n");
    mkdirSync(partDir("viola", "codex", "t"), { recursive: true });
    const sends: string[][] = [];
    const rc = await drilldownWith(
      ["t", "Architecture", dd, "", join(art, "doc.md"), "viola", "codex"],
      { offsetFor: () => 0, send: async (a) => { sends.push(a); // simulate the part writing its drill file
          const m = a[a.length - 1].slice(1); /* @<promptfile> not the out path */ return 0; },
        wait: async () => ({ event: "done" }), multiplier: () => "1.0" },
      { writeProbe: (p: string) => writeFileSync(p, "notes\n") }, // test hook: create the out file the part would write
    );
    expect(rc).toBe(0);
    expect(sends[0]).toContain("--from"); expect(sends[0]).toContain("maestro");
    expect(existsSync(join(dd, "_scratch", "drilldown-architecture-viola.md"))).toBe(true);
  });
  it("all-empty round → rc 1; bad arg count → rc 2", async () => {
    const art = scoreArtDir("t"); const dd = join(art, "drilldowns"); mkdirSync(join(dd, "_scratch"), { recursive: true });
    writeFileSync(join(art, "doc.md"), "# doc\n"); mkdirSync(partDir("viola", "codex", "t"), { recursive: true });
    const rc = await drilldownWith(["t", "Arch", dd, "", join(art, "doc.md"), "viola", "codex"],
      { offsetFor: () => 0, send: async () => 0, wait: async () => ({ event: "done" }), multiplier: () => "1.0" }, {});
    expect(rc).toBe(1); // no file written
    expect(await drilldownWith(["t", "Arch"], { offsetFor: () => 0, send: async () => 0, wait: async () => null, multiplier: () => "1.0" }, {})).toBe(2);
  });
});
```
(The `writeProbe` test hook lets the test simulate the part producing its drill file between send and
wait; the live path has no such hook — the real part writes the file.)

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement** — add dispatch `case "drilldown"`, the `composeDrilldownPrompt`/`drilldownState`
imports (from scoreTurn), `resolveDrilldownPath` (from score core), and:

```ts
interface DrilldownDeps extends ResearchSendDeps, ResearchWaitDeps {}
interface DrilldownTestHooks { writeProbe?: (outPath: string) => void; }
const DRILLDOWN_TIMEOUT = () => Number(process.env.CONSORT_DRILLDOWN_TIMEOUT_S) || 90;

async function drilldownRun(rest: string[]): Promise<number> {
  return drilldownWith(rest, { ...liveResearchSendDeps, ...liveResearchWaitDeps }, {});
}

export async function drilldownWith(rest: string[], d: DrilldownDeps, hooks: DrilldownTestHooks): Promise<number> {
  // positional: topic section ddDir focus designDoc i1 m1 [i2 m2] [subproject]
  const n = rest.length;
  if (n < 7 || n > 10 || n === 8 && false) { /* counts 7..10 allowed; refine below */ }
  if (![7, 8, 9, 10].includes(n)) { log.error("usage: score drilldown <topic> <section> <dd-dir> <focus> <design-doc> <i1> <m1> [<i2> <m2>] [<subproject>]"); return 2; }
  const [topic, section, ddDir, focus, designDoc, i1, m1] = rest;
  let i2 = "", m2 = "", subproject = "";
  if (n === 8) subproject = rest[7];
  else if (n === 9) { i2 = rest[7]; m2 = rest[8]; }
  else if (n === 10) { i2 = rest[7]; m2 = rest[8]; subproject = rest[9]; }
  if (!existsSync(ddDir)) { log.error(`score drilldown: dd-dir not found: ${ddDir}`); return 2; }
  if (!existsSync(designDoc)) { log.error(`score drilldown: design-doc not found: ${designDoc}`); return 2; }

  const scratch = join(ddDir, "_scratch");
  mkdirSync(scratch, { recursive: true });
  const parts = [{ inst: i1, model: m1 }, ...(i2 ? [{ inst: i2, model: m2 }] : [])];

  // Resolve all out-paths BEFORE dispatch so parallel parts never target the same file.
  const jobs = parts.map((p) => ({ ...p, outPath: resolveDrilldownPath(scratch, section, p.inst, subproject || undefined) }));
  const timeout = (provider: string) => scaledTimeout(DRILLDOWN_TIMEOUT(), d.multiplier(provider));

  const results = await Promise.all(jobs.map(async (j) => {
    const promptFile = join(scratch, `.${j.inst}-drill-prompt.md`);
    atomicWrite(promptFile, composeDrilldownPrompt({ section, designDocPath: designDoc, focus, outPath: j.outPath }));
    const offset = d.offsetFor(j.inst, j.model, topic);          // BEFORE send
    const rc = await d.send(["--from", "maestro", j.inst, topic, `@${promptFile}`]);
    if (rc !== 0) return "missing" as const;
    hooks.writeProbe?.(j.outPath);                                // test-only: simulate the part's write
    const ev = await d.wait(j.inst, j.model, topic, offset, ["done", "error"], timeout(j.model));
    const fileText = existsSync(j.outPath) ? readFileSync(j.outPath, "utf8") : null;
    return drilldownState(ev, fileText);
  }));

  const ok = results.filter((r) => r === "ok").length;
  log.ok(`score drilldown: ${ok}/${jobs.length} parts produced notes`);
  return ok > 0 ? 0 : 1;
}
```
(Clean up the stray `n === 8 && false` line — the real guard is the `![7,8,9,10].includes(n)` check.
`ResearchSendDeps`/`ResearchWaitDeps`/`liveResearchSendDeps`/`liveResearchWaitDeps` already exist from
Phase C. Add `drilldown` to the dispatch switch + the `usage()` string.)

- [ ] **Step 4: Run** `npx vitest run tests/score-escalation.test.ts -t drilldown && npm run typecheck && npm run lint` → PASS/clean.
- [ ] **Step 5: Commit** — `"feat(score): drilldown subcommand (K<=2 dispatch, offset-before-send, collision paths)"`

---

### Task 7: `score forensics` + `score archive` thin verbs

**Files:** Modify `src/commands/score.ts`; Test `tests/score-escalation.test.ts`

Two thin verbs so the directive invokes the capture/archive by topic. `forensics` → `captureArtDir`
(prints the path or empty; always rc 0). `archive` → `archiveTopic(topic,'score')` (rc 0).

- [ ] **Step 1: Add failing tests (append to `tests/score-escalation.test.ts`)**

```ts
import { forensicsRun, archiveRun } from "../src/commands/score.js";

describe("score forensics + archive", () => {
  it("forensics prints a path when there are findings, else empty (rc 0)", async () => {
    const art = scoreArtDir("t"); mkdirSync(join(art, "design-doc"), { recursive: true });
    writeFileSync(join(art, "design-doc", "audit.log"), "ISSUE=no_goal_section\n");
    let out = ""; const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { out += s; return true; };
    let rc = 0; try { rc = await forensicsRun(["t"]); } finally { (process.stdout as any).write = orig; }
    expect(rc).toBe(0);
    expect(out).toMatch(/forensics[\/\\]2\d{3}-\d\d-\d\d[\/\\].*-score-t\.md/);
  });
  it("archive moves _score and rmdirs the topic (rc 0)", async () => {
    const art = scoreArtDir("t"); mkdirSync(join(art, "design-doc"), { recursive: true });
    writeFileSync(join(art, "topic.txt"), "t");
    expect(await archiveRun(["t"])).toBe(0);
    expect(existsSync(art)).toBe(false); // moved to archive
  });
});
```

- [ ] **Step 2: Run to confirm fail** → FAIL.

- [ ] **Step 3: Implement** — import `captureArtDir` from `../core/forensics.js` + `archiveTopic` from
`../core/archive.js`; dispatch `case "forensics"` / `case "archive"`; and:

```ts
export async function forensicsRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score forensics <topic>"); return 2; }
  const path = captureArtDir({ artDir: scoreArtDir(topic), command: "score" });
  if (path) { log.ok(`score forensics: captured ${path}`); process.stdout.write(path + "\n"); }
  else log.info("score forensics: no mechanical findings (no file written)");
  return 0; // best-effort: never fails the wind-down
}

export async function archiveRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: score archive <topic>"); return 2; }
  archiveTopic(topic, "score");
  log.ok(`score archive: archived _score for ${topic}`);
  return 0;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"feat(score): forensics + archive thin verbs"`

---

### Task 8: `commands/score.md` — Stage 13 (drilldown loop)

**Files:** Modify `commands/score.md`

Insert Stage 13 at the "Continue to Stage 13 (Phase F)" point (replacing the Phase E end-stub).

- [ ] **Step 1: Replace the Phase E end-blockquote** ("Phase E ends … Phase F automates it") with Stage 13:

```markdown
## Stage 13 — drilldown (optional; parts still live)

(Fast-path: no parts → skip Stages 13–15 entirely; go to Stage 16.) Derive the design-doc path
(`$ART/design-doc/<date>-<TOPIC>-design.md`, also printed by `assemble`; missing → tell the user and
skip drilldown). **AskUserQuestion**: "Any aspect to drill deeper before tearing down? (parts still
live)" — **Yes, drill** / **No, proceed to teardown**. While Yes, per round:
1. Free-form: **drill subject** (a section/topic) → SECTION; **focus angle** (e.g. "the tradeoffs feel
   hand-wavy") → FOCUS.
2. **AskUserQuestion which part(s)** — an N-aware option set from `$ART/roster.txt`: N=2 → the 2 parts +
   "both (parallel)"; N=3 → the 3 parts + 3 pairs + "all three (parallel)".
3. Dispatch (the CLI caps at 2 parts per call):
   - one or two parts → one call: `$CS score drilldown <TOPIC> "<SECTION>" "$ART/drilldowns" "<FOCUS>"
     <DESIGN_DOC> <i1> <m1> [<i2> <m2>]`.
   - **all three** → **two parallel** `$CS score drilldown …` Bash calls in one message (a K=2 call +
     a K=1 call) sharing `<TOPIC>` + `"$ART/drilldowns"`. Success if ≥1 call returns rc 0.
   - multi-repo: append the target `<subproject>` slug as the final arg to scope the drill; the output
     file then carries the `-<subproject>-` infix.
4. **Read back** `$ART/drilldowns/_scratch/drilldown-<section-slug>-*.md` (tolerate an optional
   `-<subproject>-` infix) and summarize. On **rc 1** (all empty/timeout) → AskUserQuestion **Retry /
   Different aspect / Skip**. Then "Drill another aspect?" — loop or proceed.

The drill files stay in `_score/drilldowns/_scratch/` (out of `design-doc/`) and ride along into the
archive (Stage 15). Re-drilling the same section auto-suffixes `-2`, `-3`, ….
```

- [ ] **Step 2: Stale-token check** of the new prose. **Step 3: Commit** —
  `"feat(score): score.md Stage 13 drilldown loop"`

---

### Task 9: `commands/score.md` — Stages 14a (forensics + reflection), 14b (teardown), 15 (archive), 16 (present)

**Files:** Modify `commands/score.md`

- [ ] **Step 1: Append Stages 14a–16:**

```markdown
## Stage 14a — forensics capture + Maestro reflection

`FORENSICS=$($CS score forensics <TOPIC>)` (best-effort; prints a path only if mechanical signals were
found, else empty — never blocks). If `FORENSICS` is non-empty: tell the user "forensics captured:
$FORENSICS", then **Read** it and **append** a `## Maestro reflection` section (3–5 interpretive bullets:
what's surprising, repeat-vs-first-time patterns, the suggested next action — a memory worth saving, a
spec topic, a patch, or a one-off) via the Write/Edit tool. **Idempotent:** skip the append if the file
already contains the exact header `## Maestro reflection`. The forensics file lives under
`~/.consort/forensics/<date>/` — OUTSIDE the topic state — so it survives teardown + archive.

## Stage 14b — teardown (FINE banner)

Tear down all live parts in one shared banner: read the roster instruments from `$ART/roster.txt` and
run `$CS coda --pairs <TOPIC> <instrument…>` (one 9s graceful FINE-banner batch, then hard-kill +
per-part archive). Per-part failures are tolerated. (Equivalent fallback: `$CS coda <instrument>
<TOPIC>` per part.) Fast-path: no parts → skip.

## Stage 15 — archive

`$CS score archive <TOPIC>` → `archiveTopic(topic,'score')`: stamps every part `status.json` to
`state=archived`, moves the whole `_score/` dir (including `drilldowns/`) to
`~/.consort/archive/<repo-hash>/<TOPIC>/_score-<ts>`, and rmdirs the topic. The forensics file from
Stage 14a is untouched (it lives outside the state tree). Fast-path: skip (nothing beyond the doc).

## Stage 16 — present + perform handoff

**Read and present** the final design-doc (`$ART/design-doc/<date>-<TOPIC>-design.md` — the path
`assemble` printed; after Stage 15 it's the archived copy). Then point the user at the next step:
"run `/consort:perform <doc>` once perform ships" — the deploy-audit gate already guarantees the doc is
perform-ready (single-repo AND multi-repo). This is the end of `score`.
```

- [ ] **Step 2: Update the closing Notes** so the wind-down (Stages 13–16) is listed as shipped; only
  the other high-level commands (`perform`/`prelude`/`rehearsal`/`playback`) remain.
- [ ] **Step 3: Rebuild** — `npm run build`. **Step 4: Stale-token gate + full suite** —
  `npx vitest run tests/stale-tokens.test.ts && npm run test`; fix any leak. Confirm the new verbs are
  in the top-level `usage()` string + dispatch (`drilldown`/`forensics`/`archive`).
- [ ] **Step 5: Commit** — `"feat(score): score.md Stages 14a-16 (forensics+reflection, teardown, archive, present) + rebuild dist"`

---

### Task 10: Full gate + final acceptance dogfood + DOGFOOD.md

**Files:** verify gates; modify `docs/superpowers/DOGFOOD.md`

- [ ] **Step 1: Full gate** — `npm run typecheck && npm run lint && npm run test` (all green; new
  `forensics`/`score-core`/`score-turn`/`score-escalation` suites).

- [ ] **Step 2: Final acceptance dogfood (live tmux, isolated home)** — focus on the NEW Stage 13–16
  surface; reuse the proven pre-Stage-13 pipeline rather than re-running it three times:
  - **Escalated single-repo (primary):** run a real N≥2 ensemble to an audit-passing doc (Phase C/D
    path), then **Stage 13**: answer the gate Yes, give subject+focus, drill one part, **re-drill the
    same section** → confirm the `-2` suffix; verify files in `_score/drilldowns/_scratch/`; confirm an
    all-empty round surfaces Retry/Different/Skip. **Stage 14a**: seed a mechanical signal (e.g. an
    outbox `error` or `status=error`) → confirm a forensics file under `~/.consort/forensics/<date>/`,
    that Maestro appends `## Maestro reflection`, and a re-run does NOT double-append. **Stage 14b**:
    `coda --pairs` tears down all parts with the **FINE** banner. **Stage 15**: `score archive` →
    `_score` under `~/.consort/archive/…/_score-<ts>` with `status.json state=archived`, topic dir gone,
    **forensics file still present** (survives). **Stage 16**: present + the `/consort:perform` handoff.
  - **Fast-path smoke:** a no-parts topic → Stages 13/14b/15 skip cleanly; Stage 16 still presents.
  - **Multi-repo smoke:** over a Phase-E-style multi doc, one drilldown round using the `-<subproject>-`
    infix + a 3-part "all three" fan-out (two parallel `score drilldown` calls), then teardown + archive.

- [ ] **Step 3: Append the Phase F dogfood section to `docs/superpowers/DOGFOOD.md`** — the drill
  rounds (+ collision suffix), the forensics path + idempotent reflection, the FINE teardown, the
  archive (drilldowns inside, forensics survived), the present handoff, PASS/FAIL.

- [ ] **Step 4: Commit** — `"docs(score): Phase F final acceptance dogfood (drilldown -> forensics -> teardown -> archive -> present)"`

---

## Final review (after all tasks) → finish the branch

Holistic reviewer over the **whole `score` command** (Phases A–F): confirm `captureArtDir` is fully
best-effort (no path throws); the `## Maestro reflection` writer + guard use one exact header;
`resolveDrilldownPath` doesn't compound suffixes + caps at 99; drilldown captures offset before send +
treats empty-file terminal events as `missing`; the wind-down reuses `coda`/`archiveTopic` (no rewrite);
forensics lives outside the state tree (survives archive); `present` stays a forward pointer; no frozen
token renamed; stale-token gate green; `dist` in sync.

Then **superpowers:finishing-a-development-branch** — `score` is complete (A–F). Per the user's "PR
later" choice, present the finish options and, when the user is ready, open the `feat/score` PR.
