import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kvParse } from "../args.js";
import { log } from "../core/log.js";
import { inTmuxSession, tmuxVersionOk, haveCmd } from "../core/deps.js";
import { topicDir, workerDir, repoRoot } from "../core/paths.js";
import { stateInit, stateArchive, isoUtc } from "../core/archive.js";
import { readIfExists } from "../core/fsread.js";
import { identityWrite, identityPath, inboxWrite, inboxPath, paneMetaWrite, outboxWait, outboxDump } from "../core/ipc.js";
import { paneListedFor } from "../core/score.js";
import { pickRandomAgent, agentInUse, formatCollisionError } from "../core/agents.js";
import { agentBinary, agentDefaultMode, agentModeArgs, agentReadyTimeout, agentBootstrapSleep } from "../core/contracts.js";
import { wrapLaunch, splitRight, splitDown, respawn, paneAlive, paneLabelSet, paneSend, killNow, capturePane, ensurePaneBorders, ensureWindowBorderStatus } from "../core/tmux.js";
import { labelFor } from "../core/colors.js";
import { captureFailure, captureSpawnFailure, bootstrapFailureArgs } from "../core/forensics.js";

const SLUG = /^[a-z0-9-]+$/;
export function validateSlug(s: string): boolean { return SLUG.test(s) && s.length >= 1 && s.length <= 32; }
export function resolveMode(explicit: string | undefined, dflt: string | undefined): string { return explicit || dflt || "full"; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(args: string[]): Promise<number> {
  if (args.length < 3) { log.error("usage: spawn <agent|random> <model> <topic> [--mode m] [--cwd abs] [--target-pane id] [initial-prompt]"); return 2; }
  let agent = args[0];
  const [, model, topic] = args;
  let i = 3, mode = "", cwd = "", targetPane = "", preflightArtDir = "", initial = "";
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode" || a.startsWith("--mode=")) { const r = kvParse(a, args[i + 1]); mode = r.value; i += r.shift - 1; }
    else if (a === "--cwd" || a.startsWith("--cwd=")) { const r = kvParse(a, args[i + 1]); cwd = r.value; i += r.shift - 1; }
    else if (a === "--target-pane" || a.startsWith("--target-pane=")) { const r = kvParse(a, args[i + 1]); targetPane = r.value; i += r.shift - 1; }
    else if (a === "--preflight-art-dir" || a.startsWith("--preflight-art-dir=")) { const r = kvParse(a, args[i + 1]); preflightArtDir = r.value; i += r.shift - 1; }
    else { initial = args.slice(i).join(" "); break; }
  }

  if (!validateSlug(topic)) { log.error(`topic must match [a-z0-9-]+ and be <= 32 chars; got: '${topic}'`); return 2; }
  if (agent !== "random" && !validateSlug(agent)) { log.error(`agent must match [a-z0-9-]+ and be <= 32 chars (or 'random'); got: '${agent}'`); return 2; }
  if (cwd && (!cwd.startsWith("/") || !existsSync(cwd))) { log.error(`spawn --cwd must be an existing absolute path: ${cwd}`); return 1; }

  if (!inTmuxSession()) { log.error("must run inside a tmux session"); return 1; }
  if (!haveCmd("tmux")) { log.error("tmux not on PATH"); return 1; }
  if (!tmuxVersionOk()) { log.error("tmux >= 3.0 required"); return 1; }
  if (!(await ensurePaneBorders())) log.warn("could not set pane-border globals; worker labels may not render"); // render @ap_ worker labels on pane borders (not the raw TUI title)

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
    stateInit(agent, model, topic);
    identityWrite(agent, model, topic);

    const launch = wrapLaunch([binary, ...modeArgs].join(" "));
    const startDir = cwd || repoRoot();
    let pane: string;
    if (targetPane) {
      if (preflightArtDir) {
        const pf = join(preflightArtDir, "preflight-panes.txt");
        const ok = existsSync(pf) && paneListedFor(readFileSync(pf, "utf8"), agent, targetPane);
        if (!ok) {
          captureSpawnFailure({ agent, model, topic, reason: "pane_failed", detail: `--target-pane ${targetPane} not listed for ${agent} in ${pf}` });
          log.error(`--target-pane ${targetPane} is not a preflight pane for ${agent} (checked ${pf})`); return 1;
        }
      }
      if (!(await paneAlive(targetPane))) {
        captureSpawnFailure({ agent, model, topic, reason: "pane_failed", detail: `--target-pane ${targetPane} is not alive` });
        log.error(`--target-pane ${targetPane} is not alive`); return 1;
      }
      pane = await respawn(targetPane, launch, startDir);
      await paneLabelSet(pane, agent, model, topic);
    } else {
      const lastFile = join(topicDir(topic), ".last_pane");
      const prior = readIfExists(lastFile).trim();
      if (prior && await paneAlive(prior)) pane = await splitDown(launch, prior, startDir);
      else pane = await splitRight(launch, undefined, startDir);
      await paneLabelSet(pane, agent, model, topic);
      mkdirSync(topicDir(topic), { recursive: true });
      writeFileSync(lastFile, pane + "\n");
    }
    if (!(await ensureWindowBorderStatus(pane))) log.warn(`could not force pane-border-status on the spawn window; '${labelFor(agent, model, topic)}' label may not render`);
    paneMetaWrite(agent, model, topic, pane);
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
      await killNow(pane);
      const arch = stateArchive(agent, model, topic, "FAILED");
      log.error(`${agent} failed bootstrap (${reason}); state archived to: ${arch}`);
      return 1;
    }
    log.ok(`${agent} is ready`);

    if (initial) {
      initial = initial.replace(/^"|"$/g, "");
      inboxWrite(agent, model, topic, initial);
      await paneSend(pane, `Read ${inboxPath(agent, model, topic)} and execute the task. Reply when done.`);
      log.info(`use: ap collect ${agent} ${topic}  (to wait for {done})`);
    }

    process.stdout.write(`\n  worker:    ${labelFor(agent, model, topic)}\n  pane:    ${pane}\n  state:   ${workerDir(agent, model, topic)}\n  ready:   yes\n`);
    return 0;
  } catch (e) {
    captureSpawnFailure({ agent, model, topic, reason: "spawn_error", detail: String((e as Error)?.message ?? e) });
    throw e;
  }
}
