// tests/turn-wait-monitor.test.ts — GitHub issue #161. The IN-RUN turn waits are the longest waits
// in the pipeline (14400s budget x AP_WAIT_EXTEND_MULT 3 = 12h worst case), and until 0.5.55 both
// directives armed them as a plain background Bash task — the exact form the SAME two files forbid
// for the detached launch path ("Arm the watch as a persistent Monitor, never a plain background
// shell"). A background task killed from outside is silent, and a silent wait is indistinguishable
// from a dead worker: quick.md's TS=failed/timeout branch would then abort a HEALTHY run
// unattended on the second kill. This file pins the two halves of the fix as directive text —
// the Monitor arming, and the rule that a wait dying without a TS= line is never a worker verdict.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_BLOCKS } from "../src/core/ipc.js";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const DIRECTIVES = [
  ["commands/quick.md", read("commands", "quick.md")],
  ["commands/implement.md", read("commands", "implement.md")],
] as const;

/** The sentence the field run turned on: it must survive re-wrapping intact, so it stays on ONE
 *  line in both files. */
const WATCHER_RULE =
  "a wait that dies without a `TS=` line is a WATCHER failure, not a worker outcome";

describe("in-run turn waits are armed as a persistent Monitor (issue #161)", () => {
  for (const [name, md] of DIRECTIVES) {
    it(`${name} arms its turn wait with Monitor(persistent: true`, () => {
      // Two Monitors now live in each file: the detached LAUNCH watch (which wraps `job wait`) and
      // the in-run TURN wait. Assert the turn one specifically — some Monitor block must wrap the
      // `turn-wait` verb, so a file that kept only the launch Monitor still fails.
      const blocks = md.split("Monitor(persistent: true").slice(1);
      expect(blocks.length, `${name} has no persistent Monitor at all`).toBeGreaterThan(0);
      const wrapsTurnWait = blocks.some((b) => b.slice(0, b.indexOf("```")).includes("turn-wait"));
      expect(wrapsTurnWait, `${name}'s turn wait is not armed as a persistent Monitor`).toBe(true);
    });

    it(`${name} no longer backgrounds a turn wait in a plain shell`, () => {
      const offenders = md
        .split("\n")
        .filter((l) => /turn-wait/.test(l) && /run_in_background/.test(l));
      expect(offenders, `${name} still arms a turn wait with run_in_background`).toEqual([]);
      // and the pre-0.5.55 arming lines are gone by their exact text, not merely joined
      expect(md).not.toContain("run_in_background: true, description='quick await turn 1'");
      expect(md).not.toContain(`Bash(command='$CS implement turn-wait "$TOPIC" "$ROUND"', run_in_background: true,`);
    });

    it(`${name} reads the turn's outcome back out of the record`, () => {
      // The discriminator: the Monitor prints the verb's own TS= line, or says the WATCH failed.
      expect(md, `${name}'s Monitor never derives a TS=`).toContain(
        `ok|failed|timeout|question) printf "TS=%s\\n" "$TS"; exit 0;;`,
      );
      expect(md, `${name} has no loud ending for a watch that produced nothing`).toContain(
        `*) printf "TS=unreachable\\n"; exit 1;;`,
      );
    });

    it(`${name} carries the watcher-failure rule, verbatim and on one line`, () => {
      expect(md, `${name} lost the rule that saved the field run`).toContain(WATCHER_RULE);
      expect(
        md.split("\n").some((l) => l.includes(WATCHER_RULE)),
        `${name} re-wrapped the watcher-failure sentence across lines`,
      ).toBe(true);
    });

    it(`${name} documents TS=unreachable as its own branch, not a failure`, () => {
      expect(md, `${name} documents no TS=unreachable branch`).toContain("TS=unreachable");
      const i = md.indexOf(WATCHER_RULE);
      const rule = md.slice(i, i + 900);
      // The branch is only useful if it sends the reader to a MECHANICAL worker check.
      expect(rule, `${name}'s unreachable branch names no mechanical worker check`).toContain("status.json");
      expect(rule, `${name}'s unreachable branch never re-arms the watch`).toContain("re-arm the same Monitor");
    });
  }

  // The launch-path Monitor is what the turn wait now mirrors; if that rationale ever leaves the
  // files, the turn-wait shape loses the sentence it was argued from.
  it("both directives still forbid the plain background shell for the launch watch", () => {
    for (const [name, md] of DIRECTIVES) {
      expect(md, `${name} lost the launch-path Monitor rule`)
        .toContain("persistent **Monitor**, never a plain background shell");
    }
  });
});

describe("the job hub's backgrounding grant matches the directives (issue #161)", () => {
  // The job-hub identity's role block (was config/prompt-templates/job-hub.md, now the only
  // role-varying text of the one identity template).
  const hub = IDENTITY_BLOCKS["job-hub"].role_block;

  it("still grants backgrounding for the other wait verbs", () => {
    expect(hub).toContain("Backgrounding is expected of you");
    expect(hub).toContain("run_in_background: true");
  });

  it("carves the TURN waits out and sends the hub to the directive's Monitor block", () => {
    expect(hub, "the job-hub block still tells the hub to background every *-wait verb")
      .not.toContain("Dispatch the directive's `*-wait` verbs with `run_in_background: true`");
    expect(hub).toContain("persistent **Monitor**");
    expect(hub).toContain("run the directive's Monitor block as written");
  });
});
