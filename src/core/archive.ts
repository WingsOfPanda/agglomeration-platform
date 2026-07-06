import { existsSync, mkdirSync, renameSync, rmSync, readdirSync, readFileSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { workerDir, topicDir, globalRoot, repoHash } from "./paths.js";
import { atomicWrite } from "./atomic.js";

export function archiveTs(now: Date = new Date()): string {
  return isoUtc(now).replace(/[-:]/g, "");
}
// archiveTs → YYYYMMDDTHHMMSSZ
export function isoUtc(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const STALE = ["identity.md", "inbox.md", "outbox.jsonl", "status.json", "pane.json", ".session_id"];

export function stateInit(agent: string, model: string, topic: string): void {
  const dir = workerDir(agent, model, topic);
  mkdirSync(dir, { recursive: true });
  for (const f of STALE) rmSync(join(dir, f), { force: true });
  closeSync(openSync(join(dir, "outbox.jsonl"), "w")); // touch fresh empty
  atomicWrite(join(dir, ".session_id"), `${process.env.CLAUDE_CODE_SESSION_ID ?? "unknown"}\n`);
}

function uniqueDest(base: string): string {
  if (!existsSync(base)) return base;
  for (let n = 2; n <= 999; n++) { const c = `${base}-${n}`; if (!existsSync(c)) return c; }
  throw new Error("too many same-second archive collisions; aborting");
}

/** Move `src` to a collision-free destination under `base` (mkdir-parent + rename); returns dest. */
function moveToArchive(src: string, base: string): string {
  const dest = uniqueDest(base);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  return dest;
}

export function stateArchive(agent: string, model: string, topic: string, suffix?: string, opts?: { now?: Date }): string | null {
  const src = workerDir(agent, model, topic);
  if (!existsSync(src)) return null;
  const ts = archiveTs(opts?.now);
  let base = join(globalRoot(), "archive", repoHash(), topic, `${agent}-${model}-${ts}`);
  if (suffix) base += `-${suffix}`;
  return moveToArchive(src, base);
}

export function finalizeArchived(td: string, opts?: { now?: Date }): void {
  if (!existsSync(td)) return;
  const now = isoUtc(opts?.now);
  for (const name of readdirSync(td)) {
    const sj = join(td, name, "status.json");
    if (!existsSync(sj)) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(readFileSync(sj, "utf8")); } catch { continue; }
    obj.state = "archived";
    obj.archived_ts = now;
    atomicWrite(sj, JSON.stringify(obj));
  }
}

export function archiveTopic(
  topic: string,
  suite: "consult" | "deploy" | "meditate" | "design" | "implement" | "autoresearch" | "explore",
  opts?: { now?: Date },
): string | null {
  const td = topicDir(topic);
  finalizeArchived(td, opts);
  const art = join(td, `_${suite}`);
  let dest: string | null = null;
  if (existsSync(art)) {
    const base = join(globalRoot(), "archive", repoHash(), topic, `_${suite}-${archiveTs(opts?.now)}`);
    dest = moveToArchive(art, base);
  }
  try { rmSync(td, { recursive: false, force: false }); } catch { /* rmdir-if-empty; tolerate non-empty */ }
  return dest;
}
