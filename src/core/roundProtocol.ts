// src/core/roundProtocol.ts — the single-worker round protocol: ONE send body and ONE wait body,
// parameterized by a per-command descriptor.
//
// quick's turn-send/turn-wait and bridge's round-send/round-wait were the same twelve statements in
// the same order, differing in ten tokens (dirs, labels, filenames, composers, timeout). The order is
// where the bugs live — gate, then the idempotency refusal, then the offset captured BEFORE the send
// — so it is written once here and every frozen filename and log line lives in the descriptor, which
// keeps the on-disk bytes per command exactly what they were.
//
// implement's turn wait is deliberately NOT a third descriptor: its provider timeout multiplier,
// question payload + OBJECTIONS counter, `.done` marker and verify-report gate would each be a hook
// used by one row. It stays a plain caller of awaitTurn.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import { atomicWrite } from "./atomic.js";
import { readField } from "./fsread.js";
import { recordHubFlag } from "./forensics.js";
import { workerSendGate, type Clock } from "./ipc.js";
import { classifyTurn } from "./turn.js";
import { awaitTurn, recordWaitOutcome, type WaitFn } from "./wait.js";

/** One command's half of the protocol: everything the two bodies below differ in. */
export interface RoundDescriptor {
  /** The forensics command tag a wait's flags are recorded under. */
  command: "quick" | "bridge";
  /** The log/error prefix, e.g. "quick turn-send" / "bridge round-wait". The wait's missing-state
   *  error names the SEND label, so both verbs come from one slot. */
  label(verb: "send" | "wait"): string;
  /** How the send tells a caller to produce the missing identity files, e.g. "run quick init". */
  initHint: string;
  /** The unit `workerSendGate` names when the worker is still busy. */
  gateNoun: "turn" | "round";
  artDir(topic: string): string;
  execDir(topic: string): string;
  stateFile(exec: string, round: number): string;
  promptFile(exec: string, round: number): string;
  /** The round >= 2 input the directive writes, with the wording its absence is reported in. */
  bundle(exec: string, round: number): { path: string; missingWording: string };
  composeFirst(ctx: { art: string; exec: string; topic: string }): string;
  composeFollowup(bundleText: string, round: number): string;
  /** Read through a function, not a value: the env-derived constant stays in the command module,
   *  evaluated exactly when it is today. */
  timeoutS(): number;
  questionFile(exec: string, round: number): string;
}

export interface RoundSendDeps {
  offsetFor(agent: string, model: string, topic: string): number;
  send(args: string[]): Promise<number>;
}

export interface RoundWaitDeps {
  /** Both left unset by the live verb: awaitTurn's defaults are the live wait on the real clock. */
  wait?: WaitFn;
  clock?: Clock;
}

/** Compose this round's prompt and dispatch it. The offset is captured BEFORE the send — a worker
 *  that answers instantly must not have its reply skipped by an offset read after the fact — and a
 *  failed send KEEPS the state file so a retry resumes from the same place. */
export async function sendRound(
  desc: RoundDescriptor, topic: string, round: number, d: RoundSendDeps,
): Promise<number> {
  const art = desc.artDir(topic);
  const exec = desc.execDir(topic);
  const label = desc.label("send");
  const agent = readField(join(art, "agent.txt"));
  const provider = readField(join(art, "selected-provider.txt"));
  if (!agent || !provider) { log.error(`${label}: missing agent.txt/selected-provider.txt (${desc.initHint})`); return 1; }

  if (!workerSendGate(agent, provider, topic, label, desc.gateNoun)) return 1;

  const stateFile = desc.stateFile(exec, round);
  if (existsSync(stateFile)) { log.error(`${label}: ${stateFile} already exists; rm to retry`); return 1; }

  let prompt: string;
  if (round === 1) {
    prompt = desc.composeFirst({ art, exec, topic });
  } else {
    const bundle = desc.bundle(exec, round);
    if (!existsSync(bundle.path)) { log.error(`${label}: ${bundle.missingWording}: ${bundle.path} (the directive must write it first)`); return 1; }
    prompt = desc.composeFollowup(readFileSync(bundle.path, "utf8"), round);
  }

  const promptFile = desc.promptFile(exec, round);
  atomicWrite(promptFile, prompt);
  const offset = d.offsetFor(agent, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);

  const rc = await d.send([agent, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`${label}: send failed (rc=${rc}); ${stateFile} kept for retry`); return 1; }
  log.ok(`${label}: round=${round} offset=${offset}`);
  return 0;
}

/** Wait out this round through awaitTurn's confirmation policy, then record the classification (and
 *  the question payload, whose OFFSET bump awaitTurn's recorder appends so a re-arm resumes past it). */
export async function waitRound(
  desc: RoundDescriptor, topic: string, round: number, d: RoundWaitDeps,
): Promise<number> {
  const art = desc.artDir(topic);
  const exec = desc.execDir(topic);
  const label = desc.label("wait");
  const agent = readField(join(art, "agent.txt"));
  const provider = readField(join(art, "selected-provider.txt"));
  if (!agent || !provider) { log.error(`${label}: missing agent.txt/selected-provider.txt`); return 1; }
  const stateFile = desc.stateFile(exec, round);
  if (!existsSync(stateFile)) { log.error(`${label}: ${stateFile} missing (run ${desc.label("send")} first)`); return 1; }

  const timeoutS = desc.timeoutS();
  const r = await awaitTurn({
    agent, model: provider, topic, stateFile, timeoutS,
    label, policy: { confirm: true },
  }, {
    wait: d.wait, clock: d.clock,
    onArmed: (offset) => { log.info(`${label}: round=${round} offset=${offset} timeout=${timeoutS}s`); },
    onFlag: (note) => { recordHubFlag({ command: desc.command, topic, note }); },
  });
  if ("missingOffset" in r) { log.error(`${label}: OFFSET not set in ${stateFile}`); return 1; }
  const ev = r.event;
  const ts = classifyTurn(ev);
  recordWaitOutcome(agent, provider, topic, stateFile, ts, "TS",
    ev ? { file: desc.questionFile(exec, round), body: JSON.stringify(ev) + "\n" } : undefined);
  log.ok(`${label}: round=${round} TS=${ts}`);
  return 0;
}
