import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { topicDir } from "./paths.js";
import { EXP_ID_RE } from "./autoresearchExperiment.js";

/** The lexically-greatest `exp-NNN` directory name in `dir`, or "" when the dir is absent or holds
 *  no experiment dirs. existsSync-guarded to match the two scan sites it replaces (which, by design,
 *  throw if the dir exists but is unreadable). */
export function latestExpDir(dir: string): string {
  let latest = "";
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (EXP_ID_RE.test(name) && name > latest) latest = name;
    }
  }
  return latest;
}

/** The autoresearch art/state dir for a topic: <topicDir>/_autoresearch. Mirrors design's _design. */
export function autoresearchArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_autoresearch");
}

/** <artDir>/workers — the per-worker state root. */
export function workersDir(artDir: string): string {
  return join(artDir, "workers");
}

/** <artDir>/workers/<agent> — one persistent worker's dir (state.txt, experiments/, outbox.jsonl). */
export function workerStateDir(artDir: string, agent: string): string {
  return join(workersDir(artDir), agent);
}

/** <artDir>/workers/<agent>/experiments — the worker's experiment branches. */
export function experimentsDir(artDir: string, agent: string): string {
  return join(workerStateDir(artDir, agent), "experiments");
}

/** <artDir>/workers/<agent>/experiments/<exp-id> — one experiment branch (code/, result.json, …). */
export function experimentDir(artDir: string, agent: string, expId: string): string {
  return join(experimentsDir(artDir, agent), expId);
}

/** Copy config/autoresearch-lib-seed/* into <art>/lib/ (skip-if-exists, never throws).
 *  Behavioral port of the deep-research seed-lib helper. */
export function seedLib(art: string, configRoot: string): void {
  try {
    const seedDir = join(configRoot, "config", "autoresearch-lib-seed");
    if (!existsSync(seedDir)) return;
    const dest = join(art, "lib");
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(seedDir)) {
      const src = join(seedDir, name);
      if (!statSync(src).isFile()) continue;
      const target = join(dest, name);
      if (!existsSync(target)) copyFileSync(src, target);
    }
  } catch { /* best-effort; never fatal to init */ }
}
