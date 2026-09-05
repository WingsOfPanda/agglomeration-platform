// tests/implement-parallel-directive.test.ts — PR 3 of the parallel-slices design
// (docs/superpowers/specs/2026-09-04-parallel-slices-design.md, K / I): the verbs PR 2 shipped are
// dark until the directive drives them, so the directive IS the feature and its text is the
// contract. Pinned here the way tests/job-cmd.test.ts pins the watcher loop and
// tests/spawn-retry-directive.test.ts pins the retry paragraph: the stage's shape and order, the
// per-slice Monitor block a hub copies verbatim, the rules a hub reading in order must not lose, and
// — the directive-to-code contract — that every verb the stage names actually exists in the dispatch
// switch a hub's `$CS implement <verb>` lands in.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), "utf8");
const implement = read("commands", "implement.md");
const job = read("commands", "job.md");
const implementSrc = read("src", "commands", "implement.ts");
/** Whitespace-collapsed, so re-wrapping a paragraph does not break a prose pin. */
const flat = (s: string): string => s.replace(/\s+/g, " ");

const STAGE_1P = "## Stage 1P — parallel slices (every job-hub run)";
const STAGE_11 = "## Stage 1.1 — spawn the worker (single-repo)";
const STAGE_1 = "## Stage 1 — run the worker turn";

/** The stage's own text, so a pin can never be satisfied by a sentence somewhere else in the file. */
const section = (): string => {
  const a = implement.indexOf(STAGE_1P), b = implement.indexOf(STAGE_1);
  expect(a, "implement.md has no Stage 1P heading").toBeGreaterThan(-1);
  expect(b, "implement.md has no Stage 1 heading").toBeGreaterThan(-1);
  expect(b, "Stage 1P must sit BEFORE Stage 1").toBeGreaterThan(a);
  return implement.slice(a, b);
};

describe("commands/implement.md carries Stage 1P, in place", () => {
  it("sits between Stage 1.1 and Stage 1 — the fan-out happens after the spawn and before round 1", () => {
    const i11 = implement.indexOf(STAGE_11), i1p = implement.indexOf(STAGE_1P), i1 = implement.indexOf(STAGE_1);
    expect(i11, "implement.md has no Stage 1.1 heading").toBeGreaterThan(-1);
    expect(i1p, "implement.md has no Stage 1P heading").toBeGreaterThan(-1);
    expect(i1, "implement.md has no Stage 1 heading").toBeGreaterThan(-1);
    expect(i1p, "Stage 1P must come after Stage 1.1 — it dispatches to the worker Stage 1.1 spawned").toBeGreaterThan(i11);
    expect(i1, "Stage 1P must come before Stage 1 — a fanned-out run reaches Stage 2 without entering Stage 1").toBeGreaterThan(i1p);
  });

  it("names DETACHED=1 as its only signal, and no operator knob", () => {
    expect(flat(section())).toContain("`DETACHED=1`");
    expect(flat(implement), "the operator does not choose the worker count (D11)").not.toContain("--workers");
    expect(flat(job), "the operator does not choose the worker count (D11)").not.toContain("--workers");
  });

  it("initializes Stage 1's round counters and gives each named turn its own retry counter", () => {
    const f = flat(section());
    expect(f, "Stage 2/3 branch on ROUND and MAX_ROUNDS, which Stage 1 would otherwise have set")
      .toContain("`MAX_ROUNDS=${MAX_ROUNDS_OVERRIDE:-5}`");
    for (const c of ["RETRY_PLAN", "RETRY_GRILL", "RETRY_PRELUDE", "RETRY_ABSORB"]) {
      expect(f, `Stage 1P must carry its own ${c} counter, not spend the fix rounds' RETRY`).toContain(c);
    }
  });

  // The nine steps are a sequence a hub executes in order; a reordered or missing one is a run that
  // spawns before it has grouped, or integrates before the slices are done.
  it("spells its nine steps, in order", () => {
    const sec = section();
    const labels = [
      "**1P.0 Plan turn.**", "**1P.1 Slice plan.**", "**1P.2 Prelude.**", "**1P.3 Spawn.**",
      "**1P.4 Dispatch.**", "**1P.5 Outcomes.**", "**1P.6 Gate.**", "**1P.7 Integrate.**",
      "**1P.8 Absorb.**",
    ];
    let prev = -1;
    for (const l of labels) {
      const i = sec.indexOf(l);
      expect(i, `Stage 1P has no step labelled ${l}`).toBeGreaterThan(-1);
      expect(i, `Stage 1P's ${l} is out of order`).toBeGreaterThan(prev);
      prev = i;
    }
  });
});

// One Monitor per slice, reading that slice's own state file: a hub that armed one watcher over N
// slices could not tell which one ended, and a block that dropped `--agent` would wait on the lead.
describe("the per-slice Monitor block", () => {
  const blocks = (): string[] =>
    section().split("Monitor(persistent: true").slice(1).map((b) => b.slice(0, b.indexOf("esac')") + 6));

  it("arms the slice wait as a persistent Monitor on the per-agent turn-wait", () => {
    const b = blocks().find((x) => x.includes("--agent"));
    expect(b, "Stage 1P arms no Monitor over an --agent turn-wait").toBeDefined();
    expect(b!, "the slice Monitor must run the agent-keyed wait")
      .toContain(`$CS implement turn-wait "$TOPIC" 1 --agent <agent>`);
    expect(b!, "the slice Monitor must read back the slice's OWN state file")
      .toContain(`F="$ART/turn-<agent>-1.txt"`);
    expect(b!, "the slice Monitor must name the slice it watches").toContain("implement slice <agent> <TOPIC>");
    expect(b!, "the slice Monitor must derive a TS= like every other turn wait")
      .toContain(`ok|failed|timeout|question) printf "TS=%s\\n" "$TS"; exit 0;;`);
    expect(b!, "a watch that produced nothing must be loud, not a worker verdict")
      .toContain(`*) printf "TS=unreachable\\n"; exit 1;;`);
  });

  it("keeps the per-agent round files together with it", () => {
    const f = flat(section());
    expect(f, "the per-slice retry must remove the slice's own three round files")
      .toContain("$ART/turn-<agent>-1.done $ART/<agent>_turn_prompt_1.md");
  });
});

describe("the rules a hub reading Stage 1P in order must not lose", () => {
  const f = (): string => flat(section());

  it("bounds the grill at ONE per run", () => {
    expect(f(), "the grill turn must be bounded, or a refusing plan loops").toContain("The grill turn — ONE per run.");
    expect(f(), "a second refusal takes the serial path, it does not grill again").toContain("There is no second grill.");
  });

  it("keeps the refusal lines out of the hub's grill file — the verb interpolates them", () => {
    expect(f()).toContain("$ART/slice-refusals.txt");
    expect(f(), "a hub that pastes them itself doubles them in the prompt")
      .toContain("Do **not** paste the refusal lines into it");
  });

  it("carries the slice-live edit rule", () => {
    expect(f(), "design.md and plan.md are read by N workers at once")
      .toContain("edits ONLY `$ART/slice-<agent>.md` while slices are live");
  });

  it("takes the serial path, never an absorb over a whole plan, when nothing came up", () => {
    expect(f()).toContain("parallel-degraded: no slice spawned");
    expect(f()).toContain("never the absorb turn over a whole plan");
  });

  it("pastes the integrate report verbatim into the cross-verify doc", () => {
    for (const k of ["MERGED=<n>", "CONFLICT=<agent,...>", "EMPTY=<agent,...>", "SKIPPED=<agent,...>"]) {
      expect(f(), `Stage 1P must name integrate's ${k} line`).toContain(k);
    }
    expect(f()).toContain("verbatim** into `$ART/cross-verify-1.md`");
  });

  it("gives the sequential fan-out a Bash timeout that outlives six bootstraps", () => {
    expect(f(), "the tool's 120s default would SIGTERM the whole fan-out").toContain("`timeout: 600000`");
  });
});

// H: the per-agent and stage-named reports REPLACE verify-report-<ROUND>.md for a fanned-out round 1
// — pointed at the absent round file, the mutation cross-check counts zero over the slices' work.
describe("Stage 2 Step B after a fan-out", () => {
  const stepB = (): string => {
    const a = implement.indexOf("**Step B — read-based cross-verify.**");
    const b = implement.indexOf("## Stage 3");
    expect(a, "implement.md has no Stage 2 Step B").toBeGreaterThan(-1);
    return flat(implement.slice(a, b));
  };

  it("redirects the round-1 reads to the per-agent and stage-named reports", () => {
    expect(stepB()).toContain("$ART/verify-report-<agent>-1.md");
    expect(stepB()).toContain("$ART/verify-report-prelude.md");
    expect(stepB()).toContain("$ART/verify-report-absorb.md");
    expect(stepB(), "Step B also reads the two records that say what the slices did")
      .toContain("$ART/slices.tsv");
    expect(stepB()).toContain("$ART/integrate-1.tsv");
  });

  it("says the new-gate cross-check iterates that same set, and that the skip rule cannot fire", () => {
    expect(stepB(), "a gate counted over an absent file is a silent zero")
      .toContain("**The new-gate cross-check below iterates that same set**");
    expect(stepB()).toContain("`MUTATION:`");
    expect(stepB(), "the skip rule reads a file no fanned-out turn writes")
      .toContain("worker-test-duration-1.txt");
  });
});

// I: the one-writer rule the sentence encodes is per AGENT inbox, which Stage 1P respects — a hub
// reading the un-amended sentence would take the fan-out itself for the corruption it warns about.
describe("the respawn rule is per agent, in both directives (design I)", () => {
  const AMENDED = "a second worker on the SAME agent under one hub corrupts the run";
  const OLD = "a second worker under one hub corrupts the run";
  for (const [name, md] of [["commands/implement.md", implement], ["commands/job.md", job]] as const) {
    it(`${name} carries the amended sentence, on one line`, () => {
      expect(md, `${name} lost the per-agent amendment`).toContain(AMENDED);
      expect(
        md.split("\n").some((l) => l.includes(AMENDED)),
        `${name} re-wrapped the respawn sentence across lines`,
      ).toBe(true);
    });
    it(`${name} no longer carries the unqualified wording`, () => {
      expect(md, `${name} still forbids the fan-out's own second worker`).not.toContain(OLD);
    });
  }
});

// The arms a fix round added, each pinned on the code fact that made the un-amended text unfollowable
// (the verb wins wherever the spec and the shipped verb disagree).
describe("the arms whose file names and rcs come from the verbs, not from Stage 1", () => {
  const f = (): string => flat(section());

  it("keys the slice question payload and the objection count to the AGENT", () => {
    // turnWaitWith writes question-<agent>-<round>.txt and counts OBJECTIONS= in turn-<agent>-<round>.txt;
    // Stage 1 spells the lead's names, which a fanned-out round 1 never writes.
    expect(f(), "a hub following Stage 1 literally opens a payload file no slice turn wrote")
      .toContain("`$ART/question-<agent>-1.txt`");
    expect(f(), "the objection count is the slice's own state file").toContain("`OBJECTIONS=` count is the latest such line of `$ART/turn-<agent>-1.txt`");
  });

  it("sends the amended mandate as TEXT, because the worker was never given its path", () => {
    // composeSliceRound1Prompt interpolates slice-<agent>.md's CONTENT; the path is nowhere in the prompt.
    expect(f(), "an edit to the mandate file alone never reaches a running slice")
      .toContain("the reply carries the amended mandate ITSELF");
  });

  it("never sends this detached-only stage to an operator", () => {
    expect(f(), "Stage 1's objection arm is an AskUserQuestion whose Abort the run-path table refuses")
      .toContain("never call AskUserQuestion");
  });

  it("gives spawn-slices' FIRST-pass rc 2 an action, not just a description", () => {
    // The three job-level rc-2 refusals return before spawnSlices runs and print no FAILED= line,
    // so an action gated on `FAILED=` non-empty is unreachable on exactly the run design I names.
    expect(f(), "an rc 2 with no FAILED= line was refused before any row was attempted")
      .toContain("refused the job outright before it attempted anything");
    expect(f(), "the flag and the serial path must not sit behind a retry that cannot fire")
      .toContain("Once the retry is spent, or there was none to spend");
  });

  it("keys integrate's tree-dirty PARK on the rc, not on the skipped rows", () => {
    // integrateSlices sets rc 1 on the conflicting row itself; a conflict in the LAST row records
    // no `skipped:tree-dirty` row at all.
    expect(f(), "a last-row conflict leaves rc 1 with zero skipped rows and no arm")
      .toContain("**rc 1 on a pass that still printed the four keys**");
  });
});

// H, continued: a conflicted slice finished TS=ok and wrote a full report, and the absorb turn is
// told to merge its branch by hand — so its work is in the tree and its report is part of the round.
describe("Stage 2 Step B counts the conflicted slices too", () => {
  const stepB = (): string => {
    const a = implement.indexOf("**Step B — read-based cross-verify.**");
    return flat(implement.slice(a, implement.indexOf("## Stage 3")));
  };

  it("reads the report of every merged OR conflicted slice", () => {
    expect(stepB(), "integrate-1.tsv still records a hand-merged branch as `conflict`")
      .toContain("records as `merged` **or `conflict`**");
  });

  it("says an abandoned row's missing report is not a gap", () => {
    expect(stepB(), "integrate merges an abandoned slice's branch whenever it has commits")
      .toContain("wrote no report");
  });
});

// The directive-to-code contract: a hub follows this text LITERALLY, so a verb it names that the
// dispatch switch does not carry is a run that dies at `usage:` mid-fan-out. Derived from the
// directive rather than listed, so a verb added to Stage 1P is checked the day it is written.
describe("every verb Stage 1P names exists in implement's dispatch switch", () => {
  /** Lazy, so the derivation runs inside a test and its failure is reported as one. */
  const verbs = (): string[] =>
    [...new Set([...section().matchAll(/\$CS implement ([a-z][a-z-]*)/g)].map((m) => m[1]))];

  it("names the slice verbs at all (the regex is not vacuous)", () => {
    for (const v of ["slice-check", "spawn-slices", "abandon-slice", "slice-gate", "integrate"]) {
      expect(verbs(), `Stage 1P never invokes ${v}`).toContain(v);
    }
  });

  for (const v of ["slice-check", "spawn-slices", "abandon-slice", "slice-gate", "integrate", "turn-send", "turn-wait", "reset-status", "flag"]) {
    it(`implement dispatches '${v}'`, () => {
      expect(implementSrc, `src/commands/implement.ts has no case for '${v}'`).toContain(`case "${v}":`);
    });
  }

  it("dispatches EVERY verb the section names, whatever it names", () => {
    for (const v of verbs()) {
      expect(implementSrc, `Stage 1P invokes '$CS implement ${v}', which the dispatch switch does not carry`)
        .toContain(`case "${v}":`);
    }
  });
});
