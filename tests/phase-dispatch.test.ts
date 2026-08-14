// tests/phase-dispatch.test.ts — the switch and the phase table must agree.
//
// Both commands dispatch their `-send` verbs from an explicit case and their `-wait` verbs off
// PHASES/DESIGN_PHASES. Nothing else checks that the two halves stay in step: a new row whose
// `-send` case nobody wrote, or a case for a phase that has no row, would both dispatch to `usage`
// at runtime and be found by an operator rather than by the suite. Each verb is probed with NO
// arguments — the arg-parse refusal names the verb, and no phase state is touched.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freshHome } from "./helpers/tmpHome.js";
import { PHASES, DESIGN_PHASES, type PhaseRow } from "../src/core/phaseTable.js";
import { run as exploreRun } from "../src/commands/explore.js";
import { run as designRun } from "../src/commands/design.js";

let h: { home: string; cleanup: () => void };
beforeEach(() => { h = freshHome(); });
afterEach(() => { h.cleanup(); });

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

async function probe(run: (a: string[]) => Promise<number>, verb: string): Promise<{ rc: number; err: string }> {
  const err = captureStderr();
  let rc: number;
  try { rc = await run([verb]); } finally { err.restore(); }
  return { rc, err: err.text() };
}

const COMMANDS: Array<{ cmd: "explore" | "design"; rows: PhaseRow[]; run: (a: string[]) => Promise<number> }> = [
  { cmd: "explore", rows: PHASES, run: exploreRun },
  { cmd: "design", rows: DESIGN_PHASES, run: designRun },
];

for (const { cmd, rows, run } of COMMANDS) {
  describe(`${cmd}: every phase row has both verbs, and no verb outlives its row`, () => {
    for (const row of rows) {
      for (const half of ["send", "wait"] as const) {
        it(`${row.phase}-${half} dispatches to its own arg-parse`, async () => {
          const { rc, err } = await probe(run, `${row.phase}-${half}`);
          expect(rc).toBe(2);
          expect(err).toBe(`[FAIL]  usage: ${cmd} ${row.phase}-${half} <topic> <agent> <provider>\n`);
        });
      }

      it(`${row.phase}'s two verbs are named in the command usage line`, async () => {
        const { err } = await probe(run, "no-such-verb");
        expect(err).toContain(`${row.phase}-send`);
        expect(err).toContain(`${row.phase}-wait`);
      });
    }

    it("a stem with no row falls through to the command usage, never to a phase", async () => {
      for (const verb of ["bogus-send", "bogus-wait", "-wait", "wait"]) {
        const { rc, err } = await probe(run, verb);
        expect(rc).toBe(2);
        expect(err).toContain(`usage: ${cmd} <`);
      }
    });
  });
}

// The verbs that take a phase as an ARGUMENT resolve it through the same table. Their alternations
// are spelled out literally here — they are operator-facing text, and generating them from the rows
// must not be a licence to change what they say (or the order they say it in).
describe("the phase-argument verbs name every phase, in pipeline order", () => {
  const cases: Array<[string, string[], string]> = [
    ["explore wait-gate: usage", ["wait-gate"],
      "[FAIL]  usage: explore wait-gate <topic> <research|openq|crossverify|adversary|rebuttal|gap|signoff>\n"],
    ["explore wait-gate: unknown phase", ["wait-gate", "t", "nope"],
      "[FAIL]  explore wait-gate: phase must be research|openq|crossverify|adversary|rebuttal|gap|signoff (got nope)\n"],
  ];
  for (const [name, argv, expected] of cases) {
    it(name, async () => {
      const err = captureStderr();
      let rc: number;
      try { rc = await exploreRun(argv); } finally { err.restore(); }
      expect(rc).toBe(2);
      expect(err.text()).toBe(expected);
    });
  }

  const designCases: Array<[string, string[], string]> = [
    ["design wait-gate: usage", ["wait-gate"], "[FAIL]  usage: design wait-gate <topic> <research|verify>\n"],
    ["design wait-gate: unknown phase", ["wait-gate", "t", "nope"], "[FAIL]  design wait-gate: phase must be research|verify (got nope)\n"],
    ["design offset-reset: unknown phase", ["offset-reset", "t", "alpha", "nope"],
      "[FAIL]  design offset-reset: phase must be research|verify (got nope)\n"],
  ];
  for (const [name, argv, expected] of designCases) {
    it(name, async () => {
      const err = captureStderr();
      let rc: number;
      try { rc = await designRun(argv); } finally { err.restore(); }
      expect(rc).toBe(2);
      expect(err.text()).toBe(expected);
    });
  }
});
