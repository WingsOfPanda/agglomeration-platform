import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { kvParse } from "../args.js";
import { log } from "../core/log.js";
import { topicDir, repoRoot } from "../core/paths.js";
import { mainCheckoutRoot, orphanRefusal, orphanedTopicState, worktreeTopic } from "../core/job.js";
import { assertSlug } from "../core/slug.js";
import { atomicWrite } from "../core/atomic.js";
import { preflightLayout, PreflightEntry } from "../core/tmux.js";

export async function run(args: string[]): Promise<number> {
  // ONE state tree per run, whatever directory the operator is standing in (stop.ts carries the full
  // rationale). The default `_consult` art dir below is `topicDir(topic)`, keyed to process.cwd(), so
  // from inside a run's own worktree -- `<root>/.ap/worktrees/<topic>` -- preflight allocated its
  // panes against one tree while every other verb read the other. (`--art-dir` passes an absolute
  // path and was never affected.) The orphan refusal precedes the chdir, and therefore the mkdir.
  const origCwd = process.cwd();
  const gitRoot = repoRoot();
  const root = mainCheckoutRoot(gitRoot);
  const wtTopic = worktreeTopic(gitRoot);
  const stranded = orphanedTopicState(wtTopic, gitRoot, root);
  if (stranded) { for (const l of orphanRefusal(wtTopic, stranded, root).split("\n")) log.error(l); return 2; }
  if (root !== origCwd) process.chdir(root);
  try {
    return await dispatchVerb(args);
  } finally {
    // Tests import run() and share a process, so the cwd is restored rather than left moved; a cwd
    // that has since been removed must not turn a completed verb into a throw.
    if (root !== origCwd) { try { process.chdir(origCwd); } catch { /* the caller's cwd is gone */ } }
  }
}

async function dispatchVerb(args: string[]): Promise<number> {
  if (args.length < 2) { log.error("usage: preflight <topic> <N> [--list i1:m1,i2:m2,...] [--art-dir abs]"); return 2; }
  const topic = args[0];
  const n = Number(args[1]);
  let listArg = "", artDir = "";
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === "--list" || a.startsWith("--list=")) { const r = kvParse(a, args[i + 1]); listArg = r.value; i += r.shift - 1; }
    else if (a === "--art-dir" || a.startsWith("--art-dir=")) { const r = kvParse(a, args[i + 1]); artDir = r.value; i += r.shift - 1; }
  }
  // The shared gate, not a private copy: the old regex here carried its own <=64 bound, which the
  // choke point's <=32 has silently disagreed with since. Kept as an explicit call because `--art-dir`
  // skips the topicDir below, and the topic still reaches tmux as part of the pane's sentinel command.
  assertSlug("topic", topic);
  if (!Number.isInteger(n) || n < 2 || n > 4) { log.error(`N must be 2..4; got: '${args[1]}'`); return 2; }

  const list: PreflightEntry[] = listArg.split(",").filter(Boolean).map((pair) => {
    const [agent, model] = pair.split(":");
    return { agent, model };
  });
  if (list.length !== n) { log.error(`list has ${list.length} entries, expected ${n}`); return 1; }

  const art = artDir || join(topicDir(topic), "_consult");
  mkdirSync(art, { recursive: true });
  const panesFile = join(art, "preflight-panes.txt");
  try {
    const out = await preflightLayout(topic, list, { writePanes: (tsv) => atomicWrite(panesFile, tsv) });
    log.ok(`preflight: ${out.length} panes allocated for topic ${topic}`);
    for (const o of out) process.stdout.write(`  ${o.agent}\t${o.pane}\n`);
    return 0;
  } catch (e: any) {
    log.error(`preflight failed: ${e?.message ?? e}`);
    return 1;
  }
}
