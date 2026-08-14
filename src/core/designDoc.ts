// src/core/designDoc.ts
export const SECTIONS_SINGLE = ["problem", "goal", "architecture", "components", "testing", "success-criteria"] as const;

const TITLES: Record<string, string> = {
  problem: "Problem", goal: "Goal", architecture: "Architecture", components: "Components",
  testing: "Testing", "success-criteria": "Success Criteria",
};
export function sectionTitle(key: string): string { return TITLES[key] ?? key; }

export interface AssembleInput { title: string; drafts: Map<string, string>; }

/** Port of bin/consult-walk-assemble.sh's concat, single-repo only: header-less H1 + 6 sections
 *  (implement infers a lone target from cwd). */
export function assembleDoc(input: AssembleInput): string {
  let out = `# ${input.title}\n\n`;
  for (const key of SECTIONS_SINGLE) {
    const draft = input.drafts.get(key);
    if (draft != null) out += `${draft}\n`;
    else out += `## ${sectionTitle(key)}\n\n_(missing draft)_\n\n`;
  }
  return out;
}

// A steer tag is the section word FOLLOWED BY a terminator (`]`, `:`, or a space) — without one,
// `- [problem.md:3]` and `- [components/Button.tsx:10]` (ordinary adjudicated citations, which all
// open with `[`) would be claimed as tags. The terminator costs the old prefix tolerance: a
// pluralized `- [Goals]` no longer routes.
const SEED_SPECS: { section: string; heading: string; comment: string; tag: RegExp }[] = [
  { section: "problem", heading: "## Problem", comment: "<!-- seed: claims tagged [Problem] -->",
    tag: /^- \[Problem[\]:\s]/i },
  { section: "goal", heading: "## Goal", comment: "<!-- seed: claims tagged [Goal] -->",
    tag: /^- \[Goal[\]:\s]/i },
  { section: "architecture", heading: "## Architecture", comment: "<!-- seed: claims tagged [Architecture] -->",
    tag: /^- \[Architecture[\]:\s]/i },
  { section: "components", heading: "## Components", comment: "<!-- seed: claims tagged [Components] -->",
    tag: /^- \[Components[\]:\s]/i },
  { section: "testing", heading: "## Testing", comment: "<!-- seed: claims tagged [Testing] or containing \"test\" -->",
    tag: /^- \[Testing[\]:\s]/i },
  { section: "success-criteria", heading: "## Success Criteria", comment: "<!-- seed: claims tagged [Success Criteria] -->",
    tag: /^- \[Success( Criteria)?[\]:\s]/i },
];
const SEED_PLACEHOLDER = "_(no seed content matched; Hub drafts from scratch in the design walk)_";

/** Port of bin/consult-synthesize.sh — 6 single-repo seed drafts from adjudicated.md content.
 *  Each: heading + blank + seed comment + matched claim lines (placeholder if none matched).
 *
 *  Routing is FIRST-MATCH over the steer tags, so every line has at most one home: `problem` takes
 *  only `- [Problem` lines (it used to take every `- [` bullet — i.e. the whole adjudicated corpus,
 *  since adjudicate renders each claim as `- [<cite>] …`, which both dumped an untagged corpus into
 *  problem.md and landed every tagged line twice). The `testing` "contains test" heuristic is the
 *  one untagged claim, so it only sees lines no tag took. */
export function synthesizeSeeds(adjText: string): { section: string; body: string }[] {
  const matched = new Map<string, string[]>(SEED_SPECS.map((s) => [s.section, []]));
  for (const l of adjText.split("\n")) {
    const spec = SEED_SPECS.find((s) => s.tag.test(l));
    if (spec) matched.get(spec.section)!.push(l);
    else if (/^- .*\btest/i.test(l)) matched.get("testing")!.push(l);
  }
  return SEED_SPECS.map((spec) => {
    const lines = matched.get(spec.section)!;
    const body = `${spec.heading}\n\n${spec.comment}\n` +
      (lines.length ? lines.join("\n") + "\n" : SEED_PLACEHOLDER + "\n");
    return { section: spec.section, body };
  });
}
