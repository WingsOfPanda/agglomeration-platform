// src/commands/prelude.ts — /consort:prelude CLI verbs (port of meditate). Built on score's DI
// pattern + IPC/wait/archive helpers; meditate-specific logic lives in src/core/prelude*.ts.
// NOTE: verbs are added task-by-task; the dispatcher's switch grows as each verb lands.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc } from "../core/archive.js";
import { preludeArtDir, deriveSlug } from "../core/prelude.js";
import { type RosterRow, formatRosterFile } from "../core/score.js";
import { readProviderList } from "../core/providers.js";
import { activeProvidersPath } from "../core/paths.js";
import { pickInstruments } from "../core/instruments.js";
import { instrumentConsultValidated } from "../core/contracts.js";
import { classifyTopic } from "../core/preludeLit.js";

function usage(): number {
  log.error("usage: prelude <init|classify|spawn-all|research-send|research-wait|synth-preliminary|" +
    "confidence|adversary-send|adversary-wait|synth-final|forensics|teardown|handoff-extract> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest));
    case "classify": return classifyRun(rest);
    default: return usage();
  }
}

const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

// ---- init ----

export interface PreludeInitDeps {
  activeProviders(): string[];
  isValidated(provider: string): boolean;
  pickInstruments(topic: string, n: number): string[];
}
const livePreludeInitDeps: PreludeInitDeps = {
  activeProviders: () => readProviderList(activeProvidersPath()),
  isValidated: instrumentConsultValidated,
  pickInstruments,
};
async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, livePreludeInitDeps); }

export async function initWith(tokens: string[], d: PreludeInitDeps): Promise<number> {
  const topicText = tokens.join(" ").trim();
  if (!topicText) { log.error("prelude init: topic text is empty"); return 1; }
  const topic = deriveSlug(topicText);
  if (!topic) { log.error("prelude init: topic produced an empty slug; provide alphanumerics"); return 1; }

  let roster = d.activeProviders().filter((p) => d.isValidated(p));
  if (roster.length < 2) {
    log.error(`prelude init: needs >=2 consult-validated providers; got ${roster.length}`);
    log.error("  just ask Claude directly (this session) — no /consort:prelude orchestration needed");
    return 1;
  }
  if (roster.length > 3) { log.warn(`prelude init: ${roster.length} providers available; capping to the first 3`); roster = roster.slice(0, 3); }

  const art = preludeArtDir(topic);
  if (existsSync(art)) { log.error(`prelude init: topic already in flight: ${art}`); log.error("  run /consort:coda or pick a different topic"); return 2; }

  const instruments = d.pickInstruments(topic, roster.length);
  if (instruments.length < roster.length) { log.error(`prelude init: instrument pool exhausted (need ${roster.length}, got ${instruments.length})`); return 1; }
  const rows: RosterRow[] = roster.map((provider, i) => ({ provider, instrument: instruments[i] }));

  mkdirSync(art, { recursive: true });
  atomicWrite(join(art, "topic.txt"), topicText);
  atomicWrite(join(art, "roster.txt"), formatRosterFile(rows, isoUtc()));

  log.ok(`prelude init: topic=${topic} N=${rows.length}`);
  process.stdout.write(
    `TOPIC=${topic}\nN=${rows.length}\nART=${art}\n` +
    rows.map((r) => `PART=${r.instrument}:${r.provider}`).join("\n") + "\n",
  );
  return 0;
}

// ---- classify (lit auto-detect) ----
export async function classifyRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: prelude classify <topic>"); return 2; }
  const art = preludeArtDir(topic);
  if (!existsSync(art)) { log.error(`prelude classify: ${art} not found (run prelude init)`); return 1; }
  const topicText = readIf(join(art, "topic.txt")).trim();
  const track = classifyTopic(topicText);
  atomicWrite(join(art, "lit-track.txt"), `${track}\nreason: auto-detect via keyword scan\n`);
  log.ok(`prelude classify: lit-track=${track}`);
  return 0;
}
