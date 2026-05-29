// src/commands/solo.ts
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";

function usage(): number {
  log.error("usage: solo <init|branch|turn-send|turn-wait|detect-test|finish|summary> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest));
    case "branch": return branchRun(rest);
    case "turn-send": return turnSendRun(rest);
    case "turn-wait": return turnWaitRun(rest);
    case "detect-test": return detectTestRun(rest);
    case "finish": return finishRun(rest);
    case "summary": return summaryRun(rest);
    default: return usage();
  }
}

// Handlers are filled in by later tasks. Stubs keep the dispatcher compilable.
async function initRun(_a: string[]): Promise<number> { log.error("solo init: not implemented"); return 2; }
async function branchRun(_a: string[]): Promise<number> { log.error("solo branch: not implemented"); return 2; }
async function turnSendRun(_a: string[]): Promise<number> { log.error("solo turn-send: not implemented"); return 2; }
async function turnWaitRun(_a: string[]): Promise<number> { log.error("solo turn-wait: not implemented"); return 2; }
async function detectTestRun(_a: string[]): Promise<number> { log.error("solo detect-test: not implemented"); return 2; }
async function finishRun(_a: string[]): Promise<number> { log.error("solo finish: not implemented"); return 2; }
async function summaryRun(_a: string[]): Promise<number> { log.error("solo summary: not implemented"); return 2; }
