import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoStateDir, isArtifactDir } from "../core/paths.js";
import { readIfExists } from "../core/fsread.js";
import { paneMetaReadForDir, outboxPath, parseEvent, type PaneMeta } from "../core/ipc.js";
import { livePaneNonces, ownsPane } from "../core/tmux.js";

export function deriveState(lastEvent: string | undefined): string {
  switch (lastEvent) {
    case undefined: case "": return "spawning";
    case "done": return "idle (done)";
    case "error": return "idle (error)";
    case "ack": return "working";
    case "ready": return "ready";
    default: return lastEvent;
  }
}

export function lastOutboxEvent(outbox: string): string | undefined {
  const lines = readIfExists(outbox).split("\n").filter(Boolean);
  return lines.length ? parseEvent(lines[lines.length - 1])?.event : undefined;
}

// Stale-window knob; empty-string falls back to 180 to mirror the sibling shell's `:-` default
// (the `|| '180'` string-coerce, not `?? 180`, so set-but-empty also defaults). `classifyStale`'s
// own guard rejects any non-finite/negative/fractional value.
export const staleThresholdS = (): number => Number(process.env.AP_STALE_THRESHOLD_S || "180");

export function classifyStale(state: string, outbox: string, thresholdS = 180): string {
  if (state !== "working" || !existsSync(outbox)) return state;
  const t = Number.isInteger(thresholdS) && thresholdS >= 0 ? thresholdS : 180;
  const ageS = (Date.now() - statSync(outbox).mtimeMs) / 1000;
  return ageS > 0 && ageS > t ? "stale" : state;
}

/** A worker's STATE column. `[ORPHAN]` unless its recorded pane is live AND still carries the nonce
 *  recorded with it: a reused id (tmux restarts %N from 0 on a fresh server) shown as a live row is
 *  what invites the operator to `stop` — i.e. kill — a stranger's pane. */
export function rowState(live: Map<string, string>, meta: PaneMeta, outbox: string, thresholdS: number): string {
  if (!ownsPane(live, meta.paneId, meta.nonce)) return "[ORPHAN]";
  return classifyStale(deriveState(lastOutboxEvent(outbox)), outbox, thresholdS);
}

export async function run(args: string[]): Promise<number> {
  const filter = args.find((a) => !a.startsWith("--"));
  const repo = repoStateDir();
  if (!existsSync(repo)) { process.stdout.write(`no workers deployed (state dir absent: ${repo})\n`); return 0; }
  const W = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(`${W("PART", 32)} ${W("MODEL", 8)} ${W("TOPIC", 12)} ${W("PANE", 9)} STATE\n`);
  process.stdout.write(`${"-".repeat(32)} ${"-".repeat(8)} ${"-".repeat(12)} ${"-".repeat(9)} -----\n`);
  const threshold = staleThresholdS();
  const live = await livePaneNonces(); // one server-wide pane snapshot, not one scan per worker
  for (const t of readdirSync(repo, { withFileTypes: true })) {
    if (!t.isDirectory()) continue;
    if (filter && t.name !== filter) continue;
    const td = join(repo, t.name);
    for (const p of readdirSync(td, { withFileTypes: true })) {
      if (!p.isDirectory() || isArtifactDir(p.name)) continue;
      const dir = join(td, p.name);
      const meta = paneMetaReadForDir(dir);
      const pane = meta.paneId || "?";
      const ob = outboxPath(meta.agent, meta.model, t.name);
      const state = rowState(live, meta, ob, threshold);
      process.stdout.write(`${W(meta.agent, 32)} ${W(meta.model, 8)} ${W(t.name, 12)} ${W(pane, 9)} ${state}\n`);
    }
  }
  return 0;
}
