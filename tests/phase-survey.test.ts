// tests/phase-survey.test.ts — surveyPhaseArtifact, the read every validator does before consuming
// one worker's phase artifact. The nine call sites used to hand-derive the state file, the artifact
// path and the backstop opts; the rule they share is pinned ONCE here, table-driven over rows from
// both commands, and each verb keeps a thin test of its own fan-out in its command suite.
//
// The backstop WRITES (strike logs, stderr), so every slot case also asserts whether the strike log
// appeared: that is what proves a short-circuit really short-circuited instead of judging and
// discarding.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { PHASES, DESIGN_PHASES, surveyPhaseArtifact, type PhaseRow } from "../src/core/phaseTable.js";
import { END_OF_ARTIFACT } from "../src/core/artifact.js";

const TOPIC = "x", AGENT = "alpha", PROVIDER = "codex";
const WORKER = { agent: AGENT, provider: PROVIDER };
const BODY = "## Claims\n1. [a:1] half-writ";

let h: { home: string; cleanup: () => void };
beforeEach(() => { h = freshHome(); });
afterEach(() => { h.cleanup(); });

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

/** Write one worker's phase state file + artifact exactly where the ROW says they live. */
function seed(row: PhaseRow, opts: { state?: string; artifact?: string }): { art: string; artifact: string } {
  const art = row.artDir(TOPIC);
  mkdirSync(art, { recursive: true });
  const artifact = row.artifactFor(art, AGENT, PROVIDER, TOPIC);
  mkdirSync(dirname(artifact), { recursive: true });
  if (opts.artifact !== undefined) writeFileSync(artifact, opts.artifact);
  if (opts.state !== undefined) writeFileSync(join(art, `${row.phase}-${AGENT}.txt`), opts.state);
  return { art, artifact };
}

/** The backstop's per-agent-per-artifact refusal log — present iff the backstop actually ran. */
const strikeLog = (art: string, artifact: string): string => join(art, `stillwriting-${AGENT}-${basename(artifact)}.txt`);

const survey = (row: PhaseRow, over: { emptyIsComplete?: boolean } = {}) =>
  surveyPhaseArtifact(row, WORKER, { topic: TOPIC, label: "test survey", emptyIsComplete: false, ...over });
/** The skipTag overload — a DIFFERENT return type, so it cannot share the binding above. */
const surveySkip = (row: PhaseRow, over: { emptyIsComplete?: boolean } = {}) =>
  surveyPhaseArtifact(row, WORKER, { topic: TOPIC, label: "test survey", emptyIsComplete: false, ...over, skipTag: true });

/** One row per command/artifact shape: explore's art-dir-flat findings, explore's critique (a
 *  different key), and design's per-worker-dir verify.md. */
const ROWS: PhaseRow[] = [
  PHASES.find((p) => p.phase === "research")!,
  PHASES.find((p) => p.phase === "adversary")!,
  DESIGN_PHASES.find((p) => p.phase === "verify")!,
];

describe("surveyPhaseArtifact (table-driven over rows of both commands)", () => {
  for (const row of ROWS) {
    const KEY = row.key;
    describe(`${row.cmd} ${row.phase}`, () => {
      it("reads the state file and the artifact the ROW names", () => {
        seed(row, { state: `OFFSET=0\nAC=sentinel\n${KEY}=ok\n`, artifact: BODY });
        const s = survey(row);
        expect(s.text).toBe(BODY);   // the bytes judged are the bytes returned
        expect(s.tag).toBe("ok");
        expect(s.verdict).toBe("complete");
      });

      it("no AC= line (the gate-skipping hub) → still-writing, strike recorded", () => {
        const { art, artifact } = seed(row, { state: `OFFSET=0\n${KEY}=ok\n`, artifact: BODY });
        const err = captureStderr();
        let s;
        try { s = survey(row); } finally { err.restore(); }
        expect(s.verdict).toBe("still-writing");
        expect(err.text()).toContain(`STILL_WRITING=${AGENT}`);
        expect(readFileSync(strikeLog(art, artifact), "utf8")).toBe(`${AGENT} ${BODY.length}\n`);
      });

      it("AC=expired → drop", () => {
        seed(row, { state: `OFFSET=0\nAC=expired\n${KEY}=ok\n`, artifact: BODY });
        expect(survey(row).verdict).toBe("drop");
      });

      it("AC=quiescent → complete (the wait's verdict stands, sentinel or not)", () => {
        seed(row, { state: `OFFSET=0\nAC=quiescent\n${KEY}=empty\n`, artifact: BODY });
        const s = survey(row);
        expect(s.verdict).toBe("complete");
        expect(s.tag).toBe("empty");  // the CONTENT classification never decides the verdict
      });

      it("the sentinel alone is enough, with no state file at all (tag null)", () => {
        seed(row, { artifact: `${BODY}\n${END_OF_ARTIFACT}\n` });
        const s = survey(row);
        expect(s.verdict).toBe("complete");
        expect(s.tag).toBe(null);
      });

      it("emptyIsComplete: an empty artifact short-circuits to complete WITHOUT judging it", () => {
        const { art, artifact } = seed(row, { state: `OFFSET=0\n${KEY}=ok\n`, artifact: "  \n" });
        const err = captureStderr();
        let s;
        try { s = survey(row, { emptyIsComplete: true }); } finally { err.restore(); }
        expect(s.verdict).toBe("complete");
        expect(err.text()).toBe("");
        expect(existsSync(strikeLog(art, artifact))).toBe(false);
      });

      it("without emptyIsComplete the same empty artifact IS judged (still-writing, strike)", () => {
        const { art, artifact } = seed(row, { state: `OFFSET=0\n${KEY}=ok\n`, artifact: "  \n" });
        const err = captureStderr();
        let s;
        try { s = survey(row); } finally { err.restore(); }
        expect(s.verdict).toBe("still-writing");
        expect(existsSync(strikeLog(art, artifact))).toBe(true);
      });

      it(`skipTag: ${KEY}=skipped returns the skipped branch WITHOUT judging the artifact`, () => {
        const { art, artifact } = seed(row, { state: `${KEY}=skipped\n`, artifact: BODY });
        const err = captureStderr();
        let s;
        try { s = surveySkip(row); } finally { err.restore(); }
        expect(s).toEqual({ skipped: true }); // no verdict and no text: the caller MUST narrow first
        expect(err.text()).toBe("");
        expect(existsSync(strikeLog(art, artifact))).toBe(false);
      });

      it(`without skipTag the same ${KEY}=skipped artifact is judged like any other`, () => {
        seed(row, { state: `${KEY}=skipped\n`, artifact: BODY });
        const err = captureStderr();
        let s;
        try { s = survey(row); } finally { err.restore(); }
        expect(s.verdict).toBe("still-writing");
      });

      it("an absent artifact reads as empty, not as a crash", () => {
        seed(row, { state: `OFFSET=0\nAC=expired\n${KEY}=timeout\n` });
        const s = survey(row);
        expect(s.text).toBe("");
        expect(s.verdict).toBe("drop");
      });
    });
  }

  it("skipTag's branch cannot be consumed without narrowing it away (compile-time)", () => {
    // The slot is only safe because opting into it CHANGES the return type: a site that adds
    // `skipTag` and then reads the verdict as before stops compiling, instead of silently treating
    // every skipped worker as a judged one.
    const row = ROWS[0];
    seed(row, { state: `${row.key}=skipped\n`, artifact: BODY });
    const s = surveySkip(row);
    // @ts-expect-error — `verdict` does not exist on the skipped branch
    const unguarded = s.verdict;
    expect(unguarded).toBeUndefined();
    expect("skipped" in s ? "narrowed" : s.verdict).toBe("narrowed");
  });

  it("the label + command reach the backstop's refusal log (per-verb attribution)", () => {
    const row = ROWS[0];
    seed(row, { state: "OFFSET=0\nFS=ok\n", artifact: BODY });
    const err = captureStderr();
    try {
      surveyPhaseArtifact(row, WORKER, { topic: TOPIC, label: "explore survivors", emptyIsComplete: false });
    } finally { err.restore(); }
    expect(err.text()).toContain(`explore survivors: ${AGENT} `);
  });
});
