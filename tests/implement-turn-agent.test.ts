// tests/implement-turn-agent.test.ts — `--agent`, the four named lead turns, their evidence and
// budget, and the slice barrier (2026-09-04-parallel-slices-design.md, B / E / F).
//
// The first block is the ATTACHED byte-identity gate: the lead's file names, prompt bodies, send
// argv and state-file writes were captured from the code BEFORE the `agent` parameter existed, and
// nothing in this PR may move them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { noSleepClock } from "./helpers/clock.js";
import { implementArtDir } from "../src/core/implement.js";
import { outboxPath } from "../src/core/ipc.js";
import {
  composePlanPrompt, composeGrillPrompt, composePreludePrompt, composeSliceRound1Prompt, composeAbsorbPrompt,
} from "../src/core/implementTurn.js";
import { absorbIssues, parsePlanTasks, readSlices, writeSlices, type SliceRow } from "../src/core/implementSlices.js";
import { readIntegrate } from "../src/core/implementIntegrate.js";
import { run, turnSendWith, turnWaitWith, type ImplementSendDeps, type ImplementWaitDeps } from "../src/commands/implement.js";

const TOPIC = "add-oauth";
const FIXTURE: Record<string, { rc: number; args?: string[]; files?: Record<string, string>; state?: string }> =
  JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "implement-lead-turn-0.5.70.json"), "utf8"));

/** The art dir plus one worker dir per agent, exactly as `spawn` leaves a live worker. */
function seed(agents: Array<[string, string]> = [["lead", "codex"]]): string {
  const art = implementArtDir(TOPIC);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "provider.txt"), "codex\n");
  writeFileSync(join(art, "design.md"), "# design\n");
  for (const [agent, model] of agents) {
    const outbox = outboxPath(agent, model, TOPIC);
    mkdirSync(dirname(outbox), { recursive: true });
    writeFileSync(outbox, "");
    writeFileSync(join(dirname(outbox), "pane.json"), JSON.stringify({ pane_id: "%1", pane_nonce: "", agent, model }) + "\n");
  }
  return art;
}
function sendDeps(over: Partial<ImplementSendDeps> = {}): ImplementSendDeps {
  return { offsetFor: over.offsetFor ?? (() => 17), send: over.send ?? (async () => 0) };
}
function waitDeps(over: Partial<ImplementWaitDeps> = {}): ImplementWaitDeps {
  return {
    wait: over.wait ?? (async () => null),
    clock: over.clock ?? noSleepClock,
    multiplier: over.multiplier ?? (() => "1"),
    now: over.now ?? (() => 1700000000),
  };
}
/** Every file the art dir holds, contents included, with the art path itself folded to `$ART` —
 *  the fixture's own shape (the art dir is a fresh temp path on every run). */
function artFiles(art: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(art)) { try { out[f] = readFileSync(join(art, f), "utf8").split(art).join("$ART"); } catch { /* a dir */ } }
  return out;
}

describe("ATTACHED byte-identity — the lead's turn without --agent is 0.5.68", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it.each([1, 2])("round %i: same state file, same prompt file and body, same send argv", async (round) => {
    const art = seed();
    if (round === 2) writeFileSync(join(art, "fix-prompt-2.md"), "1. [bug] boom\n");
    let args: string[] = [];
    const rc = await turnSendWith(TOPIC, round, sendDeps({ send: async (a) => { args = a; return 0; } }));
    const fx = FIXTURE[`send|round=${round}`];
    expect(rc).toBe(fx.rc);
    expect(args.map((a) => a.replace(art, "$ART"))).toEqual(fx.args);
    expect(artFiles(art)).toEqual(fx.files);

    writeFileSync(join(art, `verify-report-${round}.md`), "VERDICT: PASS\n");
    const wrc = await turnWaitWith(TOPIC, round, waitDeps({ wait: async () => ({ event: "done", summary: "x" }) }));
    const wf = FIXTURE[`wait|round=${round}`];
    expect(wrc).toBe(wf.rc);
    expect(readFileSync(join(art, `turn-lead-${round}.txt`), "utf8")).toBe(wf.state);
  });
});

describe("--agent keys every per-turn path", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("a slice's state, prompt, report and log paths all carry the agent", async () => {
    const art = seed([["lead", "codex"], ["bravo", "codex"]]);
    writeFileSync(join(art, "plan.md"), "### T1: a\nfiles: a.ts\ndepends: none\n");
    writeFileSync(join(art, "slice-bravo.md"), "# Slice wp3\n");
    let args: string[] = [];
    const rc = await turnSendWith(TOPIC, 1, sendDeps({ send: async (a) => { args = a; return 0; } }), "bravo");
    expect(rc).toBe(0);
    expect(existsSync(join(art, "turn-bravo-1.txt"))).toBe(true);
    expect(existsSync(join(art, "turn-lead-1.txt"))).toBe(false);
    expect(args).toEqual(["--from", "hub", "bravo", TOPIC, "@" + join(art, "bravo_turn_prompt_1.md")]);
    const body = readFileSync(join(art, "bravo_turn_prompt_1.md"), "utf8");
    expect(body).toBe(composeSliceRound1Prompt({
      designPath: join(art, "design.md"), planPath: join(art, "plan.md"), mandateText: "# Slice wp3\n",
      verifyPath: join(art, "verify-report-bravo-1.md"),
      testLog: join(art, "test-output-bravo-1.log"),
      durationLog: join(art, "worker-test-duration-bravo-1.txt"),
      testCmd: "",
    }));
    // Never the lead's shared names — two slices in one art dir would collide on all three.
    expect(body).not.toContain("verify-report-1.md");
    expect(body).not.toContain("worker-test-duration-1.txt");
  });

  it("turn-wait --agent classifies against the slice's OWN report", async () => {
    const art = seed([["bravo", "codex"]]);
    writeFileSync(join(art, "turn-bravo-1.txt"), "OFFSET=10\n");
    writeFileSync(join(art, "verify-report-1.md"), "VERDICT: PASS\n");   // the LEAD's report, not bravo's
    await turnWaitWith(TOPIC, 1, waitDeps({ wait: async () => ({ event: "done" }) }), "bravo");
    expect(readFileSync(join(art, "turn-bravo-1.txt"), "utf8")).toContain("TS=failed\n");
    writeFileSync(join(art, "turn-bravo-1.txt"), "OFFSET=10\n");
    writeFileSync(join(art, "verify-report-bravo-1.md"), "VERDICT: PASS\n");
    await turnWaitWith(TOPIC, 1, waitDeps({ wait: async () => ({ event: "done" }) }), "bravo");
    expect(readFileSync(join(art, "turn-bravo-1.txt"), "utf8")).toContain("TS=ok\n");
  });

  it("refuses a named turn for a slice, and a slice round >= 2 (rc 2, D7)", async () => {
    seed([["lead", "codex"], ["bravo", "codex"]]);
    expect(await run(["turn-send", TOPIC, "plan", "--agent", "bravo"])).toBe(2);
    expect(await run(["turn-send", TOPIC, "2", "--agent", "bravo"])).toBe(2);
    expect(await run(["turn-wait", TOPIC, "prelude", "--agent", "bravo"])).toBe(2);
    expect(await run(["turn-send", TOPIC, "zero"])).toBe(1);
  });
});

describe("the four named lead turns", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); delete process.env.AP_IMPLEMENT_PLAN_TURN_TIMEOUT_S; delete process.env.AP_IMPLEMENT_TURN_TIMEOUT_S; });

  const twoTasks = "### T1: a\nfiles: a.ts\ndepends: none\n### T2: b\nfiles: b.ts\ndepends: none\n";

  it("plan: turn-lead-plan.txt + composePlanPrompt", async () => {
    const art = seed();
    expect(await turnSendWith(TOPIC, "plan", sendDeps())).toBe(0);
    expect(existsSync(join(art, "turn-lead-plan.txt"))).toBe(true);
    expect(readFileSync(join(art, "lead_turn_prompt_plan.md"), "utf8"))
      .toBe(composePlanPrompt({ designPath: join(art, "design.md"), planPath: join(art, "plan.md"), maxSlices: 6 }));
  });

  it("grill: the refusal lines slice-check recorded, verbatim, plus the hub's @file", async () => {
    const art = seed();
    writeFileSync(join(art, "slice-refusals.txt"), "DEP=T3->T1\nOVERLAP=wp3:wp4:src/a.ts\n");
    const hubFile = join(art, "grill.md");
    writeFileSync(hubFile, "I wanted T3 and T4 apart.\n");
    expect(await turnSendWith(TOPIC, "grill", sendDeps(), "lead", hubFile)).toBe(0);
    const body = readFileSync(join(art, "lead_turn_prompt_grill.md"), "utf8");
    expect(body).toBe(composeGrillPrompt({
      hubText: "I wanted T3 and T4 apart.\n", planPath: join(art, "plan.md"),
      refusalLines: ["DEP=T3->T1", "OVERLAP=wp3:wp4:src/a.ts"],
    }));
  });

  it("grill without the @file, or with no recorded refusal, sends nothing", async () => {
    const art = seed();
    writeFileSync(join(art, "slice-refusals.txt"), "DEP=T3->T1\n");
    let sent = false;
    expect(await turnSendWith(TOPIC, "grill", sendDeps({ send: async () => { sent = true; return 0; } }))).toBe(1);
    writeFileSync(join(art, "grill.md"), "x");
    writeFileSync(join(art, "slice-refusals.txt"), "");
    expect(await turnSendWith(TOPIC, "grill", sendDeps({ send: async () => { sent = true; return 0; } }), "lead", join(art, "grill.md"))).toBe(1);
    expect(sent).toBe(false);
  });

  it("prelude: ids from prelude.txt, stage-named report and logs", async () => {
    const art = seed();
    writeFileSync(join(art, "prelude.txt"), "T1, T2\n");
    expect(await turnSendWith(TOPIC, "prelude", sendDeps())).toBe(0);
    expect(readFileSync(join(art, "lead_turn_prompt_prelude.md"), "utf8")).toBe(composePreludePrompt({
      designPath: join(art, "design.md"), planPath: join(art, "plan.md"), preludeIds: ["T1", "T2"],
      verifyPath: join(art, "verify-report-prelude.md"),
      testLog: join(art, "test-output-prelude.log"),
      durationLog: join(art, "worker-test-duration-prelude.txt"),
      testCmd: "",
    }));
  });

  it("prelude with no prelude.txt is refused (an empty prelude has no turn)", async () => {
    seed();
    expect(await turnSendWith(TOPIC, "prelude", sendDeps())).toBe(1);
  });

  it("absorb: the ISSUES block from slices.tsv + integrate-1.tsv + the slice reports", async () => {
    const art = seed();
    writeFileSync(join(art, "plan.md"), twoTasks);
    writeSlices(join(art, "slices.tsv"), [
      { agent: "bravo", model: "codex", label: "wp3", status: "abandoned:turn-failed", tasks: ["T1"], files: ["a.ts"] },
      { agent: "delta", model: "codex", label: "wp4", status: "spawned", tasks: ["T2"], files: ["b.ts"] },
    ]);
    writeFileSync(join(art, "integrate-1.tsv"), "delta\twp4\tconflict\n");
    writeFileSync(join(art, "verify-report-delta-1.md"), "## Out-of-slice changes needed\n- src/x.ts:9 export it\n");
    expect(await turnSendWith(TOPIC, "absorb", sendDeps())).toBe(0);
    const body = readFileSync(join(art, "lead_turn_prompt_absorb.md"), "utf8");
    expect(body).toContain('- [slice] tasks T1 "a" (slice wp3) were not implemented (abandoned:turn-failed)');
    expect(body).toContain("- [integration] feat/implement-add-oauth-delta (slice wp4) conflicts");
    expect(body).toContain("- [spec-gap] src/x.ts:9 — out-of-slice change requested by slice wp4: export it");
    expect(body).toContain(join(art, "verify-report-absorb.md"));
    expect(body).toContain(join(art, "worker-test-duration-absorb.txt"));
    const plan = parsePlanTasks(twoTasks);
    expect(body).toBe(composeAbsorbPrompt({
      designPath: join(art, "design.md"), planPath: join(art, "plan.md"),
      issuesText: absorbIssues({
        topic: TOPIC, rows: readSlices(join(art, "slices.tsv")), integrate: readIntegrate(join(art, "integrate-1.tsv")),
        reportTextFor: (a) => { const f = join(art, `verify-report-${a}-1.md`); return existsSync(f) ? readFileSync(f, "utf8") : ""; },
        planTasks: plan.ok ? plan.tasks : [],
      }),
      verifyPath: join(art, "verify-report-absorb.md"),
      testLog: join(art, "test-output-absorb.log"),
      durationLog: join(art, "worker-test-duration-absorb.txt"),
      testCmd: "",
    }));
  });

  it("absorb with nothing left to absorb is refused (the symmetric arm to an empty prelude)", async () => {
    const art = seed();
    writeFileSync(join(art, "plan.md"), twoTasks);
    writeSlices(join(art, "slices.tsv"), [{ agent: "delta", model: "codex", label: "wp4", status: "spawned", tasks: ["T2"], files: ["b.ts"] }]);
    writeFileSync(join(art, "integrate-1.tsv"), "delta\twp4\tmerged\n");
    let sent = false;
    expect(await turnSendWith(TOPIC, "absorb", sendDeps({ send: async () => { sent = true; return 0; } }))).toBe(1);
    expect(sent).toBe(false);
  });

  it("plan/grill evidence is plan.md: >= 2 tasks is ok, one task is failed + PLAN=unparseable", async () => {
    const art = seed();
    writeFileSync(join(art, "turn-lead-plan.txt"), "OFFSET=10\n");
    writeFileSync(join(art, "plan.md"), twoTasks);
    await turnWaitWith(TOPIC, "plan", waitDeps({ wait: async () => ({ event: "done" }) }));
    expect(readFileSync(join(art, "turn-lead-plan.txt"), "utf8")).toBe("OFFSET=10\nTS=ok\n");

    writeFileSync(join(art, "turn-lead-grill.txt"), "OFFSET=10\n");
    writeFileSync(join(art, "plan.md"), "### T1: only one\nfiles: a.ts\ndepends: none\n");
    await turnWaitWith(TOPIC, "grill", waitDeps({ wait: async () => ({ event: "done" }) }));
    const state = readFileSync(join(art, "turn-lead-grill.txt"), "utf8");
    expect(state).toBe("OFFSET=10\nPLAN=unparseable\nTS=failed\n");   // lead line AHEAD, TS= stays last
  });

  it("no plan.md at all is failed WITHOUT PLAN=unparseable (no plan != an unreadable plan)", async () => {
    const art = seed();
    writeFileSync(join(art, "turn-lead-plan.txt"), "OFFSET=10\n");
    await turnWaitWith(TOPIC, "plan", waitDeps({ wait: async () => ({ event: "done" }) }));
    const state = readFileSync(join(art, "turn-lead-plan.txt"), "utf8");
    expect(state).toContain("TS=failed\n");
    expect(state).not.toContain("PLAN=");
  });

  it("the plan turn runs on its OWN budget, not the 4h implement turn budget", async () => {
    const art = seed();
    process.env.AP_IMPLEMENT_PLAN_TURN_TIMEOUT_S = "7";
    process.env.AP_IMPLEMENT_TURN_TIMEOUT_S = "9";
    const seen: number[] = [];
    const d = waitDeps({ wait: async (_i, _m, _t, _o, _e, to) => { seen.push(to); return null; } });
    writeFileSync(join(art, "turn-lead-plan.txt"), "OFFSET=10\n");
    await turnWaitWith(TOPIC, "plan", d);
    writeFileSync(join(art, "turn-lead-1.txt"), "OFFSET=10\n");
    await turnWaitWith(TOPIC, 1, d);
    expect(seen).toEqual([7, 9]);
  });
});

describe("PANE=died — the lead line nothing else carries out of the process", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  it("a synthetic pane-died error writes PANE=died ahead of TS=failed", async () => {
    const art = seed([["bravo", "codex"]]);
    writeFileSync(join(art, "turn-bravo-1.txt"), "OFFSET=10\n");
    await turnWaitWith(TOPIC, 1, waitDeps({ wait: async () => ({ event: "error", note: "pane-died" }) }), "bravo");
    expect(readFileSync(join(art, "turn-bravo-1.txt"), "utf8")).toBe("OFFSET=10\nPANE=died\nTS=failed\n");
  });

  it("any other error is TS=failed with no lead line", async () => {
    const art = seed([["bravo", "codex"]]);
    writeFileSync(join(art, "turn-bravo-1.txt"), "OFFSET=10\n");
    await turnWaitWith(TOPIC, 1, waitDeps({ wait: async () => ({ event: "error", note: "boom" }) }), "bravo");
    expect(readFileSync(join(art, "turn-bravo-1.txt"), "utf8")).toBe("OFFSET=10\nTS=failed\n");
  });
});

describe("implement slice-gate", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => { h.cleanup(); });

  const rows = (...st: Array<SliceRow["status"]>): SliceRow[] =>
    st.map((status, i) => ({ agent: ["bravo", "delta", "echo"][i], model: "codex", label: `wp${i}`, status, tasks: [`T${i}`], files: [`f${i}.ts`] }));

  async function gate(art: string, state: Record<string, string>): Promise<{ rc: number; out: string }> {
    for (const [agent, text] of Object.entries(state)) writeFileSync(join(art, `turn-${agent}-1.txt`), text);
    const cap = captureStdout();
    try { return { rc: await run(["slice-gate", TOPIC, "1"]), out: cap.text() }; } finally { cap.restore(); }
  }

  it("rc 2 for a round that is not a positive integer (it is interpolated into a state filename)", async () => {
    const art = seed();
    writeSlices(join(art, "slices.tsv"), rows("spawned"));
    // Without the shape test a typo reads every row `pending` and returns rc 1 — which the
    // directive acts on as "a Monitor is gone", not "you passed a bad argument".
    expect(await run(["slice-gate", TOPIC, "one"])).toBe(2);
    expect(await run(["slice-gate", TOPIC, "0"])).toBe(2);
  });

  it("ok for every non-abandoned row is rc 0; an abandoned row does not block it", async () => {
    const art = seed();
    writeSlices(join(art, "slices.tsv"), rows("spawned", "abandoned:pane-died"));
    const { rc, out } = await gate(art, { bravo: "OFFSET=1\nTS=ok\n" });
    expect(rc).toBe(0);
    expect(out).toBe("bravo\twp0\tok\ndelta\twp1\tabandoned\n");
  });

  it("a hold in progress reads `held`, and a state file with no TS= reads `pending`", async () => {
    const art = seed();
    writeSlices(join(art, "slices.tsv"), rows("spawned", "spawned"));
    const { rc, out } = await gate(art, { bravo: "OFFSET=1\nOFFSET=4\nPD=1\n", delta: "OFFSET=1\n" });
    expect(rc).toBe(1);
    expect(out).toBe("bravo\twp0\theld\ndelta\twp1\tpending\n");
  });

  it("a missing state file is `pending`, and the LAST TS= wins", async () => {
    const art = seed();
    writeSlices(join(art, "slices.tsv"), rows("spawned", "spawned"));
    const { rc, out } = await gate(art, { delta: "OFFSET=1\nTS=timeout\nOFFSET=9\nTS=ok\n" });
    expect(rc).toBe(1);
    expect(out).toBe("bravo\twp0\tpending\ndelta\twp1\tok\n");
  });

  it("a gate over zero live slices is rc 1, never vacuously green", async () => {
    const art = seed();
    writeSlices(join(art, "slices.tsv"), []);
    expect((await gate(art, {})).rc).toBe(1);
    writeSlices(join(art, "slices.tsv"), rows("abandoned:objection"));
    const { rc, out } = await gate(art, {});
    expect(rc).toBe(1);
    expect(out).toBe("bravo\twp0\tabandoned\n");
  });
});
