// tests/implement-slices.test.ts — the pure slice core (2026-09-04-parallel-slices-design.md B/F/G).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ABANDON_REASONS, MAX_SLICES, absorbIssues, checkSlicePlan, parsePlanTasks, parseSlicePlan,
  readSlices, sliceMandate, writeSlices,
  type CheckSliceInput, type IntegrateRow, type PlanTask, type SliceRow,
} from "../src/core/implementSlices.js";

function doc(...lines: string[]): string { return lines.join("\n") + "\n"; }

/** A two-task plan: T1 (prelude-shaped, nothing depends on it by default) and T2 depending on T1. */
const PLAN = doc(
  "# Plan", "",
  "### T1: add the gate kind",
  "files: src/core/gate.ts, src/core/gateKinds.ts",
  "depends: none",
  "the scope prose the parser skips",
  "",
  "### T2: shard schema",
  "files: src/core/shard.ts",
  "depends: T1",
  "",
  "## Slices",
  "prelude: T1",
  "slice: T2",
);

function planOf(...tasks: string[][]): string {
  const out: string[] = ["# Plan", ""];
  for (const [id, title, files, depends] of tasks.map((t) => t as [string, string, string, string])) {
    out.push(`### ${id}: ${title}`, `files: ${files}`, `depends: ${depends}`, "");
  }
  return out.join("\n");
}
function slicePlanOf(prelude: string, ...slices: [string, string][]): string {
  const out = ["# Slice plan", "## prelude", `tasks: ${prelude}`];
  for (const [label, tasks] of slices) out.push(`## slice ${label}`, `tasks: ${tasks}`);
  return out.join("\n") + "\n";
}
function check(plan: string, slicePlan: string, over: Partial<CheckSliceInput> = {}) {
  return checkSlicePlan({
    plan, slicePlan, existingRows: [], agentsFor: (n) => ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"].slice(0, n),
    fileExists: () => true, ...over,
  });
}
function refusals(r: ReturnType<typeof check>): string[] { return r.ok ? [] : r.refusals; }

describe("parsePlanTasks", () => {
  it("parses tasks with files, depends and the ## Slices proposal", () => {
    const p = parsePlanTasks(PLAN);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.tasks).toEqual([
      { id: "T1", title: "add the gate kind", files: ["src/core/gate.ts", "src/core/gateKinds.ts"], depends: [] },
      { id: "T2", title: "shard schema", files: ["src/core/shard.ts"], depends: ["T1"] },
    ]);
    expect(p.proposal).toEqual({ prelude: ["T1"], slices: [["T2"]] });
  });
  it("strips backticks from file tokens and accepts `prelude: none`", () => {
    const p = parsePlanTasks(doc("### T1: t", "files: `src/a.ts`", "depends: none", "## Slices", "prelude: none", "slice: T1"));
    expect(p.ok && p.tasks[0].files).toEqual(["src/a.ts"]);
    expect(p.ok && p.proposal).toEqual({ prelude: [], slices: [["T1"]] });
  });
  it("proposal is null when the plan has no ## Slices section", () => {
    const p = parsePlanTasks(planOf(["T1", "t", "src/a.ts", "none"]));
    expect(p.ok && p.proposal).toBeNull();
  });
  it("PLAN_UNPARSEABLE when there is no ### T<n>: heading at all", () => {
    const p = parsePlanTasks(doc("# Plan", "prose only"));
    expect(p).toEqual({ ok: false, reason: "PLAN_UNPARSEABLE=no ### T<n>: task heading" });
  });
  it("PLAN_UNPARSEABLE names the heading line when a task has no files: line", () => {
    const p = parsePlanTasks(doc("### T1: t", "depends: none"));
    expect(p.ok).toBe(false);
    expect(!p.ok && p.reason).toBe("PLAN_UNPARSEABLE=### T1: t (no files: line)");
  });
  it("PLAN_UNPARSEABLE when a task has no depends: line", () => {
    const p = parsePlanTasks(doc("### T1: t", "files: src/a.ts"));
    expect(!p.ok && p.reason).toBe("PLAN_UNPARSEABLE=### T1: t (no depends: line)");
  });
  it("PLAN_UNPARSEABLE names the offending line on a second files: line", () => {
    const p = parsePlanTasks(doc("### T1: t", "files: src/a.ts", "files: src/b.ts", "depends: none"));
    expect(!p.ok && p.reason).toBe("PLAN_UNPARSEABLE=files: src/b.ts (second files: line for T1)");
  });
  it("PLAN_UNPARSEABLE on a duplicate task id", () => {
    const p = parsePlanTasks(planOf(["T1", "a", "src/a.ts", "none"], ["T1", "b", "src/b.ts", "none"]));
    expect(!p.ok && p.reason).toBe("PLAN_UNPARSEABLE=### T1: b (duplicate task id)");
  });
  it("a task ends at the next H2, so ## Slices lines are never read as a task body", () => {
    const p = parsePlanTasks(doc("### T1: t", "files: src/a.ts", "depends: none", "## Slices", "slice: T1", "files: src/nope.ts"));
    expect(p.ok && p.tasks[0].files).toEqual(["src/a.ts"]);
  });
});

describe("parseSlicePlan", () => {
  it("parses the prelude and one group per ## slice <label>", () => {
    expect(parseSlicePlan(slicePlanOf("T1, T2", ["wp3", "T3, T5"], ["wp4", "T4"]))).toEqual({
      prelude: ["T1", "T2"],
      slices: [{ label: "wp3", tasks: ["T3", "T5"] }, { label: "wp4", tasks: ["T4"] }],
    });
  });
  it("`tasks: none` is an empty group, not a parse error", () => {
    expect(parseSlicePlan(slicePlanOf("none", ["wp3", "none"]))).toEqual({ prelude: [], slices: [{ label: "wp3", tasks: [] }] });
  });
  it("an absent ## prelude section is an empty prelude", () => {
    expect(parseSlicePlan(doc("## slice wp3", "tasks: T1")).prelude).toEqual([]);
  });
  it("a ## slice with no label parses to the empty label (the label rule refuses it)", () => {
    expect(parseSlicePlan(doc("## slice", "tasks: T1")).slices).toEqual([{ label: "", tasks: ["T1"] }]);
  });
  it("a tasks: line outside any group is ignored", () => {
    expect(parseSlicePlan(doc("# Slice plan", "tasks: T9", "## slice wp3", "tasks: T1"))).toEqual({
      prelude: [], slices: [{ label: "wp3", tasks: ["T1"] }],
    });
  });
});

describe("checkSlicePlan — the ok arm", () => {
  it("returns the decided groups, the prelude, the agents and no refusals", () => {
    const r = check(PLAN, slicePlanOf("T1", ["wp2", "T2"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slices).toEqual([{ label: "wp2", tasks: ["T2"], files: ["src/core/shard.ts"] }]);
    expect(r.prelude).toEqual(["T1"]);
    expect(r.agents).toEqual(["alpha"]);
    expect(r.warnings).toEqual([]);
  });
  it("a slice's files are the deduped union of its tasks' files", () => {
    const plan = planOf(["T1", "a", "src/a.ts, src/shared.ts", "none"], ["T2", "b", "src/shared.ts, src/b.ts", "none"]);
    const r = check(plan, slicePlanOf("none", ["wp1", "T1, T2"]));
    expect(r.ok && r.slices[0].files).toEqual(["src/a.ts", "src/shared.ts", "src/b.ts"]);
  });
  it("zero slices (everything in the prelude) is ok — the directive takes the serial path", () => {
    const r = check(planOf(["T1", "a", "src/a.ts", "none"]), doc("## prelude", "tasks: T1"));
    expect(r.ok && r.slices).toEqual([]);
    expect(r.ok && r.agents).toEqual([]);
  });
});

describe("checkSlicePlan — refusals", () => {
  it("SLICES_EXIST when any existing row is past `planned`, and nothing else is reported", () => {
    const rows: SliceRow[] = [{ agent: "alpha", model: "codex", label: "wp2", status: "spawned", tasks: ["T2"], files: [] }];
    const r = check("garbage", "garbage", { existingRows: rows });
    expect(refusals(r)).toEqual(["SLICES_EXIST"]);
  });
  it("an all-`planned` roster is NOT a re-entry refusal", () => {
    const rows: SliceRow[] = [{ agent: "alpha", model: "codex", label: "wp2", status: "planned", tasks: ["T2"], files: [] }];
    expect(check(PLAN, slicePlanOf("T1", ["wp2", "T2"]), { existingRows: rows }).ok).toBe(true);
  });
  it("PLAN_UNPARSEABLE is fatal-early: no other refusal is reported", () => {
    expect(refusals(check(doc("no tasks here"), slicePlanOf("none", ["wp1", "T1"])))).toEqual(["PLAN_UNPARSEABLE=no ### T<n>: task heading"]);
  });
  it("BADFILE for a glob, an absolute path, and a token that is not file-shaped", () => {
    const plan = planOf(["T1", "a", "tests/*.ts", "none"], ["T2", "b", "/etc/passwd", "none"], ["T3", "c", "src/core", "none"]);
    expect(refusals(check(plan, slicePlanOf("none", ["wp1", "T1, T2, T3"])))).toEqual([
      "BADFILE=T1:tests/*.ts", "BADFILE=T2:/etc/passwd", "BADFILE=T3:src/core",
    ]);
  });
  it("a trailing-slash directory token is file-shaped and passes BADFILE", () => {
    expect(check(planOf(["T1", "a", "src/core/", "none"]), slicePlanOf("none", ["wp1", "T1"])).ok).toBe(true);
  });
  it("UNASSIGNED for a plan task in no group", () => {
    expect(refusals(check(PLAN, slicePlanOf("T1")))).toEqual(["UNASSIGNED=T2"]);
  });
  it("DUPLICATE for a task assigned twice", () => {
    expect(refusals(check(PLAN, slicePlanOf("T1", ["wp1", "T2"], ["wp2", "T2"])))).toContain("DUPLICATE=T2");
  });
  it("UNKNOWN for a grouped id that is not in the plan", () => {
    expect(refusals(check(PLAN, slicePlanOf("T1", ["wp2", "T2, T9"])))).toEqual(["UNKNOWN=T9"]);
  });
  it("DEP when a slice task depends on a task in another slice", () => {
    const plan = planOf(["T1", "a", "src/a.ts", "none"], ["T2", "b", "src/b.ts", "T1"]);
    expect(refusals(check(plan, slicePlanOf("none", ["wp1", "T1"], ["wp2", "T2"])))).toEqual(["DEP=T2->T1"]);
  });
  it("DEP when a prelude task depends on a slice task", () => {
    const plan = planOf(["T1", "a", "src/a.ts", "T2"], ["T2", "b", "src/b.ts", "none"]);
    expect(refusals(check(plan, slicePlanOf("T1", ["wp2", "T2"])))).toEqual(["DEP=T1->T2"]);
  });
  it("DEP when the depended-on id is in no group at all", () => {
    const plan = planOf(["T1", "a", "src/a.ts", "T9"]);
    expect(refusals(check(plan, slicePlanOf("none", ["wp1", "T1"])))).toEqual(["DEP=T1->T9"]);
  });
  it("a slice task may depend on a prelude task, and on a task in its own slice", () => {
    const plan = planOf(["T1", "a", "src/a.ts", "none"], ["T2", "b", "src/b.ts", "T1"], ["T3", "c", "src/c.ts", "T2"]);
    expect(check(plan, slicePlanOf("T1", ["wp1", "T2, T3"])).ok).toBe(true);
  });
  it("EMPTY_SLICE for a group with no tasks", () => {
    expect(refusals(check(PLAN, slicePlanOf("T1, T2", ["wp1", "none"])))).toEqual(["EMPTY_SLICE=wp1"]);
  });
  it("BADLABEL for a non-slug label, an over-16-char label, and an empty label", () => {
    const plan = planOf(["T1", "a", "src/a.ts", "none"], ["T2", "b", "src/b.ts", "none"], ["T3", "c", "src/c.ts", "none"]);
    const sp = doc("## slice Work Package", "tasks: T1", "## slice seventeen-chars-x", "tasks: T2", "## slice", "tasks: T3");
    expect(refusals(check(plan, sp))).toEqual(["BADLABEL=Work Package", "BADLABEL=seventeen-chars-x", "BADLABEL="]);
  });
  it("a 16-char slug label is accepted", () => {
    const sp = doc("## prelude", "tasks: none", "## slice sixteen-chars-x", "tasks: T1");
    expect("sixteen-chars-x".length + 1).toBe(16);
    expect(check(planOf(["T1", "a", "src/a.ts", "none"]), sp).ok).toBe(true);
  });
  it("DUPLICATE_LABEL when two groups share a label", () => {
    const plan = planOf(["T1", "a", "src/a.ts", "none"], ["T2", "b", "src/b.ts", "none"]);
    expect(refusals(check(plan, slicePlanOf("none", ["wp1", "T1"], ["wp1", "T2"])))).toEqual(["DUPLICATE_LABEL=wp1"]);
  });
  it("TOO_MANY above MAX_SLICES", () => {
    const n = MAX_SLICES + 1;
    const tasks = Array.from({ length: n }, (_, i) => [`T${i + 1}`, `t${i}`, `src/f${i}.ts`, "none"]);
    const groups = tasks.map((t, i) => [`wp${i}`, t[0]] as [string, string]);
    const r = check(planOf(...tasks), slicePlanOf("none", ...groups));
    expect(refusals(r)).toEqual([`TOO_MANY=${n}`]);
  });
  it("exactly MAX_SLICES slices is accepted", () => {
    const tasks = Array.from({ length: MAX_SLICES }, (_, i) => [`T${i + 1}`, `t${i}`, `src/f${i}.ts`, "none"]);
    const groups = tasks.map((t, i) => [`wp${i}`, t[0]] as [string, string]);
    expect(check(planOf(...tasks), slicePlanOf("none", ...groups)).ok).toBe(true);
  });
  it("AGENTS_SHORT with the count the pool actually returned", () => {
    const plan = planOf(["T1", "a", "src/a.ts", "none"], ["T2", "b", "src/b.ts", "none"], ["T3", "c", "src/c.ts", "none"]);
    const sp = slicePlanOf("none", ["wp1", "T1"], ["wp2", "T2"], ["wp3", "T3"]);
    expect(refusals(check(plan, sp, { agentsFor: () => ["alpha", "bravo"] }))).toEqual(["AGENTS_SHORT=2"]);
  });
  it("the agent pool is not consulted when the grouping is already refused", () => {
    let calls = 0;
    check(PLAN, slicePlanOf("T1"), { agentsFor: (n) => { calls++; return ["alpha"].slice(0, n); } });
    expect(calls).toBe(0);
  });
  it("reports EVERY refusal the input earns in one pass", () => {
    const plan = planOf(["T1", "a", "tests/*.ts", "none"], ["T2", "b", "src/b.ts", "none"]);
    expect(refusals(check(plan, slicePlanOf("none", ["wp1", "T1"])))).toEqual(["BADFILE=T1:tests/*.ts", "UNASSIGNED=T2"]);
  });
});

describe("checkSlicePlan — overlap", () => {
  const twoSlices = (aFiles: string, bFiles: string) =>
    check(planOf(["T1", "a", aFiles, "none"], ["T2", "b", bFiles, "none"]), slicePlanOf("none", ["wp1", "T1"], ["wp2", "T2"]));

  it("OVERLAP when two slices name the same file", () => {
    expect(refusals(twoSlices("src/x.ts", "src/x.ts"))).toEqual(["OVERLAP=wp1:wp2:src/x.ts"]);
  });
  it("OVERLAP when a slice's directory CONTAINS another slice's file", () => {
    expect(refusals(twoSlices("src/core/", "src/core/x.ts"))).toEqual(["OVERLAP=wp1:wp2:src/core/"]);
  });
  it("OVERLAP when a slice's file is UNDER another slice's directory", () => {
    expect(refusals(twoSlices("src/core/x.ts", "src/core/"))).toEqual(["OVERLAP=wp1:wp2:src/core/x.ts"]);
  });
  it("OVERLAP between two nested directories", () => {
    expect(refusals(twoSlices("src/", "src/core/"))).toEqual(["OVERLAP=wp1:wp2:src/"]);
  });
  it("two files in ONE directory are not an overlap", () => {
    expect(twoSlices("src/core/a.ts", "src/core/b.ts").ok).toBe(true);
  });
  it("a directory token never matches a sibling directory by string prefix", () => {
    expect(twoSlices("src/core/", "src/coretools/x.ts").ok).toBe(true);
  });
  it("OVERLAP when the SAME file is spelled two ways in the two slices", () => {
    // The comparison normalises though the token is reported verbatim: a `./` or a doubled slash
    // used to make one file look like two, and `sliceMandate` then handed both workers the same path.
    expect(refusals(twoSlices("./src/x.ts", "src/x.ts"))).toEqual(["OVERLAP=wp1:wp2:./src/x.ts"]);
    expect(refusals(twoSlices("src//x.ts", "src/x.ts"))).toEqual(["OVERLAP=wp1:wp2:src//x.ts"]);
    expect(refusals(twoSlices("./src/core/", "src/core/x.ts"))).toEqual(["OVERLAP=wp1:wp2:./src/core/"]);
  });
  it("the PRELUDE is exempt: a prelude file may be named by a slice too", () => {
    const plan = planOf(["T1", "p", "src/shared.ts", "none"], ["T2", "b", "src/shared.ts", "T1"], ["T3", "c", "src/c.ts", "none"]);
    expect(check(plan, slicePlanOf("T1", ["wp1", "T2"], ["wp2", "T3"])).ok).toBe(true);
  });
  it("one OVERLAP line per distinct pair-and-path, not one per file comparison", () => {
    const r = twoSlices("src/core/, src/core/x.ts", "src/core/x.ts");
    expect(refusals(r)).toEqual(["OVERLAP=wp1:wp2:src/core/", "OVERLAP=wp1:wp2:src/core/x.ts"]);
  });
});

describe("checkSlicePlan — MISSING warnings", () => {
  it("warns per absent path on the ok arm without refusing", () => {
    const r = check(PLAN, slicePlanOf("T1", ["wp2", "T2"]), { fileExists: (p) => p !== "src/core/shard.ts" });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(["MISSING=T2:src/core/shard.ts"]);
  });
  it("carries the warnings on the refusal arm too", () => {
    const r = check(PLAN, slicePlanOf("T1"), { fileExists: () => false });
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual(["MISSING=T1:src/core/gate.ts", "MISSING=T1:src/core/gateKinds.ts", "MISSING=T2:src/core/shard.ts"]);
  });
  it("a BADFILE token is refused, never warned about", () => {
    const r = check(planOf(["T1", "a", "tests/*.ts", "none"]), slicePlanOf("none", ["wp1", "T1"]), { fileExists: () => false });
    expect(refusals(r)).toEqual(["BADFILE=T1:tests/*.ts"]);
    expect(r.warnings).toEqual([]);
  });
});

describe("slices.tsv", () => {
  let dir = "";
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ap-slices-")); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const rows: SliceRow[] = [
    { agent: "alpha", model: "codex", label: "wp3", status: "spawned", tasks: ["T3", "T5"], files: ["src/a.ts", "src/b/"] },
    { agent: "bravo", model: "claude", label: "wp4", status: "abandoned:turn-failed", tasks: ["T4"], files: ["src/c.ts"] },
  ];

  it("round-trips rows through the tab/comma/semicolon shape", () => {
    const p = join(dir, "slices.tsv");
    writeSlices(p, rows);
    expect(readFileSync(p, "utf8")).toBe(
      "alpha\tcodex\twp3\tspawned\tT3,T5\tsrc/a.ts;src/b/\n" +
      "bravo\tclaude\twp4\tabandoned:turn-failed\tT4\tsrc/c.ts\n",
    );
    expect(readSlices(p)).toEqual(rows);
  });
  it("leaves no tmp file behind (atomic write)", () => {
    writeSlices(join(dir, "atomic.tsv"), rows);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });
  it("an absent file reads as no rows", () => {
    expect(readSlices(join(dir, "nope.tsv"))).toEqual([]);
  });
  it("an empty roster writes an empty file and reads back empty", () => {
    const p = join(dir, "empty.tsv");
    writeSlices(p, []);
    expect(readFileSync(p, "utf8")).toBe("");
    expect(readSlices(p)).toEqual([]);
  });
  it("a row with empty tasks/files round-trips to empty arrays", () => {
    const p = join(dir, "bare.tsv");
    writeSlices(p, [{ agent: "alpha", model: "codex", label: "wp1", status: "planned", tasks: [], files: [] }]);
    expect(readSlices(p)).toEqual([{ agent: "alpha", model: "codex", label: "wp1", status: "planned", tasks: [], files: [] }]);
  });
  it("skips comment lines and rows missing a fixed column", () => {
    const p = join(dir, "torn.tsv");
    writeFileSync(p, "# generated\nalpha\tcodex\twp1\tplanned\tT1\tsrc/a.ts\nbravo\tcodex\n");
    expect(readSlices(p).map((r) => r.agent)).toEqual(["alpha"]);
  });
});

describe("absorbIssues", () => {
  const planTasks: PlanTask[] = [
    { id: "T3", title: "shard schema", files: ["src/shard.ts"], depends: [] },
    { id: "T4", title: "new training target", files: ["src/target.ts"], depends: [] },
  ];
  const row = (over: Partial<SliceRow>): SliceRow =>
    ({ agent: "alpha", model: "codex", label: "wp3", status: "done", tasks: ["T3"], files: [], ...over });
  const absorb = (rows: SliceRow[], integrate: IntegrateRow[], reports: Record<string, string> = {}) =>
    absorbIssues({ topic: "gate", rows, integrate, planTasks, reportTextFor: (a) => reports[a] ?? "" });

  it("returns \"\" when the slices left nothing", () => {
    expect(absorb([row({})], [{ agent: "alpha", label: "wp3", status: "merged" }])).toBe("");
  });
  it("[slice] for an abandoned row, with the task ids and titles from the plan", () => {
    const rows = [row({ agent: "bravo", label: "wp4", tasks: ["T4"], status: "abandoned:turn-failed" })];
    expect(absorb(rows, [])).toBe(
      '- [slice] tasks T4 "new training target" (slice wp4) were not implemented (abandoned:turn-failed): implement them per plan.md',
    );
  });
  it("[slice] for an EMPTY integrate row (the branch had no commits)", () => {
    expect(absorb([row({})], [{ agent: "alpha", label: "wp3", status: "empty" }])).toBe(
      '- [slice] tasks T3 "shard schema" (slice wp3) were not implemented (empty): implement them per plan.md',
    );
  });
  it("[slice] for a skipped integrate row, naming why", () => {
    expect(absorb([row({})], [{ agent: "alpha", label: "wp3", status: "skipped:no-branch" }])).toContain("(skipped:no-branch)");
  });
  it("one [slice] line per agent when a row is both abandoned and empty", () => {
    const rows = [row({ status: "abandoned:pane-died" })];
    const out = absorb(rows, [{ agent: "alpha", label: "wp3", status: "empty" }]).split("\n");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("(abandoned:pane-died)");
  });
  it("names an id the plan does not carry without a title", () => {
    expect(absorb([row({ tasks: ["T9"], status: "abandoned:objection" })], [])).toContain("tasks T9 (slice wp3)");
  });
  it("[integration] for a conflicting row, naming the slice branch twice", () => {
    expect(absorb([row({})], [{ agent: "alpha", label: "wp3", status: "conflict" }])).toBe(
      "- [integration] feat/implement-gate-alpha (slice wp3) conflicts with this branch — " +
      "run `git merge feat/implement-gate-alpha`, resolve keeping both intents, commit",
    );
  });
  it("[spec-gap] per line under a MERGED slice's ## Out-of-slice changes needed", () => {
    const report = doc("## Verify", "green", "## Out-of-slice changes needed", "- src/core/gate.ts:12 — widen the enum", "* src/core/x.ts:3 — export it", "", "## Blockers", "- not this one");
    expect(absorb([row({})], [{ agent: "alpha", label: "wp3", status: "merged" }], { alpha: report })).toBe(
      "- [spec-gap] src/core/gate.ts:12 — out-of-slice change requested by slice wp3: widen the enum\n" +
      "- [spec-gap] src/core/x.ts:3 — out-of-slice change requested by slice wp3: export it",
    );
  });
  it("[spec-gap] is read from a CONFLICTED slice's report too", () => {
    const report = doc("## Out-of-slice changes needed", "- src/core/gate.ts:12 — widen the enum");
    const out = absorb([row({})], [{ agent: "alpha", label: "wp3", status: "conflict" }], { alpha: report });
    expect(out).toContain("- [spec-gap] src/core/gate.ts:12 — out-of-slice change requested by slice wp3: widen the enum");
    expect(out.split("\n")).toHaveLength(2); // the [integration] line and the [spec-gap] line
  });
  it("[spec-gap] is read from an ABANDONED slice's report too", () => {
    const report = doc("## Out-of-slice changes needed", "- src/core/gate.ts:12 — widen the enum");
    expect(absorb([row({ status: "abandoned:turn-failed" })], [], { alpha: report })).toContain("[spec-gap]");
  });
  it("[spec-gap] keeps the <file:line> field ABSENT when the worker's line names no location", () => {
    const report = doc("## Out-of-slice changes needed", "- the enum in the shared gate needs widening");
    expect(absorb([row({})], [{ agent: "alpha", label: "wp3", status: "merged" }], { alpha: report })).toBe(
      "- [spec-gap] out-of-slice change requested by slice wp3: the enum in the shared gate needs widening",
    );
  });
  it("the out-of-slice heading is still the section with a count or a colon after it", () => {
    const withCount = doc("## Out-of-slice changes needed (2)", "- src/a.ts:1 — one", "- src/b.ts:2 — two");
    const withColon = doc("### Out-of-slice changes needed:", "- src/a.ts:1 — one");
    expect(absorb([row({})], [], { alpha: withCount }).split("\n")).toHaveLength(2);
    expect(absorb([row({})], [], { alpha: withColon })).toContain("- [spec-gap] src/a.ts:1 — ");
  });
  it("a never-spawned row's report is not read", () => {
    const report = doc("## Out-of-slice changes needed", "- stale from a previous run");
    const rows = [row({ status: "planned" }), row({ agent: "bravo", label: "wp4", status: "failed-spawn" })];
    expect(absorb(rows, [], { alpha: report, bravo: report })).toBe("");
  });
  it("an empty out-of-slice section yields nothing", () => {
    expect(absorb([row({})], [{ agent: "alpha", label: "wp3", status: "merged" }], { alpha: doc("## Out-of-slice changes needed", "", "## Blockers") })).toBe("");
  });
  it("orders the block [slice], then [integration], then [spec-gap]", () => {
    const rows = [row({}), row({ agent: "bravo", label: "wp4", tasks: ["T4"], status: "abandoned:turn-failed" })];
    const integrate: IntegrateRow[] = [{ agent: "alpha", label: "wp3", status: "conflict" }];
    const reports = { alpha: doc("## Out-of-slice changes needed", "- src/z.ts:1 — add a hook") };
    expect(absorb(rows, integrate, reports).split("\n").map((l) => l.slice(0, 14))).toEqual(["- [slice] task", "- [integration", "- [spec-gap] s"]);
  });
});

describe("sliceMandate", () => {
  it("names the label, the tasks with their plan titles, and the files as absolute paths", () => {
    const planTasks: PlanTask[] = [
      { id: "T3", title: "shard schema", files: ["src/shard.ts"], depends: [] },
      { id: "T5", title: "manifest", files: ["src/manifest/"], depends: [] },
    ];
    const slice = { label: "wp3", tasks: ["T3", "T5"], files: ["src/shard.ts", "src/manifest/"] };
    expect(sliceMandate(slice, planTasks, "/repo/.ap/worktrees/gate.alpha")).toBe(doc(
      "# Slice wp3", "",
      "## Tasks (from plan.md)",
      "- T3: shard schema",
      "- T5: manifest",
      "",
      "## Files you own (absolute, in your worktree)",
      "- /repo/.ap/worktrees/gate.alpha/src/shard.ts",
      "- /repo/.ap/worktrees/gate.alpha/src/manifest/",
    ));
  });
  it("an id absent from the plan is named, not dropped", () => {
    expect(sliceMandate({ label: "wp1", tasks: ["T9"], files: [] }, [], "/w")).toContain("- T9: (not in plan.md)");
  });
});

describe("constants", () => {
  it("MAX_SLICES is 6 and ABANDON_REASONS is the closed set", () => {
    expect(MAX_SLICES).toBe(6);
    expect(ABANDON_REASONS).toEqual(["spawn-failed", "turn-failed", "pane-died", "objection"]);
  });
});
