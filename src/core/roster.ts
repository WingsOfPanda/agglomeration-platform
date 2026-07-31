// src/core/roster.ts — the shared worker-roster layer for /ap:design and /ap:explore.
// A roster is list.txt (`<provider>\t<agent>` rows) plus everything derived from it: the preflight
// --list arg, the preflight-panes.txt map, the batch spawn + its spawn-results.tsv tally, the
// per-agent cross-verify bucket scope, and the `<tag>=<value>` read-back of a per-phase state file.
// None of it is design-specific — explore, spawn and autoresearch consume the same rows — so it
// lives here rather than in core/design.ts, which keeps only the design-doc pipeline.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./atomic.js";
import { log } from "./log.js";
import { splitNonCommentLines } from "./text.js";

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
