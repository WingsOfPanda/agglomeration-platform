// tests/explore-grill-directive.test.ts
// Directive contract for the two hub-user interviews in /ap:explore: Phase 0.5 (frame) and Phase 8c
// (grill). Nothing in src enforces the protocol — the directive IS the contract — so these pins are
// what a future edit must not silently drop. Pins are whitespace-collapsed so re-wrapping the prose
// costs nothing (the tests/design-assemble.test.ts idiom).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const flat = readFileSync(join(process.cwd(), "commands", "explore.md"), "utf8").replace(/\s+/g, " ");

/** Index of a pin, asserting it exists at all. */
function at(needle: string): number {
  const i = flat.indexOf(needle);
  expect(i, `missing pin: ${needle}`).toBeGreaterThan(-1);
  return i;
}
const between = (from: string, to: string) => flat.slice(at(from), at(to));

const P05 = "## Phase 0.5 — frame (hub + user, ONE round)";
const P1 = "## Phase 1 — literature auto-detect";
const P8B = "## Phase 8b — worker sign-off";
const P8C = "## Phase 8c — grill (hub + user + workers; at most 3 rounds)";
const P8A = "## Phase 8a — forensics";
const P9 = "## Phase 9 — teardown + archive + handoff-extract";

describe("explore directive: frame + grill contract", () => {
  it("places Phase 0.5 between Phase 0 and Phase 1, and Phase 8c between 8b and 8a/9", () => {
    expect(at("## Phase 0 — args + init + list")).toBeLessThan(at(P05));
    expect(at(P05)).toBeLessThan(at(P1));
    expect(at(P8B)).toBeLessThan(at(P8C));
    expect(at(P8C)).toBeLessThan(at(P8A));
    expect(at(P8A)).toBeLessThan(at(P9));
  });

  it("Phase 0.5 carries the Frame header, the recommended-first label, the schema and the skip rule", () => {
    const frame = between(P05, P1);
    expect(frame).toContain("**AskUserQuestion** (Header `Frame`)");
    expect(frame).toContain("at most 4 questions in ONE call");
    expect(frame).toContain("recommended option FIRST, labelled `(Recommended)`");
    expect(frame).toContain("# Frame: <topic> ## Scope ## Constraints ## Good means ## Decided");
    expect(frame).toContain(
      "**Skip/resume rule: if `$ART/frame.md` already exists, this phase is SKIPPED without asking**",
    );
    // decisions-only: a framing question that would need a fact is not asked
    expect(frame).toContain("would need a fact is simply NOT asked");
  });

  it("Phase 0.5 never rewrites topic.txt", () => {
    expect(between(P05, P1)).toContain("Phase 0.5 **never rewrites `$ART/topic.txt`**");
  });

  it("Phase 8c pins the round cap, the resume key and the drill-first ordering", () => {
    const grill = between(P8C, P8A);
    expect(grill).toContain("The interview is bounded: **at most 3 rounds**, then it terminates.");
    expect(grill).toContain("on `stop`, or **after round 3**");
    expect(grill).toContain(
      "**`## Settled decisions` present → skip this phase entirely** (set task `8c` → `completed`",
    );
    expect(grill).toContain("already carries `status: settled | defaulted` and is **NEVER re-asked**");
    expect(grill).toContain("**Drill first, ask second.**");
    expect(grill).toContain("**AskUserQuestion** (Header `Grill r<r>`), **at most 4 questions per call**");
    expect(grill).toContain("recommended answer FIRST, labelled `(Recommended)`");
    // a no-convergence node carries no recommendation at all
    expect(grill).toContain("**no option carries `(Recommended)`** — never invent a recommendation");
  });

  it("Phase 8c gates reading a drill answer on the .done marker AND the DS= line", () => {
    expect(between(P8C, P8A)).toContain(
      "`$ART/drill-<agent>.done` exists AND the last `DS=` line of `$ART/drill-<agent>.txt` is present.",
    );
  });

  it("Phase 8c's DS=question relay removes the .done marker, never the state file", () => {
    const grill = between(P8C, P8A);
    expect(grill).toContain("`rm -f \"$ART/drill-<agent>.done\"` (**NEVER** the `.txt` state file");
    expect(grill).toContain("the one-turn cap is state-file existence");
  });

  it("Phase 8c's mop-up loop precedes the roster-wide drill gate", () => {
    const grill = between(P8C, P8A);
    const mopup = "row with no `$ART/drill-<agent>.txt` (never drilled this run)";
    expect(grill).toContain("**Mop-up (MANDATORY, even when the grill routed zero drill facts).**");
    expect(grill).toContain(mopup);
    expect(grill).toContain(
      '$CS explore drill-send <TOPIC> "$INST" "$PROV" || echo "SEND_FAILED=$INST rc=$?";',
    );
    expect(grill).toContain("note `no drill facts routed`");
    expect(grill).toContain("`$CS explore wait-gate <TOPIC> drill` exits 0");
    expect(grill.indexOf(mopup)).toBeLessThan(grill.indexOf("wait-gate <TOPIC> drill"));
  });

  it("Phase 8c pins the grill.md schema and the never-rewritten invariants", () => {
    const grill = between(P8C, P8A);
    expect(grill).toContain("# Grill: <topic> ## Round 1 - Q1 [decision] <title>: <question>");
    expect(grill).toContain("routed: <agent> | hub-answered (<citation>) | unresolved");
    // One contiguous pin: the closing sections and their three bullet forms, IN ORDER.
    expect(grill).toContain(
      "## Settled decisions " +
      "- <title>: <answer> (round <r>, settled|defaulted[, degraded: single-source evidence]) " +
      "## Left open " +
      "- <title>: hub-defaulted to <answer> — <why not reached> (round cap | stop | prerequisite unresolved fact F<n>) " +
      "- <title>: <why> (unresolved fact: F<n>)",
    );
    expect(grill).toContain("The final landscape doc is **never rewritten** by the grill");
    expect(grill).toContain("Phase 8c **never rewrites `$ART/topic.txt`**");
    expect(grill).toContain("The confidence gate is **NEVER re-run**");
  });

  it("the grilling protocol is inlined — never a reference to the user-local skill", () => {
    expect(flat).not.toContain(".claude/skills");
    expect(flat).not.toContain("grilling` skill");
  });

  it("housekeeping: 19 task rows, the DRILL budget kind, and 8c in the degraded + worker-set lists", () => {
    expect(flat).toContain("## Task list (TaskCreate × 19 before Phase 0)");
    expect(flat).toContain("`0.5 Frame [hub + user]`");
    expect(flat).toContain("`Framing the question`");
    expect(flat).toContain("`8c Grill [hub + user + workers]`");
    expect(flat).toContain("`Grilling the landscape`");
    expect(flat).toContain("`GAP`, `SIGNOFF`, `DRILL`.");
    expect(flat).toContain("→ Phase 8c (the grill runs degraded too");
    expect(flat).toContain("phases 4b, 4c, 6, 7, 7b, 7c, 8b, and 8c derive");
    expect(flat).toContain("Two hub↔user interviews bracket");
  });

  it("Intervention Pattern 1 enumerates the drill key and its marker", () => {
    const pattern1 = between("### Pattern 1: worker question event", "### Pattern 2: malformed adversary output");
    expect(pattern1).toContain("`DS=question` (drill)");
    expect(pattern1).toContain("or `drill-<agent>.done`)");
  });

  it("Phase 9c labels hub-defaulted grill decisions as unconfirmed, separately from user-settled ones", () => {
    const handoff = between("## Phase 9c — compose design-handoff.md", "## Phase 10 — present");
    expect(handoff).toContain("**Grill fold-in (Phase 8c).**");
    expect(handoff).toContain("`User-settled (grill):`");
    expect(handoff).toContain("`Hub-defaulted (grill, unconfirmed):`");
    expect(handoff).toContain("NEVER drop a defaulted line");
    expect(handoff).toContain("The KV's `mode` key is **not** rewritten by the grill");
    // no-convergence: the survey's own verdict leads, the grill's choice trails it, no Recipe.
    expect(handoff).toContain("the fixed no-convergence sentence below stays FIRST");
    expect(handoff).toContain("it is not a survey finding.");
    expect(handoff).toContain("`## Recipe` stays OMITTED");
  });

  it("Phase 10 prints the grill override before the conclusion body and the tally after it", () => {
    const present = flat.slice(at("## Phase 10 — present"));
    expect(present).toContain("`Grill override: the survey suggested <A>; you settled on <Y>");
    expect(present).toContain("The Conclusion body itself stays VERBATIM");
    expect(present).toContain("`Grill: <n> decisions settled (<d> defaulted), <m> left open — $ART/grill.md`");
    expect(present).toContain("print ONE line BEFORE the conclusion body — after the DEGRADED caveat line when both apply");
    expect(present).toContain("**After the conclusion body**, whenever `$ART/grill.md` exists");
  });
});
