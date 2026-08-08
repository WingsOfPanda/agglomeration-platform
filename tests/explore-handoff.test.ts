import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHandoffKv, extractHandoffData, crossVerificationCoverage } from "../src/core/exploreHandoff.js";

describe("buildHandoffKv", () => {
  it("emits the frozen key order with convergence", () => {
    const kv = buildHandoffKv({
      topic: "attention kernels", landscapeDoc: "landscape-2026-05-30-attention.md",
      topApproach: "FlashAttention", findingsPaths: ["findings-rex.md", "findings-alpha.md"],
      confidenceSignals: "S1=true,S2=true,S3=true,S4=true,S5=true",
      adversaryFindingsPaths: ["adversary-rex.md"], tradeoffMatrixPresent: true,
      coverage: { value: "ok", crossverify: "covered", adversary: "covered" },
      generatedTs: "2026-05-30T00:00:00Z",
    });
    expect(kv).toBe(
      "mode=explore\n" +
      "topic=attention kernels\n" +
      "landscape_doc=landscape-2026-05-30-attention.md\n" +
      "top_approach=FlashAttention\n" +
      "findings_paths=findings-rex.md,findings-alpha.md\n" +
      "confidence_signals=S1=true,S2=true,S3=true,S4=true,S5=true\n" +
      "adversary_findings_paths=adversary-rex.md\n" +
      "tradeoff_matrix_present=true\n" +
      "cross_verification=ok\n" +
      "cross_verification_detail=crossverify=covered,adversary=covered\n" +
      "session_path=.\n" +
      "topic_txt_path=topic.txt\n" +
      "generated_ts=2026-05-30T00:00:00Z\n",
    );
  });
  it("mode=explore-no-convergence when top_approach empty (and omits related lines)", () => {
    const kv = buildHandoffKv({
      topic: "x", landscapeDoc: "landscape-draft.md", topApproach: "",
      findingsPaths: [], confidenceSignals: "", adversaryFindingsPaths: [],
      tradeoffMatrixPresent: false, generatedTs: "2026-05-30T00:00:00Z",
    });
    expect(kv).toContain("mode=explore-no-convergence\n");
    expect(kv).not.toContain("top_approach=");
    expect(kv).not.toContain("findings_paths=");
    expect(kv).toContain("tradeoff_matrix_present=false\n");
  });
  it("no coverage stamp → NEITHER coverage line, frozen tail intact (degraded / no-roster runs)", () => {
    const kv = buildHandoffKv({
      topic: "x", topApproach: "A", findingsPaths: [], confidenceSignals: "",
      adversaryFindingsPaths: [], tradeoffMatrixPresent: false, generatedTs: "t",
    });
    expect(kv).not.toContain("cross_verification");
    expect(kv).toContain("tradeoff_matrix_present=false\nsession_path=.\ntopic_txt_path=topic.txt\ngenerated_ts=t\n");
  });
});

describe("extractHandoffData (reconciled reads)", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "explore-art-"));
  it("reads adversary-skip.txt for signals and adversary-*.md for findings", () => {
    const art = mk();
    try {
      writeFileSync(join(art, "topic.txt"), "attention kernels\n");
      writeFileSync(join(art, "landscape-2026-05-30-attention.md"),
        "## Approaches\n1. FlashAttention — fused\n## Tradeoff matrix\n| a | b | c |\n");
      writeFileSync(join(art, "findings-rex.md"), "x");
      writeFileSync(join(art, "adversary-skip.txt"),
        "timestamp: t\nsignals_passed: S1=true S2=false S3=true S4=true S5=true\nuser_decision: continue\n");
      writeFileSync(join(art, "adversary-rex.md"), "critique");
      const path = extractHandoffData(art);
      expect(path).toBe(join(art, "handoff-data.kv"));
      const kv = readFileSync(path!, "utf8");
      expect(kv).toContain("mode=explore\n");
      expect(kv).toContain("top_approach=FlashAttention\n");
      expect(kv).toContain("confidence_signals=S1=true,S2=false,S3=true,S4=true,S5=true\n");
      expect(kv).toContain("adversary_findings_paths=adversary-rex.md\n");
      expect(kv).toContain("tradeoff_matrix_present=true\n");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });
  it("returns null when topic.txt is missing", () => {
    const art = mk();
    try { expect(extractHandoffData(art)).toBeNull(); }
    finally { rmSync(art, { recursive: true, force: true }); }
  });
  it("adversary-*.md glob excludes adversary-skip.txt and *_adversary_prompt.md", () => {
    const art = mk();
    try {
      writeFileSync(join(art, "topic.txt"), "x");
      writeFileSync(join(art, "adversary-skip.txt"), "signals_passed: S1=true S2=true S3=true S4=true S5=true\n");
      writeFileSync(join(art, "alpha_adversary_prompt.md"), "prompt");
      writeFileSync(join(art, "adversary-alpha.md"), "critique");
      const kv = readFileSync(extractHandoffData(art)!, "utf8");
      expect(kv).toContain("adversary_findings_paths=adversary-alpha.md\n");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });
});

// The 2026-08-08 coverage stamp: what the handoff says about the run's OWN cross-verification.
// The 2026-07-31 lockout shipped two independent research docs, nothing checking either against the
// other, and a handoff that read exactly like a cross-verified one. The rule this suite pins: a leg
// counts as covered only when the WAIT recorded an acceptance (`AC=sentinel|quiescent`) — never
// because a phase key says `ok`, which explore.md forbids gating on and which can sit beside an
// `AC=expired` artifact the validators dropped.
describe("cross_verification coverage stamp", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "explore-art-"));
  /** topic + an N-worker roster. */
  const seed = (art: string, agents = ["alpha", "bravo"]): void => {
    writeFileSync(join(art, "topic.txt"), "attention kernels\n");
    writeFileSync(join(art, "list.txt"), `# generated\n${agents.map((a) => `codex\t${a}`).join("\n")}\n`);
  };
  const state = (art: string, phase: string, agent: string, body: string): void =>
    writeFileSync(join(art, `${phase}-${agent}.txt`), `OFFSET=0\n${body}\n`);
  /** extractHandoffData + whatever it wrote to stderr (the loud warns land there). */
  const extract = (art: string): { kv: string; err: string } => {
    const err: string[] = [];
    const se = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
    try { return { kv: readFileSync(extractHandoffData(art)!, "utf8"), err: err.join("") }; }
    finally { process.stderr.write = se; }
  };

  it("both legs accepted by their waits → ok, with the detail line", () => {
    const art = mk();
    try {
      seed(art);
      state(art, "crossverify", "alpha", "AC=sentinel\nVS=ok");
      state(art, "adversary", "bravo", "AC=quiescent\nAS=ok"); // quiescent counts too
      const { kv, err } = extract(art);
      expect(kv).toContain("cross_verification=ok\n");
      expect(kv).toContain("cross_verification_detail=crossverify=covered,adversary=covered\n");
      expect(err).not.toContain("cross_verification=none");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("VS=ok / AS=ok beside AC=expired is NOT coverage — the key is not the verdict", () => {
    const art = mk();
    try {
      seed(art);
      state(art, "crossverify", "alpha", "AC=expired\nVS=ok");
      state(art, "adversary", "alpha", "AC=expired\nAS=ok");
      const { kv, err } = extract(art);
      expect(kv).toContain("cross_verification=none\n");
      expect(kv).toContain("cross_verification_detail=crossverify=lost,adversary=lost\n");
      expect(err).toContain("zero cross-verification; the landscape is an unverified single-pass survey");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("the lockout shape (waits expired, guards cascaded) → none + the loud warn", () => {
    const art = mk();
    try {
      seed(art);
      state(art, "crossverify", "alpha", "VS=timeout");
      writeFileSync(join(art, "crossverify-bravo.txt"), "VS=skipped\n"); // guard skip: no claims file
      writeFileSync(join(art, "adversary-alpha.txt"), "AS=skipped\n");
      writeFileSync(join(art, "adversary-bravo.txt"), "AS=skipped\n");
      const { kv, err } = extract(art);
      expect(kv).toContain("cross_verification=none\n");
      expect(err).toContain("zero cross-verification");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("adversary gated off by the confidence gate + cross-verify covered → gate-skipped, no harsh warn", () => {
    const art = mk();
    try {
      seed(art);
      state(art, "crossverify", "alpha", "AC=sentinel\nVS=ok");
      writeFileSync(join(art, "adversary-skip.txt"), "signals_passed: S1=true S2=true S3=true S4=true S5=true\nuser_decision: skip\n");
      const { kv, err } = extract(art);
      expect(kv).toContain("cross_verification=gate-skipped\n");
      expect(kv).toContain("cross_verification_detail=crossverify=covered,adversary=benign\n");
      expect(err).not.toContain("zero cross-verification");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("nothing to verify AND the gate skipped the adversary → gate-skipped (both benign)", () => {
    const art = mk();
    try {
      seed(art);
      // The shipped nothing-to-verify marker: crossverify-send writes the claims file (empty) right
      // before its skip; the guard path returns BEFORE writing it, which is what discriminates them.
      for (const a of ["alpha", "bravo"]) {
        writeFileSync(join(art, `crossverify-claims-${a}.txt`), "");
        writeFileSync(join(art, `crossverify-${a}.txt`), "VS=skipped\n");
      }
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: skip\n");
      expect(extract(art).kv).toContain("cross_verification_detail=crossverify=benign,adversary=benign\n");
      expect(extract(art).kv).toContain("cross_verification=gate-skipped\n");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("a NON-empty claims file whose phase never landed is lost, not benign", () => {
    const art = mk();
    try {
      seed(art);
      for (const a of ["alpha", "bravo"]) {
        writeFileSync(join(art, `crossverify-claims-${a}.txt`), "claim one\n");
        writeFileSync(join(art, `crossverify-${a}.txt`), "VS=timeout\n");
      }
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: skip\n");
      const kv = extract(art).kv;
      expect(kv).toContain("cross_verification_detail=crossverify=lost,adversary=benign\n");
      expect(kv).toContain("cross_verification=partial\n"); // gate-skipped requires cross-verify to hold
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("one leg covered, the other lost → partial", () => {
    const art = mk();
    try {
      seed(art);
      state(art, "adversary", "alpha", "AC=sentinel\nAS=ok");
      writeFileSync(join(art, "crossverify-alpha.txt"), "VS=skipped\n");
      const kv = extract(art).kv;
      expect(kv).toContain("cross_verification=partial\n");
      expect(kv).toContain("cross_verification_detail=crossverify=lost,adversary=covered\n");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("a DEGRADED run (one worker) emits NEITHER coverage line — the DEGRADED stamp says it", () => {
    const art = mk();
    try {
      seed(art, ["alpha"]);
      state(art, "adversary", "alpha", "AC=sentinel\nAS=ok"); // solo adversary is self-review
      const kv = extract(art).kv;
      expect(kv).not.toContain("cross_verification");
      expect(kv).toContain("tradeoff_matrix_present=false\nsession_path=.\n");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("no list.txt → no coverage keys + a warn (nothing to judge coverage against)", () => {
    const art = mk();
    try {
      writeFileSync(join(art, "topic.txt"), "x\n");
      writeFileSync(join(art, "crossverify-alpha.txt"), "AC=sentinel\nVS=ok\n"); // phantom, must not count
      const { kv, err } = extract(art);
      expect(kv).not.toContain("cross_verification");
      expect(err).toContain("no list.txt");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("the two lines sit between tradeoff_matrix_present and the frozen tail", () => {
    const art = mk();
    try {
      seed(art);
      expect(extract(art).kv).toContain(
        "tradeoff_matrix_present=false\ncross_verification=none\n" +
        "cross_verification_detail=crossverify=lost,adversary=lost\nsession_path=.\ntopic_txt_path=topic.txt\ngenerated_ts=",
      );
    } finally { rmSync(art, { recursive: true, force: true }); }
  });
});

describe("crossVerificationCoverage (unit)", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "explore-art-"));
  const roster = (art: string, n: number): void =>
    writeFileSync(join(art, "list.txt"), Array.from({ length: n }, (_, i) => `codex\tw${i}`).join("\n") + "\n");

  it("no list.txt → no-roster; one row → degraded; two rows → a stamp", () => {
    const art = mk();
    try {
      expect(crossVerificationCoverage(art).kind).toBe("no-roster");
      roster(art, 1);
      expect(crossVerificationCoverage(art).kind).toBe("degraded");
      roster(art, 2);
      const r = crossVerificationCoverage(art);
      expect(r.kind).toBe("stamp");
      expect(r.kind === "stamp" && r.stamp).toEqual({ value: "none", crossverify: "lost", adversary: "lost" });
    } finally { rmSync(art, { recursive: true, force: true }); }
  });

  it("ONE worker's acceptance covers the leg for the whole run", () => {
    const art = mk();
    try {
      roster(art, 3);
      writeFileSync(join(art, "crossverify-w2.txt"), "AC=sentinel\nVS=missing\n");
      const r = crossVerificationCoverage(art);
      expect(r.kind === "stamp" && r.stamp.crossverify).toBe("covered");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });
});
