// IO layer over the PURE lesson core (autoresearchMemory.ts) for /ap:autoresearch
// (capability B). This module owns the filesystem: it reads/writes the on-disk
// store and delegates EVERY policy decision (gate, merge, retrieval, render) to
// the pure core. It adds no new policy of its own.
//
// The store lives at `<storeRoot>/<scopeKey(repoHash, metricFamily)>/lessons.jsonl`,
// one JSON Lesson per line. `storeRoot` defaults to `globalRoot()/autoresearch-memory`
// (i.e. `~/.ap/autoresearch-memory`), the same global-root helper the review/
// forensics feeds use, so the store survives per-project teardown + archive.
//
// The filesystem is INJECTED via `MemoryIo` so the whole module is unit-testable
// without touching the real `~/.ap`. `liveMemoryIo` is the node-fs default; tests
// pass a temp-rooted io.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic.js";
import {
  filterLesson,
  mergeLesson,
  renderLesson,
  retrieveLessons,
  scopeKey,
  semanticFingerprint,
  type Lesson,
  type LessonVerdict,
  type MemoryPolicy,
  type ReaderContext,
} from "./autoresearchMemory.js";

/**
 * The only filesystem surface this module touches. Injected so callers (and
 * tests) control where the store lives and how a write lands.
 *  - `exists` / `readFile`: read the JSONL (tolerate a missing file).
 *  - `mkdir`: ensure the scope dir (recursive).
 *  - `writeAtomic`: tmp-in-same-dir + rename (NEVER /tmp then rename — a
 *    cross-device rename is not atomic). The default uses `atomicWrite`.
 */
export interface MemoryIo {
  exists(path: string): boolean;
  readFile(path: string): string;
  mkdir(path: string): void;
  writeAtomic(dest: string, content: string): void;
}

/** Default node-fs io, rooted (by convention) at globalRoot()/autoresearch-memory. */
export const liveMemoryIo: MemoryIo = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  writeAtomic: (dest, content) => atomicWrite(dest, content),
};

/** Absolute path to the lessons.jsonl for one (repo, family) scope. */
function lessonsPath(storeRoot: string, repoHash: string, metricFamily: string): string {
  return join(storeRoot, scopeKey(repoHash, metricFamily), "lessons.jsonl");
}

/** Read every Lesson from a JSONL file. Missing file -> []. Non-JSON / malformed
 *  lines are skipped (defense-in-depth; the store should only ever hold our own
 *  normalized records, but a partial write or manual edit must not crash a read). */
function readLessons(io: MemoryIo, path: string): Lesson[] {
  if (!io.exists(path)) return [];
  let text: string;
  try {
    text = io.readFile(path);
  } catch {
    return [];
  }
  const out: Lesson[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Lesson);
    } catch {
      // skip a malformed line
    }
  }
  return out;
}

/** Serialize a store back to JSONL (one record per line, trailing newline). */
function serialize(store: Lesson[]): string {
  return store.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

export interface WriteLessonsOpts {
  storeRoot: string;
  repoHash: string;
  metricFamily: string;
  /** Raw lesson drafts, one per experiment considered for a write. */
  drafts: any[];
  /** Verifier verdict gating each draft (parallel to `drafts`). */
  verdicts: LessonVerdict[];
  policy: MemoryPolicy;
  now: string; // ISO
}

/**
 * Finalize-time write path. For each (draft, verdict) pair:
 *  1. `filterLesson(draft, verdict, policy, now)` — the PURE write gate. If the
 *     decision is `reject` (failed source / injection token / non-experiment
 *     provenance), the draft is dropped and nothing is written for it.
 *  2. Otherwise the normalized Lesson either merges into an existing record that
 *     shares its `semanticFingerprint` (== its `id`) via `mergeLesson` — which
 *     adds the corroborating run and recomputes reinforcement — or is appended
 *     as a new record.
 *  3. The whole scope file is rewritten ATOMICALLY (tmp-in-same-dir + rename) so
 *     a concurrent reader never sees a torn JSONL.
 *
 * The store is read once, mutated in memory across all drafts (so two
 * corroborating drafts in the SAME finalize merge into one record), and written
 * once at the end — but only if at least one draft survived the gate, so a batch
 * of all-rejected drafts creates no file.
 *
 * This function performs NO policy of its own: it is pure plumbing around the
 * pure core. It does not throw on a rejected draft (rejection is the expected
 * fail-closed outcome).
 */
export function writeLessonsAtFinalize(io: MemoryIo, opts: WriteLessonsOpts): void {
  const { storeRoot, repoHash, metricFamily, drafts, verdicts, policy, now } = opts;
  const path = lessonsPath(storeRoot, repoHash, metricFamily);

  const store = readLessons(io, path);
  // Index by id (== semanticFingerprint) for O(1) merge lookup.
  const byId = new Map<string, number>();
  store.forEach((l, i) => byId.set(l.id, i));

  let mutated = false;
  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const verdict = verdicts[i];
    const gated = filterLesson(draft, verdict, policy, now);
    if (gated.decision === "reject" || !gated.normalized) continue;

    const fp = semanticFingerprint(draft); // == gated.normalized.id
    const at = byId.get(fp);
    if (at !== undefined) {
      store[at] = mergeLesson(store[at], draft, now, policy);
    } else {
      byId.set(fp, store.length);
      store.push(gated.normalized);
    }
    mutated = true;
  }

  if (!mutated) return; // every draft rejected -> create nothing
  io.mkdir(join(storeRoot, scopeKey(repoHash, metricFamily)));
  io.writeAtomic(path, serialize(store));
}

export interface RetrieveOpts {
  storeRoot: string;
  repoHash: string;
  metricFamily: string;
  objective: string;
  direction: "maximize" | "minimize";
  policy: MemoryPolicy;
  now: string; // ISO
  riskBudget?: number;
}

/**
 * Dispatch-time retrieve path. Reads the one scope file (tolerating a missing
 * one), runs the PURE `retrieveLessons` governance (promotion gate, decay,
 * expiry, same-family ABAC, relevance/diversity/risk budget), and maps each
 * surviving lesson through `renderLesson` — the ONLY sanctioned store->prompt
 * path, which emits a fixed data-only template. The result is an array of
 * data-only strings the caller folds into a worker's direction.
 *
 * Cross-repo / cross-family isolation is structural: this only ever reads the
 * scopeKey directory it computed, so a different family/repo reads a different
 * (here: nonexistent) file and gets [].
 */
export function retrieveForDispatch(io: MemoryIo, opts: RetrieveOpts): string[] {
  const { storeRoot, repoHash, metricFamily, objective, direction, policy, now } = opts;
  const path = lessonsPath(storeRoot, repoHash, metricFamily);
  const store = readLessons(io, path);
  if (store.length === 0) return [];

  const ctx: ReaderContext = {
    repoHash,
    metricFamily,
    objective,
    direction,
    riskBudget: opts.riskBudget,
  };
  return retrieveLessons(store, ctx, policy, now).map((l) => renderLesson(l));
}
