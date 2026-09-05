// The autoresearch hub runs an inline loop for hours over N lanes and then writes the handoff. These
// sentences are the hub's counterpart of the worker delegation block
// (2026-09-05-worker-delegation-reminder-design.md, amendment "autoresearch's hub side"): reading,
// the A1 re-run and the C1 re-implementation are delegable; every `$CS` verb, the loop's waits, the
// direction, the autonomous answer and every value in the handoff are the hub's own; and a queued
// stale/stuck is superseded by a newer done/error for the same worker.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const raw = readFileSync(join(process.cwd(), "commands", "autoresearch.md"), "utf8");
const doc = raw.replace(/\s+/g, " ");
const slice = (from: string, to: string) => doc.slice(doc.indexOf(from), doc.indexOf(to));
const section = slice("## Hub-side delegation", "## Task list");
const step3 = slice("### Step 3", "- **`done` / `error`**");
const question = slice("- **`question`**", "- **`stale`**");
const verify = slice("3.5. **Verify the landed result", "3.5b. **Independent re-implementation");
const inspect = slice("3.5b. **Independent re-implementation", "### Step 4");
const sota = slice("## Phase 1.5", "#### Security note");
const step5 = slice("### Step 5", "### Step 6");
const phase5 = slice("## Phase 5", "## Phase 6 —");

describe("autoresearch.md hub side: the hub's own delegation split", () => {
  it("has one Hub-side delegation section, between Flagging suspicions and the Task list", () => {
    expect(raw.match(/^## Hub-side delegation$/gm)).toHaveLength(1);
    expect(raw.indexOf("## Flagging suspicions")).toBeLessThan(raw.indexOf("## Hub-side delegation"));
    expect(raw.indexOf("## Hub-side delegation")).toBeLessThan(raw.indexOf("## Task list"));
    expect(section).toContain("**Reading is delegable; the verbs and the loop are yours.**");
    expect(section).toContain("Every `$CS` verb is keyed to YOUR cwd");
    expect(section).toContain("**Your attestation.**");
    expect(section).toContain("**A dispatch is foreground; the loop waits for it.**");
  });

  it("Step 3 supersedes a queued stale/stuck before routing", () => {
    expect(step3).toContain("**Supersession first:**");
    expect(step3).toContain("voids every `stale`/`stuck` queued for the same worker");
  });

  it("keeps the autonomous answer with the hub", () => {
    expect(question).toContain("The answer is yours");
    expect(question).toContain("never draft the reply");
  });

  it("A1: the re-run is delegable, the verb and its log are the hub's", () => {
    expect(verify).toContain("re-run that command independently of the worker");
    expect(verify).toContain("through a subagent with an explicit cheaper model");
    expect(verify).toContain("the tee'd log itself, never a subagent's summary");
  });

  it("C1: the re-implementation is delegable under both bans, the verdict is the hub's", () => {
    expect(inspect).toContain("or a subagent you brief");
    expect(inspect).toContain("bind whoever authors it, named in the brief");
    expect(inspect).toContain("never off a subagent's summary");
  });

  it("Phase 1.5, Step 5 and Phase 5 keep every cited value with the hub", () => {
    expect(sota).toContain("never originate a reference");
    expect(step5).toContain("never originate a value that lands in a worker's `prompt.md`");
    expect(phase5).toContain("never originate a cited value");
  });

  it("the sentences sit only at their sites", () => {
    expect(doc.split("**Supersession first:**")).toHaveLength(2);
    expect(doc.split("never draft the reply")).toHaveLength(2);
    expect(doc.split("never originate a cited value")).toHaveLength(2);
  });
});
