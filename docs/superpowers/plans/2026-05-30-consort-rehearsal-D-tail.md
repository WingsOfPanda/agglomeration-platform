# Rehearsal Phase D — Tail + Interventions + Full Dogfood — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers are **SEQUENTIAL** — every
> verb task edits the shared `src/commands/rehearsal.ts` + shared test files.

**Goal:** Ship the wind-down tail of `/consort:rehearsal` — the six spec'd verbs (`finalize` / `refine` /
`fresh-part` / `abort` / `handoff-extract` / `teardown`) plus `consensus` (user-approved §4 amendment) and a thin
`forensics` verb, the directive Phases 5/6/6b/6c/7, the full simulated-parts dogfood, the `CLAUDE.md` phase-guard
flip, the `dist` rebuild, and the single PR for the whole `feat/rehearsal` branch.

**Architecture:** Three new **pure** core modules (`rehearsalHandoff` / `rehearsalSummary` / `rehearsalFinalize`)
hold the error-prone string/parse logic; the verbs in `rehearsal.ts` are thin FS/IPC shells over them following
the established `*With(args, deps)` + `live*Deps` DI pattern. One mandatory core edit widens `archiveTopic`'s suite
union to include `"rehearsal"` and returns the archived dest. Teardown/fresh-part reuse the shipped `coda`
graceful-teardown + `archiveTopic` machinery rather than reinventing pane mechanics.

**Tech Stack:** TypeScript/ESM (ES2022, NodeNext, strict), esbuild → committed `dist/consort.cjs`, vitest, eslint
flat. tmux only via `execa` behind injected Deps. Behavioral source: `clone-wars/bin/deep-research-*.sh` +
`lib/deep-research.sh` (cite by symbol; line numbers drift).

---

## Decisions locked before implementation (read first)

1. **`consensus` is a thin standalone verb** (user-approved 2026-05-30). Faithful to clone-wars'
   `deep-research-consensus.sh` (a standalone, advisory, on-demand script with **zero** callers — `finalize` never
   invokes it). Wires the already-built Phase-A `buildConsensus`. This **amends** the spec §4/§8 verb list to add
   `consensus` (advisory; never auto-called by `finalize` or the loop).

2. **`finalize` reproduces the FULL `render_summary`** (header → Status → Scoreboard-top-5 → Completion →
   Recent-events → Warnings → Halt) and **replaces `session-summary.md` wholesale** via atomic write. This is
   faithful: clone-wars' `render_summary` header comment states it renders the **mechanical** sections only and
   *"the Maestro fills in Direction + Recent decisions via Write tool **after** this"* — so the wholesale wipe is
   intended and harmless (Phase 5, same Maestro session, still holds the narrative in-context).

3. **`finalize` OMITS the active-marker removal** (clone-wars step 4: `rm -f active-<sid>.txt`). Spec §1: consort
   has **no active-marker lifecycle** and `hook.ts` stays a no-op. There is no marker to remove.

4. **`teardown` is consort-idiomatic** (Phase B precedent: preserve *behavior*, reuse shipped machinery). It does
   the rehearsal-specific pre-steps (preflight-orphan kill, `shared/` sweep, relative `winner` symlink) then calls
   `archiveTopic(topic, "rehearsal")` — which archives `_rehearsal` → `archive/<repoHash>/<topic>/_rehearsal-<ts>`
   (consistent with `score`/`perform`), NOT clone-wars' whole-topic inline `mv`. Pane teardown stays the shipped
   top-level `coda --pairs` (called by the directive, mirroring `perform.md`), exactly as clone-wars splits
   `teardown.sh --pairs` (panes) from `deep-research-teardown.sh` (archive).

5. **Landscape doc + handoff doc cosmetics:** H1 `# Rehearsal: <slug-titled>`; the Experiment-log table uses
   `| Exp | Instrument | Approach | Metric | Status | Runtime |` and the Evidence table `| Rank | Instrument/Exp |
   Metric | Approach | Status |` — `Instrument` everywhere, matching the scoreboard schema (spec §7). These are
   directive prose (Phase D10), not shipped tokens.

6. **Dry-run env var is `CONSORT_DRY_RUN`** (the established consort convention — the Phase-C dogfood + `experiment-send`
   both use it), NOT `CW_DEEP_RESEARCH_DRY_RUN`/`CS_REHEARSAL_DRY_RUN`. `refine`/`fresh-part` align to it.

## Rebrand (apply to every shipped token, comments included) — stale-token gate enforces

`deep-research`→`rehearsal`; `_deep-research/`→`_rehearsal/`; `troopers/<cmdr>`→`parts/<instrument>`;
`troopers.txt`→`parts.txt`; `fresh-trooper`→`fresh-part`; commander concept→`instrument`; worker noun
`trooper`→`part`; `Master Yoda`/`Yoda`/`From: master-yoda`→`Maestro`/`From: maestro`; `## Yoda reflection`→
`## Maestro reflection`; `consult-handoff.md`→`score-handoff.md`; `deep-research-<date>-<slug>.md`→
`rehearsal-<date>-<slug>.md`; `MISSION ACCOMPLISHED`→`FINE`; `cw_*`/`@cw_`/`.clone-wars/`/`CLONE_WARS_HOME`→
dropped/`@cs_`/`.consort/`/`CONSORT_HOME`. JSDoc may cite literal `deep-research-*.sh` filenames.

## FROZEN — never rename in new code

`result.json` 12-key schema; outbox events `ready/ack/progress/done/error/question`; sentinel
`END_OF_INSTRUCTION`; `inbox.md` format; state filenames `state.txt` / `halt.flag` / `scoreboard.md` /
`results.tsv` / `session-summary.md` / `handoff-data.kv` / `consensus.md`; `winner_*`/`runner_up_*`/`mode=`
handoff keys (only `winner_cmdr`→`winner_instrument` rebrands); `contracts.yaml` keys; `CLAUDE_CODE_SESSION_ID`.

## Conventions every verb task MUST follow (from the shipped verbs)

- `export async function <verb>With(args, deps: <Verb>Deps): Promise<number>` + a module-level
  `const live<Verb>Deps: <Verb>Deps = {...}` immediately after, + a `case "<verb>": return <verb>With(rest, live<Verb>Deps);`
  arm in `run()` before `default:`. Wrap `rest` in `applyArgsFile(rest)` ONLY for verbs with free-text/spaced
  positionals (`refine`, `abort`).
- `opts?: PathOpts` lives **inside** the Deps interface (follow `init`/`experiment-send`/`score`, NOT `spawn-all`'s
  third-param outlier). `now(): string` (live = `() => isoUtc()`). `stdout?` injected; top-of-verb idiom
  `const out = deps.stdout ?? ((l) => process.stdout.write(l + "\n"));`. Errors → `log.error`/`log.warn` (stderr),
  never `out()`, never the outbox.
- rc convention: `2` = bad args/validation/usage; `1` = missing required state/dir/null-model; `0` = ok.
- Atomic writes via `atomicWrite` (tmp-same-dir+rename) for all state files. Validate ids with `EXP_ID_RE` /
  `INSTRUMENT_RE` (exported from `core/rehearsalExperiment.js`).
- Per-task: typecheck 0, lint clean, full `npm run test` green, `tests/stale-tokens.test.ts` green. Commit each
  task. Do NOT rebuild `dist/` mid-phase — D12 rebuilds it once.
- Verb tests set a fresh `CONSORT_HOME` per test (`tests/helpers/tmpHome.ts`) and scaffold a temp `_rehearsal` tree;
  NEVER spawn real panes (inject fakes). Pure-module tests are plain unit tests.

---

## Task D1: `core/archive.ts` — widen suite union + return archived dest

**Files:**
- Modify: `src/core/archive.ts:56-67` (`archiveTopic`)
- Test: `tests/archive.test.ts` (existing) or `tests/rehearsal-archive.test.ts` (new)

- [ ] **Step 1: Failing test** — add to the archive tests:

```ts
import { archiveTopic } from "../src/core/archive.js";
import { withTmpHome } from "./helpers/tmpHome.js"; // adjust to the existing helper API
// ... scaffold <CONSORT_HOME>/state/<repoHash>/<topic>/_rehearsal/x.txt
it("archiveTopic('rehearsal') moves _rehearsal and returns the archived dest", () => {
  // arrange a topic dir with a _rehearsal subdir containing a file
  const dest = archiveTopic(topic, "rehearsal");
  expect(dest).toMatch(/\/archive\/.+\/_rehearsal-\d{8}T\d{6}Z$/);
  expect(existsSync(join(dest!, "x.txt"))).toBe(true);
});
```

- [ ] **Step 2: Run → FAIL** (`"rehearsal"` not assignable to `suite`; `archiveTopic` returns `void`).

- [ ] **Step 3: Implement** — two edits:

```ts
// signature: add "rehearsal" to the union; change return type to string | null
export function archiveTopic(
  topic: string,
  suite: "consult" | "deploy" | "meditate" | "score" | "perform" | "rehearsal",
  opts?: { now?: Date },
): string | null {
  const td = topicDir(topic);
  finalizeArchived(td, opts);
  const art = join(td, `_${suite}`);
  let dest: string | null = null;
  if (existsSync(art)) {
    const base = join(globalRoot(), "archive", repoHash(), topic, `_${suite}-${archiveTs(opts?.now)}`);
    dest = uniqueDest(base);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(art, dest);
  }
  try { rmSync(td, { recursive: false, force: false }); } catch { /* rmdir-if-empty; tolerate non-empty */ }
  return dest;
}
```

  Faithfulness: `score`/`perform`'s `archiveRun` call `archiveTopic(topic, "score"/"perform")` and ignore the
  return — the new `string | null` return is backward-compatible. Do NOT change the archive path layout.

- [ ] **Step 4: Run → PASS.** Confirm existing archive + score/perform tests still pass.
- [ ] **Step 5: Commit** `feat(rehearsal): archiveTopic accepts 'rehearsal' suite and returns archived dest`.

---

## Task D2: `core/rehearsalHandoff.ts` (pure) — scoreboard parse + handoff-data.kv builder

**Files:**
- Create: `src/core/rehearsalHandoff.ts`
- Test: `tests/rehearsal-handoff.test.ts`

Behavioral source: `bin/deep-research-handoff-extract.sh` + `cw_deep_research_extract_handoff_data` in
`lib/deep-research.sh`. Winner data source = **scoreboard.md** (NOT results.tsv): first `status==ok` row is the
winner, the next ≤3 ok rows are runner-ups. The scoreboard row format is FROZEN (Task A `buildScoreboard`):
`| <rank|~rank> | <expId> | <instrument> | <metricFmt> | <status> | <runtimeFmt> | <approach> | <metricName> |`.

- [ ] **Step 1: Failing tests** (`tests/rehearsal-handoff.test.ts`):

```ts
import { parseScoreboard, buildHandoffKv } from "../src/core/rehearsalHandoff.js";

const SB = [
  "<!-- scoreboard schema_version=2 -->", "# Scoreboard", "",
  "| Rank | Experiment | Instrument | Metric | Status | Runtime | Approach | metric_name |",
  "|---|---|---|---|---|---|---|---|",
  "| 1 | exp-003 | violin | 0.9950 | ok | 40.00s | augment-a2 | accuracy |",
  "| 2 | exp-002 | viola | 0.9100 | ok | 41.00s | augment-b | accuracy |",
  "| ~3 | exp-001 | cello | n/a | partial | 5.00s | baseline | accuracy |",
].join("\n") + "\n";

it("parseScoreboard picks first-ok winner + next-ok runner-ups (skips partial)", () => {
  const r = parseScoreboard(SB);
  expect(r.winner).toMatchObject({ expId: "exp-003", instrument: "violin", metric: "0.9950", status: "ok" });
  expect(r.runnerUps.map((x) => x.instrument)).toEqual(["viola"]); // cello is partial → excluded
});

it("parseScoreboard winner null when no ok row", () => {
  const md = SB.replace(/ ok /g, " partial ");
  expect(parseScoreboard(md).winner).toBeNull();
});

it("buildHandoffKv winner branch — exact key order + winner_code_dir always emitted", () => {
  const kv = buildHandoffKv({
    topic: "rehearsal-x", landscapeDoc: "rehearsal-2026-05-30-x.md", hasMetricMd: true,
    generatedTs: "2026-05-30T11:00:00Z",
    winner: { instrument: "violin", exp: "exp-003", approach: "augment-a2", metric: "0.9950",
              checkpoint: "parts/violin/experiments/exp-003/model.pt", notes: "best run", codeDir: "parts/violin/experiments/exp-003/code/" },
    runnerUps: [{ instrument: "viola", exp: "exp-002", metric: "0.9100", approach: "augment-b" }],
  });
  expect(kv.split("\n").filter(Boolean)).toEqual([
    "mode=rehearsal", "topic=rehearsal-x", "landscape_doc=rehearsal-2026-05-30-x.md",
    "winner_instrument=violin", "winner_exp=exp-003", "winner_approach=augment-a2", "winner_metric=0.9950",
    "winner_checkpoint=parts/violin/experiments/exp-003/model.pt", "winner_notes=best run",
    "winner_code_dir=parts/violin/experiments/exp-003/code/",
    "runner_up_1=viola/exp-002:0.9100:augment-b",
    "mandates_block_path=metric.md", "session_path=.", "topic_txt_path=topic.txt", "generated_ts=2026-05-30T11:00:00Z",
  ]);
});

it("buildHandoffKv no-winner branch", () => {
  const kv = buildHandoffKv({ topic: "rehearsal-x", hasMetricMd: false, generatedTs: "2026-05-30T11:00:00Z",
    winner: null, runnerUps: [] });
  expect(kv.split("\n").filter(Boolean)).toEqual([
    "mode=rehearsal-no-winner", "topic=rehearsal-x", "session_path=.", "topic_txt_path=topic.txt",
    "generated_ts=2026-05-30T11:00:00Z",
  ]);
});
```

- [ ] **Step 2: Run → FAIL** (module missing).

- [ ] **Step 3: Implement** `src/core/rehearsalHandoff.ts`:

```ts
// Pure handoff logic for /consort:rehearsal. Faithful to deep-research-handoff-extract.sh
// + cw_deep_research_extract_handoff_data. Winner source = scoreboard.md first-ok row.

export interface ScoreboardRow { rank: string; expId: string; instrument: string; metric: string; status: string; }

/** Parse scoreboard.md data rows; winner = first status==ok; runnerUps = next ok rows (max 3). */
export function parseScoreboard(md: string): { rows: ScoreboardRow[]; winner: ScoreboardRow | null; runnerUps: ScoreboardRow[] } {
  const rows: ScoreboardRow[] = [];
  for (const line of md.split("\n")) {
    // data row: starts "| <~?int> | exp-<int> |" (the ~ prefix marks partial/fail rows)
    if (!/^\|\s*~?\d+\s*\|\s*exp-\d+\s*\|/.test(line)) continue;
    const c = line.split("|").map((s) => s.trim());
    // c[0]="" c[1]=rank c[2]=exp c[3]=instrument c[4]=metric c[5]=status ...
    rows.push({ rank: c[1], expId: c[2], instrument: c[3], metric: c[4], status: c[5] });
  }
  const ok = rows.filter((r) => r.status === "ok");
  const winner = ok[0] ?? null;
  const runnerUps = ok.slice(1, 4);
  return { rows, winner, runnerUps };
}

export interface HandoffInput {
  topic: string;
  landscapeDoc?: string;          // basename only, omitted if absent
  hasMetricMd: boolean;           // emits mandates_block_path=metric.md when true
  generatedTs: string;
  winner: null | {
    instrument: string; exp: string; approach: string; metric: string;
    checkpoint?: string;          // omitted when empty; passthrough (may be absolute)
    notes?: string;               // omitted when empty; newlines already collapsed by caller
    codeDir: string;              // ALWAYS emitted (hardcoded parts/<i>/experiments/<e>/code/)
  };
  runnerUps: { instrument: string; exp: string; metric: string; approach: string }[]; // approach default "unknown"
}

/** Build handoff-data.kv body. Key ORDER is load-bearing (byte-identical fixtures). */
export function buildHandoffKv(i: HandoffInput): string {
  const L: string[] = [];
  if (!i.winner) {
    L.push("mode=rehearsal-no-winner", `topic=${i.topic}`);
    if (i.landscapeDoc) L.push(`landscape_doc=${i.landscapeDoc}`);
    if (i.hasMetricMd) L.push("mandates_block_path=metric.md");
    L.push("session_path=.", "topic_txt_path=topic.txt", `generated_ts=${i.generatedTs}`);
    return L.join("\n") + "\n";
  }
  const w = i.winner;
  L.push("mode=rehearsal", `topic=${i.topic}`);
  if (i.landscapeDoc) L.push(`landscape_doc=${i.landscapeDoc}`);
  L.push(`winner_instrument=${w.instrument}`, `winner_exp=${w.exp}`, `winner_approach=${w.approach || "unknown"}`,
    `winner_metric=${w.metric}`);
  if (w.checkpoint) L.push(`winner_checkpoint=${w.checkpoint}`);
  if (w.notes) L.push(`winner_notes=${w.notes}`);
  L.push(`winner_code_dir=${w.codeDir}`);
  i.runnerUps.forEach((r, n) => L.push(`runner_up_${n + 1}=${r.instrument}/${r.exp}:${r.metric}:${r.approach || "unknown"}`));
  if (i.hasMetricMd) L.push("mandates_block_path=metric.md");
  L.push("session_path=.", "topic_txt_path=topic.txt", `generated_ts=${i.generatedTs}`);
  return L.join("\n") + "\n";
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(rehearsal): rehearsalHandoff pure scoreboard-parse + handoff-data.kv builder`.

---

## Task D3: `core/rehearsalSummary.ts` (pure) — render_summary port

**Files:**
- Create: `src/core/rehearsalSummary.ts`
- Test: `tests/rehearsal-summary.test.ts`

Behavioral source: `cw_deep_research_render_summary` (`lib/deep-research.sh` ~L718-877). The verb (Task D4)
gathers the data from disk; this module renders it. Reproduce EXACTLY: title `# Research session — <topic>`,
`Updated:`/`Started:`/`Time budget:` header, then sections **`## Status`** (`| Part | Phase | Current | Last
event |`), **`## Scoreboard top 5`** (echo consort scoreboard.md header + first 5 data rows, else `_(scoreboard
empty)_`), **`## Completion check`** (Floor/Target/K/Plateau/Hard-cap bullets, else `_(missing scoreboard or
metric)_`), **`## Recent events`** (`- <ts> <part>/<event>`, else `_(no events yet)_`), optional **`## Warnings`**
(only when warnings present), optional **`## Halt`** (only when halt.flag present).

REBRAND: `| Trooper |`→`| Part |`. The Status table cell is `<lastTs> <lastEvent>` (space-joined, faithful).
`## Halt` rendering: structured → fenced halt.flag body **minus the `format=` line** + `Finalized: <iso>`;
prose → `- Reason: <reason>` / `- Finalized: <iso>`; missing → omit the section entirely.

- [ ] **Step 1: Failing tests** — cover: full render with all sections; empty scoreboard placeholder; missing
  completion placeholder; no events placeholder; structured Halt (fence, no `format=` line); prose Halt; missing
  Halt omitted; `| Part |` header (no `Trooper`). Example for the Halt sub-render:

```ts
import { renderHaltSection, renderSessionSummary } from "../src/core/rehearsalSummary.js";
import type { HaltFlag } from "../src/core/rehearsalState.js";

it("renderHaltSection structured strips format= and fences the body", () => {
  const halt: HaltFlag = { format: "structured",
    fields: { halted_by: "maestro", halted_at: "t", reason: "converged", format: "structured" } };
  const out = renderHaltSection(halt, "2026-05-30T12:00:00Z", "maestro");
  expect(out).toBe("\n## Halt\n\n```\nhalted_by=maestro\nhalted_at=t\nreason=converged\n```\nFinalized: 2026-05-30T12:00:00Z\n");
});
it("renderHaltSection missing → empty", () => {
  expect(renderHaltSection({ format: "missing" }, "t", "maestro")).toBe("");
});
```

  NOTE: `renderHaltSection` must re-emit the structured fields in their ORIGINAL order. Since `readHaltFlag`
  returns a `fields` object, the verb (D4) should pass the **raw halt.flag body** (minus `format=` is computed
  here) — so give `renderHaltSection` the raw body for the structured branch, or have D4 pass an ordered
  `string[]` of `key=value` lines. **Plan choice:** `renderHaltSection(halt, finalizedIso)` where, for
  `structured`, it iterates `Object.entries(halt.fields)` skipping `format`. (`readHaltFlag` preserves insertion
  order from the file; the verb reads the file in order, so entries are ordered.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `src/core/rehearsalSummary.ts`:

```ts
import type { CompletionSignals } from "./rehearsalComplete.js"; // {floorMet,targetMet,kSoFar,kRequired,plateau}
import type { HaltFlag } from "./rehearsalState.js";

export interface StatusRow { instrument: string; phase: string; current: string; lastTs: string; lastEvent: string; }
export interface EventRow { ts: string; instrument: string; event: string; }
export interface SummaryInput {
  topic: string; updatedIso: string; startedIso: string; budget: string;
  statusRows: StatusRow[];
  scoreboardMd: string | null;           // raw scoreboard.md (for the top-5 echo)
  completion: CompletionSignals | null;  // null → "_(missing scoreboard or metric)_"
  hardCap: boolean | null;               // null → omit the Hard cap bullet (no time-budget files)
  recentEvents: EventRow[];              // already merged + sorted desc + capped at 10 by the verb
  warnings: string[];                    // rendered bullet lines (verb formats size_warn/audit_warn → bullets)
  halt: HaltFlag;
  finalizedIso: string;
}

/** ## Halt block ("" when missing). Structured = fenced body minus format= line; prose = Reason/Finalized. */
export function renderHaltSection(halt: HaltFlag, finalizedIso: string): string {
  if (halt.format === "structured" && halt.fields) {
    const body = Object.entries(halt.fields).filter(([k]) => k !== "format").map(([k, v]) => `${k}=${v}`).join("\n");
    return `\n## Halt\n\n\`\`\`\n${body}\n\`\`\`\nFinalized: ${finalizedIso}\n`;
  }
  if (halt.format === "prose") {
    return `\n## Halt\n\n- Reason: ${halt.reason ?? ""}\n- Finalized: ${finalizedIso}\n`;
  }
  return "";
}

const SB_DATA_RE = /^\|\s*~?\d+\s*\|\s*exp-/;

export function renderSessionSummary(s: SummaryInput): string {
  const out: string[] = [];
  out.push(`# Research session — ${s.topic}`);
  out.push(`Updated: ${s.updatedIso}`);
  out.push(`Started: ${s.startedIso}`);
  out.push(`Time budget: ${s.budget}`, "");

  out.push("## Status", "");
  out.push("| Part | Phase | Current | Last event |");
  out.push("|---|---|---|---|");
  for (const r of s.statusRows) {
    out.push(`| ${r.instrument} | ${r.phase} | ${r.current || "—"} | ${r.lastTs} ${r.lastEvent} |`);
  }
  out.push("");

  out.push("## Scoreboard top 5", "");
  if (s.scoreboardMd) {
    out.push("| Rank | Experiment | Instrument | Metric | Status | Runtime | Approach | metric_name |");
    out.push("|---|---|---|---|---|---|---|---|");
    const data = s.scoreboardMd.split("\n").filter((l) => SB_DATA_RE.test(l)).slice(0, 5);
    for (const l of data) out.push(l);
  } else {
    out.push("_(scoreboard empty)_");
  }
  out.push("");

  out.push("## Completion check", "");
  if (s.completion) {
    out.push(`- Floor: ${s.completion.floorMet ? "MET" : "not met"}`);
    out.push(`- Target: ${s.completion.targetMet ? "MET" : "not met"}`);
    out.push(`- K corroboration: ${s.completion.kSoFar}/${s.completion.kRequired}`);
    out.push(`- Plateau: ${s.completion.plateau ? "YES" : "no"}`);
    if (s.hardCap !== null) out.push(`- Hard cap: ${s.hardCap ? "YES" : "NO"}`);
  } else {
    out.push("_(missing scoreboard or metric)_");
  }
  out.push("");

  out.push("## Recent events", "");
  if (s.recentEvents.length > 0) {
    for (const e of s.recentEvents) out.push(`- ${e.ts} ${e.instrument}/${e.event}`);
  } else {
    out.push("_(no events yet)_");
  }

  if (s.warnings.length > 0) {
    out.push("", "## Warnings", "");
    for (const w of s.warnings) out.push(w);
  }

  return out.join("\n") + "\n" + renderHaltSection(s.halt, s.finalizedIso);
}
```

  Verify the exact `CompletionSignals` field names against `src/core/rehearsalComplete.ts` before finalizing
  (`floorMet`/`targetMet`/`kSoFar`/`kRequired`/`plateau`). The Hard-cap bullet uses `checkTimeBudget` (gathered by
  the verb); `null` omits it (faithful — bash only prints it when both time-budget files exist).

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(rehearsal): rehearsalSummary pure render_summary port`.

---

## Task D4: `finalize` verb (+ `core/rehearsalFinalize.ts` pure helpers)

**Files:**
- Create: `src/core/rehearsalFinalize.ts` (pure: `finalizePhase`, `parseHardConstraints`)
- Modify: `src/commands/rehearsal.ts` (add `finalizeWith` + `liveFinalizeDeps` + `case "finalize"`)
- Test: `tests/rehearsal-finalize.test.ts`

Behavioral source: `bin/deep-research-finalize.sh` (orchestration) + `cw_deep_research_*` helpers
(`normalize_result` L1416, `prune_intermediate_checkpoints` L1275, `link_pane_artifacts` L1338,
`compute_size_warnings` L1375, `audit_diff` L1502). The implementer MUST read these for byte-exact FS details.

**Orchestration (faithful order):** `finalize [--keep-intermediate] <topic>` →
1. art = `rehearsalArtDir(topic, opts)`; if not a dir → `log.error("finalize: art-dir missing: <art>"); return 1`.
2. **Per-part phase normalization.** For each instrument in `parts.txt` (skip blank): if `state.txt` missing skip;
   (a) **reconcile** from outbox tail (see below) then (b) read `phase`; case-map via `finalizePhase`.
3. **(OMIT clone-wars step 4 active-marker removal — consort has no marker lifecycle; see Decision 3.)**
4. **normalize_result:** glob `parts/*/experiments/exp-*/result.json`; for each, `JSON.parse` → if invalid skip;
   apply `normalizeResult`; if the normalized status/metric differ, `atomicWrite` the FROZEN 12-key JSON back.
5. **prune intermediate checkpoints** (skip when `--keep-intermediate`/`CONSORT_REHEARSAL_KEEP_INTERMEDIATE`): per
   exp dir with a `result.json`, keep `checkpoint_path` (path-escape-guarded; resolve relative to the exp dir),
   delete every OTHER `*.pt` in that dir. Best-effort.
6. **link pane artifacts:** for each part, `resolveModel(instrument, topic)` → pane dir
   `<topicDir>/<instrument>-<model>/`; relative-`symlinkSync` its `outbox.jsonl`/`inbox.md` into
   `parts/<instrument>/` (best-effort; `log.warn` on a missing pane file).
7. **compute size warnings:** TRUNCATE `warnings.txt`, then append `size_warn\t<part>/<exp>\t<gb1dec>\t<fileCount>`
   for each exp dir whose recursive byte size ≥ threshold (`CONSORT_REHEARSAL_SIZE_WARN_GB`, default 2; GiB,
   1-decimal).
8. **audit diff:** for each exp dir with BOTH `prompt.md` + `audit.json`, parse the `**Hard constraints:**` block
   (`parseHardConstraints`), compare to `audit.json`, APPEND `audit_warn\t<part>/<exp>\t<key>\tprompt=<v>  actual=<v>`
   (TWO spaces) to `warnings.txt`. (size BEFORE audit — size truncates, audit appends.)
9. **render session-summary.md:** gather Status rows (parts.txt + state.txt), scoreboard.md, `checkCompletion`
   (scoreboard.md + metric.md, else null), `checkTimeBudget` (time-budget.txt + session-start.txt, else null),
   Recent events (tail-10 of each part's pane `outbox.jsonl`, merge, sort desc by ts, cap 10), warnings.txt →
   bullets, `readHaltFlag(halt.flag)`; call `renderSessionSummary(...)`; `atomicWrite` to `session-summary.md`.
10. `log.ok("finalize: cleanup complete")`; return 0.

**reconcile (per part):** read `liveness-cursor.txt` (int byte offset, else 0); read the part's pane
`outbox.jsonl` from that byte offset to EOF (`buf.subarray(offset).toString()`); `reconcileFromOutbox(tail,
doneResultExists)` where `doneResultExists` = `result.json` exists for the part's `current_exp_id`. If it returns
`"failed"`/`"idle"`, `atomicWrite(stateTxt, mergeState(stateTxt, { phase: <res> }))`. (Error wins over done is
inside `reconcileFromOutbox`.)

- [ ] **Step 1: Failing tests** — `tests/rehearsal-finalize.test.ts`. Pure first:

```ts
import { finalizePhase, parseHardConstraints } from "../src/core/rehearsalFinalize.js";
it("finalizePhase case-map", () => {
  for (const p of ["working", "stale", "stuck", "blocked"]) expect(finalizePhase(p)).toBe("incomplete");
  for (const p of ["idle", "complete"]) expect(finalizePhase(p)).toBe("complete");
  expect(finalizePhase("failed")).toBeNull();
  expect(finalizePhase("abandoned")).toBeNull(); // unknown → no write
});
it("parseHardConstraints reads only the **Hard constraints:** block, numeric k=v lines", () => {
  const md = "intro\n\n**Hard constraints:**\nmax_params = 100000\nlr=0.1 something\n\nnext para\nx=5\n";
  expect(parseHardConstraints(md)).toEqual([{ key: "max_params", value: "100000" }, { key: "lr", value: "0.1" }]);
});
```

  Then the **verb** integration test (temp `CONSORT_HOME`): scaffold a `_rehearsal` with `parts.txt` (two
  parts), `state.txt` (one `phase=working` with a `done` in its pane outbox + matching `result.json`, one
  `phase=idle`), a `halt.flag` (structured `halted_by=maestro\nhalted_at=...\nreason=converged`), `scoreboard.md`,
  `metric.md`. Assert after `finalizeWith(["<topic>"], deps)`: rc 0; the working part reconciled to `idle` then
  case-mapped to `complete`; the idle part → `complete`; `session-summary.md` exists and contains `## Halt`,
  `reason=converged` (no `format=` line), `## Status`, `| Part |`; an `ok+null` result.json was normalized to
  `partial`. (Inject `now: () => "2026-05-30T12:00:00Z"`.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** the pure helpers:

```ts
// src/core/rehearsalFinalize.ts — pure finalize helpers. Faithful to deep-research-finalize.sh.
const HC_RE = /^\s*([a-z_]+)\s*=\s*([0-9]+(?:\.[0-9]+)?)\b/;

/** Phase case-map: working/stale/stuck/blocked→incomplete; idle/complete→complete; else null (no write). */
export function finalizePhase(cur: string): "incomplete" | "complete" | null {
  if (cur === "working" || cur === "stale" || cur === "stuck" || cur === "blocked") return "incomplete";
  if (cur === "idle" || cur === "complete") return "complete";
  return null;
}

/** Extract numeric key=value mandates from the **Hard constraints:** block (until the next blank line). */
export function parseHardConstraints(promptMd: string): { key: string; value: string }[] {
  const lines = promptMd.split("\n");
  const start = lines.findIndex((l) => l.trim() === "**Hard constraints:**");
  if (start < 0) return [];
  const out: { key: string; value: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") break;
    const m = HC_RE.exec(lines[i]);
    if (m) out.push({ key: m[1], value: m[2] });
  }
  return out;
}
```

  Then `finalizeWith` in `rehearsal.ts`. Inject the impure seams; use node fs inline (monitor precedent). The
  implementer reads the cited bash helpers for the exact glob/du/symlink/audit semantics. `RehearsalFinalizeDeps {
  now(): string; keepIntermediate?: boolean; sizeWarnGb?: number; stdout?; opts?: PathOpts }`. `liveFinalizeDeps =
  { now: () => isoUtc(), keepIntermediate: process.env.CONSORT_REHEARSAL_KEEP_INTERMEDIATE ? true : undefined,
  sizeWarnGb: Number(process.env.CONSORT_REHEARSAL_SIZE_WARN_GB) || 2 }`. Parse `--keep-intermediate` off the
  front of `args` (OR with `deps.keepIntermediate`). Use `resolveModel`/`outboxPath`/`inboxPath` for pane paths,
  `experimentDir`/`partStateDir`/`experimentsDir`/`partsDir` for the state tree, `reconcileFromOutbox`/`mergeState`/
  `parseState`, `normalizeResult`, `checkCompletion`/`checkTimeBudget`, `readHaltFlag`, `renderSessionSummary`,
  `atomicWrite`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(rehearsal): finalize verb — reconcile/normalize/prune/link/warnings/session-summary`.

---

## Task D5: `refine` verb

**Files:**
- Modify: `src/commands/rehearsal.ts` (`refineWith` + `liveRefineDeps` + `case "refine": return refineWith(applyArgsFile(rest), liveRefineDeps);`)
- Test: `tests/rehearsal-tail-cmd.test.ts` (new; shared by D5/D6/D7/D8/D9 verb tests)

Behavioral source: `bin/deep-research-refine.sh`. **Stateless** mid-experiment scope-narrowing: write a numbered
`refine-N.md` into the live branch dir + nudge the pane. NO state mutation.

`refine <topic> <instrument> <exp-id> <refinement-text>` (EXACTLY 4 positionals):
1. validate `INSTRUMENT_RE` (rc 2), `EXP_ID_RE` (rc 2).
2. `branchDir = experimentDir(art, instrument, expId)`; if not a dir → `log.error("branch dir missing: <branchDir>"); return 1`.
3. find first free `refine-N.md` (N=1,2,3… first non-existing; do NOT max+1); `atomicWrite(refinePath, text + "\n")`.
4. `log.info("[refine] wrote <refinePath>")`.
5. nudge unless dry-run: if `!deps.dryRun`, `await deps.send([instrument, topic, "REFINE: read <refinePath>
   before continuing your current experiment (<expId>)."])` (or `--from maestro`); on non-zero/throw →
   `log.warn("[refine] send nudge failed; part may not have noticed refine-<N>.md")` (NON-fatal).
6. `log.ok("[refine] <instrument>/<expId> refine-<N>.md sent")`; return 0.

`RehearsalRefineDeps { send(args: string[]): Promise<number>; dryRun?: boolean; stdout?; opts?: PathOpts }`.
`liveRefineDeps = { send: (a) => sendRun(a), dryRun: process.env.CONSORT_DRY_RUN === "1" }` (import
`run as sendRun` from `./send.js`). Confirm the consort `send` signature/flag (`--from maestro`) against
`src/commands/send.ts` before wiring.

- [ ] **Step 1: Failing tests** — rc 2 on bad instrument/exp-id; rc 1 on missing branch dir; writes `refine-1.md`
  then `refine-2.md` (first-free-slot: with `refine-1.md`+`refine-3.md` present, next write fills `refine-2.md`);
  body = text + trailing `\n`; dry-run (`dryRun:true`) skips `send` (fake `send` throws if called); nudge failure
  is non-fatal (rc still 0). NO state.txt mutation (assert state unchanged).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** per the spec above (`parseRefineArgs` helper; first-free-slot loop).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(rehearsal): refine verb — stateless refine-N.md + best-effort nudge`.

---

## Task D6: `handoff-extract` + `forensics` verbs

**Files:**
- Modify: `src/commands/rehearsal.ts` (`handoffExtractWith` + `liveHandoffDeps`; `forensicsRun`; two dispatch arms)
- Test: `tests/rehearsal-tail-cmd.test.ts`

**`handoff-extract <art-dir>`** — note: the bin takes the **art-dir** (the archived `_rehearsal` path), not a
topic (the directive calls it post-archive with the rebound `$ART`). Faithful to
`cw_deep_research_extract_handoff_data`:
1. `art = args[0]`; if empty or not a dir → `log.error("rehearsal handoff-extract: art-dir required"); return 2`.
2. require `topic.txt` under art → else `return 2`. `topic = read(topic.txt)` newlines→spaces, trim-right.
3. `parseScoreboard(read(scoreboard.md) ?? "")` (missing scoreboard → no-winner). landscape = basename of first
   `rehearsal-*.md` glob (if any). `hasMetricMd = exists(metric.md)`.
4. winner branch: read `result.json` of `parts/<winner.instrument>/experiments/<winner.exp>/` →
   `approach_label`/`notes`(newlines→spaces)/`checkpoint_path` (absolute passthrough else prefix
   `parts/<i>/experiments/<e>/`); `codeDir = "parts/<i>/experiments/<e>/code/"` (always). runner-ups: read each
   `approach_label` (default `"unknown"`). `metric` = scoreboard cell.
5. `buildHandoffKv(...)` → `atomicWrite(join(art, "handoff-data.kv"), body)`; `log.ok("handoff-data.kv written:
   <art>/handoff-data.kv")`; return 0.

`RehearsalHandoffDeps { now(): string; stdout?; opts?: PathOpts }`, `liveHandoffDeps = { now: () => isoUtc() }`.
Use node fs inline + `parseScoreboard`/`buildHandoffKv`. Read `result.json` fields by their FROZEN names.

**`forensics <topic>`** — thin, mirror `score.ts::forensicsRun`/`perform.ts`:
```ts
export async function forensicsRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("rehearsal forensics: topic required"); return 2; }
  const path = captureArtDir({ artDir: rehearsalArtDir(topic), command: "rehearsal" });
  if (path) { log.ok(`forensics captured: ${path}`); process.stdout.write(path + "\n"); }
  else log.info("rehearsal forensics: no mechanical findings");
  return 0;
}
```
Add `import { captureArtDir } from "../core/forensics.js";`. `captureArtDir` REQUIRES the nested
`<topic>/_rehearsal` art dir (its topicSlug = `basename(dirname(artDir))`); `rehearsalArtDir(topic)` is exactly
that. Best-effort → always rc 0.

- [ ] **Step 1: Failing tests** — handoff-extract winner branch writes `handoff-data.kv` with
  `winner_instrument=violin`, `winner_metric=<scoreboard cell>`, `winner_code_dir=...code/`, runner-up line;
  no-winner branch (`mode=rehearsal-no-winner`) when scoreboard has no ok row; rc 2 on missing art-dir / missing
  topic.txt. forensics: rc 0 with no findings (empty art) → `log.info`; rc 0 + path when findings exist; rc 2 no
  topic.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both verbs + dispatch arms.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(rehearsal): handoff-extract (handoff-data.kv) + forensics verbs`.

---

## Task D7: `teardown` verb

**Files:**
- Modify: `src/commands/rehearsal.ts` (`teardownWith` + `liveTeardownDeps` + `case "teardown"`)
- Test: `tests/rehearsal-tail-cmd.test.ts`

Behavioral source: `bin/deep-research-teardown.sh` (winner symlink + status stamp + archive). consort-idiomatic
(Decision 4): pre-steps + `archiveTopic`. `teardown <topic>`:
1. `art = rehearsalArtDir(topic, opts)`; if not a dir → `log.error("<art> not found"); return 1`. (rc 2 no topic.)
2. **preflight orphan kill** (best-effort): if `art/preflight-panes.txt` exists, for each non-blank pane line
   `await deps.killPane(pane)` swallowing errors. (Panes are normally already gone via `coda --pairs`; no-op in
   the dogfood.)
3. **shared sweep** (best-effort): if `art/shared` is a dir, delete files matching `*.tmp`/`*.lock` at depth ≤2.
4. **winner symlink:** `parseScoreboard(read(art/scoreboard.md) ?? "")`; if `winner` and
   `parts/<winner.instrument>/experiments/<winner.exp>/code` exists → `symlinkSync("parts/<i>/experiments/<e>/code",
   join(art, "winner"))` (RELATIVE target; `rmSync(force)` any existing `winner` first); `log.ok("[teardown]
   winner symlink -> <rel> (<i>/<e>)")`. Else `log.info`/`log.warn` per the cases (no scoreboard → silent; no ok
   row → info; missing code dir → warn). Best-effort.
5. `const dest = deps.archiveTopic(topic, "rehearsal");` → archives `_rehearsal` (winner symlink + state stamp
   ride along), rmdir-if-empty topic dir.
6. if `dest`: `process.stdout.write(dest + "\n")` (the directive captures it for the `$ART` rebind);
   `log.ok("[teardown] archived <topic> -> <dest>")`. return 0.

`RehearsalTeardownDeps { killPane(pane: string): Promise<void>; archiveTopic(topic, suite): string | null; now():
string; stdout?; opts?: PathOpts }`. `liveTeardownDeps = { killPane: (p) => killNow(p), archiveTopic, now: () =>
isoUtc() }` (import `killNow` from `../core/tmux.js`, `archiveTopic` from `../core/archive.js`).

- [ ] **Step 1: Failing tests** — rc 2 no topic; rc 1 missing art dir; with a scored `scoreboard.md` (winner
  violin/exp-003) + a real `parts/violin/experiments/exp-003/code/` dir, asserts: `winner` symlink created
  (relative, → the code dir) BEFORE archive, then `_rehearsal` moved under
  `<CONSORT_HOME>/archive/<repoHash>/<topic>/_rehearsal-<ts>` (topic dir gone), stdout printed the dest, rc 0;
  `killPane` fake NOT called when `preflight-panes.txt` absent. No ok row → no symlink, still archives.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Create the symlink with `symlinkSync(target, path)` where `target` is the RELATIVE
  string (so it survives the archive `mv`). Verify the symlink survives `archiveTopic` (it moves the parent dir).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(rehearsal): teardown verb — winner symlink + shared sweep + archive`.

---

## Task D8: `fresh-part` verb

**Files:**
- Modify: `src/commands/rehearsal.ts` (`freshPartWith` + `liveFreshPartDeps` + `case "fresh-part"`)
- Test: `tests/rehearsal-tail-cmd.test.ts`

Behavioral source: `bin/deep-research-fresh-trooper.sh`. `fresh-part <topic> <instrument>` (exactly 2):
1. validate `INSTRUMENT_RE` (rc 2). `art = rehearsalArtDir(topic, opts)`.
2. `stateTxt = parts/<instrument>/state.txt`; if missing → `log.error("part state.txt missing: <stateTxt>");
   return 1`.
3. `prev = parseState(read(stateTxt))`. **Refuse if `prev.phase === "working"`** → `log.error("part <instrument>
   is mid-experiment (phase=working); abort or wait for done before fresh-part."); return 1`.
4. `prevCounter = /^\d+$/.test(prev.exp_counter ?? "") ? prev.exp_counter : "0"`.
5. `log.info("[fresh-part] tearing down <instrument>'s pane on <topic> ...")`; `await deps.teardown(topic,
   instrument)` (best-effort — `coda --pairs <topic> <instrument>`; swallow errors).
6. `log.info("[fresh-part] respawning <instrument> ...")`; `const rc = await deps.spawn([instrument, "codex",
   topic]);` if `rc !== 0` → `log.error("spawn failed for <instrument> on <topic>"); return 1`.
7. **reset state** (PRESERVE exp_counter): `atomicWrite(stateTxt, mergeState(read(stateTxt), { last_event:
   "fresh-part-respawn", last_event_ts: deps.now(), phase: "idle", current_exp_id: "", exp_counter: prevCounter,
   probe_sent_ts: "" }))`. (current_exp_id + probe_sent_ts cleared to EMPTY; exp_counter re-written with its
   preserved value.)
8. `log.ok("[fresh-part] <instrument> respawned on <topic>; state preserved (exp_counter=<prevCounter>)")`;
   return 0.

`RehearsalFreshPartDeps { teardown(topic, instrument): Promise<void>; spawn(args: string[]): Promise<number>;
now(): string; stdout?; opts?: PathOpts }`. `liveFreshPartDeps = { teardown: (t, i) => codaRun(["--pairs", t,
i]).then(() => undefined).catch(() => undefined), spawn: (a) => spawnRun(a), now: () => isoUtc() }` (import
`run as codaRun` from `./coda.js`; `spawnRun` already imported).

- [ ] **Step 1: Failing tests** — rc 2 bad instrument; rc 1 missing state.txt; **rc 1 refusal when phase=working**
  (exact message); on success: `teardown` called, `spawn` called with `[instrument,"codex",topic]`, state reset to
  `phase=idle`/`current_exp_id=`(empty)/`probe_sent_ts=`(empty)/`exp_counter` PRESERVED/`last_event=fresh-part-respawn`;
  spawn-fail → rc 1 (inject `spawn` returning 1).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `set -uo pipefail` analog: teardown is best-effort (`.catch`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(rehearsal): fresh-part verb — refuse-if-working + respawn + state reset`.

---

## Task D9: `abort` + `consensus` verbs + register all dispatch arms

**Files:**
- Modify: `src/commands/rehearsal.ts` (`abortWith`+`liveAbortDeps`; `consensusWith`+`liveConsensusDeps`; the
  `run()` switch — confirm ALL Phase-D arms are present)
- Test: `tests/rehearsal-tail-cmd.test.ts`

**`abort <topic> [reason]`** (1 or 2 positionals) — `bin/deep-research-abort.sh`:
1. `art = rehearsalArtDir(topic, opts)`; if not a dir → `log.error("no active rehearsal session for topic:
   <topic> (art-dir <art> missing)"); return 1`. (rc 2 on 0 or >2 args.)
2. `reason = args[1] ?? "unspecified"`.
3. capture Monitor task ids BEFORE teardown: if `art/monitor-tasks.txt` exists, read non-blank lines.
4. write `halt.flag` — **plain overwrite** (NOT atomic; faithful), exactly three lines:
   `halted_by=user\nhalted_at=<deps.now()>\nreason=<reason>\n` via `writeFileSync`. `log.info("halt.flag written
   (<reason>)")`.
5. `if (await deps.finalize(topic) !== 0) { log.error("finalize failed"); return 1; }`.
6. `if (await deps.teardown(topic) !== 0) { log.error("teardown failed"); return 1; }`.
7. TaskStop hint (log only): if ids non-empty → `log.info("note: <N> Monitor task(s) still active; will TaskStop
   on next Maestro turn (halt.flag detected):")` then `log.info("  - <id>")` each; else `log.info("no Monitor
   tasks to stop")`.
8. `log.ok("rehearsal session <topic> aborted")`; return 0.

`RehearsalAbortDeps { finalize(topic): Promise<number>; teardown(topic): Promise<number>; now(): string; stdout?;
opts?: PathOpts }`. `liveAbortDeps = { finalize: (t) => finalizeWith([t], liveFinalizeDeps), teardown: (t) =>
teardownWith([t], liveTeardownDeps), now: () => isoUtc() }`. halt.flag is a PLAIN overwrite (the one state file
consort writes non-atomically — faithful to clone-wars + the loop's Step 4 directive already writes it plainly).

**`consensus [--epsilon=<f>] <topic>`** — `bin/deep-research-consensus.sh` (advisory, standalone):
1. parse `--epsilon` (default 0.01); `topic` positional (rc 2 missing). `art = rehearsalArtDir(topic, opts)`;
   require `parts/` dir → else `log.error(...); return 1`.
2. for each instrument under `parts/`, walk `experiments/exp-*/result.json` ascending; pick the **lexically
   greatest exp** whose `status==ok`; record that result's field object into `latestOk[instrument]`.
3. if `latestOk` is empty → `log.error("no ok result.json files found"); return 1`.
4. `const md = buildConsensus(latestOk, { topic, nowIso: deps.now(), epsilon });` →
   `atomicWrite(join(art, "consensus.md"), md)`; `log.ok("[consensus] wrote <art>/consensus.md (<N> parts)")`;
   return 0.

`RehearsalConsensusDeps { now(): string; stdout?; opts?: PathOpts }`, `liveConsensusDeps = { now: () => isoUtc()
}`. `buildConsensus` is the existing pure renderer; this verb only does the latest-ok disk-walk + atomic write.
Confirm `buildConsensus`'s `latestOk` shape (`Record<instrument, Record<field, unknown>>`) from
`src/core/rehearsalConsensus.ts` and pass each result.json parsed object (the 7 inspected fields are read inside
`buildConsensus`).

- [ ] **Step 1: Failing tests** — abort: rc 2 (0 args / 3 args); rc 1 missing art; writes 3-line `halt.flag`
  (`halted_by=user`, default `reason=unspecified`); calls `finalize` then `teardown` (fakes); finalize-fail → rc
  1 + "finalize failed"; TaskStop hint printed when `monitor-tasks.txt` present. consensus: rc 2 no topic; rc 1
  no `parts/`; rc 1 no ok results; with two parts each having a latest-ok result writes `consensus.md` containing
  `## Agreed`/`## Contested`/`## All-missing`. Then assert `run(["finalize"...])` … smoke-dispatch: assert `run`
  routes every new verb (`finalize`/`refine`/`handoff-extract`/`forensics`/`teardown`/`fresh-part`/`abort`/`consensus`)
  — unknown verb still rc 2.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both verbs; add `import { buildConsensus } from "../core/rehearsalConsensus.js";`. Add
  all remaining `case` arms in `run()` (before `default:`):
```ts
case "finalize": return finalizeWith(rest, liveFinalizeDeps);
case "refine": return refineWith(applyArgsFile(rest), liveRefineDeps);
case "handoff-extract": return handoffExtractWith(rest, liveHandoffDeps);
case "forensics": return forensicsRun(rest);
case "teardown": return teardownWith(rest, liveTeardownDeps);
case "fresh-part": return freshPartWith(rest, liveFreshPartDeps);
case "abort": return abortWith(applyArgsFile(rest), liveAbortDeps);
case "consensus": return consensusWith(rest, liveConsensusDeps);
```
- [ ] **Step 4: Run → PASS** (full suite + stale-tokens + typecheck + lint).
- [ ] **Step 5: Commit** `feat(rehearsal): abort + consensus verbs + register Phase-D dispatch`.

---

## Task D10: `commands/rehearsal.md` — Phases 5/6/6b/6c/7 + reconcile forward-refs

**Files:**
- Modify: `commands/rehearsal.md` (append Phases 5-7 at EOF; rewrite the Step 2.3 placeholder + the trailing
  blockquote + the header forward-ref)

Heading convention: `## Phase N — <title>` (two-hash em-dash, matching Phases 0-4). Use the literal `6b`/`6c`
suffixes. Reconcile the placeholders the C-phase left:
- **Step 2 (hard-cap), item 3** (currently "Synthesis … are Phase D — added next … EXIT THE LOOP"): replace with
  `1. $CS rehearsal finalize <TOPIC>` then keep `2. TaskStop every id in monitor-tasks.txt` then `3. Proceed to
  Phase 5 → 6 → 6b → 6c → 7 below. EXIT THE LOOP (a real stop).`
- **Trailing blockquote** (`> Phases 5-7 … added next.`): delete; the phases now follow.
- **Header forward-ref** (the "wind-down … Phase D, added next" line): change to present tense.

Append (rebranded; mirror `clone-wars/commands/deep-research.md` Phases 5-7 + `perform.md` Stage-4 teardown):

- **`## Phase 5 — Synthesis (landscape doc)`:** Maestro **Write**s `$ART/rehearsal-<date>-<slug>.md` (atomic
  single-shot) from `session-summary.md` + the final `scoreboard.md`. Required: H1 `# Rehearsal: <slug-titled>`;
  header lines `**Generated:**`/`**Topic:**` (verbatim from `topic.txt`)/`**Metric block:**` (verbatim
  `metric.md` body)/`**Roster:**` (comma-separated instruments)/`**Time budget:**`/`**Outcome:**` (`stopped-by-user
  | converged-by-judgment | time-budget-exhausted`); sections `## Experiment log` (table `| Exp | Instrument |
  Approach | Metric | Status | Runtime |`, chronological), `## Winner` (names `exp-NNN (instrument <i>)`,
  `Approach:`, Metric, Code path `parts/<i>/experiments/<exp>/code/`, Runtime, Notes verbatim from result.json),
  `## Why we stopped` (one paragraph citing exp-NNN), `## Branches preserved` (all dirs under
  `parts/<instrument>/experiments/` are kept in the archive), `## Suggested next` (Step 1 `/consort:score
  <abs-art-dir>/score-handoff.md`, Step 2 `/consort:perform <abs path to score's design-doc>`, + the
  skip-Step-1-only-if-trivial caveat).
- **`## Phase 6 — Teardown + archive`:** (1) **`TaskStop`** every id in `$ART/monitor-tasks.txt` (harness tool,
  one call per id, idempotent). (2) `$CS rehearsal forensics <TOPIC>` (best-effort); if it prints a path, **Edit**
  that file to APPEND a `## Maestro reflection` section (3-5 bullets interpreting the mechanical findings) BEFORE
  teardown. (3) `$CS coda --pairs <TOPIC> <instruments from parts.txt>` (the one 9s `FINE` banner; panes). (4)
  `$CS rehearsal teardown <TOPIC>` → capture stdout as `ARCHIVED_ART`; verify it exists; **rebind `$ART =
  ARCHIVED_ART`** for 6b/6c. (5) **Read** then **Edit** the landscape doc inside the archive to bake absolute
  paths under `## Suggested next`.
- **`## Phase 6b — Extract handoff data`:** `$CS rehearsal handoff-extract <$ART>` (the rebound archive art dir)
  → writes `$ART/handoff-data.kv`. Non-zero rc → `log.warn` and SKIP 6c.
- **`## Phase 6c — Compose score-handoff.md`:** Maestro **Write**s `$ART/score-handoff.md` from `handoff-data.kv`
  + the landscape doc. Six sections in order: `## Recommendation` (prose, no bullets, names the winner), `## Recipe`
  (prescriptive; cite code paths as `$ART/<winner_code_dir>`; OMIT entirely on no-winner), `## Constraints
  (carry-forward)` (inline `metric.md` Hard-constraints verbatim), `## Open questions` (CONDITIONAL — omit the
  WHOLE section, no `_(none)_` stub, when research closed everything), `## Evidence` (table `| Rank |
  Instrument/Exp | Metric | Approach | Status |` + a one-line `Winner emergence:`), `## Appendix: artifacts` (ALL
  ABSOLUTE paths — interpolate each KV value as `$ART/<value>`; emit a `/`-leading value verbatim). No-winner
  (`mode=rehearsal-no-winner`): fixed `## Recommendation` "No deployable winner…" prose, omit `## Recipe`.
- **`## Phase 7 — Present`:** show the archived landscape-doc path, the winner `code/` dir, the `## Suggested
  next` line VERBATIM, and a one-line outcome summary (outcome + best-metric + delta vs the FIRST experiment).

Banners/headings MUST be `FINE` / `## Maestro reflection` / `score-handoff.md` (stale-token gate).

- [ ] **Step 1: Reconcile** the Step 2.3 placeholder, the trailing blockquote, the header forward-ref.
- [ ] **Step 2: Append** Phases 5/6/6b/6c/7 per the spec above.
- [ ] **Step 3: Verify** every `$CS` invocation matches a real verb signature (`finalize`/`forensics`/`teardown`/
  `handoff-extract` + top-level `coda --pairs`); `TaskStop`/`Monitor`/Write/Edit are tool refs, not bash.
- [ ] **Step 4: Stale-token** check on the file (no `Yoda`/`MISSION ACCOMPLISHED`/`consult-handoff`/`commander`).
- [ ] **Step 5: Commit** `docs(rehearsal): rehearsal.md Phases 5/6/6b/6c/7 + reconcile Phase-D forward-refs`.

---

## Task D11: `scripts/dogfood-rehearsal-loop.sh` — Scenario D (wind-down)

**Files:**
- Modify: `scripts/dogfood-rehearsal-loop.sh` (append Scenario D BEFORE the Tally; REUSE Scenarios A/B/C +
  helpers; do NOT touch them)

Scenario D drives the wind-down CLI verbs against Scenario A's already-scored state (winner = `violin` exp-003 @
`0.9950`). The Maestro-authored docs (landscape, score-handoff.md) are NOT verb output, so the dogfood asserts the
**verb outputs** the Maestro would consume — exactly the `perform`-dogfood pattern. Add (extend the top comment to
note wind-down coverage):

```bash
############################################################################
# Scenario D — wind-down (finalize -> consensus -> handoff-extract -> teardown/forensics)
############################################################################
echo "===================================================================="
echo "Scenario D — wind-down on Scenario A's scored topic"
echo "===================================================================="

# D1 finalize: write a structured halt.flag, then finalize -> session-summary.md ## Halt.
printf 'halted_by=maestro\nhalted_at=2026-05-30T12:00:00Z\nreason=converged target+K\n' > "$ART/halt.flag"
fin_rc="$(rc_of $CS rehearsal finalize "$TOPIC")"
check "D1 finalize rc 0" "$fin_rc"
check "D2 session-summary.md has ## Halt + reason" \
  "$([ -f "$ART/session-summary.md" ] && grep -q '## Halt' "$ART/session-summary.md" && grep -q 'reason=converged' "$ART/session-summary.md" && echo 0 || echo 1)"

# D3 consensus: latest-ok per part -> consensus.md.
con_rc="$(rc_of $CS rehearsal consensus "$TOPIC")"
check "D3 consensus rc 0 + consensus.md with ## Agreed/## Contested" \
  "$([ "$con_rc" -eq 0 ] && [ -f "$ART/consensus.md" ] && grep -q '## Agreed' "$ART/consensus.md" && grep -q '## Contested' "$ART/consensus.md" && echo 0 || echo 1)"

# D4 handoff-extract: winner = violin/exp-003 @ 0.9950.
he_rc="$(rc_of $CS rehearsal handoff-extract "$ART")"
KV="$ART/handoff-data.kv"
check "D4 handoff-extract rc 0 + handoff-data.kv winner=violin metric=0.9950 + winner_code_dir" \
  "$([ "$he_rc" -eq 0 ] && grep -q '^winner_instrument=violin$' "$KV" && grep -q '^winner_metric=0.9950$' "$KV" && grep -q '^winner_code_dir=parts/violin/experiments/exp-003/code/$' "$KV" && grep -q '^mode=rehearsal$' "$KV" && echo 0 || echo 1)"

# D5 forensics: best-effort, rc 0.
fo_rc="$(rc_of $CS rehearsal forensics "$TOPIC")"
check "D5 forensics rc 0 (best-effort)" "$fo_rc"

# D6 teardown: winner symlink + archive (_rehearsal moved out of the topic dir).
# Make the winner code dir real so the symlink is created.
mkdir -p "$ART/parts/violin/experiments/exp-003/code"
TD_OUT="$($CS rehearsal teardown "$TOPIC" 2>/dev/null)"
td_rc=$?
ARCHIVE_ROOT="$CONSORT_HOME/archive"
check "D6 teardown rc 0 + printed archive dest under archive/" \
  "$([ "$td_rc" -eq 0 ] && printf '%s' "$TD_OUT" | grep -q '/archive/.*/_rehearsal-' && echo 0 || echo 1)"
check "D7 topic _rehearsal archived (live art dir gone; archive dir present)" \
  "$([ ! -d "$ART" ] && [ -d "$ARCHIVE_ROOT" ] && find "$ARCHIVE_ROOT" -name '_rehearsal-*' -type d | grep -q . && echo 0 || echo 1)"

# D8 no stale tokens in any wind-down artifact written under the archive.
check "D8 no master-yoda / MISSION ACCOMPLISHED / consult-handoff in archive" \
  "$(! grep -rIl -e 'master-yoda' -e 'MISSION ACCOMPLISHED' -e 'consult-handoff' "$ARCHIVE_ROOT" 2>/dev/null | grep -q . && echo 0 || echo 1)"
```

Faithfulness: capture `$?` on its OWN line right after the `teardown` command substitution (don't chain). The
Tally block (`PASS`/`FAIL`/`RESULT`) is unchanged — it already counts D1-D8.

- [ ] **Step 1: Append** Scenario D + extend the top comment; do NOT modify A/B/C or the helpers/tally.
- [ ] **Step 2: Run** `bash scripts/dogfood-rehearsal-loop.sh` → expect ALL PASS (A 17 + B 1 + C 2 + D 8 = 28).
  NOTE: requires a rebuilt `dist` — this task runs AFTER D12's build, OR D12 reruns it. Sequence: implement here,
  then D12 builds + reruns. If `dist` is stale, D1-D8 fail on unknown verbs — that is expected until D12 builds.
- [ ] **Step 3: Commit** `test(rehearsal): dogfood Scenario D — full wind-down (finalize→consensus→handoff→teardown)`.

---

## Task D12: phase-guard flip + dist rebuild + final review + memory

**Files:**
- Modify: `CLAUDE.md` (project) — phase guard
- Modify: `dist/consort.cjs` (rebuilt)
- Modify: memory (`rehearsal-build-state.md`, `MEMORY.md`)

- [ ] **Step 1: Phase-guard flip** in `/home/liupan/CC/consort/CLAUDE.md` "Current phase guard": move `rehearsal`
  (and its verbs) into **Shipped**; leave **`prelude` (meditate) as the ONLY remaining out-of-scope command**
  (drop `rehearsal` from the OUT OF SCOPE line). Keep the wording style of the existing guard.
- [ ] **Step 2: `npm run typecheck && npm run lint && npm run test`** — all green (stale-tokens included).
- [ ] **Step 3: `npm run build`** → refresh `dist/consort.cjs`. Confirm determinism: build twice, identical
  `sha256` (no git diff churn beyond the real change). Confirm all 8 new verbs dispatch from the bundle (a quick
  `node dist/consort.cjs rehearsal finalize` → rc 2 usage, not "unknown verb").
- [ ] **Step 4: Rerun the dogfood** `bash scripts/dogfood-rehearsal-loop.sh` → **ALL PASS (28/28)** against the
  rebuilt bundle.
- [ ] **Step 5: Final holistic review** (subagent or workflow) — verify end-to-end: `finalize`↔`session-summary.md`
  render; `handoff-extract`↔`buildHandoffKv`↔directive 6c; `teardown`↔`archiveTopic` dest↔directive `$ART` rebind;
  `abort`↔`finalize`+`teardown`; `consensus`↔`buildConsensus`; the directive's every `$CS` call matches a real
  verb; stale-token gate green across all shipped files including the new directive + dogfood.
- [ ] **Step 6: Update memory** — `rehearsal-build-state.md` → DONE Phase D (verb signatures + adaptations);
  `MEMORY.md` index → "Phases A/B/C/D done; rehearsal shipped; prelude is the only out-of-scope command."
- [ ] **Step 7: Commit** `build(rehearsal): rebuild dist + flip CLAUDE.md phase guard (rehearsal shipped)`.
- [ ] **Step 8: Finish the branch** — REQUIRED SUB-SKILL: `superpowers:finishing-a-development-branch`. Verify
  tests, present the 4 options, open the single PR for `feat/rehearsal` (the whole A→D port). PR body: the
  four-phase port, the rebrand+frozen contract, the dogfood coverage, the `consensus` §4 amendment.

---

## Self-review (run before dispatching D1)

- **Spec coverage:** §8 Phase D verbs all present (finalize D4 / refine D5 / fresh-part D8 / abort D9 /
  handoff-extract D6 / teardown D7) + consensus D9 (user-approved) + forensics D6 (directive needs it) +
  directive Phases 5/6/6b/6c/7 (D10) + full dogfood (D11) + CLAUDE.md guard + dist (D12). ✔
- **Type consistency:** `archiveTopic` return `string | null` (D1) consumed by D7/D9; `parseScoreboard`/
  `buildHandoffKv` (D2) consumed by D6/D7; `renderSessionSummary`/`renderHaltSection` (D3) consumed by D4;
  `finalizePhase`/`parseHardConstraints` (D4 pure) used by D4 verb; `finalizeWith`/`teardownWith` (D4/D7) consumed
  by D9 abort. ✔ — verify `CompletionSignals` field names + `buildConsensus`/`send`/`coda` signatures against
  source at implementation time.
- **Dependency order:** D1→D7/D9; D2→D6/D7; D3→D4→D9; D7→D9; D10/D11 after verbs; D12 last. ✔
- **No placeholders:** pure modules have full code; verbs have full spec + code skeletons + cited bash symbols for
  FS details. ✔
- **Frozen/rebrand:** handoff keys, result.json schema, state filenames frozen; FINE/Maestro/score-handoff/Part/
  Instrument rebrands applied; stale-token gate checked per task. ✔
