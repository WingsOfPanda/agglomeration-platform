// src/core/explore.ts — paths + slug for /ap:explore (port of meditate-init.sh + the
// _meditate art-dir helper), plus the art-dir file lookups its verbs share. Built on design's
// bare-slug convention; the _explore suffix disambiguates from _design/_autoresearch, so no
// topic prefix. explore keeps its per-worker artifacts art-dir FLAT (`<prefix>-<agent>.md`),
// so "which artifact does this roster row own" is a path question and lives here.
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { topicDir } from "./paths.js";
import { readIfExists } from "./fsread.js";
import type { ListRow } from "./roster.js";
export { deriveSlug } from "./quick.js"; // identical slug rule (cap-20); reused, not duplicated

/** `_explore` art dir for a topic. */
export function exploreArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_explore");
}

/** The final landscape doc (`landscape-<date>-<topic>.md`), newest by name; null when unwritten.
 *  `landscape-draft.md` never matches (the date segment is required). */
export function finalLandscapePath(art: string): string | null {
  let names: string[];
  try { names = readdirSync(art); } catch { return null; }
  const finals = names.filter((f) => /^landscape-\d{4}-\d{2}-\d{2}-.+\.md$/.test(f)).sort();
  return finals.length ? join(art, finals[finals.length - 1]) : null;
}

/** List rows whose `<prefix>-<agent>.md` art file is missing/empty → list of the missing filenames. */
export function missingListArtifacts(art: string, rows: ListRow[], prefix: string): string[] {
  return rows.filter((r) => !readIfExists(join(art, `${prefix}-${r.agent}.md`)).trim()).map((r) => `${prefix}-${r.agent}.md`);
}
