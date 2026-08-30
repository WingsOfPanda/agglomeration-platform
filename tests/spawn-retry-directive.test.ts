// tests/spawn-retry-directive.test.ts — GitHub issue #175, a producer<->consumer contract in the
// style of tests/spawn-timeout-directive.test.ts: a codex worker dying at bootstrap is transient and
// recurring, so `spawn` PRODUCES one machine-readable failure reason on stdout and the single-worker
// directives CONSUME it to retry a cold start exactly once. `explore` has tolerated this since its
// Phase 2 (spawn-retry-once); quick/implement treated any non-zero spawn as terminal.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { captureSpawnFailure } from "../src/core/forensics.js";
import { globalRoot } from "../src/core/paths.js";

describe("spawn prints ONE machine-readable failure reason on stdout", () => {
  let env: { home: string; cleanup: () => void };
  beforeEach(() => { env = freshHome(); });
  afterEach(() => { env.cleanup(); });

  // The retryable pair and one deterministic reason: the directives branch on exactly this token.
  for (const reason of ["pane_dead", "timeout", "binary_not_found"]) {
    it(`emits 'SPAWN_FAILED reason=${reason}' exactly once`, () => {
      const out = captureStdout();
      try { captureSpawnFailure({ agent: "lima", model: "codex", topic: "t", reason, detail: "d" }); }
      finally { out.restore(); }
      expect(out.text().match(/^SPAWN_FAILED reason=\S+$/gm)).toEqual([`SPAWN_FAILED reason=${reason}`]);
    });
  }

  it("still prints when the record cannot be filed — the line is a CLI contract, not a byproduct", () => {
    mkdirSync(globalRoot(), { recursive: true });
    writeFileSync(join(globalRoot(), "forensics"), "x"); // a FILE where the queue dir would go
    const out = captureStdout();
    try { expect(captureSpawnFailure({ agent: "a", model: "b", topic: "t", reason: "pane_dead", detail: "x" })).toBe(""); }
    finally { out.restore(); }
    expect(out.text()).toContain("SPAWN_FAILED reason=pane_dead");
  });
});

// Pins are whitespace-collapsed so re-wrapping the prose does not break them.
const flat = (p: string) => readFileSync(join(process.cwd(), "commands", p), "utf8").replace(/\s+/g, " ");
/** One directive paragraph, anchor to anchor. Both indices are asserted: `indexOf` returns -1 for a
 *  missing anchor, and `slice(-1, n)` silently yields an empty or inverted range — so a renamed
 *  anchor must fail HERE, naming itself, not as six confusing `toContain` failures downstream. */
const para = (p: string, start: string, end: string): string => {
  const f = flat(p);
  const a = f.indexOf(start), b = f.indexOf(end);
  if (a < 0) throw new Error(`${p}: slice start anchor missing: ${start}`);
  if (b < 0) throw new Error(`${p}: slice end anchor missing: ${end}`);
  return f.slice(a, b);
};
// 0.5.64 appended the provider-fallback paragraph INSIDE what used to be the retry slice, so the
// retry slice is re-bounded at the fallback's anchor: three of its pins (`pane_dead`, `timeout`,
// `once`) would otherwise be satisfiable by the fallback text alone.
const FALLBACK_ANCHOR = "**provider fallback**";
const ENDS: Array<[string, string]> = [
  ["quick.md", "Dispatch round 1"],
  ["implement.md", "## Stage 1 — run the worker turn"],
];
const RETRY_PARAGRAPHS: Array<[string, string]> =
  ENDS.map(([rel]) => [rel, para(rel, "**spawn-retry-once**", FALLBACK_ANCHOR)]);
const FALLBACK_PARAGRAPHS: Array<[string, string]> =
  ENDS.map(([rel, end]) => [rel, para(rel, FALLBACK_ANCHOR, end)]);

describe("the single-worker directives consume that reason (spawn-retry-once)", () => {
  for (const [rel, para] of RETRY_PARAGRAPHS) {
    it(`${rel} branches on the stdout line, not on stderr`, () => {
      expect(para, `${rel} must name the line a hub greps for`).toContain("SPAWN_FAILED reason=");
    });

    it(`${rel} retries the cold-start reasons exactly once`, () => {
      expect(para, `${rel} must name pane_dead as retryable`).toContain("pane_dead");
      expect(para, `${rel} must name timeout as retryable`).toContain("timeout");
      expect(para, `${rel} must bound the retry at one`).toContain("once");
    });

    it(`${rel} refuses to retry a deterministic reason`, () => {
      expect(para, `${rel} must name binary_not_found as non-retried`)
        .toContain("Every other reason (`binary_not_found`");
      expect(para).toContain("deterministic");
    });

    // 0.5.64: the paragraph used to end "and so is a **second** failure, whatever its reason" and
    // then stop the run — an unqualified terminal that contradicts the fallback outright. The
    // exception has to live HERE, before the abort instruction, or a hub reading in order stops.
    it(`${rel} qualifies the second failure with the fallback exception`, () => {
      expect(para, `${rel} must carve the codex cold-start case out of the terminal second failure`)
        .toContain("A **second** failure with provider `codex` and reason `pane_dead` or `timeout` is NOT terminal");
    });
  }
});

// The 0.5.64 provider fallback: the SECOND cold-start death of a codex worker switches the run to
// claude instead of ending it. Pins are deliberately discriminating — a bare `terminal` is
// satisfied by the retry sentence that bleeds into the head of this slice, and carries no signal.
describe("the directives consume a SECOND cold-start failure (provider fallback)", () => {
  for (const [rel, para] of FALLBACK_PARAGRAPHS) {
    it(`${rel} triggers only on codex`, () => {
      expect(para, `${rel} must gate the fallback on the run's provider`).toContain("the run's provider is `codex`");
      expect(para, `${rel} must say a non-codex run is terminal`).toContain("a provider other than codex");
    });

    it(`${rel} excludes the deterministic reasons, in its own words`, () => {
      // Worded differently from the retry paragraph's "Every other reason (" on purpose: neither
      // slice may satisfy the other's pin.
      expect(para).toContain("Any other reason (`binary_not_found`, `config_error`, `killed`");
    });

    it(`${rel} names the second spawn's reason, not the first's`, () => {
      expect(para, `${rel} must disambiguate which SPAWN_FAILED line supplies <reason>`)
        .toContain("is the **second** spawn's value");
    });

    it(`${rel} re-routes, records and flags in one verb call`, () => {
      expect(para).toContain("set-provider");
      expect(para, `${rel} must pass the closed reason token to the verb`).toContain("claude --reason");
      expect(para, `${rel} must name the artifact the verb writes`).toContain("provider-fallback.txt");
      expect(para, `${rel} must carry the token the flag and job status print`).toContain("PROVIDER_FALLBACK");
    });

    it(`${rel} rebinds PROVIDER for the rest of the run`, () => {
      expect(para, `${rel} must rebind the hub's own PROVIDER value, not just the file`)
        .toContain("Rebind **`PROVIDER=claude`** for the rest of this run");
      expect(para, `${rel} must say why: the codex worker dir is archived`).toContain("status.json");
    });

    it(`${rel} warns the operator verbatim, attached or detached`, () => {
      expect(para).toContain("WARNING: codex worker failed at spawn twice");
      expect(para).toContain("It will use claude tokens.");
      expect(para, `${rel} must forbid parking a detached run on this`).toContain("neither asks nor parks");
    });

    it(`${rel} stops after ONE fallback spawn`, () => {
      expect(para, `${rel} must forbid a third attempt`).toContain("no third retry, no further fallback");
    });

    it(`${rel} names the switch in the run's closing report`, () => {
      expect(para).toContain("names the switch");
    });
  }

  it("implement bypasses the claude-confirm gate on the fallback", () => {
    const p = FALLBACK_PARAGRAPHS.find(([rel]) => rel === "implement.md")![1];
    expect(p, "the gate would re-ask a question the WARNING line already discloses")
      .toContain("Claude-confirm gate is NOT re-applied");
  });
});
