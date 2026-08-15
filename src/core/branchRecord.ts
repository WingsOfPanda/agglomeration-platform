// src/core/branchRecord.ts — a run's branch: one spelling, one reader.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readField, kvField } from "./fsread.js";

export type BranchCommand = "quick" | "implement" | "bridge";

/** The one place `feat/<command>-<topic>` is spelled. An empty topic yields the command's branch
 *  PREFIX, which is what bridge's single-occupancy check matches against. */
export function branchNameFor(command: BranchCommand, topic: string): string {
  return `feat/${command}-${topic}`;
}

export interface BranchRecord {
  /** Where the run started — the branch a finish restores and PRs into. */
  startBranch: string;
  baseSha: string;
  /** The branch the run ended up on, as its own branch step recorded it. */
  branch: string;
  mode: "branch" | "no-branch" | "in-place";
}

/** implement's `<slug>\t<branch>` map; "" when the file or the slug's row is absent. */
function branchMapField(map: string, slug: string): string {
  if (!existsSync(map)) return "";
  for (const line of readFileSync(map, "utf8").split("\n")) { const [s, b] = line.split("\t"); if (s === slug) return b ?? ""; }
  return "";
}

/** What a run recorded about its branch, over the three genuinely different on-disk layouts: quick
 *  and bridge write single-line files under `execute/` (only bridge has a mode, its `--in-place`
 *  flag), implement writes per-slug rows under its art dir and needs the slug to find them. `dir` is
 *  the state dir the caller already holds — implement's art dir is opts-dependent, so it is passed
 *  in rather than re-derived here.
 *  Every field is the raw record, "" when absent: each consumer words its own default ("main",
 *  "unknown", "(none)"), and this reader must not pick one for them. A mode file that predates the
 *  record reads as `branch` — that is the mode those runs used, and reading a missing file as
 *  no-branch/in-place is exactly the silent no-op the mode record exists to end. */
export function readBranchRecord(command: "quick" | "bridge", ctx: { dir: string }): BranchRecord;
export function readBranchRecord(command: "implement", ctx: { dir: string; slug: string }): BranchRecord;
export function readBranchRecord(command: BranchCommand, ctx: { dir: string; slug?: string }): BranchRecord {
  if (command === "implement") {
    const slug = ctx.slug ?? "";
    return {
      startBranch: kvField(join(ctx.dir, "baselines", `${slug}.tsv`), "branch"),
      baseSha: readField(join(ctx.dir, "branch-base.sha")),
      branch: branchMapField(join(ctx.dir, "implement-branches.tsv"), slug),
      mode: readField(join(ctx.dir, "branch-mode.txt")) === "no-branch" ? "no-branch" : "branch",
    };
  }
  return {
    startBranch: readField(join(ctx.dir, "start-branch.txt")),
    baseSha: readField(join(ctx.dir, "branch-base.sha")),
    branch: readField(join(ctx.dir, "branch.txt")),
    mode: command === "bridge" && readField(join(ctx.dir, "mode.txt")) === "in-place" ? "in-place" : "branch",
  };
}
