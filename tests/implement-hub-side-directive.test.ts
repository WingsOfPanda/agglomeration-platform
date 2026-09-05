// The attached implement hub's grind is Stage 2's read list and Stage 3's evidence gathering; its
// attestations are the VERDICT= it records, the spot-checked hunks it cites and every path and number
// in the fix bundle. These sentences are the hub's counterpart of the worker delegation block
// (2026-09-05-worker-delegation-reminder-design.md, amendment "implement's attached hub side").
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const doc = readFileSync(join(process.cwd(), "commands", "implement.md"), "utf8").replace(/\s+/g, " ");
const stepA = doc.slice(doc.indexOf("**Step A — independent test re-run"), doc.indexOf("**Step B — read-based cross-verify.**"));
const stepB = doc.slice(doc.indexOf("**Step B — read-based cross-verify.**"), doc.indexOf("## Stage 3"));
const stage3 = doc.slice(doc.indexOf("## Stage 3"), doc.indexOf("## Stage 4"));
const before2 = doc.slice(0, doc.indexOf("## Stage 2"));

describe("implement.md attached hub side: the hub's own delegation split", () => {
  it("Step A: the log tail is delegable, the recorded VERDICT= is read off the hub log", () => {
    expect(stepA).toContain("Reading the log tail is grind you may dispatch to a subagent;");
    expect(stepA).toContain("read off `$ART/hub-test-output-<ROUND>.log`, never off a subagent's summary.");
  });

  it("Step B: the reads are delegable grind, the spot-checks and the VERDICT are the hub's attestation", () => {
    expect(stepB).toContain("is grind you may dispatch to a subagent with an explicit cheaper model; the spot-checks are yours.");
    expect(stepB).toContain("The spot-checked hunks you cite as `(file:line)` evidence and the VERDICT are your attestation");
    expect(stepB).toContain("you opened those hunks yourself in this turn; a subagent may enumerate what to open, never originate a citation.");
  });

  it("Stage 3: the citation rule is first-person and names the evidence gathering as delegable grind", () => {
    expect(stage3).toContain("A Read/Glob/`ls` you ran yourself in this turn, not \"I know that file\".");
    expect(stage3).not.toContain("in *this* session");
    expect(stage3).toContain("**Gathering the evidence is grind; the bundle is yours.**");
    expect(stage3).toContain("every path, number and environment fact the bundle cites stays first-hand");
  });

  it("none of it leaks before Stage 2 (the worker and the job hub carry their own blocks)", () => {
    expect(before2).not.toContain("never originate a citation");
    expect(before2).not.toContain("never off a subagent's summary");
  });
});
