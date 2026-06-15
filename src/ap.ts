#!/usr/bin/env node
import { applyArgsFile } from "./args.js";
import { runArgsFile } from "./core/paths.js";
import { renderBannerHead, ansiFromColor } from "./core/colors.js";
import { dispatch, type Handler } from "./core/dispatch.js";

async function loadHandlers(): Promise<Record<string, Handler>> {
  const [spawn, send, collect, list, stop, check, preflight, hook, quick, design, implement, review, autoresearch, explore, bridge] = await Promise.all([
    import("./commands/spawn.js"), import("./commands/send.js"), import("./commands/collect.js"),
    import("./commands/list.js"), import("./commands/stop.js"), import("./commands/check.js"),
    import("./commands/preflight.js"), import("./commands/hook.js"), import("./commands/quick.js"),
    import("./commands/design.js"), import("./commands/implement.js"), import("./commands/review.js"),
    import("./commands/autoresearch.js"), import("./commands/explore.js"), import("./commands/bridge.js"),
  ]);
  return {
    spawn: spawn.run, send: send.run, collect: collect.run, list: list.run,
    stop: stop.run, check: check.run, preflight: preflight.run, hook: hook.run,
    quick: quick.run, design: design.run, implement: implement.run, review: review.run,
    autoresearch: autoresearch.run, explore: explore.run, bridge: bridge.run,
  };
}

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

  const handlers = await loadHandlers();
  const fn = handlers[sub];
  if (!fn) { process.stderr.write(`ap: unknown subcommand '${sub}'\n`); return 2; }
  return dispatch(fn, resolved);
}

main().then((code) => process.exit(code)).catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
