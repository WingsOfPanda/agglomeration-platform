import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { kvParse } from "../args.js";
import { log } from "../core/log.js";
import { inTmuxSession, tmuxVersionOk, tmuxVersionString, haveCmd } from "../core/deps.js";
import { topicDir, workerDir, repoRoot } from "../core/paths.js";
import { withMainCheckout } from "../core/job.js";
import { pinReport } from "../core/provision.js";
import { stateInit, stateArchive, isoUtc } from "../core/archive.js";
import { readIfExists } from "../core/fsread.js";
import { atomicWrite } from "../core/atomic.js";
import { validateSlug } from "../core/slug.js";
import { identityWrite, identityPath, seedWorkerStatus, writeWorkerStatus, inboxWrite, inboxPath, paneMetaWrite, outboxWaitSince, outboxDump, parseLastPane, formatLastPane, IDENTITY_BLOCKS, PANE_DIED_NOTE, type WorkerRole, type OutboxEvent, type Clock } from "../core/ipc.js";
import { paneNonceFor } from "../core/roster.js";
import { pickRandomAgent, agentInUse, formatCollisionError } from "../core/agents.js";
import { agentBinary, agentDefaultMode, agentModeArgs, agentReadyTimeout, agentBootstrapSleep } from "../core/contracts.js";
import { wrapLaunch, splitRight, splitDown, respawn, paneOwned, paneNonceSet, paneStateSet, paneLabelSet, paneSend, killNow, capturePane, ensurePaneBorders, ensureWindowBorderStatus, sessionExists, newSession, validSessionName } from "../core/tmux.js";
import { labelFor } from "../core/colors.js";
import { taskNudge } from "./send.js";
import { captureFailure, captureSpawnFailure, NO_EVENT_SENTINEL, type FailureReason } from "../core/forensics.js";

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

/** The events the bootstrap ready-wait listens for. Frozen names, one definition: the live call and
 *  the tests that drive the real wait engine must not be able to drift apart. */
export const READY_EVENTS: string[] = ["ready", "error"];

/** The exit code spawn re-raises when it is SIGTERMed: 128 + SIGTERM(15), i.e. exactly the code the
 *  caller would have seen had no handler been installed. */
export const SPAWN_KILLED_EXIT = 143;

export interface ReadyWaitDeps {
  wait: typeof outboxWaitSince;
  paneAlive: (pane: string, nonce: string) => Promise<boolean>;
  clock?: Clock;
}

/** The bootstrap ready-wait, with the wait's pane-liveness escape hatch wired to the pane THIS call
 *  just created. Without it, a pane that dies at t=10s still burned the whole ready_timeout_s before
 *  anyone noticed. Deliberately NO `extendMult` (default 1 = off): the turn waits extend for a live
 *  worker that is merely slow, but a bootstrap deadline a silent pane can stretch is not a deadline.
 *  The probe is ownership-checked (nonce, not id alone) for the reason waitLive.ts carries: a pane id
 *  can name a stranger's pane after a tmux restart. */
export function readyWait(
  ctx: { agent: string; model: string; topic: string; pane: string; nonce: string; readyTimeout: number },
  deps: ReadyWaitDeps,
): Promise<OutboxEvent | null> {
  return deps.wait(ctx.agent, ctx.model, ctx.topic, 0, READY_EVENTS, ctx.readyTimeout, {
    paneAlive: (p) => deps.paneAlive(p, ctx.nonce),
    paneId: ctx.pane,
  }, deps.clock);
}

/** Why the ready-wait ended without a `ready`: no event at all is the deadline; the wait's synthetic
 *  pane-death error is a dead pane (the worker never wrote it); anything else is the worker's own
 *  `error` event. Pure, so the three-way split is testable without a wait. */
export const bootstrapFailureDetail = (ev: OutboxEvent | null): string => ev ? JSON.stringify(ev) : NO_EVENT_SENTINEL;
export function bootstrapFailureReason(ev: OutboxEvent | null): FailureReason {
  if (!ev) return "timeout";
  return ev.note === PANE_DIED_NOTE ? "pane_dead" : "error_event";
}

/** The exit code the bootstrap-failure arm returns for a reason: **3** for the two COLD-START
 *  reasons (the pane died, or `ready` never came) and 1 for the worker's own `error` event. The
 *  split exists for `implement spawn-slices`, which branches on the RETURN CODE — the
 *  `SPAWN_FAILED reason=` line is a directive contract a Bash step greps, invisible to an
 *  in-process caller — and retries only the cold-start pair. Every existing caller tests
 *  zero-vs-non-zero only, so nothing else moves. */
export function bootstrapFailureRc(reason: FailureReason): number {
  return reason === "pane_dead" || reason === "timeout" ? 3 : 1;
}

/** Roles `--role` admits: exactly the identity blocks, so a role can never be spelled in the gate
 *  and missing from the table (or the reverse). `hasOwn`, not `in`: `--role constructor` would walk
 *  the prototype chain and pass. Exported so the gate is testable without creating a pane. */
export function isWorkerRole(role: string): role is WorkerRole {
  return Object.hasOwn(IDENTITY_BLOCKS, role);
}

/** Injected so the killed-spawn ORDER is unit-testable without a pane, a real signal, or a real exit. */
export interface SpawnKilledDeps {
  writeWorkerStatus: typeof writeWorkerStatus;
  killNow: typeof killNow;
  capturePane: typeof capturePane;
  captureFailure: typeof captureFailure;
  captureSpawnFailure: typeof captureSpawnFailure;
  stateArchive: typeof stateArchive;
  exit: (code: number) => void;
}

export function realSpawnKilledDeps(): SpawnKilledDeps {
  return { writeWorkerStatus, killNow, capturePane, captureFailure, captureSpawnFailure, stateArchive, exit: (c) => process.exit(c) };
}

/** The bootstrap-failure sequence for a spawn whose OWN PROCESS is killed mid-ready-wait — the
 *  caller's deadline firing before ours (every Bash-tool default does: 120s < bootstrap_sleep_s +
 *  ready_timeout_s on every provider). Without it the killed spawn left `status.json` frozen at the
 *  seed, no forensics, no archive, and the caller free to read "spawned" as "running" for hours.
 *
 *  Ordered cheapest-and-most-valuable first, because the harness may escalate to SIGKILL after a
 *  grace we cannot measure:
 *    (a) ONE atomic status rename — alone it moves the worker off the `last_event: spawn` seed, so
 *        every reader sees a terminal `error` even if nothing below completes;
 *    (b) kill the pane — BEFORE the archive and never after: stateArchive moves pane.json out of the
 *        topic and every teardown discovers ownership from active topic dirs, so an archived live
 *        pane is unreachable by `stop`/`job stop`/`list`. The id was created by THIS call, so it
 *        cannot be stale (the same justification the timeout path carries);
 *    (c) forensics — the scrollback is captured from an already-killed pane and is usually empty;
 *        that is the accepted price of (b) ordering ahead of it;
 *    (d) archive, then re-raise the signal's own exit code.
 *  Each step is individually guarded: a step that throws must not cost the ones after it. */
export async function spawnKilled(
  ctx: { agent: string; model: string; topic: string; pane: string; readyTimeout: number },
  deps: SpawnKilledDeps,
): Promise<void> {
  const { agent, model, topic, pane } = ctx;
  const step = async (fn: () => void | Promise<void>): Promise<void> => {
    try { await fn(); } catch { /* the steps after this one are worth more than this one's error */ }
  };
  try {
    await step(() => { deps.writeWorkerStatus(agent, model, topic, "error", "spawn-killed"); });
    await step(() => deps.killNow(pane));
    await step(async () => {
      const fr = await deps.captureFailure(
        { agent, model, topic, paneId: pane, reason: "killed", readyTimeout: ctx.readyTimeout },
        { workerDir, capturePane: (p, n) => deps.capturePane(p, n), atomicWriteSync: (d, c) => writeFileSync(d, c), isWritableDir: (d) => existsSync(d), now: () => isoUtc() },
      );
      deps.captureSpawnFailure({
        agent, model, topic, reason: "killed",
        detail: `spawn was killed (SIGTERM) while waiting for {ready,error} (timeout ${ctx.readyTimeout}s)`,
        failureReportPath: fr.ok ? fr.path : undefined,
      });
    });
    await step(() => {
      const arch = deps.stateArchive(agent, model, topic, "FAILED");
      log.error(`${agent} spawn was killed (SIGTERM) during bootstrap; state archived to: ${arch}`);
    });
  } finally {
    deps.exit(SPAWN_KILLED_EXIT);
  }
}

/** Run `body` with a SIGTERM handler installed for exactly its duration, and removed after: a
 *  handler left installed would swallow the default terminate for every later phase of the spawn.
 *  Node suppresses the default SIGTERM action while any listener exists, so `onTerm` MUST end the
 *  process itself (spawnKilled does, in a finally). Fires at most once — a second signal must not
 *  restart a sequence that is already archiving. */
/** The bootstrap-failure sequence for a ready-wait that ended without a `ready`: the pane tail and
 *  the outbox to stderr, forensics, the pane killed, the seed stamped over with the truth, the state
 *  archived — and the EXIT CODE the caller branches on. Split out of `dispatchVerb` for the reason
 *  `spawnKilled` is: `implement spawn-slices` retries rc 3 and falls back on a second one (D2), and
 *  an arm no test can RUN is an arm that can go back to returning 1 with the whole suite green.
 *  Takes `SpawnKilledDeps` — the same side effects, minus the re-raise, in the same order. */
export async function bootstrapFailed(
  ctx: { agent: string; model: string; topic: string; pane: string; readyTimeout: number },
  ev: OutboxEvent | null,
  deps: SpawnKilledDeps,
): Promise<number> {
  const { agent, model, topic, pane, readyTimeout } = ctx;
  const reason = bootstrapFailureReason(ev);
  const tail = await deps.capturePane(pane, 25);
  process.stderr.write(tail + "\n");
  if (!ev) {
    const ob = outboxDump(agent, model, topic).trim();
    if (ob) process.stderr.write(`outbox:\n${ob}\n`);
  }
  const fr = await deps.captureFailure(
    { agent, model, topic, paneId: pane, reason, eventLine: ev ? JSON.stringify(ev) : undefined, readyTimeout },
    { workerDir, capturePane: (p, n) => deps.capturePane(p, n), atomicWriteSync: (d, c) => writeFileSync(d, c), isWritableDir: (d) => existsSync(d), now: () => isoUtc() },
  );
  deps.captureSpawnFailure({
    agent, model, topic, reason,
    detail: bootstrapFailureDetail(ev),
    failureReportPath: fr.ok ? fr.path : undefined,
  });
  await deps.killNow(pane);   // no ownership re-check: this id was created by THIS call, it cannot be stale
  // stamp the truth over the seed: a FAILED archive must not claim a dispatchable state for a worker that never reported (`error` is terminal, so no gate changes)
  deps.writeWorkerStatus(agent, model, topic, "error", "bootstrap-failed");
  const arch = deps.stateArchive(agent, model, topic, "FAILED");
  log.error(`${agent} failed bootstrap (${reason}); state archived to: ${arch}`);
  return bootstrapFailureRc(reason);
}

export async function withSigtermGuard<T>(onTerm: () => void | Promise<void>, body: () => Promise<T>): Promise<T> {
  let fired = false;
  const handler = (): void => { if (fired) return; fired = true; void onTerm(); };
  process.on("SIGTERM", handler);
  try { return await body(); } finally { process.off("SIGTERM", handler); }
}

export async function run(args: string[]): Promise<number> {
  // ONE state tree per run, whatever directory the hub is standing in. Every state path derives from
  // process.cwd() (paths.ts stateRoot + repoHash), and `--cwd` sets only the PANE's start directory
  // (`startDir`) -- it never enters the hash -- so the same spawn issued from the repo root and from
  // inside the run's own worktree wrote identity.md into two different trees, and the worker rightly
  // refused a later nudge naming an inbox its identity did not name. `mainCheckoutRoot` re-roots
  // ap-created run worktrees ONLY and leaves every other path (a user's own worktree included)
  // exactly as git reported it. Outside a git repo repoRoot() falls back to cwd, so this is a no-op.
  return withMainCheckout(() => dispatchVerb(args));
}

async function dispatchVerb(args: string[]): Promise<number> {
  if (args.length < 3) { log.error("usage: spawn <agent|random> <model> <topic> [--mode m] [--cwd abs] [--target-pane id] [--session name] [--role worker|job-hub|slice] [initial-prompt]"); return 2; }
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
  // --session CREATES the session for its first pane (the job hub); every later worker splits inside
  // it from one of its panes — one session, one window. A live session is refused HERE, before any
  // worker state is written, so nothing is left for agentInUse to trip over.
  if (session && await sessionExists(session)) { log.error(`spawn --session '${session}' names a session that already exists; a worker joins a running session by splitting from inside it (run spawn without --session from a pane of that session)`); return 2; }
  // The role selects the identity template, i.e. how much authority the pane is granted. An unknown
  // value must never silently fall back to the permissive one.
  if (role && !isWorkerRole(role)) { log.error(`spawn --role must be one of ${Object.keys(IDENTITY_BLOCKS).join(", ")}; got: '${role}'`); return 2; }

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

  const workerRole = (role || "worker") as WorkerRole;
  log.info(`preparing state for ${agent}-${model} on ${topic}`);
  try {
    prepareWorkerState(agent, model, topic, workerRole);

    const startDir = cwd || repoRoot();
    // The worktree PYTHONPATH pin (src/core/provision.ts): "" unless startDir is a worktree ap created
    // under this checkout AND something in the operator's site-packages resolves the repo from the
    // main checkout. The hub pane (spawned at the root) and an attached --cwd elsewhere stay unpinned;
    // an unsafe entry is named and the worker is launched UNPINNED, which is today's behaviour.
    const pinned = pinReport(repoRoot(), startDir);
    if (pinned.unsafe) log.warn(`spawn: a PYTHONPATH pin for ${startDir} would carry a quote, $, backtick, backslash, newline or colon and cannot be exported safely — the worker is UNPINNED; python in this pane may import the main checkout`);
    const launch = wrapLaunch([binary, ...modeArgs].join(" "), undefined, pinned.pin);
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
      // Detached placement CREATES the session for its FIRST pane (the job hub); a --session naming a
      // live session was refused above, before any state was written. No .last_pane write either:
      // that file is the ATTACHED layout's split-target memory, and this pane is the session's first.
      nonce = randomUUID();
      pane = await newSession(session, launch, startDir);
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
    paneMetaWrite(agent, model, topic, pane, nonce, workerRole);
    log.ok(`spawned ${labelFor(agent, model, topic)} in pane ${pane} (mode=${useMode})`);

    const boot = agentBootstrapSleep(model);
    log.info(`sleeping ${boot}s for ${model} bootstrap`);
    await sleep(boot * 1000);

    log.info(`asking ${agent} to read identity`);
    await paneSend(pane, `Read ${identityPath(agent, model, topic)} and follow its instructions exactly.`);

    log.info(`waiting for {ready,error} in outbox (timeout ${readyTimeout}s)`);
    // Two ways this wait can end early, both of which used to end it in silence: the pane dying
    // during bootstrap (the liveness probe below), and THIS PROCESS being killed by a caller whose
    // deadline is shorter than ours (the SIGTERM guard, which fails the worker closed and re-raises).
    const ev = await withSigtermGuard(
      () => spawnKilled({ agent, model, topic, pane, readyTimeout }, realSpawnKilledDeps()),
      () => readyWait({ agent, model, topic, pane, nonce, readyTimeout }, { wait: outboxWaitSince, paneAlive: paneOwned }),
    );
    if (!ev || ev.event === "error") {
      return await bootstrapFailed({ agent, model, topic, pane, readyTimeout }, ev, realSpawnKilledDeps());
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
