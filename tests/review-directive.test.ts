// tests/review-directive.test.ts — the forensics-as-issues contract as the DIRECTIVES state it.
// Verbs alone do not ship the behaviour: the hub only surfaces ISSUE=/QUEUED=/CONSENT=needed, asks
// for consent, and reflects because its .md says so. Pins are whitespace-collapsed so re-wrapping
// the prose does not break them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");
const flat = (p: string): string => read(join("commands", p)).replace(/\s+/g, " ");

// Each command names its own run identifier (<SLUG> for quick/bridge, <TOPIC> elsewhere).
const RUN_COMMANDS: [cmd: string, ident: string][] = [
  ["quick", "<SLUG>"], ["design", "<TOPIC>"], ["implement", "<TOPIC>"],
  ["explore", "<TOPIC>"], ["autoresearch", "<TOPIC>"], ["bridge", "<SLUG>"],
];

describe("run directives — forensics filing", () => {
  it.each(RUN_COMMANDS)("%s.md surfaces ISSUE= / QUEUED= / CONSENT=needed", (cmd) => {
    const md = flat(`${cmd}.md`);
    expect(md).toContain("ISSUE=");
    expect(md).toContain("QUEUED=");
    expect(md).toContain("CONSENT=needed");
  });

  it.each(RUN_COMMANDS)("%s.md hands the reflection to `reflect <run> @<file>`", (cmd, ident) => {
    const md = flat(`${cmd}.md`);
    expect(md).toContain(`${cmd} reflect ${ident} @`);
    expect(md).toContain("temp file");
    expect(md).toContain("debug this from the issue alone");   // teammate audience (spec B)
    expect(md).toContain("NO_RUN_ISSUE");
    expect(md).not.toContain("## Hub reflection");             // the append-to-file rule is gone
  });

  it.each(RUN_COMMANDS)("%s.md fires the consent AskUserQuestion, attached runs only", (cmd) => {
    const md = flat(`${cmd}.md`);
    expect(md).toContain("asked once per machine (attached runs only)");
    expect(md).toContain("AskUserQuestion");
    expect(md).toContain("Header `Issues`");
    expect(md).toContain("github.com/WingsOfPanda/agglomeration-platform");
    expect(md).toContain("`Allow (recommended for the team)` / `Never on this machine` / `Not now`");
    expect(md).toContain("Allow → `$CS review consent yes`, then `$CS review flush`");
    expect(md).toContain("Never → `$CS review consent no`");
    expect(md).toContain("Mid-run flags never ask, and a detached run never asks");
  });

  it.each(RUN_COMMANDS)("%s.md says flags become comments on the run issue", (cmd) => {
    const md = flat(`${cmd}.md`);
    const at = md.indexOf("## Flagging suspicions");
    const section = md.slice(at, at + 900);
    expect(section).toContain(`${cmd} flag <`);
    expect(section).toContain("comment on this run's GitHub issue");
    expect(section).toContain("before this machine has answered the consent question");
    expect(section).toContain("Flags never ask for consent");
  });

  it.each(RUN_COMMANDS)("%s.md's front matter allows AskUserQuestion", (cmd) => {
    const raw = read(join("commands", `${cmd}.md`));
    const fm = raw.slice(0, raw.indexOf("\n---", 3));
    expect(fm).toMatch(/^allowed-tools: .*AskUserQuestion/m);
  });
});

const RETIRED = ["ssh", "xjp"];

describe("review.md — triage over issues", () => {
  const md = flat("review.md");
  it("drives the new verbs", () => {
    expect(md).toContain("$CS review survey");
    expect(md).toContain("$CS review flush");
    expect(md).toContain("$CS review consent yes");
    expect(md).toContain("$CS review consent no");
    expect(md).toContain("$CS review archive <n1> <n2>");
    expect(md).toContain("QUEUE=");
    expect(md).toContain("--command <name>");
    expect(md).toContain("--since <Nd|Nh>");
    expect(md).not.toContain("--all");
  });
  it("every gh line carries --repo WingsOfPanda/agglomeration-platform", () => {
    const ghLines = read(join("commands", "review.md")).split("\n").filter((l) => /\bgh (issue|label)\b/.test(l));
    expect(ghLines.length).toBeGreaterThanOrEqual(3);
    // A gh invocation may wrap across lines, so check the collapsed neighbourhood of each one.
    for (const l of ghLines) {
      const i = md.indexOf(l.trim().replace(/^[-*\d.]+\s*/, "").replace(/\s+/g, " "));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(md.slice(i, i + 220)).toContain("--repo WingsOfPanda/agglomeration-platform");
    }
  });
  it("reads issues, clusters, hands off with Closes #n, then labels triaged", () => {
    expect(md).toContain("gh issue view <n> --repo WingsOfPanda/agglomeration-platform --comments");
    expect(md).toContain("Closes #");
    expect(md).toContain("/ap:quick");
    expect(md).toContain("/ap:implement");
    expect(md).toContain("--add-label triaged");
    expect(md).toContain("no untriaged ap issues; ap has been healthy");
    expect(md).toContain("AskUserQuestion");
  });
  it("the local-file / remote-box era is gone", () => {
    // RETIRED[0] = the remote-box pull, RETIRED[1] = the box it pulled from.
    for (const gone of [...RETIRED, ".reviewed", ".trends.json", "~/.ap/forensics/<date>"]) {
      expect(md.toLowerCase()).not.toContain(gone);
    }
  });
});

describe("job.md — detached runs never ask", () => {
  const md = flat("job.md");
  it("says so, and says they queue instead", () => {
    expect(md).toContain("Detached runs never ask for consent");
    expect(md).toContain("QUEUED=");
    expect(md).toContain("never fires that AskUserQuestion");
  });
});

describe("README.md — security posture names the public tracker", () => {
  const readme = read("README.md").replace(/\s+/g, " ");
  it("one clause: what is filed, where, and how to decline", () => {
    expect(readme).toContain("Security posture");
    expect(readme).toContain("github.com/WingsOfPanda/agglomeration-platform");
    expect(readme).toContain("asks once per machine");
    expect(readme).toContain("ap review consent no");
  });
});
