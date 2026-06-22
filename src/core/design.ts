// src/core/design.ts
import { join } from "node:path";
import { existsSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWrite } from "./atomic.js";
import { log } from "./log.js";
import { topicDir } from "./paths.js";
import { splitNonCommentLines } from "./text.js";
export { deriveSlug } from "./quick.js"; // identical to consult's slug rule; reused, not duplicated

/** `_design` art dir for a topic. */
export function designArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_design");
}
/** Where the per-section drafts live. */
export function designDraftDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(designArtDir(topic, opts), "design-doc", ".draft");
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

export interface ListRow { provider: string; agent: string; }

/** list.txt body: a generated-comment header + one `<provider>\t<agent>` row per worker. */
export function formatListFile(rows: ListRow[], isoStamp: string): string {
  const body = rows.map((r) => `${r.provider}\t${r.agent}`).join("\n");
  return `# generated ${isoStamp} by /ap:design\n${body}${rows.length ? "\n" : ""}`;
}

/** Parse list.txt: skip #/blank lines; keep rows with both fields.
 *  Consumed by the ensemble path (Phase C reads list.txt back to spawn the workers); not orphaned. */
export function parseListFile(text: string): ListRow[] {
  return splitNonCommentLines(text)
    .map((l) => { const [provider, agent] = l.split("\t"); return { provider, agent }; })
    .filter((r) => r.provider && r.agent) as ListRow[];
}

/** Preflight --list arg from list rows: "<agent>:<provider>,..." (model = provider). */
export function spawnListArg(rows: ListRow[]): string {
  return rows.map((r) => `${r.agent}:${r.provider}`).join(",");
}

export interface SpawnResult { agent: string; provider: string; rc: number; }

/** spawn-results.tsv body: one `<agent>\t<provider>\t<rc>\t<reason>` row per worker (no header;
 *  mirrors spawn-batch.sh). reason is "" on success, "spawn-failed" otherwise. */
export function spawnResultsTsv(results: SpawnResult[]): string {
  if (!results.length) return "";
  return results.map((r) => `${r.agent}\t${r.provider}\t${r.rc}\t${r.rc === 0 ? "" : "spawn-failed"}`).join("\n") + "\n";
}

/** Batch-spawn exit code, ported from spawn-batch.sh: all ok → 0; none ok → 2; partial → 1. */
export function spawnTally(rcs: number[]): 0 | 1 | 2 {
  const ok = rcs.filter((rc) => rc === 0).length;
  if (ok === rcs.length) return 0;
  if (ok === 0) return 2;
  return 1;
}

/** Parse preflight-panes.txt (TSV `<agent>\t<pane>`; skip #/blank) into a map. */
export function parsePanesFile(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of splitNonCommentLines(text)) {
    const [agent, pane] = t.split("\t");
    if (agent && pane) m.set(agent, pane);
  }
  return m;
}

export interface SpawnAllBatchDeps {
  preflight(args: string[]): Promise<number>;
  spawn(args: string[]): Promise<number>;
  repoRoot(): string;
}

/** Shared spawn-all batch body for `design` and `explore` — byte-identical between them except the
 *  art dir and the `label` woven into log/usage strings. Reads list.txt (needs >=2 rows), preflights,
 *  verifies every row got a preflight pane, spawns all in parallel, writes spawn-results.tsv, and
 *  returns the spawn-batch tally (0 all-ready / 1 partial / 2 none). The command modules keep their
 *  own `spawnAllWith(topic, d)` thin wrappers (and their Deps types) so their test surface is intact. */
export async function spawnAllBatch(label: string, topic: string, art: string, d: SpawnAllBatchDeps): Promise<number> {
  const listPath = join(art, "list.txt");
  if (!existsSync(listPath)) { log.error(`${label} spawn-all: list.txt missing at ${listPath} (run ${label} init)`); return 2; }
  const rows = parseListFile(readFileSync(listPath, "utf8"));
  if (rows.length < 2) { log.error(`${label} spawn-all: need >=2 workers in list.txt, got ${rows.length}`); return 2; }

  const pf = await d.preflight([topic, String(rows.length), "--list", spawnListArg(rows), "--art-dir", art]);
  if (pf !== 0) { log.error(`${label} spawn-all: preflight failed (rc=${pf})`); return 2; }

  const panesPath = join(art, "preflight-panes.txt");
  if (!existsSync(panesPath)) { log.error(`${label} spawn-all: preflight wrote no ${panesPath}`); return 2; }
  const panes = parsePanesFile(readFileSync(panesPath, "utf8"));
  const orphans = rows.filter((r) => !panes.has(r.agent));
  if (orphans.length) { log.error(`${label} spawn-all: workers missing a preflight pane: ${orphans.map((r) => r.agent).join(", ")}`); return 2; }

  const cwd = d.repoRoot();
  const results: SpawnResult[] = await Promise.all(rows.map(async (r) => {
    const rc = await d.spawn([r.agent, r.provider, topic, "--target-pane", panes.get(r.agent)!, "--cwd", cwd, "--preflight-art-dir", art]);
    return { agent: r.agent, provider: r.provider, rc };
  }));
  atomicWrite(join(art, "spawn-results.tsv"), spawnResultsTsv(results));

  const rc = spawnTally(results.map((r) => r.rc));
  const nOk = results.filter((r) => r.rc === 0).length;
  if (rc === 0) log.ok(`${label} spawn-all: ${nOk}/${rows.length} workers ready`);
  else log.warn(`${label} spawn-all: ${nOk}/${rows.length} workers ready (rc=${rc})`);
  return rc;
}

/** True iff <agent>\t<pane> appears as a line in a preflight-panes.txt body. This is the
 *  --target-pane membership check; stricter-than-spawn.sh: spawn.sh accepts the pane under ANY
 *  agent (wildcard `^[a-z0-9-]+\t<pane>$`), this requires the pane be listed for THIS
 *  agent so a foreign live pane can never be clobbered. */
export function paneListedFor(panesTsv: string, agent: string, pane: string): boolean {
  return panesTsv.split("\n").some((l) => l === `${agent}\t${pane}`);
}

/** Bucket filenames whose verdicts `target` should verify — every file where target is NOT a member
 *  (port of consult-verify-send.sh): others' `<c>_only_items.txt`, then (N>=3) `<a>+<b>_only.txt` with
 *  target ∉ {a,b}. consensus.txt is always excluded (target is a member). */
export function verifyScopeFiles(target: string, agents: string[]): string[] {
  const out: string[] = [];
  for (const c of agents) if (c !== target) out.push(`${c}_only_items.txt`);
  if (agents.length >= 3) {
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i], b = agents[j];
        if (a !== target && b !== target) out.push(`${a}+${b}_only.txt`);
      }
    }
  }
  return out;
}

/** Last `^<tag>=<value>$` value in a KV state file's text; null if absent. */
export function lastTag(text: string, tag: string): string | null {
  const re = new RegExp(`^${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(.*)$`, "gm");
  const ms = [...text.matchAll(re)];
  return ms.length ? ms[ms.length - 1][1].trim() : null;
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
