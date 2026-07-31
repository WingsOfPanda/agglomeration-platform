// tests/helpers/phaseDeps.ts — override factories for the shared phase send/wait deps.
// Every explore/design phase verb takes the same two DI shapes (core/phaseTable.ts), so the stub
// literals were copied ~88 times across the suite. Pattern: implement-turn-cmd.test.ts's
// sendDeps/waitDeps. Defaults are the inert ones (offset 0, send ok, no event, multiplier 1);
// pass only the slot a test actually asserts on.
import type { SendDeps, WaitDeps } from "../../src/core/phaseTable.js";

export function sendDeps(over: Partial<SendDeps> = {}): SendDeps {
  return {
    offsetFor: over.offsetFor ?? (() => 0),
    send: over.send ?? (async () => 0),
  };
}

export function waitDeps(over: Partial<WaitDeps> = {}): WaitDeps {
  return {
    wait: over.wait ?? (async () => null),
    multiplier: over.multiplier ?? (() => "1"),
  };
}
