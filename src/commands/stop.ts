import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { topicDir, repoStateDir, isArtifactDir, pluginRoot } from "../core/paths.js";
import { jobPath, withMainCheckout } from "../core/job.js";
import { stateArchive } from "../core/archive.js";
import { readIfExists } from "../core/fsread.js";
import { paneMetaRead, paneMetaReadForDir, parseLastPane, type PaneOwner } from "../core/ipc.js";
import { livePaneNonces, ownsPane, killGraceful, killNow } from "../core/tmux.js";

export const GRACEFUL_BATCH_WAIT_MS = 9000;
export interface Pair { agent: string; model: string; }

export interface StopDeps {
  paneMetaRead(i: string, m: string, t: string): PaneOwner | null;
  livePaneNonces(): Promise<Map<string, string>>;
  killGraceful(pane: string, owned: boolean): Promise<void>;
  killNow(pane: string): Promise<void>;
  stateArchive(i: string, m: string, t: string, suffix?: string): string | null;
  sleep(ms: number): Promise<void>;
  readLastPane(t: string): string;
  removeLastPane(t: string): void;
}

export async function teardownBatch(topic: string, pairs: Pair[], d: StopDeps): Promise<void> {
  const pending: string[] = [];
  const stale = new Set<string>();   // pairs whose recorded pane is live but not ours (archive-only)
  // ONE full-server pane+nonce snapshot for the whole batch (a per-pane probe would re-run the
  // identical `tmux list-panes -a` scan for every worker).
  const live = pairs.length > 0 ? await d.livePaneNonces() : new Map<string, string>();
  for (const { agent, model } of pairs) {
    const owner = d.paneMetaRead(agent, model, topic);
    if (!owner || !live.has(owner.paneId)) continue;   // pane gone: today's orphan path, archive only
    // The pane id is live — but a %N is reused after a tmux server restart, which is exactly when a
    // never-archived pane.json is doing the naming. Kill ONLY on a matching @ap_nonce.
    if (!ownsPane(live, owner.paneId, owner.nonce)) {
      stale.add(`${agent}-${model}`);
      if (owner.nonce === "") {
        // An ap worker pane still carries @ap_label even when it predates @ap_nonce, so the
        // operator has one check ap cannot make for itself. Name it BEFORE the kill line: this pane
        // is precisely the one ap just said it could not identify.
        log.warn(`${agent}-${model}: pane ${owner.paneId} is live but pane.json predates ownership nonces — cannot prove it is ours, so NOT killing it. Identify it first: tmux display-message -p -t ${owner.paneId} '#{pane_current_command} #{@ap_label}' — then, if it really is this worker's pane: tmux kill-pane -t ${owner.paneId}`);
      } else {
        log.warn(`${agent}-${model}: pane ${owner.paneId} is live but is not ours (nonce mismatch) — not killing; it belongs to another program`);
      }
      continue;
    }
    log.info(`graceful shutdown for ${agent}-${model} on ${topic} (pane ${owner.paneId})`);
    await d.killGraceful(owner.paneId, true); // ownership already proven from the batch snapshot
    pending.push(owner.paneId);
  }
  if (pending.length > 0) {
    log.info("waiting 9s for graceful banners to finish");
    await d.sleep(GRACEFUL_BATCH_WAIT_MS);
    for (const p of pending) await d.killNow(p);
  }
  for (const { agent, model } of pairs) {
    // A skipped kill still archives — the sweep's job is clearing leftover state — but the archive
    // is marked so forensics can see teardown never reached a pane.
    const dest = d.stateArchive(agent, model, topic, stale.has(`${agent}-${model}`) ? "stalepane" : undefined);
    if (dest) log.ok(`archived ${agent}-${model}: ${dest}`);
  }
  const last = parseLastPane(d.readLastPane(topic));
  if (last && pending.includes(last.paneId)) d.removeLastPane(topic);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function liveDeps(): StopDeps {
  return {
    paneMetaRead: (i, m, t) => paneMetaRead(i, m, t),
    livePaneNonces: () => livePaneNonces(),
    killGraceful: (p, owned) => killGraceful(p, pluginRoot(), owned),
    killNow: (p) => killNow(p),
    stateArchive: (i, m, t, suffix) => stateArchive(i, m, t, suffix),
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

/** Tear down EVERY worker under a topic, then the topic dir — the UNGATED path, which `job stop`
 *  owns. It is the one caller entitled to it: it has already accounted for the job hub (persisting
 *  the pane evidence, then sweeping the session), whereas the public `stop <topic>` form refuses
 *  while a job record exists rather than calling this. */
export async function teardownTopic(topic: string): Promise<void> {
  await teardownBatch(topic, collectTopicPairs(topic), liveDeps());
  cleanupTopicDir(topic);
}

/** The refusal a public whole-topic teardown gets while a detached job is in flight. A job hub is
 *  mechanically an ordinary worker whose state dir sits under the very topic being torn down, so the
 *  topic form archives the CONTROLLER's outbox before its `done` reaches the origin's `job wait`,
 *  which then reports a synthetic pane death — the run looks like it crashed. The directives already
 *  say "per-agent while detached" in prose; prose only protects the obedient path. Silently sparing
 *  the hub was rejected too: a topic teardown that quietly left a live supervisor over its dead
 *  workers is a worse lie than a refusal. */
function jobInFlight(topic: string): boolean { return existsSync(jobPath(topic)); }

export async function run(args: string[]): Promise<number> {
  // ONE state tree per run, whatever directory the operator is standing in. Every state path derives
  // from process.cwd() (paths.ts stateRoot + repoHash), so a teardown issued from inside the run's
  // own worktree -- `<root>/.ap/worktrees/<topic>` -- hashed the WORKTREE, read an empty tree, and
  // answered `no worker '<agent>' on topic '<topic>'` while the worker was alive under the ROOT
  // hash: panes left running and nothing archived (6 field occurrences, 2026-08-24..28).
  // The orphan refusal is deliberately BEFORE the chdir, and therefore before any teardownBatch or
  // cleanupTopicDir: a pre-0.5.51 run whose state really is stranded under the worktree hash has to
  // be refused by name, never re-rooted over -- and stop must not archive or delete anything on the
  // way to finding that out. `mainCheckoutRoot` re-roots ap-created run worktrees ONLY and leaves
  // every other path (a user's own worktree included) exactly as git reported it; outside a git repo
  // repoRoot() falls back to cwd, so this is a no-op there.
  return withMainCheckout(() => dispatchVerb(args));
}

async function dispatchVerb(args: string[]): Promise<number> {
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
      if (!t.isDirectory()) continue;
      // LOUD skip, never silent: the sweep is exactly where an operator stops reading per-topic
      // detail, so a topic it declined to touch has to name itself and its own teardown verb.
      if (jobInFlight(t.name)) {
        log.warn(`stop --all: skipping ${t.name} — a detached job is in flight (${jobPath(t.name)}) and its hub is a worker under that topic; tear that job down with: ap job stop ${t.name}`);
        continue;
      }
      await teardownBatch(t.name, collectTopicPairs(t.name), d); cleanupTopicDir(t.name);
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
  if (args.length === 1) {
    if (jobInFlight(a0)) {
      log.error(`stop ${a0}: a detached job is in flight (${jobPath(a0)}) and its hub is a worker under this topic — tearing the topic down would kill the hub mid-run and the origin would read it as a crash. Nothing was torn down. Tear the whole job down with: ap job stop ${a0} — or stop ONE worker with: ap stop <agent> ${a0}`);
      return 1;
    }
    await teardownBatch(a0, collectTopicPairs(a0), d); cleanupTopicDir(a0); return 0;
  }
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
