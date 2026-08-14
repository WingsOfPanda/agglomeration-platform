// src/core/design.ts — the design-doc pipeline for /ap:design: art-dir/draft/doc paths, the
// `--ensemble` arg parse, the clean-retry cascade, drilldown out-paths, and the doc export.
// The worker-roster layer it used to carry (list.txt, panes, batch spawn, verify scope, state
// tags) lives in core/roster.ts — it is shared with explore/spawn/autoresearch and not design's.
import { join } from "node:path";
import { existsSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWrite } from "./atomic.js";
import { topicDir } from "./paths.js";
import { WALK_DIRNAME } from "./designWalk.js";
export { deriveSlug } from "./quick.js"; // identical to consult's slug rule; reused, not duplicated

/** `_design` art dir for a topic. */
export function designArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_design");
}
/** Where the per-section drafts live. */
export function designDraftDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(designArtDir(topic, opts), "design-doc", ".draft");
}
/** Where the walk's per-section verdict markers live (siblings of the drafts). */
export function designWalkDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(designArtDir(topic, opts), "design-doc", WALK_DIRNAME);
}

export interface DesignArgs { topicText: string; ensemble: boolean; }

/** Pull the `--ensemble` boolean flag (token-exact) out of the glued $ARGUMENTS. */
export function parseDesignArgs(tokens: string[]): DesignArgs {
  let ensemble = false;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--ensemble") { ensemble = true; continue; }
    rest.push(t);
  }
  return { topicText: rest.join(" "), ensemble };
}

/** Canonical design-doc path: `_design/design-doc/<YYYY-MM-DD>-<topic>-design.md`. */
export function designDocPath(topic: string, dateUtc: string, opts?: { home?: string; cwd?: string }): string {
  return join(designArtDir(topic, opts), "design-doc", `${dateUtc}-${topic}-design.md`);
}

export type ResetPhase = "research" | "verify";
/** Files a clean-retry must invalidate. Globs/files are art-dir relative; workerFile is worker-dir relative.
 *  Behavioral port of the consult offset-reset cascade, generalized to dynamic agents (glob, not hardcoded names). */
export function cascadeTargets(phase: ResetPhase, keepFindings: boolean): { workerFile: "findings.md" | "verify.md"; artGlobs: string[]; artFiles: string[]; } {
  const workerFile = phase === "research" ? "findings.md" : "verify.md";
  if (keepFindings) return { workerFile, artGlobs: [], artFiles: [] };
  if (phase === "research") return { workerFile, artGlobs: ["*_only_items.txt", "*_only.txt", "consensus.txt"], artFiles: ["adjudicated-draft.md", "diff.md"] };
  return { workerFile, artGlobs: [], artFiles: ["adjudicated-draft.md"] };
}

/** Collision-resolved drill output path (port of consult-drilldown.sh resolve_out_path). Strips any
 *  prior `-N` before re-appending `-2..-99`, so re-runs don't compound; throws past 99. */
export function resolveDrilldownPath(scratchDir: string, section: string, agent: string): string {
  const slug = section.toLowerCase().replace(/ /g, "-");
  const base = `drilldown-${slug}-${agent}`;
  let cand = base;
  let n = 2;
  while (existsSync(join(scratchDir, `${cand}.md`))) {
    cand = `${cand.replace(/-[0-9]+$/, "")}-${n}`;
    if (++n > 100) throw new Error("resolveDrilldownPath: too many same-section drilldown collisions");
  }
  return join(scratchDir, `${cand}.md`);
}

/** Canonical export location for a finished design doc: <repoRoot>/docs/ap/specs/<basename>. */
export function designExportDocPath(repoRoot: string, basename: string): string {
  return join(repoRoot, "docs", "ap", "specs", basename);
}

/** Copy the single assembled `*-<topic>-design.md` out of `_design/design-doc/` into
 *  `<destRoot>/docs/ap/specs/`. Returns the dest path, or null if no assembled doc exists
 *  (assemble must have run first). Overwrites on re-run (latest assembled doc wins). */
export function exportDocTo(topic: string, destRoot: string, opts?: { home?: string; cwd?: string }): string | null {
  const ddir = join(designArtDir(topic, opts), "design-doc");
  if (!existsSync(ddir)) return null;
  const hits = readdirSync(ddir).filter((f) => f.endsWith(`-${topic}-design.md`)).sort();
  if (hits.length === 0) return null;
  const basename = hits[hits.length - 1];
  const dest = designExportDocPath(destRoot, basename);
  mkdirSync(join(destRoot, "docs", "ap", "specs"), { recursive: true });
  atomicWrite(dest, readFileSync(join(ddir, basename), "utf8"));
  return dest;
}
