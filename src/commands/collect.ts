import { kvParse } from "../args.js";
import { log } from "../core/log.js";
import { withMainCheckout } from "../core/job.js";
import { resolveModel, outboxWaitSince, outboxDump } from "../core/ipc.js";
import { validateSlug } from "../core/slug.js";

export async function run(args: string[]): Promise<number> {
  // ONE state tree per run, whatever directory the operator is standing in (stop.ts carries the full
  // rationale). `resolveModel` and the outbox path below derive from process.cwd(), so from inside a
  // run's own worktree -- `<root>/.ap/worktrees/<topic>` -- this verb emitted the same false
  // `no worker '<agent>' on topic '<topic>'` stop did. The orphan refusal precedes the chdir so a
  // genuinely split pre-0.5.51 run is named rather than reported as a missing worker.
  return withMainCheckout(() => dispatchVerb(args));
}

async function dispatchVerb(args: string[]): Promise<number> {
  if (args.length < 2) { log.error("usage: collect <agent> <topic> [--timeout n]"); return 2; }
  const [agent, topic] = args;
  if (!validateSlug(agent) || !validateSlug(topic)) { log.error(`agent/topic must match [a-z0-9-]+ and be <= 32 chars; got agent='${agent}' topic='${topic}'`); return 2; }
  let timeout = 600;
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === "--timeout" || a.startsWith("--timeout=")) { const r = kvParse(a, args[i + 1]); timeout = Number(r.value); i += r.shift - 1; }
    else { log.error(`unknown arg: ${a}`); return 2; }
  }
  const model = resolveModel(agent, topic);
  if (!model) { log.error(`no worker '${agent}' on topic '${topic}'`); return 1; }
  log.info(`tailing outbox for ${agent}-${model} (timeout ${timeout}s)`);
  const ev = await outboxWaitSince(agent, model, topic, 0, ["done", "error"], timeout);
  if (ev?.event === "done") { log.ok("{done} received"); process.stdout.write(JSON.stringify(ev) + "\n"); return 0; }
  if (ev?.event === "error") { log.error(`{error} received from ${agent}`); process.stdout.write(JSON.stringify(ev) + "\n"); return 1; }
  log.error(`timeout after ${timeout}s; outbox tail:`);
  process.stderr.write(outboxDump(agent, model, topic).split("\n").slice(-5).join("\n") + "\n");
  return 1;
}
