// src/core/slug.ts — the shared state-path-segment validator.
const SLUG = /^[a-z0-9-]+$/;

/** True iff `s` is a safe state-path segment: [a-z0-9-], 1..32 chars. Gate agent/topic values with
 *  this BEFORE they reach topicDir/workerDir joins so a `..` / `/` segment can't traverse out of the
 *  repo state dir. */
export function validateSlug(s: string): boolean {
  return SLUG.test(s) && s.length >= 1 && s.length <= 32;
}
