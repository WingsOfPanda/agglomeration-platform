import { statSync, readFileSync, existsSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { workerDir, topicDir, pluginRoot } from "./paths.js";
import { atomicWrite } from "./atomic.js";
import { isoUtc } from "./archive.js";
import { readIfExists } from "./fsread.js";

export function inboxPath(i: string, m: string, t: string) { return join(workerDir(i, m, t), "inbox.md"); }
export function outboxPath(i: string, m: string, t: string) { return join(workerDir(i, m, t), "outbox.jsonl"); }
export function identityPath(i: string, m: string, t: string) { return join(workerDir(i, m, t), "identity.md"); }
export function statusPath(i: string, m: string, t: string) { return join(workerDir(i, m, t), "status.json"); }
export function paneMetaPath(i: string, m: string, t: string) { return join(workerDir(i, m, t), "pane.json"); }

/** The worker's status.json state when it is NOT idle (a turn/round still in flight), else null
 *  (absent/unreadable status, no state field, empty state, or idle). Uses the frozen non-JSON-
 *  tolerant regex read — never JSON.parse — matching the send-before-dispatch idle gate. */
export function workerBusyState(i: string, m: string, t: string): string | null {
  const sp = statusPath(i, m, t);
  if (!existsSync(sp)) return null;
  const match = readFileSync(sp, "utf8").match(/"state":"([^"]*)"/);
  return match && match[1] && match[1] !== "idle" ? match[1] : null;
}

const SENDER_RE = /^[a-zA-Z0-9_-]+$/;

export function inboxWrite(i: string, m: string, t: string, task: string, opts?: { from?: string; noDoneInstruction?: boolean }): void {
  const from = opts?.from ?? "hub";
  if (!SENDER_RE.test(from)) throw new Error(`inboxWrite: invalid sender name '${from}' (allowed: [a-zA-Z0-9_-])`);
  const outbox = outboxPath(i, m, t);
  // When the task body already specifies its own done-event contract (e.g. the autoresearch experiment
  // template's `summary="experiment exp-NNN metric=… status=…"`), the caller passes noDoneInstruction
  // to suppress this generic one — otherwise the worker receives two conflicting done instructions and
  // the loop's exp-NNN derivation can read the wrong summary.
  const doneInstruction = opts?.noDoneInstruction
    ? ""
    : `When done, append a single JSONL line to ${outbox}:\n\n` +
      '`{"event":"done","summary":"<one-line summary>","ts":"<iso-timestamp>"}`\n\n';
  const body = `From: ${from}\n\n${task}\n\n${doneInstruction}END_OF_INSTRUCTION\n`;
  atomicWrite(inboxPath(i, m, t), body);
}

export function identityWrite(i: string, m: string, t: string): void {
  const root = pluginRoot();
  const tplPath = join(root, "config", "prompt-templates", "identity.md");
  if (!existsSync(tplPath)) {
    throw new Error(
      `identityWrite: identity template not found at ${tplPath} (resolved pluginRoot=${root}). ` +
      `Set CLAUDE_PLUGIN_ROOT to the ap plugin directory, or run ap from it.`,
    );
  }
  const stateDir = workerDir(i, m, t);
  const outbox = outboxPath(i, m, t);
  let body = readFileSync(tplPath, "utf8")
    .replaceAll("{{agent}}", i)
    .replaceAll("{{model}}", m)
    .replaceAll("{{topic}}", t)
    .replaceAll("{{state_dir}}", stateDir);
  body += `\n\n---\n\n**First action (do this immediately, then wait):**\n\n` +
    `Append exactly ONE JSONL line to ${outbox}. The line MUST be:\n\n` +
    '`{"event":"ready","ts":"<ISO-8601 UTC>","agent":"' + i + '","model":"' + m + '"}`\n\n' +
    `Generate the timestamp at the moment you emit. Use this shell command verbatim:\n\n` +
    '`echo "{\\"event\\":\\"ready\\",\\"ts\\":\\"$(date -u +' + "'%Y-%m-%dT%H:%M:%SZ'" + ')\\",\\"agent\\":\\"' + i + '\\",\\"model\\":\\"' + m + '\\"}" >> ' + outbox + '`\n\n' +
    `Then stop and wait. I will send another instruction asking you to read your inbox.\n`;
  atomicWrite(identityPath(i, m, t), body);
}

export interface OutboxEvent { event: string; ts?: string; [k: string]: unknown; }

/** Parse one outbox JSONL line into a typed event, or null when the line is not JSON. The single
 *  home of the frozen JSON.parse event-matching mechanism (skip-non-JSON, never an anchored regex). */
export function parseEvent(line: string): OutboxEvent | null {
  try { return JSON.parse(line) as OutboxEvent; } catch { return null; }
}

export function outboxOffset(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function readFrom(path: string, offset: number): string {
  try {
    const size = outboxOffset(path);
    // If the file shrank below the captured offset (crash/rotation recreated it),
    // re-read from the start so a fresh event in the smaller file is still seen.
    const start = size < offset ? 0 : offset;
    if (size <= start) return "";
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return ""; } // unreadable outbox -> treat as a no-match poll; the loop reaches its real timeout
}

function lastMatch(text: string, events: string[]): OutboxEvent | null {
  const lines = text.split("\n").filter(Boolean);
  // Match the upstream outbox-wait precedence: events in ARGUMENT ORDER — the
  // first listed event that appears anywhere wins, returning its LAST (tail-n1)
  // occurrence. (NOT file-position order.)
  for (const name of events) {
    for (let k = lines.length - 1; k >= 0; k--) {
      const obj = parseEvent(lines[k]);
      if (obj && obj.event === name) return obj;
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function outboxWaitSince(i: string, m: string, t: string, offset: number, events: string[], timeoutSec: number): Promise<OutboxEvent | null> {
  const path = outboxPath(i, m, t);
  for (let n = 0; n < timeoutSec; n++) {
    const hit = lastMatch(readFrom(path, offset), events);
    if (hit) return hit;
    await sleep(1000);
  }
  return null;
}

export async function outboxWait(i: string, m: string, t: string, events: string[], timeoutSec: number): Promise<OutboxEvent | null> {
  return outboxWaitSince(i, m, t, 0, events, timeoutSec);
}

export function outboxDump(i: string, m: string, t: string): string {
  return readIfExists(outboxPath(i, m, t));
}

export function paneMetaWrite(i: string, m: string, t: string, paneId: string, opts?: { now?: Date }): void {
  const spawned = isoUtc(opts?.now);
  atomicWrite(paneMetaPath(i, m, t), JSON.stringify({ pane_id: paneId, agent: i, model: m, spawned_at: spawned }) + "\n");
}

export interface PaneMeta { agent: string; model: string; paneId: string; }

interface PaneJson { pane_id?: string; agent?: string; model?: string; }

/** Read+parse a worker dir's pane.json, or null when absent/unparseable (the read throwing into
 *  the catch is equivalent to an existsSync pre-check). */
function readPaneJson(dir: string): PaneJson | null {
  try { return JSON.parse(readFileSync(join(dir, "pane.json"), "utf8")) as PaneJson; } catch { return null; }
}

export function paneMetaReadForDir(dir: string): PaneMeta {
  const o = readPaneJson(dir);
  if (o && o.agent && o.model) return { agent: o.agent, model: o.model, paneId: o.pane_id ?? "" };
  const name = dir.replace(/\/+$/, "").split("/").pop() ?? "";
  return { agent: name.replace(/-[^-]*$/, ""), model: name.replace(/^.*-/, ""), paneId: "" };
}

export function paneMetaRead(i: string, m: string, t: string): string | null {
  return readPaneJson(workerDir(i, m, t))?.pane_id ?? null;
}

/** Resolve the model segment for an agent's worker on a topic (the on-disk
 *  <agent>-<model> dir name), then the canonical model from pane.json. null if absent. */
export function resolveModel(agent: string, topic: string): string | null {
  const td = topicDir(topic);
  if (!existsSync(td)) return null;
  const d = readdirSync(td, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.startsWith(`${agent}-`));
  if (!d) return null;
  const model = d.name.slice(agent.length + 1);
  return readPaneJson(workerDir(agent, model, topic))?.model ?? model;
}
