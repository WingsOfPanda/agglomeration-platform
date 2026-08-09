// tests/liveness-guards.test.ts — the 2026-08-08 evidence-gated dispatch guard.
//
// Origin: the GUARD LOCKOUT observed on a side-lane eval box. Every phase wait expired against a
// slower-than-budget worker, each `timeout` tag soft-skipped the NEXT phase, and a 2-worker run
// degraded to two independent research docs while both workers sat idle. The fix is NOT "skip
// unless it looks idle" — an absent status file, a seeded one, or an expired wait all look idle
// and prove nothing. A skip is overridden only by POSITIVE evidence, all four legs: the worker
// reported an idle status itself, a terminal event landed past the failing phase's offset, that
// phase's artifact is settled, and its pane is alive.
// The per-verb wiring and the refusal matrix live in explore-cmd.test.ts (table-driven over PHASES);
// this file pins the predicate itself, its messages, and the two guard encodings through it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { PHASES, guardSkipped, type GuardLive, type PhaseRow } from "../src/core/phaseTable.js";
import { globalRoot, workerDir } from "../src/core/paths.js";
import { outboxPath, outboxTerminalSince, paneMetaPath, statusPath, workerStatusReport } from "../src/core/ipc.js";
import { END_OF_ARTIFACT } from "../src/core/artifact.js";

const TOPIC = "lockout", AGENT = "alpha", PROVIDER = "codex";

let h: { home: string; cleanup: () => void };
beforeEach(() => { h = freshHome(); });
afterEach(() => { h.cleanup(); });

const row = (phase: string): PhaseRow => PHASES.find((p) => p.phase === phase)!;
/** Write `<KEY>=<value>` into the state file that owns that key, as the wait verbs do. */
const tag = (phase: string, kv: string): void =>
  writeFileSync(join(h.home, `${phase}-${AGENT}.txt`), `OFFSET=0\n${kv}\n`);
/** The hub flags recorded under AP_HOME/forensics/<date>/ — /ap:review's feed. */
const hubFlags = (): string => {
  const root = join(globalRoot(), "forensics");
  if (!existsSync(root)) return "";
  return readdirSync(root)
    .flatMap((d) => readdirSync(join(root, d)).map((f) => readFileSync(join(root, d, f), "utf8")))
    .join("\n");
};

/** All four evidence legs, satisfied. Each test below removes exactly one. */
function seedEvidence(opts: { status?: "reported" | "seed" | "absent"; terminal?: boolean; pane?: boolean } = {}): void {
  mkdirSync(workerDir(AGENT, PROVIDER, TOPIC), { recursive: true });
  if (opts.status !== "absent") {
    writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), JSON.stringify(
      opts.status === "seed" ? { state: "idle", updated: "t", last_event: "spawn" } : { state: "idle", updated: "t", last_event: "done" },
    ) + "\n");
  }
  writeFileSync(outboxPath(AGENT, PROVIDER, TOPIC),
    opts.terminal === false ? '{"event":"progress","note":"still going"}\n' : '{"event":"done","summary":"landed late"}\n');
  if (opts.pane !== false) {
    writeFileSync(paneMetaPath(AGENT, PROVIDER, TOPIC), JSON.stringify({ pane_id: "%9", agent: AGENT, model: PROVIDER }) + "\n");
  }
}

const live = (over: Partial<GuardLive> = {}): GuardLive =>
  ({ topic: TOPIC, provider: PROVIDER, paneAlive: async () => true, ...over });

async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  const err: string[] = [];
  const se = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { return { value: await fn(), err: err.join("") }; }
  finally { process.stderr.write = se; }
}

/** openq's guard (chain FS) against a worker whose research phase timed out — the lockout's shape. */
const runOpenqGuard = (l?: GuardLive) =>
  capture(() => guardSkipped(row("openq"), h.home, AGENT, join(h.home, "openq-alpha.txt"), l));
const stateFile = () => join(h.home, "openq-alpha.txt");

describe("guardSkipped: the override needs all four evidence legs", () => {
  beforeEach(() => { tag("research", "FS=timeout"); });

  it("THE LOCKOUT: all four legs → no skip, no state write, one hub flag", async () => {
    seedEvidence();
    const { value, err } = await runOpenqGuard(live());
    expect(value).toBe(false);                    // dispatch proceeds — the phase is NOT ended
    expect(existsSync(stateFile())).toBe(false);  // nothing written: the send tail owns the file
    expect(err).toContain(
      "explore openq-send: alpha guard override — research ended FS=timeout but the worker is verifiably free (reported idle, turn ended, artifact settled, pane alive); dispatching",
    );
    expect(hubFlags()).toContain("guard-override-idle: alpha openq chain=FS=timeout");
  });

  // Leg (a): the worker's own word. Silence is not evidence — this is the pair of holes that would
  // have let the override fire for the four forensics workers that never maintained a status file.
  it("no status.json → skip (an absent file is silence, not idleness)", async () => {
    seedEvidence({ status: "absent" });
    const { value, err } = await runOpenqGuard(live());
    expect(value).toBe(true);
    expect(readFileSync(stateFile(), "utf8")).toBe("QS=skipped\n");
    expect(err).toContain("no status.json from the worker");
    expect(hubFlags()).toBe("");
  });

  it("the platform spawn seed (last_event: spawn) → skip: the worker never reported", async () => {
    seedEvidence({ status: "seed" });
    const { value, err } = await runOpenqGuard(live());
    expect(value).toBe(true);
    expect(err).toContain("status.json is still the spawn seed (worker never reported)");
  });

  it("a busy worker → skip, with today's text plus the live state", async () => {
    seedEvidence();
    const { value, err } = await runOpenqGuard(live({ busyState: () => "working" }));
    expect(value).toBe(true);
    expect(err).toContain(
      "explore openq-send: alpha skipped — research ended FS=timeout (worker may still be busy; sending would clobber its inbox; live state=working)",
    );
  });

  // Leg (b): a wait expiry says the HUB stopped listening, not that the turn ended.
  it("no terminal outbox event past the failing phase's offset → skip", async () => {
    seedEvidence({ terminal: false });
    const { value, err } = await runOpenqGuard(live());
    expect(value).toBe(true);
    expect(err).toContain("no terminal outbox event since research OFFSET=0 (turn may still be running)");
  });

  it("no OFFSET in the failing phase's state file → skip (cannot tell whether it ended)", async () => {
    writeFileSync(join(h.home, "research-alpha.txt"), "FS=timeout\n");
    seedEvidence();
    const { value, err } = await runOpenqGuard(live());
    expect(value).toBe(true);
    expect(err).toContain("no OFFSET recorded for research");
  });

  // Leg (c): the 0.5.8 late-done race — a done event whose artifact is still being written.
  it("the failing phase's artifact is present but unsettled → skip", async () => {
    seedEvidence();
    writeFileSync(join(h.home, "findings-alpha.md"), "## Claims\nhalf a doc");
    const { value, err } = await runOpenqGuard(live());
    expect(value).toBe(true);
    expect(err).toContain(`has no ${END_OF_ARTIFACT} and no AC= verdict (still being written)`);
  });

  it("a settled artifact is one of: absent, empty, sentinel-terminated, or already AC-accepted", async () => {
    const settled = [
      () => { /* absent */ },
      () => writeFileSync(join(h.home, "findings-alpha.md"), "   \n"),
      () => writeFileSync(join(h.home, "findings-alpha.md"), `## Claims\n1. x\n${END_OF_ARTIFACT}\n`),
      () => {
        writeFileSync(join(h.home, "findings-alpha.md"), "## Claims\nno sentinel");
        writeFileSync(join(h.home, "research-alpha.txt"), "OFFSET=0\nAC=quiescent\nFS=timeout\n");
      },
    ];
    for (const make of settled) {
      writeFileSync(join(h.home, "research-alpha.txt"), "OFFSET=0\nFS=timeout\n");
      seedEvidence();
      make();
      expect((await runOpenqGuard(live())).value).toBe(false);
      expect(existsSync(stateFile())).toBe(false);
    }
  });

  // Leg (d): a dead worker passes every other check, but dispatching to it converts a clean
  // `<KEY>=skipped` rc-0 walk into one send failure per remaining phase.
  it("no pane.json → skip", async () => {
    seedEvidence({ pane: false });
    const { value, err } = await runOpenqGuard(live());
    expect(value).toBe(true);
    expect(err).toContain("no pane.json (cannot confirm the pane is alive)");
  });

  it("a dead pane → skip", async () => {
    seedEvidence();
    const { value, err } = await runOpenqGuard(live({ paneAlive: async () => false }));
    expect(value).toBe(true);
    expect(err).toContain("pane %9 is gone");
  });

  it("a pane probe that throws (tmux server gone) counts as dead", async () => {
    seedEvidence();
    const { value, err } = await runOpenqGuard(live({ paneAlive: async () => { throw new Error("no server"); } }));
    expect(value).toBe(true);
    expect(err).toContain("pane %9 is gone");
  });

  it("NO live param → the pre-liveness behavior, byte-identical (regression pin)", async () => {
    seedEvidence();
    const { value, err } = await runOpenqGuard();
    expect(value).toBe(true);
    expect(readFileSync(stateFile(), "utf8")).toBe("QS=skipped\n");
    expect(err).toContain(
      "explore openq-send: alpha skipped — research ended FS=timeout (worker may still be busy; sending would clobber its inbox)\n",
    );
    expect(err).not.toContain("live state=");
    expect(hubFlags()).toBe("");
  });

  it("a safe chain never probes and never flags", async () => {
    writeFileSync(join(h.home, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
    const busyState = vi.fn(() => "working");
    const paneAlive = vi.fn(async () => true);
    expect(await guardSkipped(row("openq"), h.home, AGENT, stateFile(), live({ busyState, paneAlive }))).toBe(false);
    expect(busyState).not.toHaveBeenCalled();
    expect(paneAlive).not.toHaveBeenCalled();
    expect(existsSync(stateFile())).toBe(false);
    expect(hubFlags()).toBe("");
  });

  it("the probes get the ids they expect: (agent, provider, topic) and the pane id", async () => {
    seedEvidence();
    const busyState = vi.fn(() => null);
    const paneAlive = vi.fn(async () => true);
    await runOpenqGuard(live({ busyState, paneAlive }));
    expect(busyState).toHaveBeenCalledWith(AGENT, PROVIDER, TOPIC);
    expect(paneAlive).toHaveBeenCalledWith("%9");
  });
});

// Both encodings reach the SAME evidence probe; neither is touched, and the chain each consults (and
// the order it consults it in) still decides which KEY=value the warning and the flag name.
describe("both guard encodings through the evidence probe", () => {
  it("`any` (crossverify: FS then QS) — order unchanged, the override names QS", async () => {
    expect(row("crossverify").guard).toEqual({ kind: "any", noun: "previous phase", chain: ["FS", "QS"] });
    tag("research", "FS=ok");
    tag("openq", "QS=timeout");
    seedEvidence();
    const sf = join(h.home, "crossverify-alpha.txt");
    const { value, err } = await capture(() => guardSkipped(row("crossverify"), h.home, AGENT, sf, live()));
    expect(value).toBe(false);
    expect(err).toContain("previous phase ended QS=timeout but the worker is verifiably free");
    expect(hubFlags()).toContain("guard-override-idle: alpha crossverify chain=QS=timeout");

    // ... and the same chain still SKIPS when one leg is missing.
    writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), '{"state":"working"}\n');
    const again = await capture(() => guardSkipped(row("crossverify"), h.home, AGENT, sf, live()));
    expect(again.value).toBe(true);
    expect(readFileSync(sf, "utf8")).toBe("VS=skipped\n");
  });

  it("`latest` (rebuttal: AS,VS,QS,FS) — walks past AS=skipped, the override names VS", async () => {
    expect(row("rebuttal").guard).toEqual({ kind: "latest", noun: "latest phase", chain: ["AS", "VS", "QS", "FS"] });
    writeFileSync(join(h.home, "adversary-alpha.txt"), "AS=skipped\n");
    tag("crossverify", "VS=timeout");
    seedEvidence();
    const sf = join(h.home, "rebuttal-alpha.txt");
    const { value, err } = await capture(() => guardSkipped(row("rebuttal"), h.home, AGENT, sf, live()));
    expect(value).toBe(false);
    expect(err).toContain("latest phase ended VS=timeout but the worker is verifiably free");
    expect(hubFlags()).toContain("guard-override-idle: alpha rebuttal chain=VS=timeout");

    writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), '{"state":"working"}\n');
    const again = await capture(() => guardSkipped(row("rebuttal"), h.home, AGENT, sf, live()));
    expect(again.value).toBe(true);
    expect(readFileSync(sf, "utf8")).toBe("RS=skipped\n");
  });
});

describe("the ipc reads the guard's evidence rests on", () => {
  it("workerStatusReport: absent / seed / reported", () => {
    expect(workerStatusReport(AGENT, PROVIDER, TOPIC)).toBe("absent");
    mkdirSync(workerDir(AGENT, PROVIDER, TOPIC), { recursive: true });
    writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), '{"state":"idle","updated":"t","last_event":"spawn"}\n');
    expect(workerStatusReport(AGENT, PROVIDER, TOPIC)).toBe("seed");
    writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), '{"state": "idle", "last_event": "done"}\n');
    expect(workerStatusReport(AGENT, PROVIDER, TOPIC)).toBe("reported"); // pretty-printed too
  });

  it("outboxTerminalSince: only events at/after the offset, only terminal ones", () => {
    mkdirSync(workerDir(AGENT, PROVIDER, TOPIC), { recursive: true });
    const first = '{"event":"progress","note":"a"}\n';
    writeFileSync(outboxPath(AGENT, PROVIDER, TOPIC), first);
    expect(outboxTerminalSince(AGENT, PROVIDER, TOPIC, 0)).toBe(false);
    writeFileSync(outboxPath(AGENT, PROVIDER, TOPIC), first + '{"event":"done","summary":"s"}\n');
    expect(outboxTerminalSince(AGENT, PROVIDER, TOPIC, 0)).toBe(true);
    expect(outboxTerminalSince(AGENT, PROVIDER, TOPIC, first.length)).toBe(true); // the done is past it
    expect(outboxTerminalSince("nobody", PROVIDER, TOPIC, 0)).toBe(false);        // absent outbox
  });
});
