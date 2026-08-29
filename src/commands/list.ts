import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoStateDir, isArtifactDir } from "../core/paths.js";
import { parseJob, jobPath, classifyJobLiveness, withMainCheckout } from "../core/job.js";
import { readIfExists } from "../core/fsread.js";
import { paneMetaReadForDir, outboxPath, parseEvent, type PaneMeta } from "../core/ipc.js";
import { livePaneNonces, ownsPane } from "../core/tmux.js";
import { scanTopicWorkers } from "../core/workerLiveness.js";

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
  // ONE state tree per run, whatever directory the operator is standing in (stop.ts carries the full
  // rationale). `repoStateDir()` below derives from process.cwd(), so from inside a run's own
  // worktree -- `<root>/.ap/worktrees/<topic>` -- this table listed the WORKTREE tree: no workers, or
  // orphans, for a run whose workers were alive under the ROOT hash. The orphan refusal precedes the
  // chdir so a genuinely split pre-0.5.51 run is named rather than reported as an empty repo.
  return withMainCheckout(() => dispatchVerb(args));
}

async function dispatchVerb(args: string[]): Promise<number> {
  const filter = args.find((a) => !a.startsWith("--"));
  const repo = repoStateDir();
  if (!existsSync(repo)) { process.stdout.write(`no workers deployed (state dir absent: ${repo})\n`); return 0; }
  const W = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(`${W("PART", 32)} ${W("MODEL", 8)} ${W("TOPIC", 12)} ${W("PANE", 9)} ${W("STATE", 12)} LIVENESS\n`);
  process.stdout.write(`${"-".repeat(32)} ${"-".repeat(8)} ${"-".repeat(12)} ${"-".repeat(9)} ${"-".repeat(12)} --------\n`);
  const threshold = staleThresholdS();
  const live = await livePaneNonces(); // one server-wide pane snapshot, not one scan per worker
  const now = Date.now();
  for (const t of readdirSync(repo, { withFileTypes: true })) {
    if (!t.isDirectory()) continue;
    if (filter && t.name !== filter) continue;
    const td = join(repo, t.name);
    // Read-only: `ap list` reports the classifier's verdict but never ADVANCES the miss counter.
    // An operator running it in a `watch` loop must not be able to drive a worker to `pane-dead`
    // faster than the run's own scheduled rescans do.
    const liveness = new Map(scanTopicWorkers(t.name, live, now).map((w) => [w.worker, w.verdict]));
    for (const p of readdirSync(td, { withFileTypes: true })) {
      if (!p.isDirectory() || isArtifactDir(p.name)) continue;
      const dir = join(td, p.name);
      const meta = paneMetaReadForDir(dir);
      const pane = meta.paneId || "?";
      const ob = outboxPath(meta.agent, meta.model, t.name);
      const state = rowState(live, meta, ob, threshold);
      process.stdout.write(`${W(meta.agent, 32)} ${W(meta.model, 8)} ${W(t.name, 12)} ${W(pane, 9)} ${W(state, 12)} ${liveness.get(p.name) ?? "unknown"}\n`);
    }
  }
  writeJobsSection(repo, live, filter, W);
  return 0;
}

/** The DETACHED JOBS section. Printed after the worker table and only when this repo has at least
 *  one job record, so an operator who has never run a detached job sees exactly what they see today.
 *  Liveness is the job module's three-valued verdict, not the worker table's `[ORPHAN]`: a job hub
 *  whose nonce cannot be verified is UNKNOWN, and calling that dead would tell an operator their
 *  multi-hour run had died when it is running fine. */
function writeJobsSection(repo: string, live: Map<string, string>, filter: string | undefined, W: (s: string, n: number) => string): void {
  const rows: string[] = [];
  for (const t of readdirSync(repo, { withFileTypes: true })) {
    if (!t.isDirectory()) continue;
    if (filter && t.name !== filter) continue;
    const rec = parseJob(readIfExists(jobPath(t.name)));
    if (!rec) continue;
    const hub = `${rec.hub.agent}-${rec.hub.model}`;
    const liveness = classifyJobLiveness(live, paneMetaReadForDir(join(repo, t.name, hub)));
    rows.push(`${W(rec.topic, 24)} ${W(rec.command, 10)} ${W(hub, 20)} ${W(rec.session, 24)} ${liveness}`);
  }
  if (rows.length === 0) return;
  process.stdout.write(`\nDETACHED JOBS\n`);
  process.stdout.write(`${W("TOPIC", 24)} ${W("COMMAND", 10)} ${W("HUB", 20)} ${W("SESSION", 24)} HUB-LIVENESS\n`);
  process.stdout.write(`${"-".repeat(24)} ${"-".repeat(10)} ${"-".repeat(20)} ${"-".repeat(24)} ------------\n`);
  for (const r of rows) process.stdout.write(r + "\n");
}
