import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { topicDir } from "./paths.js";

/** The rehearsal art/state dir for a topic: <topicDir>/_rehearsal. Mirrors score's _score. */
export function rehearsalArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_rehearsal");
}

/** <artDir>/parts — the per-part state root. */
export function partsDir(artDir: string): string {
  return join(artDir, "parts");
}

/** <artDir>/parts/<instrument> — one persistent part's dir (state.txt, experiments/, outbox.jsonl). */
export function partStateDir(artDir: string, instrument: string): string {
  return join(partsDir(artDir), instrument);
}

/** <artDir>/parts/<instrument>/experiments — the part's experiment branches. */
export function experimentsDir(artDir: string, instrument: string): string {
  return join(partStateDir(artDir, instrument), "experiments");
}

/** <artDir>/parts/<instrument>/experiments/<exp-id> — one experiment branch (code/, result.json, …). */
export function experimentDir(artDir: string, instrument: string, expId: string): string {
  return join(experimentsDir(artDir, instrument), expId);
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
