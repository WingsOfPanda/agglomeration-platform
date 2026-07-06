import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { topicDir, repoStateDir, isArtifactDir, pluginRoot } from "../core/paths.js";
import { stateArchive } from "../core/archive.js";
import { readIfExists } from "../core/fsread.js";
import { paneMetaRead, paneMetaReadForDir } from "../core/ipc.js";
import { livePanes, killGraceful, killNow } from "../core/tmux.js";

export const GRACEFUL_BATCH_WAIT_MS = 9000;
export interface Pair { agent: string; model: string; }

export interface StopDeps {
  paneMetaRead(i: string, m: string, t: string): string | null;
  livePanes(): Promise<Set<string>>;
  killGraceful(pane: string): Promise<void>;
  killNow(pane: string): Promise<void>;
  stateArchive(i: string, m: string, t: string): string | null;
  sleep(ms: number): Promise<void>;
  readLastPane(t: string): string;
  removeLastPane(t: string): void;
}

export async function teardownBatch(topic: string, pairs: Pair[], d: StopDeps): Promise<void> {
  const pending: string[] = [];
  // ONE full-server pane snapshot for the whole batch (per-pane paneAlive would re-run the
  // identical `tmux list-panes -a` scan for every worker).
  const live = pairs.length > 0 ? await d.livePanes() : new Set<string>();
  for (const { agent, model } of pairs) {
    const pane = d.paneMetaRead(agent, model, topic) ?? "";
    if (pane && live.has(pane)) {
      log.info(`graceful shutdown for ${agent}-${model} on ${topic} (pane ${pane})`);
      await d.killGraceful(pane);
      pending.push(pane);
    }
  }
  if (pending.length > 0) {
    log.info("waiting 9s for graceful banners to finish");
    await d.sleep(GRACEFUL_BATCH_WAIT_MS);
    for (const p of pending) await d.killNow(p);
  }
  for (const { agent, model } of pairs) {
    const dest = d.stateArchive(agent, model, topic);
    if (dest) log.ok(`archived ${agent}-${model}: ${dest}`);
  }
  const last = d.readLastPane(topic);
  if (last && pending.includes(last)) d.removeLastPane(topic);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function liveDeps(): StopDeps {
  return {
    paneMetaRead: (i, m, t) => paneMetaRead(i, m, t),
    livePanes: () => livePanes(),
    killGraceful: (p) => killGraceful(p, pluginRoot()),
    killNow: (p) => killNow(p),
    stateArchive: (i, m, t) => stateArchive(i, m, t),
    sleep,
    readLastPane: (t) => { const f = join(topicDir(t), ".last_pane"); return readIfExists(f).trim(); },
    removeLastPane: (t) => { try { rmSync(join(topicDir(t), ".last_pane"), { force: true }); } catch { /* */ } },
  };
}

function collectTopicPairs(topic: string): Pair[] {
  const td = topicDir(topic);
  if (!existsSync(td)) return [];
  const pairs: Pair[] = [];
  for (const name of readdirSync(td, { withFileTypes: true })) {
    if (!name.isDirectory() || isArtifactDir(name.name)) continue;
    const m = paneMetaReadForDir(join(td, name.name));
    pairs.push({ agent: m.agent, model: m.model });
  }
  return pairs;
}

function collectAgentPairs(topic: string, agents: string[]): Pair[] {
  const td = topicDir(topic);
  if (!existsSync(td)) return [];
  const dirs = readdirSync(td, { withFileTypes: true }).filter((e) => e.isDirectory());
  const pairs: Pair[] = [];
  for (const agent of agents) {
    for (const e of dirs) {
      if (e.name.startsWith(`${agent}-`)) {
        const m = paneMetaReadForDir(join(td, e.name));
        if (m.agent === agent) pairs.push({ agent, model: m.model });
      }
    }
  }
  return pairs;
}

function cleanupTopicDir(topic: string): void {
  const td = topicDir(topic);
  try { rmSync(join(td, ".last_pane"), { force: true }); } catch { /* */ }
  try { rmdirSync(td); } catch { /* tolerate non-empty */ }
}

export async function run(args: string[]): Promise<number> {
  const d = liveDeps();
  const a0 = args[0] ?? "";
  if (a0 === "" || a0 === "-h" || a0 === "--help") {
    process.stderr.write("Usage: stop <topic>\n       stop <agent> <topic>\n       stop --all\n       stop --pairs <topic> <i1> [i2...]\n");
    return 2;
  }
  if (a0 === "--all") {
    if (!args.includes("--yes")) {
      log.warn("stop --all tears down EVERY worker across every topic in this repo; re-run to confirm: stop --all --yes");
      return 2;
    }
    const repo = repoStateDir();
    if (!existsSync(repo)) { log.info("no state dirs to tear down"); return 0; }
    for (const t of readdirSync(repo, { withFileTypes: true })) {
      if (t.isDirectory()) { await teardownBatch(t.name, collectTopicPairs(t.name), d); cleanupTopicDir(t.name); }
    }
    return 0;
  }
  if (a0 === "--pairs") {
    const topic = args[1];
    const agents = args.slice(2);
    if (!topic || agents.length === 0) { log.error("--pairs requires <topic> <i1> [i2...]"); return 2; }
    const pairs = collectAgentPairs(topic, agents);
    if (pairs.length === 0) log.warn(`no matching worker dirs found for any of: ${agents.join(" ")}`);
    else await teardownBatch(topic, pairs, d);
    cleanupTopicDir(topic);
    return 0;
  }
  if (args.length === 1) { await teardownBatch(a0, collectTopicPairs(a0), d); cleanupTopicDir(a0); return 0; }
  if (args.length === 2) {
    const [agent, topic] = args;
    const pairs = collectAgentPairs(topic, [agent]);
    if (pairs.length === 0) { log.error(`no worker '${agent}' on topic '${topic}'`); return 1; }
    await teardownBatch(topic, pairs, d); cleanupTopicDir(topic);
    return 0;
  }
  process.stderr.write("Usage: stop <topic> | <agent> <topic> | --all | --pairs <topic> <i...>\n");
  return 2;
}
