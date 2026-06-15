// src/core/explore.ts — paths + slug for /ap:explore (port of meditate-init.sh + the
// _meditate art-dir helper). Built on design's bare-slug convention; the _explore suffix
// disambiguates from _design/_autoresearch, so no topic prefix.
import { join } from "node:path";
import { topicDir } from "./paths.js";
export { deriveSlug } from "./quick.js"; // identical slug rule (cap-20); reused, not duplicated

/** `_explore` art dir for a topic. */
export function exploreArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_explore");
}
