// Experiment-send pure logic for /ap:autoresearch. Faithful to
// deep-research-experiment-send.sh (template render, sota/hardware/peers block
// assembly, dispatch state transition). Pure; FS/subprocess happen in the verb.
import { mergeState } from "./autoresearchState.js";

/** Expanded one-variable operator set. Each operator carries a single variable and resolves
 *  through the unchanged parent/knob lineage classification (see autoresearchLineage.ts) — the
 *  label is carried on the dispatch, not derived here. */
export const OPERATORS = ["draft", "improve", "debug", "ablate", "replicate", "crossover", "literature-refresh"] as const;
export function isOperator(s: string): boolean {
  return (OPERATORS as readonly string[]).includes(s);
}

/** ^exp-[0-9]+$ — 1+ digit experiment id (bash experiment-send.sh:61). */
export const EXP_ID_RE = /^exp-[0-9]+$/;
/** ^[a-z][a-z0-9-]*$ — agent name (bash experiment-send.sh:64). */
export const AGENT_RE = /^[a-z][a-z0-9-]*$/;

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

/** Render the experiment template by literal token substitution (split/join is literal —
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
 *  below half baseline (raw-ratio gate: cur < base*0.5). X is the truncated drop percentage,
 *  matching the bash awk `int(...)`. "" when no baseline or no qualifying drop. */
export function hardwareDiffAlert(baseline: string | null, current: string): string {
  const base = parseGpus(baseline);
  const cur = parseGpus(current);
  const out: string[] = [];
  for (const [name, b] of base) {
    const c = cur.get(name);
    if (!c || !(b.free > 0) || !(c.free < b.free * 0.5)) continue;
    const dropPct = Math.trunc((1 - c.free / b.free) * 100);
    out.push(`ALERT: gpu '${name}' memory.free ${b.free} -> ${c.free} MiB (-${dropPct}%)`);
  }
  return out.join("\n");
}

export interface PeerRow {
  agent: string; phase: string; currentExp: string;
  approach: string; metric: string; status: string; notes: string;
}

/** "## Peers" markdown section (one row per peer, self excluded by the caller). "" when no peers.
 *  Faithful to the bash format-peers-block helper; table header is the rebranded Worker column. */
export function formatPeersBlock(peers: PeerRow[]): string {
  if (peers.length === 0) return "";
  const lines = [
    "## Peers",
    "",
    "Other workers are exploring this objective in parallel. Diverge from their approaches —",
    "do not duplicate a pipeline a peer is already running. Use their results to decide where",
    "the unexplored, promising region of the design space is.",
    "",
    "| Worker | Phase | Current/last | Approach | Best metric | Notes |",
    "|---|---|---|---|---|---|",
  ];
  for (const p of peers) {
    const metric = p.metric === "" ? "" : (p.status ? `${p.metric} (${p.status})` : p.metric);
    const flat = p.notes.replace(/\s+/g, " ").trim();
    const notes = flat.length > 80 ? flat.slice(0, 77) + "..." : flat;
    lines.push(`| ${p.agent} | ${p.phase} | ${p.currentExp} | ${p.approach} | ${metric} | ${notes} |`);
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

/** Next dispatch id from the reconstructible counter rule: max(state.txt
 *  exp_counter, the ledger's highest intent number for the agent) + 1 —
 *  a crash that lost the state bump can never cause an exp-id reuse. */
export function nextExpId(stateText: string | null, ledgerIntentMax: number): string {
  const prev = stateText?.split("\n").find((l) => l.startsWith("exp_counter="))?.slice("exp_counter=".length) ?? "";
  const n = /^[0-9]+$/.test(prev.trim()) ? parseInt(prev, 10) : 0;
  return `exp-${String(Math.max(n, ledgerIntentMax) + 1).padStart(3, "0")}`;
}
