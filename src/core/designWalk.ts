// src/core/designWalk.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Port of consult_audit_issue_to_section (lib/consult-walk.sh:18-33). Section name | "ASK" | "" (unknown). */
export function auditIssueToSection(key: string): string {
  switch (key) {
    case "no_goal_section": return "goal";
    case "no_arch_section": return "architecture";
    case "no_testing_section": return "testing";
    case "no_success_section": return "success-criteria";
    case "tbd_marker": case "todo_marker": case "fill_in_later_marker": case "to_be_determined_marker": return "ASK";
    case "unresolved_placeholder": return "architecture";
    default: return "";
  }
}

/** The walk's verdict markers live in `design-doc/.walk/<section>.state`, beside `.draft/`. */
export const WALK_DIRNAME = ".walk";
export const WALK_VERDICTS = ["approved", "skipped"] as const;
export type WalkVerdict = (typeof WALK_VERDICTS)[number];

/** A marker's verdict word, or null when it is absent/garbage. Only the walk writes these files
 *  (via `design walk-approve`, which validates first), so garbage means hand-surgery — and an
 *  unreadable verdict is not a verdict: the section stays unsettled. */
export function parseWalkVerdict(text: string): WalkVerdict | null {
  const v = text.trim();
  return (WALK_VERDICTS as readonly string[]).includes(v) ? (v as WalkVerdict) : null;
}

export interface SectionStatus { name: string; status: WalkVerdict; }

/** The sections the walk has SETTLED, by their recorded markers (sorted). A drafted-but-unmarked
 *  section is pending and simply absent — the draft file is the walk's input, never its verdict
 *  (a seeded `.draft/` used to read as six approvals before the walk had run). Missing dir → []. */
export function walkSectionState(dir: string): string[];
export function walkSectionState(dir: string, opts: { withStatus: true }): SectionStatus[];
export function walkSectionState(dir: string, opts?: { withStatus?: boolean }): string[] | SectionStatus[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".state")); }
  catch { return []; }
  const settled: SectionStatus[] = [];
  for (const f of files.sort()) {
    const status = parseWalkVerdict(readFileSync(join(dir, f), "utf8"));
    if (status) settled.push({ name: f.replace(/\.state$/, ""), status });
  }
  return opts?.withStatus ? settled : settled.map((s) => s.name);
}
