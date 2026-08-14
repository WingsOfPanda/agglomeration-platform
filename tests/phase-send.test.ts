// tests/phase-send.test.ts — phaseSend, the send head all nine dispatching phases open with.
//
// The per-phase behavior (composers, preconditions, guard chains) is pinned in explore-cmd.test.ts
// and design-escalation.test.ts against the real verbs. THIS file pins the skeleton itself against
// synthetic hooks, so each step's ORDER is asserted on its own: the exists-precondition in the row's
// own words, the trigger check ahead of the dispatch guard, the guard ahead of the phase's own
// preconditions, and the prompt-file/dispatch tail.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { sendDeps } from "./helpers/phaseDeps.js";
import { exploreArtDir } from "../src/core/explore.js";
import { workerDir } from "../src/core/paths.js";
import { statusPath } from "../src/core/ipc.js";
import { verifyState } from "../src/core/designTurn.js";
import { PHASES, DESIGN_PHASES, phaseSend, type PhaseRow, type PhaseSendHooks } from "../src/core/phaseTable.js";

const TOPIC = "x", AGENT = "alpha", PROVIDER = "codex";

let h: { home: string; cleanup: () => void };
beforeEach(() => { h = freshHome(); });
afterEach(() => { h.cleanup(); });

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

/** Put the worker mid-turn, so a guard that reaches its evidence probes cannot override the skip. */
function markBusy(): void {
  mkdirSync(workerDir(AGENT, PROVIDER, TOPIC), { recursive: true });
  writeFileSync(statusPath(AGENT, PROVIDER, TOPIC), '{"state":"working"}\n');
}

const artOf = (row: PhaseRow): string => {
  const art = row.artDir(TOPIC);
  mkdirSync(art, { recursive: true });
  return art;
};
const stateFileOf = (row: PhaseRow): string => join(row.artDir(TOPIC), `${row.phase}-${AGENT}.txt`);
const send = (row: PhaseRow, hooks: PhaseSendHooks, d = sendDeps()) => phaseSend(row, { topic: TOPIC, agent: AGENT, provider: PROVIDER }, d, hooks);

const ALL_ROWS = [...PHASES, ...DESIGN_PHASES];
const rowOf = (cmd: "explore" | "design", phase: string): PhaseRow =>
  ALL_ROWS.find((p) => p.cmd === cmd && p.phase === phase)!;

/** The exists-precondition's exact tail per phase — the two one-turn-cap phases word their cap
 *  differently from each other, so both are spelled out here rather than derived. */
const RETRY_NOTES: Record<string, string> = {
  "explore research": "exists; rm to retry",
  "explore openq": "exists; rm to retry",
  "explore crossverify": "exists; rm to retry",
  "explore adversary": "exists; rm to retry",
  "explore rebuttal": "exists — one rebuttal round per worker (the one-turn cap)",
  "explore gap": "exists; rm to retry",
  "explore signoff": "exists — one sign-off turn per worker (the one-turn cap)",
  "design research": "exists; rm to retry",
  "design verify": "exists; rm to retry",
};

describe("phaseSend: the exists-precondition speaks in the row's own words", () => {
  it("covers every dispatching phase", () => {
    expect(Object.keys(RETRY_NOTES).sort()).toEqual(ALL_ROWS.map((r) => `${r.cmd} ${r.phase}`).sort());
  });

  for (const row of ALL_ROWS) {
    it(`${row.cmd} ${row.phase}-send: rc 1, no prepare, no send`, async () => {
      artOf(row);
      writeFileSync(stateFileOf(row), "OFFSET=1\n");
      const prepare = vi.fn(() => ({ prompt: "p" }));
      const dispatch = vi.fn(async () => 0);
      const err = captureStderr();
      let rc: number;
      try { rc = await send(row, { prepare }, sendDeps({ send: dispatch })); } finally { err.restore(); }
      expect(rc).toBe(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(err.text()).toBe(
        `[FAIL]  ${row.cmd} ${row.phase}-send: ${stateFileOf(row)} ${RETRY_NOTES[`${row.cmd} ${row.phase}`]}\n`,
      );
    });
  }
});

describe("phaseSend: the guard runs before the phase's own preconditions", () => {
  const GUARDED = PHASES.filter((r) => r.guard);

  it("the guarded set is every explore phase from openq on", () => {
    expect(GUARDED.map((r) => r.phase)).toEqual(["openq", "crossverify", "adversary", "rebuttal", "gap", "signoff"]);
  });

  for (const row of GUARDED) {
    it(`${row.phase}-send: an unsafe chain skips without preparing anything`, async () => {
      // The chain head is the phase whose failure BOTH encodings agree on.
      const art = artOf(row);
      const head = row.guard!.chain[0];
      const owner = PHASES.find((p) => p.key === head)!.phase;
      writeFileSync(join(art, `${owner}-${AGENT}.txt`), `OFFSET=0\n${head}=timeout\n`);
      markBusy();
      const prepare = vi.fn(() => ({ prompt: "p" }));
      const dispatch = vi.fn(async () => 0);
      const err = captureStderr();
      let rc: number;
      try { rc = await send(row, { prepare }, sendDeps({ send: dispatch })); } finally { err.restore(); }
      expect(rc).toBe(0);
      expect(prepare).not.toHaveBeenCalled();          // dropping the guard call would prepare + dispatch
      expect(dispatch).not.toHaveBeenCalled();
      expect(readFileSync(stateFileOf(row), "utf8")).toBe(`${row.key}=skipped\n`);
      expect(existsSync(join(art, `${AGENT}_${row.phase}_prompt.md`))).toBe(false);
      expect(err.text()).toContain(`${row.cmd} ${row.phase}-send: ${AGENT} skipped — ${row.guard!.noun} ended ${head}=timeout`);
    });
  }

  it("a row with no guard dispatches over the same unsafe state (the guard is the ROW's, not the skeleton's)", async () => {
    const row = rowOf("explore", "research");
    const art = artOf(row);
    writeFileSync(join(art, `research-${AGENT}.txt.other`), ""); // no chain to be unsafe about
    markBusy();
    const dispatch = vi.fn(async () => 0);
    const err = captureStderr();
    let rc: number;
    try { rc = await send(row, { prepare: () => ({ prompt: "p" }) }, sendDeps({ send: dispatch, busyState: () => null })); } finally { err.restore(); }
    expect(rc).toBe(0);
    expect(dispatch).toHaveBeenCalled();
  });
});

describe("phaseSend: preGuard precedes the dispatch guard (gap's trigger)", () => {
  const row = rowOf("explore", "gap");

  it("an untriggered round skips on its OWN reason, and the guard never speaks", async () => {
    const art = artOf(row);
    // An unsafe chain the guard WOULD skip on, so the two skips are distinguishable.
    writeFileSync(join(art, `rebuttal-${AGENT}.txt`), "OFFSET=0\nRS=timeout\n");
    markBusy();
    const prepare = vi.fn(() => ({ prompt: "p" }));
    const err = captureStderr();
    let rc: number;
    try {
      rc = await send(row, { preGuard: () => ({ skip: "no recorded S1/S2 failure — trigger not fired" }), prepare });
    } finally { err.restore(); }
    expect(rc).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(readFileSync(stateFileOf(row), "utf8")).toBe("GS=skipped\n");
    expect(err.text()).toContain("explore gap-send: alpha GS=skipped (no recorded S1/S2 failure — trigger not fired)");
    // Reordering the two would produce the guard's wording (and probe a worker nobody asked about).
    expect(err.text()).not.toContain("worker may still be busy");
  });

  it("a triggered round falls through to the guard, which still gets the last word", async () => {
    const art = artOf(row);
    writeFileSync(join(art, `rebuttal-${AGENT}.txt`), "OFFSET=0\nRS=timeout\n");
    markBusy();
    const prepare = vi.fn(() => ({ prompt: "p" }));
    const err = captureStderr();
    let rc: number;
    try { rc = await send(row, { preGuard: () => null, prepare }); } finally { err.restore(); }
    expect(rc).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(err.text()).toContain("explore gap-send: alpha skipped — latest phase ended RS=timeout");
  });
});

describe("phaseSend: the prepare verdicts", () => {
  const row = rowOf("explore", "research");

  it("prompt → prompt file at <agent>_<phase>_prompt.md, then the dispatch tail", async () => {
    const art = artOf(row);
    const promptFile = join(art, `${AGENT}_research_prompt.md`);
    let sent: string[] = [];
    let stateAtSend: string | null = null;
    let promptAtSend: string | null = null;
    const rc = await send(row, { prepare: () => ({ prompt: "COMPOSED" }) }, sendDeps({
      offsetFor: () => 7,
      send: async (a) => {
        sent = a;
        stateAtSend = readFileSync(stateFileOf(row), "utf8");
        promptAtSend = readFileSync(promptFile, "utf8"); // the worker is handed a file that exists
        return 0;
      },
    }));
    expect(rc).toBe(0);
    expect(promptAtSend).toBe("COMPOSED");              // written BEFORE the dispatch, not after
    expect(stateAtSend).toBe("OFFSET=7\n");            // written before the send, as the tail promises
    expect(sent).toEqual(["--from", "hub", AGENT, TOPIC, `@${promptFile}`]);
  });

  it("skip → <KEY>=skipped reported as success, no prompt file, no send", async () => {
    const art = artOf(row);
    const dispatch = vi.fn(async () => 0);
    const err = captureStderr();
    let rc: number;
    try { rc = await send(row, { prepare: () => ({ skip: "nothing routed to it" }) }, sendDeps({ send: dispatch })); } finally { err.restore(); }
    expect(rc).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(readFileSync(stateFileOf(row), "utf8")).toBe("FS=skipped\n");
    expect(existsSync(join(art, `${AGENT}_research_prompt.md`))).toBe(false);
    expect(err.text()).toContain("explore research-send: alpha FS=skipped (nothing routed to it)");
  });

  it("fail → the verb's own rc, no state file, no prompt file (the phase stays runnable)", async () => {
    const art = artOf(row);
    const dispatch = vi.fn(async () => 0);
    const rc = await send(row, { prepare: () => ({ fail: 1 }) }, sendDeps({ send: dispatch }));
    expect(rc).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(existsSync(stateFileOf(row))).toBe(false);
    expect(existsSync(join(art, `${AGENT}_research_prompt.md`))).toBe(false);
    // The rc is the VERB's, passed through — not a hard-coded 1 that happens to match.
    expect(await send(row, { prepare: () => ({ fail: 2 }) }, sendDeps({ send: dispatch }))).toBe(2);
  });

  it("prepare is handed the row's own paths, never a hand-spelled one", async () => {
    const art = artOf(row);
    let io: unknown;
    await send(row, { prepare: (got) => { io = got; return { prompt: "p" }; } });
    expect(io).toEqual({
      art,
      stateFile: join(art, `research-${AGENT}.txt`),
      artifact: row.artifactFor(art, AGENT, PROVIDER, TOPIC),
      promptFile: join(art, `${AGENT}_research_prompt.md`),
    });
  });
});

describe("phaseSend: a phase is a row plus a prepare body", () => {
  // The success criterion of the phase table, exercised without shipping an eighth explore phase:
  // a row the shipped table has never seen dispatches correctly with no other change.
  const CANARY: PhaseRow = {
    phase: "canary", key: "FS", cmd: "explore", artDir: exploreArtDir, timeoutKind: "research",
    artifactFor: (art, agent) => join(art, `canary-${agent}.md`), stateFn: verifyState, skippable: true,
  };

  it("dispatches through the shared head with its own state file, artifact and prompt file", async () => {
    const art = artOf(CANARY);
    let sent: string[] = [];
    const rc = await send(CANARY, { prepare: ({ artifact }) => ({ prompt: `write ${artifact}` }) }, sendDeps({
      offsetFor: () => 3,
      send: async (a) => { sent = a; return 0; },
    }));
    expect(rc).toBe(0);
    expect(readFileSync(join(art, `canary-${AGENT}.txt`), "utf8")).toBe("OFFSET=3\n");
    expect(readFileSync(join(art, `${AGENT}_canary_prompt.md`), "utf8")).toBe(`write ${join(art, `canary-${AGENT}.md`)}`);
    expect(sent[4]).toBe(`@${join(art, `${AGENT}_canary_prompt.md`)}`);
  });
});
