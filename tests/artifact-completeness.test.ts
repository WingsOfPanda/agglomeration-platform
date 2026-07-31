// tests/artifact-completeness.test.ts — the three artifact-completeness layers (2026-07-31 spec):
// the composers' contract block (L1), phaseWait's sentinel grace + the validators' backstop (L2),
// and dispatchPrompt's busy-gate (L3). The incident: a worker emitted `done` before its findings
// file was written, the hub read the half-written file, and the next phase-send rewrote the inbox
// of a worker still mid-turn.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
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
} from "../src/commands/explore.js";
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

  it("sentinel already present at done → FS=ok, no polling, no flag", async () => {
    const art = seedWait();
    writeFileSync(findings(), complete("## Claims\n1. [a:1] x"));
    const sleep = vi.fn(async () => {});
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=ok");
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

  it("no sentinel but the file stopped growing → quiescence-accept (FS=ok) + the soft-compliance flag", async () => {
    const art = seedWait();
    writeFileSync(findings(), "## Claims\n1. [a:1] finished but unsentinelled");
    process.env.AP_ARTIFACT_GRACE_S = "20"; // far more grace than quiescence needs
    const sleep = vi.fn(async () => {});
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(2); // ~4s: two consecutive equal-size polls, then accept
    // Classified by the row's stateFn exactly as a sentinel-accept would be — never destroyed.
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=0\nFS=ok\n");
    expect(flagFeed()).toContain(`artifact-quiescent-no-sentinel: alpha ${findings()}`);
    expect(flagFeed()).not.toContain("artifact-incomplete");
  });

  it("still growing at the grace cap → FS=timeout, .done marker, and a forensics flag naming the artifact", async () => {
    const art = seedWait();
    writeFileSync(findings(), "## Claims\n1. [a:1] half-writ");
    process.env.AP_ARTIFACT_GRACE_S = "6"; // 3 polls at the 2s cadence
    const sleep = vi.fn(async () => { appendFileSync(findings(), " more"); }); // never quiesces
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toBe("OFFSET=0\nFS=timeout\n");
    expect(existsSync(join(art, "research-alpha.done"))).toBe(true); // the gate still sees a terminal worker
    expect(flagFeed()).toContain(`artifact-incomplete: alpha ${findings()} done-event without ${END_OF_ARTIFACT} after 6s grace`);
  });

  it("an EMPTY artifact never quiesces → FS=timeout even though its size is stable", async () => {
    const art = seedWait();
    writeFileSync(findings(), "");
    process.env.AP_ARTIFACT_GRACE_S = "6";
    const sleep = vi.fn(async () => {});
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(3); // polled to the cap, never accepted
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=timeout");
    expect(flagFeed()).toContain(`artifact-incomplete: alpha ${findings()}`);
  });

  it("non-done terminal events bypass the check entirely (error → FS=failed, question → FS=question)", async () => {
    const art = seedWait();
    writeFileSync(findings(), "half-writ"); // no sentinel either way
    const sleep = vi.fn(async () => {});
    await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: async () => ({ event: "error" } as any), sleep }));
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=failed");

    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\n");
    await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: async () => ({ event: "question", message: "which?" } as any), sleep }));
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=question");
    expect(sleep).not.toHaveBeenCalled();
    expect(flagFeed()).toBe("");
  });

  it("AP_ARTIFACT_GRACE_S=0 disables the check — the stateFn classifies as before", async () => {
    const art = seedWait();
    writeFileSync(findings(), ""); // empty, no sentinel
    process.env.AP_ARTIFACT_GRACE_S = "0";
    const sleep = vi.fn(async () => {});
    expect(await researchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=empty");
    expect(flagFeed()).toBe("");
  });

  it("design rows share the same grace (one design-side pin)", async () => {
    const art = designArtDir(TOPIC);
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=0\n");
    mkdirSync(workerDir("alpha", "codex", TOPIC), { recursive: true });
    const f = join(workerDir("alpha", "codex", TOPIC), "findings.md");
    writeFileSync(f, "## Claims\n1. [a:1] half-writ");
    process.env.AP_ARTIFACT_GRACE_S = "6";
    const sleep = async (): Promise<void> => { appendFileSync(f, " more"); }; // still growing at the cap
    expect(await designResearchWaitWith(TOPIC, "alpha", "codex", waitDeps({ wait: done, sleep }))).toBe(0);
    expect(readFileSync(join(art, "research-alpha.txt"), "utf8")).toContain("FS=timeout");
    expect(flagFeed()).toContain("artifact-incomplete: alpha");
  });
});

describe("artifactGraceS / artifactComplete", () => {
  it("default 60s; clamped to 0..300; 0 honoured; junk falls back", () => {
    delete process.env.AP_ARTIFACT_GRACE_S;
    expect(artifactGraceS()).toBe(60);
    for (const [raw, want] of [["5", 5], ["0", 0], ["999", 300], ["-3", 0], ["abc", 60], ["", 60]] as const) {
      process.env.AP_ARTIFACT_GRACE_S = raw;
      expect(artifactGraceS()).toBe(want);
    }
  });

  it("the sentinel must be the LAST line; trailing whitespace/newlines tolerated", () => {
    const p = join(h.home, "a.md");
    writeFileSync(p, `body\n${END_OF_ARTIFACT}\n\n  \n`);
    expect(artifactComplete(p)).toBe(true);
    writeFileSync(p, `body\n${END_OF_ARTIFACT}\nmore prose\n`);
    expect(artifactComplete(p)).toBe(false);
    expect(artifactComplete(join(h.home, "nope.md"))).toBe(false); // absent is never complete
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
  /** alpha's findings without the sentinel + charlie's complete; `tag` is alpha's FS= value. */
  function seedFindings(tag: string | null, alphaBody = "## Claims\n1. [a:1] half-writ"): string {
    const art = seedExplore([{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }]);
    writeFileSync(join(art, "findings-alpha.md"), alphaBody);
    writeFileSync(join(art, "findings-charlie.md"), complete("## Claims\n1. [c:1] y"));
    writeFileSync(join(art, "research-charlie.txt"), "OFFSET=0\nFS=ok\n");
    if (tag !== null) writeFileSync(join(art, "research-alpha.txt"), `OFFSET=0\nFS=${tag}\n`);
    return art;
  }

  it("survivors: FS=ok + no sentinel → ACCEPTED (the wait already classified it; never destroy accepted work)", async () => {
    const art = seedFindings("ok");
    const out = captureStdout();
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); err.restore(); }
    expect(rc).toBe(0);
    expect(out.text().trim()).toBe("SURVIVORS=2");
    expect(err.text()).not.toContain("STILL_WRITING");
    expect(existsSync(join(art, "stillwriting-alpha.txt"))).toBe(false);
  });

  it("survivors: an UNSET tag (the gate-skipping hub) refuses — rc 1, STILL_WRITING, strike recorded", async () => {
    const art = seedFindings(null);
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha\n");
    expect(err.text()).not.toContain("STILL_WRITING=charlie");
    expect(readFileSync(join(art, "stillwriting-alpha.txt"), "utf8")).toBe("alpha 28\n");
    expect(readFileSync(join(art, "list.txt"), "utf8")).toContain("alpha"); // nothing rewritten
  });

  it("survivors: an accepted verdict clears the strike file", async () => {
    const art = seedFindings(null);
    const err = captureStderr();
    try { expect(await survivorsRun([TOPIC])).toBe(1); } finally { err.restore(); }
    expect(existsSync(join(art, "stillwriting-alpha.txt"))).toBe(true);
    writeFileSync(join(art, "findings-alpha.md"), complete("## Claims\n1. [a:1] x")); // the worker finished
    const out = captureStdout();
    try { expect(await survivorsRun([TOPIC])).toBe(0); } finally { out.restore(); }
    expect(existsSync(join(art, "stillwriting-alpha.txt"))).toBe(false); // no strikes carried forward
  });

  it("survivors: FS=timeout + no sentinel → dropped as empty (the existing N-1 path)", async () => {
    const art = seedFindings("timeout");
    const out = captureStdout();
    const err = captureStderr();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); err.restore(); }
    expect(rc).toBe(0);
    expect(out.text().trim().split("\n")).toEqual(["SURVIVORS=1", "DROPPED=alpha", "DEGRADED=1"]);
    expect(err.text()).not.toContain("STILL_WRITING");
    expect(readFileSync(join(art, "list.txt"), "utf8")).not.toContain("alpha");
  });

  it("survivors: both artifacts complete → unchanged pass-through", async () => {
    const art = seedFindings("ok", complete("## Claims\n1. [a:1] x"));
    const out = captureStdout();
    let rc: number;
    try { rc = await survivorsRun([TOPIC]); } finally { out.restore(); }
    expect(rc).toBe(0);
    expect(out.text().trim()).toBe("SURVIVORS=2");
    expect(existsSync(join(art, "stillwriting-alpha.txt"))).toBe(false);
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
    expect(readFileSync(join(art, "stillwriting-alpha.txt"), "utf8").trim().split("\n").length).toBe(3);
    expect(flagFeed()).toContain("artifact-incomplete: alpha");
    expect(flagFeed()).toContain("dropped as empty after 3 refusals with no growth");
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
    expect(readFileSync(join(art, "stillwriting-alpha.txt"), "utf8").trim().split("\n").length).toBe(3);
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

  it("synth-preliminary: unset tag + no sentinel → rc 1 STILL_WRITING; FS=timeout → blocked as empty", async () => {
    seedFindings(null);
    const err = captureStderr();
    let rc: number;
    try { rc = await synthPreliminaryRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");

    const err2 = captureStderr();
    let rc2: number;
    try {
      seedFindings("timeout");
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

  it("design diff: still-writing refuses; a non-ok tag diffs the worker as empty", async () => {
    const seedDesign = (tag: string | null): string => {
      const art = designArtDir(TOPIC);
      mkdirSync(art, { recursive: true });
      writeFileSync(join(art, "list.txt"), "codex\talpha\nclaude\tcharlie\n");
      if (tag !== null) writeFileSync(join(art, `research-alpha.txt`), `OFFSET=0\nFS=${tag}\n`);
      for (const [agent, provider, body] of [["alpha", "codex", "## Claims\n1. [a:1] half-writ"], ["charlie", "claude", complete("## Claims\n1. [c:1] y")]] as const) {
        mkdirSync(workerDir(agent, provider, TOPIC), { recursive: true });
        writeFileSync(join(workerDir(agent, provider, TOPIC), "findings.md"), body);
      }
      return art;
    };
    let art = seedDesign(null); // the gate-skipping hub: no FS= tag was ever written
    const err = captureStderr();
    let rc: number;
    try { rc = await designDiffRun([TOPIC]); } finally { err.restore(); }
    expect(rc).toBe(1);
    expect(err.text()).toContain("STILL_WRITING=alpha");
    expect(existsSync(join(art, "diff.md"))).toBe(false);

    h.cleanup(); h = freshHome();
    art = seedDesign("timeout");
    expect(await designDiffRun([TOPIC])).toBe(0);
    expect(readFileSync(join(art, "alpha_only_items.txt"), "utf8").trim()).toBe(""); // contributed nothing
    expect(readFileSync(join(art, "charlie_only_items.txt"), "utf8")).toContain("[c:1] y");

    h.cleanup(); h = freshHome();
    art = seedDesign("ok"); // accepted by the wait → diffed as-is, sentinel or not
    expect(await designDiffRun([TOPIC])).toBe(0);
    expect(readFileSync(join(art, "alpha_only_items.txt"), "utf8")).toContain("[a:1] half-writ");
  });

  it("explore diff: unset tag refuses; FS=timeout buckets that worker as empty", async () => {
    const seedDiff = (tag: string | null): string => {
      const art = seedExplore([{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }]);
      writeFileSync(join(art, "findings-alpha.md"), "## Approaches\n1. [a.ts:1] AlphaOnly — solo\n");
      writeFileSync(join(art, "findings-charlie.md"), complete("## Approaches\n1. [c.ts:2] CharlieOnly — solo"));
      if (tag !== null) writeFileSync(join(art, "research-alpha.txt"), `OFFSET=0\nFS=${tag}\n`);
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
    art = seedDiff("timeout");
    expect(await diffExploreRun([TOPIC])).toBe(0);
    expect(readFileSync(join(art, "alpha_only_items.txt"), "utf8").trim()).toBe("");
    expect(readFileSync(join(art, "charlie_only_items.txt"), "utf8")).toContain("CharlieOnly");
  });

  it("openq-collate: unset tag refuses; FS=timeout routes none of that worker's questions", async () => {
    const seedQs = (tag: string | null): string => {
      const art = seedExplore([{ provider: "codex", agent: "alpha" }, { provider: "claude", agent: "charlie" }]);
      writeFileSync(join(art, "findings-alpha.md"), "## Open questions\n- qa1\n");
      writeFileSync(join(art, "findings-charlie.md"), complete("## Open questions\n- qc1"));
      if (tag !== null) writeFileSync(join(art, "research-alpha.txt"), `OFFSET=0\nFS=${tag}\n`);
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
    art = seedQs("timeout");
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

    // With the tag written by the wait, the same file adjudicates; charlie's absent verify.md is the
    // pre-existing VS=skipped path and never reaches the backstop.
    writeFileSync(join(art, "verify-alpha.txt"), "OFFSET=0\nVS=ok\n");
    expect(await adjudicateRun([TOPIC])).toBe(0);
    expect(existsSync(join(art, "adjudicated-draft.md"))).toBe(true);
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
