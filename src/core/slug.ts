// src/core/slug.ts — the shared state-path-segment validator.
const SLUG = /^[a-z0-9-]+$/;

/** True iff `s` is a safe state-path segment: [a-z0-9-], 1..32 chars. Gate agent/topic values with
 *  this BEFORE they reach topicDir/workerDir joins so a `..` / `/` segment can't traverse out of the
 *  repo state dir. */
export function validateSlug(s: string): boolean {
  return SLUG.test(s) && s.length >= 1 && s.length <= 32;
}

/** A refused path segment. `code = 2` (usage), like KvError — dispatch renders it as one stderr
 *  line, never a stack. */
export class SlugError extends Error { code = 2; }

/** Return `s` iff it is a safe path segment, else throw. The containment gate: topicDir/workerDir
 *  call it for every art dir, and the few verbs that spell an `agent` into a filename THEMSELVES
 *  (inside an already-resolved art dir, where workerDir never sees it) call it on their own arg. */
export function assertSlug(kind: "topic" | "agent", s: string): string {
  if (!validateSlug(s)) throw new SlugError(`${kind} must match [a-z0-9-]+ and be <= 32 chars; got: '${s}'`);
  return s;
}
