import { existsSync, readFileSync } from "node:fs";
import { log } from "../core/log.js";
import { workerDir, sameStateDir } from "../core/paths.js";
import { withMainCheckout } from "../core/job.js";
import { resolveModel, paneMetaRead, inboxWrite, inboxPath } from "../core/ipc.js";
import { paneOwned, paneSend, paneStateRead } from "../core/tmux.js";
import { validateSlug } from "../core/slug.js";

/** The typed pane prompt that points a worker at its inbox. A claude worker's line carries the
 *  "ultracode" keyword BY DEFAULT — Claude Code's per-prompt Workflow opt-in scans the typed
 *  prompt, so the keyword must ride the nudge, not the inbox file. AP_ULTRACODE=0 (exactly "0")
 *  opts a dispatch out. Other providers have no such trigger and always get the plain line. */
export function taskNudge(inbox: string, model: string, env: NodeJS.ProcessEnv = process.env): string {
  const ultra = env.AP_ULTRACODE !== "0" && model === "claude";
  return `Read ${inbox} and execute the task${ultra ? " with ultracode" : ""}. Reply when done.`;
}

/** The three tmux touches this verb makes: the ownership probe that decides whether the pane may be
 *  typed into, the @ap_state read that decides whether the tree it is about to write is the tree the
 *  worker reads, and the typing itself. Injected only by tests — nothing may reach a real pane in a
 *  unit test, least of all the verb whose bug was typing into a stranger's shell. `paneState` is
 *  optional so a test that is not about the state guard needs no shim and reaches no tmux: an
 *  un-injected reader answers "" (unverified), the same proceed-anyway value an unstamped pane
 *  gives. The shipped path always injects the live reader. */
export interface SendCmdDeps {
  paneOwned(pane: string, nonce: string): Promise<boolean>;
  paneSend(pane: string, line: string): Promise<void>;
  paneState?(pane: string): Promise<string>;
}
const liveSendCmdDeps: SendCmdDeps = { paneOwned, paneSend, paneState: paneStateRead };

export async function run(args: string[], deps: SendCmdDeps = liveSendCmdDeps): Promise<number> {
  // ONE state tree per run, whatever directory the hub is standing in. Every state path derives from
  // process.cwd() (paths.ts stateRoot + repoHash), so this verb's inboxWrite and its nudge -- which
  // are consistent with EACH OTHER by construction, both deriving from the same cwd -- could be
  // consistently wrong relative to the worker: from inside the run's own worktree the task was
  // written into a second tree, the pane was nudged with that tree's path, and the worker (rightly)
  // refused an inbox its identity.md did not name and idled. The split is here, not in the nudge.
  // `mainCheckoutRoot` re-roots ap-created run worktrees ONLY and leaves every other path (a user's
  // own worktree included) exactly as git reported it; outside a git repo repoRoot() falls back to
  // cwd, so this is a no-op there.
  return withMainCheckout(() => dispatchVerb(args, deps));
}

async function dispatchVerb(args: string[], deps: SendCmdDeps): Promise<number> {
  let from: string | undefined;
  // --no-done-instruction: the inbox carries the message WITHOUT the generic done-event contract.
  // For a mid-turn message to a worker whose task states its own done contract (the autoresearch
  // experiment brief), the generic line would be a second, conflicting `done` instruction: the
  // worker answered the hub's staleness probe with a generic-summary `done` that the loop then
  // scored as the experiment's completion (2026-09-05-worker-delegation-reminder-design.md, exposure 4).
  let noDone = false;
  let a = [...args];
  for (;;) {
    if (a[0] === "--from") { if (!a[1]) { log.error("--from requires a sender name"); return 2; } from = a[1]; a = a.slice(2); continue; }
    if (a[0] === "--no-done-instruction") { noDone = true; a = a.slice(1); continue; }
    break;
  }
  if (a.length < 3) { log.error("usage: send [--from s] [--no-done-instruction] <agent> <topic> <message|@file>"); return 2; }
  const [agent, topic] = a;
  if (!validateSlug(agent) || !validateSlug(topic)) { log.error(`agent/topic must match [a-z0-9-]+ and be <= 32 chars; got agent='${agent}' topic='${topic}'`); return 2; }
  let msg = a.slice(2).join(" ");

  const model = resolveModel(agent, topic);
  if (!model) { log.error(`no worker '${agent}' on topic '${topic}' (state dir absent)`); log.error(`  spawn first: ap spawn ${agent} <model> ${topic}`); return 1; }
  const owner = paneMetaRead(agent, model, topic);
  if (!owner) { log.error(`pane.json missing for ${agent}-${model} on ${topic}`); return 1; }
  const pane = owner.paneId;
  // Ownership, not liveness: a recorded id that outlived its pane can name a stranger's pane after a
  // tmux restart, and this verb TYPES INTO the pane it accepts (the nudge is executed there).
  if (!(await deps.paneOwned(pane, owner.nonce))) { log.error(`${agent}'s pane ${pane} is gone or is no longer ours (orphan); run ap stop ${agent} ${topic}`); return 1; }

  // The hub's own proof that it resolved the tree this worker was actually given. inboxWrite and the
  // nudge derive from the SAME cwd, so they stay consistent with each other while both miss the
  // worker; the pane is the one reference the two sides share that does not derive from the hub's
  // cwd. Three-valued, and the third value carries the weight: an unstamped pane (a worker spawned
  // by a pre-@ap_state release) is UNVERIFIED, never mismatched — refusing on absence would strand
  // every in-flight worker across the upgrade, the same discipline `job wait` and classifyTestRun
  // apply to a check that could not run. This MUST precede inboxWrite: a guard that refuses after
  // writing has already put the task in the tree it was guarding against.
  const resolvedDir = workerDir(agent, model, topic);
  const stamped = deps.paneState ? await deps.paneState(pane) : "";
  if (stamped && !sameStateDir(stamped, resolvedDir)) {
    log.error(`state-tree disagreement: ${agent}'s pane ${pane} was given a different state tree than this hub resolved; nothing was written`);
    log.error(`  worker's tree (pane @ap_state): ${stamped}`);
    log.error(`  tree resolved here:             ${resolvedDir}`);
    log.error(`  run ap from the repo root that owns this run, or finish/tear down the run that owns the other tree (ap list; ap stop ${agent} ${topic})`);
    return 2;
  }

  if (msg.startsWith("@")) {
    const f = msg.slice(1);
    if (!existsSync(f)) { log.error(`file not found: ${f}`); return 1; }
    msg = readFileSync(f, "utf8");
  }
  inboxWrite(agent, model, topic, msg, { ...(from ? { from } : {}), ...(noDone ? { noDoneInstruction: true } : {}) });
  const inbox = inboxPath(agent, model, topic);
  log.info(`wrote inbox at ${inbox}; nudging pane ${pane}`);
  await deps.paneSend(pane, taskNudge(inbox, model));
  process.stdout.write(`\n  worker:    ${agent}-${model} on ${topic}\n  pane:    ${pane}\n  inbox:   ${inbox}\n  status:  queued — use: ap collect ${agent} ${topic}  (to wait for {done})\n`);
  return 0;
}
