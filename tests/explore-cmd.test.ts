// tests/explore-cmd.test.ts — /ap:explore verbs.
//
// The send/wait SKELETON is one shared body (core/phaseTable.ts), so it is tested ONCE, table-driven
// over PHASES: guard chain + encoding, zero-input skip, dispatch tail, wait classify/re-arm. Adding a
// phase #8 = one PHASES row + one composer + one dispatch case, and it inherits that whole matrix.
// Everything below the skeleton suite is what is genuinely per-phase: prompt composition, phase
// preconditions, artifact contents, and the dated guard-chain regression suites at the end.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { globalRoot, workerDir } from "../src/core/paths.js";
import { outboxPath, paneMetaPath, statusPath } from "../src/core/ipc.js";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { sendDeps, waitDeps } from "./helpers/phaseDeps.js";
import { initWith, classifyRun, spawnAllWith, researchSendWith, researchWaitWith, openqCollateRun, openqSendWith, openqWaitWith, crossverifySendWith, crossverifyWaitWith, rebuttalSendWith, rebuttalWaitWith, gapSendWith, gapWaitWith, signoffSendWith, signoffWaitWith, survivorsRun, synthPreliminaryRun, confidenceRun, annotateRun, adversarySendWith, adversaryWaitWith, synthFinalRun, verdictTallyRun, diffExploreRun, forensicsRun as exploreForensicsRun, teardownWith as exploreTeardownWith, handoffExtractRun, contributionRun, type ExploreInitDeps, type ExploreSpawnAllDeps } from "../src/commands/explore.js";
import { exploreArtDir } from "../src/core/explore.js";
import { PHASES, type PhaseKey, type PhaseRow, type SendDeps, type WaitDeps } from "../src/core/phaseTable.js";
import { END_OF_ARTIFACT } from "../src/core/artifact.js";
import { consultTimeout } from "../src/core/contracts.js";
import { scaledTimeout } from "../src/core/designTurn.js";

/** Put a worker mid-turn. Since the 2026-08-08 liveness spec an unsafe guard chain skips unless the
 *  worker is verifiably free — every skip case below pins the chain semantics, so it seeds a busy
 *  worker; the override's own evidence rules are pinned in tests/liveness-guards.test.ts. */
function markBusy(agent: string, provider: string, topic: string): void {
  mkdirSync(workerDir(agent, provider, topic), { recursive: true });
  writeFileSync(statusPath(agent, provider, topic), '{"state":"working"}\n');
}

/** The evidence that lets a guard override its chain verdict, all four legs present: the worker
 *  REPORTED an idle status itself (not the spawn seed), a terminal event landed past the failing
 *  phase's offset, that phase's artifact is settled, and pane.json names a pane (its liveness is
 *  injected). Remove any one leg and the skip must stand. */
function seedOverrideEvidence(agent: string, provider: string, topic: string): void {
  mkdirSync(workerDir(agent, provider, topic), { recursive: true });
  writeFileSync(statusPath(agent, provider, topic), JSON.stringify({ state: "idle", last_event: "done" }) + "\n");
  writeFileSync(outboxPath(agent, provider, topic), '{"event":"done","summary":"landed late"}\n');
  writeFileSync(paneMetaPath(agent, provider, topic), JSON.stringify({ pane_id: "%9", agent, model: provider }) + "\n");
}

/** The hub flags recorded under AP_HOME/forensics/<date>/ — /ap:review's feed. */
function hubFlags(): string {
  const root = join(globalRoot(), "forensics");
  if (!existsSync(root)) return "";
  return readdirSync(root)
    .flatMap((d) => readdirSync(join(root, d)).map((f) => readFileSync(join(root, d, f), "utf8")))
    .join("\n");
}

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const se = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => { chunks.push(String(s)); return true; }) as typeof process.stderr.write;
  return { text: () => chunks.join(""), restore: () => { process.stderr.write = se; } };
}

/** One broken evidence leg each: the mutation that must turn an override back into a skip. `break`
 *  edits the seeded state and/or returns the dep overrides that carry the failure. */
const BROKEN_LEGS: Array<{
  name: string;
  break(agent: string, provider: string, topic: string, art: string, failRow: PhaseRow): Partial<SendDeps>;
  why: string;
}> = [
  {
    name: "no status.json at all",
    break: (i, m, t) => { rmSync(statusPath(i, m, t), { force: true }); return {}; },
    why: "no status.json from the worker",
  },
  {
    name: "status.json is still the platform spawn seed",
    break: (i, m, t) => {
      writeFileSync(statusPath(i, m, t), JSON.stringify({ state: "idle", last_event: "spawn" }) + "\n");
      return {};
    },
    why: "still the spawn seed",
  },
  { name: "the worker is busy", break: () => ({ busyState: () => "working" }), why: "live state=working" },
  {
    name: "no terminal outbox event past the offset",
    break: (i, m, t) => { writeFileSync(outboxPath(i, m, t), '{"event":"progress","note":"still going"}\n'); return {}; },
    why: "no terminal outbox event since",
  },
  {
    name: "the failing phase's artifact is still being written",
    break: (i, m, t, art, failRow) => {
      writeFileSync(failRow.artifactFor(art, i, m, t), "half a document, no sentinel");
      return {};
    },
    why: "still being written",
  },
  {
    name: "no pane.json",
    break: (i, m, t) => { rmSync(paneMetaPath(i, m, t), { force: true }); return {}; },
    why: "no pane.json",
  },
  { name: "the pane is gone", break: () => ({ paneAlive: async () => false }), why: "is gone" },
];

/** A worker artifact as the completeness contract requires it: body + the sentinel as its LAST
 *  line. Everything the validators (survivors / synth-preliminary) accept must carry it. */
const complete = (body: string): string => `${body}\n${END_OF_ARTIFACT}\n`;

function initDeps(over: Partial<ExploreInitDeps> = {}): ExploreInitDeps {
  return {
    activeProviders: () => ["codex", "claude"],
    isValidated: () => true,
    pickAgents: (_t, n) => ["alpha", "charlie", "golf"].slice(0, n),
    ...over,
  };
}

describe("explore init", () => {
  it("scaffolds _explore with topic.txt + list.txt for N=2", async () => {
    const { cleanup } = freshHome();
    try {
      const rc = await initWith(["attention", "kernels"], initDeps());
      expect(rc).toBe(0);
      const art = exploreArtDir("attention-kernels");
      expect(existsSync(join(art, "topic.txt"))).toBe(true);
      expect(readFileSync(join(art, "topic.txt"), "utf8")).toBe("attention kernels");
      expect(readFileSync(join(art, "list.txt"), "utf8")).toContain("codex\talpha");
    } finally { cleanup(); }
  });
  it("rc1 when fewer than 2 validated providers", async () => {
    const { cleanup } = freshHome();
    try {
      const rc = await initWith(["x"], initDeps({ activeProviders: () => ["codex"] }));
      expect(rc).toBe(1);
    } finally { cleanup(); }
  });
  it("caps to 3 providers", async () => {
    const { cleanup } = freshHome();
    try {
      const rc = await initWith(["x"], initDeps({ activeProviders: () => ["a", "b", "c", "d"] }));
      expect(rc).toBe(0);
      expect(readFileSync(join(exploreArtDir("x"), "list.txt"), "utf8").split("\n").filter((l) => l.includes("\t")).length).toBe(3);
    } finally { cleanup(); }
  });
  it("rc2 when _explore already exists", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const rc = await initWith(["x"], initDeps());
      expect(rc).toBe(2);
    } finally { cleanup(); }
  });
});

describe("explore classify", () => {
  it("writes lit-track.txt = ON for an academic topic", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["attention", "models"], initDeps());
      const rc = await classifyRun(["attention-models"]);
      expect(rc).toBe(0);
      const lt = readFileSync(join(exploreArtDir("attention-models"), "lit-track.txt"), "utf8");
      expect(lt.startsWith("ON\n")).toBe(true);
      expect(lt).toContain("reason: auto-detect via keyword scan");
    } finally { cleanup(); }
  });
  it("rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try { expect(await classifyRun(["nope"])).toBe(1); } finally { cleanup(); }
  });
});

describe("explore spawn-all", () => {
  it("preflights then spawns each list worker; rc0 when all ok", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      const deps: ExploreSpawnAllDeps = {
        preflight: async () => { writeFileSync(join(art, "preflight-panes.txt"), "alpha\t%1\ncharlie\t%2\n"); return 0; },
        spawn: async () => 0,
        repoRoot: () => "/repo",
      };
      const rc = await spawnAllWith("x", deps);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "spawn-results.tsv"), "utf8")).toContain("alpha\tcodex\t0");
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------------------------------------
// The table-driven skeleton suite: one generated matrix per PHASES row.
// ---------------------------------------------------------------------------------------------

type Seed = (art: string, agent: string) => void;

interface Skeleton {
  phase: string;
  send: (topic: string, agent: string, provider: string, d: SendDeps) => Promise<number>;
  wait: (topic: string, agent: string, provider: string, d: WaitDeps) => Promise<number>;
  /** Preconditions for a dispatch. Must NOT write the agent's own chain state files — the guard
   *  cases own those (a peer's state file is fine; the guard only reads the agent under test). */
  seed: Seed;
  /** Make the phase's own zero-input skip fire; undefined when the phase has no such skip. */
  starve?: Seed;
  /** Artifact content that classifies as `<KEY>=ok`. */
  okArtifact: string;
  /** `<KEY>=` value for a done event with an EMPTY artifact: researchState says "empty" where
   *  verifyState says "missing" — the stateFn slot, observable only here. */
  emptyState: string;
}

const NEEDS_ATTENTION = [
  "# Adversary critique: charlie's pass",
  "## Verdict",
  "needs-attention",
  "## Material findings",
  "### Finding 1: alpha's solo claim over-reaches",
  "- **Targets:** src/only-a.ts:1 in the draft",
  "- **Why vulnerable:** the cited file does not say that",
].join("\n");

/** A phase's dispatch preconditions, written in ONE place: the skeleton table below drives the
 *  generic matrix from these, and the per-phase suites reuse them for their composer assertions. */
const seed: Record<string, Seed> = {
  research: () => { /* explore init already wrote topic.txt */ },
  openq: (art, agent) => writeFileSync(join(art, `openq-claims-${agent}.txt`), "charlie\tIs batch viable?\n"),
  crossverify: (art) => {
    writeFileSync(join(art, "alpha_only_items.txt"), "[src/only-a.ts:1] AlphaOnly — solo\n");
    writeFileSync(join(art, "charlie_only_items.txt"), "[paper:arxiv:9] CharlieOnly — solo\n");
  },
  adversary: (art) => writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A"),
  rebuttal: (art) => {
    writeFileSync(join(art, "alpha_only_items.txt"), "[src/only-a.ts:1] AlphaOnly — solo\n");
    writeFileSync(join(art, "charlie_only_items.txt"), "");
    // Sentinel-complete: rebuttal-send backstops every critique it selects targets FROM.
    writeFileSync(join(art, "adversary-alpha.md"), complete("## Verdict\naccept"));
    writeFileSync(join(art, "adversary-charlie.md"), complete(NEEDS_ATTENTION)); // charlie critiques alpha
    writeFileSync(join(art, "adversary-charlie.txt"), "OFFSET=0\nAC=sentinel\nAS=ok\n"); // peer state, not alpha's
  },
  gap: (art) => {
    writeFileSync(join(art, "adversary-skip.txt"),
      "timestamp: t\nsignals_passed: S1=true S2=false S3=true S4=true S5=true\nuser_decision: not-offered\n");
    writeFileSync(join(art, "alpha_only_items.txt"), "");
    writeFileSync(join(art, "charlie_only_items.txt"), "[paper:arxiv:9] CharlieOnly — solo\n");
  },
  signoff: (art) => {
    writeFileSync(join(art, "landscape-2026-07-10-x.md"),
      "## Topic\nx\n## Approaches\n1. A\n## Conclusion\nAdopt FlashAttention; caveats apply.\n## Citations\n- c\n");
    writeFileSync(join(art, "alpha_only_items.txt"), "[src/only-a.ts:1] AlphaOnly — solo\n");
    writeFileSync(join(art, "charlie_only_items.txt"), "");
    writeFileSync(join(art, "diff.md"),
      "## Agreed\n- [https://x.test/p] Shared — both\n\n## Alpha-only\n- [src/only-a.ts:1] AlphaOnly — solo\n\n## Charlie-only\n");
  },
};

const SKELETONS: Skeleton[] = [
  {
    phase: "research", send: researchSendWith, wait: researchWaitWith, seed: seed.research,
    okArtifact: "## Claims\n1. [src/a.ts:1] x\n", emptyState: "empty",
  },
  {
    phase: "openq", send: openqSendWith, wait: openqWaitWith, seed: seed.openq,
    starve: (art, agent) => rmSync(join(art, `openq-claims-${agent}.txt`), { force: true }),
    okArtifact: "## Q1 x\nanswer\n", emptyState: "missing",
  },
  {
    phase: "crossverify", send: crossverifySendWith, wait: crossverifyWaitWith, seed: seed.crossverify,
    starve: (art) => {
      writeFileSync(join(art, "alpha_only_items.txt"), "");
      writeFileSync(join(art, "charlie_only_items.txt"), "");
    },
    okArtifact: "# Verify\n## Verdicts\n1. AGREE ...\n", emptyState: "missing",
  },
  {
    phase: "adversary", send: adversarySendWith, wait: adversaryWaitWith, seed: seed.adversary,
    okArtifact: "## Verdict\naccept\n", emptyState: "missing",
  },
  {
    phase: "rebuttal", send: rebuttalSendWith, wait: rebuttalWaitWith, seed: seed.rebuttal,
    starve: (art) => writeFileSync(join(art, "adversary-charlie.md"), "## Verdict\naccept\n"),
    okArtifact: "# Rebuttal\n## Responses\n1. DEFEND ...\n", emptyState: "missing",
  },
  {
    phase: "gap", send: gapSendWith, wait: gapWaitWith, seed: seed.gap,
    starve: (art) => writeFileSync(join(art, "charlie_only_items.txt"), ""),
    okArtifact: "# Gap enrichment\n## Answers\n1. CONFIRM ...\n", emptyState: "missing",
  },
  {
    phase: "signoff", send: signoffSendWith, wait: signoffWaitWith, seed: seed.signoff,
    okArtifact: "# Sign-off\nVERDICT: fair\n", emptyState: "missing",
  },
];

describe("explore phase send/wait skeleton (table-driven over PHASES)", () => {
  const TOPIC = "x", AGENT = "alpha", PROVIDER = "codex";
  let h: { home: string; cleanup: () => void };
  let art: string;
  beforeEach(async () => {
    h = freshHome();
    await initWith([TOPIC], initDeps()); // list: alpha(codex), charlie(claude)
    art = exploreArtDir(TOPIC);
  });
  afterEach(() => { h.cleanup(); });

  it("covers every PHASES row", () => {
    expect(SKELETONS.map((s) => s.phase)).toEqual(PHASES.map((p) => p.phase));
  });

  it("the starve (zero-input skip) set is exactly the phases that have one", () => {
    // `starve` is a test-table slot with no other completeness check: without this pin, deleting
    // it from a SKELETONS row would silently delete that phase's zero-input-skip test.
    expect(SKELETONS.filter((s) => s.starve).map((s) => s.phase)).toEqual(["openq", "crossverify", "rebuttal", "gap"]);
  });

  for (const s of SKELETONS) {
    const row = PHASES.find((p) => p.phase === s.phase)!;
    const KEY = row.key;
    const chain = row.guard?.chain ?? [];
    const stateFile = (agent = AGENT) => join(art, `${s.phase}-${agent}.txt`);

    /** Write `<KEY>=<value>` into the state file that owns each key, as the wait verbs do. */
    const setChain = (tags: Partial<Record<PhaseKey, string>>): void => {
      for (const [k, v] of Object.entries(tags)) {
        const owner = PHASES.find((p) => p.key === k)!.phase;
        writeFileSync(join(art, `${owner}-${AGENT}.txt`), `OFFSET=0\n${k}=${v}\n`);
      }
    };

    /** Dispatch under the current state and assert whether the guard let it through. */
    const expectDispatch = async (dispatched: boolean): Promise<void> => {
      const send = vi.fn(async () => 0);
      expect(await s.send(TOPIC, AGENT, PROVIDER, sendDeps({ offsetFor: () => 4, send }))).toBe(0);
      if (dispatched) {
        expect(send).toHaveBeenCalled();
        expect(readFileSync(stateFile(), "utf8")).toBe("OFFSET=4\n");
      } else {
        expect(send).not.toHaveBeenCalled();
        expect(readFileSync(stateFile(), "utf8")).toBe(`${KEY}=skipped\n`);
        // A guard skip must not render a prompt file (pinned on main; restored by the 2026-07-31 audit).
        expect(existsSync(join(art, `${AGENT}_${s.phase}_prompt.md`))).toBe(false);
      }
    };

    describe(`${s.phase}-send`, () => {
      it("happy path: OFFSET captured BEFORE the send, prompt rendered, @prompt-file dispatch", async () => {
        s.seed(art, AGENT);
        let sent: string[] = [];
        let stateAtSend: string | null = null;
        const rc = await s.send(TOPIC, AGENT, PROVIDER, sendDeps({
          offsetFor: () => 7,
          send: async (a) => { sent = a; stateAtSend = readFileSync(stateFile(), "utf8"); return 0; },
        }));
        expect(rc).toBe(0);
        expect(stateAtSend).toBe("OFFSET=7\n"); // written before send: a crash leaves a retryable state
        const promptFile = join(art, `${AGENT}_${s.phase}_prompt.md`);
        expect(existsSync(promptFile)).toBe(true);
        expect(sent).toEqual(["--from", "hub", AGENT, TOPIC, `@${promptFile}`]);
      });

      it("rc 1 when its state file already exists; no send", async () => {
        s.seed(art, AGENT);
        writeFileSync(stateFile(), "OFFSET=1\n");
        const send = vi.fn(async () => 0);
        expect(await s.send(TOPIC, AGENT, PROVIDER, sendDeps({ send }))).toBe(1);
        expect(send).not.toHaveBeenCalled();
      });

      it("send failure → rc 1 and the state file is KEPT (rm to redo)", async () => {
        s.seed(art, AGENT);
        expect(await s.send(TOPIC, AGENT, PROVIDER, sendDeps({ offsetFor: () => 2, send: async () => 3 }))).toBe(1);
        expect(readFileSync(stateFile(), "utf8")).toBe("OFFSET=2\n");
      });

      if (s.starve) {
        it(`zero input → ${KEY}=skipped reported as success, no send`, async () => {
          s.seed(art, AGENT);
          s.starve!(art, AGENT);
          await expectDispatch(false);
        });
      }

      if (row.guard) {
        for (const k of chain) {
          it(`guard: ${k}=timeout → ${KEY}=skipped, no send`, async () => {
            // Chain entries ahead of k are seeded skipped so k is the one that decides under BOTH
            // encodings; entries behind it are ok, proving they cannot mask it.
            s.seed(art, AGENT);
            markBusy(AGENT, PROVIDER, TOPIC);
            const idx = chain.indexOf(k);
            setChain(Object.fromEntries(chain.map((c, i) => [c, i < idx ? "skipped" : i === idx ? "timeout" : "ok"])));
            await expectDispatch(false);
          });

          it(`guard: ${k}=skipped with the rest of the chain ok → dispatches`, async () => {
            s.seed(art, AGENT);
            setChain(Object.fromEntries(chain.map((c) => [c, c === k ? "skipped" : "ok"])));
            await expectDispatch(true);
          });
        }

        it(`guard: ${chain[chain.length - 1]}=failed → ${KEY}=skipped, no send`, async () => {
          s.seed(art, AGENT);
          markBusy(AGENT, PROVIDER, TOPIC);
          setChain(Object.fromEntries(chain.map((c, i) => [c, i === chain.length - 1 ? "failed" : "skipped"])));
          await expectDispatch(false);
        });

        it("guard: whole chain ok → dispatches", async () => {
          s.seed(art, AGENT);
          setChain(Object.fromEntries(chain.map((c) => [c, "ok"])));
          await expectDispatch(true);
        });

        if (chain.length > 1) {
          const kind = row.guard.kind;
          it(`guard encoding (${kind}): chain head ${chain[0]}=ok + chain tail ${chain[chain.length - 1]}=timeout → ${kind === "any" ? `the guard refuses (${KEY}=skipped)` : "the guard clears it (only the busy-gate refuses, rc 3)"}`, async () => {
            // The input the two encodings answer differently. The walk sites (rebuttal/gap/signoff)
            // consult ONLY the head of their chain — the latest phase — so a clean head clears an
            // older failure; the ternary sites scan the whole chain and a tail failure still blocks.
            // BOTH sides run against a busy worker, so the two encodings produce visibly different
            // refusals (guard rc 0 + state write vs busy-gate rc 3 + no state file) instead of the
            // same "no send" — swapping one encoding for the other used to leave this test green.
            s.seed(art, AGENT);
            markBusy(AGENT, PROVIDER, TOPIC);
            setChain({ [chain[0]]: "ok", [chain[chain.length - 1]]: "timeout" });
            const send = vi.fn(async () => 0);
            const err = captureStderr();
            let rc: number;
            try { rc = await s.send(TOPIC, AGENT, PROVIDER, sendDeps({ offsetFor: () => 4, send })); }
            finally { err.restore(); }
            expect(send).not.toHaveBeenCalled();
            if (kind === "any") {
              expect(rc).toBe(0);
              expect(readFileSync(stateFile(), "utf8")).toBe(`${KEY}=skipped\n`);
            } else {
              expect(rc).toBe(3);
              expect(existsSync(stateFile())).toBe(false);
            }
          });
        }

        // The 2026-08-08 override, parametrized over EVERY guarded verb: a mutation audit removed
        // five of the six call-site wirings and the suite stayed green, so each verb pins its own.
        const failRow = PHASES.find((p) => p.key === chain[0])!;
        it(`guard override: ${chain[0]}=timeout + all four evidence legs → dispatches, flagged`, async () => {
          s.seed(art, AGENT);
          setChain({ [chain[0]]: "timeout" });
          seedOverrideEvidence(AGENT, PROVIDER, TOPIC);
          const send = vi.fn(async () => 0);
          const err = captureStderr();
          try {
            expect(await s.send(TOPIC, AGENT, PROVIDER, sendDeps({ offsetFor: () => 4, send, paneAlive: async () => true }))).toBe(0);
          } finally { err.restore(); }
          expect(send).toHaveBeenCalled();
          expect(readFileSync(stateFile(), "utf8")).toBe("OFFSET=4\n");
          expect(existsSync(join(art, `${AGENT}_${s.phase}_prompt.md`))).toBe(true);
          expect(err.text()).toContain(`guard override — ${row.guard!.noun} ended ${chain[0]}=timeout`);
          expect(hubFlags()).toContain(`guard-override-idle: ${AGENT} ${s.phase} chain=${chain[0]}=timeout`);
        });

        for (const leg of BROKEN_LEGS) {
          it(`guard override refused (${leg.name}) → ${KEY}=skipped, no send, no flag`, async () => {
            s.seed(art, AGENT);
            setChain({ [chain[0]]: "timeout" });
            seedOverrideEvidence(AGENT, PROVIDER, TOPIC);
            const over = leg.break(AGENT, PROVIDER, TOPIC, art, failRow);
            const send = vi.fn(async () => 0);
            const err = captureStderr();
            try {
              expect(await s.send(TOPIC, AGENT, PROVIDER, sendDeps({ send, paneAlive: async () => true, ...over }))).toBe(0);
            } finally { err.restore(); }
            expect(send).not.toHaveBeenCalled();
            expect(readFileSync(stateFile(), "utf8")).toBe(`${KEY}=skipped\n`);
            expect(err.text()).toContain(leg.why);
            expect(hubFlags()).toBe("");
          });
        }
      }
    });

    describe(`${s.phase}-wait`, () => {
      it(`done + complete artifact → ${KEY}=ok; empty → ${KEY}=${s.emptyState}; absent → ${KEY}=missing; no event → ${KEY}=timeout`, async () => {
        // The stateFn slot, observable only here. An empty/absent artifact is a done-then-write race
        // under the default grace, so those two rows run with the sentinel check DISABLED
        // (AP_ARTIFACT_GRACE_S=0) — that is the classification the stateFn has always produced.
        const done = async () => ({ event: "done" } as any);
        const cases: Array<[string, string | null, () => Promise<any>, string, string | null]> = [
          ["alpha", s.okArtifact + END_OF_ARTIFACT + "\n", done, "ok", null],
          ["charlie", "", done, s.emptyState, "0"],
          ["golf", null, done, "missing", "0"],
          ["hotel", s.okArtifact, async () => null, "timeout", null],
        ];
        try {
          for (const [agent, artifact, ev, expected, grace] of cases) {
            if (grace === null) delete process.env.AP_ARTIFACT_GRACE_S; else process.env.AP_ARTIFACT_GRACE_S = grace;
            writeFileSync(stateFile(agent), "OFFSET=0\n");
            if (artifact !== null) writeFileSync(row.artifactFor(art, agent, PROVIDER, TOPIC), artifact);
            expect(await s.wait(TOPIC, agent, PROVIDER, waitDeps({ wait: ev }))).toBe(0);
            expect(readFileSync(stateFile(agent), "utf8")).toContain(`${KEY}=${expected}`);
            expect(existsSync(join(art, `${s.phase}-${agent}.done`))).toBe(true);
          }
        } finally {
          // A failing expect must not leak the env override into every later test in this file.
          delete process.env.AP_ARTIFACT_GRACE_S;
        }
      });

      it(`a question captures the payload and re-arms OFFSET (${KEY}=question)`, async () => {
        writeFileSync(stateFile(), "OFFSET=0\n");
        const ev = { event: "question", message: "which one?" };
        expect(await s.wait(TOPIC, AGENT, PROVIDER, waitDeps({ wait: async () => ev as any }))).toBe(0);
        const state = readFileSync(stateFile(), "utf8");
        expect(state).toContain(`${KEY}=question`);
        expect(state.match(/OFFSET=/g)!.length).toBe(2); // re-armed past the handled question
        expect(readFileSync(join(art, `question-${AGENT}.txt`), "utf8")).toContain("which one?");
      });

      it(row.skippable
        ? `${KEY}=skipped → fast-path .done, rc 0, wait never called`
        : `${KEY}=skipped → rc 1 (no fast-path: research always needs an OFFSET)`, async () => {
        writeFileSync(stateFile(), `${KEY}=skipped\n`);
        const wait = vi.fn(async () => null);
        const rc = await s.wait(TOPIC, AGENT, PROVIDER, waitDeps({ wait }));
        expect(wait).not.toHaveBeenCalled();
        expect(rc).toBe(row.skippable ? 0 : 1);
        expect(existsSync(join(art, `${s.phase}-${AGENT}.done`))).toBe(row.skippable);
        expect(readFileSync(stateFile(), "utf8")).toBe(`${KEY}=skipped\n`); // no extra lines either way
      });

      it("rc 1 when the state file is missing (send not run)", async () => {
        const wait = vi.fn(async () => null);
        expect(await s.wait(TOPIC, AGENT, PROVIDER, waitDeps({ wait }))).toBe(1);
        expect(wait).not.toHaveBeenCalled();
      });

      it(`the wait budget is contracts' ${row.timeoutKind} timeout, provider-scaled`, async () => {
        writeFileSync(stateFile(), "OFFSET=0\n");
        let got = -1;
        await s.wait(TOPIC, AGENT, PROVIDER, waitDeps({
          multiplier: () => "2",
          wait: async (_i, _m, _t, _off, _ev, to) => { got = to; return null; },
        }));
        expect(got).toBe(scaledTimeout(consultTimeout(row.timeoutKind), "2"));
      });
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Per-phase behavior the table cannot express: prompt composition, preconditions, artifacts.
// ---------------------------------------------------------------------------------------------

describe("explore research-send (prompt composition)", () => {
  it("renders the findings + selfassess paths into <agent>_research_prompt.md", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      await classifyRun(["x"]);
      const art = exploreArtDir("x");
      const rc = await researchSendWith("x", "alpha", "codex", sendDeps({ offsetFor: () => 7 }));
      expect(rc).toBe(0);
      const prompt = readFileSync(join(art, "alpha_research_prompt.md"), "utf8");
      expect(prompt).toContain(join(art, "findings-alpha.md"));
      expect(prompt).toContain(join(art, "selfassess-alpha.md"));
    } finally { cleanup(); }
  });
  it("weights the prompt by provider: codex gets the code lens, claude the literature lens", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // list: alpha(codex), charlie(claude)
      await classifyRun(["x"]);
      const art = exploreArtDir("x");
      expect(await researchSendWith("x", "alpha", "codex", sendDeps())).toBe(0);
      expect(await researchSendWith("x", "charlie", "claude", sendDeps())).toBe(0);
      const pAlpha = readFileSync(join(art, "alpha_research_prompt.md"), "utf8");
      const pCharlie = readFileSync(join(art, "charlie_research_prompt.md"), "utf8");
      expect(pAlpha).toContain("repo-code evidence");
      expect(pCharlie).toContain("literature and web synthesis");
      const guard = "This is an emphasis, not a boundary";
      expect(pAlpha).toContain(guard);
      expect(pCharlie).toContain(guard);
    } finally { cleanup(); }
  });
  it("rc1 when topic.txt is missing/empty", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      writeFileSync(join(exploreArtDir("x"), "topic.txt"), "");
      expect(await researchSendWith("x", "alpha", "codex", sendDeps())).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore openq-collate", () => {
  it("collates open questions and writes per-target claims files (swap at N=2)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // alpha, charlie
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), complete("## Open questions\n- qa1\n- qa2\n## Notes\nn"));
      writeFileSync(join(art, "findings-charlie.md"), complete("## Open questions\n- qc1\n## Notes\nn"));
      const rc = await openqCollateRun(["x"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "open-questions.md"), "utf8")).toContain("qa1");
      expect(readFileSync(join(art, "openq-claims-charlie.txt"), "utf8")).toBe("alpha\tqa1\nalpha\tqa2\n");
      expect(readFileSync(join(art, "openq-claims-alpha.txt"), "utf8")).toBe("charlie\tqc1\n");
    } finally { cleanup(); }
  });
  it("prints OPENQ=none and writes no claims files when no findings carry questions", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), complete("## Summary\ns"));
      writeFileSync(join(art, "findings-charlie.md"), complete("## Summary\ns"));
      expect(await openqCollateRun(["x"])).toBe(0);
      expect(existsSync(join(art, "open-questions.md"))).toBe(false);
      expect(existsSync(join(art, "openq-claims-alpha.txt"))).toBe(false);
      expect(existsSync(join(art, "openq-claims-charlie.txt"))).toBe(false);
    } finally { cleanup(); }
  });
  it("rc2 without a topic; rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try {
      expect(await openqCollateRun([])).toBe(2);
      expect(await openqCollateRun(["nope"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore openq-send (prompt composition)", () => {
  it("numbers the routed claims with their asker and names the answers path", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      writeFileSync(join(art, "openq-claims-alpha.txt"), "charlie\tIs batch viable?\n");
      expect(await openqSendWith("x", "alpha", "codex", sendDeps({ offsetFor: () => 9 }))).toBe(0);
      const prompt = readFileSync(join(art, "alpha_openq_prompt.md"), "utf8");
      expect(prompt).toContain("1. (from charlie) Is batch viable?");
      expect(prompt).toContain(join(art, "openq-alpha.md"));
    } finally { cleanup(); }
  });
});

async function seedFindings(art: string, draft: string): Promise<void> {
  writeFileSync(join(art, "findings-alpha.md"), "FlashAttention is fast. https://x.test/p . uncertain about batch.");
  writeFileSync(join(art, "findings-charlie.md"), "FlashAttention wins. https://x.test/p .");
  writeFileSync(join(art, "landscape-draft.md"), draft);
}
const DRAFT = [
  "## Approaches", "1. FlashAttention — fused", "## Tradeoff matrix",
  "| Priority | Best fit | Reason |", "| latency | FlashAttention | https://x.test/p |", "## Citations", "- https://x.test/p",
].join("\n");

describe("explore synth-preliminary", () => {
  it("prints the draft path when all findings exist", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), complete("a")); writeFileSync(join(art, "findings-charlie.md"), complete("b"));
      const rc = await synthPreliminaryRun(["x"]);
      expect(rc).toBe(0);
    } finally { cleanup(); }
  });
  it("rc1 when a worker's findings are missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      writeFileSync(join(exploreArtDir("x"), "findings-alpha.md"), "a"); // charlie missing
      expect(await synthPreliminaryRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore confidence", () => {
  it("no-flag + not-all-hold writes adversary-skip.txt with user_decision: not-offered", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      await seedFindings(art, DRAFT + "\nCONTESTED: foo"); // S3 fails -> not all hold
      const rc = await confidenceRun(["x"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "adversary-skip.txt"), "utf8")).toContain("user_decision: not-offered");
    } finally { cleanup(); }
  });
  it("--decision skip writes the record with that decision", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      await seedFindings(art, DRAFT);
      const rc = await confidenceRun(["x", "--decision", "skip"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "adversary-skip.txt"), "utf8")).toContain("user_decision: skip");
    } finally { cleanup(); }
  });
  it("ALL_HOLD=true + no flag writes nothing (two-call: Hub asks before --decision)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      // header-less matrix with a /-anchored Reason cell so the strict S4 holds; alpha finding has
      // "uncertain" (S5); both findings cite https://x.test/p (S1/S2); no CONTESTED (S3) -> all hold.
      const allHold = [
        "## Approaches", "1. FlashAttention — fused", "## Tradeoff matrix",
        "| latency | FlashAttention | /p see https://x.test/p |", "## Citations", "- https://x.test/p",
      ].join("\n");
      await seedFindings(art, allHold);
      const rc = await confidenceRun(["x"]);
      expect(rc).toBe(0);
      expect(existsSync(join(art, "adversary-skip.txt"))).toBe(false);
    } finally { cleanup(); }
  });
  it("prints S1=..S5= per-signal lines to stdout with ALL_HOLD= as the LAST line", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      await seedFindings(art, DRAFT + "\nCONTESTED: foo"); // S3 fails
      const out = captureStdout();
      try {
        expect(await confidenceRun(["x"])).toBe(0);
      } finally { out.restore(); }
      const lines = out.text().trim().split("\n");
      expect(lines).toContain("S3=false");
      for (const n of [1, 2, 4, 5]) expect(lines.some((l) => new RegExp(`^S${n}=(true|false)$`).test(l))).toBe(true);
      expect(lines[lines.length - 1]).toBe("ALL_HOLD=false"); // directive-parse compatibility: last line
      expect(lines.slice(0, 5)).toEqual(lines.filter((l) => /^S[1-5]=/.test(l))); // S-lines come first, in order
    } finally { cleanup(); }
  });
});

describe("explore annotate", () => {
  it("annotates a solo citation + uncited row, writes marker + annotations.json", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      // alpha+charlie both cite https://x.test/p (corroborated); https://x.test/solo is solo (alpha only).
      writeFileSync(join(art, "findings-alpha.md"), "https://x.test/p and https://x.test/solo . uncertain.");
      writeFileSync(join(art, "findings-charlie.md"), "https://x.test/p only.");
      writeFileSync(join(art, "landscape-draft.md"), [
        "## Findings by worker", "See https://x.test/solo here.",
        "## Tradeoff matrix", "| latency | One | plain prose reason |",
      ].join("\n"));
      const rc = await annotateRun(["x"]);
      expect(rc).toBe(0);
      const out = readFileSync(join(art, "landscape-draft.md"), "utf8");
      expect(out).toContain("https://x.test/solo [unverified]");
      expect(out).toContain("plain prose reason [no citation]");
      expect(existsSync(join(art, "annotate-applied.txt"))).toBe(true);
      expect(readFileSync(join(art, "annotations.json"), "utf8")).toContain("\"n_unverified\"");
    } finally { cleanup(); }
  });
  it("is a no-op when annotate-applied.txt already exists", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      await seedFindings(art, DRAFT);
      writeFileSync(join(art, "annotate-applied.txt"), "applied: earlier\n");
      const before = readFileSync(join(art, "landscape-draft.md"), "utf8");
      const rc = await annotateRun(["x"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "landscape-draft.md"), "utf8")).toBe(before); // untouched
    } finally { cleanup(); }
  });
  it("rc1 when the draft is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      expect(await annotateRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore adversary-send (prompt composition + preconditions)", () => {
  it("guards the draft: rc1 when landscape-draft.md is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      expect(await adversarySendWith("x", "alpha", "codex", sendDeps())).toBe(1);
    } finally { cleanup(); }
  });
  it("lists peer findings paths and assigns a distinct lens per list index", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // list: alpha(codex), charlie(claude)
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      expect(await adversarySendWith("x", "alpha", "codex", sendDeps())).toBe(0);
      expect(await adversarySendWith("x", "charlie", "claude", sendDeps())).toBe(0);
      const pAlpha = readFileSync(join(art, "alpha_adversary_prompt.md"), "utf8");
      const pCharlie = readFileSync(join(art, "charlie_adversary_prompt.md"), "utf8");
      expect(pAlpha).toContain(join(art, "adversary-alpha.md"));    // the critique out path
      expect(pAlpha).toContain(join(art, "findings-charlie.md"));   // peers only
      expect(pAlpha).not.toContain(join(art, "findings-alpha.md"));
      expect(pCharlie).toContain(join(art, "findings-alpha.md"));
      expect(pAlpha).toContain("citation-fidelity");                 // index 0 lens
      expect(pCharlie).toContain("frame-exclusion");                 // index 1 lens
      expect(pAlpha).not.toBe(pCharlie);
    } finally { cleanup(); }
  });
  it("rc1 when the agent is not in list.txt", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      writeFileSync(join(exploreArtDir("x"), "landscape-draft.md"), "d");
      expect(await adversarySendWith("x", "zulu", "codex", sendDeps())).toBe(1);
    } finally { cleanup(); }
  });
  it("passes annotations.json solo tokens as Priority targets (unverified + approaches-flagged, deduped)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      writeFileSync(join(art, "annotations.json"), JSON.stringify({
        topic: "x",
        counts: { n_unverified: 2, n_no_citation: 1, n_approaches_flagged: 1 },
        items: [
          { kind: "unverified", token: "https://x.test/solo", lineIndex: 1 },
          { kind: "unverified", token: "https://x.test/solo", lineIndex: 4 },
          { kind: "approaches-flagged", token: "src/a.ts:1", lineIndex: 2 },
          { kind: "no-citation", lineIndex: 3 },
        ],
      }));
      const rc = await adversarySendWith("x", "alpha", "codex", sendDeps());
      expect(rc).toBe(0);
      const prompt = readFileSync(join(art, "alpha_adversary_prompt.md"), "utf8");
      expect(prompt).toContain("Priority targets");
      expect(prompt.split("- https://x.test/solo").length - 1).toBe(1); // deduped
      expect(prompt).toContain("- src/a.ts:1");
    } finally { cleanup(); }
  });
  it("omits the Priority targets block when annotations.json is missing or malformed", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      expect(await adversarySendWith("x", "alpha", "codex", sendDeps())).toBe(0);
      expect(readFileSync(join(art, "alpha_adversary_prompt.md"), "utf8")).not.toContain("Priority targets");

      writeFileSync(join(art, "annotations.json"), "{not json");
      expect(await adversarySendWith("x", "charlie", "claude", sendDeps())).toBe(0);
      expect(readFileSync(join(art, "charlie_adversary_prompt.md"), "utf8")).not.toContain("Priority targets");
    } finally { cleanup(); }
  });
  it("passes the union of selfassess least-sure lines as the low-confidence block", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      writeFileSync(join(art, "selfassess-alpha.md"), "high: A\n## Least sure\n- claim-a [src/a.ts:1]\n- shared-claim [https://x.test/s]\n");
      writeFileSync(join(art, "selfassess-charlie.md"), "## Least sure\n- shared-claim [https://x.test/s]\n- claim-c [paper:arxiv:9]\n");
      const rc = await adversarySendWith("x", "alpha", "codex", sendDeps());
      expect(rc).toBe(0);
      const prompt = readFileSync(join(art, "alpha_adversary_prompt.md"), "utf8");
      expect(prompt).toContain("Self-flagged low-confidence claims");
      expect(prompt).toContain("- claim-a [src/a.ts:1]");
      expect(prompt).toContain("- claim-c [paper:arxiv:9]");
      expect(prompt.split("- shared-claim [https://x.test/s]").length - 1).toBe(1); // unioned/deduped
    } finally { cleanup(); }
  });
  it("omits the low-confidence block when no selfassess files exist", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      expect(await adversarySendWith("x", "alpha", "codex", sendDeps())).toBe(0);
      expect(readFileSync(join(art, "alpha_adversary_prompt.md"), "utf8")).not.toContain("Self-flagged low-confidence claims");
    } finally { cleanup(); }
  });
});

describe("selfassess gate-blindness invariant (confidence/annotate never read selfassess-*)", () => {
  it("a selfassess file saturated with UNCERTAIN vocabulary and restated citations changes no signal and no marker", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      // Findings: confident (no UNCERTAIN vocab anywhere) and citation-disjoint (every draft cite is solo).
      writeFileSync(join(art, "findings-alpha.md"), "FlashAttention rocks. https://a.only/1 .");
      writeFileSync(join(art, "findings-charlie.md"), "PagedAttention rocks. https://c.only/2 .");
      writeFileSync(join(art, "landscape-draft.md"), [
        "## Approaches", "1. FlashAttention — fused", "## Tradeoff matrix",
        "| latency | FlashAttention | see https://a.only/1 |", "## Citations", "- https://a.only/1",
      ].join("\n"));
      // The poison pill: uncertainty vocab + BOTH citations restated. If confidence/annotate ever
      // read this file, S5 flips true and https://a.only/1 stops being solo (S2 + [unverified]).
      writeFileSync(join(art, "selfassess-alpha.md"),
        "low: FlashAttention\n## Least sure\n- uncertain unclear not sure https://a.only/1 https://c.only/2\n");
      const out = captureStdout();
      try { expect(await confidenceRun(["x"])).toBe(0); } finally { out.restore(); }
      const lines = out.text().trim().split("\n");
      expect(lines).toContain("S5=false"); // findings alone carry no uncertainty vocab
      expect(lines).toContain("S2=false"); // https://a.only/1 stays solo — selfassess restatement invisible
      expect(await annotateRun(["x"])).toBe(0);
      expect(readFileSync(join(art, "landscape-draft.md"), "utf8")).toContain("https://a.only/1 [unverified]");
    } finally { cleanup(); }
  });
});

describe("explore synth-final", () => {
  it("rc0 when adversary ran and all critiques exist", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "topic.txt"), "x"); writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
      writeFileSync(join(art, "adversary-alpha.md"), complete("c")); writeFileSync(join(art, "adversary-charlie.md"), complete("c"));
      expect(await synthFinalRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
  it("rc0 with only the draft when user_decision: skip", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: skip\n");
      expect(await synthFinalRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
  it("rc1 when adversary ran but a critique is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
      writeFileSync(join(art, "adversary-alpha.md"), complete("c")); // charlie missing
      expect(await synthFinalRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
  it("rc0 when a worker's critique is absent but its state says AS=skipped", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
      writeFileSync(join(art, "adversary-alpha.md"), complete("c"));           // alpha critiqued
      writeFileSync(join(art, "adversary-charlie.txt"), "AS=skipped\n"); // charlie skipped, no .md
      expect(await synthFinalRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
});

describe("explore verdict-tally", () => {
  it("prints one VERDICT= line per list row and a TALLY= majority (tie → most severe)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // list: alpha(codex), charlie(claude)
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.md"), complete("# c\n## Verdict\nneeds-attention\n## Material findings"));
      writeFileSync(join(art, "adversary-charlie.md"), complete("# c\n## Verdict\naccept"));
      const out = captureStdout();
      try { expect(await verdictTallyRun(["x"])).toBe(0); } finally { out.restore(); }
      const lines = out.text().trim().split("\n");
      expect(lines).toEqual(["VERDICT=alpha:needs-attention", "VERDICT=charlie:accept", "TALLY=needs-attention"]);
    } finally { cleanup(); }
  });
  it("AS=skipped rows report skipped and never enter the majority", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.md"), complete("## Verdict\naccept"));
      writeFileSync(join(art, "adversary-charlie.txt"), "AS=skipped\n"); // no .md
      const out = captureStdout();
      try { expect(await verdictTallyRun(["x"])).toBe(0); } finally { out.restore(); }
      const lines = out.text().trim().split("\n");
      expect(lines).toEqual(["VERDICT=alpha:accept", "VERDICT=charlie:skipped", "TALLY=accept"]);
    } finally { cleanup(); }
  });
  it("EVERY row skipped → a loud stderr warning, rc unchanged", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      for (const a of ["alpha", "charlie"]) writeFileSync(join(art, `adversary-${a}.txt`), "AS=skipped\n");
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
      const out = captureStdout();
      try { expect(await verdictTallyRun(["x"])).toBe(0); } finally { out.restore(); spy.mockRestore(); }
      expect(out.text().trim().split("\n")).toEqual(["VERDICT=alpha:skipped", "VERDICT=charlie:skipped", "TALLY=unavailable"]);
      expect(chunks.join("")).toContain("all adversary rounds skipped — the landscape will ship without adversarial review; verify this is intended");
    } finally { cleanup(); }
  });
  it("one live adversary round → no all-skipped warning", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.md"), complete("## Verdict\naccept"));
      writeFileSync(join(art, "adversary-charlie.txt"), "AS=skipped\n");
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
      const out = captureStdout();
      try { expect(await verdictTallyRun(["x"])).toBe(0); } finally { out.restore(); spy.mockRestore(); }
      expect(chunks.join("")).not.toContain("all adversary rounds skipped");
    } finally { cleanup(); }
  });
  it("missing or heading-less critique reports malformed; all-uncountable → TALLY=unavailable", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.md"), complete("no heading here"));
      // charlie has neither .txt nor .md → malformed too
      const out = captureStdout();
      try { expect(await verdictTallyRun(["x"])).toBe(0); } finally { out.restore(); }
      const lines = out.text().trim().split("\n");
      expect(lines).toEqual(["VERDICT=alpha:malformed", "VERDICT=charlie:malformed", "TALLY=unavailable"]);
    } finally { cleanup(); }
  });
  it("rc2 without a topic; rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try {
      expect(await verdictTallyRun([])).toBe(2);
      expect(await verdictTallyRun(["nope"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore teardown", () => {
  it("archives _explore, kills panes by id (not the whole TSV line), prints the dest", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "preflight-panes.txt"), "alpha\t%1\ncharlie\t%2\n");
      let dest = "";
      const killed: string[] = [];
      const rc = await exploreTeardownWith(["x"], {
        killPane: async (p) => { killed.push(p); },
        archiveTopic: () => { dest = "/archive/x/_explore-T"; return dest; },
        stdout: (l) => { dest = l; },
      });
      expect(rc).toBe(0);
      expect(dest).toContain("_explore");
      expect(killed).toEqual(["%1", "%2"]);   // pane id, not "alpha\t%1"
    } finally { cleanup(); }
  });

  it("--panes-only: kills partial panes, clears attempt files, preserves list, no archive", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "preflight-panes.txt"), "alpha\t%1\ncharlie\t%2\n");
      writeFileSync(join(art, "spawn-results.tsv"), "alpha\tcodex\t0\n");
      const killed: string[] = [];
      let archived = false;
      const rc = await exploreTeardownWith(["x", "--panes-only"], {
        killPane: async (p) => { killed.push(p); },
        archiveTopic: () => { archived = true; return "/should/not/happen"; },
      });
      expect(rc).toBe(0);
      expect(killed).toEqual(["%1", "%2"]);                              // partial panes killed
      expect(archived).toBe(false);                                     // NO archive
      expect(existsSync(join(art, "preflight-panes.txt"))).toBe(false); // attempt files cleared
      expect(existsSync(join(art, "spawn-results.tsv"))).toBe(false);
      expect(existsSync(join(art, "list.txt"))).toBe(true);           // state preserved for retry
    } finally { cleanup(); }
  });
});

describe("explore forensics", () => {
  it("rc2 when no topic is given", async () => {
    expect(await exploreForensicsRun([])).toBe(2);
  });
});

describe("explore handoff-extract", () => {
  it("rc2 on a missing art-dir / no topic.txt", async () => {
    const art = mkdtempSync(join(tmpdir(), "explore-empty-"));
    expect(await handoffExtractRun([art])).toBe(2);
  });
});

describe("explore diff", () => {
  const approaches = (...items: string[]) =>
    "## Approaches\n" + items.map((c, i) => `${i + 1}. ${c}`).join("\n") + "\n";
  it("writes diff.md + buckets from explore-schema findings", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // list: alpha(codex), charlie(claude)
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), complete(approaches("[src/a.ts:10] Shared — both", "[src/only-a.ts:1] AlphaOnly — solo")));
      writeFileSync(join(art, "findings-charlie.md"), complete(approaches("[src/a.ts:10] Shared — both", "[paper:arxiv:9] CharlieOnly — solo")));
      expect(await diffExploreRun(["x"])).toBe(0);
      expect(readFileSync(join(art, "alpha_only_items.txt"), "utf8")).toBe("[src/only-a.ts:1] AlphaOnly — solo\n");
      expect(readFileSync(join(art, "charlie_only_items.txt"), "utf8")).toBe("[paper:arxiv:9] CharlieOnly — solo\n");
      expect(readFileSync(join(art, "diff.md"), "utf8")).toContain("## Agreed\n- [src/a.ts:10] Shared — both | Shared — both\n");
    } finally { cleanup(); }
  });
  it("rc 1 when diff.md already exists or a findings file is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      expect(await diffExploreRun(["x"])).toBe(1); // findings missing
      writeFileSync(join(art, "findings-alpha.md"), complete(approaches("[a.ts:1] A — a")));
      writeFileSync(join(art, "findings-charlie.md"), complete(approaches("[a.ts:1] A — a")));
      expect(await diffExploreRun(["x"])).toBe(0);
      expect(await diffExploreRun(["x"])).toBe(1); // diff.md exists; rm to retry
    } finally { cleanup(); }
  });
});

describe("explore crossverify-send (scope + prompt composition)", () => {
  it("scopes the claims to PEER buckets only and renders the verify prompt", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      seed.crossverify(art, "alpha");
      expect(await crossverifySendWith("x", "alpha", "codex", sendDeps({ offsetFor: () => 7 }))).toBe(0);
      const claims = readFileSync(join(art, "crossverify-claims-alpha.txt"), "utf8");
      expect(claims).toBe("[paper:arxiv:9] CharlieOnly — solo\n"); // charlie's bucket, never alpha's own
      const prompt = readFileSync(join(art, "alpha_crossverify_prompt.md"), "utf8");
      expect(prompt).toContain("AGREE");
      expect(prompt).toContain(join(art, "crossverify-alpha.md"));
      expect(prompt).not.toContain("END_OF_INSTRUCTION");
    } finally { cleanup(); }
  });
  it("empty peer scope → VS=skipped with the claims file written empty, no send", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "alpha_only_items.txt"), "");
      writeFileSync(join(art, "charlie_only_items.txt"), "");
      const send = vi.fn(async () => 0);
      expect(await crossverifySendWith("x", "alpha", "codex", sendDeps({ send }))).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "crossverify-alpha.txt"), "utf8")).toBe("VS=skipped\n");
      expect(readFileSync(join(art, "crossverify-claims-alpha.txt"), "utf8")).toBe("");
    } finally { cleanup(); }
  });
  it("rc1 when a peer bucket is missing (run explore diff first)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      expect(await crossverifySendWith("x", "alpha", "codex", sendDeps())).toBe(1);
    } finally { cleanup(); }
  });
});

describe("explore rebuttal-send (target selection + prompt composition)", () => {
  it("zero attributed findings → RS=skipped, no send (charlie has none against it)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      seed.rebuttal(art, "alpha");
      const send = vi.fn(async () => 0);
      expect(await rebuttalSendWith("x", "charlie", "claude", sendDeps({ send }))).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "rebuttal-charlie.txt"), "utf8")).toBe("RS=skipped\n");
    } finally { cleanup(); }
  });
  it("an attributed needs-attention finding → prompt carries the claim + the critique", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      seed.rebuttal(art, "alpha");
      expect(await rebuttalSendWith("x", "alpha", "codex", sendDeps({ offsetFor: () => 5 }))).toBe(0);
      const prompt = readFileSync(join(art, "alpha_rebuttal_prompt.md"), "utf8");
      expect(prompt).toContain("[src/only-a.ts:1] AlphaOnly — solo");
      expect(prompt).toContain("### Finding 1: alpha's solo claim over-reaches");
      expect(prompt).toContain("CONCEDE");
      expect(prompt).toContain(join(art, "rebuttal-alpha.md"));
      expect(prompt).not.toContain("END_OF_INSTRUCTION");
    } finally { cleanup(); }
  });
});

describe("explore gap-send (trigger + prompt composition)", () => {
  it("trigger off (S1/S2 both true) → GS=skipped, no send", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      seed.gap(art, "alpha");
      writeFileSync(join(art, "adversary-skip.txt"), // no recorded S1/S2 failure: the round never fires
        "timestamp: t\nsignals_passed: S1=true S2=true S3=true S4=true S5=true\nuser_decision: not-offered\n");
      const send = vi.fn(async () => 0);
      expect(await gapSendWith("x", "alpha", "codex", sendDeps({ send }))).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "gap-alpha.txt"), "utf8")).toBe("GS=skipped\n");
    } finally { cleanup(); }
  });
  it("S2=false + safe worker + non-empty peer bucket → prompt rendered; skip.txt untouched", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      seed.gap(art, "alpha");
      const before = readFileSync(join(art, "adversary-skip.txt"), "utf8");
      expect(await gapSendWith("x", "alpha", "codex", sendDeps({ offsetFor: () => 3 }))).toBe(0);
      const prompt = readFileSync(join(art, "alpha_gap_prompt.md"), "utf8");
      expect(prompt).toContain("[paper:arxiv:9] CharlieOnly — solo");
      expect(prompt).toContain("CONFIRM");
      expect(prompt).toContain(join(art, "gap-alpha.md"));
      expect(readFileSync(join(art, "adversary-skip.txt"), "utf8")).toBe(before); // record never rewritten
    } finally { cleanup(); }
  });
});

describe("explore survivors", () => {
  const deps3 = () => initDeps({ activeProviders: () => ["codex", "claude", "agy"] }); // alpha, charlie, golf

  it("all rows non-empty → SURVIVORS=N, list.txt untouched, no list-original.txt", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), complete("a"));
      writeFileSync(join(art, "findings-charlie.md"), complete("c"));
      const before = readFileSync(join(art, "list.txt"), "utf8");
      const out = captureStdout();
      try { expect(await survivorsRun(["x"])).toBe(0); } finally { out.restore(); }
      expect(out.text().trim()).toBe("SURVIVORS=2");
      expect(readFileSync(join(art, "list.txt"), "utf8")).toBe(before);
      expect(existsSync(join(art, "list-original.txt"))).toBe(false);
    } finally { cleanup(); }
  });

  it("one empty findings at N=3 → list-original written, list.txt rewritten to 2 rows, DROPPED line", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], deps3());
      const art = exploreArtDir("x");
      const original = readFileSync(join(art, "list.txt"), "utf8");
      writeFileSync(join(art, "findings-alpha.md"), complete("a"));
      writeFileSync(join(art, "findings-charlie.md"), complete("c"));
      writeFileSync(join(art, "findings-golf.md"), "   \n\t\n"); // whitespace-only: same predicate as missingListArtifacts
      const out = captureStdout();
      try { expect(await survivorsRun(["x"])).toBe(0); } finally { out.restore(); }
      expect(out.text().trim().split("\n")).toEqual(["SURVIVORS=2", "DROPPED=golf"]);
      expect(readFileSync(join(art, "list-original.txt"), "utf8")).toBe(original);
      const rewritten = readFileSync(join(art, "list.txt"), "utf8");
      expect(rewritten).toContain("codex\talpha");
      expect(rewritten).toContain("claude\tcharlie");
      expect(rewritten).not.toContain("golf");
    } finally { cleanup(); }
  });

  it("crash re-run never overwrites list-original.txt", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], deps3());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), complete("a"));
      writeFileSync(join(art, "findings-charlie.md"), complete("c")); // golf missing
      writeFileSync(join(art, "list-original.txt"), "# SENTINEL preserved roster\ncodex\talpha\nclaude\tcharlie\nagy\tgolf\n");
      const out = captureStdout();
      try { expect(await survivorsRun(["x"])).toBe(0); } finally { out.restore(); }
      expect(readFileSync(join(art, "list-original.txt"), "utf8")).toContain("SENTINEL");
    } finally { cleanup(); }
  });

  it("N=2 with one empty → DEGRADED=1 as the last stdout line", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), complete("a")); // charlie missing
      const out = captureStdout();
      try { expect(await survivorsRun(["x"])).toBe(0); } finally { out.restore(); }
      expect(out.text().trim().split("\n")).toEqual(["SURVIVORS=1", "DROPPED=charlie", "DEGRADED=1"]);
      expect(readFileSync(join(art, "list.txt"), "utf8")).not.toContain("charlie");
    } finally { cleanup(); }
  });

  it("all findings empty → rc 1, nothing rewritten", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      const before = readFileSync(join(art, "list.txt"), "utf8");
      expect(await survivorsRun(["x"])).toBe(1);
      expect(readFileSync(join(art, "list.txt"), "utf8")).toBe(before);
      expect(existsSync(join(art, "list-original.txt"))).toBe(false);
    } finally { cleanup(); }
  });

  it("rc2 without a topic; rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try {
      expect(await survivorsRun([])).toBe(2);
      expect(await survivorsRun(["nope"])).toBe(1);
    } finally { cleanup(); }
  });

  it("post-rewrite pipeline: synth-preliminary, annotate, confidence pass over the survivor set", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], deps3());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"), complete("FlashAttention is fast. https://x.test/p . uncertain about batch."));
      writeFileSync(join(art, "findings-charlie.md"), complete("FlashAttention wins. https://x.test/p ."));
      // golf produced nothing — without survivors this blocks synth-preliminary with rc 1
      expect(await synthPreliminaryRun(["x"])).toBe(1);
      const out = captureStdout();
      try { expect(await survivorsRun(["x"])).toBe(0); } finally { out.restore(); }
      writeFileSync(join(art, "landscape-draft.md"), DRAFT);
      expect(await synthPreliminaryRun(["x"])).toBe(0);
      expect(await annotateRun(["x"])).toBe(0);
      expect(await confidenceRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
});

describe("explore signoff-send (final-doc reading + prompt composition)", () => {
  it("guard walks PAST consecutive skipped tags: GS=skipped + RS=skipped + AS=ok → proceeds", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      seed.signoff(art, "alpha");
      writeFileSync(join(art, "adversary-alpha.txt"), "OFFSET=0\nAS=ok\n");
      writeFileSync(join(art, "gap-alpha.txt"), "GS=skipped\n");
      writeFileSync(join(art, "rebuttal-alpha.txt"), "RS=skipped\n");
      const send = vi.fn(async () => 0);
      expect(await signoffSendWith("x", "alpha", "codex", sendDeps({ offsetFor: () => 2, send }))).toBe(0);
      expect(send).toHaveBeenCalled();
    } finally { cleanup(); }
  });
  it("prompt carries the Conclusion + solo bucket + Agreed text", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      seed.signoff(art, "alpha");
      expect(await signoffSendWith("x", "alpha", "codex", sendDeps({ offsetFor: () => 5 }))).toBe(0);
      const prompt = readFileSync(join(art, "alpha_signoff_prompt.md"), "utf8");
      expect(prompt).toContain("Adopt FlashAttention; caveats apply.");
      expect(prompt).toContain("- [src/only-a.ts:1] AlphaOnly — solo");
      expect(prompt).toContain("- [https://x.test/p] Shared — both");
      expect(prompt).toContain("VERDICT: fair | misrepresented");
      expect(prompt).toContain(join(art, "signoff-alpha.md"));
      expect(prompt).not.toContain("END_OF_INSTRUCTION");
    } finally { cleanup(); }
  });
  it("rc1 when the final landscape doc (or its Conclusion) is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      expect(await signoffSendWith("x", "alpha", "codex", sendDeps())).toBe(1);
    } finally { cleanup(); }
  });
  it("tolerates missing bucket/diff (degraded N=1): prompt still renders the Conclusion", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-2026-07-10-x.md"), "## Conclusion\nSingle-source survey.\n");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      const send = vi.fn(async () => 0);
      expect(await signoffSendWith("x", "alpha", "codex", sendDeps({ send }))).toBe(0);
      expect(send).toHaveBeenCalled();
      const prompt = readFileSync(join(art, "alpha_signoff_prompt.md"), "utf8");
      expect(prompt).toContain("Single-source survey.");
      expect(prompt).not.toContain("Your solo claims");
    } finally { cleanup(); }
  });
});

describe("explore contribution", () => {
  it("fully seeded N=2 art dir → exact TSV rows in file and stdout", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps()); // alpha(codex), charlie(claude)
      const art = exploreArtDir("x");
      writeFileSync(join(art, "findings-alpha.md"),
        "## Approaches\n1. [src/a.ts:10] Shared — both\n2. [src/only-a.ts:1] AlphaOnly — solo\n");
      writeFileSync(join(art, "findings-charlie.md"),
        "## Approaches\n1. [src/a.ts:10] Shared — both\n");
      writeFileSync(join(art, "alpha_only_items.txt"), "[src/only-a.ts:1] AlphaOnly — solo\n");
      writeFileSync(join(art, "charlie_only_items.txt"), "");
      writeFileSync(join(art, "crossverify-charlie.md"),
        "# Verify\n## Verdicts\n1. AGREE [src/only-a.ts:1] AlphaOnly — solo\n   checked\n");
      writeFileSync(join(art, "crossverify-alpha.md"), "");
      writeFileSync(join(art, "adversary-alpha.txt"), "OFFSET=0\nAS=ok\n");
      writeFileSync(join(art, "adversary-alpha.md"), "## Verdict\naccept\n");
      writeFileSync(join(art, "adversary-charlie.txt"), "AS=skipped\n");
      writeFileSync(join(art, "rebuttal-alpha.md"), "## Responses\n1. DEFEND holds\n");
      writeFileSync(join(art, "signoff-alpha.txt"), "OFFSET=0\nSS=ok\n");
      writeFileSync(join(art, "signoff-alpha.md"), "# Sign-off\nVERDICT: fair\n");
      const out = captureStdout();
      try { expect(await contributionRun(["x"])).toBe(0); } finally { out.restore(); }
      const expected = [
        "# agent\tprovider\tclaims_total\tclaims_solo\tclaims_consensus\tpeer_agree\tpeer_dispute\tpeer_uncertain\tadversary_verdict\trebuttal_defended\trebuttal_conceded\tsignoff",
        "alpha\tcodex\t2\t1\t1\t1\t0\t0\taccept\t1\t0\tfair",
        "charlie\tclaude\t1\t0\t1\t0\t0\t0\tskipped\t0\t0\tskipped",
      ].join("\n") + "\n";
      expect(readFileSync(join(art, "contribution.tsv"), "utf8")).toBe(expected);
      expect(out.text()).toBe(expected);
    } finally { cleanup(); }
  });
  it("with list-original.txt present the dropped worker appears as a zero row", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      // survivors dropped charlie: list.txt has alpha only, list-original preserves both
      writeFileSync(join(art, "list-original.txt"), readFileSync(join(art, "list.txt"), "utf8"));
      writeFileSync(join(art, "list.txt"), "# generated later by /ap:design\ncodex\talpha\n");
      writeFileSync(join(art, "findings-alpha.md"), "## Approaches\n1. [src/a.ts:1] A — solo\n");
      const out = captureStdout();
      try { expect(await contributionRun(["x"])).toBe(0); } finally { out.restore(); }
      const lines = readFileSync(join(art, "contribution.tsv"), "utf8").trimEnd().split("\n");
      expect(lines.length).toBe(3); // header + BOTH roster rows
      expect(lines[2]).toBe("charlie\tclaude\t0\t0\t0\t0\t0\t0\tskipped\t0\t0\tskipped");
    } finally { cleanup(); }
  });
  it("rc2 without a topic; rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try {
      expect(await contributionRun([])).toBe(2);
      expect(await contributionRun(["nope"])).toBe(1);
    } finally { cleanup(); }
  });
});

// Dated regression suites — kept as written, exact scenarios, not folded into the table above.
describe("wait-liveness guard-chain (VS gap, 2026-07-26 spec)", () => {
  it("adversary-send soft-skips (AS=skipped, no send) when crossverify ended VS=timeout", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      writeFileSync(join(art, "openq-alpha.txt"), "OFFSET=0\nQS=ok\n");
      writeFileSync(join(art, "crossverify-alpha.txt"), "OFFSET=0\nVS=timeout\n");
      markBusy("alpha", "codex", "x"); // an unsafe chain skips only while the worker is mid-turn
      const send = vi.fn(async () => 0);
      const rc = await adversarySendWith("x", "alpha", "codex", sendDeps({ send }));
      expect(rc).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toBe("AS=skipped\n");
    } finally { cleanup(); }
  });
  it("adversary-send proceeds when crossverify is VS=skipped (skipped never blocks)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      writeFileSync(join(art, "crossverify-alpha.txt"), "VS=skipped\n");
      const send = vi.fn(async () => 0);
      const rc = await adversarySendWith("x", "alpha", "codex", sendDeps({ offsetFor: () => 4, send }));
      expect(rc).toBe(0);
      expect(send).toHaveBeenCalled();
      expect(readFileSync(join(art, "adversary-alpha.txt"), "utf8")).toContain("OFFSET=4");
    } finally { cleanup(); }
  });
  it("gap-send soft-skips (GS=skipped, no send) when crossverify ended VS=timeout", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-skip.txt"), "signals_passed: S1=false S2=true S3=true S4=true S5=true\n");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      writeFileSync(join(art, "crossverify-alpha.txt"), "OFFSET=0\nVS=timeout\n");
      markBusy("alpha", "codex", "x");
      const send = vi.fn(async () => 0);
      const rc = await gapSendWith("x", "alpha", "codex", sendDeps({ send }));
      expect(rc).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "gap-alpha.txt"), "utf8")).toBe("GS=skipped\n");
    } finally { cleanup(); }
  });
  it("signoff-send soft-skips (SS=skipped, no send) when crossverify ended VS=timeout", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      writeFileSync(join(art, "crossverify-alpha.txt"), "OFFSET=0\nVS=timeout\n");
      markBusy("alpha", "codex", "x");
      const send = vi.fn(async () => 0);
      const rc = await signoffSendWith("x", "alpha", "codex", sendDeps({ send }));
      expect(rc).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "signoff-alpha.txt"), "utf8")).toBe("SS=skipped\n");
    } finally { cleanup(); }
  });
});

describe("rebuttal-send latest-phase walk (AS=skipped falls through to VS)", () => {
  it("soft-skips (RS=skipped, no send) when adversary was skipped over a VS=timeout crossverify", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\nFS=ok\n");
      writeFileSync(join(art, "crossverify-alpha.txt"), "OFFSET=0\nVS=timeout\n");
      writeFileSync(join(art, "adversary-alpha.txt"), "AS=skipped\n");
      markBusy("alpha", "codex", "x");
      const send = vi.fn(async () => 0);
      const rc = await rebuttalSendWith("x", "alpha", "codex", sendDeps({ offsetFor: () => 7, send }));
      expect(rc).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "rebuttal-alpha.txt"), "utf8")).toBe("RS=skipped\n");
    } finally { cleanup(); }
  });
  it("still soft-skips on a direct AS=timeout (pre-existing behavior preserved)", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = exploreArtDir("x");
      writeFileSync(join(art, "adversary-alpha.txt"), "OFFSET=0\nAS=timeout\n");
      markBusy("alpha", "codex", "x");
      const send = vi.fn(async () => 0);
      const rc = await rebuttalSendWith("x", "alpha", "codex", sendDeps({ send }));
      expect(rc).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(join(art, "rebuttal-alpha.txt"), "utf8")).toBe("RS=skipped\n");
    } finally { cleanup(); }
  });
});
