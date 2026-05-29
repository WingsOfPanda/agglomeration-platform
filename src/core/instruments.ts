import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { globalRoot, repoStateDir, topicDir, partDir, isArtifactDir } from "./paths.js";
import { paneMetaReadForDir } from "./ipc.js";

function pluginRoot(): string { return process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd(); }
export function instrumentsPath(): string {
  const user = join(globalRoot(), "instruments.yaml");
  return existsSync(user) ? user : join(pluginRoot(), "config", "instruments.yaml");
}

export function loadInstrumentPool(): string[] {
  const p = instrumentsPath();
  if (!existsSync(p)) return [];
  try {
    const doc = parse(readFileSync(p, "utf8"));
    const list = Array.isArray(doc) ? doc : doc?.instruments;
    return Array.isArray(list) ? list.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch { return []; }
}

function instrumentsInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory() || isArtifactDir(name.name)) continue;
    const meta = paneMetaReadForDir(join(dir, name.name));
    if (meta.instrument) out.push(meta.instrument);
  }
  return out;
}

export function instrumentsInUseInTopic(topic: string): string[] {
  return [...new Set(instrumentsInDir(topicDir(topic)))].sort();
}
export function instrumentInUse(instrument: string, topic: string): boolean {
  return instrumentsInUseInTopic(topic).includes(instrument);
}
export function instrumentsInUseGlobally(): string[] {
  const repo = repoStateDir();
  if (!existsSync(repo)) return [];
  const all: string[] = [];
  for (const t of readdirSync(repo, { withFileTypes: true })) {
    if (t.isDirectory()) all.push(...instrumentsInDir(join(repo, t.name)));
  }
  return [...new Set(all)].sort();
}

export function pickRandomInstrument(topic: string, rng: () => number = Math.random): string | null {
  const pool = loadInstrumentPool();
  const global = new Set(instrumentsInUseGlobally());
  let candidates = pool.filter((x) => !global.has(x));
  if (candidates.length === 0) {
    const local = new Set(instrumentsInUseInTopic(topic));
    candidates = pool.filter((x) => !local.has(x));
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

export function formatCollisionError(instrument: string, model: string, topic: string, sessionId?: string): string {
  const lines = [`${instrument} is already deployed on ${topic}; pick another instrument`];
  const sidFile = join(partDir(instrument, model, topic), ".session_id");
  let owner = "";
  if (existsSync(sidFile)) owner = readFileSync(sidFile, "utf8").split("\n")[0] ?? "";
  const me = sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? "unknown";
  if (owner && owner !== me) lines.push(`  owned by another Claude Code session (id=${owner.slice(0, 8)}…, mine=${me.slice(0, 8)}…)`);
  lines.push(`  or run: /consort:coda ${instrument} ${topic}`);
  return lines.join("\n");
}
