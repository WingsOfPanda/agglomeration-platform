// src/core/workerLiveness.ts — the I/O half of worker liveness: read the records a topic's worker
// dirs already hold, hand them to the PURE classifier in core/job.ts, and persist the one piece of
// state this layer owns (the consecutive-miss counter).
//
// Kept out of core/job.ts because that module's contract is "everything decidable from values
// alone", and out of commands/job.ts because `ap list` needs the same answer without importing the
// whole job verb (and its spawn/send/stop dependencies) to get it.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { topicDir, jobDir, isArtifactDir } from "./paths.js";
import { atomicWrite } from "./atomic.js";
import { readIfExists, readOr } from "./fsread.js";
import { isoUtc } from "./archive.js";
import { paneMetaReadForDir } from "./ipc.js";
import {
  classifyWorkerLiveness, parseOutbox, parseWorkerMisses, formatWorkerMisses, workerLivenessPath,
  type WorkerMiss, type WorkerRec, type WorkerStatusRec,
} from "./job.js";

/** One printed row: the worker's `<agent>-<model>` identity (its dir name, which is the identity
 *  every state path is built from), the verdict token, and whether that verdict is a death. */
export interface WorkerRow { worker: string; verdict: string; dead: boolean; role?: string; }

/** `spawned_at` from a worker dir's pane.json, or "" for an absent, torn, or pre-`spawned_at`
 *  record. Read here rather than through `paneMetaReadForDir` so PaneMeta's shape — which four
 *  other callers and their tests pin — stays exactly as it is. */
function spawnedAtOf(dir: string): string {
  try {
    const o = JSON.parse(readFileSync(join(dir, "pane.json"), "utf8")) as { spawned_at?: unknown };
    return typeof o?.spawned_at === "string" ? o.spawned_at : "";
  } catch { return ""; }
}

/** `role` from a worker dir's pane.json — only a SLICE worker has one (src/core/ipc.ts,
 *  `paneMetaWrite`), so "" is the answer for every record written today. Read here beside
 *  `spawnedAtOf`, and for the same reason: `PaneMeta`'s shape is pinned by four other callers and
 *  their tests, and this field has exactly one consumer. */
function roleOf(dir: string): string {
  try {
    const o = JSON.parse(readFileSync(join(dir, "pane.json"), "utf8")) as { role?: unknown };
    return typeof o?.role === "string" ? o.role : "";
  } catch { return ""; }
}

/** The pane record for one worker dir. `paneMetaReadForDir` already falls back to the dir name for
 *  agent/model when pane.json is missing, and to "" for an unrecorded id/nonce — an unverifiable
 *  record, which rule 4 answers `unknown` rather than dead. */
export function readWorkerRec(dir: string): WorkerRec {
  const meta = paneMetaReadForDir(dir);
  return { agent: meta.agent, model: meta.model, paneId: meta.paneId, nonce: meta.nonce, spawnedAt: spawnedAtOf(dir) };
}

/** status.json as liveness reads it, or null when there is nothing to read. Regex over the two
 *  fields, matching every other status reader in the platform (a worker may pretty-print it, and a
 *  drifted format must degrade to "no state" rather than throw). */
export function readWorkerStatusRec(dir: string): WorkerStatusRec | null {
  const text = readOr(join(dir, "status.json"));
  if (text.trim() === "") return null;
  const state = /"state"\s*:\s*"([^"]*)"/.exec(text);
  const last = /"last_event"\s*:\s*"([^"]*)"/.exec(text);
  return { state: state ? state[1].trim() : "", lastEvent: last ? last[1].trim() : "" };
}

/** Every worker dir under `topic`, classified against ONE pane snapshot. The hub's own dir is
 *  excluded by name (`opts.exclude`) — its liveness is `classifyJobLiveness`'s job, and reporting it
 *  twice under two vocabularies is how two layers start disagreeing.
 *
 *  `persist` is the caller's choice because the counter is a RUNNING one: the `job` verbs that scan
 *  on a schedule (`status`, and `wait`'s mid-wait poll) advance it, while `ap list` — which an
 *  operator may run in a loop, or `watch` — reads it and reports without ever advancing it. A view
 *  must not be able to drive a worker to `pane-dead` faster than the run's own watch does.
 *
 *  Never throws: an unreadable topic dir is no workers, and a counter that could not be written
 *  re-reads as zero, which only ever costs extra misses before a death — the safe direction. */
export function scanTopicWorkers(
  topic: string,
  snapshot: Map<string, string>,
  now: number,
  opts?: { exclude?: string; persist?: boolean },
): WorkerRow[] {
  const td = topicDir(topic);
  if (!existsSync(td)) return [];
  let names: string[];
  try {
    names = readdirSync(td, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isArtifactDir(e.name))
      .map((e) => e.name)
      .sort();
  } catch { return []; }

  const prior = parseWorkerMisses(readIfExists(workerLivenessPath(topic)));
  const next: Record<string, WorkerMiss> = {};
  const rows: WorkerRow[] = [];
  for (const name of names) {
    if (opts?.exclude && name === opts.exclude) continue;
    const dir = join(td, name);
    // The dir name IS `<agent>-<model>`, so the paths are joined rather than rebuilt through
    // outboxPath/statusPath: a hyphenated model would otherwise have to be re-split to get back the
    // string we already hold.
    const events = parseOutbox(readIfExists(join(dir, "outbox.jsonl"))).length;
    const seen = prior[name];
    const v = classifyWorkerLiveness(readWorkerRec(dir), readWorkerStatusRec(dir), events, snapshot, seen?.misses ?? 0, now);
    next[name] = { misses: v.misses, last_seen: v.kind === "alive" ? isoUtc(new Date(now)) : (seen?.last_seen ?? "") };
    // The role is spread in only when there IS one, so a non-slice row is the object it always was.
    const role = roleOf(dir);
    rows.push({ worker: name, verdict: v.verdict, dead: v.dead, ...(role ? { role } : {}) });
  }
  if (opts?.persist && rows.length > 0) {
    try {
      mkdirSync(jobDir(topic), { recursive: true });
      atomicWrite(workerLivenessPath(topic), formatWorkerMisses(next));
    } catch { /* a counter we could not persist re-reads as 0: it costs misses, never a false death */ }
  }
  return rows;
}
