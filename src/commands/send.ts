import { existsSync, readFileSync } from "node:fs";
import { log } from "../core/log.js";
import { resolveModel, paneMetaRead, inboxWrite, inboxPath } from "../core/ipc.js";
import { paneAlive, paneSend } from "../core/tmux.js";

export async function run(args: string[]): Promise<number> {
  let from: string | undefined;
  let a = [...args];
  if (a[0] === "--from") { if (!a[1]) { log.error("--from requires a sender name"); return 2; } from = a[1]; a = a.slice(2); }
  if (a.length < 3) { log.error("usage: send [--from s] <agent> <topic> <message|@file>"); return 2; }
  const [agent, topic] = a;
  let msg = a.slice(2).join(" ");

  const model = resolveModel(agent, topic);
  if (!model) { log.error(`no worker '${agent}' on topic '${topic}' (state dir absent)`); log.error(`  spawn first: ap spawn ${agent} <model> ${topic}`); return 1; }
  const pane = paneMetaRead(agent, model, topic);
  if (!pane) { log.error(`pane.json missing for ${agent}-${model} on ${topic}`); return 1; }
  if (!(await paneAlive(pane))) { log.error(`${agent}'s pane ${pane} is gone (orphan); run ap coda ${agent} ${topic}`); return 1; }

  if (msg.startsWith("@")) {
    const f = msg.slice(1);
    if (!existsSync(f)) { log.error(`file not found: ${f}`); return 1; }
    msg = readFileSync(f, "utf8");
  }
  inboxWrite(agent, model, topic, msg, from ? { from } : undefined);
  const inbox = inboxPath(agent, model, topic);
  log.info(`wrote inbox at ${inbox}; nudging pane ${pane}`);
  await paneSend(pane, `Read ${inbox} and execute the task. Reply when done.`);
  process.stdout.write(`\n  worker:    ${agent}-${model} on ${topic}\n  pane:    ${pane}\n  inbox:   ${inbox}\n  status:  queued — use: ap collect ${agent} ${topic}  (to wait for {done})\n`);
  return 0;
}
