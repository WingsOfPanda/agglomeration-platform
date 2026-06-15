// src/core/prelude.ts — paths + slug for /ap:prelude (port of meditate-init.sh + the
// _meditate art-dir helper). Built on score's bare-slug convention; the _prelude suffix
// disambiguates from _score/_rehearsal, so no topic prefix.
import { join } from "node:path";
import { topicDir } from "./paths.js";
export { deriveSlug } from "./solo.js"; // identical slug rule (cap-20); reused, not duplicated

/** `_prelude` art dir for a topic. */
export function preludeArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_prelude");
}
