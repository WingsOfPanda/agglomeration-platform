// tests/spawn-timeout-directive.test.ts — L3, a producer<->consumer contract in the style of
// tests/implement-verify-tests.test.ts: every directive that issues `spawn` must bound the call at
// 300000ms. spawn's own bootstrap deadline is `bootstrap_sleep_s + ready_timeout_s` (codex 20+150,
// claude 12+150, config/contracts.yaml), so ANY caller running on the Bash tool's 120s default
// SIGTERMs the spawn before its own deadline can fire — GitHub issue #157, and the same mechanism
// recorded once before on 2026-08-06 as guidance that never became directive text.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentBootstrapSleep, agentReadyTimeout } from "../src/core/contracts.js";
import { IDENTITY_BLOCKS } from "../src/core/ipc.js";

const md = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

/** Every directive text that tells a hub to run `spawn`. The job hub's is no longer a file: it is
 *  the role block the one identity template is rendered with. */
const SPAWN_DIRECTIVES: Array<[string, string]> = [
  [join("commands", "quick.md"), md("commands", "quick.md")],
  [join("commands", "implement.md"), md("commands", "implement.md")],
  ["the job-hub identity block", IDENTITY_BLOCKS["job-hub"].role_block],
];

const TIMEOUT_SENTENCE = "MUST carry `timeout: 300000`";
const NO_ECHO_RC = 'Never append `; echo "rc=$?"`';
const NO_UNBOUNDED = "unbounded `until ... sleep` loop";
const KILLED_RC = "exits **143**";

describe("spawn Bash-call contract <-> the directives that issue it", () => {
  for (const [rel, md] of SPAWN_DIRECTIVES) {
    it(`${rel} bounds the spawn call at 300000ms`, () => {
      expect(md, `${rel} lets a hub spawn on the Bash tool's 120s default, which always loses to bootstrap`)
        .toContain(TIMEOUT_SENTENCE);
    });

    it(`${rel} forbids appending an rc echo to the spawn call`, () => {
      expect(md, `${rel} must forbid '; echo "rc=$?"' — it masks the rc the next step branches on`)
        .toContain(NO_ECHO_RC);
    });

    it(`${rel} forbids an unbounded until/sleep wait`, () => {
      expect(md, `${rel} must forbid the unbounded poll loop; only the bounded wait verbs wait`)
        .toContain(NO_UNBOUNDED);
    });

    it(`${rel} says what a killed spawn's exit code means`, () => {
      expect(md, `${rel} must tell the hub that 143 is a spawn failure, not an unknown rc`)
        .toContain(KILLED_RC);
    });
  }

  // The number in the directives is not folklore: it must outlast the worst bootstrap contracts.yaml
  // can ask for. If a provider's budget ever grows past it, this fails before a field run does.
  it("300000ms still clears the worst bootstrap_sleep_s + ready_timeout_s in contracts.yaml", () => {
    for (const model of ["codex", "claude"]) {
      const worst = (agentBootstrapSleep(model) + agentReadyTimeout(model)) * 1000;
      expect(worst, `${model}'s bootstrap budget has outgrown the directives' timeout: 300000`).toBeLessThan(300_000);
    }
  });
});
