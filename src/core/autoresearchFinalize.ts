// src/core/autoresearchFinalize.ts — the finalize mechanism for /ap:autoresearch (Phase 4->5
// wind-down), faithful to the deep-research finalize script. Every numbered step below is one
// exported helper; commands/autoresearch.ts keeps only `finalizeWith`, which sequences them and
// re-renders session-summary.md. ap adaptations: NO active-marker lifecycle (the bash step 3
// `rm -f active-<sid>.txt` is omitted; hook.ts is a no-op), and the summary is the FULL
// renderSessionSummary rather than the bash partial.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { log } from "./log.js";
import { atomicWrite } from "./atomic.js";
import { readJsonOr, readOr } from "./fsread.js";
import { globalRoot, repoHash } from "./paths.js";
import { experimentsDir, workerStateDir } from "./autoresearch.js";
import { EXP_ID_RE } from "./autoresearchExperiment.js";
import { normalizeResult, type ResultJson } from "./autoresearchResult.js";
import { parseState } from "./autoresearchState.js";
import { parseMetricMd } from "./autoresearchMetric.js";
import { parseVerdicts } from "./autoresearchInfeasible.js";
import { parseInspections, inspectionTsvPath } from "./autoresearchInspect.js";
import { verificationTsvPath } from "./autoresearchVerify.js";
import { metricFamilyOf, lessonVerdictOf, policyFromMetric, buildLessonDraft, type LessonDraft } from "./autoresearchLessonMap.js";
import { writeLessonsAtFinalize, liveMemoryIo, type MemoryIo } from "./autoresearchMemoryStore.js";
import { type LessonVerdict } from "./autoresearchMemory.js";
import { inboxPath, outboxPath, resolveModel } from "./ipc.js";

type PathOpts = { home?: string; cwd?: string };

const HC_RE = /^\s*([a-z_]+)\s*=\s*([0-9]+(?:\.[0-9]+)?)\b/;
/** Bytes per GiB — the size-warning threshold is configured in GiB, computed by the caller. */
export const GIB = 1073741824;

export interface AutoresearchFinalizeDeps {
  now(): string;
  keepIntermediate?: boolean;
  sizeWarnGb?: number;
  stdout?: (l: string) => void;
  opts?: PathOpts;
  // M2 cross-run memory WRITE seams (best-effort tail step). All optional; the live
  // path leaves them undefined so the node-fs defaults apply. A test injects a temp
  // store root (+ optionally a throwing io) to exercise the write without touching ~/.ap.
  memoryIo?: MemoryIo;
  memoryStoreRoot?: string;
  repoHash?: string;
}

/** Phase case-map: working/stale/stuck/blocked->incomplete; idle/complete->complete; else null (no write). */
export function finalizePhase(cur: string): "incomplete" | "complete" | null {
  if (cur === "working" || cur === "stale" || cur === "stuck" || cur === "blocked") return "incomplete";
  if (cur === "idle" || cur === "complete") return "complete";
  return null;
}

/** Extract numeric key=value mandates from the **Hard constraints:** block (until the next blank line). */
export function parseHardConstraints(promptMd: string): { key: string; value: string }[] {
  const lines = promptMd.split("\n");
  const start = lines.findIndex((l) => l.trim() === "**Hard constraints:**");
  if (start < 0) return [];
  const out: { key: string; value: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") break;
    const m = HC_RE.exec(lines[i]);
    if (m) out.push({ key: m[1], value: m[2] });
  }
  return out;
}

/** List the exp-NNN dirs directly under a worker's experiments root (ENOENT-safe). Every step
 *  below walks `agents x listExpDirs`; `resume`'s ledger backfill reuses the same walk. */
export function listExpDirs(expsRoot: string): string[] {
  try {
    return readdirSync(expsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && EXP_ID_RE.test(e.name))
      .map((e) => e.name).sort();
  } catch { return []; }
}

/** Recursive byte size (sum of regular-file sizes) under dir. */
function dirByteSize(dir: string): number {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirByteSize(p);
    else if (e.isFile()) { try { total += statSync(p).size; } catch { /* skip */ } }
  }
  return total;
}

/** Count regular files at depth 1 of dir. */
function fileCountDepth1(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch { return 0; }
}

/** Step 4: enforce status/metric_value joint validity per exp (normalize_result). */
export function normalizeResults(art: string, agents: string[]): void {
  for (const agent of agents) {
    const expsRoot = experimentsDir(art, agent);
    for (const expId of listExpDirs(expsRoot)) {
      const resultPath = join(expsRoot, expId, "result.json");
      const parsed = readJsonOr<ResultJson>(resultPath, null);
      if (parsed === null) continue;
      const norm = normalizeResult(parsed);
      if (norm.status !== parsed.status || norm.metric_value !== parsed.metric_value) {
        atomicWrite(resultPath, JSON.stringify(norm));
        log.info(`normalize: ${agent}/${expId} -> ${norm.status}`);
      }
    }
  }
}

/** Step 5: prune intermediate checkpoints (caller guards with !keep). */
export function pruneIntermediate(art: string, agents: string[]): void {
  for (const agent of agents) {
    const expsRoot = experimentsDir(art, agent);
    for (const expId of listExpDirs(expsRoot)) {
      const expDir = join(expsRoot, expId);
      const r = readJsonOr<{ checkpoint_path?: unknown }>(join(expDir, "result.json"), null);
      if (r === null) continue;
      const keptRel = r.checkpoint_path != null ? String(r.checkpoint_path) : "";
      if (!keptRel || keptRel === "null") continue;
      // Resolve relative to the exp dir; reject paths that escape it.
      const keptAbs = resolve(expDir, keptRel);
      if (keptAbs !== expDir && !keptAbs.startsWith(expDir + "/")) {
        log.warn(`prune: checkpoint_path escapes exp dir: ${keptRel} (in ${expDir}); skipping`);
        continue;
      }
      let entries: string[];
      try { entries = readdirSync(expDir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith(".pt")) continue;
        const pt = join(expDir, name);
        if (pt === keptAbs) continue;
        try { if (statSync(pt).isFile()) rmSync(pt, { force: true }); } catch { /* best-effort */ }
      }
    }
  }
}

/** Step 6: link pane artifacts (relative symlinks of outbox/inbox into the art tree). */
export function linkPaneArtifacts(art: string, agents: string[], topic: string): void {
  for (const agent of agents) {
    const model = resolveModel(agent, topic);
    if (!model) continue;
    const targetDir = workerStateDir(art, agent);
    mkdirSync(targetDir, { recursive: true });
    const paneFiles: Array<[string, string]> = [
      ["outbox.jsonl", outboxPath(agent, model, topic)],
      ["inbox.md", inboxPath(agent, model, topic)],
    ];
    for (const [name, src] of paneFiles) {
      if (!existsSync(src)) { log.warn(`link_pane_artifacts: pane file missing for ${agent}: ${name}`); continue; }
      const linkPath = join(targetDir, name);
      const rel = relative(targetDir, src);
      try {
        try { if (lstatSync(linkPath)) unlinkSync(linkPath); } catch { /* nothing to replace */ }
        symlinkSync(rel, linkPath);
      } catch { /* best-effort */ }
    }
  }
}

/** Step 7: compute size warnings (post-prune); TRUNCATE warnings.txt first. */
export function computeSizeWarnings(art: string, agents: string[], threshold: number): void {
  const warningsPath = join(art, "warnings.txt");
  const sizeLines: string[] = [];
  for (const agent of agents) {
    const expsRoot = experimentsDir(art, agent);
    for (const expId of listExpDirs(expsRoot)) {
      const expDir = join(expsRoot, expId);
      const bytes = dirByteSize(expDir);
      if (bytes >= threshold) {
        const gb = (bytes / GIB).toFixed(1);
        sizeLines.push(`size_warn\t${agent}/${expId}\t${gb}\t${fileCountDepth1(expDir)}`);
      }
    }
  }
  atomicWrite(warningsPath, sizeLines.length ? sizeLines.join("\n") + "\n" : "");
}

/** Step 8: audit diff — append audit_warn rows for prompt/audit knob mismatches (AFTER size). */
export function computeAuditWarnings(art: string, agents: string[], warningsPath: string): void {
  const auditLines: string[] = [];
  for (const agent of agents) {
    const expsRoot = experimentsDir(art, agent);
    for (const expId of listExpDirs(expsRoot)) {
      const expDir = join(expsRoot, expId);
      const promptMd = join(expDir, "prompt.md");
      const auditJson = join(expDir, "audit.json");
      if (!existsSync(promptMd)) continue;
      const audit = readJsonOr<Record<string, unknown>>(auditJson, null);
      if (audit === null) continue;
      for (const { key, value } of parseHardConstraints(readFileSync(promptMd, "utf8"))) {
        const actual = audit[key];
        if (actual == null || String(actual) === "null") continue;
        if (String(value) !== String(actual)) {
          auditLines.push(`audit_warn\t${agent}/${expId}\t${key}\tprompt=${value}  actual=${String(actual)}`);
        }
      }
    }
  }
  if (auditLines.length) {
    const existing = readOr(warningsPath);
    atomicWrite(warningsPath, existing + auditLines.join("\n") + "\n");
  }
}

/**
 * M2 — finalize-time cross-run memory WRITE (best-effort, NON-FATAL).
 *
 * Walks `agents x listExpDirs` (mirroring computeAuditWarnings), turning each ok
 * experiment whose A1/C1 verifier confirmed a positive into a lesson draft, then
 * does ONE governed `writeLessonsAtFinalize` per metric family. EVERY error is
 * swallowed: this helper can NEVER throw into finalize, change its return code,
 * or touch any existing finalize output. An unknown metric family or an empty
 * draft set is a silent no-op. The whole body is inside one try/catch.
 */
export function writeFinalizeLessons(art: string, agents: string[], deps: AutoresearchFinalizeDeps): void {
  try {
    const thresholds = parseMetricMd(readOr(join(art, "metric.md")));
    const family = metricFamilyOf(thresholds.primaryMetric);
    if (!family) return; // unknown / outside taxonomy -> skip (fail-closed, no lessons)

    const direction: "maximize" | "minimize" = thresholds.direction ?? "maximize";
    const a1 = parseVerdicts(readOr(verificationTsvPath(art)));
    const c1 = parseInspections(readOr(inspectionTsvPath(art)));
    const now = deps.now();

    const drafts: LessonDraft[] = [];
    const verdicts: LessonVerdict[] = [];

    for (const agent of agents) {
      const expsRoot = experimentsDir(art, agent);
      for (const expId of listExpDirs(expsRoot)) {
        const expDir = join(expsRoot, expId);
        const r = readJsonOr<ResultJson>(join(expDir, "result.json"), null);
        if (r === null) continue;
        if (r.status !== "ok" || r.metric_value == null) continue;

        const key = `${agent}/${expId}`;
        const verdict = lessonVerdictOf(a1[key], c1[key]);
        if (!verdict) continue; // not a confirmed positive -> no lesson

        // Resolve the parent (baseline) metric from this exp's lineage.txt parent_id.
        let parentMetric: number | null = null;
        const parentId = (parseState(readOr(join(expDir, "lineage.txt"))).parent_id ?? "").trim();
        if (parentId) {
          const pr = readJsonOr<ResultJson>(join(expsRoot, parentId, "result.json"), null);   // absent/garbled -> rootless draft
          if (pr && pr.metric_value != null) parentMetric = pr.metric_value;
        }

        // Operator recorded at dispatch (phase-A wiring); absent file keeps the
        // improve/draft default inside buildLessonDraft.
        const operator = (parseState(readOr(join(expDir, "operator.txt"))).operator ?? "").trim() || undefined;

        drafts.push(buildLessonDraft({
          approachLabel: r.approach_label,
          metricName: r.metric_name,
          metricValue: r.metric_value,
          parentMetric,
          direction,
          family,
          operator,
          runId: expId,   // result.json has no run_id; the exp-id is the per-run identity
          expId,
          verdict,
          createdTs: now,
        }));
        verdicts.push(verdict);
      }
    }

    if (!drafts.length) return;

    writeLessonsAtFinalize(deps.memoryIo ?? liveMemoryIo, {
      storeRoot: deps.memoryStoreRoot ?? join(globalRoot(), "autoresearch-memory"),
      repoHash: deps.repoHash ?? repoHash(),
      metricFamily: family,
      drafts,
      verdicts,
      policy: policyFromMetric(thresholds),
      now,
    });
  } catch (e) {
    // best-effort: a memory-write failure must NEVER fail finalize.
    log.error(`finalize: lesson-write skipped (best-effort): ${String(e)}`);
  }
}

/** Step 9 (render input): warnings.txt text -> the summary's Warnings bullet lines. Faithful to
 *  render_summary's Warnings section — unknown leading fields are dropped, not rendered. */
export function renderWarningLines(warningsText: string): string[] {
  const warnings: string[] = [];
  for (const line of warningsText.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f[0] === "size_warn") {
      warnings.push(`- size_warn: ${f[1]} ${f[2]} GB (${f[3]} files)`);
    } else if (["audit_warn", "sanity", "lineage", "reimpl"].includes(f[0])) {
      warnings.push(`- ${f[0]}: ${f[1]} ${f[2]} (${f[3]})`);
    }
  }
  return warnings;
}
