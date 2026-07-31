// tests/artifact-completeness.test.ts — the three artifact-completeness layers (2026-07-31 spec):
// the composers' contract block (L1), phaseWait's sentinel grace + the validators' backstop (L2),
// and dispatchPrompt's busy-gate (L3). The incident: a worker emitted `done` before its findings
// file was written, the hub read the half-written file, and the next phase-send rewrote the inbox
// of a worker still mid-turn.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { sendDeps, waitDeps } from "./helpers/phaseDeps.js";
import { END_OF_ARTIFACT, artifactGraceS, artifactComplete } from "../src/core/artifact.js";
import { exploreArtDir } from "../src/core/explore.js";
import { designArtDir } from "../src/core/design.js";
import { statusPath } from "../src/core/ipc.js";
import { workerDir } from "../src/core/paths.js";
import {
  researchSendWith, researchWaitWith, survivorsRun, synthPreliminaryRun, diffExploreRun, openqCollateRun,
  rebuttalSendWith, verdictTallyRun, synthFinalRun,
} from "../src/commands/explore.js";
import { anyPriorUnsafe } from "../src/core/phaseTable.js";
import { lastTag } from "../src/core/roster.js";
import {
  researchSendWith as designResearchSendWith, researchWaitWith as designResearchWaitWith, diffRun as designDiffRun,
  adjudicateRun,
} from "../src/commands/design.js";
import { composeExploreResearchPrompt, composeAdversaryPrompt, composeGapPrompt, composeSignoffPrompt, litGuidance, ADVERSARY_LENSES, researchLens } from "../src/core/exploreTurn.js";
import { composeOpenqPrompt } from "../src/core/exploreOpenq.js";
import { composeRebuttalPrompt } from "../src/core/exploreRebuttal.js";
import { composeResearchPrompt, composeVerifyPrompt } from "../src/core/designTurn.js";

const TOPIC = "x";
const complete = (body: string): string => `${body}\n${END_OF_ARTIFACT}\n`;

let h: { home: string; cleanup: () => void };
beforeEach(() => { h = freshHome(); });
afterEach(() => { h.cleanup(); delete process.env.AP_ARTIFACT_GRACE_S; });

/** _explore art dir with a two-row roster; returns the art dir. */
function seedExplore(rows: Array<{ provider: string; agent: string }>): string {
  const art = exploreArtDir(TOPIC);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "topic.txt"), "attention kernels");
  writeFileSync(join(art, "list.txt"), rows.map((r) => `${r.provider}\t${r.agent}`).join("\n") + "\n");
  return art;
}

/** Every forensics review-feed file written under this test's AP_HOME, concatenated. */
function flagFeed(): string {
  const root = join(h.home, "forensics");
  if (!existsSync(root)) return "";
  return readdirSync(root)
    .flatMap((date) => readdirSync(join(root, date)).map((f) => readFileSync(join(root, date, f), "utf8")))
    .join("\n");
}

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => { chunks.push(String(s)); return true; }) as never);
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

// ---- L2 primary: phaseWait's sentinel grace --------------------------------------------------

describe("phaseWait artifact grace", () => {
  const done = async (): Promise<any> => ({ event: "done", summary: "ok" });
  const findings = (): string => join(exploreArtDir(TOPIC), "findings-alpha.md");

  function seedWait(): string {
    const art = seedExplore([{ provider: "codex", agent: "alpha" }]);
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\n");
    return art;
  }

  it("sentinel already present at done → AC=sentinel + FS=ok, no polling, no flag", async () => {
    const art = seedWait();
    writeFileSync(findings(), complete("## Claims\n1. [a:1] x"));
    const sleep = vi.fn(async () => {});
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    // AC= (the wait's own verdict) leads; the phase key stays the file's LAST line.
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=0\nAC=sentinel\nFS=ok\n");
    expect(flagFeed()).toBe("");
  });

  it("sentinel appears mid-grace → the race is absorbed silently (FS=ok after the poll)", async () => {
    const art = seedWait();
    writeFileSync(findings(), "## Claims\n1. [a:1] x\n"); // done arrived first: file still being written
    let polls = 0;
    const sleep = async (): Promise<void> => { if (++polls === 2) writeFileSync(findings(), complete("## Claims\n1. [a:1] x")); };
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(polls).toBe(2); // returned as soon as the sentinel landed, not at grace expiry
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=ok");
    expect(flagFeed()).toBe("");
  });

  it("no sentinel but the file stopped growing → quiescence-accept (AC=quiescent) + the soft-compliance flag", async () => {
    const art = seedWait();
    writeFileSync(findings(), "## Claims\n1. [a:1] finished but unsentinelled");
    process.env.AP_ARTIFACT_GRACE_S = "20"; // far more grace than quiescence needs
    const sleep = vi.fn(async () => {});
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(5); // ~10s: five consecutive equal-size polls, then accept
    // Classified by the row's stateFn exactly as a sentinel-accept would be — never destroyed.
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=0\nAC=quiescent\nFS=ok\n");
    expect(flagFeed()).toContain(`artifact-quiescent-no-sentinel: alpha ${findings()}`);
    expect(flagFeed()).not.toContain("artifact-incomplete");
  });

  it("still growing at the grace cap → AC=expired, the row's NATURAL key, .done marker, forensics flag", async () => {
    const art = seedWait();
    writeFileSync(findings(), "## Claims\n1. [a:1] half-writ");
    process.env.AP_ARTIFACT_GRACE_S = "10"; // 5 polls at the 2s cadence (the quiescence floor)
    const sleep = vi.fn(async () => { appendFileSync(findings(), " more"); }); // never quiesces
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(5);
    // FS is what the stateFn says about the CONTENT (a cited claim → ok); the drop decision rides
    // on AC=expired alone. Forcing FS=timeout here is what cascade-skipped every later phase.
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=0\nAC=expired\nFS=ok\n");
    expect(existsSync(join(art, "research-alpha.done"))).toBe(true); // the gate still sees a terminal worker
    expect(flagFeed()).toContain(`artifact-incomplete: alpha ${findings()} done-event without ${END_OF_ARTIFACT} after 10s grace`);
  });

  it("an EMPTY artifact never quiesces → AC=expired even though its size is stable", async () => {
    const art = seedWait();
    writeFileSync(findings(), "");
    process.env.AP_ARTIFACT_GRACE_S = "10";
    const sleep = vi.fn(async () => {});
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(5); // polled to the cap, never accepted
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=0\nAC=expired\nFS=empty\n");
    expect(flagFeed()).toContain(`artifact-incomplete: alpha ${findings()}`);
  });

  it("re-running the wait after an expiry RESCUES the artifact (the documented recovery)", async () => {
    const art = seedWait();
    writeFileSync(findings(), "## Claims\n1. [a:1] slow");
    process.env.AP_ARTIFACT_GRACE_S = "10";
    const growing = async (): Promise<void> => { appendFileSync(findings(), " more"); };
    await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep: growing }));
    expect(lastTag(readFileSync(join(art, "research-alpha.txt"), "utf8"), "AC")).toBe("expired");
    // The worker finished writing after the cap; the same wait, re-run, resumes from the recorded
    // OFFSET, re-reads the same done event and appends a fresh verdict (latest-line-wins).
    await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep: async () => {} }));
    expect(lastTag(readFileSync(join(art, "research-alpha.txt"), "utf8"), "AC")).toBe("quiescent");
  });

  it("expiry does NOT cascade-skip the later phases (the F3 regression)", async () => {
    // One optional artifact that expired must not end the worker's run: the guards read the phase
    // KEY, and the key now keeps its natural classification. openq's guard consults FS.
    const art = seedWait();
    writeFileSync(findings(), "## Claims\n1. [a:1] slow but cited");
    process.env.AP_ARTIFACT_GRACE_S = "10";
    const sleep = async (): Promise<void> => { appendFileSync(findings(), " more"); };
    await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }));
    expect(anyPriorUnsafe(art, "alpha", ["FS"])).toBeNull(); // pre-fix: "FS=timeout" → every later phase skipped
  });

  it("non-done terminal events bypass the check entirely (error → FS=failed, question → FS=question), writing NO AC=", async () => {
    const art = seedWait();
    writeFileSync(findings(), "half-writ"); // no sentinel either way
    const sleep = vi.fn(async () => {});
    await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: async () => ({ event: "error" } as any), sleep }));
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=0\nFS=failed\n"); // no AC: nothing was accepted

    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\n");
    await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: async () => ({ event: "question", message: "which?" } as any), sleep }));
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=question");
    expect(sleep).not.toHaveBeenCalled();
    expect(flagFeed()).toBe("");
  });

  it("AP_ARTIFACT_GRACE_S=0 disables the check ENTIRELY — the stateFn classifies, AC=unchecked", async () => {
    const art = seedWait();
    writeFileSync(findings(), ""); // empty, no sentinel
    process.env.AP_ARTIFACT_GRACE_S = "0";
    const sleep = vi.fn(async () => {});
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    // `unchecked` also switches the validators' backstop off: 0 must disable BOTH depths, or the
    // escape hatch would trade a hang in the wait for a refusal loop in every validator.
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=0\nAC=unchecked\nFS=empty\n");
    expect(flagFeed()).toBe("");
  });

  it("design rows share the same grace (one design-side pin)", async () => {
    const art = designArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\n");
    mkdirSync(workerDir("alpha", "codex", TOPIC), { recursive: true });
    const f = join(workerDir("alpha", "codex", TOPIC), "findings.md");
    writeFileSync(f, "## Claims\n1. [a:1] half-writ");
    process.env.AP_ARTIFACT_GRACE_S = "10";
    const sleep = async (): Promise<void> => { appendFileSync(f, " more"); }; // still growing at the cap
    expect(await designResearchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("AC=expired");
    expect(flagFeed()).toContain("artifact-incomplete: alpha");
  });
});

describe("artifactGraceS / artifactComplete", () => {
  it("default 60s; clamped to the quiescence floor..300; 0 honoured; junk falls back", () => {
    delete process.env.AP_ARTIFACT_GRACE_S;
    expect(artifactGraceS()).toBe(60);
    // A positive value BELOW the 10s quiescence floor is raised to it, never honoured: under the
    // floor the only reachable outcome is `expired`, so a "shorter grace" would silently mean
    // "destroy every finished-but-unsentinelled artifact". 0 still disables outright.
    for (const [raw, want] of [["5", 10], ["10", 10], ["30", 30], ["0", 0], ["999", 300], ["-3", 0], ["abc", 60], ["", 60]] as const) {
      process.env.AP_ARTIFACT_GRACE_S = raw;
      expect(artifactGraceS()).toBe(want);
    }
  });

  it("the LAST non-empty line must EQUAL the sentinel; trailing whitespace/newlines tolerated", () => {
    const p = join(h.home, "a.md");
    writeFileSync(p, `body\n${END_OF_ARTIFACT}\n\n  \n`);
    expect(artifactComplete(p)).toBe(true);
    writeFileSync(p, `body\n${END_OF_ARTIFACT}\nmore prose\n`);
    expect(artifactComplete(p)).toBe(false);
    expect(artifactComplete(join(h.home, "nope.md"))).toBe(false); // absent is never complete
  });

  it("an echoed contract line does NOT satisfy the sentinel (equality, not endsWith)", () => {
    const p = join(h.home, "b.md");
    // The worker pasted the contract block's own wording as its last line. `endsWith` said complete.
    writeFileSync(p, `## Approaches\n1. [a:1] x\n  2. Make the LAST line of that file the literal sentinel: ${END_OF_ARTIFACT}\n`);
    expect(artifactComplete(p)).toBe(false);
    writeFileSync(p, `## Approaches\n1. [a:1] x\n   ${END_OF_ARTIFACT}   \n`); // padded, but the whole line
    expect(artifactComplete(p)).toBe(true);
  });

  it("a sentinel-only artifact is content-free, not complete", () => {
    const p = join(h.home, "c.md");
    writeFileSync(p, `${END_OF_ARTIFACT}\n`);
    expect(artifactComplete(p)).toBe(false);
    writeFileSync(p, `\n  \n${END_OF_ARTIFACT}\n`); // whitespace is not content either
    expect(artifactComplete(p)).toBe(false);
  });
});

// ---- L3: dispatchPrompt's busy-gate ----------------------------------------------------------

describe("dispatchPrompt busy-gate", () => {
  it("busy worker → rc 3, nothing written, no send, exact stderr", async () => {
    const art = seedExplore([{ provider: "codex", agent: "alpha" }]);
    const send = vi.fn(async () => 0);
    const err = captureStderr();
    let rc: number;
    try {
      rc = await researchSendWith(TOPIC, "alpha", "codex", sendDeps({ send, busyState: () => "working" }));
    } finally { err.restore(); }
    expect(rc).toBe(3); // distinct from rc 1 (state file exists / send failed) and rc 2 (usage)
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(join(art, "research-alpha.txt"))).toBe(false); // no OFFSET → the phase stays runnable
    expect(err.text()).toContain(
      `explore research-send: worker alpha busy (state=working) — not sending; re-run wait-gate and retry (status: ${statusPath("alpha", "codex", TOPIC)})`,
    );
  });

  it("idle worker → dispatch unchanged", async () => {
    const art = seedExplore([{ provider: "codex", agent: "alpha" }]);
    const send = vi.fn(async () => 0);
    expect(await researchSendWith(TOPIC, "alpha", "codex", sendDeps({ offsetFor: () => 4, send, busyState: () => null }))).toBe(0);
    expect(send).toHaveBeenCalled();
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=4\n");
  });

  it("absent status.json reads as idle through the live default (no dep override)", async () => {
    const art = seedExplore([{ provider: "codex", agent: "alpha" }]);
    const send = vi.fn(async () => 0);
    expect(existsSync(statusPath("alpha", "codex", TOPIC))).toBe(false);
    expect(await researchSendWith(TOPIC, "alpha", "codex", { offsetFor: () => 1, send })).toBe(0);
    expect(send).toHaveBeenCalled();
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=1\n");
  });

  it("unreadable/state-less status.json reads as idle", async () => {
    seedExplore([{ provider: "codex", agent: "alpha" }]);
    mkdirSync(workerDir("alpha", "codex", TOPIC), { recursive: true });
    writeFileSync(statusPath("alpha", "codex", TOPIC), "not json at all");
    const send = vi.fn(async () => 0);
    expect(await researchSendWith(TOPIC, "alpha", "codex", { offsetFor: () => 0, send })).toBe(0);
    expect(send).toHaveBeenCalled();
  });

  it("TERMINAL states are not busy: done/ready/complete/error/blank all dispatch", async () => {
    // The identity template mandates `idle` after a terminal event but lets a worker write any
    // state string, and real workers echo their last event. Refusing those refused idle workers.
    seedExplore([{ provider: "codex", agent: "alpha" }]);
    mkdirSync(workerDir("alpha", "codex", TOPIC), { recursive: true });
    const art = exploreArtDir(TOPIC);
    for (const state of ["done", "ready", "complete", "error", "DONE", "  idle  ", "", "   "]) {
      rmSync(join(art, "research-alpha.txt"), { force: true });
      writeFileSync(statusPath("alpha", "codex", TOPIC), `{"state":"${state}","updated":"t"}`);
      const send = vi.fn(async () => 0);
      expect(await researchSendWith(TOPIC, "alpha", "codex", { offsetFor: () => 0, send })).toBe(0);
      expect(send).toHaveBeenCalled();
    }
    // Anything not in the terminal set stays busy — an unknown state is never assumed safe.
    rmSync(join(art, "research-alpha.txt"), { force: true });
    writeFileSync(statusPath("alpha", "codex", TOPIC), '{"state":"synthesising","updated":"t"}');
    const send = vi.fn(async () => 0);
    const err = captureStderr();
    try { expect(await researchSendWith(TOPIC, "alpha", "codex", { offsetFor: () => 0, send })).toBe(3); } finally { err.restore(); }
    expect(send).not.toHaveBeenCalled();
  });

  it("PRETTY-PRINTED status.json reads as busy — the spaced-JSON hole (rc 3)", async () => {
    const art = seedExplore([{ provider: "codex", agent: "alpha" }]);
    mkdirSync(workerDir("alpha", "codex", TOPIC), { recursive: true });
    writeFileSync(statusPath("alpha", "codex", TOPIC), '{\n  "state" : "working",\n  "last_event": "progress"\n}\n');
    const send = vi.fn(async () => 0);
    const err = captureStderr();
    let rc: number;
    try { rc = await researchSendWith(TOPIC, "alpha", "codex", { offsetFor: () => 0, send }); } finally { err.restore(); }
    expect(rc).toBe(3);
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(join(art, "research-alpha.txt"))).toBe(false);
    expect(err.text()).toContain("worker alpha busy (state=working)");
  });

  it("design's sends inherit the gate by construction", async () => {
    const art = designArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "topic.txt"), "cache policy");
    writeFileSync(join(art, "list.txt"), "codex\talpha\n");
    const send = vi.fn(async () => 0);
    const err = captureStderr();
    let rc: number;
    try {
      rc = await designResearchSendWith(TOPIC, "alpha", "codex", sendDeps({ send, busyState: () => "round-1" }));
    } finally { err.restore(); }
    expect(rc).toBe(3);
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(join(art, "research-alpha.txt"))).toBe(false);
    expect(err.text()).toContain("design research-send: worker alpha busy (state=round-1)");
  });
});

// ---- L2 backstop: the validators -------------------------------------------------------------

describe("validators: sentinel backstop", () => {
  /** alpha's strike log for its findings — per agent+ARTIFACT since 2026-07-31. */
  const strike = (art: string, agent = "alpha", file = `findings-${agent}.md`): string =>
    join(art, `stillwriting-${agent}-${file}.txt`);

  /** alpha's findings without the sentinel + charlie's complete. `tag` is alpha's FS= value, `ac`
   *  its AC= (the wait's own verdict) — the two are independent, which is the whole point. */
  function seedFindings(
    tag: string | null, alphaBody = "## Claims\n1. [a:1] half-writ", ac: string | null = null,
  ): string {
    const art = seedExplore([{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }]);
    writeFileSync(join(art, "findings-alpha.md"), alphaBody);
    writeFileSync(join(art, "findings-charlie.md"), complete("## Claims\n1. [c:1] y"));
    writeFileSync(join(art, "research-charlie.txt"), "OFFSET=0\nAC=sentinel\nFS=ok\n");
    if (tag !== null || ac !== null) {
      writeFileSync(join(art, "research-alpha.txt"),
        `OFFSET=0\n${ac !== null ? `AC=${ac}\n` : ""}${tag !== null ? `FS=${tag}\n` : ""}`);
    }
    return art;
  }

  it("survivors: HEALTHY explore findings (FS=empty, no sentinel) SURVIVE — the F1 regression", async () => {
    // The bug this whole PR exists for. explore's research prompt asks for `## Approaches`, but
    // findingsStatus counts claims under `## Claims`, so a perfectly good explore findings file
    // classifies FS=empty — and explore.md itself says "do NOT gate on FS=ok". The first backstop
    // accepted only on tag `ok`, so every healthy explore worker that skipped the soft sentinel
    // line was refused three times and then destroyed as empty. AC= is what accepts it now.
    const findings = [
      "# Findings: attention kernels",
      "## Summary",
      "Three kernel families dominate; FlashAttention-3 leads on H100.",
      "## Approaches",
      "1. [https://arxiv.org/abs/2407.08608] FlashAttention-3 — warp-specialised, FP8 path",
      "2. [src/kernels/triton_attn.py:112] Triton fused attention — portable, ~15% slower",
      "## SOTA evidence",
      "- [https://arxiv.org/abs/2407.08608] 1.5-2.0x over FA-2 on H100",
      "## Tradeoffs",
      "- FA-3 wins on throughput because of async copy overlap [https://arxiv.org/abs/2407.08608]",
      "## Independent Discovery",
      "- [https://github.com/Dao-AILab/flash-attention] upstream kernel matrix",
      "## Open questions",
      "- Does the FP8 path hold accuracy at long context?",
      "## Notes",
      "None.",
    ].join("\n");
    const art = seedFindings("empty", findings, "quiescent"); // the wait accepted it; the CONTENT is `empty`
    const out = captureStdout();
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); err.restore(); }
    expect(rc).toBe(0);
    expect(out.text().trim()).toBe("SURVIVORS=2");
    expect(err.text()).not.toContain("STILL_WRITING");
    expect(existsSync(strike(art))).toBe(false);
    expect(readFileSync(join(art, "list.txt"), "utf8")).toContain("alpha"); // never dropped
  });

  it("survivors: a SLOW writer the wait accepted at validation time is not re-judged (AC=sentinel wins)", async () => {
    // The worker wrote its file long after `done`; the wait waited it out and accepted. By the time
    // the validator runs the file may still lack the soft line — the wait's verdict stands.
    const art = seedFindings("malformed", "## Claims\n1. no citation here", "sentinel");
    const out = captureStdout();
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); err.restore(); }
    expect(rc).toBe(0);
    expect(out.text().trim()).toBe("SURVIVORS=2");
    expect(err.text()).not.toContain("STILL_WRITING");
    expect(existsSync(strike(art))).toBe(false);
  });

  it("survivors: AC=quiescent + no sentinel → ACCEPTED (never destroy work the wait accepted)", async () => {
    const art = seedFindings("ok", "## Claims\n1. [a:1] half-writ", "quiescent");
    const out = captureStdout();
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); err.restore(); }
    expect(rc).toBe(0);
    expect(out.text().trim()).toBe("SURVIVORS=2");
    expect(err.text()).not.toContain("STILL_WRITING");
    expect(existsSync(strike(art))).toBe(false);
  });

  it("survivors: FS=ok WITHOUT an AC= line still refuses — the tag is not the wait's verdict", async () => {
    const art = seedFindings("ok");
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha\n");
    expect(existsSync(strike(art))).toBe(true);
  });

  it("survivors: an UNSET tag (the gate-skipping hub) refuses — rc 1, STILL_WRITING, strike recorded", async () => {
    const art = seedFindings(null);
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha\n");
    expect(err.text()).not.toContain("STILL_WRITING=charlie");
    expect(readFileSync(strike(art), "utf8")).toBe("alpha 28\n");
    expect(readFileSync(join(art, "list.txt"), "utf8")).toContain("alpha"); // nothing rewritten
  });

  it("survivors: an accepted verdict clears the strike file", async () => {
    const art = seedFindings(null);
    const err = captureStderr();
    try { expect(await survivorsRun([TOPIC])).toBe(1); } finally { err.restore(); }
    expect(existsSync(strike(art))).toBe(true);
    writeFileSync(join(art, "findings-alpha.md"), complete("## Claims\n1. [a:1] x")); // the worker finished
    const out = captureStdout();
    try { expect(await survivorsRun([TOPIC])).toBe(0); } finally { out.restore(); }
    expect(existsSync(strike(art))).toBe(false); // no strikes carried forward
  });

  it("survivors: strikes are per ARTIFACT — one agent's two files never share a counter", async () => {
    const art = seedFindings(null);
    const err = captureStderr();
    try {
      expect(await survivorsRun([TOPIC])).toBe(1);
      expect(await survivorsRun([TOPIC])).toBe(1); // findings: 2 strikes, one refusal short of the drop
    } finally { err.restore(); }
    expect(readFileSync(strike(art), "utf8").trim().split("\n").length).toBe(2);
    // A DIFFERENT artifact of the same agent starts at zero: adversary work carries no findings debt.
    expect(existsSync(strike(art, "alpha", "adversary-alpha.md"))).toBe(false);
    writeFileSync(join(art, "adversary-alpha.md"), "## Verdict\nhalf-writ");
    writeFileSync(join(art, "adversary-alpha.txt"), "OFFSET=0\nAS=ok\n");
    const err2 = captureStderr();
    try { expect(await verdictTallyRun([TOPIC])).toBe(1); } finally { err2.restore(); }
    expect(readFileSync(strike(art, "alpha", "adversary-alpha.md"), "utf8").trim().split("\n").length).toBe(1);
    expect(readFileSync(strike(art), "utf8").trim().split("\n").length).toBe(2); // untouched
  });

  it("survivors: AC=expired + no sentinel → dropped as empty (the existing N-1 path)", async () => {
    const art = seedFindings("ok", "## Claims\n1. [a:1] half-writ", "expired");
    const out = captureStdout();
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); err.restore(); }
    expect(rc).toBe(0);
    expect(out.text().trim().split("\n")).toEqual(["SURVIVORS=1", "DROPPED=alpha", "DEGRADED=1"]);
    expect(err.text()).not.toContain("STILL_WRITING");
    expect(readFileSync(join(art, "list.txt"), "utf8")).not.toContain("alpha");
  });

  it("survivors: a dead worker (FS=timeout, empty artifact, no AC) still drops via missing-or-empty", async () => {
    // `timeout` alone no longer means drop — but the wait that timed out with no event leaves an
    // empty or absent artifact, and the pre-existing missing-or-empty machinery takes it as before.
    const art = seedFindings("timeout", "   \n");
    const out = captureStdout();
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); err.restore(); }
    expect(rc).toBe(0);
    expect(out.text().trim().split("\n")).toEqual(["SURVIVORS=1", "DROPPED=alpha", "DEGRADED=1"]);
    expect(err.text()).not.toContain("STILL_WRITING"); // the backstop never even ran
    expect(existsSync(strike(art))).toBe(false);
  });

  it("survivors: FS=failed (an error event) drops without a retry loop", async () => {
    const art = seedFindings("failed");
    const out = captureStdout();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); }
    expect(rc).toBe(0);
    expect(out.text()).toContain("DROPPED=alpha");
    expect(existsSync(strike(art))).toBe(false);
  });

  it("survivors: both artifacts complete → unchanged pass-through", async () => {
    const art = seedFindings("ok", complete("## Claims\n1. [a:1] x"));
    const out = captureStdout();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); }
    expect(rc).toBe(0);
    expect(out.text().trim()).toBe("SURVIVORS=2");
    expect(existsSync(strike(art))).toBe(false);
  });

  it("survivors: 3rd refusal with NO growth degrades to the drop path + a forensics flag", async () => {
    const art = seedFindings(null);
    const err = captureStderr();
    try {
      expect(await survivorsRun([TOPIC])).toBe(1);
      expect(await survivorsRun([TOPIC])).toBe(1);
    } finally { err.restore(); }
    const out = captureStdout();
    try { expect(await survivorsRun([TOPIC])).toBe(0); } finally { out.restore(); }
    expect(out.text()).toContain("DROPPED=alpha");
    expect(readFileSync(strike(art), "utf8").trim().split("\n").length).toBe(3);
    expect(flagFeed()).toContain("artifact-incomplete: alpha");
    expect(flagFeed()).toContain("dropped as empty after 3 refusals with no growth");
  });

  it("survivors: a re-dispatch of the phase clears the strikes (the rm-to-retry contract)", async () => {
    const art = seedFindings(null);
    const err = captureStderr();
    try {
      expect(await survivorsRun([TOPIC])).toBe(1);
      expect(await survivorsRun([TOPIC])).toBe(1); // 2 strikes: the next refusal would destroy it
    } finally { err.restore(); }
    expect(existsSync(strike(art))).toBe(true);
    rmSync(join(art, "research-alpha.txt"), { force: true });     // the documented rm-to-retry
    expect(await researchSendWith(TOPIC, "alpha", "codex", sendDeps())).toBe(0);
    expect(existsSync(strike(art))).toBe(false);                  // freshly dispatched work owes nothing
  });

  it("survivors: file GROWTH between refusals resets the strike counter", async () => {
    const art = seedFindings(null);
    const err = captureStderr();
    try {
      expect(await survivorsRun([TOPIC])).toBe(1);
      writeFileSync(join(art, "findings-alpha.md"), "## Claims\n1. [a:1] half-writ and then some more"); // progress
      expect(await survivorsRun([TOPIC])).toBe(1);
      expect(await survivorsRun([TOPIC])).toBe(1); // would have degraded without the reset
    } finally { err.restore(); }
    // The log is append-only (the absolute cap reads it); it is the STREAK that reset, not the file.
    expect(readFileSync(strike(art), "utf8").trim().split("\n").length).toBe(3);
    expect(flagFeed()).toBe("");
  });

  it("survivors: a SHRINK or an oscillation is not growth — the 3-strike bound still bites", async () => {
    const art = seedFindings(null);
    const body = (n: number): string => "## Claims\n1. [a:1] " + "x".repeat(n);
    const err = captureStderr();
    try {
      expect(await survivorsRun([TOPIC])).toBe(1);             // 28 bytes
      writeFileSync(join(art, "findings-alpha.md"), body(40)); // grew → streak resets
      expect(await survivorsRun([TOPIC])).toBe(1);
      writeFileSync(join(art, "findings-alpha.md"), body(10)); // SHRANK → not progress
      expect(await survivorsRun([TOPIC])).toBe(1);
      writeFileSync(join(art, "findings-alpha.md"), body(40)); // back up, but not above the max → oscillation
    } finally { err.restore(); }
    const out = captureStdout();
    try { expect(await survivorsRun([TOPIC])).toBe(0); } finally { out.restore(); }
    expect(out.text()).toContain("DROPPED=alpha");
    expect(flagFeed()).toContain("dropped as empty after 3 refusals with no growth");
  });

  it("survivors: the 6-refusal cap degrades even when the file grows every time", async () => {
    const art = seedFindings(null);
    const err = captureStderr();
    try {
      for (let i = 1; i <= 5; i++) {
        expect(await survivorsRun([TOPIC])).toBe(1);
        writeFileSync(join(art, "findings-alpha.md"), "## Claims\n1. [a:1] " + "x".repeat(10 * i)); // real growth every round
      }
    } finally { err.restore(); }
    const out = captureStdout();
    try { expect(await survivorsRun([TOPIC])).toBe(0); } finally { out.restore(); } // the 6th refusal caps out
    expect(out.text()).toContain("DROPPED=alpha");
    expect(flagFeed()).toContain("dropped as empty after 6 refusals (cap 6)");
  });

  it("synth-preliminary: unset tag + no sentinel → rc 1 STILL_WRITING; AC=expired → blocked as empty", async () => {
    seedFindings(null);
    const err = captureStderr();
    let rc: number;
    try { rc = await synthPreliminaryRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");

    const err2 = captureStderr();
    let rc2: number;
    try {
      seedFindings("ok", "## Claims\n1. [a:1] half-writ", "expired");
      rc2 = await synthPreliminaryRun([TOPIC]);
    } finally { err2.restore(); }
    expect(rc2).toBe(1);
    expect(err2.text()).not.toContain("STILL_WRITING");
    expect(err2.text()).toContain("missing or empty findings");
  });

  it("synth-preliminary: complete artifacts pass", async () => {
    seedFindings("ok", complete("## Claims\n1. [a:1] x"));
    const out = captureStdout();
    let rc: number;
    try { rc = await synthPreliminaryRun([TOPIC]); } finally { out.restore(); }
    expect(rc).toBe(0);
    expect(out.text()).toContain("landscape-draft.md");
  });

  it("design diff: still-writing refuses; AC=expired diffs the worker as empty; AC=quiescent diffs as-is", async () => {
    const seedDesign = (ac: string | null): string => {
      const art = designArtDir(TOPIC);
      mkdirSync(art, { recursive: true });
      writeFileSync(join(art, "list.txt"), "codex\talpha\nclaude\tcharlie\n");
      if (ac !== null) writeFileSync(join(art, `research-alpha.txt`), `OFFSET=0\nAC=${ac}\nFS=ok\n`);
      for (const [agent, provider, body] of [["alpha", "codex", "## Claims\n1. [a:1] half-writ"], ["charlie", "claude", complete("## Claims\n1. [c:1] y")]] as const) {
        mkdirSync(workerDir(agent, provider, TOPIC), { recursive: true });
        writeFileSync(join(workerDir(agent, provider, TOPIC), "findings.md"), body);
      }
      return art;
    };
    let art = seedDesign(null); // the gate-skipping hub: the wait never ran, so there is no AC=
    const err = captureStderr();
    let rc: number;
    try { rc = await designDiffRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");
    expect(existsSync(join(art, "diff.md"))).toBe(false);

    h.cleanup(); h = freshHome();
    art = seedDesign("expired");
    expect(await designDiffRun([TOPIC])).toBe(0);
    expect(readFileSync(join(art, "alpha_only_items.txt"), "utf8").trim()).toBe(""); // contributed nothing
    expect(readFileSync(join(art, "charlie_only_items.txt"), "utf8")).toContain("[c:1] y");

    h.cleanup(); h = freshHome();
    art = seedDesign("quiescent"); // accepted by the wait → diffed as-is, sentinel or not
    expect(await designDiffRun([TOPIC])).toBe(0);
    expect(readFileSync(join(art, "alpha_only_items.txt"), "utf8")).toContain("[a:1] half-writ");
  });

  it("explore diff: no AC refuses; AC=expired buckets that worker as empty; AC=quiescent buckets it in", async () => {
    const seedDiff = (ac: string | null): string => {
      const art = seedExplore([{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }]);
      writeFileSync(join(art, "findings-alpha.md"), "## Approaches\n1. [a.ts:1] AlphaOnly — solo\n");
      writeFileSync(join(art, "findings-charlie.md"), complete("## Approaches\n1. [c.ts:2] CharlieOnly — solo"));
      // FS=empty is what a HEALTHY explore findings file classifies as — the F1 bug in one line.
      if (ac !== null) writeFileSync(join(art, "research-alpha.txt"), `OFFSET=0\nAC=${ac}\nFS=empty\n`);
      return art;
    };
    let art = seedDiff(null);
    const err = captureStderr();
    let rc: number;
    try { rc = await diffExploreRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");
    expect(existsSync(join(art, "diff.md"))).toBe(false);

    h.cleanup(); h = freshHome();
    art = seedDiff("expired");
    expect(await diffExploreRun([TOPIC])).toBe(0);
    expect(readFileSync(join(art, "alpha_only_items.txt"), "utf8").trim()).toBe("");
    expect(readFileSync(join(art, "charlie_only_items.txt"), "utf8")).toContain("CharlieOnly");

    h.cleanup(); h = freshHome();
    art = seedDiff("quiescent"); // healthy FS=empty findings the wait accepted → bucketed, not dropped
    expect(await diffExploreRun([TOPIC])).toBe(0);
    expect(readFileSync(join(art, "alpha_only_items.txt"), "utf8")).toContain("AlphaOnly");
  });

  it("openq-collate: no AC refuses; AC=expired routes none of that worker's questions", async () => {
    const seedQs = (ac: string | null): string => {
      const art = seedExplore([{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }]);
      writeFileSync(join(art, "findings-alpha.md"), "## Open questions\n- qa1\n");
      writeFileSync(join(art, "findings-charlie.md"), complete("## Open questions\n- qc1"));
      if (ac !== null) writeFileSync(join(art, "research-alpha.txt"), `OFFSET=0\nAC=${ac}\nFS=empty\n`);
      return art;
    };
    let art = seedQs(null);
    const err = captureStderr();
    let rc: number;
    try { rc = await openqCollateRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");
    expect(existsSync(join(art, "open-questions.md"))).toBe(false);

    h.cleanup(); h = freshHome();
    art = seedQs("expired");
    const out = captureStdout();
    try { expect(await openqCollateRun([TOPIC])).toBe(0); } finally { out.restore(); }
    expect(existsSync(join(art, "openq-claims-alpha.txt"))).toBe(true);   // still receives charlie's
    expect(existsSync(join(art, "openq-claims-charlie.txt"))).toBe(false); // alpha contributed none
  });

  it("design adjudicate: a still-writing verify.md refuses; VS=skipped (no file) is untouched", async () => {
    const art = designArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "list.txt"), "codex\talpha\nclaude\tcharlie\n");
    writeFileSync(join(art, "alpha_only_items.txt"), "[a:1] alpha claim\n");
    writeFileSync(join(art, "charlie_only_items.txt"), "[b:2] charlie claim\n");
    for (const [agent, provider] of [["alpha", "codex"], ["charlie", "claude"]] as const) {
      mkdirSync(workerDir(agent, provider, TOPIC), { recursive: true });
    }
    // alpha: verify.md present, no sentinel, and the wait never classified it (no verify-alpha.txt).
    writeFileSync(join(workerDir("alpha", "codex", TOPIC), "verify.md"), "## Verdicts\n1. AGREE [b:2] charlie claim");
    const err = captureStderr();
    let rc: number;
    try { rc = await adjudicateRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");
    expect(existsSync(join(art, "adjudicated-draft.md"))).toBe(false);

    // With the wait's AC= verdict written, the same file adjudicates; charlie's absent verify.md is
    // the pre-existing VS=skipped path and never reaches the backstop.
    writeFileSync(join(art, "verify-alpha.txt"), "OFFSET=0\nAC=quiescent\nVS=ok\n");
    expect(await adjudicateRun([TOPIC])).toBe(0);
    expect(existsSync(join(art, "adjudicated-draft.md"))).toBe(true);
  });

  // ---- the adversary-artifact consumers (F10) --------------------------------------------------

  /** Two-worker explore art dir with alpha's critique unsentinelled; `ac` is alpha's AC= verdict. */
  function seedAdversary(ac: string | null, body = "## Verdict\nneeds-attention\n## Material findings\n### Finding 1: charlie over-reaches\n- **Targets:** src/only-c.ts:1 in the draft"): string {
    const art = seedExplore([{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }]);
    writeFileSync(join(art, "landscape-draft.md"), "d");
    writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
    writeFileSync(join(art, "adversary-alpha.md"), body);
    writeFileSync(join(art, "adversary-alpha.txt"), `OFFSET=0\n${ac !== null ? `AC=${ac}\n` : ""}AS=ok\n`);
    writeFileSync(join(art, "adversary-charlie.md"), complete("## Verdict\naccept"));
    writeFileSync(join(art, "adversary-charlie.txt"), "OFFSET=0\nAC=sentinel\nAS=ok\n");
    writeFileSync(join(art, "alpha_only_items.txt"), "");
    writeFileSync(join(art, "charlie_only_items.txt"), "[src/only-c.ts:1] CharlieOnly — solo\n");
    return art;
  }

  it("verdict-tally: a still-writing critique refuses (rc 1); AC=expired tallies as unavailable", async () => {
    seedAdversary(null);
    const err = captureStderr();
    let rc: number;
    try { rc = await verdictTallyRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");

    h.cleanup(); h = freshHome();
    seedAdversary("expired");
    const out = captureStdout();
    try { expect(await verdictTallyRun([TOPIC])).toBe(0); } finally { out.restore(); }
    expect(out.text()).toContain("VERDICT=alpha:malformed"); // dropped → tallied as if empty
    expect(out.text()).toContain("VERDICT=charlie:accept");

    h.cleanup(); h = freshHome();
    seedAdversary("quiescent"); // the wait accepted it → tallied on its real verdict line
    const out2 = captureStdout();
    try { expect(await verdictTallyRun([TOPIC])).toBe(0); } finally { out2.restore(); }
    expect(out2.text()).toContain("VERDICT=alpha:needs-attention");
  });

  it("synth-final: a still-writing critique refuses; AC=expired blocks as a missing critique", async () => {
    seedAdversary(null);
    const err = captureStderr();
    let rc: number;
    try { rc = await synthFinalRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");

    h.cleanup(); h = freshHome();
    seedAdversary("expired");
    const err2 = captureStderr();
    try { expect(await synthFinalRun([TOPIC])).toBe(1); } finally { err2.restore(); }

    h.cleanup(); h = freshHome();
    seedAdversary("quiescent");
    const out = captureStdout();
    try { expect(await synthFinalRun([TOPIC])).toBe(0); } finally { out.restore(); }
    expect(out.text()).toContain("landscape-");
  });

  it("rebuttal-send: a still-writing critique refuses; AC=quiescent selects targets from it", async () => {
    seedAdversary(null);
    const send = vi.fn(async () => 0);
    const err = captureStderr();
    let rc: number;
    try { rc = await rebuttalSendWith(TOPIC, "charlie", "claude", sendDeps({ send })); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");
    expect(send).not.toHaveBeenCalled();

    h.cleanup(); h = freshHome();
    const art = seedAdversary("quiescent");
    const send2 = vi.fn(async () => 0);
    expect(await rebuttalSendWith(TOPIC, "charlie", "claude", sendDeps({ send: send2 }))).toBe(0);
    expect(send2).toHaveBeenCalled();
    expect(readFileSync(join(art, "charlie_rebuttal_prompt.md"), "utf8")).toContain("CharlieOnly");
  });
});

// ---- L1: the composers' contract block --------------------------------------------------------

describe("phase composers carry the contract block for THEIR artifact", () => {
  const lens = ADVERSARY_LENSES[0];
  const cases: Array<[string, string, string]> = [
    ["explore research", "/art/findings-alpha.md",
      composeExploreResearchPrompt("attn", "/art/findings-alpha.md", litGuidance("ON"), researchLens("codex"), "/art/selfassess-alpha.md")],
    ["explore openq", "/art/openq-alpha.md", composeOpenqPrompt([{ from: "charlie", question: "q?" }], "/art/openq-alpha.md")],
    ["explore crossverify", "/art/crossverify-alpha.md", composeVerifyPrompt("[a:1] c", "/art/crossverify-alpha.md")],
    ["explore adversary", "/art/adversary-alpha.md",
      composeAdversaryPrompt("draft", "alpha", "/art/adversary-alpha.md", { peerFindingsPaths: [], lens })],
    ["explore rebuttal", "/art/rebuttal-alpha.md", composeRebuttalPrompt([{ cite: "a:1", text: "t" }], ["### Finding 1"], "/art/rebuttal-alpha.md")],
    ["explore gap", "/art/gap-alpha.md", composeGapPrompt(["[a:1] item"], "/art/gap-alpha.md")],
    ["explore signoff", "/art/signoff-alpha.md", composeSignoffPrompt("Adopt X.", ["[a:1] solo"], "", "/art/signoff-alpha.md")],
    ["design research", "/w/alpha-codex/findings.md", composeResearchPrompt("cache policy", "/w/alpha-codex/findings.md")],
    ["design verify", "/w/alpha-codex/verify.md", composeVerifyPrompt("[a:1] c", "/w/alpha-codex/verify.md")],
  ];

  it("explore research: the contract covers its SECOND file, the self-assessment", () => {
    const prompt = composeExploreResearchPrompt("attn", "/art/findings-alpha.md", litGuidance("ON"), researchLens("codex"), "/art/selfassess-alpha.md");
    expect(prompt).toContain("  3b. Same three steps for /art/selfassess-alpha.md: write /art/selfassess-alpha.md.tmp");
    expect(prompt).toContain("mv /art/selfassess-alpha.md.tmp /art/selfassess-alpha.md");
  });

  for (const [name, path, prompt] of cases) {
    it(`${name}: tmp-write, sentinel, mv into ${path}`, () => {
      expect(prompt).toContain(`  1. Write your output to ${path}.tmp`);
      expect(prompt).toContain(`  2. Make the LAST line of that file the literal sentinel: ${END_OF_ARTIFACT}`);
      expect(prompt).toContain(`  3. Rename it into place: mv ${path}.tmp ${path}`);
      // inboxWrite still owns the done contract + the fence — the block must not restate either.
      expect(prompt).not.toContain('{"event":"done"');
      expect(prompt).not.toContain("END_OF_INSTRUCTION");
    });
  }
});
