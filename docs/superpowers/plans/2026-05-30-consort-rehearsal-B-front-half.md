# consort `rehearsal` — Phase B: Front Half (init + metric/SOTA + spawn) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build `rehearsal`'s synchronous front half — the `init`/`metric`/`sota`/`spawn-all` CLI verbs and the `commands/rehearsal.md` directive Phases 0–3 (args fence → metric discussion → SOTA sweep → roster + time-budget → batch-spawn persistent codex parts).

**Architecture:** Verbs live in `src/commands/rehearsal.ts` (a verb router dispatched by `rehearsal <verb>`), following the solo/score init structure (injected `*Deps` for testability). They consume Phase A's pure core (`extractMetric`, `formatMetricBlock`, `formatSotaBlock`, `rehearsalArtDir`) and REUSE score's batch-spawn machinery (`preflightRun`, `spawnRun`, `spawnResultsTsv`, `spawnTally`, `parsePanesFile`, `spawnRosterArg` from `src/core/score.ts`) + `pickInstruments` (instruments.ts). The directive orchestrates them.

**Tech Stack:** TypeScript (ES2022 / NodeNext / strict), vitest, esbuild. No new deps.

**Grounding (verified by the Phase-B grounding workflow):**
- Slug: `deriveSlug(text)` from `src/core/solo.ts` (re-exported by score.ts) — lowercase→`[a-z0-9-]`→collapse→trim→**cap 20**→trim-trailing-dash; `""` if no alphanumerics. consort uses the **bare slug as the topic dir** (no `rehearsal-` prefix) + a `_rehearsal` artifact subdir, and an **in-flight guard** (`existsSync(art)`→error) instead of a `-N` collision loop.
- Codex gate: `instrumentBinary("codex")` (`src/core/contracts.ts`, `string|undefined`) + `haveCmd(binary)` (`src/core/deps.ts`) — exactly as `solo init` does (return 3 on failure).
- `atomicWrite(dest, content)` (`src/core/atomic.ts`) does NOT create parent dirs — `mkdirSync(dir,{recursive:true})` first.
- Paths: `topicDir(topic, opts?)`, `rehearsalArtDir(topic, opts?)` (already built in Phase A, threads opts), `globalRoot(home?)`.
- Batch spawn (reuse score's `spawnAllWith` pattern): `preflightRun([topic, String(N), "--roster", spawnRosterArg(rows), "--art-dir", art])` → read `preflight-panes.txt` via `parsePanesFile` → `Promise.all(rows.map(r => spawnRun([r.instrument, r.provider, topic, "--target-pane", panes.get(r.instrument)!, "--cwd", repoRoot()])))` → `atomicWrite(join(art,"spawn-results.tsv"), spawnResultsTsv(results))` → `spawnTally(rcs)` (0 all / 1 partial / 2 none). `SpawnResult = {instrument, provider, rc}`. preflight caps N at 2..4 (rehearsal's 2–3 fits). Provider string for codex = literally `"codex"`.
- Directive conventions (`commands/score.md`/`solo.md`/`roster.md`): frontmatter `allowed-tools: Bash, Write, Read, Edit, AskUserQuestion`; `Let \`CS="node ${CLAUDE_PLUGIN_ROOT}/dist/consort.cjs"\``; 3-step fence (`$CS rehearsal --mint-args-file` → Write `$ARGUMENTS` verbatim → `$CS rehearsal init --args-file <path>`); init prints capture-vars to **stdout** (logs to stderr); `AskUserQuestion` is PROSE (bold verb + quoted prompt + `Option / Option` labels, ≤4 options).

**Conventions:**
- Verb tests use `freshHome()` from `tests/helpers/tmpHome.ts` (sets `CONSORT_HOME`, returns `{home, cleanup}`); pass `{home, cwd}` opts to path helpers OR rely on `CONSORT_HOME`. Match how `tests/score-*.test.ts` / `tests/solo*.test.ts` set up.
- After each task: `npm run test`, `npm run typecheck`, `npm run lint` green before commit. Do NOT touch `dist/` until Task B4.
- No banned tokens (`clone-wars`/`cw_`/`master-yoda`/`MISSION ACCOMPLISHED`/`@cw_`/case-insensitive `trooper`/`commander`) in `src`/`commands`. Cite the prior plugin as `deep-research-init.sh`/`deep-research.md` in JSDoc.
- **Before writing a verb, the implementer should READ `src/commands/score.ts` + `src/commands/solo.ts`** to copy the exact `--mint-args-file`/`--args-file` handling, the `*Deps` DI shape, the flag-parse style, and the `log`/stdout/stderr conventions. The code below is complete but must match the repo's existing idioms where they differ (e.g. the args-file helper name).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/commands/rehearsal.ts` | Verb router + `init`, `metric`, `sota`, `spawn-all` verbs (with injected `*Deps`). |
| `src/consort.ts` | Register `rehearsal` in the destructured import + handler map. |
| `commands/rehearsal.md` | The directive Phases 0–3 (Phase 4+ added in Phase C). |
| `tests/rehearsal-cmd.test.ts` | Verb unit tests (init/metric/sota/spawn-all). |

---

## Task B1: `rehearsal init` verb + router + registration

**Files:**
- Create: `src/commands/rehearsal.ts`
- Modify: `src/consort.ts`
- Test: `tests/rehearsal-cmd.test.ts`

`init` parses `--seed-from`/`--time-budget`/`--metric`/`--slug` + positional topic, gates on codex, derives the slug, guards in-flight, scaffolds `_rehearsal/`, seeds `topic.txt`/`metric.txt`, optionally pre-writes `metric.md` (`--metric`) and `time-budget.txt`+`session-start.txt` (`--time-budget`), and prints `TOPIC=`/`ART=` to stdout.

- [ ] **Step 1: Read the existing idioms.** Read `src/commands/solo.ts` and `src/commands/score.ts` in full. Note: the exact `--mint-args-file` + `--args-file` handling (copy it), the `InitDeps`/`*Deps` DI shape, the flag-parse loop style, `log.error`/`log.info` usage, and how `init` prints `ART=`/`TOPIC=` to stdout. Your `rehearsal.ts` must match these idioms; the code in Step 3 is the intended behavior, adapt its surface to the repo's actual helpers (especially the args-file mint/read helper names).

- [ ] **Step 2: Write the failing test.** Create `tests/rehearsal-cmd.test.ts`:

```ts
// tests/rehearsal-cmd.test.ts — rehearsal CLI verbs (Phase B).
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { freshHome } from "./helpers/tmpHome.js";
import { initWith, type RehearsalInitDeps } from "../src/commands/rehearsal.js";
import { rehearsalArtDir } from "../src/core/rehearsal.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function home() { const h = freshHome(); cleanups.push(h.cleanup); return h; }

const okDeps = (over: Partial<RehearsalInitDeps> = {}): RehearsalInitDeps => ({
  haveCmd: () => true,
  instrumentBinary: (n) => (n === "codex" ? "codex" : undefined),
  now: () => "2026-05-30T00:00:00Z",
  probeHardware: () => {},
  ...over,
});

describe("rehearsal init", () => {
  it("scaffolds the _rehearsal art dir, topic.txt, and a metric.txt seed; prints TOPIC + ART", async () => {
    const h = home();
    const out: string[] = [];
    const log = (s: string) => out.push(s);
    const rc = await initWith(["maximize accuracy under 100k params"],
      okDeps({ stdout: log, opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(0);
    const art = rehearsalArtDir("maximize-accuracy-under", { home: h.home, cwd: h.home });
    expect(existsSync(art)).toBe(true);
    expect(readFileSync(`${art}/topic.txt`, "utf8")).toBe("maximize accuracy under 100k params");
    expect(readFileSync(`${art}/metric.txt`, "utf8").trim()).toBe("accuracy"); // extractMetric seed
    expect(out.join("\n")).toContain(`ART=${art}`);
    expect(out.join("\n")).toContain("TOPIC=maximize-accuracy-under");
  });
  it("gates on codex availability (rc 3)", async () => {
    const h = home();
    const rc = await initWith(["x topic"], okDeps({ haveCmd: () => false, opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(3);
  });
  it("rejects an empty slug (rc 2)", async () => {
    const h = home();
    const rc = await initWith(["!!!"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(2);
  });
  it("refuses an already-in-flight topic (rc 2)", async () => {
    const h = home();
    const d = okDeps({ opts: { home: h.home, cwd: h.home } });
    expect(await initWith(["same topic"], d)).toBe(0);
    expect(await initWith(["same topic"], d)).toBe(2);
  });
  it("--metric pre-writes metric.md; --time-budget pre-writes time-budget.txt + session-start.txt", async () => {
    const h = home();
    const rc = await initWith([
      "--metric", "primary_metric=accuracy,direction=maximize,min_acceptable=>= 0.9,target=>= 0.99",
      "--time-budget", "4h", "tune model",
    ], okDeps({ opts: { home: h.home, cwd: h.home } }));
    expect(rc).toBe(0);
    const art = rehearsalArtDir("tune-model", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art}/metric.md`, "utf8")).toContain("**Primary metric:** accuracy");
    expect(readFileSync(`${art}/time-budget.txt`, "utf8").trim()).toBe("14400"); // 4h
    expect(readFileSync(`${art}/session-start.txt`, "utf8").trim()).toBe("2026-05-30T00:00:00Z");
  });
  it("--slug overrides derivation; --time-budget none / Ns / int all resolve", async () => {
    const h = home();
    expect(await initWith(["--slug", "myrun", "--time-budget", "none", "anything"],
      okDeps({ opts: { home: h.home, cwd: h.home } }))).toBe(0);
    const art = rehearsalArtDir("myrun", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art}/time-budget.txt`, "utf8").trim()).toBe("none");
  });
});
```

- [ ] **Step 3: Run the test, confirm it fails** (`Cannot find module ../src/commands/rehearsal.js`).

Run: `npm run test -- rehearsal-cmd`

- [ ] **Step 4: Implement `src/commands/rehearsal.ts`.** Adapt to the idioms from Step 1 (args-file helper, log). Intended behavior:

```ts
// /consort:rehearsal CLI verbs (Phase B front half). Ports deep-research-init.sh
// (slug/codex-gate/flags/scaffolding) + the deep-research.md Phase 0-3 surface.
// Verb router dispatched by `rehearsal <verb>`.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../core/atomic.js";
import { deriveSlug } from "../core/solo.js";
import { extractMetric, formatMetricBlock } from "../core/rehearsalMetric.js";
import { rehearsalArtDir } from "../core/rehearsal.js";
import { instrumentBinary } from "../core/contracts.js";
import { haveCmd } from "../core/deps.js";
import { log } from "../core/log.js";

type PathOpts = { home?: string; cwd?: string };

export interface RehearsalInitDeps {
  haveCmd(name: string): boolean;
  instrumentBinary(name: string): string | undefined;
  now(): string;                          // ISO-8601 UTC
  probeHardware?(path: string): void;     // best-effort; default no-op
  stdout?: (line: string) => void;        // default process.stdout
  opts?: PathOpts;                         // home/cwd for path resolution (tests)
}

/** Parse "--flag value" / "--flag=value" + a trailing positional topic. */
function parseInitArgs(args: string[]): { topic: string; seedFrom?: string; timeBudget?: string; metric?: string; slug?: string } {
  let topic = "", seedFrom, timeBudget, metric, slug;
  const take = (i: number, inline?: string) => inline ?? args[++i] ?? "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") ? (eq > 0 ? a.slice(0, eq) : a) : "";
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
    if (flag === "--seed-from") { seedFrom = inline ?? args[++i]; }
    else if (flag === "--time-budget") { timeBudget = inline ?? args[++i]; }
    else if (flag === "--metric") { metric = inline ?? args[++i]; }
    else if (flag === "--slug") { slug = inline ?? args[++i]; }
    else if (a.startsWith("--")) { /* unknown flag → caller errors */ topic = `__BADFLAG__${a}`; }
    else { topic = args.slice(i).join(" "); break; }
  }
  return { topic, seedFrom, timeBudget, metric, slug };
}

/** Resolve --time-budget: none | <N>h | <N>s | positive integer seconds. Throws on malformed. */
function resolveTimeBudget(v: string): string {
  if (v === "none") return "none";
  if (/^[1-9][0-9]*h$/.test(v)) return String(parseInt(v, 10) * 3600);
  if (/^[1-9][0-9]*s$/.test(v)) return String(parseInt(v, 10));
  if (/^[1-9][0-9]*$/.test(v)) return v;
  throw new Error(`invalid --time-budget: '${v}' (expected 'none', '<N>h', '<N>s', or positive seconds)`);
}

export async function initWith(args: string[], deps: RehearsalInitDeps): Promise<number> {
  const out = deps.stdout ?? ((l: string) => process.stdout.write(l + "\n"));
  const p = parseInitArgs(args);
  if (p.topic.startsWith("__BADFLAG__")) { log.error(`rehearsal init: unknown flag: ${p.topic.slice(11)}`); return 2; }
  if (!p.topic) { log.error("rehearsal init: topic required"); return 2; }

  let resolvedBudget: string | undefined;
  if (p.timeBudget !== undefined) {
    try { resolvedBudget = resolveTimeBudget(p.timeBudget); }
    catch (e) { log.error(`rehearsal init: ${(e as Error).message}`); return 2; }
  }

  // codex gate (single-binary, like solo init)
  const binary = deps.instrumentBinary("codex");
  if (!binary) { log.error("rehearsal init: codex has no entry in contracts.yaml"); return 3; }
  if (!deps.haveCmd(binary)) { log.error("rehearsal init: codex binary not on PATH; install codex and run /consort:soundcheck"); return 3; }

  // slug
  let slug: string;
  if (p.slug !== undefined) {
    if (!/^[a-z][a-z0-9-]{0,19}$/.test(p.slug)) { log.error(`rehearsal init: --slug must match ^[a-z][a-z0-9-]{0,19}$; got '${p.slug}'`); return 2; }
    slug = p.slug;
  } else {
    slug = deriveSlug(p.topic);
  }
  if (!slug) { log.error("rehearsal init: topic produced an empty slug; provide alphanumerics"); return 2; }

  const art = rehearsalArtDir(slug, deps.opts);
  if (existsSync(art)) { log.error(`rehearsal init: topic already in flight: ${art}`); return 2; }

  // seed-from validation
  if (p.seedFrom && !existsSync(p.seedFrom)) { log.error(`rehearsal init: --seed-from not found: ${p.seedFrom}`); return 1; }

  mkdirSync(art, { recursive: true });
  atomicWrite(join(art, "topic.txt"), p.topic);
  atomicWrite(join(art, "metric.txt"), extractMetric(p.topic) + "\n");
  if (p.seedFrom) atomicWrite(join(art, "seed-from.txt"), p.seedFrom + "\n");
  (deps.probeHardware ?? (() => {}))(join(art, "hardware.txt"));

  if (p.metric !== undefined) {
    const fields: Record<string, string> = {};
    for (const pair of p.metric.split(",")) { const i = pair.indexOf("="); if (i > 0) fields[pair.slice(0, i)] = pair.slice(i + 1); }
    try { atomicWrite(join(art, "metric.md"), formatMetricBlock(fields)); }
    catch (e) { log.error(`rehearsal init: --metric: ${(e as Error).message}`); return 2; }
  }
  if (resolvedBudget !== undefined) {
    atomicWrite(join(art, "time-budget.txt"), resolvedBudget + "\n");
    atomicWrite(join(art, "session-start.txt"), deps.now() + "\n");
  }

  out(`TOPIC=${slug}`);
  out(`ART=${art}`);
  return 0;
}

const liveInitDeps: RehearsalInitDeps = {
  haveCmd, instrumentBinary,
  now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
};

export async function run(args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  switch (verb) {
    case "init": return initWith(rest, liveInitDeps);
    // metric / sota / spawn-all added in B2/B3
    default: log.error(`rehearsal: unknown verb: ${verb ?? "(none)"}`); return 2;
  }
}
```

> Adapt: if `src/core/log.ts` exports `log` differently (e.g. `log.error`/`log.info`/`log.ok`), match it. If the `now` ISO format helper exists elsewhere, reuse it. The `--mint-args-file`/`--args-file` handling is added to `run()` in B4 (copy score's) — for B1 the unit tests call `initWith` directly.

- [ ] **Step 5: Register in `src/consort.ts`.** Add `rehearsal` to the destructured dynamic import array + the handler map (mirror how `playback`/`score` are registered — find the `Promise.all([...import(...)])` block and the handler object). Example shape:

```ts
// add to the import list:
import("./commands/rehearsal.js"),
// destructure: ...rehearsal
// add to handlers: rehearsal: rehearsal.run,
```

- [ ] **Step 6: Run the tests, typecheck, lint.**

Run: `npm run test -- rehearsal-cmd` → PASS (6 cases). `npm run typecheck` → 0. `npm run lint` → clean.

- [ ] **Step 7: Commit.**

```bash
git add src/commands/rehearsal.ts src/consort.ts tests/rehearsal-cmd.test.ts
git commit -m "feat(rehearsal): init verb + router + registration (Phase B1)"
```

---

## Task B2: `metric` + `sota` verbs (write metric.md / sota.md from K=V)

**Files:**
- Modify: `src/commands/rehearsal.ts`
- Test: `tests/rehearsal-cmd.test.ts`

Thin verbs the directive calls after gathering K=V (Phase 1) / curating refs (Phase 1.5). `metric <topic> --kv "k=v,..."` → `formatMetricBlock` → `$ART/metric.md`. `sota <topic> --kv "topic=...,metric=...,sweep_date=...,ref_1=...,..."` → `formatSotaBlock` → `$ART/sota.md`. Both write atomically into the resolved `_rehearsal` art dir.

- [ ] **Step 1: Write the failing test** (append to `tests/rehearsal-cmd.test.ts`):

```ts
import { metricWith, sotaWith } from "../src/commands/rehearsal.js";

describe("rehearsal metric / sota verbs", () => {
  it("metric writes metric.md from --kv", async () => {
    const h = home();
    await initWith(["--slug", "r1", "topic one"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await metricWith(["r1", "--kv", "primary_metric=auc,direction=maximize,min_acceptable=>= 0.8"],
      { opts: { home: h.home, cwd: h.home } });
    expect(rc).toBe(0);
    const art = rehearsalArtDir("r1", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art}/metric.md`, "utf8")).toContain("**Primary metric:** auc");
  });
  it("metric returns 2 on a bad block (missing direction)", async () => {
    const h = home();
    await initWith(["--slug", "r2", "topic two"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    expect(await metricWith(["r2", "--kv", "primary_metric=auc"], { opts: { home: h.home, cwd: h.home } })).toBe(2);
  });
  it("sota writes sota.md from --kv with ref rows", async () => {
    const h = home();
    await initWith(["--slug", "r3", "topic three"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await sotaWith(["r3", "--kv",
      "topic=mnist,metric=accuracy,sweep_date=2026-05-30,ref_1=cnn|0.99|fits|url|note"],
      { opts: { home: h.home, cwd: h.home } });
    expect(rc).toBe(0);
    const art = rehearsalArtDir("r3", { home: h.home, cwd: h.home });
    const md = readFileSync(`${art}/sota.md`, "utf8");
    expect(md).toContain("# SOTA reference — mnist");
    expect(md).toContain("| cnn | 0.99 | fits | url | note |");
  });
});
```

- [ ] **Step 2: Run, confirm fail** (`metricWith is not a function`). Run: `npm run test -- rehearsal-cmd`

- [ ] **Step 3: Implement** (append to `src/commands/rehearsal.ts`; also wire the verbs into `run()`):

```ts
import { formatSotaBlock } from "../core/rehearsalMetric.js";

interface VerbOpts { opts?: PathOpts }

/** Parse a "k=v,k2=v2,..." --kv value into a record (first '=' splits; supports values with '='). */
function parseKv(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const pair of s.split(",")) { const i = pair.indexOf("="); if (i > 0) o[pair.slice(0, i)] = pair.slice(i + 1); }
  return o;
}

function takeKvFlag(args: string[]): { topic: string; kv: string } {
  let topic = "", kv = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--kv") { kv = args[++i] ?? ""; }
    else if (!args[i].startsWith("--") && !topic) { topic = args[i]; }
  }
  return { topic, kv };
}

export async function metricWith(args: string[], v: VerbOpts = {}): Promise<number> {
  const { topic, kv } = takeKvFlag(args);
  if (!topic) { log.error("rehearsal metric: topic required"); return 2; }
  const art = rehearsalArtDir(topic, v.opts);
  try { atomicWrite(join(art, "metric.md"), formatMetricBlock(parseKv(kv))); }
  catch (e) { log.error(`rehearsal metric: ${(e as Error).message}`); return 2; }
  return 0;
}

export async function sotaWith(args: string[], v: VerbOpts = {}): Promise<number> {
  const { topic, kv } = takeKvFlag(args);
  if (!topic) { log.error("rehearsal sota: topic required"); return 2; }
  const f = parseKv(kv);
  const refs: string[] = [];
  for (let i = 1; i <= 7; i++) { if (f[`ref_${i}`]) refs.push(f[`ref_${i}`]); }
  try {
    atomicWrite(join(rehearsalArtDir(topic, v.opts), "sota.md"),
      formatSotaBlock({ topic: f.topic ?? "", metric: f.metric ?? "", sweep_date: f.sweep_date ?? "", queries: f.queries, refs }));
  } catch (e) { log.error(`rehearsal sota: ${(e as Error).message}`); return 2; }
  return 0;
}
```

Wire into `run()`:
```ts
    case "metric": return metricWith(rest);
    case "sota": return sotaWith(rest);
```

- [ ] **Step 4: Run tests/typecheck/lint** (`npm run test -- rehearsal-cmd` PASS; typecheck 0; lint clean).

- [ ] **Step 5: Commit.**

```bash
git add src/commands/rehearsal.ts tests/rehearsal-cmd.test.ts
git commit -m "feat(rehearsal): metric + sota verbs (Phase B2)"
```

---

## Task B3: `spawn-all` verb (pick codex roster → preflight → batch spawn)

**Files:**
- Modify: `src/commands/rehearsal.ts`
- Test: `tests/rehearsal-cmd.test.ts`

`spawn-all <topic> <N>` picks N distinct instruments via `pickInstruments`, builds codex rows, writes `parts.txt`, then REUSES score's machinery (preflight + `Promise.all(spawn)` + `spawnResultsTsv`/`spawnTally`) writing `spawn-results.tsv`. Returns 0 (all ready) / 1 (partial) / 2 (none or <2 picked). preflight + spawn are injected for testability (no real tmux/codex in unit tests).

- [ ] **Step 1: Read** `src/commands/score.ts` `spawnAllWith` + `src/core/score.ts` (`spawnRosterArg`, `parsePanesFile`, `SpawnResult`, `spawnResultsTsv`, `spawnTally`) + `src/core/instruments.ts` (`pickInstruments`) to confirm the exact signatures, then copy the pattern.

- [ ] **Step 2: Write the failing test** (append):

```ts
import { spawnAllWith, type SpawnAllDeps } from "../src/commands/rehearsal.js";
import { mkdirSync, writeFileSync } from "node:fs";

describe("rehearsal spawn-all", () => {
  function deps(over: Partial<SpawnAllDeps> = {}): SpawnAllDeps {
    return {
      // preflight writes preflight-panes.txt for the roster it is given
      preflight: async (a) => {
        const art = a[a.indexOf("--art-dir") + 1];
        const roster = a[a.indexOf("--roster") + 1]; // "inst:codex,inst2:codex"
        const lines = roster.split(",").map((e, i) => `${e.split(":")[0]}\t%${i + 1}`).join("\n");
        mkdirSync(art, { recursive: true });
        writeFileSync(`${art}/preflight-panes.txt`, lines + "\n");
        return 0;
      },
      spawn: async () => 0, // every part comes up ready
      repoRoot: () => "/repo",
      pickInstruments: (_t, n) => Array.from({ length: n }, (_, i) => `inst${i + 1}`),
      ...over,
    };
  }
  it("picks N codex parts, spawns them, writes parts.txt + spawn-results.tsv, rc 0", async () => {
    const h = home();
    await initWith(["--slug", "s1", "spawn topic"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await spawnAllWith(["s1", "2"], deps(), { home: h.home, cwd: h.home });
    expect(rc).toBe(0);
    const art = rehearsalArtDir("s1", { home: h.home, cwd: h.home });
    expect(readFileSync(`${art}/parts.txt`, "utf8").trim().split("\n")).toEqual(["inst1", "inst2"]);
    const tsv = readFileSync(`${art}/spawn-results.tsv`, "utf8");
    expect(tsv).toContain("inst1\tcodex\t0");
  });
  it("rc 1 when one part fails to come up", async () => {
    const h = home();
    await initWith(["--slug", "s2", "spawn topic 2"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await spawnAllWith(["s2", "2"], deps({ spawn: async (a) => (a[0] === "inst2" ? 1 : 0) }), { home: h.home, cwd: h.home });
    expect(rc).toBe(1);
  });
  it("rc 2 when fewer than 2 instruments can be picked", async () => {
    const h = home();
    await initWith(["--slug", "s3", "spawn topic 3"], okDeps({ opts: { home: h.home, cwd: h.home } }));
    const rc = await spawnAllWith(["s3", "2"], deps({ pickInstruments: () => ["only1"] }), { home: h.home, cwd: h.home });
    expect(rc).toBe(2);
  });
});
```

- [ ] **Step 3: Run, confirm fail** (`spawnAllWith is not a function`). Run: `npm run test -- rehearsal-cmd`

- [ ] **Step 4: Implement** (append; match the real `spawnRosterArg`/`parsePanesFile`/`spawnResultsTsv`/`spawnTally` signatures from `src/core/score.ts`):

```ts
import { readFileSync } from "node:fs";
import { spawnRosterArg, parsePanesFile, spawnResultsTsv, spawnTally, type SpawnResult } from "../core/score.js";
import { pickInstruments } from "../core/instruments.js";
import { repoRoot } from "../core/paths.js";

export interface SpawnAllDeps {
  preflight(args: string[]): Promise<number>;
  spawn(args: string[]): Promise<number>;
  repoRoot(): string;
  pickInstruments(topic: string, n: number): string[];
}

export async function spawnAllWith(args: string[], deps: SpawnAllDeps, opts?: PathOpts): Promise<number> {
  const topic = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? "";
  const n = parseInt(args.find((a) => /^\d+$/.test(a)) ?? "2", 10);
  if (!topic) { log.error("rehearsal spawn-all: topic required"); return 2; }
  const art = rehearsalArtDir(topic, opts);

  const instruments = deps.pickInstruments(topic, n);
  if (instruments.length < 2) { log.error(`rehearsal spawn-all: need >= 2 codex parts; picked ${instruments.length}`); return 2; }
  const rows = instruments.map((instrument) => ({ instrument, provider: "codex" }));
  atomicWrite(join(art, "parts.txt"), instruments.join("\n") + "\n");

  const prc = await deps.preflight([topic, String(rows.length), "--roster", spawnRosterArg(rows), "--art-dir", art]);
  if (prc !== 0) { log.error(`rehearsal spawn-all: preflight failed (rc ${prc})`); return 2; }
  const panes = parsePanesFile(readFileSync(join(art, "preflight-panes.txt"), "utf8"));

  const results: SpawnResult[] = await Promise.all(rows.map(async (r) => ({
    instrument: r.instrument, provider: r.provider,
    rc: await deps.spawn([r.instrument, r.provider, topic, "--target-pane", panes.get(r.instrument) ?? "", "--cwd", deps.repoRoot()]),
  })));
  atomicWrite(join(art, "spawn-results.tsv"), spawnResultsTsv(results));
  return spawnTally(results.map((r) => r.rc));
}
```

> Confirm `spawnRosterArg` produces `"inst:provider,..."` and `SpawnResult`/`spawnResultsTsv`/`spawnTally`/`parsePanesFile` signatures from `src/core/score.ts`; adapt field names if they differ. Wire a live `spawn-all` into `run()` with real deps (preflight=preflightRun, spawn=spawnRun) in B4 alongside the args-file handling.

- [ ] **Step 5: Run tests/typecheck/lint.** (`npm run test -- rehearsal-cmd` PASS; typecheck 0; lint clean.)

- [ ] **Step 6: Commit.**

```bash
git add src/commands/rehearsal.ts tests/rehearsal-cmd.test.ts
git commit -m "feat(rehearsal): spawn-all verb reusing score batch machinery (Phase B3)"
```

---

## Task B4: `commands/rehearsal.md` directive Phases 0–3 + live verb wiring + dist

**Files:**
- Create: `commands/rehearsal.md`
- Modify: `src/commands/rehearsal.ts` (the `run()` router: `--mint-args-file`, `--args-file`, live `spawn-all` deps)
- Modify: `dist/consort.cjs` (rebuilt)

- [ ] **Step 1: Finish `run()`.** Read `src/commands/score.ts`'s `run()` for the exact `--mint-args-file` (mint an args path under `.consort/_args/`, print it) and `--args-file <path>` (read + delete it, pass contents to `initWith`) handling — copy it verbatim, swapping `score`→`rehearsal`. Wire live `spawn-all`:

```ts
import { run as spawnRun } from "./spawn.js";
import { run as preflightRun } from "./preflight.js";
// in run(): case "spawn-all": return spawnAllWith(rest, { preflight: preflightRun, spawn: spawnRun, repoRoot, pickInstruments });
```

(Confirm the exact import names for the spawn/preflight verb entrypoints; score.ts already imports them.)

- [ ] **Step 2: Write `commands/rehearsal.md`.** Frontmatter + the directive. Full content:

````markdown
---
description: Advisor-driven autoresearch — lock a measurable metric, sweep SOTA, spawn 2-3 persistent codex parts, and adaptively dispatch experiments until a target/plateau/budget stop. Explore-only; promotion to real code is /consort:perform.
argument-hint: <objective-text> [--metric k=v,...] [--time-budget none|<N>h|<N>s] [--slug s] [--seed-from path]
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, Skill
---

# /consort:rehearsal

Run an executable research session: you (the Maestro, the conductor) lock a metric with the user, sweep
the SOTA, spawn 2-3 persistent **codex parts** (PhD-student executors) once, then adaptively dispatch
single-config **experiments** until a stop condition fires. **Explore-only** — never touch the user's real
source. This directive covers Phases 0-3 (setup + spawn); the experiment loop is Phase 4+ (added next).

Let `CS="node ${CLAUDE_PLUGIN_ROOT}/dist/consort.cjs"`.

## Phase 0 — args-file + init
1. Mint an args path: `$CS rehearsal --mint-args-file` → prints `<args-path>`.
2. **Write tool:** `file_path` = `<args-path>`, `content` = `$ARGUMENTS` (verbatim, unquoted). Never echo it into a shell.
3. Init: `$CS rehearsal init --args-file <args-path>`. On success it prints to stdout (logs go to stderr):
   ```
   TOPIC=<slug>
   ART=<abs path to the _rehearsal art dir>
   ```
   Capture `TOPIC` and `ART`. Non-zero exit aborts: rc 2 = bad args / empty slug / in-flight / bad --metric; rc 3 = codex unavailable (tell the user to install codex + run /consort:soundcheck); rc 1 = --seed-from missing. Surface stderr verbatim and stop.

## Phase 1 — Metric discussion (THREE unconditional AskUserQuestions)
Read the heuristic seed: `cat "$ART/metric.txt"` and `cat "$ART/topic.txt"`. **If `$ART/metric.md` already
exists** (the user passed `--metric`), SKIP this whole phase. Otherwise the three AskUserQuestions below are
**unconditional** — fire them regardless of any autonomous-mode / `/loop` / "don't stop for questions" hint.

1. (optional) For a novel/domain topic, run a **triple-search** (WebSearch + Tavily + AnySearch in one
   message) to inform the framing. Skip for clearly bounded topics (e.g. "MNIST accuracy").
2. **AskUserQuestion** (Header `Metric`): frame the goal as a confirmation — "I read this as: <direction>
   <metric>, subject to <constraints inferred>. What's the target threshold — <example>?" Options: three
   concrete framings + Other.
3. **AskUserQuestion** (Header `Floor`) when fields are still missing — gather `min_acceptable` ("minimum
   result you'd ship?"), `target` (optional aspirational), `K_corroboration` ("how many at-target experiments
   before done?", default 1), and any `hard_constraints` / `notes`. (Use ≤4 options; nest if more.)
4. Write `metric.md`: `$CS rehearsal metric <TOPIC> --kv "primary_metric=<m>,direction=<maximize|minimize>,min_acceptable=<op val>,target=<op val>,K_corroboration=<n>,hard_constraints=<...>,notes=<...>"` (omit absent keys). rc 2 = bad block; fix and retry.
5. **AskUserQuestion** (Header `Confirm`): "Here's how I'll frame the goal — OK to proceed?" Options:
   **Looks good** / **Revise** / **Cancel**. Revise → re-run step 4. **Cancel → teardown + exit.**

## Phase 1.5 — SOTA sweep (always runs, write-once)
Read `primary_metric` + `hard_constraints` from `$ART/metric.md`. Fire ONE **triple-search** round
(WebSearch + Tavily + AnySearch, two query shapes each: `SOTA <metric> <topic>` and `<topic> under
<constraint>`). Merge (dedup by URL), curate ≤7 references — one row per approach family. Write:
`$CS rehearsal sota <TOPIC> --kv "topic=<topic text>,metric=<primary>,sweep_date=<UTC ISO>,queries=<the queries you fired>,ref_1=<family>|<best>|<fits or over by N>|<url>|<note>,ref_2=..."`. Zero usable refs → omit all `ref_N` (the helper emits the fallback note).

## Phase 2 — Roster size + time budget
1. **Pick N silently** (your call, explain in chat): **N=2** (default — single objective + tight
   constraint) or **N=3** (multiple sub-goals / broad survey / no clear single optimum). When unsure → 2.
   Bias toward different pipelines per part; record the rationale for round 1's `session-summary.md`.
2. **If `$ART/time-budget.txt` already exists** (`--time-budget` passed), skip. Otherwise **AskUserQuestion**
   (Header `Time budget`, unconditional): "Time limit on this research session?" Options: **No limit
   (recommended)** / **4 hours** / **12 hours** / **Other (custom hours)**. Do NOT auto-pick. Then write:
   ```bash
   printf '%s\n' "<none|14400|43200|<hours*3600>>" > "$ART/time-budget.txt"
   date -u +%Y-%m-%dT%H:%M:%SZ > "$ART/session-start.txt"
   ```

## Phase 3 — Batch-spawn persistent codex parts
Spawn N parts in one call: `$CS rehearsal spawn-all <TOPIC> <N>`. It picks N distinct instruments, allocates
panes off your pane (main-vertical), batch-spawns them as codex, and writes `$ART/spawn-results.tsv` +
`$ART/parts.txt`. Branch on rc:
- **rc 0** → all parts ready. Continue (Phase 4 lands next).
- **rc 1 or 2, first failure** → teardown the partial set and retry `spawn-all` ONCE (cold-start tolerance).
- **rc 1 or 2, after retry** → read `$ART/spawn-results.tsv`; if **< 2** parts have rc 0, abort (teardown +
  archive). Else **AskUserQuestion**: **Proceed degraded (<k>/<N>)** / **Abort** — degraded drops the failed
  instruments and continues with the rest.

> Phase 4 (the experiment loop) is added in the next phase. For now, after a successful spawn, report the
> roster + that setup is complete.
````

- [ ] **Step 3: Rebuild dist + smoke test.**

```bash
npm run build
node dist/consort.cjs rehearsal init --slug smoke --time-budget none "smoke topic" 2>/dev/null  # in a temp CONSORT_HOME
```
Confirm it prints `TOPIC=smoke` / `ART=...` and exits 0. (Set `CONSORT_HOME=$(mktemp -d)` first; clean up after.)

- [ ] **Step 4: Run full gates.** `npm run test` (all green), `npm run typecheck` (0), `npm run lint` (clean), `npm run test -- stale-tokens` (green — the directive's `commands/rehearsal.md` must have NO banned tokens; "part"/"instrument"/"Maestro" only).

- [ ] **Step 5: Commit.**

```bash
git add src/commands/rehearsal.ts commands/rehearsal.md dist/consort.cjs
git commit -m "feat(rehearsal): directive Phases 0-3 + live verb wiring + dist (Phase B4)"
```

---

## Task B5: Phase B dogfood checkpoint

**Files:**
- Modify: `docs/superpowers/DOGFOOD.md` (append a Phase B section)

Validate the front-half verbs end-to-end against a real temp `CONSORT_HOME` (no tmux/codex — `spawn-all`'s live path needs real panes, which the codex-trust blocker prevents, so the dogfood exercises `init`/`metric`/`sota` live and notes spawn-all is unit-covered + deferred to the Phase D live dogfood).

- [ ] **Step 1: Write + run a dogfood script** that, in a fresh `CONSORT_HOME`:
  1. `rehearsal init --slug df-mnist "maximize accuracy under 100k params"` → assert `_rehearsal/{topic.txt,metric.txt}` + `metric.txt` seed = `accuracy` + stdout `TOPIC=`/`ART=`.
  2. `rehearsal metric df-mnist --kv "primary_metric=accuracy,direction=maximize,min_acceptable=>= 0.9,target=>= 0.99,K_corroboration=2"` → assert `metric.md` parses (round-trips: `node -e` calling `parseMetricMd`, or grep the lines).
  3. `rehearsal sota df-mnist --kv "topic=mnist,metric=accuracy,sweep_date=2026-05-30,ref_1=cnn|0.995|fits|url|lenet"` → assert `sota.md` has the header + the ref row.
  4. `rehearsal init --slug df-mnist "..."` again → assert rc 2 (in-flight guard).
  5. Codex-gate: a run with a stubbed-absent codex isn't scriptable live; note it's unit-covered (rc 3).

- [ ] **Step 2: Append the result to `docs/superpowers/DOGFOOD.md`** under a `## /consort:rehearsal — Phase B (front half)` heading: the commands run, the asserted outputs, and the note that `spawn-all`'s live tmux/codex path is unit-covered and validated in the Phase D full dogfood (codex directory-trust blocks autonomous live spawns).

- [ ] **Step 3: Commit.**

```bash
git add docs/superpowers/DOGFOOD.md
git commit -m "docs(rehearsal): Phase B front-half dogfood (Phase B5)"
```

---

## Self-Review (against spec §8 Phase B)

- **init (slug/codex-gate/hardware-probe/scaffolding/metric-seed/flags)** → B1. `--metric`/`--time-budget` pre-writes → B1. ✓ (hardware probe is the injected `probeHardware`, default no-op; the real nvidia-smi probe is a best-effort Phase D util — the per-experiment diff tolerates a missing baseline.)
- **metric.md / sota.md writers** → B2 (format-fidelity via the Phase A `formatMetricBlock`/`formatSotaBlock`). ✓
- **roster (pickInstruments) + batch-spawn persistent codex parts** → B3 (reuses score machinery). ✓
- **directive Phases 0/1/1.5/2/3a/3b** → B4: args fence, 3 unconditional metric AskUserQuestions + skip-if-metric.md, triple-search SOTA, silent N=2/3, unconditional time-budget AskUserQuestion + skip-if-file, spawn-all + rc retry/degraded. ✓
- **dogfood checkpoint** → B5. ✓

Type consistency: `initWith`/`metricWith`/`sotaWith`/`spawnAllWith` signatures match their tests; `SpawnAllDeps`/`RehearsalInitDeps` are the injection seams; `rehearsalArtDir(topic, opts)` (Phase A) is used uniformly with `{home, cwd}` for test isolation. The exact `spawnRosterArg`/`parsePanesFile`/`spawnResultsTsv`/`spawnTally`/`SpawnResult` shapes + the `--mint-args-file`/`--args-file` helper + `log` API must be confirmed against the live `src/core/score.ts`/`src/commands/score.ts` during B1/B3/B4 (instructed in each task's Step 1).

No placeholders; every code step shows complete code (adapt-to-idiom notes flag where the implementer must match an existing helper exactly).
