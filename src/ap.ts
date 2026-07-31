#!/usr/bin/env node
import { applyArgsFile } from "./args.js";
import { runArgsFile } from "./core/paths.js";
import { renderBannerHead, ansiFromColor } from "./core/colors.js";
import { dispatch, type Handler } from "./core/dispatch.js";

// One dynamic-import thunk per verb: only the dispatched subcommand's module is loaded. Eagerly
// importing all 15 initialized 14 unused ones on every invocation (~21 ms on the always-on `ap hook`).
const LOADERS: Record<string, () => Promise<{ run: Handler }>> = {
  spawn: () => import("./commands/spawn.js"), send: () => import("./commands/send.js"), collect: () => import("./commands/collect.js"),
  list: () => import("./commands/list.js"), stop: () => import("./commands/stop.js"), check: () => import("./commands/check.js"),
  preflight: () => import("./commands/preflight.js"), hook: () => import("./commands/hook.js"), quick: () => import("./commands/quick.js"),
  design: () => import("./commands/design.js"), implement: () => import("./commands/implement.js"), review: () => import("./commands/review.js"),
  autoresearch: () => import("./commands/autoresearch.js"), explore: () => import("./commands/explore.js"), bridge: () => import("./commands/bridge.js"),
};

async function banner(label: string, color: string): Promise<number> {
  process.stdout.write(renderBannerHead(label, color) + "\n");
  const c = ansiFromColor(color);
  const r = "\x1b[0m";
  const fast = Boolean(process.env.AP_BANNER_FAST);
  for (let i = 8; i >= 1; i--) {
    process.stdout.write(`  ${c}Closing in ${i} second${i === 1 ? "" : "s"}...${r}\r`);
    if (!fast) await new Promise((res) => setTimeout(res, 1000));
  }
  process.stdout.write(`  ${c}Closed.                          ${r}\n`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub) { process.stderr.write("ap: missing subcommand\n"); return 2; }
  if (sub === "_banner") return banner(rest[0] ?? "worker", rest[1] ?? "");

  // --mint-args-file: the command directives' step 1
  if (rest.includes("--mint-args-file")) { process.stdout.write(runArgsFile(sub) + "\n"); return 0; }

  let resolved: string[];
  try { resolved = applyArgsFile(rest); }
  catch (e: any) { process.stderr.write(`${e.message ?? e}\n`); return e.code ?? 2; }

  const loader = LOADERS[sub];
  if (!loader) { process.stderr.write(`ap: unknown subcommand '${sub}'\n`); return 2; }
  return dispatch((await loader()).run, resolved);
}

main().then((code) => process.exit(code)).catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
