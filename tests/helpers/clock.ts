// tests/helpers/clock.ts — the wait module's injected time source, for tests.
// The clock is injected at the ENGINE (src/core/ipc.ts), so a test that binds one of these can run
// the REAL poll loop — its matcher and its liveness extension — over a real temp outbox, at CPU
// speed, instead of asserting on a mocked-away wait. Most of the suite still injects a `wait`; what
// these buy is that the wait module's OWN tests no longer have to choose between the two.
import type { Clock } from "../../src/core/ipc.js";

/** A clock that never actually sleeps. For the many tests that only care about a wait's VERDICT:
 *  the confirmation window and the artifact grace loop stop costing real seconds, exactly as the
 *  injected no-op `sleep` did before the clock existed. */
export const noSleepClock: Clock = { now: () => Date.now(), sleep: async () => {} };

/** A clock where time only moves when the code under test sleeps: `sleep(ms)` advances `now` by
 *  `ms` and returns immediately, and anything scheduled with `at(ms, fn)` fires as `now` passes it.
 *  A worker "still writing during the window", or an event landing past the base budget but inside
 *  the liveness extension, is then deterministic and instant. */
export function virtualClock(t0 = 1_700_000_000_000): {
  clock: Clock;
  at(ms: number, run: () => void): void;
  elapsed(): number;
} {
  let t = t0;
  const timeline: Array<{ at: number; run: () => void }> = [];
  const fire = (): void => {
    while (timeline.length > 0 && timeline[0].at <= t - t0) timeline.shift()!.run();
  };
  return {
    clock: {
      now: () => t,
      sleep: async (ms) => { t += ms; fire(); },
    },
    at: (ms, run) => { timeline.push({ at: ms, run }); timeline.sort((a, b) => a.at - b.at); },
    elapsed: () => t - t0,
  };
}
