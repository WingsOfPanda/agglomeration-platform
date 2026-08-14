// tests/phase-survey-sites.test.ts — each validator's SLOT VALUES and its refusal attribution,
// through the real verbs.
//
// tests/phase-survey.test.ts pins what the two slots DO; this file pins which value each of the nine
// sites passes, because a wrong value is silent: it changes an rc and a strike-log write that no
// other suite reads. Each case is the input where the two values disagree — an artifact that is
// EMPTY (the emptyIsComplete branch) or a worker whose phase is `<key>=skipped` (the skipTag
// branch) — asserted on rc plus the presence or ABSENCE of the `stillwriting-*` refusal log.
//
// THREE sites (survivors, synth-preliminary, synth-final) are absent by construction: each filters
// its roster through missingListArtifacts FIRST, whose predicate is `readIfExists().trim()` over the
// SAME file the row names, so an empty artifact is dropped before the survey ever sees it and the
// slot's empty branch is unreachable. What is pinned there instead is that unreachability.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { sendDeps } from "./helpers/phaseDeps.js";
import { END_OF_ARTIFACT } from "../src/core/artifact.js";
import { exploreArtDir } from "../src/core/explore.js";
import { designArtDir } from "../src/core/design.js";
import { workerDir } from "../src/core/paths.js";
import {
  openqCollateRun, diffExploreRun, survivorsRun, synthPreliminaryRun, synthFinalRun,
  verdictTallyRun, rebuttalSendWith,
} from "../src/commands/explore.js";
import { diffRun as designDiffRun, adjudicateRun } from "../src/commands/design.js";

const TOPIC = "x";
/** Non-empty, no sentinel, and no `AC=` beside it: the shipped still-writing input. */
const HALF = "## Claims\n1. [a:1] half-writ";
const complete = (body: string): string => `${body}\n${END_OF_ARTIFACT}\n`;

let h: { home: string; cleanup: () => void };
beforeEach(() => { h = freshHome(); });
afterEach(() => { h.cleanup(); });

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

/** Every forensics review-feed file written under this test's AP_HOME, concatenated. */
function flagFeed(): string {
  const root = join(h.home, "forensics");
  if (!existsSync(root)) return "";
  return readdirSync(root)
    .flatMap((date) => readdirSync(join(root, date)).map((f) => readFileSync(join(root, date, f), "utf8")))
    .join("\n");
}

/** The backstop's refusal log for one agent's one artifact — present iff the backstop ran. */
const strikeLog = (art: string, artifact: string, agent = "alpha"): string =>
  join(art, `stillwriting-${agent}-${basename(artifact)}.txt`);

/** _explore with alpha + charlie, alpha's findings as given (charlie's always complete). */
function seedFindings(alphaBody: string): string {
  const art = exploreArtDir(TOPIC);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "topic.txt"), "attention kernels");
  writeFileSync(join(art, "list.txt"), "codex\talpha\nclaude\tcharlie\n");
  writeFileSync(join(art, "findings-alpha.md"), alphaBody);
  writeFileSync(join(art, "findings-charlie.md"), complete("## Approaches\n1. [c:1] CharlieOnly — solo\n## Open questions\n- qc1"));
  writeFileSync(join(art, "research-charlie.txt"), "OFFSET=0\nAC=sentinel\nFS=ok\n");
  return art;
}

/** _explore with alpha's adversary critique as given and its `AS=` tag as given. */
function seedCritique(alphaBody: string, alphaTag: string): string {
  const art = seedFindings(complete("## Approaches\n1. [a:1] AlphaOnly — solo"));
  writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
  writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
  writeFileSync(join(art, "adversary-alpha.md"), alphaBody);
  writeFileSync(join(art, "adversary-alpha.txt"), `OFFSET=0\n${alphaTag}\n`);
  writeFileSync(join(art, "adversary-charlie.md"), complete("## Verdict\naccept"));
  writeFileSync(join(art, "adversary-charlie.txt"), "OFFSET=0\nAC=sentinel\nAS=ok\n");
  writeFileSync(join(art, "alpha_only_items.txt"), "[src/only-a.ts:1] AlphaOnly — solo\n");
  writeFileSync(join(art, "charlie_only_items.txt"), "");
  return art;
}

/** _design with alpha + charlie; each worker's findings.md / verify.md as given. */
function seedDesign(files: { findings?: [string, string]; verify?: [string, string] }): string {
  const art = designArtDir(TOPIC);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "list.txt"), "codex\talpha\nclaude\tcharlie\n");
  writeFileSync(join(art, "alpha_only_items.txt"), "[a:1] alpha claim\n");
  writeFileSync(join(art, "charlie_only_items.txt"), "[b:2] charlie claim\n");
  for (const [agent, provider] of [["alpha", "codex"], ["charlie", "claude"]] as const) {
    mkdirSync(workerDir(agent, provider, TOPIC), { recursive: true });
    for (const [name, bodies] of Object.entries(files)) {
      const body = agent === "alpha" ? bodies[0] : bodies[1];
      if (body !== undefined) writeFileSync(join(workerDir(agent, provider, TOPIC), `${name}.md`), body);
    }
  }
  return art;
}

/** Run a verb with stdout swallowed and stderr captured. */
async function run(fn: () => Promise<number>): Promise<{ rc: number; err: string }> {
  const out = captureStdout();
  const err = captureStderr();
  let rc: number;
  try { rc = await fn(); } finally { out.restore(); err.restore(); }
  return { rc, err: err.text() };
}

describe("emptyIsComplete: the sites that short-circuit an empty artifact, and the sites that judge it", () => {
  it("explore openq-collate: an empty findings file routes no questions — rc 0, never judged", async () => {
    const art = seedFindings("");
    const { rc, err } = await run(() => openqCollateRun([TOPIC]));
    expect(rc).toBe(0);
    expect(err).not.toContain("STILL_WRITING");
    expect(existsSync(strikeLog(art, "findings-alpha.md"))).toBe(false);
  });

  it("design adjudicate: an empty verify.md is the VS=skipped path — rc 0, never judged", async () => {
    const art = seedDesign({ verify: ["", complete("## Verdicts\n1. AGREE [a:1] alpha claim")] });
    const { rc, err } = await run(() => adjudicateRun([TOPIC]));
    expect(rc).toBe(0);
    expect(err).not.toContain("STILL_WRITING");
    expect(existsSync(strikeLog(art, "verify.md"))).toBe(false);
  });

  it("explore diff: an empty findings file IS judged — rc 1, strike recorded", async () => {
    const art = seedFindings("");
    const { rc, err } = await run(() => diffExploreRun([TOPIC]));
    expect(rc).toBe(1);
    expect(err).toContain("STILL_WRITING=alpha");
    expect(existsSync(strikeLog(art, "findings-alpha.md"))).toBe(true);
    expect(existsSync(join(art, "diff.md"))).toBe(false);
  });

  it("design diff: an empty findings.md IS judged — rc 1, strike recorded", async () => {
    const art = seedDesign({ findings: ["", complete("## Claims\n1. [c:1] y")] });
    const { rc, err } = await run(() => designDiffRun([TOPIC]));
    expect(rc).toBe(1);
    expect(err).toContain("STILL_WRITING=alpha");
    expect(existsSync(strikeLog(art, "findings.md"))).toBe(true);
    expect(existsSync(join(art, "diff.md"))).toBe(false);
  });

  it("explore rebuttal-send: an empty critique is omitted before any judgement — rc 0, no strike", async () => {
    const art = seedCritique("", "AS=ok");
    const { rc, err } = await run(() => rebuttalSendWith(TOPIC, "charlie", "claude", sendDeps()));
    expect(rc).toBe(0);
    expect(err).not.toContain("STILL_WRITING");
    expect(existsSync(strikeLog(art, "adversary-alpha.md"))).toBe(false);
  });

  // The two sites whose empty branch the CALLER makes unreachable (survivors' own case is pinned in
  // artifact-completeness.test.ts, "a dead worker ... still drops via missing-or-empty").
  for (const [name, verb] of [
    ["synth-preliminary", synthPreliminaryRun],
    ["synth-final", synthFinalRun],
  ] as const) {
    it(`explore ${name}: an empty artifact is dropped by missing-or-empty and never reaches the backstop`, async () => {
      const art = name === "synth-preliminary" ? seedFindings("") : seedCritique("", "AS=ok");
      const artifact = name === "synth-preliminary" ? "findings-alpha.md" : "adversary-alpha.md";
      const { rc, err } = await run(() => verb([TOPIC]));
      expect(rc).toBe(1);
      expect(err).toContain("missing");
      expect(err).not.toContain("STILL_WRITING");
      expect(existsSync(strikeLog(art, artifact))).toBe(false);
    });
  }
});

describe("skipTag: a `<key>=skipped` worker is reported, never judged", () => {
  it("explore rebuttal-send: a skipped peer's leftover critique is omitted — rc 0, no strike", async () => {
    // The input the slot decides: AS=skipped WITH a non-empty unsentinelled critique still on disk.
    const art = seedCritique(HALF, "AS=skipped");
    const { rc, err } = await run(() => rebuttalSendWith(TOPIC, "charlie", "claude", sendDeps()));
    expect(rc).toBe(0);
    expect(err).not.toContain("STILL_WRITING");
    expect(existsSync(strikeLog(art, "adversary-alpha.md"))).toBe(false);
  });

  it("explore verdict-tally: the same worker tallies as skipped — rc 0, no strike", async () => {
    const art = seedCritique(HALF, "AS=skipped");
    const out = captureStdout();
    const err = captureStderr();
    let rc: number;
    try { rc = await verdictTallyRun([TOPIC]); } finally { out.restore(); err.restore(); }
    expect(rc).toBe(0);
    expect(out.text()).toContain("VERDICT=alpha:skipped");
    expect(err.text()).not.toContain("STILL_WRITING");
    expect(existsSync(strikeLog(art, "adversary-alpha.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Refusal attribution: which verb the operator is told to re-run, and which command's review feed
// records the drop. Both come from the row + the site's label, and neither was pinned anywhere.
// ---------------------------------------------------------------------------------------------

interface SiteCase {
  label: string;
  cmd: "explore" | "design";
  artifact: string;                    // basename of the judged artifact
  seed(): string;
  run(): Promise<number>;
}

const SITES: SiteCase[] = [
  {
    label: "explore openq-collate", cmd: "explore", artifact: "findings-alpha.md",
    seed: () => seedFindings(HALF), run: () => openqCollateRun([TOPIC]),
  },
  {
    label: "explore diff", cmd: "explore", artifact: "findings-alpha.md",
    seed: () => seedFindings(HALF), run: () => diffExploreRun([TOPIC]),
  },
  {
    label: "explore survivors", cmd: "explore", artifact: "findings-alpha.md",
    seed: () => seedFindings(HALF), run: () => survivorsRun([TOPIC]),
  },
  {
    label: "explore synth-preliminary", cmd: "explore", artifact: "findings-alpha.md",
    seed: () => seedFindings(HALF), run: () => synthPreliminaryRun([TOPIC]),
  },
  {
    label: "explore rebuttal-send", cmd: "explore", artifact: "adversary-alpha.md",
    seed: () => seedCritique(HALF, "AS=ok"), run: () => rebuttalSendWith(TOPIC, "charlie", "claude", sendDeps()),
  },
  {
    label: "explore synth-final", cmd: "explore", artifact: "adversary-alpha.md",
    seed: () => seedCritique(HALF, "AS=ok"), run: () => synthFinalRun([TOPIC]),
  },
  {
    label: "explore verdict-tally", cmd: "explore", artifact: "adversary-alpha.md",
    seed: () => seedCritique(HALF, "AS=ok"), run: () => verdictTallyRun([TOPIC]),
  },
  {
    label: "design diff", cmd: "design", artifact: "findings.md",
    seed: () => seedDesign({ findings: [HALF, complete("## Claims\n1. [c:1] y")] }), run: () => designDiffRun([TOPIC]),
  },
  {
    label: "design adjudicate", cmd: "design", artifact: "verify.md",
    seed: () => seedDesign({ verify: [HALF, complete("## Verdicts\n1. AGREE [a:1] alpha claim")] }),
    run: () => adjudicateRun([TOPIC]),
  },
];

describe("every site names ITSELF in the refusal and ITS command in the review feed", () => {
  it("covers all nine backstop-consuming sites", () => {
    expect(SITES.length).toBe(9);
    expect(new Set(SITES.map((s) => s.label)).size).toBe(9);
  });

  for (const site of SITES) {
    it(`${site.label}: the refusal, the drop warning and the hub flag all carry it`, async () => {
      const art = site.seed();
      const artifactPath = site.label.startsWith("design")
        ? join(workerDir("alpha", "codex", TOPIC), site.artifact)
        : join(art, site.artifact);

      const first = await run(site.run);
      expect(first.rc).toBe(1);
      expect(first.err).toContain(`${site.label}: alpha ${artifactPath} has no ${END_OF_ARTIFACT}`);
      expect(first.err).toContain("run that phase's wait verb, then retry");

      await run(site.run);                       // strike 2 of 3, no growth
      const third = await run(site.run);         // degrades to the drop path
      expect(third.err).toContain(`${site.label}: alpha still has no ${END_OF_ARTIFACT} after 3 refusals with no growth`);
      expect(flagFeed()).toContain(`command=${site.cmd}`);
      expect(flagFeed()).toContain(`artifact-incomplete: alpha ${artifactPath} dropped as empty after 3 refusals with no growth`);
    });
  }
});
