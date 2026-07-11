// Campaign event ledger for /ap:autoresearch (campaign spine, phase A).
//
// Append-only JSONL at <art>/campaign-ledger.jsonl: every dispatch intent,
// delivery, completion, and controller transition is one event line, so a
// crashed hub can replay the campaign deterministically. The event kinds are
// a NEW vocabulary deliberately OUTSIDE the frozen wire protocol (ready/ack/
// progress/done/error/question are untouched). The idempotency key of an
// experiment is (topic, agent, exp_id); topic is implicit (one ledger per art
// dir), so maps key by "<agent>/<exp_id>" — the same composite the
// verification/inspection paths use.
//
// PURE: no fs/clock. The CLI does the IO (single-line appendFileSync, the
// same durability idiom as designTurn's recordWaitOutcome appends;
// controller.gen goes through atomicWrite).

import { join } from "node:path";

export type LedgerEventKind =
  | "campaign-init" | "dispatch-intent" | "dispatch-delivered" | "result-recorded"
  | "verify-recorded" | "budget-debit" | "stop-decision" // reserved: no shipped writer in phase A
  | "resume" | "fresh-worker-respawn" | "interrupted";

const KINDS: readonly string[] = [
  "campaign-init", "dispatch-intent", "dispatch-delivered", "result-recorded",
  "verify-recorded", "budget-debit", "stop-decision",
  "resume", "fresh-worker-respawn", "interrupted",
];

export interface LedgerEvent {
  seq: number;
  gen: number;
  ts: string;
  kind: LedgerEventKind;
  agent?: string;
  exp_id?: string;
  data?: Record<string, unknown>;
}

/** <art>/campaign-ledger.jsonl — the append-only campaign event ledger. */
export function ledgerPath(art: string): string {
  return join(art, "campaign-ledger.jsonl");
}

/** <art>/controller.gen — the fenced controller-generation KV (atomicWrite). */
export function controllerGenPath(art: string): string {
  return join(art, "controller.gen");
}

/** Tolerant line parse: skip non-JSON lines and lines without an integer seq/gen
 *  or a known kind (a torn append or manual edit must never crash a replay). */
export function parseLedger(text: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: unknown;
    try { o = JSON.parse(t); } catch { continue; }
    const e = o as LedgerEvent;
    if (!Number.isInteger(e.seq) || !Number.isInteger(e.gen)) continue;
    if (typeof e.kind !== "string" || !KINDS.includes(e.kind)) continue;
    out.push(e);
  }
  return out;
}

/** The ledger's controller generation: highest campaign-init/resume gen (0 when none). */
function controllerGenOf(events: LedgerEvent[]): number {
  let g = 0;
  for (const e of events) if ((e.kind === "campaign-init" || e.kind === "resume") && e.gen > g) g = e.gen;
  return g;
}

/** Mint the next event line to append. seq = last valid seq + 1 (1 on empty);
 *  throws on a gen below the ledger's controller gen (fencing — a stale writer
 *  must fail LOUDLY, never silently clobber). Returns one JSONL line + "\n". */
export function appendEvent(prevText: string, ev: Omit<LedgerEvent, "seq">): string {
  const events = parseLedger(prevText);
  const controllerGen = controllerGenOf(events);
  if (ev.gen < controllerGen) {
    throw new Error(`autoresearchLedger: stale gen ${ev.gen} < controller gen ${controllerGen}`);
  }
  const lastSeq = events.length ? events[events.length - 1].seq : 0;
  return JSON.stringify({ seq: lastSeq + 1, ...ev }) + "\n";
}

export interface LedgerIntent {
  agent: string;
  expId: string;
  delivered: boolean;
  outboxOffset?: number;
  operator?: string;
}

export interface LedgerReplay {
  lastSeq: number;
  gen: number;                          // highest campaign-init/resume gen (0 when none)
  intents: Map<string, LedgerIntent>;   // key "<agent>/<exp_id>"
  completionOrder: string[];            // "<agent>/<exp_id>" in result-recorded seq order (deduped)
  counters: Map<string, number>;        // agent -> highest numeric exp id among its intents
  lastDeliveredOffset: Map<string, number>; // agent -> outboxOffset of its LAST delivered event
}

const EXP_NUM = /^exp-([0-9]+)$/;

/** The shared replay reducer every consumer uses (dispatch counter rule, resume
 *  reconciliation, plateau chronology). Pure fold over parseLedger(text). */
export function replayLedger(text: string): LedgerReplay {
  const events = parseLedger(text);
  const intents = new Map<string, LedgerIntent>();
  const completionOrder: string[] = [];
  const counters = new Map<string, number>();
  const lastDeliveredOffset = new Map<string, number>();
  const completed = new Set<string>();

  for (const e of events) {
    const key = e.agent && e.exp_id ? `${e.agent}/${e.exp_id}` : null;
    if (e.kind === "dispatch-intent" && key && e.agent && e.exp_id) {
      const operator = typeof e.data?.operator === "string" ? (e.data.operator as string) : undefined;
      if (!intents.has(key)) intents.set(key, { agent: e.agent, expId: e.exp_id, delivered: false, operator });
      const m = EXP_NUM.exec(e.exp_id);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > (counters.get(e.agent) ?? 0)) counters.set(e.agent, n);
      }
    } else if (e.kind === "dispatch-delivered" && key && e.agent && e.exp_id) {
      const it = intents.get(key) ?? { agent: e.agent, expId: e.exp_id, delivered: false };
      it.delivered = true;
      const off = e.data?.outboxOffset;
      if (typeof off === "number") { it.outboxOffset = off; lastDeliveredOffset.set(e.agent, off); }
      intents.set(key, it);
    } else if (e.kind === "result-recorded" && key) {
      if (!completed.has(key)) { completed.add(key); completionOrder.push(key); }
    }
  }

  return {
    lastSeq: events.length ? events[events.length - 1].seq : 0,
    gen: controllerGenOf(events),
    intents, completionOrder, counters, lastDeliveredOffset,
  };
}

/** Parse controller.gen KV. gen 0 when absent/garbled (caller treats 0 as "no lease"). */
export function readGen(text: string | null): { gen: number; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  if (text !== null) {
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  const g = fields.gen ?? "";
  return { gen: /^[0-9]+$/.test(g.trim()) ? parseInt(g, 10) : 0, fields };
}

/** Render controller.gen KV (written via atomicWrite by the verbs). */
export function renderGen(gen: number, acquiredTs: string, holder: string): string {
  return `gen=${gen}\nacquired_ts=${acquiredTs}\nholder=${holder}\n`;
}
