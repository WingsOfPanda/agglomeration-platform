// tests/design-turn.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { topicDir, workerDir } from "../src/core/paths.js";
import { findingsStatus, researchState, composeResearchPrompt, composeVerifyPrompt, verifyState, composeDrilldownPrompt, drilldownState } from "../src/core/designTurn.js";
import { parseLatestOffset, lastKeyedNumber, recordWaitOutcome, scaledTimeout } from "../src/core/wait.js";

describe("findingsStatus", () => {
  it("null (no findings.md) → missing", () => { expect(findingsStatus(null)).toBe("missing"); });
  it(">=1 cited claim under ## Claims → ok", () => {
    expect(findingsStatus("## Claims\n1. [src/a.ts:10] uses LRU\n")).toBe("ok");
  });
  it("non-blank lines under ## Claims but none cited → malformed", () => {
    expect(findingsStatus("## Claims\nthis line has no citation\n")).toBe("malformed");
  });
  it("empty ## Claims section → empty", () => {
    expect(findingsStatus("## Summary\nblah\n\n## Claims\n\n## Notes\nx\n")).toBe("empty");
  });
  it("a heading after ## Claims closes the section", () => {
    expect(findingsStatus("## Claims\n\n## Notes\nnot a claim line\n")).toBe("empty");
  });
});

describe("researchState", () => {
  it("null event → timeout", () => { expect(researchState(null, "## Claims\n1. [a:1] x\n")).toBe("timeout"); });
  it("question event → question (findings ignored)", () => {
    expect(researchState({ event: "question", message: "?" }, null)).toBe("question");
  });
  it("done event → findingsStatus of the findings text", () => {
    expect(researchState({ event: "done", summary: "ok" }, "## Claims\n1. [a:1] x\n")).toBe("ok");
    expect(researchState({ event: "done", summary: "ok" }, null)).toBe("missing");
    expect(researchState({ event: "done", summary: "ok" }, "## Claims\nno cite\n")).toBe("malformed");
  });
  it("error / unknown event → failed", () => {
    expect(researchState({ event: "error", reason: "x" }, null)).toBe("failed");
    expect(researchState({ event: "weird" }, null)).toBe("failed");
  });
});

describe("parseLatestOffset", () => {
  it("single OFFSET line", () => { expect(parseLatestOffset("OFFSET=128\n")).toBe(128); });
  it("returns the LAST OFFSET after a question re-arm", () => {
    expect(parseLatestOffset("OFFSET=10\nFS=question\nOFFSET=512\nFS=ok\n")).toBe(512);
  });
  it("ignores trailing FS lines; null when absent", () => {
    expect(parseLatestOffset("OFFSET=0\nFS=ok\n")).toBe(0);
    expect(parseLatestOffset("FS=timeout\n")).toBeNull();
  });
});

describe("scaledTimeout", () => {
  it("multiplier 1.0 is identity; 2.5 rounds half-up; bad multiplier → identity", () => {
    expect(scaledTimeout(600, "1.0")).toBe(600);
    expect(scaledTimeout(300, "2.5")).toBe(750);
    expect(scaledTimeout(601, "1.5")).toBe(902); // 901.5 → 902
    expect(scaledTimeout(600, "bad")).toBe(600);
    expect(scaledTimeout(600, "0")).toBe(600);
  });
});

describe("composeResearchPrompt", () => {
  const p = composeResearchPrompt("compare LRU vs LFU", "/state/x/alpha-codex/findings.md");
  it("names the topic + the findings write path with the Findings structure", () => {
    expect(p).toContain("compare LRU vs LFU");
    expect(p).toContain("/state/x/alpha-codex/findings.md");
    expect(p).toContain("## Claims");
    expect(p).toMatch(/\[<source citation>\]/);
  });
  it("documents the question protocol and is NOT branch-disciplined", () => {
    expect(p).toContain('"event":"question"');
    expect(p).not.toMatch(/git (checkout|switch|branch)/i);
  });
  it("carries no canonical fence (inboxWrite appends it) and no stale rebrand tokens", () => {
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
    expect(p).not.toMatch(/master[ -]?yoda/i);
    expect(p).not.toMatch(/trooper|commander/i);
  });
});

describe("verifyState", () => {
  it("null → timeout; question → question; error → failed", () => {
    expect(verifyState(null, "x")).toBe("timeout");
    expect(verifyState({ event: "question", message: "?" }, null)).toBe("question");
    expect(verifyState({ event: "error", reason: "x" }, "x")).toBe("failed");
  });
  it("done → ok iff verify.md non-empty, else missing", () => {
    expect(verifyState({ event: "done", summary: "ok" }, "## Verdicts\n1. AGREE [a:1] x\n")).toBe("ok");
    expect(verifyState({ event: "done", summary: "ok" }, "")).toBe("missing");
    expect(verifyState({ event: "done", summary: "ok" }, null)).toBe("missing");
  });
});

describe("composeVerifyPrompt", () => {
  const p = composeVerifyPrompt("[a:1] claim one\n[b:2] claim two", "/s/alpha-codex/verify.md");
  it("numbers the items, names AGREE/DISPUTE/UNCERTAIN + the write path, no fence/rebrand tokens", () => {
    expect(p).toContain("1. [a:1] claim one");
    expect(p).toContain("2. [b:2] claim two");
    expect(p).toMatch(/AGREE/); expect(p).toMatch(/DISPUTE/); expect(p).toMatch(/UNCERTAIN/);
    expect(p).toContain("/s/alpha-codex/verify.md");
    expect(p).toContain("## Verdicts");
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toContain('"event":"done"');
    expect(p).not.toMatch(/master[ -]?yoda|trooper|commander/i);
    expect(p).toContain('"event":"question"');
  });
});

describe("composeDrilldownPrompt", () => {
  it("names the section, design doc, focus, out path; default focus; no fence/rebrand tokens", () => {
    const p = composeDrilldownPrompt({ section: "Architecture", designDocPath: "/d/doc.md", focus: "", outPath: "/o/dd.md" });
    expect(p).toContain("Architecture");
    expect(p).toContain("/d/doc.md");
    expect(p).toContain("/o/dd.md");
    expect(p).toMatch(/Provide more depth, citations, and concrete trade-offs for the Architecture section\./);
    expect(p).not.toContain("END_OF_INSTRUCTION");
    expect(p).not.toMatch(/master[ -]?yoda|trooper|commander/i);
    expect(composeDrilldownPrompt({ section: "Testing", designDocPath: "/d", focus: "edge cases", outPath: "/o" })).toContain("edge cases");
  });
});

describe("drilldownState", () => {
  it("terminal + non-empty file → ok; terminal + empty → missing; null → timeout", () => {
    expect(drilldownState({ event: "done" }, "notes\n")).toBe("ok");
    expect(drilldownState({ event: "done" }, "")).toBe("missing");
    expect(drilldownState({ event: "error", reason: "x" }, null)).toBe("missing");
    expect(drilldownState(null, "notes")).toBe("timeout");
  });
});

// recordWaitOutcome is the single WRITER of the `OFFSET=` / `<KEY>=` state-file micro-protocol
// its readers (parseLatestOffset / lastKeyedNumber / gateState) already cover. Characterization
// tests: they pin the bytes it appends today, including that the `.done` marker and the logging
// stay the CALLER's job — recordWaitOutcome never writes one.
describe("recordWaitOutcome", () => {
  const AGENT = "alpha", MODEL = "codex", TOPIC = "demo";

  /** A worker dir whose outbox has a known byte size, plus an art dir with a pre-armed state file. */
  function seed(outbox: string) {
    const wd = workerDir(AGENT, MODEL, TOPIC);
    mkdirSync(wd, { recursive: true });
    writeFileSync(join(wd, "outbox.jsonl"), outbox);
    const art = join(topicDir(TOPIC), "_design");
    mkdirSync(art, { recursive: true });
    const stateFile = join(art, `research-${AGENT}.txt`);
    writeFileSync(stateFile, "OFFSET=0\n");
    return {
      stateFile,
      questionFile: join(art, `question-${AGENT}.txt`),
      doneMarker: join(art, `research-${AGENT}.done`),
      size: Buffer.byteLength(outbox),
      state: () => readFileSync(stateFile, "utf8"),
    };
  }

  it("terminal outcome appends only `<KEY>=<state>` — no question file, no .done marker", () => {
    const { cleanup } = freshHome();
    try {
      const s = seed('{"event":"done","summary":"ok"}\n');
      recordWaitOutcome(AGENT, MODEL, TOPIC, s.stateFile, "ok", "FS");
      expect(s.state()).toBe("OFFSET=0\nFS=ok\n");
      expect(parseLatestOffset(s.state())).toBe(0);   // OFFSET untouched on a terminal outcome
      expect(existsSync(s.questionFile)).toBe(false);
      expect(existsSync(s.doneMarker)).toBe(false);   // the caller writes the marker, not this
    } finally { cleanup(); }
  });

  it("state 'question' with no payload falls through to the terminal branch", () => {
    const { cleanup } = freshHome();
    try {
      const s = seed('{"event":"question","message":"?"}\n');
      recordWaitOutcome(AGENT, MODEL, TOPIC, s.stateFile, "question", "FS");
      expect(s.state()).toBe("OFFSET=0\nFS=question\n");
      expect(existsSync(s.questionFile)).toBe(false);
    } finally { cleanup(); }
  });

  it("question outcome writes the payload and re-arms OFFSET past the handled event", () => {
    const { cleanup } = freshHome();
    try {
      const s = seed('{"event":"question","message":"which passage?"}\n');
      recordWaitOutcome(AGENT, MODEL, TOPIC, s.stateFile, "question", "FS",
        { file: s.questionFile, body: '{"event":"question","message":"which passage?"}\n' });
      expect(readFileSync(s.questionFile, "utf8")).toBe('{"event":"question","message":"which passage?"}\n');
      expect(s.state()).toBe(`OFFSET=0\nOFFSET=${s.size}\nFS=question\n`);
      expect(parseLatestOffset(s.state())).toBe(s.size); // latest-line-wins: past the handled event
      expect(existsSync(s.doneMarker)).toBe(false);
    } finally { cleanup(); }
  });

  it("question extraLines are appended verbatim after `<KEY>=question` (implement's OBJECTIONS=)", () => {
    const { cleanup } = freshHome();
    try {
      const s = seed('{"event":"question","message":"objection"}\n');
      recordWaitOutcome(AGENT, MODEL, TOPIC, s.stateFile, "question", "TS",
        { file: s.questionFile, body: "payload", extraLines: "OBJECTIONS=1\n" });
      expect(s.state()).toBe(`OFFSET=0\nOFFSET=${s.size}\nTS=question\nOBJECTIONS=1\n`);
      expect(lastKeyedNumber(s.state(), "OBJECTIONS")).toBe(1);
    } finally { cleanup(); }
  });
});
