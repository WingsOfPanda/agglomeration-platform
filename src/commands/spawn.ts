import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { kvParse } from "../args.js";
import { log } from "../core/log.js";
import { inTmuxSession, tmuxVersionOk, tmuxVersionString, haveCmd } from "../core/deps.js";
import { topicDir, workerDir, repoRoot } from "../core/paths.js";
import { mainCheckoutRoot, orphanRefusal, orphanedTopicState, worktreeTopic } from "../core/job.js";
import { stateInit, stateArchive, isoUtc } from "../core/archive.js";
import { readIfExists } from "../core/fsread.js";
import { atomicWrite } from "../core/atomic.js";
import { validateSlug } from "../core/slug.js";
import { identityWrite, identityPath, seedWorkerStatus, writeWorkerStatus, inboxWrite, inboxPath, paneMetaWrite, outboxWait, outboxDump, parseLastPane, formatLastPane, type WorkerRole } from "../core/ipc.js";
import { paneNonceFor } from "../core/roster.js";
import { pickRandomAgent, agentInUse, formatCollisionError } from "../core/agents.js";
import { agentBinary, agentDefaultMode, agentModeArgs, agentReadyTimeout, agentBootstrapSleep } from "../core/contracts.js";
import { wrapLaunch, splitRight, splitDown, respawn, paneOwned, paneNonceSet, paneStateSet, paneLabelSet, paneSend, killNow, capturePane, ensurePaneBorders, ensureWindowBorderStatus, sessionExists, newSession, newWindow, validSessionName } from "../core/tmux.js";
import { labelFor } from "../core/colors.js";
import { taskNudge } from "./send.js";
import { captureFailure, captureSpawnFailure, bootstrapFailureArgs } from "../core/forensics.js";

export { validateSlug };
export function resolveMode(explicit: string | undefined, dflt: string | undefined): string { return explicit || dflt || "full"; }

/** The parsed `spawn` argv. Extracted from run() so the flag grammar — in particular the placement
 *  flags, which are mutually exclusive — is testable without spawning a pane. */
export interface SpawnArgs {
  agent: string; model: string; topic: string;
  mode: string; cwd: string; targetPane: string; preflightArtDir: string; session: string; role: string; initial: string;
}
/** Positional `<agent> <model> <topic>`, then flags until the first non-flag token, which begins the
 *  initial prompt (the rest of argv, joined). Faithful to the loop this replaced. */
export function parseSpawnArgs(args: string[]): SpawnArgs {
  const [agent, model, topic] = args;
  let mode = "", cwd = "", targetPane = "", preflightArtDir = "", session = "", role = "", initial = "";
  for (let i = 3; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode" || a.startsWith("--mode=")) { const r = kvParse(a, args[i + 1]); mode = r.value; i += r.shift - 1; }
    else if (a === "--cwd" || a.startsWith("--cwd=")) { const r = kvParse(a, args[i + 1]); cwd = r.value; i += r.shift - 1; }
    else if (a === "--target-pane" || a.startsWith("--target-pane=")) { const r = kvParse(a, args[i + 1]); targetPane = r.value; i += r.shift - 1; }
    else if (a === "--preflight-art-dir" || a.startsWith("--preflight-art-dir=")) { const r = kvParse(a, args[i + 1]); preflightArtDir = r.value; i += r.shift - 1; }
    else if (a === "--session" || a.startsWith("--session=")) { const r = kvParse(a, args[i + 1]); session = r.value; i += r.shift - 1; }
    else if (a === "--role" || a.startsWith("--role=")) { const r = kvParse(a, args[i + 1]); role = r.value; i += r.shift - 1; }
    else { initial = args.slice(i).join(" "); break; }
  }
  return { agent, model, topic, mode, cwd, targetPane, preflightArtDir, session, role, initial };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stamp the fresh pane's ownership nonce, or tear it back down. A pane that did not take the stamp
 *  can never be proven ap's again: recording the nonce anyway would leave a worker no teardown could
 *  ever kill, so the pane goes now (best-effort — the same tmux failure may well defeat the kill,
 *  and the message says so). Returns false when the caller must abort the spawn. */
async function stampOrFail(pane: string, nonce: string, agent: string, model: string, topic: string): Promise<boolean> {
  // Both stamps or neither: @ap_state is the hub's proof that the tree it resolves is the tree this
  // worker was given, and a pane carrying one stamp without the other is a pane whose answers cannot
  // be trusted either way.
  const missing = !(await paneNonceSet(pane, nonce)) ? "@ap_nonce"
    : !(await paneStateSet(pane, paneStateStamp(agent, model, topic))) ? "@ap_state"
    : "";
  if (!missing) return true;
  captureSpawnFailure({ agent, model, topic, reason: "pane_failed", detail: `could not stamp ${missing} on ${pane}` });
  await killNow(pane);
  log.error(`could not stamp the ownership nonce on ${pane} (tmux unreachable?): ${missing} was refused; the pane was torn down rather than left unownable — check for a stray pane with: tmux list-panes -a`);
  return false;
}

/** The value stamped onto the worker's pane as @ap_state. It is exactly the `workerDir` that
 *  identityWrite embeds in the worker's identity.md, so pane and identity name ONE tree by
 *  construction -- if this ever returns something else, the hub-side guard in `send` starts refusing
 *  healthy runs, which is why it is a named seam and not an inline expression. */
export function paneStateStamp(agent: string, model: string, topic: string): string {
  return workerDir(agent, model, topic);
}

/** The three pre-tmux state writes every spawn path crosses: a fresh state dir, the identity file,
 *  and a seeded status.json. Extracted so this wiring is unit-testable without spawning a pane. */
export function prepareWorkerState(agent: string, model: string, topic: string, role?: WorkerRole): void {
  stateInit(agent, model, topic);
  identityWrite(agent, model, topic, { role });
  seedWorkerStatus(agent, model, topic);
}

export async function run(args: string[]): Promise<number> {
  // ONE state tree per run, whatever directory the hub is standing in. Every state path derives from
  // process.cwd() (paths.ts stateRoot + repoHash), and `--cwd` sets only the PANE's start directory
  // (`startDir`) -- it never enters the hash -- so the same spawn issued from the repo root and from
  // inside the run's own worktree wrote identity.md into two different trees, and the worker rightly
  // refused a later nudge naming an inbox its identity did not name. `mainCheckoutRoot` re-roots
  // ap-created run worktrees ONLY and leaves every other path (a user's own worktree included)
  // exactly as git reported it. Outside a git repo repoRoot() falls back to cwd, so this is a no-op.
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
    // One verb per process on the CLI path (src/ap.ts exits right after), but tests import run() and
    // share a process, so the cwd is restored rather than left moved. A cwd that has since been
    // removed must not turn a completed verb into a throw.
    if (root !== origCwd) { try { process.chdir(origCwd); } catch { /* the caller's cwd is gone */ } }
  }
}

async function dispatchVerb(args: string[]): Promise<number> {
  if (args.length < 3) { log.error("usage: spawn <agent|random> <model> <topic> [--mode m] [--cwd abs] [--target-pane id] [--session name] [--role worker|job-hub] [initial-prompt]"); return 2; }
  const parsed = parseSpawnArgs(args);
  let agent = parsed.agent;
  let initial = parsed.initial;
  const { model, topic, mode, cwd, targetPane, preflightArtDir, session, role } = parsed;

  if (!validateSlug(topic)) { log.error(`topic must match [a-z0-9-]+ and be <= 32 chars; got: '${topic}'`); return 2; }
  if (agent !== "random" && !validateSlug(agent)) { log.error(`agent must match [a-z0-9-]+ and be <= 32 chars (or 'random'); got: '${agent}'`); return 2; }
  if (cwd && (!cwd.startsWith("/") || !existsSync(cwd))) { log.error(`spawn --cwd must be an existing absolute path: ${cwd}`); return 1; }
  // Placement is a three-way choice and exactly one may be named: --target-pane RESPAWNS a reserved
  // preflight pane, --session creates/uses a detached session, and neither given means split the
  // caller's pane. Silently preferring one would put the worker somewhere the caller did not ask for.
  if (session && targetPane) { log.error("spawn: --session and --target-pane are mutually exclusive (--target-pane respawns a reserved preflight pane; --session places the worker in a detached session of its own)"); return 2; }
  if (session && !validSessionName(session)) { log.error(`spawn --session must be a tmux-safe name (letter or digit first, then letters/digits/_/-, at most 64 chars, no '.' or ':'); got: '${session}'`); return 2; }
  // The role selects the identity template, i.e. how much authority the pane is granted. An unknown
  // value must never silently fall back to the permissive one.
  if (role && role !== "worker" && role !== "job-hub") { log.error(`spawn --role must be 'worker' or 'job-hub'; got: '${role}'`); return 2; }

  // --session creates its OWN session, so the caller need not be inside tmux at all: this gate exists
  // only because the other two placements split the CALLER's pane.
  if (!session && !inTmuxSession()) { log.error("must run inside a tmux session (or pass --session <name> to place the worker in a detached session)"); return 1; }
  const tmuxVer = tmuxVersionString(); // one `tmux -V` for both checks (tmuxVersionOk() would re-run it)
  if (!tmuxVer) { log.error("tmux not on PATH"); return 1; }
  if (!tmuxVersionOk(tmuxVer)) { log.error("tmux >= 3.0 required"); return 1; }
  // Render @ap_ worker labels on pane borders (not the raw TUI title). These are `set -g` globals and
  // need a RUNNING server: on the detached path there may not be one yet (`tmux set-option -g` exits
  // 1 with "error connecting to ..." against a cold server), so the warn is withheld there and the
  // retry below — after new-session has started a server — is the one that counts.
  const bordersOk = await ensurePaneBorders();
  if (!bordersOk && !session) log.warn("could not set pane-border globals; worker labels may not render");

  if (agent === "random") {
    const pick = pickRandomAgent(topic);
    if (!pick) { log.error(`no available agent in pool for topic '${topic}'`); return 1; }
    agent = pick; log.info(`random pick: ${agent}`);
  }
  if (agentInUse(agent, topic)) { for (const l of formatCollisionError(agent, model, topic).split("\n")) log.error(l); return 1; }

  const binary = agentBinary(model);
  if (!binary) { captureSpawnFailure({ agent, model, topic, reason: "config_error", detail: `model '${model}' has no entry in contracts.yaml` }); log.error(`model '${model}' has no entry in contracts.yaml`); return 1; }
  if (!haveCmd(binary)) { captureSpawnFailure({ agent, model, topic, reason: "binary_not_found", detail: `${model}'s binary '${binary}' is not on PATH` }); log.error(`${model}'s binary '${binary}' is not on PATH`); return 1; }
  const useMode = resolveMode(mode, agentDefaultMode(model));
  const modeArgs = agentModeArgs(model, useMode);
  if (!modeArgs) { captureSpawnFailure({ agent, model, topic, reason: "config_error", detail: `mode '${useMode}' not defined for ${model} in contracts.yaml` }); log.error(`mode '${useMode}' not defined for ${model} in contracts.yaml`); return 1; }
  const readyTimeout = agentReadyTimeout(model);

  log.info(`preparing state for ${agent}-${model} on ${topic}`);
  try {
    prepareWorkerState(agent, model, topic, (role || "worker") as WorkerRole);

    const launch = wrapLaunch([binary, ...modeArgs].join(" "));
    const startDir = cwd || repoRoot();
    let pane: string;
    let nonce: string;
    if (targetPane) {
      // respawn-pane (-k) DESTROYS whatever runs in the target, so membership in preflight-panes.txt
      // is not enough: that file outlives the tmux server, and %N is reused after a restart. The
      // recorded nonce must still be on the live pane. Without an art dir there is no recorded
      // nonce at all, i.e. no ownership evidence — refuse rather than respawn a stranger's pane.
      if (!preflightArtDir) {
        captureSpawnFailure({ agent, model, topic, reason: "pane_failed", detail: `--target-pane ${targetPane} given without --preflight-art-dir (no ownership record)` });
        log.error(`--target-pane requires --preflight-art-dir: without it there is no recorded @ap_nonce for ${targetPane}, so ap cannot prove the pane is its own`); return 1;
      }
      const pf = join(preflightArtDir, "preflight-panes.txt");
      const recorded = existsSync(pf) ? paneNonceFor(readFileSync(pf, "utf8"), agent, targetPane) : null;
      if (recorded === null) {
        captureSpawnFailure({ agent, model, topic, reason: "pane_failed", detail: `--target-pane ${targetPane} not listed for ${agent} in ${pf}` });
        log.error(`--target-pane ${targetPane} is not a preflight pane for ${agent} (checked ${pf})`); return 1;
      }
      if (!(await paneOwned(targetPane, recorded))) {
        captureSpawnFailure({ agent, model, topic, reason: "pane_failed", detail: `--target-pane ${targetPane} is not alive or is not ours (nonce mismatch)` });
        log.error(`--target-pane ${targetPane} is not alive, or its @ap_nonce does not match ${pf} (it now belongs to another program); not respawning it`); return 1;
      }
      // Keep the preflight nonce: one nonce follows the pane from creation to teardown, so the
      // preflight-orphan sweep still recognizes a pane that became a worker.
      nonce = recorded;
      pane = await respawn(targetPane, launch, startDir);
      // respawn preserves pane options, so the stamp is a re-assertion — but if it FAILS, tmux is
      // unreachable and nothing here can be trusted; fail closed rather than record a nonce we
      // could not put on the pane. (stampOrFail kills the pane it just took over.)
      if (!(await stampOrFail(pane, nonce, agent, model, topic))) return 1;
      await paneLabelSet(pane, agent, model, topic);
    } else if (session) {
      // Detached placement: the worker gets its own window in `session`, created on first use. No
      // .last_pane write — that file is the ATTACHED layout's split-target memory, and a detached
      // session has no split geometry to remember.
      nonce = randomUUID();
      pane = (await sessionExists(session))
        ? await newWindow(session, launch, startDir)
        : await newSession(session, launch, startDir);
      if (!(await stampOrFail(pane, nonce, agent, model, topic))) return 1;
      await paneLabelSet(pane, agent, model, topic);
      if (!bordersOk && !(await ensurePaneBorders())) log.warn("could not set pane-border globals; worker labels may not render");
    } else {
      const lastFile = join(topicDir(topic), ".last_pane");
      // .last_pane records `<pane>\t<nonce>` for the same reason pane.json does: it survives a tmux
      // restart, and splitting off an unverified id would put this worker inside a stranger's
      // window. Unverifiable (legacy/mismatched/dead) → the plain splitRight, exactly as an absent
      // file behaves today.
      const prior = parseLastPane(readIfExists(lastFile));
      nonce = randomUUID();
      if (prior && await paneOwned(prior.paneId, prior.nonce)) pane = await splitDown(launch, prior.paneId, startDir);
      else pane = await splitRight(launch, undefined, startDir);
      if (!(await stampOrFail(pane, nonce, agent, model, topic))) return 1;
      await paneLabelSet(pane, agent, model, topic);
      mkdirSync(topicDir(topic), { recursive: true });
      atomicWrite(lastFile, formatLastPane(pane, nonce));   // atomic: a torn .last_pane would break the next split-target
    }
    if (!(await ensureWindowBorderStatus(pane))) log.warn(`could not force pane-border-status on the spawn window; '${labelFor(agent, model, topic)}' label may not render`);
    paneMetaWrite(agent, model, topic, pane, nonce);
    log.ok(`spawned ${labelFor(agent, model, topic)} in pane ${pane} (mode=${useMode})`);

    const boot = agentBootstrapSleep(model);
    log.info(`sleeping ${boot}s for ${model} bootstrap`);
    await sleep(boot * 1000);

    log.info(`asking ${agent} to read identity`);
    await paneSend(pane, `Read ${identityPath(agent, model, topic)} and follow its instructions exactly.`);

    log.info(`waiting for {ready,error} in outbox (timeout ${readyTimeout}s)`);
    const ev = await outboxWait(agent, model, topic, ["ready", "error"], readyTimeout);
    if (!ev || ev.event === "error") {
      const reason = ev ? "error_event" : "timeout";
      const tail = await capturePane(pane, 25);
      process.stderr.write(tail + "\n");
      if (!ev) {
        const ob = outboxDump(agent, model, topic).trim();
        if (ob) process.stderr.write(`outbox:\n${ob}\n`);
      }
      const fr = await captureFailure(
        { agent, model, topic, paneId: pane, reason: reason as "timeout" | "error_event", eventLine: ev ? JSON.stringify(ev) : undefined, readyTimeout },
        { workerDir, capturePane: (p, n) => capturePane(p, n), atomicWriteSync: (d, c) => writeFileSync(d, c), isWritableDir: (d) => existsSync(d), now: () => isoUtc() },
      );
      captureSpawnFailure({ agent, model, topic, ...bootstrapFailureArgs(ev ?? null, fr.ok ? fr.path : undefined) });
      await killNow(pane);   // no ownership re-check: this id was created by THIS call, it cannot be stale
      // stamp the truth over the seed: a FAILED archive must not claim a dispatchable state for a worker that never reported (`error` is terminal, so no gate changes)
      writeWorkerStatus(agent, model, topic, "error", "bootstrap-failed");
      const arch = stateArchive(agent, model, topic, "FAILED");
      log.error(`${agent} failed bootstrap (${reason}); state archived to: ${arch}`);
      return 1;
    }
    log.ok(`${agent} is ready`);

    if (initial) {
      initial = initial.replace(/^"|"$/g, "");
      inboxWrite(agent, model, topic, initial);
      await paneSend(pane, taskNudge(inboxPath(agent, model, topic), model));
      log.info(`use: ap collect ${agent} ${topic}  (to wait for {done})`);
    }

    const sessionLine = session ? `  session: ${session}  (tmux attach -t ${session})\n` : "";
    process.stdout.write(`\n  worker:    ${labelFor(agent, model, topic)}\n  pane:    ${pane}\n${sessionLine}  state:   ${workerDir(agent, model, topic)}\n  ready:   yes\n`);
    return 0;
  } catch (e) {
    captureSpawnFailure({ agent, model, topic, reason: "spawn_error", detail: String((e as Error)?.message ?? e) });
    throw e;
  }
}
