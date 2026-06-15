import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { globalRoot, repoStateDir, topicDir, workerDir, isArtifactDir, pluginRoot } from "./paths.js";
import { paneMetaReadForDir } from "./ipc.js";

export function agentsPath(): string {
  const user = join(globalRoot(), "agents.yaml");
  return existsSync(user) ? user : join(pluginRoot(), "config", "agents.yaml");
}

export function loadAgentPool(): string[] {
  const p = agentsPath();
  if (!existsSync(p)) return [];
  try {
    const doc = parse(readFileSync(p, "utf8"));
    const list = Array.isArray(doc) ? doc : doc?.agents;
    return Array.isArray(list) ? list.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch { return []; }
}

function agentsInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory() || isArtifactDir(name.name)) continue;
    const meta = paneMetaReadForDir(join(dir, name.name));
    if (meta.agent) out.push(meta.agent);
  }
  return out;
}

export function agentsInUseInTopic(topic: string): string[] {
  return [...new Set(agentsInDir(topicDir(topic)))].sort();
}
export function agentInUse(agent: string, topic: string): boolean {
  return agentsInUseInTopic(topic).includes(agent);
}
export function agentsInUseGlobally(): string[] {
  const repo = repoStateDir();
  if (!existsSync(repo)) return [];
  const all: string[] = [];
  for (const t of readdirSync(repo, { withFileTypes: true })) {
    if (t.isDirectory()) all.push(...agentsInDir(join(repo, t.name)));
  }
  return [...new Set(all)].sort();
}

export function pickRandomAgent(topic: string, rng: () => number = Math.random): string | null {
  const pool = loadAgentPool();
  const global = new Set(agentsInUseGlobally());
  let candidates = pool.filter((x) => !global.has(x));
  if (candidates.length === 0) {
    const local = new Set(agentsInUseInTopic(topic));
    candidates = pool.filter((x) => !local.has(x));
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

/** Pick n DISTINCT agents for a topic. Prefers globally-unused names; falls back to
 *  topic-unused; already-picked-this-call are always excluded. Returns up to n (fewer if the
 *  pool is exhausted). Generalizes pickRandomAgent for the N-worker design ensemble. */
export function pickAgents(topic: string, n: number, rng: () => number = Math.random): string[] {
  const pool = loadAgentPool();
  const globalUsed = new Set(agentsInUseGlobally());
  const localUsed = new Set(agentsInUseInTopic(topic));
  const picked: string[] = [];
  for (let k = 0; k < n; k++) {
    let candidates = pool.filter((x) => !globalUsed.has(x) && !picked.includes(x));
    if (candidates.length === 0) candidates = pool.filter((x) => !localUsed.has(x) && !picked.includes(x));
    if (candidates.length === 0) break;
    picked.push(candidates[Math.floor(rng() * candidates.length)]);
  }
  return picked;
}

export function formatCollisionError(agent: string, model: string, topic: string, sessionId?: string): string {
  const lines = [`${agent} is already deployed on ${topic}; pick another agent`];
  const sidFile = join(workerDir(agent, model, topic), ".session_id");
  let owner = "";
  if (existsSync(sidFile)) owner = readFileSync(sidFile, "utf8").split("\n")[0] ?? "";
  const me = sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? "unknown";
  if (owner && owner !== me) lines.push(`  owned by another Claude Code session (id=${owner.slice(0, 8)}…, mine=${me.slice(0, 8)}…)`);
  lines.push(`  or run: /ap:stop ${agent} ${topic}`);
  return lines.join("\n");
}
