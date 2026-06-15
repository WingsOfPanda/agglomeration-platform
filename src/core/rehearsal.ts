import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { topicDir } from "./paths.js";

/** The rehearsal art/state dir for a topic: <topicDir>/_rehearsal. Mirrors score's _score. */
export function rehearsalArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_rehearsal");
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

/** Copy config/rehearsal-lib-seed/* into <art>/lib/ (skip-if-exists, never throws).
 *  Behavioral port of the deep-research seed-lib helper. */
export function seedLib(art: string, configRoot: string): void {
  try {
    const seedDir = join(configRoot, "config", "rehearsal-lib-seed");
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
