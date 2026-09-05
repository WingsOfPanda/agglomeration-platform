// The explore hub's attestation is faithful representation, not first-hand citation (the Hub never
// retrieves; its citations come from the workers' findings). One section states the hub-side
// delegation rules once; five pointers mark the reading sites (2026-09-05-worker-delegation-reminder-
// design.md, amendment "explore's hub side").
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const doc = readFileSync(join(process.cwd(), "commands", "explore.md"), "utf8").replace(/\s+/g, " ");
const slice = (a: string, b: string) => doc.slice(doc.indexOf(a), doc.indexOf(b));
const section = slice("## Hub-side delegation", "## Flagging suspicions");
const phase5 = slice("## Phase 5 — preliminary synthesis", "## Phase 5b");
const phase8 = slice("## Phase 8 — final synthesis", "## Phase 8b");
const phase8c = slice("## Phase 8c", "## Phase 8a");
const phase9c = slice("## Phase 9c — compose design-handoff.md", "## Phase 10 — present");
const phase10 = doc.slice(doc.indexOf("## Phase 10 — present"));

describe("explore.md hub side: one delegation section, five pointers", () => {
  it("states the three rules once, beside the worker ultracode note", () => {
    expect(section.length).toBeGreaterThan(0);
    expect(doc.indexOf("## Ultracode workers")).toBeLessThan(doc.indexOf("## Hub-side delegation"));
    expect(section).toContain("**Reading is delegable; retrieval is not.**");
    expect(section).toContain("the Hub never retrieves, and neither does a hub-side subagent.");
    expect(section).toContain("**Driving the workers is your own turn.**");
    expect(section).toContain("**Your attestation is faithful representation.**");
    expect(section).toContain("never supply a claim, drop a bracket, strip a hedge, or originate a citation.");
  });

  it("points at the section from every reading site", () => {
    expect(phase5).toContain("The reading is delegable and the draft is yours — the `## Hub-side delegation` rules apply here:");
    expect(phase8).toContain("The reading is delegable and the final doc is yours — the `## Hub-side delegation` rules apply here:");
    expect(phase8c).toContain("the frontier and every `hub-answered (<citation>)` line are yours — the `## Hub-side delegation` rules apply here.");
    expect(phase9c).toContain("every `## Evidence` row and every path or URL in `## Recipe` is carried from a line you read in the landscape doc yourself");
    expect(phase10).toContain("The Conclusion body is copied by you from the archived doc; a subagent may locate the section, never supply its text.");
  });

  it("the frozen retrieval boundary is untouched", () => {
    expect(doc).toContain("**The Hub itself never runs retrieval — workers are the only retrievers.**");
  });
});
