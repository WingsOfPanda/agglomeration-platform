import { describe, it, expect } from "vitest";
import { validateSlug, resolveMode, isWorkerRole, bootstrapFailureRc } from "../src/commands/spawn.js";

describe("spawn pure helpers", () => {
  it("validateSlug accepts lowercase/digit/hyphen ≤32, rejects others", () => {
    expect(validateSlug("auth-review")).toBe(true);
    expect(validateSlug("Bad")).toBe(false);
    expect(validateSlug("has space")).toBe(false);
    expect(validateSlug("x".repeat(33))).toBe(false);
    expect(validateSlug("")).toBe(false);
  });
  it("resolveMode: explicit > default > full", () => {
    expect(resolveMode("read-only", "full")).toBe("read-only");
    expect(resolveMode(undefined, "full")).toBe("full");
    expect(resolveMode(undefined, undefined)).toBe("full");
  });
});

// The `--role` gate, without creating a pane: an unknown value must never fall back to the
// permissive template, and the third role (design D) has to be admitted by the same table the
// identity is rendered from — a role spelled in one and missing from the other is the drift the
// predicate exists to make impossible.
describe("isWorkerRole — the --role gate", () => {
  it("admits exactly the three identity roles, slice included", () => {
    expect(isWorkerRole("worker")).toBe(true);
    expect(isWorkerRole("job-hub")).toBe(true);
    expect(isWorkerRole("slice")).toBe(true);
  });
  it("refuses anything else, prototype keys included", () => {
    for (const bad of ["superuser", "hub", "Slice", "slices", "", "constructor", "toString"]) {
      expect(isWorkerRole(bad), bad).toBe(false);
    }
  });
});

// `implement spawn-slices` branches on spawn's RETURN CODE (the `SPAWN_FAILED reason=` line is a
// directive contract a Bash step greps, invisible in-process), retrying only the cold-start pair.
// Every existing caller — `spawnTally`, `job start` — tests zero-vs-non-zero, so the split moves
// nothing for them.
describe("bootstrapFailureRc — 3 for a cold start, 1 for the worker's own error", () => {
  it("pane_dead and timeout are rc 3", () => {
    expect(bootstrapFailureRc("pane_dead")).toBe(3);
    expect(bootstrapFailureRc("timeout")).toBe(3);
  });
  it("error_event stays rc 1 — the worker reported, a retry would meet the same failure", () => {
    expect(bootstrapFailureRc("error_event")).toBe(1);
  });
  it("every code is still non-zero, which is all any shipped caller reads", () => {
    for (const reason of ["pane_dead", "timeout", "error_event"] as const) {
      expect(bootstrapFailureRc(reason)).not.toBe(0);
    }
  });
});
