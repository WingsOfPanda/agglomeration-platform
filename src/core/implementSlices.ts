// src/core/implementSlices.ts — the pure slice core of a fanned-out `implement` run
// (docs/superpowers/specs/2026-09-04-parallel-slices-design.md, B / F / G): the plan parser, the
// slice-plan parser, the check that refuses a grouping, the `slices.tsv` roster, and the two texts
// the hub hands a worker (a slice's mandate, the absorb turn's ISSUES block).
//
// Everything here is pure except `readSlices` / `writeSlices`: the plan, the slice plan and the
// slice reports arrive as TEXT and the two environment questions (which agents are free, does this
// path exist in the run worktree) arrive as injected callbacks, so the five verbs on top stay thin
// adapters and the whole layer is testable without a pane, a worktree or a git call.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { atomicWrite } from "./atomic.js";
import { sliceBranchFor } from "./branchRecord.js";
import { fileShaped } from "./implementScope.js";
import { validateSlug } from "./slug.js";
import { splitNonCommentLines } from "./text.js";

/** Hard ceiling on concurrent slices (D11). A code CONSTANT, not an env var and not a flag: an
 *  operator-tunable count is still the operator choosing the split. Six is where a detached
 *  session's windows, the box's codex processes and the disk for seven worktrees stop being free;
 *  it moves by a code change with a dogfood behind it. */
export const MAX_SLICES = 6;

/** The closed reason set `abandon-slice` accepts (F). Closed so `abandoned:<reason>` in the roster
 *  stays a value the gate and the absorb turn can branch on. */
export const ABANDON_REASONS = ["spawn-failed", "turn-failed", "pane-died", "objection"] as const;
export type AbandonReason = (typeof ABANDON_REASONS)[number];

/** A roster row's lifecycle: `planned -> spawned | failed-spawn -> done | abandoned:<reason>`. */
export type SliceStatus = "planned" | "spawned" | "failed-spawn" | "done" | `abandoned:${AbandonReason}`;

/** One `### T<n>:` task of the lead's plan.md. `files` is verbatim — no normalisation, because a
 *  token this parser silently repaired would be compared as something the worker never wrote. */
export interface PlanTask { id: string; title: string; files: string[]; depends: string[]; }
/** The lead's `## Slices` proposal — its VIEW of what can run concurrently. The hub decides. */
export interface SlicesProposal { prelude: string[]; slices: string[][]; }
export type PlanParse =
  | { ok: true; tasks: PlanTask[]; proposal: SlicesProposal | null }
  | { ok: false; reason: string };

/** A decided slice: the hub's label, the task ids it owns, and the union of those tasks' files. */
export interface SliceGroup { label: string; tasks: string[]; files: string[]; }
/** slice-plan.md as written: the prelude's ids and one group per `## slice <label>`. */
export interface SlicePlan { prelude: string[]; slices: { label: string; tasks: string[] }[]; }

/** A `slices.tsv` row. `status` and `model` are the two columns that change over the run. */
export interface SliceRow { agent: string; model: string; label: string; status: SliceStatus; tasks: string[]; files: string[]; }
/** An `integrate-<round>.tsv` row: merged | conflict | empty | skipped:<why>. */
export interface IntegrateRow { agent: string; label: string; status: string; }

const TASK_HEAD = /^###\s+(T\d+):\s*(.*)$/;
const H2 = /^##\s+(.*)$/;
const ANY_HEAD = /^#{1,6}\s/;
const OUT_OF_SLICE = /^#{1,6}\s+Out-of-slice changes needed\b/i;
const GLOB = /[*?[]/;

function unquote(s: string): string { return s.trim().replace(/^`(.*)`$/, "$1").trim(); }
function commaList(v: string): string[] { return v.split(",").map(unquote).filter(Boolean); }
function semiList(v: string): string[] { return v.split(";").map(unquote).filter(Boolean); }
/** An id list where the literal `none` means "empty" (`depends: none`, `prelude: none`). */
function idList(v: string): string[] { return v.trim().toLowerCase() === "none" ? [] : commaList(v); }

/** Parse the lead's plan.md into tasks plus its `## Slices` proposal.
 *
 *  Strict on the two machine-readable lines (`files:` / `depends:`, exactly one each per task) and
 *  loose on everything else: the free-text scope prose under a task is skipped, an absent
 *  `## Slices` section yields `proposal: null` (the hub can still group). A failure names the
 *  OFFENDING LINE, because the only consumer of the refusal is a grill turn asking the lead to
 *  rewrite the plan, and "unparseable" without the line is not something a worker can act on. */
export function parsePlanTasks(text: string): PlanParse {
  const fail = (what: string): PlanParse => ({ ok: false, reason: `PLAN_UNPARSEABLE=${what}` });
  const tasks: PlanTask[] = [];
  const proposal: SlicesProposal = { prelude: [], slices: [] };
  let sawSlices = false;
  let inSlices = false;
  let cur: { id: string; title: string; head: string; files: string[] | null; depends: string[] | null } | null = null;

  /** Push the open task, or return the reason it cannot be pushed. */
  const close = (): string | null => {
    const c = cur;
    if (!c) return null;
    if (c.files === null) return `${c.head} (no files: line)`;
    if (c.depends === null) return `${c.head} (no depends: line)`;
    tasks.push({ id: c.id, title: c.title, files: c.files, depends: c.depends });
    cur = null;
    return null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const th = TASK_HEAD.exec(line);
    if (th) {
      const err = close();
      if (err) return fail(err);
      if (tasks.some((t) => t.id === th[1])) return fail(`${line} (duplicate task id)`);
      inSlices = false;
      cur = { id: th[1], title: th[2].trim(), head: line, files: null, depends: null };
      continue;
    }
    const h2 = H2.exec(line);
    if (h2) {
      const err = close();
      if (err) return fail(err);
      inSlices = /^slices$/i.test(h2[1].trim());
      if (inSlices) sawSlices = true;
      continue;
    }
    if (cur) {
      const f = /^files:\s*(.*)$/i.exec(line);
      if (f) {
        if (cur.files !== null) return fail(`${line} (second files: line for ${cur.id})`);
        cur.files = commaList(f[1]);
        continue;
      }
      const d = /^depends:\s*(.*)$/i.exec(line);
      if (d) {
        if (cur.depends !== null) return fail(`${line} (second depends: line for ${cur.id})`);
        cur.depends = idList(d[1]);
      }
      continue;
    }
    if (!inSlices) continue;
    const p = /^prelude:\s*(.*)$/i.exec(line);
    if (p) { proposal.prelude = idList(p[1]); continue; }
    const s = /^slice:\s*(.*)$/i.exec(line);
    if (s) proposal.slices.push(idList(s[1]));
  }
  const err = close();
  if (err) return fail(err);
  if (!tasks.length) return fail("no ### T<n>: task heading");
  return { ok: true, tasks, proposal: sawSlices ? proposal : null };
}

/** Parse the hub's slice-plan.md. Structural only — every rule (assignment, labels, empty groups)
 *  is `checkSlicePlan`'s, so a malformed grouping produces a NAMED refusal rather than a parse
 *  error the grill turn cannot read. A `## slice` with no label parses to the empty label, which
 *  the label rule then refuses. */
export function parseSlicePlan(text: string): SlicePlan {
  const out: SlicePlan = { prelude: [], slices: [] };
  let cur: { label: string; tasks: string[] } | null = null;
  let inPrelude = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const h2 = H2.exec(line);
    if (h2) {
      const head = h2[1].trim();
      const s = /^slice\b\s*(.*)$/i.exec(head);
      cur = null;
      inPrelude = false;
      if (s) { cur = { label: unquote(s[1]), tasks: [] }; out.slices.push(cur); }
      else inPrelude = /^prelude$/i.test(head);
      continue;
    }
    const t = /^tasks:\s*(.*)$/i.exec(line);
    if (!t) continue;
    if (cur) cur.tasks.push(...idList(t[1]));
    else if (inPrelude) out.prelude.push(...idList(t[1]));
  }
  return out;
}

export interface CheckSliceInput {
  /** plan.md as written by the plan (or grill) turn. */
  plan: string;
  /** slice-plan.md as decided by the hub. */
  slicePlan: string;
  /** What `slices.tsv` already holds — the re-entry guard's input. */
  existingRows: SliceRow[];
  /** `pickAgents(topic, n)`, injected: it is random per call and reads the state dir. */
  agentsFor(n: number): string[];
  /** Does this repo-relative path exist in the run worktree? Warn-only. */
  fileExists(relPath: string): boolean;
}
export type CheckSliceResult =
  | { ok: true; slices: SliceGroup[]; prelude: string[]; agents: string[]; warnings: string[] }
  | { ok: false; refusals: string[]; warnings: string[] };

/** Check the hub's grouping against the lead's plan. Fail-closed and EXHAUSTIVE: every refusal the
 *  input earns is reported in one pass, because the refusal lines go verbatim into the grill turn
 *  and a lead that re-cuts against one refusal at a time costs a turn per defect.
 *
 *  Two refusals are fatal-early instead, since nothing after them is meaningful: `SLICES_EXIST`
 *  (a re-entered check would re-run `pickAgents` and rename live workers out of the roster every
 *  later verb reads) and an unparseable plan. */
export function checkSlicePlan(inp: CheckSliceInput): CheckSliceResult {
  const warnings: string[] = [];
  if (inp.existingRows.some((r) => r.status !== "planned")) return { ok: false, refusals: ["SLICES_EXIST"], warnings };

  const plan = parsePlanTasks(inp.plan);
  if (!plan.ok) return { ok: false, refusals: [plan.reason], warnings };

  const refusals: string[] = [];
  const sp = parseSlicePlan(inp.slicePlan);
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));

  // Files: a glob compared as a literal would never overlap anything, so two slices would edit the
  // same paths with the check green. Absence is only a warning — the task may create the file.
  for (const t of plan.tasks) {
    for (const tok of t.files) {
      if (isAbsolute(tok) || GLOB.test(tok) || !fileShaped(tok)) refusals.push(`BADFILE=${t.id}:${tok}`);
      else if (!inp.fileExists(tok)) warnings.push(`MISSING=${t.id}:${tok}`);
    }
  }

  // Assignment: every plan task in exactly one group, every named id in the plan. -1 = the prelude.
  const groupOf = new Map<string, number>();
  const counts = new Map<string, number>();
  const assign = (id: string, gi: number) => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!groupOf.has(id)) groupOf.set(id, gi);
  };
  for (const id of sp.prelude) assign(id, -1);
  sp.slices.forEach((s, i) => { for (const id of s.tasks) assign(id, i); });
  for (const t of plan.tasks) if (!counts.has(t.id)) refusals.push(`UNASSIGNED=${t.id}`);
  for (const [id, n] of counts) if (n > 1) refusals.push(`DUPLICATE=${id}`);
  for (const id of counts.keys()) if (!byId.has(id)) refusals.push(`UNKNOWN=${id}`);

  // Labels and group shape.
  const seenLabels = new Set<string>();
  for (const s of sp.slices) {
    if (!validateSlug(s.label) || s.label.length > 16) refusals.push(`BADLABEL=${s.label}`);
    else if (seenLabels.has(s.label)) refusals.push(`DUPLICATE_LABEL=${s.label}`);
    seenLabels.add(s.label);
    if (!s.tasks.length) refusals.push(`EMPTY_SLICE=${s.label}`);
  }
  if (sp.slices.length > MAX_SLICES) refusals.push(`TOO_MANY=${sp.slices.length}`);

  // Dependencies: a prelude task may depend only on prelude tasks; a slice task on prelude tasks or
  // its own slice. Anything else would have one worker waiting on another worker's tree.
  for (const t of plan.tasks) {
    const gt = groupOf.get(t.id);
    if (gt === undefined) continue; // already UNASSIGNED
    for (const d of t.depends) {
      const gd = groupOf.get(d);
      if (gd === -1) continue;
      if (gd === undefined || gd !== gt) refusals.push(`DEP=${t.id}->${d}`);
    }
  }

  // Overlap, slice-to-slice only: the PRELUDE is exempt because it runs to completion before any
  // slice worktree is forked, so a prelude file is nobody's concurrent write.
  const groups: SliceGroup[] = sp.slices.map((s) => ({
    label: s.label,
    tasks: s.tasks,
    files: [...new Set(s.tasks.flatMap((id) => byId.get(id)?.files ?? []))],
  }));
  const seenOverlap = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      for (const a of groups[i].files) {
        for (const b of groups[j].files) {
          if (!pathsOverlap(a, b)) continue;
          const line = `OVERLAP=${groups[i].label}:${groups[j].label}:${a}`;
          if (!seenOverlap.has(line)) { seenOverlap.add(line); refusals.push(line); }
        }
      }
    }
  }

  // The agent pool is asked only once the grouping stands: `pickAgents` is random per call, and a
  // count nobody will spawn is not worth a roster read.
  let agents: string[] = [];
  if (!refusals.length && groups.length) {
    agents = inp.agentsFor(groups.length);
    if (agents.length < groups.length) refusals.push(`AGENTS_SHORT=${agents.length}`);
  }

  if (refusals.length) return { ok: false, refusals, warnings };
  return { ok: true, slices: groups, prelude: sp.prelude, agents, warnings };
}

/** Do two declared paths name overlapping work? Equal, one UNDER the other, or one CONTAINING the
 *  other — containment only through an explicit directory token (trailing `/`), which is why
 *  `fileShaped` is the BADFILE gate: an extension-less `src` would otherwise be an ambiguous token
 *  that contains nothing. Two files in one directory are NOT an overlap; two workers editing
 *  sibling files is the whole point of the fan-out. */
function pathsOverlap(a: string, b: string): boolean {
  // Compared NORMALIZED though every token is stored and reported verbatim: `./src/a.ts` and
  // `src/a.ts` are one file, and two slices owning it with the check green is the exact hole the
  // BADFILE rule exists to close. `normalize` keeps the trailing `/` that makes a token a
  // directory, so the containment clause below reads the same tokens it always did.
  const x = normalize(a), y = normalize(b);
  if (x === y) return true;
  return under(x, y) || under(y, x);
}
function under(child: string, dir: string): boolean {
  return dir.endsWith("/") && child.startsWith(dir);
}

/** Read `slices.tsv`; [] when absent. Rows short of the four fixed columns are skipped, the way
 *  `parseListFile` drops a half-written roster row rather than materialising an empty agent. */
export function readSlices(path: string): SliceRow[] {
  if (!existsSync(path)) return [];
  return splitNonCommentLines(readFileSync(path, "utf8"))
    .map((l) => {
      const [agent, model, label, status, tasks, files] = l.split("\t");
      return { agent, model, label, status: status as SliceStatus, tasks: commaList(tasks ?? ""), files: semiList(files ?? "") };
    })
    .filter((r) => r.agent && r.model && r.label && r.status);
}

/** Write `slices.tsv` atomically — every verb that changes a `status` rewrites the whole file, and
 *  a torn roster is a run whose later verbs cannot tell which workers are live. */
export function writeSlices(path: string, rows: SliceRow[]): void {
  const body = rows.map((r) => [r.agent, r.model, r.label, r.status, r.tasks.join(","), r.files.join(";")].join("\t")).join("\n");
  atomicWrite(path, rows.length ? `${body}\n` : "");
}

export interface AbsorbInput {
  topic: string;
  rows: SliceRow[];
  integrate: IntegrateRow[];
  /** A slice's `verify-report-<agent>-<round>.md`; "" when it wrote none. */
  reportTextFor(agent: string): string;
  planTasks: PlanTask[];
}

/** The absorb turn's ISSUES block (G): what the slices LEFT, as three tagged item kinds. "" when
 *  they left nothing, which is the directive's signal to skip the turn entirely.
 *
 *  The out-of-slice scan covers every SPAWNED row — merged, conflicted and abandoned alike. A
 *  conflicted slice's request is exactly the one the turn is about to merge by hand, so skipping it
 *  would drop the changes the conflict is about. */
export function absorbIssues(inp: AbsorbInput): string {
  const titles = new Map(inp.planTasks.map((t) => [t.id, t.title]));
  const integrateOf = new Map(inp.integrate.map((r) => [r.agent, r.status]));
  const out: string[] = [];

  for (const r of inp.rows) {
    const ist = integrateOf.get(r.agent) ?? "";
    const reason = r.status.startsWith("abandoned:") ? r.status
      : ist === "empty" || ist.startsWith("skipped") ? ist
        : "";
    if (!reason) continue;
    const named = r.tasks.map((id) => (titles.has(id) ? `${id} "${titles.get(id)}"` : id)).join(", ");
    out.push(`- [slice] tasks ${named} (slice ${r.label}) were not implemented (${reason}): implement them per plan.md`);
  }
  for (const r of inp.integrate) {
    if (r.status !== "conflict") continue;
    const b = sliceBranchFor(inp.topic, r.agent);
    out.push(`- [integration] ${b} (slice ${r.label}) conflicts with this branch — run \`git merge ${b}\`, resolve keeping both intents, commit`);
  }
  for (const r of inp.rows) {
    if (r.status === "planned" || r.status === "failed-spawn") continue;
    for (const line of outOfSliceLines(inp.reportTextFor(r.agent))) {
      // G's `<file:line>` field. The worker is TOLD to lead its item with the file and line, so the
      // field is split off the report's own text rather than re-derived; a line that carries none
      // keeps the field absent rather than inventing a location the worker never named.
      const m = /^(\S+:\d+)\s*(?:[-—:]\s*)?(.*)$/.exec(line);
      out.push(`- [spec-gap] ${m ? `${m[1]} — ` : ""}out-of-slice change requested by slice ${r.label}: ${m ? m[2] : line}`);
    }
  }
  return out.join("\n");
}

/** The lines under a slice report's `## Out-of-slice changes needed`, bullet markers stripped, up
 *  to the next heading of any level. */
function outOfSliceLines(report: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const raw of report.split("\n")) {
    const line = raw.trim();
    if (OUT_OF_SLICE.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    if (ANY_HEAD.test(line)) break;
    if (!line) continue;
    out.push(line.replace(/^[-*+]\s+/, ""));
  }
  return out;
}

/** `slice-<agent>.md`: the mandate the slice worker's inbox task points at — its label, its tasks
 *  with the plan's titles, and its files as ABSOLUTE paths under its own worktree, so a worker that
 *  reads only this file cannot address a path in the run tree or a peer's. */
export function sliceMandate(slice: SliceGroup, planTasks: PlanTask[], sliceWorktree: string): string {
  const titles = new Map(planTasks.map((t) => [t.id, t.title]));
  const lines = [`# Slice ${slice.label}`, "", "## Tasks (from plan.md)"];
  for (const id of slice.tasks) lines.push(`- ${id}: ${titles.get(id) ?? "(not in plan.md)"}`);
  lines.push("", "## Files you own (absolute, in your worktree)");
  for (const f of slice.files) lines.push(`- ${join(sliceWorktree, f)}`); // join keeps a directory token's trailing slash
  return `${lines.join("\n")}\n`;
}
