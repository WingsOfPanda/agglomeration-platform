import { existsSync, readFileSync } from "node:fs";
import { log } from "../core/log.js";
import { resolveModel, paneMetaRead, inboxWrite, inboxPath } from "../core/ipc.js";
import { paneAlive, paneSend } from "../core/tmux.js";
import { validateSlug } from "../core/slug.js";

/** The typed pane prompt that points a worker at its inbox. A claude worker's line carries the
 *  "ultracode" keyword BY DEFAULT — Claude Code's per-prompt Workflow opt-in scans the typed
 *  prompt, so the keyword must ride the nudge, not the inbox file. AP_ULTRACODE=0 (exactly "0")
 *  opts a dispatch out. Other providers have no such trigger and always get the plain line. */
export function taskNudge(inbox: string, model: string, env: NodeJS.ProcessEnv = process.env): string {
  const ultra = env.AP_ULTRACODE !== "0" && model === "claude";
  return `Read ${inbox} and execute the task${ultra ? " with ultracode" : ""}. Reply when done.`;
}

export async function run(args: string[]): Promise<number> {
  let from: string | undefined;
  let a = [...args];
  if (a[0] === "--from") { if (!a[1]) { log.error("--from requires a sender name"); return 2; } from = a[1]; a = a.slice(2); }
  if (a.length < 3) { log.error("usage: send [--from s] <agent> <topic> <message|@file>"); return 2; }
  const [agent, topic] = a;
  if (!validateSlug(agent) || !validateSlug(topic)) { log.error(`agent/topic must match [a-z0-9-]+ and be <= 32 chars; got agent='${agent}' topic='${topic}'`); return 2; }
  let msg = a.slice(2).join(" ");

  const model = resolveModel(agent, topic);
  if (!model) { log.error(`no worker '${agent}' on topic '${topic}' (state dir absent)`); log.error(`  spawn first: ap spawn ${agent} <model> ${topic}`); return 1; }
  const pane = paneMetaRead(agent, model, topic);
  if (!pane) { log.error(`pane.json missing for ${agent}-${model} on ${topic}`); return 1; }
  if (!(await paneAlive(pane))) { log.error(`${agent}'s pane ${pane} is gone (orphan); run ap stop ${agent} ${topic}`); return 1; }

  if (msg.startsWith("@")) {
    const f = msg.slice(1);
    if (!existsSync(f)) { log.error(`file not found: ${f}`); return 1; }
    msg = readFileSync(f, "utf8");
  }
  inboxWrite(agent, model, topic, msg, from ? { from } : undefined);
  const inbox = inboxPath(agent, model, topic);
  log.info(`wrote inbox at ${inbox}; nudging pane ${pane}`);
  await paneSend(pane, taskNudge(inbox, model));
  process.stdout.write(`\n  worker:    ${agent}-${model} on ${topic}\n  pane:    ${pane}\n  inbox:   ${inbox}\n  status:  queued — use: ap collect ${agent} ${topic}  (to wait for {done})\n`);
  return 0;
}
