// src/commands/score.ts
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc } from "../core/archive.js";
import {
  deriveSlug, parseScoreArgs, scoreArtDir, scoreDraftDir,
  formatRosterFile, type RosterRow,
} from "../core/score.js";
import { readProviderList } from "../core/providers.js";
import { activeProvidersPath } from "../core/paths.js";
import { instrumentConsultValidated } from "../core/contracts.js";
import { pickInstruments } from "../core/instruments.js";

function usage(): number { log.error("usage: score <init|assemble> ..."); return 2; }

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest));
    case "assemble": return assembleRun(rest);
    default: return usage();
  }
}

export interface ScoreInitDeps {
  activeProviders(): string[];
  isValidated(provider: string): boolean;
  pickInstruments(topic: string, n: number): string[];
}
const liveInitDeps: ScoreInitDeps = {
  activeProviders: () => readProviderList(activeProvidersPath()),
  isValidated: instrumentConsultValidated,
  pickInstruments,
};

async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, liveInitDeps); }

export async function initWith(tokens: string[], d: ScoreInitDeps): Promise<number> {
  const { topicText, ensemble, targets } = parseScoreArgs(tokens);
  if (!topicText) { log.error("score init: topic text is empty"); return 1; }
  const topic = deriveSlug(topicText);
  if (!topic) { log.error("score init: topic produced an empty slug; provide alphanumerics"); return 1; }

  let roster = d.activeProviders().filter((p) => d.isValidated(p));
  if (roster.length < 2) {
    log.error(`score init: needs >=2 consult-validated providers; got ${roster.length}`);
    log.error("  just ask Claude directly (this session) — no /consort:score orchestration needed");
    return 1;
  }
  if (roster.length > 3) { log.warn(`score init: ${roster.length} providers available; capping the ensemble to the first 3`); roster = roster.slice(0, 3); }

  const art = scoreArtDir(topic);
  if (existsSync(art)) { log.error(`score init: topic already in flight: ${art}`); log.error("  run /consort:coda or pick a different topic"); return 2; }

  const instruments = d.pickInstruments(topic, roster.length);
  if (instruments.length < roster.length) { log.error(`score init: instrument pool exhausted (need ${roster.length}, got ${instruments.length})`); return 1; }
  const rows: RosterRow[] = roster.map((provider, i) => ({ provider, instrument: instruments[i] }));

  mkdirSync(scoreDraftDir(topic), { recursive: true }); // creates _score/design-doc/.draft
  atomicWrite(join(art, "topic.txt"), topicText);
  atomicWrite(join(art, "roster.txt"), formatRosterFile(rows, isoUtc()));
  const mode = targets.length >= 2 ? "multi" : targets.length === 1 ? "single-sub" : "single";
  atomicWrite(join(art, "multi-repo.txt"), mode + "\n");
  if (targets.length > 0) atomicWrite(join(art, "targets.txt"), `# generated ${isoUtc()} by /consort:score\n${targets.join("\n")}\n`);

  log.ok(`score init: topic=${topic} N=${rows.length} ensemble=${ensemble ? "yes" : "no"} mode=${mode}`);
  process.stdout.write(
    `TOPIC=${topic}\nN=${rows.length}\nENSEMBLE=${ensemble ? "yes" : "no"}\nMODE=${mode}\n` +
    rows.map((r) => `PART=${r.instrument}:${r.provider}`).join("\n") + "\n",
  );
  return 0;
}

// assembleRun lands in Task 4.
async function assembleRun(_rest: string[]): Promise<number> { return 0; }
