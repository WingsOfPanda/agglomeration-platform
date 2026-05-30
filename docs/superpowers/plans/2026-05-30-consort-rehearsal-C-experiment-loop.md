# consort `rehearsal` Phase C — Experiment Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are SEQUENTIAL — they share `tests/rehearsal-core.test.ts`, `tests/rehearsal-cmd.test.ts`, and `src/commands/rehearsal.ts`; never run two implementers in parallel.

**Goal:** Build the rehearsal experiment loop — the three IPC verbs (`experiment-send`, `score`, `monitor`), the `status-brief` render verb, the frozen experiment prompt template, and the `rehearsal.md` directive Phase 4 + inline loop + decision policy — so the Maestro can dispatch single-config experiments to persistent codex parts, score results into a rolling scoreboard, and keep dispatching until a stop condition fires.

**Architecture:** Pure logic lives in four new `core/rehearsal*.ts` modules (exhaustively unit-tested); the verbs in `src/commands/rehearsal.ts` are thin DI shells over them (mirroring Phase B's `initWith`/`spawnAllWith`). IPC reuses consort's existing `inboxWrite`/`outboxOffset`/`outboxWaitSince`/`paneSend` primitives. The multi-turn loop is **inline** (no resume file, no hook) exactly like the shipped `score`/`perform` turn loops.

**Tech Stack:** TypeScript/ESM (ES2022, NodeNext, strict), vitest, esbuild → committed `dist/consort.cjs`, execa for tmux.

---

## Grounding (read before starting)

- **Spec:** `docs/superpowers/specs/2026-05-30-consort-rehearsal-design.md` — §5 (stage sequence), §6 (decision policy + 7 stop conditions), §7 (frozen semantic formats), §8 Phase C breakdown. Spec wins over MIGRATION.md.
- **Behavioral source (clone-wars):** `bin/deep-research-experiment-send.sh` (294 ln), `bin/deep-research-score.sh` (156 ln), `bin/deep-research-monitor.sh` (159 ln), `config/prompt-templates/deep-research/experiment.md` (191 ln), `commands/deep-research.md` Phase 4 + `deep-research-resume.md` (the loop). Preserve **behavior**, grep by symbol (line numbers drift).
- **Phase A modules already built** (`core/rehearsal*.ts`): `rehearsalArtDir`/`partsDir`/`partStateDir`/`experimentsDir`/`experimentDir` (paths), `parseMetricMd`/`formatMetricBlock`/`formatSotaBlock`/`extractMetric` (metric), `validateResult`/`buildScoreboard`/`renderScoreboardRow`/`normalizeResult`/`ScoreRow`/`ResultJson` (result), `checkCompletion`/`checkTimeBudget` (complete), `buildConsensus` (consensus), `parseState`/`renderState`/`mergeState`/`reconcileFromOutbox`/`readHaltFlag` (state).
- **Phase B verbs already built** (`commands/rehearsal.ts`): `initWith`/`metricWith`/`sotaWith`/`spawnAllWith` + the `run()` switch + the DI house style (`<verb>With(args, deps)` + `liveXDeps` + injected `now`/`stdout`/`opts`).
- **IPC reuse** (`core/ipc.ts`): `inboxWrite(i,m,t,task,{from})` (wraps `From:`+task+generic-done-line+`END_OF_INSTRUCTION`), `inboxPath`/`outboxPath`(i,m,t), `outboxOffset(path)`=`statSync.size`, `outboxWaitSince(i,m,t,off,events,to)`, `paneMetaRead(i,m,t)`, `OutboxEvent`. `core/tmux.ts`: `paneSend(pane,line)`, `paneAlive(pane)`. `core/paths.ts`: `partDir(i,m,t,opts)`=`<topicDir>/<i>-<m>`, `topicDir(t,opts)`.

### Locked design decisions (resolved during grounding — do not re-litigate)

1. **Two state roots (critical).** IPC state (`inbox.md`/`outbox.jsonl`/`pane.json`) lives in the **standard** part dir `partDir(instrument, model, topic)` = `<topicDir>/<instrument>-<model>/` (created by Phase B `spawn-all`). Rehearsal state (`state.txt`, `experiments/<exp>/{code,result.json,prompt.md}`, liveness cursor/rescan) lives under `partStateDir(art, instrument)` = `<topicDir>/_rehearsal/parts/<instrument>/`. The part writes `result.json` to `experimentDir(...)` and appends outbox events to `outboxPath(...)`. A verb that needs the outbox/inbox must **resolve the model** the way `send.ts`/`collect.ts` do: `readdirSync(topicDir)` → first dir starting `<instrument>-` → `paneMetaModel(...)`.

2. **Inbox write = `inboxWrite` direct + best-effort nudge** (NOT routed through `send.ts`). clone-wars `experiment-send.sh` writes the inbox then calls `send.sh @inbox`, which **re-wraps** the content through `cw_inbox_write` (verified: `send.sh:107` `cw_inbox_write ... "$TASK"`). So the part receives the experiment prompt wrapped by the generic `From:`/done-line/`END_OF_INSTRUCTION`. The consort-faithful + house-idiomatic form: the prompt composer **OMITS** the fence/done-line (exactly like `composeResearchPrompt`, `scoreTurn.ts:58-60`), then `experiment-send` calls `inboxWrite(instrument, model, topic, promptBody, {from:"maestro"})` (writes the inbox with the canonical fence) and nudges the pane **best-effort** via `paneSend` (failure → `log.warn`, non-fatal, matching `experiment-send.sh:286-292`). Do NOT call `send.ts` (its `paneAlive` gate would skip the inbox write when the pane is down; clone-wars guarantees the inbox + state transition regardless of nudge).

3. **Rebrand of frozen-looking tokens** (the stale-token gate bans `trooper`/`commander`/`legion` case-insensitively in `src`/`config`/`commands`):
   - monitor notification JSON: clone-wars `{"trooper":...}` → consort **`{"part":"<instrument>",...}`** (the `trooper` key is internal — consumed by the Maestro loop, not the codex part; NOT in the frozen-fields list; gate forces the rename). Keep `event`/`summary`/`ts` (frozen).
   - `results.tsv` header col 1: clone-wars `commander` → consort **`instrument`** (7-col shape/order frozen; the word is rebranded).
   - status-brief table header: clone-wars `| Trooper |` → consort **`| Part |`**.
   - experiment template: full rebrand (trooper→part, commander→instrument, "Master Yoda"/Yoda→Maestro, the peers table `| Trooper |`→`| Part |`).

4. **Verb names** (under the `rehearsal <verb>` namespace): `experiment-send`, `score`, `monitor`, `status-brief`. (`rehearsal score` does not collide with the top-level `score` command — it is namespaced.) These slot into the `run()` switch alongside `init`/`metric`/`sota`/`spawn-all`.

5. **No `END_OF_INSTRUCTION` in the experiment template tail.** Drop the template's trailing bare `END_OF_INSTRUCTION` (clone-wars line 191) — `inboxWrite` supplies the canonical fence (matches the consort research/drilldown port decision). KEEP the template's own `done`-event and `heartbeat` printf lines in the body (frozen event shapes; the generic done-line `inboxWrite` adds is redundant-but-harmless, exactly as in clone-wars).

6. **Monitor = pure `monitorScan` + thin long-running `run()`.** All logic (byte-tail event emit, phase-gate stale/stuck, periodic rescan dedup, cursor/rescan/clock state) lives in a pure `monitorScan(...) → {notifications, state}` that is exhaustively unit-tested. `run()` is the thin shell the Monitor tool launches persistently: load/init state → loop `{scan; emit; persist cursor+rescan; sleep 2}`. A `--once` flag does a single scan then exits (for the dogfood + tests). Byte offsets are **bytes** (`Buffer.byteLength`), never char counts.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/core/rehearsalExperiment.ts` (new) | experiment-send pure logic: `renderExperimentPrompt`, `buildSotaBlock`, `assembleHardwareBlock`, `hardwareDiffAlert`, `formatPeersBlock`, `buildDispatchState`, `EXP_ID_RE`/`INSTRUMENT_RE` | C1 |
| `config/prompt-templates/rehearsal/experiment.md` (new) | the frozen experiment prompt template (rebranded; no trailing fence) | C2 |
| `src/commands/rehearsal.ts` (modify) | `experimentSendWith` verb + DI deps | C3 |
| `src/core/rehearsalScore.ts` (new) | `buildResultsTsv`, `computeScore` pure walk → scoreboard/tsv/sidecars/phaseClears | C4 |
| `src/commands/rehearsal.ts` (modify) | `scoreWith` verb (thin FS shell over `computeScore`) | C5 |
| `src/core/rehearsalMonitor.ts` (new) | `initScanState`, `monitorScan` liveness state machine | C6 |
| `src/commands/rehearsal.ts` (modify) | `monitorRun` verb (model-resolve + scan loop + persist) | C7 |
| `src/core/rehearsalBrief.ts` (new) + `src/commands/rehearsal.ts` (modify) | `buildStatusBrief` + `statusBriefWith` verb | C8 |
| `commands/rehearsal.md` (modify) | Phase 4 (initial dispatch) + inline loop Steps 1–8 + decision policy | C9 |
| `tests/rehearsal-core.test.ts` (modify) | pure-logic tests (C1/C4/C6/C8 core) | C1,C4,C6,C8 |
| `tests/rehearsal-cmd.test.ts` (modify) | verb tests (C3/C5/C7/C8 verb) | C3,C5,C7,C8 |
| `docs/superpowers/DOGFOOD.md` (modify) + `dist/consort.cjs` (rebuild) | simulated-parts loop dogfood + dist | C10 |

---

## Task C1: `core/rehearsalExperiment.ts` — experiment-send pure logic

**Files:**
- Create: `src/core/rehearsalExperiment.ts`
- Test: `tests/rehearsal-core.test.ts` (append a `describe("rehearsalExperiment", ...)`)

Port of the pure parts of `deep-research-experiment-send.sh` (template render, SOTA/hardware/peers block assembly, dispatch state). The `_awk_esc` double-escaping in the bash is a gsub artifact — in TS use literal `String.prototype.replaceAll`, which is already literal; do NOT replicate the escaping.

- [ ] **Step 1: Write the failing tests.** Add to `tests/rehearsal-core.test.ts`:

```ts
import {
  renderExperimentPrompt, buildSotaBlock, assembleHardwareBlock, hardwareDiffAlert,
  formatPeersBlock, buildDispatchState, EXP_ID_RE, INSTRUMENT_RE, type PeerRow,
} from "../src/core/rehearsalExperiment.js";

describe("rehearsalExperiment", () => {
  it("EXP_ID_RE / INSTRUMENT_RE match the bash regexes", () => {
    expect(EXP_ID_RE.test("exp-001")).toBe(true);
    expect(EXP_ID_RE.test("exp-7")).toBe(true);
    expect(EXP_ID_RE.test("exp-")).toBe(false);
    expect(EXP_ID_RE.test("exp001")).toBe(false);
    expect(INSTRUMENT_RE.test("violin")).toBe(true);
    expect(INSTRUMENT_RE.test("french-horn")).toBe(true);
    expect(INSTRUMENT_RE.test("Violin")).toBe(false);
    expect(INSTRUMENT_RE.test("1st")).toBe(false);
  });

  it("renderExperimentPrompt substitutes all 14 tokens literally", () => {
    const tpl = "M={{METRIC_BLOCK}} H={{HARDWARE_BLOCK}} O={{OUTBOX_PATH}} T={{TOPIC}} " +
      "E={{EXP_ID}} L={{APPROACH_LABEL}} B={{APPROACH_BRIEF}} D={{BRANCH_DIR}} " +
      "N={{METRIC_NAME}} S={{TIME_BUDGET_S}} C={{TASK_CONTEXT}} W={{SOTA_BLOCK}} P={{PEERS_BLOCK}} A={{ART_DIR}}";
    const out = renderExperimentPrompt(tpl, {
      metricBlock: "mb", hardwareBlock: "hb", outboxPath: "/o", topicText: "topic",
      expId: "exp-001", approachLabel: "lab", approachBrief: "brief", branchDir: "/bd",
      metricName: "accuracy", timeBudgetS: "1800", taskContext: "", sotaBlock: "", peersBlock: "", artDir: "/a",
    });
    expect(out).toBe("M=mb H=hb O=/o T=topic E=exp-001 L=lab B=brief D=/bd N=accuracy S=1800 C= W= P= A=/a");
  });

  it("renderExperimentPrompt treats $-sequences in values as literal", () => {
    const out = renderExperimentPrompt("x={{TOPIC}}", { ...zeroFields(), topicText: "$1 & $& done" });
    expect(out).toBe("x=$1 & $& done");
  });

  it("renderExperimentPrompt throws if an unrendered {{TOKEN}} remains", () => {
    expect(() => renderExperimentPrompt("a {{UNKNOWN}} b", zeroFields())).toThrow(/unrendered/i);
  });

  it("buildSotaBlock empty when null/empty, wrapped otherwise", () => {
    expect(buildSotaBlock(null)).toBe("");
    expect(buildSotaBlock("")).toBe("");
    const b = buildSotaBlock("ref content");
    expect(b.startsWith("## Reference: SOTA\n\nref content")).toBe(true);
    expect(b).toContain("### Web search affordance");
    expect(b).toContain("## Sources consulted");
  });

  it("assembleHardwareBlock appends alert only when non-empty", () => {
    expect(assembleHardwareBlock("no-gpu", "")).toBe("no-gpu");
    expect(assembleHardwareBlock("gpu...", "ALERT: x")).toBe("gpu...\nALERT: x");
  });

  it("hardwareDiffAlert flags >50% free-memory drop per gpu", () => {
    const base = "detected_at\t2026\ngpu\tA100\t80000\t40000\tdrv";
    const cur  = "detected_at\t2026\ngpu\tA100\t80000\t10000\tdrv";   // 40000 -> 10000 = -75%
    const a = hardwareDiffAlert(base, cur);
    expect(a).toMatch(/ALERT: gpu 'A100' memory\.free 40000 -> 10000 MiB \(-75%\)/);
    expect(hardwareDiffAlert(base, base)).toBe("");        // no change
    expect(hardwareDiffAlert(null, cur)).toBe("");          // no baseline -> no alert
  });

  it("formatPeersBlock empty for zero peers, else a ## Peers table", () => {
    expect(formatPeersBlock([])).toBe("");
    const peers: PeerRow[] = [{ instrument: "viola", phase: "working", currentExp: "exp-003",
      approach: "deep-net", metric: "0.91", status: "ok", notes: "n" }];
    const b = formatPeersBlock(peers);
    expect(b).toContain("## Peers");
    expect(b).toContain("| Part | Phase | Current/last | Approach | Best metric | Notes |");
    expect(b).toContain("| viola | working | exp-003 | deep-net | 0.91 | n |");
    expect(b).not.toMatch(/trooper/i);
  });

  it("buildDispatchState transitions phase->working, bumps counter, stamps event", () => {
    const prev = "exp_counter=2\nphase=idle\ncurrent_exp_id=\nlast_event=spawn\n";
    const next = buildDispatchState(prev, "exp-003", "2026-05-30T10:00:00Z");
    const kv = Object.fromEntries(next.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect(kv.phase).toBe("working");
    expect(kv.current_exp_id).toBe("exp-003");
    expect(kv.exp_counter).toBe("3");
    expect(kv.last_event).toBe("dispatched");
    expect(kv.last_event_ts).toBe("2026-05-30T10:00:00Z");
  });

  it("buildDispatchState defaults a non-numeric counter to 0 -> 1", () => {
    const next = buildDispatchState("phase=idle\n", "exp-001", "T");
    expect(next).toMatch(/exp_counter=1/);
  });
});

function zeroFields() {
  return { metricBlock: "", hardwareBlock: "", outboxPath: "", topicText: "", expId: "",
    approachLabel: "", approachBrief: "", branchDir: "", metricName: "", timeBudgetS: "",
    taskContext: "", sotaBlock: "", peersBlock: "", artDir: "" };
}
```

- [ ] **Step 2: Run to verify failure.** `npm run test -- rehearsal-core` → FAIL (module not found).

- [ ] **Step 3: Implement `src/core/rehearsalExperiment.ts`:**

```ts
// Experiment-send pure logic for /consort:rehearsal. Faithful to
// deep-research-experiment-send.sh (template render, sota/hardware/peers block
// assembly, dispatch state transition). Pure; FS/subprocess happen in the verb.
import { mergeState } from "./rehearsalState.js";

/** ^exp-[0-9]+$ — 1+ digit experiment id (bash experiment-send.sh:61). */
export const EXP_ID_RE = /^exp-[0-9]+$/;
/** ^[a-z][a-z0-9-]*$ — instrument name (bash experiment-send.sh:64). */
export const INSTRUMENT_RE = /^[a-z][a-z0-9-]*$/;

export interface PromptFields {
  metricBlock: string; hardwareBlock: string; outboxPath: string; topicText: string;
  expId: string; approachLabel: string; approachBrief: string; branchDir: string;
  metricName: string; timeBudgetS: string; taskContext: string; sotaBlock: string;
  peersBlock: string; artDir: string;
}

const TOKENS: Array<[string, keyof PromptFields]> = [
  ["{{METRIC_BLOCK}}", "metricBlock"], ["{{HARDWARE_BLOCK}}", "hardwareBlock"],
  ["{{OUTBOX_PATH}}", "outboxPath"], ["{{TOPIC}}", "topicText"], ["{{EXP_ID}}", "expId"],
  ["{{APPROACH_LABEL}}", "approachLabel"], ["{{APPROACH_BRIEF}}", "approachBrief"],
  ["{{BRANCH_DIR}}", "branchDir"], ["{{METRIC_NAME}}", "metricName"],
  ["{{TIME_BUDGET_S}}", "timeBudgetS"], ["{{TASK_CONTEXT}}", "taskContext"],
  ["{{SOTA_BLOCK}}", "sotaBlock"], ["{{PEERS_BLOCK}}", "peersBlock"], ["{{ART_DIR}}", "artDir"],
];

/** Render the experiment template by literal token substitution (replaceAll is literal —
 *  no awk-escape dance). Throws if any {{TOKEN}} remains unrendered. */
export function renderExperimentPrompt(template: string, f: PromptFields): string {
  let out = template;
  for (const [token, key] of TOKENS) out = out.split(token).join(f[key]);
  const leftover = out.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`renderExperimentPrompt: unrendered placeholder ${leftover[0]}`);
  return out;
}

const SOTA_AFFORDANCE =
  "### Web search affordance\n\n" +
  "Consult this reference before starting. Web search (curl / pip install / arXiv / " +
  "HuggingFace / etc.) is allowed when you hit a plateau or before scaling up. Record any " +
  "consulted source in notes.md under a `## Sources consulted` heading.";

/** Wrap sota.md content, or "" when absent/empty (bash experiment-send.sh:209-214). */
export function buildSotaBlock(sotaMd: string | null): string {
  if (!sotaMd || sotaMd.trim() === "") return "";
  return `## Reference: SOTA\n\n${sotaMd}\n\n${SOTA_AFFORDANCE}`;
}

/** probe text + a trailing alert line iff alert non-empty (bash experiment-send.sh:164). */
export function assembleHardwareBlock(probeText: string, alertText: string): string {
  return alertText ? `${probeText}\n${alertText}` : probeText;
}

interface Gpu { name: string; free: number; }
function parseGpus(probe: string | null): Map<string, Gpu> {
  const m = new Map<string, Gpu>();
  if (!probe) return m;
  for (const line of probe.split("\n")) {
    const c = line.split("\t");
    if (c[0] === "gpu" && c.length >= 4) m.set(c[1], { name: c[1], free: Number(c[3]) });
  }
  return m;
}

/** Emit "ALERT: gpu '<name>' memory.free <b> -> <c> MiB (-X%)" for GPUs whose free dropped
 *  >50% baseline->current. "" when no baseline or no qualifying drop. */
export function hardwareDiffAlert(baseline: string | null, current: string): string {
  const base = parseGpus(baseline);
  const cur = parseGpus(current);
  const out: string[] = [];
  for (const [name, b] of base) {
    const c = cur.get(name);
    if (!c || !(b.free > 0)) continue;
    const dropPct = Math.round(((b.free - c.free) / b.free) * 100);
    if (dropPct > 50) out.push(`ALERT: gpu '${name}' memory.free ${b.free} -> ${c.free} MiB (-${dropPct}%)`);
  }
  return out.join("\n");
}

export interface PeerRow {
  instrument: string; phase: string; currentExp: string;
  approach: string; metric: string; status: string; notes: string;
}

/** "## Peers" markdown section (one row per peer, self excluded by the caller). "" when no peers.
 *  Faithful to cw_deep_research_format_peers_block; table header rebranded Trooper->Part. */
export function formatPeersBlock(peers: PeerRow[]): string {
  if (peers.length === 0) return "";
  const lines = [
    "## Peers",
    "",
    "Other parts are exploring this objective in parallel. Diverge from their approaches —",
    "do not duplicate a pipeline a peer is already running. Use their results to decide where",
    "the unexplored, promising region of the design space is.",
    "",
    "| Part | Phase | Current/last | Approach | Best metric | Notes |",
    "|---|---|---|---|---|---|",
  ];
  for (const p of peers) {
    const metric = p.metric === "" ? "" : `${p.metric}${p.status && p.status !== "ok" ? ` (${p.status})` : ""}`;
    const notes = p.notes.length > 80 ? p.notes.slice(0, 80) : p.notes;
    lines.push(`| ${p.instrument} | ${p.phase} | ${p.currentExp} | ${p.approach} | ${metric} | ${notes} |`);
  }
  return lines.join("\n");
}

/** Dispatch state transition: phase=working, current_exp_id=<expId>, exp_counter=+1 (0 if
 *  non-numeric), last_event=dispatched, last_event_ts=<nowIso>. Merges over existing KV. */
export function buildDispatchState(existing: string | null, expId: string, nowIso: string): string {
  const prevCounter = existing?.split("\n").find((l) => l.startsWith("exp_counter="))?.slice("exp_counter=".length) ?? "";
  const n = /^[0-9]+$/.test(prevCounter.trim()) ? parseInt(prevCounter, 10) : 0;
  return mergeState(existing, {
    phase: "working", current_exp_id: expId, exp_counter: String(n + 1),
    last_event: "dispatched", last_event_ts: nowIso,
  });
}
```

- [ ] **Step 4: Run to verify pass.** `npm run test -- rehearsal-core` → PASS. `npm run typecheck` → 0. `npm run lint` → clean.

- [ ] **Step 5: Commit.** `git add src/core/rehearsalExperiment.ts tests/rehearsal-core.test.ts && git commit -m "feat(rehearsal): experiment-send pure logic (render/sota/hardware/peers/state)"`

> **Note on peers-block faithfulness:** The exact divergence guidance prose (3 lines) and the metric-cell format are the implementer's faithful reproduction of `cw_deep_research_format_peers_block` (deep-research.sh ~1192-1197). The spec reviewer must diff against the bash for the table header + column semantics; the prose wording can adapt to the consort voice as long as the "diverge from peers" intent and the table shape are preserved.

---

## Task C2: `config/prompt-templates/rehearsal/experiment.md` — the frozen template

**Files:**
- Create: `config/prompt-templates/rehearsal/experiment.md`
- Test: `tests/rehearsal-core.test.ts` (a render-integration test that loads the real template)

Port `config/prompt-templates/deep-research/experiment.md` (191 ln) with the full musical rebrand and the trailing-fence drop. The `result.json` schema (12 keys, exact order), the `done`/`heartbeat` event-line shapes, the `audit.json` contract, and the 5-step protocol are **FROZEN** — preserve byte-identical modulo rebrand. The 14 `{{TOKEN}}` placeholders must all be present.

- [ ] **Step 1: Write the failing render-integration test.** Add to `tests/rehearsal-core.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("rehearsal experiment template", () => {
  const tpl = readFileSync(join(__dirname, "..", "config", "prompt-templates", "rehearsal", "experiment.md"), "utf8");

  it("contains all 14 placeholders and no stale clone-wars terms", () => {
    for (const t of ["METRIC_BLOCK","HARDWARE_BLOCK","OUTBOX_PATH","TOPIC","EXP_ID","APPROACH_LABEL",
      "APPROACH_BRIEF","BRANCH_DIR","METRIC_NAME","TIME_BUDGET_S","TASK_CONTEXT","SOTA_BLOCK","PEERS_BLOCK","ART_DIR"]) {
      expect(tpl).toContain(`{{${t}}}`);
    }
    expect(tpl).not.toMatch(/trooper|commander|master[- ]?yoda|\byoda\b/i);
  });

  it("preserves the frozen result.json schema keys in order", () => {
    const keys = ["branch_id","approach_label","metric_name","metric_value","status","runtime_s",
      "log_paths","checkpoint_path","notes","self_reported_count","self_reported_ratio","self_reported_notes"];
    let last = -1;
    for (const k of keys) { const i = tpl.indexOf(`"${k}"`); expect(i).toBeGreaterThan(last); last = i; }
  });

  it("keeps the frozen done + heartbeat event shapes and does NOT end with END_OF_INSTRUCTION", () => {
    expect(tpl).toContain('"event":"done"');
    expect(tpl).toContain('"event":"heartbeat"');
    expect(tpl.trimEnd().endsWith("END_OF_INSTRUCTION")).toBe(false);
  });

  it("renders with zero leftover placeholders", () => {
    const out = renderExperimentPrompt(tpl, {
      metricBlock: "MB", hardwareBlock: "HB", outboxPath: "/o.jsonl", topicText: "the topic",
      expId: "exp-001", approachLabel: "baseline", approachBrief: "do the thing", branchDir: "/bd",
      metricName: "accuracy", timeBudgetS: "1800", taskContext: "", sotaBlock: "", peersBlock: "", artDir: "/a",
    });
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `npm run test -- rehearsal-core` → FAIL (template missing).

- [ ] **Step 3: Create the template.** Copy `/home/liupan/CC/clone-wars/config/prompt-templates/deep-research/experiment.md` and apply, faithfully:
  - **Rebrand** every occurrence: `trooper`→`part`, `commander`→`instrument`, `Master Yoda`/`Yoda`/`the advisor (Yoda)`→`Maestro`/`the Maestro`, peers table `| Trooper |`→`| Part |`. (Gate scans `config/`.)
  - **Drop** the trailing bare `END_OF_INSTRUCTION` (last line) — `inboxWrite` appends the canonical fence.
  - **Preserve byte-identical** (modulo rebrand): the `result.json` 12-key schema block + order; the `{"event":"done","summary":"experiment {{EXP_ID}} metric=<value> status=<status>","ts":"<iso>"}` line written to `{{OUTBOX_PATH}}`; the `{"event":"heartbeat","summary":"epoch <N>/<total>","ts":"<iso>"}` line; the `audit.json` contract section; the explore-only / no-system-command / net-access paragraphs; `## Shared utilities`; the 5 numbered steps; failure handling; wall-clock/cost/independence/validation-feedback paragraphs.
  - Keep all 14 `{{TOKEN}}` placeholders.

- [ ] **Step 4: Run to verify pass.** `npm run test -- rehearsal-core` → PASS. Then `npm run test -- stale-tokens` → PASS (the template is now scanned).

- [ ] **Step 5: Commit.** `git add config/prompt-templates/rehearsal/experiment.md tests/rehearsal-core.test.ts && git commit -m "feat(rehearsal): experiment prompt template (rebranded, fence-dropped, schema frozen)"`

---

## Task C3: `experiment-send` verb

**Files:**
- Modify: `src/commands/rehearsal.ts` (add `experimentSendWith` + `ExperimentSendDeps` + `liveExperimentSendDeps` + `run()` case)
- Test: `tests/rehearsal-cmd.test.ts`

Port `deep-research-experiment-send.sh`'s orchestration. The verb is a thin DI shell: parse → validate → phase gate → branch dir → (optional smoke-test) → gather blocks via deps → `renderExperimentPrompt` (C1) → write `prompt.md` → `inboxWrite` direct → `buildDispatchState` → best-effort nudge.

**Arg contract:** optional flags FIRST (`--inputs <csv>`, `--context-file <path>`, `--smoke-test <path>`, `--timeout <N>`), then exactly 5 positionals: `<topic> <instrument> <exp-id> <approach-label> <approach-brief>`.

**Exit codes** (faithful to the bash): `2` = bad args / bad `exp-id` / bad instrument / unreadable inputs / non-exec-or-failed smoke-test / unreadable context-file / bad timeout / **phase=abandoned**; `1` = missing art dir / metric.md / state.txt / outbox / empty-or-unrendered prompt / **phase≠idle (non-abandoned)**; `0` = dispatched.

**Phase gate has THREE outcomes** — `abandoned`→rc 2 (distinct), `idle`→proceed, anything-else→rc 1. Smoke-test runs AFTER branch-dir creation but BEFORE any state mutation.

- [ ] **Step 1: Write the failing tests.** Add to `tests/rehearsal-cmd.test.ts`. Use `freshHome()`; pre-scaffold a topic via `rehearsalArtDir`, write `metric.md`, `topic.txt`, and a part's `state.txt`. Inject deps so no real tmux runs (`dryRun: true`, fake `paneSend`). Key cases:
  - **idle → dispatched (rc 0):** writes `experiments/exp-001/prompt.md` (no `{{` leftover), writes the part's `inbox.md` containing the prompt body + `END_OF_INSTRUCTION`, transitions `state.txt` to `phase=working current_exp_id=exp-001 exp_counter=1 last_event=dispatched`, and (dryRun) does not call `paneSend`.
  - **phase=working → rc 1** ("not idle").
  - **phase=abandoned → rc 2** (distinct).
  - **bad exp-id (`exp1`) → rc 2**; **bad instrument (`Viola`) → rc 2**.
  - **missing metric.md → rc 1**; **missing state.txt → rc 1**; **missing outbox → rc 1**.
  - **`--context-file` unreadable → rc 2**; readable → its content lands in the rendered prompt (`{{TASK_CONTEXT}}`).
  - **`--smoke-test` non-exec → rc 2**; a failing injected `runSmokeTest` → rc 2 + `smoke-test.err` written + state stays `idle` (NOT transitioned).
  - **sota.md present** → the rendered prompt contains `## Reference: SOTA`.
  - **nudge:** with `dryRun:false` and a fake `paneSend` that throws, the verb still returns rc 0 (best-effort) and the inbox + state are written.

- [ ] **Step 2: Run to verify failure.** `npm run test -- rehearsal-cmd` → FAIL.

- [ ] **Step 3: Implement.** Add to `src/commands/rehearsal.ts` (imports + the verb). DI interface:

```ts
export interface ExperimentSendDeps {
  now(): string;                                          // isoUtc — last_event_ts
  probeHardware(): string;                                // best-effort: "no-gpu" or "detected_at\t..\ngpu\t.."
  inboxWrite(i: string, m: string, t: string, body: string, opts: { from: string }): void;
  paneSend(pane: string, line: string): Promise<void>;    // tmux nudge
  paneMetaRead(i: string, m: string, t: string): string | null;
  resolveModel(instrument: string, topic: string): string | null;  // readdir <i>- prefix
  runSmokeTest?(script: string, cwd: string, timeoutSec: number): { ok: boolean; stderr: string };
  smokeTimeoutSec?: number;                               // default 60
  consultTimeout(kind: "experiment"): number;             // default per-experiment cap (1800)
  dryRun?: boolean;
  stdout?: (line: string) => void;
  opts?: PathOpts;
}
```

Control flow (mirror `experiment-send.sh`):
1. Parse flags-first then 5 positionals (reuse the `parseInitArgs` flag-loop style). Bad-arg / bad count → rc 2.
2. `EXP_ID_RE`/`INSTRUMENT_RE` validate (rc 2). `--inputs` readability probe (rc 2). `--smoke-test` executable probe (rc 2). `--timeout` `^[1-9][0-9]*$` (rc 2). `--context-file` readability (rc 2; read content for `{{TASK_CONTEXT}}`).
3. `art = rehearsalArtDir(topic, opts)`; must be a dir (rc 1). `metric.md` must exist (rc 1). `state = partStateDir(art, instrument)`; `state.txt` must exist (rc 1).
4. Phase gate from `parseState(stateTxt).phase`: `abandoned`→rc 2, `≠idle`→rc 1, `idle`→proceed.
5. `branchDir = experimentDir(art, instrument, expId)`; `mkdirSync(join(branchDir,"code"), {recursive:true})`.
6. If `--smoke-test`: run `runSmokeTest(script, join(branchDir,"code"), smokeTimeoutSec ?? 60)`; on fail write `branchDir/smoke-test.err`, log error, rc 2 (state untouched).
7. Resolve `model = resolveModel(instrument, topic)` (rc 1 if null); `outbox = outboxPath(instrument, model, topic)`; must exist (rc 1). (The outbox file is created at spawn; its absence means the part was never spawned.)
8. Gather blocks: `metricBlock = readFileSync(metric.md)`; `metricName = parseMetricMd(metricBlock).primaryMetric` (rc 1 if empty); `probe = deps.probeHardware()`; `hardwareBlock = assembleHardwareBlock(probe, hardwareDiffAlert(<baseline hardware.txt or null>, probe))`; `topicText = readFileSync(art/topic.txt)`; `sotaBlock = buildSotaBlock(<sota.md or null>)`; `peersBlock = formatPeersBlock(<peers gathered from parts.txt + each peer state.txt + latest result.json, self excluded>)`; `timeBudgetS = String(timeout ?? deps.consultTimeout("experiment"))`.
9. `prompt = renderExperimentPrompt(template, fields)` where `template = readFileSync(<plugin root>/config/prompt-templates/rehearsal/experiment.md)`. Empty/`throw` → rc 1.
10. `atomicWrite(join(branchDir,"prompt.md"), prompt)`.
11. `deps.inboxWrite(instrument, model, topic, prompt, { from: "maestro" })`.
12. `atomicWrite(state.txt, buildDispatchState(stateTxt, expId, deps.now()))`.
13. Nudge (skip if `dryRun`): `pane = deps.paneMetaRead(instrument, model, topic)`; if pane, `try { await deps.paneSend(pane, `Read ${inbox} and execute the task. Reply when done.`) } catch { log.warn(...) }`. Non-fatal.
14. `out("dispatched ${expId} -> ${instrument}")`; rc 0.

`liveExperimentSendDeps`: `now: isoUtc`, `probeHardware` = best-effort `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits` → format rows or `"no-gpu"` (wrap in try/catch → `"no-gpu"`), `inboxWrite`/`paneMetaRead` from `core/ipc.js`, `paneSend` from `core/tmux.js`, `resolveModel` (factor the `send.ts` readdir+`paneMetaModel` logic — see note below), `runSmokeTest` = `execFileSync` under a timeout, `consultTimeout` from `core/contracts.js`, `dryRun: process.env.CONSORT_DRY_RUN === "1"`.

`run()` case: `case "experiment-send": return experimentSendWith(applyArgsFile(rest), liveExperimentSendDeps);`

- [ ] **Step 4: Run to verify pass.** `npm run test -- rehearsal-cmd` → PASS. `npm run typecheck` → 0. `npm run lint` → clean.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(rehearsal): experiment-send verb (dispatch one experiment to a persistent part)"`

> **`resolveModel` DRY note:** `send.ts` and `collect.ts` each inline this readdir-for-`<instrument>-` + `paneMetaModel` logic. C3 needs it too. Either inline it again (matches the established non-DRY pattern) OR factor a shared `resolveModel(instrument, topic, opts?): string | null` into `core/ipc.ts` and have C3 use it. **Prefer the shared helper** — flag it for the spec reviewer; if extracting, leave `send.ts`/`collect.ts` untouched (no drive-by refactor) and only add the new export.

---

## Task C4: `core/rehearsalScore.ts` — score pure walk

**Files:**
- Create: `src/core/rehearsalScore.ts`
- Test: `tests/rehearsal-core.test.ts`

Port the pure logic of `deep-research-score.sh`: walk all `parts/*/experiments/*/result.json` (sorted ascending), validate+accumulate each, build the scoreboard + `results.tsv`, compute sidecar writes/removes + race-guarded phase clears. Pure: all FS access is injected via deps; returns a `ScoreComputation` the verb (C5) then applies.

- [ ] **Step 1: Write the failing tests.** Add to `tests/rehearsal-core.test.ts`:

```ts
import { buildResultsTsv, computeScore, type ScoreFs } from "../src/core/rehearsalScore.js";

describe("rehearsalScore", () => {
  it("buildResultsTsv header is the frozen 7-col shape with 'instrument' col1", () => {
    const tsv = buildResultsTsv([]);
    expect(tsv).toBe("exp_id\tinstrument\tapproach\tmetric\tstatus\truntime_s\tmetric_name\n");
  });

  it("buildResultsTsv appends rows in given order (approach col3, metric col4)", () => {
    const tsv = buildResultsTsv([
      { expId: "exp-001", instrument: "viola", approach: "base", metric: "0.9", status: "ok", runtime: "12", metricName: "accuracy" },
    ]);
    expect(tsv).toBe("exp_id\tinstrument\tapproach\tmetric\tstatus\truntime_s\tmetric_name\n" +
      "exp-001\tviola\tbase\t0.9\tok\t12\taccuracy\n");
  });

  it("computeScore validates, sorts, race-guards phase clear", () => {
    // Fake FS: two parts; viola/exp-001 ok 0.95, cello/exp-001 ok 0.90, cello current=exp-001 has result.
    const files: Record<string, string> = {
      "/a/metric.md": "**Primary metric:** accuracy\n",
      "/a/parts/viola/state.txt": "phase=working\ncurrent_exp_id=exp-001\n",
      "/a/parts/cello/state.txt": "phase=working\ncurrent_exp_id=exp-001\n",
      "/a/parts/viola/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"base",metric_name:"accuracy",metric_value:0.95,status:"ok",
        runtime_s:12,log_paths:[],checkpoint_path:null,notes:"" }),
      "/a/parts/cello/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"deep",metric_name:"accuracy",metric_value:0.90,status:"ok",
        runtime_s:20,log_paths:[],checkpoint_path:null,notes:"" }),
    };
    const fs = fakeFs(files);
    const c = computeScore("/a", fs, () => "2026-05-30T00:00:00Z");
    expect(c.scoreboardMd).toContain("| 1 | exp-001 | viola |");   // 0.95 ranks above 0.90
    expect(c.scoreboardMd).toContain("| 2 | exp-001 | cello |");
    expect(c.resultsTsv.split("\n")[1]).toContain("cello");        // walk order: cello before viola (ascending)
    expect(c.phaseClears.map((p) => p.statePath).sort()).toEqual([
      "/a/parts/cello/state.txt", "/a/parts/viola/state.txt"]);
    expect(c.phaseClears[0].merged).toMatch(/phase=idle/);
    expect(c.phaseClears[0].merged).toMatch(/current_exp_id=\n|current_exp_id=$/m);
  });

  it("computeScore rejects a bad metric_name -> sidecar, omits from scoreboard+tsv, no throw", () => {
    const files: Record<string, string> = {
      "/a/metric.md": "**Primary metric:** accuracy\n",
      "/a/parts/viola/state.txt": "current_exp_id=exp-001\n",
      "/a/parts/viola/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"x",metric_name:"loss",metric_value:0.1,status:"ok",
        runtime_s:1,log_paths:[],checkpoint_path:null,notes:"" }),
    };
    const c = computeScore("/a", fakeFs(files), () => "T");
    expect(c.sidecars).toHaveLength(1);
    expect(c.sidecars[0].path).toBe("/a/parts/viola/experiments/exp-001/result-validation.txt");
    expect(c.sidecars[0].body).toMatch(/^FAILED at T: metric_name 'loss' != /);
    expect(c.scoreboardMd).not.toContain("exp-001");
    expect(c.resultsTsv.split("\n").filter(Boolean)).toHaveLength(1); // header only
    expect(c.warnings).toHaveLength(1);
  });

  it("computeScore does NOT clear phase for a part whose current_exp_id has no result.json (race guard)", () => {
    const files: Record<string, string> = {
      "/a/metric.md": "**Primary metric:** accuracy\n",
      "/a/parts/viola/state.txt": "phase=working\ncurrent_exp_id=exp-002\n", // exp-002 has no result
      "/a/parts/viola/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"x",metric_name:"accuracy",metric_value:0.9,status:"ok",
        runtime_s:1,log_paths:[],checkpoint_path:null,notes:"" }),
    };
    const c = computeScore("/a", fakeFs(files), () => "T");
    expect(c.phaseClears).toHaveLength(0);   // exp-002 absent -> still working
  });

  it("computeScore removes a stale sidecar when a result becomes valid", () => {
    const files: Record<string, string> = {
      "/a/metric.md": "**Primary metric:** accuracy\n",
      "/a/parts/viola/state.txt": "current_exp_id=exp-001\n",
      "/a/parts/viola/experiments/exp-001/result.json": JSON.stringify({
        branch_id:"b",approach_label:"x",metric_name:"accuracy",metric_value:0.9,status:"ok",
        runtime_s:1,log_paths:[],checkpoint_path:null,notes:"" }),
      "/a/parts/viola/experiments/exp-001/result-validation.txt": "FAILED at old: x\n",
    };
    const c = computeScore("/a", fakeFs(files), () => "T");
    expect(c.staleSidecars).toEqual(["/a/parts/viola/experiments/exp-001/result-validation.txt"]);
  });
});

// minimal injectable FS over a path->content map
function fakeFs(files: Record<string, string>): ScoreFs {
  const has = (p: string) => p in files;
  const dirsUnder = (p: string) => {
    const pre = p.endsWith("/") ? p : p + "/";
    const set = new Set<string>();
    for (const k of Object.keys(files)) if (k.startsWith(pre)) set.add(k.slice(pre.length).split("/")[0]);
    return [...set].sort();
  };
  return {
    exists: has,
    read: (p) => (p in files ? files[p] : null),
    listDir: (p) => dirsUnder(p),
  };
}
```

- [ ] **Step 2: Run to verify failure.** `npm run test -- rehearsal-core` → FAIL.

- [ ] **Step 3: Implement `src/core/rehearsalScore.ts`:** (uses `validateResult`/`buildScoreboard`/`ScoreRow`/`ResultJson` from `rehearsalResult.js`, `mergeState`/`parseState` from `rehearsalState.js`, `parseMetricMd` from `rehearsalMetric.js`, and the path helpers from `rehearsal.js`)

```ts
// Score-walk pure logic for /consort:rehearsal. Faithful to deep-research-score.sh:
// walk parts/*/experiments/*/result.json (ascending), validate+accumulate, build
// scoreboard + results.tsv, compute sidecar writes/removes + race-guarded phase clears.
// Pure: FS access injected via ScoreFs; the verb (C5) applies the returned plan.
import { join } from "node:path";
import { validateResult, buildScoreboard, type ScoreRow } from "./rehearsalResult.js";
import { mergeState, parseState } from "./rehearsalState.js";
import { parseMetricMd } from "./rehearsalMetric.js";
import { partsDir, partStateDir, experimentsDir, experimentDir } from "./rehearsal.js";

export interface ScoreFs {
  exists(path: string): boolean;
  read(path: string): string | null;
  listDir(path: string): string[];   // sorted ascending by the impl
}

export interface TsvRow {
  expId: string; instrument: string; approach: string;
  metric: string; status: string; runtime: string; metricName: string;
}

const TSV_HEADER = "exp_id\tinstrument\tapproach\tmetric\tstatus\truntime_s\tmetric_name\n";

/** results.tsv = frozen 7-col header + one row per experiment (walk order). */
export function buildResultsTsv(rows: TsvRow[]): string {
  return TSV_HEADER + rows.map((r) =>
    `${r.expId}\t${r.instrument}\t${r.approach}\t${r.metric}\t${r.status}\t${r.runtime}\t${r.metricName}\n`).join("");
}

export interface ScoreComputation {
  scoreboardMd: string;
  resultsTsv: string;
  sidecars: { path: string; body: string }[];   // result-validation.txt to write (rejected)
  staleSidecars: string[];                        // result-validation.txt to remove (now valid)
  phaseClears: { statePath: string; merged: string }[];  // race-guarded idle transitions
  warnings: string[];
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : typeof v === "number" ? String(v) : String(v);
}

/** Compute the full score plan for a rehearsal art dir. now() stamps sidecar/last_event_ts. */
export function computeScore(art: string, fs: ScoreFs, now: () => string): ScoreComputation {
  const metricMd = fs.read(join(art, "metric.md"));
  const primary = metricMd ? parseMetricMd(metricMd).primaryMetric : "";
  const expectedMetric = primary ? primary : undefined;

  const rows: ScoreRow[] = [];
  const tsvRows: TsvRow[] = [];
  const sidecars: { path: string; body: string }[] = [];
  const staleSidecars: string[] = [];
  const warnings: string[] = [];

  const parts = fs.exists(partsDir(art)) ? fs.listDir(partsDir(art)) : [];
  for (const instrument of parts) {                       // ascending
    const expRoot = experimentsDir(art, instrument);
    const exps = fs.exists(expRoot) ? fs.listDir(expRoot) : [];
    for (const expId of exps) {                            // ascending
      const branchDir = experimentDir(art, instrument, expId);
      const resultPath = join(branchDir, "result.json");
      if (!fs.exists(resultPath)) continue;                // skip experiments without a result
      const sidecar = join(branchDir, "result-validation.txt");
      let json: unknown;
      try { json = JSON.parse(fs.read(resultPath) ?? ""); }
      catch { json = null; }
      const v = validateResult(json, {
        expectedMetric,
        logPathExists: (p) => (p.startsWith("./") ? fs.exists(join(branchDir, p)) : true),
      });
      if (!v.ok) {
        sidecars.push({ path: sidecar, body: `FAILED at ${now()}: ${v.error}\n` });
        warnings.push(`result.json invalid: ${resultPath} (${v.error})`);
        continue;                                          // omit from scoreboard AND tsv
      }
      if (fs.exists(sidecar)) staleSidecars.push(sidecar); // now-valid -> remove stale sidecar
      const o = json as Record<string, unknown>;
      const metric = str(o.metric_value), status = str(o.status), runtime = str(o.runtime_s),
        approach = str(o.approach_label), metricName = str(o.metric_name);
      rows.push({ expId, instrument, metric, status, runtime, approach, metricName });
      tsvRows.push({ expId, instrument, approach, metric, status, runtime, metricName });
    }
  }

  // Race-guarded phase clear: idle ONLY for parts whose own current_exp_id has a result.json.
  const phaseClears: { statePath: string; merged: string }[] = [];
  for (const instrument of parts) {
    const statePath = join(partStateDir(art, instrument), "state.txt");
    const stateTxt = fs.read(statePath);
    if (stateTxt === null) continue;
    const cur = parseState(stateTxt).current_exp_id ?? "";
    if (!cur) continue;
    if (!fs.exists(join(experimentDir(art, instrument, cur), "result.json"))) continue;
    phaseClears.push({ statePath, merged: mergeState(stateTxt, {
      last_event: "scored", last_event_ts: now(), phase: "idle", current_exp_id: "" }) });
  }

  return { scoreboardMd: buildScoreboard(rows), resultsTsv: buildResultsTsv(tsvRows),
    sidecars, staleSidecars, phaseClears, warnings };
}
```

- [ ] **Step 4: Run to verify pass.** `npm run test -- rehearsal-core` → PASS. typecheck 0, lint clean.

- [ ] **Step 5: Commit.** `git add src/core/rehearsalScore.ts tests/rehearsal-core.test.ts && git commit -m "feat(rehearsal): score pure walk (validate/scoreboard/tsv/sidecars/race-guard)"`

---

## Task C5: `score` verb

**Files:**
- Modify: `src/commands/rehearsal.ts` (add `scoreWith` + `RehearsalScoreDeps` + `liveScoreDeps` + `run()` case)
- Test: `tests/rehearsal-cmd.test.ts`

Thin FS shell over `computeScore` (C4). Arg: exactly 1 positional `<topic>` (rc 2 otherwise). `parts` dir missing → rc 1. Else compute, then **write in the frozen order**: `scoreboard.md` (atomic) → log `[score] scoreboard at <path>` → `results.tsv` (atomic) → write/remove sidecars → apply phase clears (each `atomicWrite`) → log each warning. rc 0.

- [ ] **Step 1: Write failing tests.** Add to `tests/rehearsal-cmd.test.ts`: scaffold a topic under `freshHome()` with `metric.md` + two parts each with a valid `result.json`; run `scoreWith(["topic"], liveScoreDeps, {home,cwd})`; assert `scoreboard.md` + `results.tsv` exist on disk with the right ranking; assert a part's `state.txt` flipped to `phase=idle current_exp_id=`; assert a bad result wrote `result-validation.txt` and is absent from `scoreboard.md`; assert `scoreWith([])` → rc 2; missing parts dir → rc 1.

- [ ] **Step 2: Run to verify failure.** → FAIL.

- [ ] **Step 3: Implement.** Add to `src/commands/rehearsal.ts`:

```ts
export interface RehearsalScoreDeps {
  computeScore(art: string, fs: ScoreFs, now: () => string): ScoreComputation; // = core computeScore
  fs: ScoreFs;                       // live = existsSync/readFileSync-or-null/readdirSync().sort()
  writeAtomic(path: string, content: string): void;
  removeFile(path: string): void;    // rmSync force
  now(): string;
  stdout?: (line: string) => void;
  opts?: PathOpts;
}

export async function scoreWith(args: string[], deps: RehearsalScoreDeps): Promise<number> {
  const topic = args.find((a) => !a.startsWith("--"));
  if (!topic || args.filter((a) => !a.startsWith("--")).length !== 1) { log.error("usage: rehearsal score <topic>"); return 2; }
  const art = rehearsalArtDir(topic, deps.opts);
  if (!deps.fs.exists(partsDir(art))) { log.error(`rehearsal score: parts dir missing: ${partsDir(art)}`); return 1; }
  const c = deps.computeScore(art, deps.fs, deps.now);
  deps.writeAtomic(join(art, "scoreboard.md"), c.scoreboardMd);
  log.ok(`[score] scoreboard at ${join(art, "scoreboard.md")}`);
  deps.writeAtomic(join(art, "results.tsv"), c.resultsTsv);
  for (const s of c.sidecars) deps.writeAtomic(s.path, s.body);
  for (const p of c.staleSidecars) deps.removeFile(p);
  for (const pc of c.phaseClears) deps.writeAtomic(pc.statePath, pc.merged);
  for (const w of c.warnings) log.warn(w);
  return 0;
}
```

`liveScoreDeps`: `computeScore` (the core fn), `fs: { exists: existsSync, read: (p) => existsSync(p) ? readFileSync(p,"utf8") : null, listDir: (p) => readdirSync(p).sort() }`, `writeAtomic: atomicWrite`, `removeFile: (p) => { try { rmSync(p, { force: true }); } catch { /* */ } }`, `now: isoUtc`.

`run()` case: `case "score": return scoreWith(rest, liveScoreDeps);`

- [ ] **Step 4: Run to verify pass.** → PASS. typecheck 0, lint clean.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(rehearsal): score verb (scoreboard + results.tsv + race-guarded phase clear)"`

---

## Task C6: `core/rehearsalMonitor.ts` — liveness state machine

**Files:**
- Create: `src/core/rehearsalMonitor.ts`
- Test: `tests/rehearsal-core.test.ts`

Port `deep-research-monitor.sh` into a pure single-scan function. The trickiest math — exhaustive tests. **Byte semantics** for offsets (`Buffer.byteLength`). Three passes per scan: (A) byte-tail forward new lines emitting `done|error|question|heartbeat`; (B) phase-gate stale/stuck (only when `phase=="working"`) emitting `stale`/`stuck` with mtime-delta summaries, mutually exclusive (stuck checked first), each rate-limited by its own threshold; (C) periodic rescan over the WHOLE outbox emitting `done|error|question` not already in the dedup set (keyed by 1-based `<lineNum>\t<event>`), suffixing ` (rescan)`. Default thresholds (CODE, not the stale doc comment): `probeS=900`, `stuckS=1800`, `rescanEveryS=30`.

- [ ] **Step 1: Write failing tests.** Add to `tests/rehearsal-core.test.ts`:

```ts
import { initScanState, monitorScan, type MonitorScanState, type MonitorDeps } from "../src/core/rehearsalMonitor.js";

const TH = { probeS: 900, stuckS: 1800, rescanEveryS: 30 };

function deps(over: Partial<MonitorDeps>): MonitorDeps {
  return { outboxText: "", outboxFullText: "", outboxSize: 0, outboxMtime: 0, phase: "working",
    now: 1000, nowIso: "T", thresholds: TH, ...over };
}

describe("rehearsalMonitor", () => {
  it("initScanState fresh start skips all prior events (offset = EOF)", () => {
    const full = '{"event":"done","summary":"x"}\n';
    const s = initScanState(Buffer.byteLength(full), full, null, null);
    expect(s.offset).toBe(Buffer.byteLength(full));
    // pre-seed marks the existing done as already-emitted
    expect(s.rescanEmitted.has("1\tdone")).toBe(true);
  });

  it("initScanState honors a valid persisted cursor <= size", () => {
    expect(initScanState(100, "", "40", null).offset).toBe(40);
    expect(initScanState(100, "", "400", null).offset).toBe(100); // overshoot -> EOF
    expect(initScanState(100, "", "junk", null).offset).toBe(100);
  });

  it("byte-tail emits done/error/question/heartbeat for new lines, advances offset", () => {
    const newText = '{"event":"progress","summary":"p"}\n{"event":"done","summary":"finished"}\n';
    const s: MonitorScanState = { offset: 0, rescanEmitted: new Set(), lastStaleTs: 0, lastStuckTs: 0, lastRescan: 0 };
    const r = monitorScan("/o", "viola", s, deps({ outboxText: newText, outboxFullText: newText,
      outboxSize: Buffer.byteLength(newText), phase: "idle" }));  // idle -> no stale/stuck
    const evs = r.notifications.map((n) => n.event);
    expect(evs).toContain("done");
    expect(evs).not.toContain("progress");   // progress is NOT emitted
    expect(r.notifications.find((n) => n.event === "done")!.part).toBe("viola"); // 'part', not 'trooper'
    expect(r.state.offset).toBe(Buffer.byteLength(newText));
  });

  it("stuck fires before stale and is mutually exclusive when working + mtime very old", () => {
    const s: MonitorScanState = { offset: 0, rescanEmitted: new Set(), lastStaleTs: 0, lastStuckTs: 0, lastRescan: 0 };
    const r = monitorScan("/o", "viola", s, deps({ now: 100000, outboxMtime: 100000 - 2000 })); // delta 2000 >= stuckS
    const evs = r.notifications.map((n) => n.event);
    expect(evs).toContain("stuck");
    expect(evs).not.toContain("stale");
    expect(r.state.lastStuckTs).toBe(100000);
  });

  it("stale fires when delta in [probeS, stuckS)", () => {
    const s: MonitorScanState = { offset: 0, rescanEmitted: new Set(), lastStaleTs: 0, lastStuckTs: 0, lastRescan: 0 };
    const r = monitorScan("/o", "viola", s, deps({ now: 100000, outboxMtime: 100000 - 1000 })); // 900<=1000<1800
    expect(r.notifications.map((n) => n.event)).toContain("stale");
  });

  it("no stale/stuck when phase != working", () => {
    const s: MonitorScanState = { offset: 0, rescanEmitted: new Set(), lastStaleTs: 0, lastStuckTs: 0, lastRescan: 0 };
    const r = monitorScan("/o", "viola", s, deps({ now: 100000, outboxMtime: 0, phase: "idle" }));
    expect(r.notifications).toHaveLength(0);
  });

  it("stale is rate-limited by probeS across scans", () => {
    let s: MonitorScanState = { offset: 0, rescanEmitted: new Set(), lastStaleTs: 0, lastStuckTs: 0, lastRescan: 0 };
    s = monitorScan("/o", "v", s, deps({ now: 100000, outboxMtime: 99000 })).state; // fires, lastStaleTs=100000
    const r2 = monitorScan("/o", "v", s, deps({ now: 100100, outboxMtime: 99000 }));  // 100100-100000=100 < 900
    expect(r2.notifications.map((n) => n.event)).not.toContain("stale");
  });

  it("rescan emits a terminal event missed by the tail, deduped by line+event, with ' (rescan)'", () => {
    const full = '{"event":"progress","summary":"p"}\n{"event":"error","summary":"boom"}\n';
    const s: MonitorScanState = { offset: Buffer.byteLength(full), rescanEmitted: new Set(),
      lastStaleTs: 0, lastStuckTs: 0, lastRescan: 0 };
    const r = monitorScan("/o", "v", s, deps({ outboxText: "", outboxFullText: full,
      outboxSize: Buffer.byteLength(full), phase: "idle", now: 1000 }));   // lastRescan 0, now 1000 -> rescan runs
    const err = r.notifications.find((n) => n.event === "error");
    expect(err).toBeDefined();
    expect(err!.summary).toMatch(/ \(rescan\)$/);
    expect(r.state.rescanEmitted.has("2\terror")).toBe(true);
    // second scan: same line not re-emitted
    const r2 = monitorScan("/o", "v", r.state, deps({ outboxFullText: full, outboxSize: Buffer.byteLength(full),
      phase: "idle", now: 1000 + TH.rescanEveryS }));
    expect(r2.notifications.find((n) => n.event === "error")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure.** → FAIL.

- [ ] **Step 3: Implement `src/core/rehearsalMonitor.ts`:**

```ts
// Liveness state machine for /consort:rehearsal monitor. Faithful to
// deep-research-monitor.sh: byte-tail event emit (A), phase-gate stale/stuck (B),
// periodic whole-outbox rescan dedup (C). Pure single-scan; the verb (C7) owns the
// loop + persistence. Byte offsets are BYTES (Buffer.byteLength), never char counts.

export interface MonitorScanState {
  offset: number;                 // byte cursor into the outbox
  rescanEmitted: Set<string>;     // "<lineNum>\t<event>" dedup keys (1-based line num)
  lastStaleTs: number;            // epoch seconds (0 = never)
  lastStuckTs: number;
  lastRescan: number;
}

export interface MonitorNotification { part: string; event: string; summary: string; ts: string; }

export interface MonitorScanResult { notifications: MonitorNotification[]; state: MonitorScanState; }

export interface MonitorDeps {
  outboxText: string;       // NEW bytes since state.offset (caller slices [offset, size))
  outboxFullText: string;   // whole outbox (for the rescan pass)
  outboxSize: number;       // current byte size
  outboxMtime: number;      // epoch seconds, 0 if missing
  phase: string;            // parseState(state.txt).phase ?? ""
  now: number;              // epoch seconds
  nowIso: string;           // ISO-8601 UTC Z
  thresholds: { probeS: number; stuckS: number; rescanEveryS: number };
}

const TAIL_EVENTS = new Set(["done", "error", "question", "heartbeat"]);
const RESCAN_EVENTS = new Set(["done", "error", "question"]);

function eventOf(line: string): { event?: string; summary?: string } {
  try { const o = JSON.parse(line) as { event?: string; summary?: string }; return o; } catch { return {}; }
}

/** Cursor-restore + pre-seed (bash L42-88). Honors a valid persisted cursor (<= size), else EOF.
 *  Pre-seeds the rescan dedup set with every terminal event already below the restored cursor. */
export function initScanState(
  size: number, fullText: string, persistedCursor: string | null, persistedRescan: string | null,
): MonitorScanState {
  const c = persistedCursor?.replace(/\s+/g, "") ?? "";
  const offset = /^[0-9]+$/.test(c) && Number(c) <= size ? Number(c) : size;
  const rescanEmitted = new Set<string>(persistedRescan ? persistedRescan.split("\n").filter(Boolean) : []);
  if (offset > 0) {
    let bytesSeen = 0, lineNum = 0;
    for (const line of fullText.split("\n")) {
      if (bytesSeen >= offset) break;
      lineNum++;
      bytesSeen += Buffer.byteLength(line) + 1;            // +1 for the stripped newline
      const ev = eventOf(line).event;
      if (ev && RESCAN_EVENTS.has(ev)) rescanEmitted.add(`${lineNum}\t${ev}`);
    }
  }
  return { offset, rescanEmitted, lastStaleTs: 0, lastStuckTs: 0, lastRescan: 0 };
}

/** One liveness scan. Pure given deps + state; never sleeps (the verb owns cadence). */
export function monitorScan(_outboxPath: string, part: string, prev: MonitorScanState, d: MonitorDeps): MonitorScanResult {
  const notifications: MonitorNotification[] = [];
  const emit = (event: string, summary: string): void => { notifications.push({ part, event, summary, ts: d.nowIso }); };
  const state: MonitorScanState = { ...prev, rescanEmitted: new Set(prev.rescanEmitted) };

  // (A) byte-tail forward new lines
  if (d.outboxSize > state.offset && d.outboxText) {
    for (const line of d.outboxText.split("\n")) {
      if (!line) continue;
      const { event, summary } = eventOf(line);
      if (event && TAIL_EVENTS.has(event)) emit(event, summary ?? "");
    }
    state.offset = d.outboxSize;
  }

  // (B) phase-gate stale/stuck (only when working; stuck before stale; mutually exclusive)
  if (d.phase === "working" && d.outboxMtime > 0) {
    const delta = d.now - d.outboxMtime;
    if (delta >= d.thresholds.stuckS && d.now - state.lastStuckTs >= d.thresholds.stuckS) {
      emit("stuck", `outbox mtime ${delta}s old (>= ${d.thresholds.stuckS}s threshold)`);
      state.lastStuckTs = d.now;
    } else if (delta >= d.thresholds.probeS && d.now - state.lastStaleTs >= d.thresholds.probeS) {
      emit("stale", `outbox mtime ${delta}s old (>= ${d.thresholds.probeS}s threshold)`);
      state.lastStaleTs = d.now;
    }
  }

  // (C) periodic whole-outbox rescan safety net
  if (d.now - state.lastRescan >= d.thresholds.rescanEveryS && d.outboxFullText) {
    let lineNum = 0;
    for (const line of d.outboxFullText.split("\n")) {
      if (!line) { lineNum++; continue; }
      lineNum++;
      const { event, summary } = eventOf(line);
      if (event && RESCAN_EVENTS.has(event)) {
        const key = `${lineNum}\t${event}`;
        if (!state.rescanEmitted.has(key)) { emit(event, `${summary ?? ""} (rescan)`); state.rescanEmitted.add(key); }
      }
    }
    state.lastRescan = d.now;
  }

  return { notifications, state };
}
```

> **Line-number parity note:** the bash counts `read`-stripped lines (no trailing empty token). `"a\nb\n".split("\n")` yields `["a","b",""]`; the trailing `""` must not consume a real line number for a terminal event (it never matches `RESCAN_EVENTS`, so the `{ lineNum++; continue; }` on empty keeps numbering aligned). The implementer must verify the rescan line numbers match the bash on a fixture with a trailing newline.

- [ ] **Step 4: Run to verify pass.** → PASS. typecheck 0, lint clean.

- [ ] **Step 5: Commit.** `git add src/core/rehearsalMonitor.ts tests/rehearsal-core.test.ts && git commit -m "feat(rehearsal): monitor liveness state machine (byte-tail/stale-stuck/rescan)"`

---

## Task C7: `monitor` verb

**Files:**
- Modify: `src/commands/rehearsal.ts` (add `monitorRun` + `run()` case)
- Test: `tests/rehearsal-cmd.test.ts`

Arg: `<topic> <instrument>` (2 positionals; rc 2 on wrong count or missing art dir). Optional `--once` (single scan then exit; for tests/dogfood). Resolve `model` → `outboxPath`; cursor/rescan files under `partStateDir(art, instrument)`. Load persisted cursor+rescan → `initScanState`; loop `{read outbox slice + full + mtime; phase from state.txt; monitorScan; print each notification as a JSON line to stdout; persist cursor (no trailing newline) + rescan set; if --once break else sleep 2}`. The in-memory clocks (`lastStale/Stuck/Rescan`) persist across loop iterations within the long-lived process; cursor+rescan persist to disk for restart-survival.

- [ ] **Step 1: Write failing tests.** Drive `--once`. Scaffold a topic + part under `freshHome()`; spawn-dir + `pane.json`/`outbox.jsonl` so `resolveModel` finds the model; write a `state.txt` with `phase=working` + an outbox with a `done` line newer than the cursor. Run `monitorRun(["topic","viola","--once"], {opts})`; capture stdout; assert a `{"part":"viola","event":"done",...}` line printed and `liveness-cursor.txt` written under `partStateDir`. Assert `monitorRun([])` → rc 2; missing art dir → rc 2.

- [ ] **Step 2: Run to verify failure.** → FAIL.

- [ ] **Step 3: Implement.** Add `monitorRun(args, opts?)` to `src/commands/rehearsal.ts`. Resolve model via the shared `resolveModel` (from C3). Read the outbox slice `[offset,size)` (reuse `outboxOffset` + a byte-range read — either export `readFrom` from `ipc.ts` or read the whole file and `Buffer.from(...).subarray(offset)`). `phase` via `parseState(readFileSync(state.txt)).phase`. Persist cursor with `writeFileSync(cursorPath, String(offset))` (no newline) and the rescan set as `\n`-joined keys. `--once` → one scan; default → `while (true) { scan; await sleep(2000); }`. The `run()` case: `case "monitor": return monitorRun(rest);`

- [ ] **Step 4: Run to verify pass.** → PASS. typecheck 0, lint clean.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(rehearsal): monitor verb (per-part liveness scan loop + cursor persistence)"`

---

## Task C8: `core/rehearsalBrief.ts` + `status-brief` verb

**Files:**
- Create: `src/core/rehearsalBrief.ts`
- Modify: `src/commands/rehearsal.ts` (add `statusBriefWith` + `run()` case)
- Test: `tests/rehearsal-core.test.ts` (pure) + `tests/rehearsal-cmd.test.ts` (verb)

Port `cw_deep_research_status_brief`. Pure `buildStatusBrief(input)` renders: a header (`## Experiment status — <exp> (<instrument>) just landed` with latest args, else `## Experiment status`), a per-part table `| Part | Phase | Current/last | Approach | Metric |` (working part → metric `(running)`), a `**Scoreboard top 3:**` section (rows `<rank>. <instrument>/<exp> — <metric> — <metric_name>`; empty → `_(no scored experiments yet)_`; absent file → `_(scoreboard absent)_`), and a `**Completion check:** <floor_met=… target_met=… …>` line. The verb `statusBriefWith(topic, {latestInstrument?, latestExp?})` reads the parts + scoreboard.md + metric.md, runs `checkCompletion`, prints the brief to stdout.

- [ ] **Step 1: Write failing tests.** Pure: `buildStatusBrief` with/without latest args; empty parts; a working part → `(running)`; scoreboard absent vs present (top-3); completion line. Assert table header is `| Part |` (not `| Trooper |`). Verb: scaffold a topic with a scoreboard + parts; assert the printed brief contains the header, table, top-3, and completion line.

- [ ] **Step 2: Run to verify failure.** → FAIL.

- [ ] **Step 3: Implement** `buildStatusBrief` (pure, takes injected part rows + scoreboard text + completion result) and `statusBriefWith` (FS shell: read parts' state.txt + each part's current/last approach from `prompt.md`'s `Approach label:` line or the latest result.json, read scoreboard.md, run `checkCompletion(scoreboardMd, metricMd)`). The frozen formats are in the §7 spec + reader 4 `frozen` block. `run()` case: `case "status-brief": return statusBriefWith(rest, liveStatusBriefDeps);`

- [ ] **Step 4: Run to verify pass.** → PASS. typecheck 0, lint clean, stale-tokens green.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(rehearsal): status-brief render + verb"`

---

## Task C9: `commands/rehearsal.md` — Phase 4 + inline loop + decision policy

**Files:**
- Modify: `commands/rehearsal.md` (append Phase 4 + the inline loop + decision policy after the existing Phases 0–3)

Port `deep-research.md` Phase 4 + the `deep-research-resume.md` handler, **inlined** like score/perform (no resume file, no hook). **No unit test** (directive) — verified by the spec reviewer against the frozen prose + by the C10 dogfood.

The **biggest trap**: clone-wars ENDS the turn at Step 8 and waits for an external trigger. Consort must NOT — Step 8 is the **loop tail** (go to Step 1). The loop BLOCKS in-process for the next part event (the inline analog of waiting for a Monitor notification).

- [ ] **Step 1: Author Phase 4 (runs ONCE, before the loop):**
  1. Seed per-part state: `state.txt` `exp_counter=0 phase=idle current_exp_id= last_event=spawn`; `mkdir` each part's `experiments/`. (`parts.txt` already written by `spawn-all`.)
  2. Start ONE persistent **Monitor** task per part → command `consort rehearsal monitor <topic> <instrument>`, `persistent: true`; append each task ID to `monitor-tasks.txt` (one per line).
  3. Write initial `session-summary.md`; append `## Current direction` (1–3 sentences) + `## Recent decisions`.
  4. First dispatch round — **parallel** (one Bash call per part, one message): `consort rehearsal experiment-send <topic> <instrument> exp-001 <approach-label> <direction>`.
  5. `consort rehearsal status-brief <topic>` (generic header) → print verbatim.
  6. ENTER THE LOOP (do NOT end the turn).

- [ ] **Step 2: Author the inline loop (Steps 1–8, repeat until Step 2 or Step 4 stops):**
  1. Read baseline (`scoreboard.md`, each `state.txt`, `halt.flag` existence, `time-budget.txt`+`session-start.txt`); **BLOCK** on the next part `done`/`error`/`question` (the Monitor notifications drive re-entry).
  2. Hard-cap: `halt.flag` exists OR `consort rehearsal` time-budget elapsed → finalize (Phase D verb; for now build final scoreboard/consensus) + **TaskStop** every `monitor-tasks.txt` ID → jump to Phase 5. EXIT LOOP.
  3a. Route the event: `done`/`error` → `consort rehearsal score <topic>` (set `RAN_SCORE=1`, record `LAST_INSTRUMENT`/`LAST_EXP`); also clear a recovered part's `probe_sent_ts`. `question` → surface to user, set `phase=blocked`, do NOT auto-dispatch. `stale` → `send status?` probe, `phase=stale`, `probe_sent_ts=now` (debounce). `stuck` → Maestro judgment (abort pane / extend). `heartbeat` → bump `last_event_ts`, clear `probe_sent_ts`.
  3b. If `RAN_SCORE`: `consort rehearsal status-brief <topic> --latest-instrument <I> --latest-exp <E>` ONCE → print verbatim.
  4. `consort rehearsal` completion check → apply the **decision policy** (Step 3 below). If stop → write `halt.flag` with reason, jump to Step 2.
  5. Dispatch round (**NEVER STOP HERE**): for each `phase=idle` part with no `halt.flag` — run the **Lane-D abandon** check first; else compose a ~50-token direction and `experiment-send <topic> <instrument> exp-NNN <label> <direction>`.
  6. Handle a user message (halt / change-direction / extend-budget / conversational); out-of-band `halt.flag` is also caught by Step 2.
  7. Re-render `session-summary.md` (atomic); Maestro fills `## Current direction` + `## Recent decisions`.
  8. **LOOP TAIL** → go to Step 1.

- [ ] **Step 3: Embed the FROZEN decision-policy prose verbatim:**

```
Decision policy (apply at Step 4):
  Hard rules (no judgment):
  - floor_met=no AND no hard cap -> keep going.
  - hard_cap=yes OR halt.flag present -> stop (go to Step 2).
  Soft rules (Maestro judgment, default-stop, override allowed):
  - All of floor + target + K satisfied -> default stop. Override if variance looks
    suspicious or the user asked to keep exploring.
  - Floor met + plateau detected + target not met -> default stop. Override to pivot
    direction or request user input.
  If decision = stop, touch halt.flag with reason text, then jump to Step 2.

NEVER STOP the loop at Step 5. If at least one part has phase=idle and no halt.flag exists,
dispatch the next experiment — do not pause to ask "should I continue?" or "is this a good
stopping point?". Stop conditions are owned by Step 2 (halt.flag / time budget) and Step 4
(completion check). If results look thin: rotate the approach mix, escalate via a question,
or document the concern in session-summary.md Recent decisions — and dispatch.

Lane-D abandon (per part, at Step 5 — ALL THREE must hold):
  1. >= 3 completed (status=ok) experiments for this part;
  2. NONE of this part's LAST 3 experiments scored >= min_acceptable;
  3. this part's best metric >= 5 x plateau_threshold BELOW the current overall leader.
  -> transition phase=abandoned + lane_abandon_reason + lane_abandon_ts; skip dispatch;
     surface in chat. (experiment-send refuses an abandoned lane with rc 2.)
```

- [ ] **Step 4: Verify the directive invocations match the verbs.** Cross-check every `consort rehearsal <verb> …` invocation against the implemented `run()` cases + signatures. `npm run test -- stale-tokens` → PASS (commands/ is scanned — no `trooper`/`commander`/`yoda`/`MISSION ACCOMPLISHED`).

- [ ] **Step 5: Commit.** `git add commands/rehearsal.md && git commit -m "feat(rehearsal): rehearsal.md Phase 4 + inline experiment loop + decision policy"`

---

## Task C10: Simulated-parts dogfood + dist rebuild + gates

**Files:**
- Modify: `docs/superpowers/DOGFOOD.md` (append a Phase C entry)
- Rebuild: `dist/consort.cjs`

Per spec §8 Phase C dogfood: "simulated parts → a few rounds → score → completion → stop." codex directory-trust blocks live spawns, so simulate the parts. The dogfood drives the **real CLI verbs** across rounds; finalize/synthesis/teardown are Phase D, so stop at the completion/stop boundary (`halt.flag` written).

- [ ] **Step 1: Build a simulated-parts script** under a fresh `CONSORT_HOME`: `init` a topic → `metric` (set floor + target + K) → scaffold N part state dirs + standard part dirs (with `outbox.jsonl`) → for each round: `experiment-send` (assert `prompt.md`/`inbox.md`/state transition) → simulate the part (write a `result.json` to the branch dir + append a `done` event to the part outbox) → `score` (assert scoreboard sort + `results.tsv` + race-guarded phase clear) → `status-brief` → run the completion math. Cover **two stop paths**: (a) floor → then floor+target+K → default stop; (b) a separate plateau-stop run (floor met, no target, last-window plateau). Also exercise `monitor --once` over a simulated outbox and assert a `{"part":...}` notification line.

- [ ] **Step 2: Run the dogfood end-to-end.** Capture the assertions (aim for a clean N/N like Phase B's 30/30). Fix any divergence in the verbs (fold back to the relevant task's commit).

- [ ] **Step 3: Full gates.**
  - `npm run test` (full suite) → all green.
  - `npm run typecheck` → 0.
  - `npm run lint` → clean.
  - `npm run test -- stale-tokens` → 7/7.

- [ ] **Step 4: Rebuild + verify dist determinism.** `npm run build` → `git diff --stat dist/consort.cjs` (expect a real change vs the Phase B dist), then `npm run build` again → `git diff --quiet dist/consort.cjs` (no diff on re-build). Smoke-test a verb from the bundle: `node dist/consort.cjs rehearsal score` (expect the usage rc-2 message).

- [ ] **Step 5: Commit.** `git add docs/superpowers/DOGFOOD.md dist/consort.cjs && git commit -m "test(rehearsal): Phase C simulated-parts loop dogfood + dist rebuild"`

---

## Final review (after all tasks)

Dispatch a final holistic reviewer across the whole Phase C diff:
- **Faithfulness:** experiment-send phase-gate (3 outcomes), inbox-write path (inboxWrite direct + best-effort nudge), score race-guard (per-part current_exp_id, not peer-driven), monitor three-pass + byte offsets + clock persistence, the frozen decision-policy prose + Lane-D math + NEVER-STOP banner, the inline-loop turn-model (Step 8 = loop tail, NOT turn end).
- **Rebrand:** `"part"` notification key, `instrument` TSV header, `| Part |` table headers, template fully rebranded — stale-tokens green.
- **Gates:** full suite green, typecheck 0, lint clean, dist deterministic, the `rehearsal` verbs dispatch from `dist/consort.cjs`.
- **Carry-forward to Phase D:** the loop's Step 2 calls a `finalize` verb and Phase 5/6/6b/6c/7 — all Phase D. Note any seams (e.g. `monitor`'s long-running `run()` exercised only via `--once` in tests; the live persistent-Monitor path is a Phase D full-dogfood concern).

Then proceed to Phase D (the tail) only on the user's go.

---

## Self-review (plan author)

- **Spec coverage:** experiment-send (§8 C, §5 Phase 4) → C1+C2+C3; score (§7, §8 C) → C4+C5; monitor (§8 C) → C6+C7; status-brief (§5 Phase 4/loop) → C8; rehearsal.md Phase 4 + loop + decision policy (§5, §6) → C9; dogfood (§10) → C10. ✓
- **Frozen formats:** result.json schema (template C2 + validateResult reuse), scoreboard (buildScoreboard reuse), results.tsv 7-col (C4), done/heartbeat/question events (template + monitor), decision-policy prose + Lane-D + NEVER-STOP (C9 verbatim), halt.flag (readHaltFlag reuse). ✓
- **Rebrand:** `"part"` key (C6), `instrument` TSV header (C4), `| Part |` (C6 peers / C8 brief / C2 template), template scanned (C2). ✓
- **Type consistency:** `MonitorScanState`/`MonitorDeps`/`ScoreFs`/`ScoreComputation`/`PromptFields`/`PeerRow` defined once (C1/C4/C6) and reused by their verbs (C3/C5/C7). ✓
- **No placeholders:** every code step has real code or an explicit faithful-port instruction with the bash citation. ✓
```
