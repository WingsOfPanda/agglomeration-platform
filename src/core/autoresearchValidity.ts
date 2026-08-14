// Shell IO for /ap:autoresearch's research-validity verbs (A1 verify, C1 inspect). The adjudication
// itself is pure and lives in autoresearchVerify/autoresearchInspect; this owns what the four verbs
// do around it — the campaign-TSV + per-experiment-sidecar append, the shared result.json read, and
// C1's inspection tally. On-disk formats belong to the row codecs; only the write order lives here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic.js";
import { readIfExists, readJsonOr } from "./fsread.js";
import { experimentDir } from "./autoresearch.js";
import { verificationRow, verificationTsvPath, VERIFICATION_TSV_HEADER, type VerificationRow } from "./autoresearchVerify.js";
import { inspectionRow, inspectionTsvPath, parseInspectionRows, INSPECTION_TSV_HEADER, type InspectionRow } from "./autoresearchInspect.js";

/** How one adjudication row reaches disk: which campaign TSV it extends and which per-experiment
 *  sidecar it stamps. The verification/inspection pair differ only in these five members. */
interface RowSpec<R> {
  tsvPath(art: string): string;
  header: string;
  renderRow(row: R): string;
  sidecarName: string;
  sidecarLine(row: R): string;
}

/** Append `row` to the campaign TSV (header-seeded on first write) then stamp the experiment's
 *  sidecar. Read-or-header before the write, TSV before sidecar — a reader that sees the sidecar
 *  always sees the row. */
function appendRow<R>(art: string, agent: string, expId: string, spec: RowSpec<R>, row: R): void {
  const tsv = spec.tsvPath(art);
  const prior = existsSync(tsv) ? readFileSync(tsv, "utf8") : spec.header;
  atomicWrite(tsv, prior + spec.renderRow(row));
  atomicWrite(join(experimentDir(art, agent, expId), spec.sidecarName), spec.sidecarLine(row));
}

/** A1: record a verify verdict in verification.tsv + the experiment's verification.txt. */
export function appendVerificationRow(art: string, agent: string, expId: string, row: VerificationRow): void {
  appendRow(art, agent, expId, {
    tsvPath: verificationTsvPath, header: VERIFICATION_TSV_HEADER, renderRow: verificationRow,
    sidecarName: "verification.txt",
    sidecarLine: (r) => `${r.verdict} reason=${r.reason} recomputed=${r.recomputed} at ${r.ts}\n`,
  }, row);
}

/** C1: record an inspect verdict in inspection.tsv + the experiment's inspection.txt. */
export function appendInspectionRow(art: string, agent: string, expId: string, row: InspectionRow): void {
  appendRow(art, agent, expId, {
    tsvPath: inspectionTsvPath, header: INSPECTION_TSV_HEADER, renderRow: inspectionRow,
    sidecarName: "inspection.txt",
    sidecarLine: (r) => `${r.verdict} reason=${r.reason} reimpl_metric=${r.reimplMetric} at ${r.ts}\n`,
  }, row);
}

/** The experiment's reported result.json; null when absent or unparseable. */
export function readExperimentResult(art: string, agent: string, expId: string): Record<string, unknown> | null {
  return readJsonOr<Record<string, unknown>>(join(experimentDir(art, agent, expId), "result.json"), null);
}

/** Inspections recorded this campaign (header excluded) — C1's budget counter. */
export function inspectionCount(art: string): number {
  return parseInspectionRows(readIfExists(inspectionTsvPath(art))).length;
}
