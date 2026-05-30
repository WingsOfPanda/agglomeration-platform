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
import {
  type RosterRow, formatRosterFile, parseRosterFile, spawnRosterArg, spawnResultsTsv, spawnTally,
  parsePanesFile, type SpawnResult,
} from "../core/score.js";
import { readProviderList } from "../core/providers.js";
import { activeProvidersPath, repoRoot } from "../core/paths.js";
import { pickInstruments } from "../core/instruments.js";
import { instrumentConsultValidated } from "../core/contracts.js";
import { classifyTopic } from "../core/preludeLit.js";
import { run as spawnRun } from "./spawn.js";
import { run as preflightRun } from "./preflight.js";

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
    case "spawn-all": return spawnAllRun(rest);
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

// ---- spawn-all ----
export interface PreludeSpawnAllDeps {
  preflight(args: string[]): Promise<number>;
  spawn(args: string[]): Promise<number>;
  repoRoot(): string;
}
const livePreludeSpawnAllDeps: PreludeSpawnAllDeps = { preflight: preflightRun, spawn: spawnRun, repoRoot };

async function spawnAllRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: prelude spawn-all <topic>"); return 2; }
  return spawnAllWith(topic, livePreludeSpawnAllDeps);
}

export async function spawnAllWith(topic: string, d: PreludeSpawnAllDeps): Promise<number> {
  const art = preludeArtDir(topic);
  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error(`prelude spawn-all: roster.txt missing at ${rosterPath} (run prelude init)`); return 2; }
  const rows = parseRosterFile(readFileSync(rosterPath, "utf8"));
  if (rows.length < 2) { log.error(`prelude spawn-all: need >=2 parts in roster.txt, got ${rows.length}`); return 2; }

  const pf = await d.preflight([topic, String(rows.length), "--roster", spawnRosterArg(rows), "--art-dir", art]);
  if (pf !== 0) { log.error(`prelude spawn-all: preflight failed (rc=${pf})`); return 2; }

  const panesPath = join(art, "preflight-panes.txt");
  if (!existsSync(panesPath)) { log.error(`prelude spawn-all: preflight wrote no ${panesPath}`); return 2; }
  const panes = parsePanesFile(readFileSync(panesPath, "utf8"));
  const orphans = rows.filter((r) => !panes.has(r.instrument));
  if (orphans.length) { log.error(`prelude spawn-all: parts missing a preflight pane: ${orphans.map((r) => r.instrument).join(", ")}`); return 2; }

  const cwd = d.repoRoot();
  const results: SpawnResult[] = await Promise.all(rows.map(async (r) => {
    const rc = await d.spawn([r.instrument, r.provider, topic, "--target-pane", panes.get(r.instrument)!, "--cwd", cwd]);
    return { instrument: r.instrument, provider: r.provider, rc };
  }));
  atomicWrite(join(art, "spawn-results.tsv"), spawnResultsTsv(results));

  const rc = spawnTally(results.map((r) => r.rc));
  const nOk = results.filter((r) => r.rc === 0).length;
  if (rc === 0) log.ok(`prelude spawn-all: ${nOk}/${rows.length} parts ready`);
  else log.warn(`prelude spawn-all: ${nOk}/${rows.length} parts ready (rc=${rc})`);
  return rc;
}
