// tests/phase-table.test.ts — invariants of the phase table itself (src/core/phaseTable.ts).
// The per-phase send/wait behavior is exercised table-driven in explore-cmd.test.ts; here we pin the
// DATA: the row slots, the guard-chain completeness rule, and the two deliberately-unmerged guard
// encodings (including the pipeline-unreachable input where they disagree).
// LOAD-BEARING: four slots (timeoutKind, artifactFor, skippable, guard.kind) are pinned ONLY here —
// the explore-cmd table suite reads the row for both sides of its assertions — so weakening this
// file silently untests those values (established by the 2026-07-31 mutation audit).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import {
  PHASES, DESIGN_PHASES, anyPriorUnsafe, latestNonSkippedUnsafe, guardSkipped,
  type PhaseKey, type PhaseRow,
} from "../src/core/phaseTable.js";
import { researchState, verifyState } from "../src/core/designTurn.js";

const ALL: PhaseRow[] = [...PHASES, ...DESIGN_PHASES];
const id = (r: PhaseRow) => `${r.cmd}/${r.phase}`;

describe("PHASES/DESIGN_PHASES shape", () => {
  it("keys, phase stems and artifacts are distinct within a command", () => {
    const { home, cleanup } = freshHome();
    try {
      for (const table of [PHASES, DESIGN_PHASES]) {
        expect(new Set(table.map((r) => r.key)).size).toBe(table.length);
        expect(new Set(table.map((r) => r.phase)).size).toBe(table.length); // state-file + verb stem
        const artifacts = table.map((r) => r.artifactFor(home, "alpha", "codex", "t"));
        expect(new Set(artifacts).size).toBe(table.length);
      }
      expect(PHASES.every((r) => r.cmd === "explore")).toBe(true);
      expect(DESIGN_PHASES.every((r) => r.cmd === "design")).toBe(true);
    } finally { cleanup(); }
  });

  it("timeoutKind per row — crossverify reuses design's verify budget, not a 'crossverify' key", () => {
    const kinds = Object.fromEntries(ALL.map((r) => [id(r), r.timeoutKind]));
    expect(kinds).toEqual({
      "explore/research": "research",
      "explore/openq": "openq",
      "explore/crossverify": "verify", // NOT "crossverify"
      "explore/adversary": "adversary",
      "explore/rebuttal": "rebuttal",
      "explore/gap": "gap",
      "explore/signoff": "signoff",
      "design/research": "research",
      "design/verify": "verify",
    });
  });

  it("skippable=false for exactly the two research rows (nothing precedes them)", () => {
    expect(ALL.filter((r) => !r.skippable).map(id)).toEqual(["explore/research", "design/research"]);
  });

  it("stateFn: researchState for the research rows, verifyState for every later phase", () => {
    for (const r of ALL) {
      expect(r.stateFn).toBe(r.phase === "research" ? researchState : verifyState);
    }
  });

  it("explore artifacts are art-dir flat; design artifacts are per-worker (provider+topic)", () => {
    const { home, cleanup } = freshHome();
    try {
      for (const r of PHASES) {
        const stem = r.phase === "research" ? "findings" : r.phase;
        expect(r.artifactFor(home, "alpha", "codex", "t")).toBe(join(home, `${stem}-alpha.md`));
        // provider/topic are inert for explore — the same file whatever the worker runs on
        expect(r.artifactFor(home, "alpha", "claude", "other")).toBe(r.artifactFor(home, "alpha", "codex", "t"));
      }
      for (const r of DESIGN_PHASES) {
        const path = r.artifactFor(home, "alpha", "codex", "t");
        expect(path.endsWith(r.phase === "research" ? "findings.md" : "verify.md")).toBe(true);
        expect(r.artifactFor("/nowhere", "alpha", "codex", "t")).toBe(path); // worker dir, not the art dir
        expect(r.artifactFor(home, "alpha", "claude", "t")).not.toBe(path); // provider is load-bearing
        expect(r.artifactFor(home, "alpha", "codex", "other")).not.toBe(path); // so is the topic
      }
    } finally { cleanup(); }
  });

  it("guards: the six post-research explore rows only — design dispatches behind its own gate", () => {
    expect(PHASES.filter((r) => r.guard).map((r) => r.phase))
      .toEqual(["openq", "crossverify", "adversary", "rebuttal", "gap", "signoff"]);
    expect(DESIGN_PHASES.some((r) => r.guard)).toBe(false);
    expect(Object.fromEntries(PHASES.filter((r) => r.guard).map((r) => [r.phase, [r.guard!.kind, r.guard!.noun]])))
      .toEqual({
        openq: ["any", "research"],
        crossverify: ["any", "previous phase"],
        adversary: ["any", "previous phase"],
        rebuttal: ["latest", "latest phase"],
        gap: ["latest", "latest phase"],
        signoff: ["latest", "latest phase"],
      });
  });
});

describe("guard chains", () => {
  it("SET-completeness: a chain holds EVERY earlier same-command phase key", () => {
    for (const table of [PHASES, DESIGN_PHASES]) {
      table.forEach((row, i) => {
        if (!row.guard) return;
        const earlier = table.slice(0, i).map((p) => p.key);
        expect([...row.guard.chain].sort()).toEqual([...earlier].sort()); // set equality, order-free
      });
    }
  });

  it("a chain names only earlier phases, each exactly once", () => {
    PHASES.forEach((row, i) => {
      if (!row.guard) return;
      const chain = row.guard.chain;
      expect(new Set(chain).size).toBe(chain.length);
      const laterOrSelf = PHASES.slice(i).map((p) => p.key);
      expect(chain.filter((k) => laterOrSelf.includes(k))).toEqual([]);
    });
  });

  it("chain ORDER is transcribed per site, not derived (it picks the KEY=value the warning names)", () => {
    // Characterization: crossverify consults earliest-first, adversary latest-first. Both are copied
    // from the shipped hand-written guards; a "tidy-up" that normalizes them changes warning text.
    const chain = (phase: string) => PHASES.find((p) => p.phase === phase)!.guard!.chain;
    expect(chain("openq")).toEqual(["FS"]);
    expect(chain("crossverify")).toEqual(["FS", "QS"]);
    expect(chain("adversary")).toEqual(["VS", "QS", "FS"]);
    expect(chain("rebuttal")).toEqual(["AS", "VS", "QS", "FS"]);
    expect(chain("gap")).toEqual(["RS", "AS", "VS", "QS", "FS"]);
    expect(chain("signoff")).toEqual(["GS", "RS", "AS", "VS", "QS", "FS"]);
  });
});

// ---- guard predicates ----
// Both read the explore state file that OWNS a key (`<phase>-<agent>.txt`), latest line wins.
describe("guard predicates", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  /** Write `<KEY>=<value>` into the state file that owns KEY, exactly as the wait verbs do. */
  function tag(key: PhaseKey, value: string, agent = "alpha"): void {
    const phase = PHASES.find((p) => p.key === key)!.phase;
    writeFileSync(join(h.home, `${phase}-${agent}.txt`), `OFFSET=0\n${key}=${value}\n`);
  }

  describe("anyPriorUnsafe (ternary encoding: openq / crossverify / adversary)", () => {
    it("no state files at all → safe", () => {
      expect(anyPriorUnsafe(h.home, "alpha", ["VS", "QS", "FS"])).toBeNull();
    });

    it("timeout and failed are unsafe; ok, skipped and question are not", () => {
      for (const bad of ["timeout", "failed"]) {
        tag("FS", bad);
        expect(anyPriorUnsafe(h.home, "alpha", ["FS"])).toBe(`FS=${bad}`);
      }
      for (const good of ["ok", "skipped", "question"]) {
        tag("FS", good);
        expect(anyPriorUnsafe(h.home, "alpha", ["FS"])).toBeNull();
      }
    });

    it("a clean LATER phase does NOT clear an earlier failure", () => {
      tag("FS", "failed");
      tag("QS", "ok");
      tag("VS", "ok");
      expect(anyPriorUnsafe(h.home, "alpha", ["VS", "QS", "FS"])).toBe("FS=failed");
    });

    it("chain order decides which KEY=value is reported when several are unsafe", () => {
      tag("FS", "failed");
      tag("QS", "timeout");
      expect(anyPriorUnsafe(h.home, "alpha", ["FS", "QS"])).toBe("FS=failed");   // crossverify's order
      expect(anyPriorUnsafe(h.home, "alpha", ["VS", "QS", "FS"])).toBe("QS=timeout"); // adversary's
    });

    it("latest line wins inside a state file", () => {
      writeFileSync(join(h.home, "research-alpha.txt"), "OFFSET=0\nFS=timeout\nOFFSET=9\nFS=ok\n");
      expect(anyPriorUnsafe(h.home, "alpha", ["FS"])).toBeNull();
    });

    it("state is per agent", () => {
      tag("FS", "timeout", "charlie");
      expect(anyPriorUnsafe(h.home, "alpha", ["FS"])).toBeNull();
      expect(anyPriorUnsafe(h.home, "charlie", ["FS"])).toBe("FS=timeout");
    });
  });

  describe("latestNonSkippedUnsafe (walk encoding: rebuttal / gap / signoff)", () => {
    const CHAIN: PhaseKey[] = ["AS", "VS", "QS", "FS"]; // rebuttal's, latest phase first

    it("no state files at all → safe", () => {
      expect(latestNonSkippedUnsafe(h.home, "alpha", CHAIN)).toBeNull();
    });

    it("the latest non-skipped tag decides", () => {
      tag("FS", "ok");
      tag("AS", "timeout");
      expect(latestNonSkippedUnsafe(h.home, "alpha", CHAIN)).toBe("AS=timeout");
    });

    it("walks PAST skipped tags to the state that caused them", () => {
      tag("FS", "ok");
      tag("VS", "timeout");
      tag("AS", "skipped"); // written by the adversary guard itself
      expect(latestNonSkippedUnsafe(h.home, "alpha", CHAIN)).toBe("VS=timeout");
    });

    it("a clean LATER phase DOES clear an older failure", () => {
      tag("FS", "failed");
      tag("QS", "timeout");
      tag("AS", "ok");
      expect(latestNonSkippedUnsafe(h.home, "alpha", CHAIN)).toBeNull();
    });

    it("every phase skipped → safe (nothing was ever dispatched)", () => {
      for (const k of CHAIN) tag(k, "skipped");
      expect(latestNonSkippedUnsafe(h.home, "alpha", CHAIN)).toBeNull();
    });
  });

  describe("the two encodings on the pipeline-unreachable input VS=ok alongside QS=timeout", () => {
    beforeEach(() => {
      // The pipeline can never produce this: crossverify is only dispatched when openq was safe.
      // Kept as-is at every site — merging the encodings would be a behavior change (own spec).
      tag("QS", "timeout");
      tag("VS", "ok");
    });

    it("same chain, different answers: the ternary skips, the walk does not", () => {
      const chain: PhaseKey[] = ["VS", "QS", "FS"];
      expect(anyPriorUnsafe(h.home, "alpha", chain)).toBe("QS=timeout");
      expect(latestNonSkippedUnsafe(h.home, "alpha", chain)).toBeNull(); // VS=ok is the latest, and clean
    });

    it("as shipped: adversary (ternary) skips, rebuttal (walk) dispatches", () => {
      const adversary = PHASES.find((p) => p.phase === "adversary")!.guard!;
      const rebuttal = PHASES.find((p) => p.phase === "rebuttal")!.guard!;
      expect(anyPriorUnsafe(h.home, "alpha", adversary.chain)).toBe("QS=timeout");
      expect(latestNonSkippedUnsafe(h.home, "alpha", rebuttal.chain)).toBeNull();
    });
  });

  describe("guardSkipped (the write+warn tail)", () => {
    const row = (phase: string) => PHASES.find((p) => p.phase === phase)!;

    it("unsafe chain → writes <KEY>=skipped and returns true", () => {
      tag("FS", "timeout");
      const stateFile = join(h.home, "openq-alpha.txt");
      expect(guardSkipped(row("openq"), h.home, "alpha", stateFile)).toBe(true);
      expect(readFileSync(stateFile, "utf8")).toBe("QS=skipped\n");
    });

    it("safe chain → returns false and writes nothing", () => {
      tag("FS", "ok");
      const stateFile = join(h.home, "openq-alpha.txt");
      expect(guardSkipped(row("openq"), h.home, "alpha", stateFile)).toBe(false);
      expect(existsSync(stateFile)).toBe(false);
    });

    it("a row without a guard is always safe", () => {
      tag("FS", "timeout");
      const stateFile = join(h.home, "research-alpha-guard.txt");
      expect(guardSkipped(row("research"), h.home, "alpha", stateFile)).toBe(false);
      expect(guardSkipped(DESIGN_PHASES[1], h.home, "alpha", stateFile)).toBe(false);
      expect(existsSync(stateFile)).toBe(false);
    });
  });
});
