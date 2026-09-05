// The design ensemble path (Stages 3-15) is where the hub drives N workers, relays their questions,
// resolves PENDING claims, walks the six sections with the user and drills down. These sentences are
// the hub's counterpart of the worker delegation block on that path
// (2026-09-05-worker-delegation-reminder-design.md, amendment "design's ensemble hub side"):
// reading is delegable after the gate, driving the workers and every `$CS` verb are the hub's own
// turn, and every verdict, relayed answer and walked section is the hub's faithful representation of
// what it read itself. Wording deliberately avoids the fast-path test's two no-leak substrings.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const raw = readFileSync(join(process.cwd(), "commands", "design.md"), "utf8");
const doc = raw.replace(/\s+/g, " ");
const slice = (from: string, to: string) => doc.slice(doc.indexOf(from), doc.indexOf(to));
const section = slice("## Hub-side delegation", "## Stage 0");
const stage5 = slice("## Stage 5", "## Stage 6");
const stage9 = slice("## Stage 9", "## Stage 10");
const stage10 = slice("## Stage 10", "## Stage 11");
const stage12 = slice("## Stage 12", "## Stage 13a");
const stage13a = slice("## Stage 13a", "## Stage 13b");

describe("design.md ensemble path: the hub's own delegation split", () => {
  it("has one Hub-side delegation section, between Flagging suspicions and Stage 0", () => {
    expect(raw.match(/^## Hub-side delegation$/gm)).toHaveLength(1);
    expect(raw.indexOf("## Flagging suspicions")).toBeLessThan(raw.indexOf("## Hub-side delegation"));
    expect(raw.indexOf("## Hub-side delegation")).toBeLessThan(raw.indexOf("## Stage 0"));
    expect(section).toContain("**Reading is delegable after the gate; the verbs are yours.**");
    expect(section).toContain("the artifact gate binds whoever opens the file");
    expect(section).toContain("Every `$CS` verb is keyed to YOUR cwd");
    expect(section).toContain("**Driving the workers is your own turn.**");
    expect(section).toContain("**Your attestation is faithful representation.**");
  });

  it("Stage 5 keeps the waits, the gate and the relay with the hub, and binds the relayed answer", () => {
    expect(stage5).toContain("These waits, the gate below and the relay are your own turn");
    expect(stage5).toContain("the `## Hub-side delegation` rules apply here");
    expect(stage5).toContain("never supply the answer");
  });

  it("Stage 9 keeps every PENDING verdict and its source with the hub", () => {
    expect(stage9).toContain("you opened yourself in this turn, and the verdict is yours");
    expect(stage9).toContain("never supply the verdict");
  });

  it("Stage 10 keeps the walked drafts and the components stat with the hub", () => {
    expect(stage10).toContain("the draft is yours");
    expect(stage10).toContain("never supply a claim or a citation");
    expect(stage10).toContain("the path you cite you stat'd yourself in this turn");
  });

  it("Stage 12 and 13a keep the drilldown summary and the reflection with the hub", () => {
    expect(stage12).toContain("the summary you present is your own reading of them in this turn");
    expect(stage13a).toContain("`reflect` runs once, from you");
  });

  it("the sentences sit only at their sites", () => {
    expect(doc.split("never supply the answer")).toHaveLength(2);
    expect(doc.split("never supply the verdict")).toHaveLength(2);
    expect(doc.split("`reflect` runs once, from you")).toHaveLength(2);
  });
});
