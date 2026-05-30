# consort `prelude` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port clone-wars `meditate` to consort as the `prelude` command — a multi-part research
pass with a literature-track classifier, a 5-signal confidence gate, an adversary round, and a
landscape doc + `score-handoff.md` that feeds `/consort:score`.

**Architecture:** `prelude` is built on `score` (the consult port): it reuses score's DI verb
pattern, IPC/wait helpers, timeouts, archive, forensics, and roster helpers. The three meditate-
specific additions (lit classifier, confidence gate, adversary round) are pure core modules.
Synthesis docs are authored Maestro-side (Write tool) inside the directive; the CLI verbs do
init/classify/spawn/send/wait/validate/gate/extract/teardown.

**Tech Stack:** TypeScript (ES2022, NodeNext, strict), vitest, esbuild → committed
`dist/consort.cjs`, execa for tmux. Spec: `docs/superpowers/specs/2026-05-30-consort-prelude-design.md`.

**Branch:** `feat/prelude` (already checked out).

**Conventions every task follows:**
- Atomic writes (`atomicWrite` from `src/core/atomic.js`) for all state files.
- Errors to **stderr** via `log.error`/`log.warn` (`src/core/log.js`); machine output to stdout.
- No emojis in shipped output. No `cw_`/`clone-wars`/`trooper`/`commander` tokens anywhere in
  `src`/`config`/`commands`/`hooks` (stale-token gate — 7 tokens, case-insensitive on
  trooper/commander). JSDoc **may** cite `meditate-*.sh` source filenames.
- Tests set a fresh `CONSORT_HOME` via `freshHome()` from `tests/helpers/tmpHome.ts`.
- Run `npm run typecheck` (authoritative — ignore editor/LSP "cannot find module" false positives)
  and `npm run test` before each commit.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Sequencing note for the executor:** Tasks P6–P12 all edit the shared files
`src/commands/prelude.ts` and `tests/prelude-cmd.test.ts` — dispatch implementers **sequentially**,
never in parallel. P1–P5 create independent new files but also touch the shared dispatcher
(`src/consort.ts`) only in P6; keep them sequential for clean commits.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/core/archive.ts` (modify) | add `"prelude"` to the `archiveTopic` suite union | P1 |
| `src/core/prelude.ts` (create) | `preludeArtDir`; re-export `deriveSlug` | P1 |
| `src/core/preludeLit.ts` (create) | `classifyTopic` + `LIT_KEYWORDS` | P2 |
| `src/core/preludeConfidence.ts` (create) | `computeSignals` (S1–S5) + `renderSkipRecord` | P3 |
| `src/core/preludeTurn.ts` (create) | `composePreludeResearchPrompt`, `composeAdversaryPrompt`, `litGuidance` | P4 |
| `src/core/preludeHandoff.ts` (create) | `buildHandoffKv` (pure) + `extractHandoffData` (I/O, reconciled) | P5 |
| `src/commands/prelude.ts` (create) | the 13 verbs (DI pattern) | P6–P12 |
| `src/consort.ts` (modify) | register the `prelude` handler | P6 |
| `commands/prelude.md` (create) | the directive (Phases 0–10) | P13 |
| `scripts/dogfood-prelude-loop.sh` (create) | simulated end-to-end dogfood | P14 |
| `dist/consort.cjs` (rebuild) | committed bundle | P14 |
| `CLAUDE.md` (modify) | flip the phase guard (prelude shipped) | P15 |
| `tests/prelude-*.test.ts` (create) | unit + command-verb tests | all |

---

### Task P1: archive suite + `prelude` paths

**Files:**
- Modify: `src/core/archive.ts` (the `archiveTopic` suite union, ~line 58)
- Create: `src/core/prelude.ts`
- Test: `tests/prelude-core.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/prelude-core.test.ts
import { describe, it, expect } from "vitest";
import { freshHome } from "./helpers/tmpHome.js";
import { preludeArtDir, deriveSlug } from "../src/core/prelude.js";

describe("prelude core paths", () => {
  it("preludeArtDir ends in _prelude under the topic dir", () => {
    const { cleanup } = freshHome();
    try {
      const art = preludeArtDir("foo-bar");
      expect(art.endsWith("/foo-bar/_prelude")).toBe(true);
    } finally { cleanup(); }
  });
  it("re-exports deriveSlug (cap-20, bare slug)", () => {
    expect(deriveSlug("Deep Think About Attention")).toBe("deep-think-about-att");
    expect(deriveSlug("  ")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prelude-core.test.ts`
Expected: FAIL — `Cannot find module '../src/core/prelude.js'`.

- [ ] **Step 3: Add `"prelude"` to the archive suite union**

In `src/core/archive.ts`, change the `archiveTopic` signature's `suite` union to include `"prelude"`:

```ts
export function archiveTopic(
  topic: string,
  suite: "consult" | "deploy" | "meditate" | "score" | "perform" | "rehearsal" | "prelude",
  opts?: { now?: Date },
): string | null {
```

(No other change — the body already builds `_${suite}` generically.)

- [ ] **Step 4: Create `src/core/prelude.ts`**

```ts
// src/core/prelude.ts — paths + slug for /consort:prelude (port of meditate-init.sh + the
// _meditate art-dir helper). Built on score's bare-slug convention; the _prelude suffix
// disambiguates from _score/_rehearsal, so no topic prefix.
import { join } from "node:path";
import { topicDir } from "./paths.js";
export { deriveSlug } from "./solo.js"; // identical slug rule (cap-20); reused, not duplicated

/** `_prelude` art dir for a topic. */
export function preludeArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_prelude");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/prelude-core.test.ts` → PASS. Then `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/archive.ts src/core/prelude.ts tests/prelude-core.test.ts
git commit -m "feat(prelude): archive suite + _prelude art-dir paths"
```

---

### Task P2: literature classifier (`preludeLit.ts`)

**Files:**
- Create: `src/core/preludeLit.ts`
- Test: `tests/prelude-lit.test.ts`

Port of `cw_meditate_classify_topic` + `cw_meditate_lit_keywords` (lib/meditate.sh). Whole-word,
case-insensitive keyword match → `"ON"`/`"OFF"`. Empty topic → `"OFF"`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/prelude-lit.test.ts
import { describe, it, expect } from "vitest";
import { classifyTopic, LIT_KEYWORDS } from "../src/core/preludeLit.js";

describe("classifyTopic", () => {
  it("ON when an academic keyword appears as a whole word", () => {
    expect(classifyTopic("SOTA attention architectures")).toBe("ON");
    expect(classifyTopic("best LOSS function for ranking")).toBe("ON"); // case-insensitive
  });
  it("OFF for non-academic topics", () => {
    expect(classifyTopic("how to structure a billing service")).toBe("OFF");
  });
  it("whole-word only: 'networking' does not match keyword 'network'", () => {
    expect(classifyTopic("a networking conference recap")).toBe("OFF");
  });
  it("hyphenated keywords match: 'fine-tune', 'state-of-the-art'", () => {
    expect(classifyTopic("how to fine-tune cheaply")).toBe("ON");
    expect(classifyTopic("the state-of-the-art survey")).toBe("ON");
  });
  it("empty topic -> OFF", () => {
    expect(classifyTopic("")).toBe("OFF");
    expect(classifyTopic("   ")).toBe("OFF");
  });
  it("keyword list has the 24 ported terms", () => {
    expect(LIT_KEYWORDS).toContain("transformer");
    expect(LIT_KEYWORDS.length).toBe(24);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prelude-lit.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/core/preludeLit.ts`**

```ts
// src/core/preludeLit.ts — literature-track classifier (port of cw_meditate_classify_topic +
// cw_meditate_lit_keywords, lib/meditate.sh). Whole-word case-insensitive match → ON/OFF.

/** The 24 academic/SOTA keywords (ported verbatim, order preserved). */
export const LIT_KEYWORDS: string[] = [
  "loss", "embedding", "network", "model", "architecture", "training", "optimizer", "scheduler",
  "transformer", "mamba", "attention", "regularization", "augmentation", "fine-tune", "sota",
  "state-of-the-art", "benchmark", "paper", "arxiv", "algorithm", "inference", "quantization",
  "distillation", "pruning",
];

/** Escape a keyword for use inside a RegExp (the hyphenated ones contain `-`, which is literal
 *  outside a character class, but escape defensively). */
function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** ON iff any keyword appears as a whole word (bordered by non-alphanumeric or string edge),
 *  case-insensitive. Faithful to the bash `[[ " $lower " =~ [^a-z0-9]"$kw"[^a-z0-9] ]]` test:
 *  the space-padding makes start/end count as borders. Empty topic → OFF. */
export function classifyTopic(topic: string): "ON" | "OFF" {
  const t = (topic ?? "").trim();
  if (!t) return "OFF";
  const padded = ` ${t.toLowerCase()} `;
  for (const kw of LIT_KEYWORDS) {
    if (new RegExp(`[^a-z0-9]${esc(kw)}[^a-z0-9]`).test(padded)) return "ON";
  }
  return "OFF";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prelude-lit.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/preludeLit.ts tests/prelude-lit.test.ts
git commit -m "feat(prelude): literature-track classifier (24-keyword whole-word scan)"
```

---

### Task P3: confidence gate (`preludeConfidence.ts`)

**Files:**
- Create: `src/core/preludeConfidence.ts`
- Test: `tests/prelude-confidence.test.ts`

Port of directive Step 5.5 (`commands/meditate.md`). All signal defs are in spec §5. `computeSignals`
is pure (draft text + findings texts → booleans). `renderSkipRecord` emits the 3-line
`adversary-skip.txt` body.

- [ ] **Step 1: Write the failing test**

```ts
// tests/prelude-confidence.test.ts
import { describe, it, expect } from "vitest";
import { computeSignals, renderSkipRecord } from "../src/core/preludeConfidence.js";

const DRAFT_OK = [
  "## Topic",
  "x",
  "## Approaches",
  "1. FlashAttention — fused kernel",
  "2. Ring attention — sharded",
  "## Tradeoff matrix",
  "| Priority | Best fit | Reason |",
  "|---|---|---|",
  "| latency | FlashAttention | see https://arxiv.org/abs/2205.14135 |",
  "## Citations",
  "- https://arxiv.org/abs/2205.14135",
].join("\n");

const FIND_A = "FlashAttention is fast. https://arxiv.org/abs/2205.14135 . I am uncertain about batch.";
const FIND_B = "FlashAttention wins. https://arxiv.org/abs/2205.14135 confirms it.";

describe("computeSignals", () => {
  it("all hold on a clean draft (N=2)", () => {
    const s = computeSignals(DRAFT_OK, [FIND_A, FIND_B]);
    expect(s).toEqual({ s1: true, s2: true, s3: true, s4: true, s5: true, allHold: true });
  });
  it("S3 false when CONTESTED appears", () => {
    const s = computeSignals(DRAFT_OK + "\nCONTESTED: ring vs flash", [FIND_A, FIND_B]);
    expect(s.s3).toBe(false);
    expect(s.allHold).toBe(false);
  });
  it("S1 false when top approach is absent from N-1 findings", () => {
    const s = computeSignals(DRAFT_OK, ["nothing relevant here", "also nothing"]);
    expect(s.s1).toBe(false);
  });
  it("S2 false when a draft citation is solo-cited (< 2 findings)", () => {
    const draft = DRAFT_OK.replace("## Citations", "## Citations\n- https://solo.example/x");
    const s = computeSignals(draft, [FIND_A + " https://solo.example/x", FIND_B]);
    expect(s.s2).toBe(false);
  });
  it("S4 false when a matrix Reason cell lacks a / or : anchor", () => {
    const draft = DRAFT_OK.replace("see https://arxiv.org/abs/2205.14135", "it is simply faster");
    const s = computeSignals(draft, [FIND_A, FIND_B]);
    expect(s.s4).toBe(false);
  });
  it("S5 false when no finding acknowledges uncertainty", () => {
    const s = computeSignals(DRAFT_OK, ["FlashAttention. https://arxiv.org/abs/2205.14135", FIND_B.replace("confirms it.", "confirms it. https://arxiv.org/abs/2205.14135")]);
    expect(s.s5).toBe(false);
  });
});

describe("renderSkipRecord", () => {
  it("emits the 3-line body with the chosen decision", () => {
    const body = renderSkipRecord({
      signals: { s1: true, s2: true, s3: true, s4: true, s5: true, allHold: true },
      decision: "skip", now: "2026-05-30T00:00:00Z",
    });
    expect(body).toBe(
      "timestamp: 2026-05-30T00:00:00Z\n" +
      "signals_passed: S1=true S2=true S3=true S4=true S5=true\n" +
      "user_decision: skip\n",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prelude-confidence.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/core/preludeConfidence.ts`**

```ts
// src/core/preludeConfidence.ts — the 5-signal confidence gate (port of directive Step 5.5,
// commands/meditate.md). Pure: draft text + findings texts → booleans. Signal defs in the spec.

export interface Signals { s1: boolean; s2: boolean; s3: boolean; s4: boolean; s5: boolean; allHold: boolean; }

/** Top approach = text of the first `^N. ` item under `## Approaches`, minus the `N. ` prefix,
 *  trailing space, and any ` — …` tail. "" if none. */
export function topApproach(draft: string): string {
  let inApproaches = false;
  for (const line of draft.split("\n")) {
    if (/^## Approaches/.test(line)) { inApproaches = true; continue; }
    if (/^## /.test(line)) { inApproaches = false; continue; }
    if (inApproaches) {
      const m = line.match(/^[0-9]+\.\s+(.+)$/);
      if (m) return m[1].replace(/\s+$/, "").replace(/\s+—.*$/, "").replace(/\s+$/, "");
    }
  }
  return "";
}

/** Citation tokens in the draft: file-ish `a/b.ext[:NN]` or a URL. Unique, order-preserving. */
export function draftCitations(draft: string): string[] {
  const re = /[A-Za-z_./-]+\.[a-z]+(?::[0-9]+)?|https?:\/\/[^ )"\\]+/g;
  const seen = new Set<string>();
  for (const m of draft.matchAll(re)) { const tok = m[0]; if (!seen.has(tok)) seen.add(tok); }
  return [...seen];
}

/** Count of "bad" matrix rows: within `## Tradeoff matrix`, a row whose 3rd (Reason) cell's first
 *  non-space char is neither `/` nor `:`. Faithful to grep -cE '^\| [^|]+\| [^|]+\| [^/:][^|]*\|$'. */
export function matrixBadRows(draft: string): number {
  let inMatrix = false, bad = 0;
  for (const line of draft.split("\n")) {
    if (/^## Tradeoff matrix/.test(line)) { inMatrix = true; continue; }
    if (/^## /.test(line)) { inMatrix = false; continue; }
    if (inMatrix && /^\| [^|]+\| [^|]+\| [^/:][^|]*\|$/.test(line)) bad++;
  }
  return bad;
}

const UNCERTAIN = /uncertain|unclear|depends on|could not determine|not sure|gap in evidence/i;

export function computeSignals(draft: string, findings: string[]): Signals {
  const n = findings.length;
  // S1: top-approach convergence — >= N-1 findings mention it (case-insensitive literal).
  const top = topApproach(draft);
  const hits = top ? findings.filter((f) => f.toLowerCase().includes(top.toLowerCase())).length : 0;
  const s1 = top !== "" && hits >= n - 1;
  // S2: every draft citation appears in >= 2 findings.
  let solo = 0;
  for (const cite of draftCitations(draft)) {
    const citers = findings.filter((f) => f.includes(cite)).length;
    if (citers < 2) solo++;
  }
  const s2 = solo === 0;
  // S3: no CONTESTED markers (case-insensitive).
  const s3 = !/CONTESTED/i.test(draft);
  // S4: every matrix Reason cell has a path/URL/paper anchor.
  const s4 = matrixBadRows(draft) === 0;
  // S5: >= 1 finding acknowledges uncertainty.
  const s5 = findings.some((f) => UNCERTAIN.test(f));
  return { s1, s2, s3, s4, s5, allHold: s1 && s2 && s3 && s4 && s5 };
}

export type Decision = "not-offered" | "skip" | "continue";

/** The adversary-skip.txt body (atomic-written by the verb). */
export function renderSkipRecord(input: { signals: Signals; decision: Decision; now: string }): string {
  const s = input.signals;
  return (
    `timestamp: ${input.now}\n` +
    `signals_passed: S1=${s.s1} S2=${s.s2} S3=${s.s3} S4=${s.s4} S5=${s.s5}\n` +
    `user_decision: ${input.decision}\n`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prelude-confidence.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/preludeConfidence.ts tests/prelude-confidence.test.ts
git commit -m "feat(prelude): 5-signal confidence gate + skip-record renderer"
```

---

### Task P4: prompt builders (`preludeTurn.ts`)

**Files:**
- Create: `src/core/preludeTurn.ts`
- Test: `tests/prelude-turn.test.ts`

Ports `config/prompt-templates/meditate/{research,adversary}.md` as string-builders (the consort
idiom — cf. `scoreTurn.ts`). Unlike score's inbox-appended done-line, **prelude prompts DO end with
the frozen done-event line + `END_OF_INSTRUCTION`** (the meditate templates include them, and prelude
sends via `send @file` which does not append a done instruction). `litGuidance(track)` returns the
ON/OFF block.

- [ ] **Step 1: Write the failing test**

```ts
// tests/prelude-turn.test.ts
import { describe, it, expect } from "vitest";
import { composePreludeResearchPrompt, composeAdversaryPrompt, litGuidance } from "../src/core/preludeTurn.js";

describe("litGuidance", () => {
  it("ON block prioritizes peer-reviewed papers", () => {
    expect(litGuidance("ON")).toMatch(/peer-reviewed/);
  });
  it("OFF block allows a brief SOTA section", () => {
    expect(litGuidance("OFF")).toMatch(/Not applicable|Brief SOTA/i);
  });
});

describe("composePreludeResearchPrompt", () => {
  const p = composePreludeResearchPrompt("attention kernels", "/art/findings-rex.md", litGuidance("ON"));
  it("contains topic, write-to, the lit-guidance, the done event, and the fence", () => {
    expect(p).toContain("attention kernels");
    expect(p).toContain("/art/findings-rex.md");
    expect(p).toContain("peer-reviewed");
    expect(p).toContain('{"event":"done"');
    expect(p.trimEnd().endsWith("END_OF_INSTRUCTION")).toBe(true);
  });
  it("frames it as landscape exposure, not recommendation", () => {
    expect(p).toMatch(/not a recommendation/i);
  });
});

describe("composeAdversaryPrompt", () => {
  const p = composeAdversaryPrompt("## Topic\nflash\n## Approaches\n1. A", "viola", "/art/adversary-viola.md");
  it("inlines the draft, names the instrument, targets the out-path, ends with the fence", () => {
    expect(p).toContain("## Approaches");
    expect(p).toContain("viola");
    expect(p).toContain("/art/adversary-viola.md");
    expect(p).toContain('{"event":"done"');
    expect(p.trimEnd().endsWith("END_OF_INSTRUCTION")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prelude-turn.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/core/preludeTurn.ts`**

Port the two templates verbatim (rebranded: Master Yoda→Maestro; trooper→part/fellow part). Bodies
end with `Then emit {"event":"done", ...} to your outbox.` then a blank line then `END_OF_INSTRUCTION`.

```ts
// src/core/preludeTurn.ts — research + adversary prompt builders for /consort:prelude
// (port of config/prompt-templates/meditate/{research,adversary}.md, rebranded). These bodies
// DO include the done-event line + END_OF_INSTRUCTION (prelude sends them as @file, unmodified).

const DONE_AND_FENCE = (summary: string): string =>
  `\nThen emit {"event":"done", "summary":"${summary}", "ts":"<iso>"} to your outbox.\n\nEND_OF_INSTRUCTION\n`;

/** The {{LIT_GUIDANCE}} block for the research prompt, keyed on the lit-track classification. */
export function litGuidance(track: "ON" | "OFF"): string {
  return track === "ON"
    ? "The topic is academic / SOTA-shaped. Prioritize peer-reviewed papers (arXiv, conference " +
      "proceedings) over blog posts or vendor docs. List 3+ recent papers, projects, or benchmarks " +
      "with citations including authors, year, venue, URL/DOI where available."
    : "The topic is not academic-shaped. Brief SOTA-evidence section is fine — list 1-2 anchor " +
      "sources or write 'Not applicable' with a one-line reason.";
}

/** Research-phase prompt (port of meditate/research.md). Expose the landscape; do NOT recommend. */
export function composePreludeResearchPrompt(topic: string, writeTo: string, lit: string): string {
  const t = topic.trim();
  return [
    "Investigate the following topic from multiple angles. Your job is not to",
    "recommend; your job is to expose the landscape — approaches, tradeoffs,",
    "SOTA evidence, and open questions.",
    "",
    `Topic: ${t}`,
    "",
    `Output requirements — write to ${writeTo} with this EXACT structure:`,
    "",
    `  # Findings: ${t}`,
    "",
    "  ## Summary",
    "  <2-3 sentence overview, free-form prose>",
    "",
    "  ## Approaches",
    "  1. [<citation>] <approach name> — <one-line description>",
    "  2. [<citation>] <approach name> — <one-line description>",
    "  ...",
    "",
    "  ## SOTA evidence",
    `  ${lit}`,
    "",
    "  ## Tradeoffs",
    "  - <approach A> wins on <criterion> because <reason with citation>",
    "  - <approach A> loses on <criterion> because <reason with citation>",
    "  ...",
    "",
    "  ## Independent Discovery",
    "  Files / URLs / papers you opened during research that go beyond what the",
    "  Maestro's identity prompt suggested. Cite at least 3 sources you found on",
    "  your own — this is an anti-correlated-blind-spots guard.",
    "",
    "  ## Open questions",
    "  - <question 1 that the research could not resolve>",
    "  - <question 2>",
    "",
    "  ## Notes",
    "  <any free-form additions; not parsed by the Maestro>",
    "",
    "Citation format options:",
    "  - <file path>:<line>          e.g. src/auth/store.py:42",
    "  - <file path>:<line-range>    e.g. src/auth/refresh.py:15-30",
    "  - <URL>                       e.g. https://arxiv.org/abs/2401.04088",
    "  - paper:<id>                  e.g. paper:arxiv:2401.04088",
    "  - runtime: <command>          e.g. runtime: pytest tests/test_x.py",
    "",
    "Every Approach AND every Tradeoff bullet MUST have a citation in [brackets].",
    "Bullets without citations will be silently dropped by the Maestro's synthesis —",
    "and if NO approach has a citation, your findings will be flagged as malformed.",
    "",
    "Research methods: use any tool available in your environment. When local",
    "evidence is insufficient or the topic references external knowledge (papers,",
    "RFCs, library docs, vendor APIs, benchmarks), you SHOULD use WebSearch /",
    "WebFetch (or the equivalent in your TUI) to find authoritative sources. Prefer",
    "primary sources over blog posts. If a tool is not available, fall back to",
    "local-only investigation and note the gap as an [unverified] claim.",
    "",
    "Important: this is NOT a recommendation phase. Do not pick a \"best\" approach.",
    "Surface the landscape; the Maestro will synthesize the tradeoff matrix and a",
    "separate adversary round will challenge the synthesis before the final landscape",
    "doc is written.",
    DONE_AND_FENCE("researched " + t),
  ].join("\n");
}

/** Adversary-phase prompt (port of meditate/adversary.md). Inlines the draft to challenge. */
export function composeAdversaryPrompt(landscapeDraft: string, instrument: string, outPath: string): string {
  return [
    "You are now playing adversary against a synthesized landscape doc that",
    "was built from your earlier research findings (and the findings of your",
    "fellow parts). Your job is to break confidence in the synthesis — not",
    "to validate it.",
    "",
    "Default to skepticism. Assume the synthesis can fail in subtle, high-cost,",
    "or hard-to-detect ways until evidence says otherwise. Do not give credit",
    "for good intent or partial coverage.",
    "",
    "The synthesis to challenge:",
    "",
    landscapeDraft,
    "",
    "Attack surface — prioritize these failure modes:",
    "- Approaches that were missed or wrongly excluded from the landscape",
    "- Tradeoff matrix rows where the \"Best fit\" assignment is wrong or weakly justified",
    "- Citations that don't actually support the claim attached to them",
    "  (open the cited file/URL and verify the claim is grounded)",
    "- Convergent findings across parts that may share a correlated blind spot",
    "- Frames the synthesis adopted that exclude valid alternative frames",
    "- Open questions that should have been answered but were filed instead",
    "- SOTA claims that are stale (paper from 3+ years ago marked \"current SOTA\")",
    "",
    `Output requirements — write to ${outPath}:`,
    "",
    `  # Adversary critique: ${instrument}'s pass`,
    "",
    "  ## Verdict",
    "  <one line: needs-attention | minor-revisions | accept>",
    "",
    "  ## Material findings",
    "  Each finding answers:",
    "  1. What is the weakness in the synthesis?",
    "  2. Why is that synthesis claim vulnerable?",
    "  3. What concrete change to the landscape doc would reduce the risk?",
    "",
    "  ### Finding 1: <one-line summary>",
    "  - **Targets:** <which section/row/citation in the draft>",
    "  - **Why vulnerable:** <evidence the claim is shaky, with new citation>",
    "  - **Concrete fix:** <what to change in the landscape doc>",
    "",
    "  ### Finding 2: ...",
    "",
    "  ## Notes",
    "  <optional free-form additions>",
    "",
    "Calibration rules:",
    "- Prefer one strong finding over several weak ones",
    "- Do not dilute serious issues with stylistic nits",
    "- If the synthesis looks defensible, say so directly and return zero findings",
    "  (verdict: accept). Padding with weak adversarial reaches is worse than admitting",
    "  the draft is sound.",
    "- Be aggressive but stay grounded — every finding must be defensible from the",
    "  cited evidence, not speculative",
    DONE_AND_FENCE("adversary critique done"),
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prelude-turn.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/preludeTurn.ts tests/prelude-turn.test.ts
git commit -m "feat(prelude): research + adversary prompt builders"
```

---

### Task P5: handoff extraction (`preludeHandoff.ts`)

**Files:**
- Create: `src/core/preludeHandoff.ts`
- Test: `tests/prelude-handoff.test.ts`

Port of `cw_meditate_extract_handoff_data` (lib/meditate.sh) **with the approved reconciliation**:
read `adversary-skip.txt` for `confidence_signals` and glob `adversary-*.md` for
`adversary_findings_paths` (clone-wars read never-written `confidence-record.txt` /
`adversary-findings-*.md`). Key set + order is FROZEN (spec §6). `buildHandoffKv` is pure;
`extractHandoffData` does file I/O + atomic write.

- [ ] **Step 1: Write the failing test**

```ts
// tests/prelude-handoff.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHandoffKv, extractHandoffData } from "../src/core/preludeHandoff.js";

describe("buildHandoffKv", () => {
  it("emits the frozen key order with convergence", () => {
    const kv = buildHandoffKv({
      topic: "attention kernels", landscapeDoc: "landscape-2026-05-30-attention.md",
      topApproach: "FlashAttention", findingsPaths: ["findings-rex.md", "findings-viola.md"],
      confidenceSignals: "S1=true,S2=true,S3=true,S4=true,S5=true",
      adversaryFindingsPaths: ["adversary-rex.md"], tradeoffMatrixPresent: true,
      generatedTs: "2026-05-30T00:00:00Z",
    });
    expect(kv).toBe(
      "mode=prelude\n" +
      "topic=attention kernels\n" +
      "landscape_doc=landscape-2026-05-30-attention.md\n" +
      "top_approach=FlashAttention\n" +
      "findings_paths=findings-rex.md,findings-viola.md\n" +
      "confidence_signals=S1=true,S2=true,S3=true,S4=true,S5=true\n" +
      "adversary_findings_paths=adversary-rex.md\n" +
      "tradeoff_matrix_present=true\n" +
      "session_path=.\n" +
      "topic_txt_path=topic.txt\n" +
      "generated_ts=2026-05-30T00:00:00Z\n",
    );
  });
  it("mode=prelude-no-convergence when top_approach empty (and omits related lines)", () => {
    const kv = buildHandoffKv({
      topic: "x", landscapeDoc: "landscape-draft.md", topApproach: "",
      findingsPaths: [], confidenceSignals: "", adversaryFindingsPaths: [],
      tradeoffMatrixPresent: false, generatedTs: "2026-05-30T00:00:00Z",
    });
    expect(kv).toContain("mode=prelude-no-convergence\n");
    expect(kv).not.toContain("top_approach=");
    expect(kv).not.toContain("findings_paths=");
    expect(kv).toContain("tradeoff_matrix_present=false\n");
  });
});

describe("extractHandoffData (reconciled reads)", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "prelude-art-"));
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
      expect(kv).toContain("mode=prelude\n");
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
      writeFileSync(join(art, "viola_adversary_prompt.md"), "prompt");
      writeFileSync(join(art, "adversary-viola.md"), "critique");
      const kv = readFileSync(extractHandoffData(art)!, "utf8");
      expect(kv).toContain("adversary_findings_paths=adversary-viola.md\n");
    } finally { rmSync(art, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prelude-handoff.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/core/preludeHandoff.ts`**

```ts
// src/core/preludeHandoff.ts — handoff-data.kv extraction for /consort:prelude (port of
// cw_meditate_extract_handoff_data, lib/meditate.sh). RECONCILED reads: confidence_signals from
// adversary-skip.txt, adversary_findings_paths from adversary-*.md (clone-wars read filenames the
// directive never wrote). Key set + order is FROZEN.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic.js";
import { isoUtc } from "./archive.js";
import { topApproach } from "./preludeConfidence.js"; // reuse the same first-approach scan

export interface HandoffInput {
  topic: string;
  landscapeDoc?: string;
  topApproach: string;
  findingsPaths: string[];
  confidenceSignals: string;
  adversaryFindingsPaths: string[];
  tradeoffMatrixPresent: boolean;
  generatedTs: string;
}

/** handoff-data.kv body. Key ORDER is load-bearing. Conditional lines omitted when empty. */
export function buildHandoffKv(i: HandoffInput): string {
  const L: string[] = [];
  L.push(`mode=${i.topApproach ? "prelude" : "prelude-no-convergence"}`);
  L.push(`topic=${i.topic}`);
  if (i.landscapeDoc) L.push(`landscape_doc=${i.landscapeDoc}`);
  if (i.topApproach) L.push(`top_approach=${i.topApproach}`);
  if (i.findingsPaths.length) L.push(`findings_paths=${i.findingsPaths.join(",")}`);
  if (i.confidenceSignals) L.push(`confidence_signals=${i.confidenceSignals}`);
  if (i.adversaryFindingsPaths.length) L.push(`adversary_findings_paths=${i.adversaryFindingsPaths.join(",")}`);
  L.push(`tradeoff_matrix_present=${i.tradeoffMatrixPresent}`);
  L.push("session_path=.");
  L.push("topic_txt_path=topic.txt");
  L.push(`generated_ts=${i.generatedTs}`);
  return L.join("\n") + "\n";
}

function readIf(p: string): string | null { return existsSync(p) ? readFileSync(p, "utf8") : null; }

/** Walk an art dir → write handoff-data.kv. Returns the path, or null if art-dir/topic.txt missing. */
export function extractHandoffData(artDir: string, now?: Date): string | null {
  if (!existsSync(artDir) || !statSync(artDir).isDirectory()) return null;
  const topicTxt = readIf(join(artDir, "topic.txt"));
  if (topicTxt === null) return null;
  const topic = topicTxt.replace(/\n/g, " ").replace(/ +$/, "");

  const names = readdirSync(artDir);
  // landscape: prefer the non-draft (final) match, else landscape-draft.md.
  const landscapes = names.filter((n) => /^landscape-.*\.md$/.test(n));
  const landscapeDoc = landscapes.find((n) => n !== "landscape-draft.md")
    ?? (landscapes.includes("landscape-draft.md") ? "landscape-draft.md" : undefined);

  const findingsPaths = names.filter((n) => /^findings-.*\.md$/.test(n)).sort();
  const adversaryFindingsPaths = names.filter((n) => /^adversary-.*\.md$/.test(n)).sort();

  let top = "", tradeoff = false;
  if (landscapeDoc) {
    const doc = readFileSync(join(artDir, landscapeDoc), "utf8");
    top = topApproach(doc);
    tradeoff = /^## Tradeoff matrix/m.test(doc);
  }

  // RECONCILED: confidence_signals from adversary-skip.txt's signals_passed line → CSV.
  let confidenceSignals = "";
  const skip = readIf(join(artDir, "adversary-skip.txt"));
  if (skip) {
    const m = skip.split("\n").find((l) => l.startsWith("signals_passed:"));
    if (m) confidenceSignals = m.replace(/^signals_passed:\s*/, "").trim().replace(/\s+/g, ",");
  }

  const body = buildHandoffKv({
    topic, landscapeDoc, topApproach: top, findingsPaths, confidenceSignals,
    adversaryFindingsPaths, tradeoffMatrixPresent: tradeoff, generatedTs: isoUtc(now),
  });
  const dest = join(artDir, "handoff-data.kv");
  atomicWrite(dest, body);
  return dest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prelude-handoff.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/preludeHandoff.ts tests/prelude-handoff.test.ts
git commit -m "feat(prelude): reconciled handoff-data.kv extraction"
```

---

### Task P6: command scaffold + `init` verb + dispatcher

**Files:**
- Create: `src/commands/prelude.ts`
- Modify: `src/consort.ts` (register the handler)
- Test: `tests/prelude-cmd.test.ts`

`init` mirrors `score.ts::initWith` minus `--ensemble`/`--targets` (meditate has no flags). DI pattern:
`PreludeInitDeps` + `initWith(tokens, deps)` + `livePreludeInitDeps`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/prelude-cmd.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { initWith, type PreludeInitDeps } from "../src/commands/prelude.js";
import { preludeArtDir } from "../src/core/prelude.js";

function initDeps(over: Partial<PreludeInitDeps> = {}): PreludeInitDeps {
  return {
    activeProviders: () => ["codex", "claude"],
    isValidated: () => true,
    pickInstruments: (_t, n) => ["viola", "cello", "oboe"].slice(0, n),
    ...over,
  };
}

describe("prelude init", () => {
  it("scaffolds _prelude with topic.txt + roster.txt for N=2", async () => {
    const { cleanup } = freshHome();
    try {
      const rc = await initWith(["attention", "kernels"], initDeps());
      expect(rc).toBe(0);
      const art = preludeArtDir("attention-kernels");
      expect(existsSync(join(art, "topic.txt"))).toBe(true);
      expect(readFileSync(join(art, "topic.txt"), "utf8")).toBe("attention kernels");
      expect(readFileSync(join(art, "roster.txt"), "utf8")).toContain("codex\tviola");
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
      expect(readFileSync(join(preludeArtDir("x"), "roster.txt"), "utf8").split("\n").filter((l) => l.includes("\t")).length).toBe(3);
    } finally { cleanup(); }
  });
  it("rc2 when _prelude already exists", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const rc = await initWith(["x"], initDeps());
      expect(rc).toBe(2);
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prelude-cmd.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `src/commands/prelude.ts` with the dispatcher + `init`**

```ts
// src/commands/prelude.ts — /consort:prelude CLI verbs (port of meditate). Built on score's DI
// pattern + IPC/wait/archive helpers; meditate-specific logic lives in src/core/prelude*.ts.
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc, archiveTopic } from "../core/archive.js";
import { preludeArtDir, deriveSlug } from "../core/prelude.js";
import {
  type RosterRow, formatRosterFile, parseRosterFile, spawnRosterArg, spawnResultsTsv, spawnTally,
  parsePanesFile, type SpawnResult,
} from "../core/score.js";
import { readProviderList } from "../core/providers.js";
import { activeProvidersPath, partDir, repoRoot } from "../core/paths.js";
import { pickInstruments } from "../core/instruments.js";
import { instrumentConsultValidated, consultTimeout, instrumentTimeoutMultiplier } from "../core/contracts.js";
import { outboxOffset, outboxPath, outboxWaitSince, type OutboxEvent } from "../core/ipc.js";
import { parseLatestOffset, scaledTimeout, researchState, verifyState } from "../core/scoreTurn.js";
import { classifyTopic } from "../core/preludeLit.js";
import { composePreludeResearchPrompt, composeAdversaryPrompt, litGuidance } from "../core/preludeTurn.js";
import { computeSignals, renderSkipRecord, type Decision } from "../core/preludeConfidence.js";
import { extractHandoffData } from "../core/preludeHandoff.js";
import { captureArtDir } from "../core/forensics.js";
import { killNow } from "../core/tmux.js";
import { run as sendRun } from "./send.js";
import { run as spawnRun } from "./spawn.js";
import { run as preflightRun } from "./preflight.js";

function usage(): number {
  log.error("usage: prelude <init|classify|spawn-all|research-send|research-wait|synth-preliminary|" +
    "confidence|adversary-send|adversary-wait|synth-final|forensics|teardown|handoff-extract> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest));
    case "classify": return classifyRun(rest);
    case "spawn-all": return spawnAllRun(rest);
    case "research-send": return researchSendRun(rest);
    case "research-wait": return researchWaitRun(rest);
    case "synth-preliminary": return synthPreliminaryRun(rest);
    case "confidence": return confidenceRun(rest);
    case "adversary-send": return adversarySendRun(rest);
    case "adversary-wait": return adversaryWaitRun(rest);
    case "synth-final": return synthFinalRun(rest);
    case "forensics": return forensicsRun(rest);
    case "teardown": return teardownRun(rest);
    case "handoff-extract": return handoffExtractRun(rest);
    default: return usage();
  }
}

const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

// ---- init ----

export interface PreludeInitDeps {
  activeProviders(): string[];
  isValidated(provider: string): boolean;
  pickInstruments(topic: string, n: number): string[];
}
const livePreludeInitDeps: PreludeInitDeps = {
  activeProviders: () => readProviderList(activeProvidersPath()),
  isValidated: instrumentConsultValidated,
  pickInstruments,
};
async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, livePreludeInitDeps); }

export async function initWith(tokens: string[], d: PreludeInitDeps): Promise<number> {
  const topicText = tokens.join(" ").trim();
  if (!topicText) { log.error("prelude init: topic text is empty"); return 1; }
  const topic = deriveSlug(topicText);
  if (!topic) { log.error("prelude init: topic produced an empty slug; provide alphanumerics"); return 1; }

  let roster = d.activeProviders().filter((p) => d.isValidated(p));
  if (roster.length < 2) {
    log.error(`prelude init: needs >=2 consult-validated providers; got ${roster.length}`);
    log.error("  just ask Claude directly (this session) — no /consort:prelude orchestration needed");
    return 1;
  }
  if (roster.length > 3) { log.warn(`prelude init: ${roster.length} providers available; capping to the first 3`); roster = roster.slice(0, 3); }

  const art = preludeArtDir(topic);
  if (existsSync(art)) { log.error(`prelude init: topic already in flight: ${art}`); log.error("  run /consort:coda or pick a different topic"); return 2; }

  const instruments = d.pickInstruments(topic, roster.length);
  if (instruments.length < roster.length) { log.error(`prelude init: instrument pool exhausted (need ${roster.length}, got ${instruments.length})`); return 1; }
  const rows: RosterRow[] = roster.map((provider, i) => ({ provider, instrument: instruments[i] }));

  mkdirSync(art, { recursive: true });
  atomicWrite(join(art, "topic.txt"), topicText);
  atomicWrite(join(art, "roster.txt"), formatRosterFile(rows, isoUtc()));

  log.ok(`prelude init: topic=${topic} N=${rows.length}`);
  process.stdout.write(
    `TOPIC=${topic}\nN=${rows.length}\nART=${art}\n` +
    rows.map((r) => `PART=${r.instrument}:${r.provider}`).join("\n") + "\n",
  );
  return 0;
}
```

> NOTE: `formatRosterFile` writes the header `# generated <iso> by /consort:score`. That is
> acceptable (it's an internal comment, not a stale token). If a reviewer objects, leave it — do
> NOT introduce a new formatter just for the comment string.

- [ ] **Step 4: Register the handler in `src/consort.ts`**

Add `prelude` to the dynamic import array and the returned map (mirror `rehearsal`):

```ts
  const [spawn, send, collect, roster, coda, soundcheck, preflight, hook, solo, score, perform, playback, rehearsal, prelude] = await Promise.all([
    import("./commands/spawn.js"), import("./commands/send.js"), import("./commands/collect.js"),
    import("./commands/roster.js"), import("./commands/coda.js"), import("./commands/soundcheck.js"),
    import("./commands/preflight.js"), import("./commands/hook.js"), import("./commands/solo.js"),
    import("./commands/score.js"), import("./commands/perform.js"), import("./commands/playback.js"),
    import("./commands/rehearsal.js"), import("./commands/prelude.js"),
  ]);
  return {
    spawn: spawn.run, send: send.run, collect: collect.run, roster: roster.run,
    coda: coda.run, soundcheck: soundcheck.run, preflight: preflight.run, hook: hook.run,
    solo: solo.run, score: score.run, perform: perform.run, playback: playback.run,
    rehearsal: rehearsal.run, prelude: prelude.run,
  };
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run tests/prelude-cmd.test.ts` → PASS. `npm run typecheck` → clean.
(Some imports in P6 are unused until later tasks add their verbs — to keep lint/typecheck green,
add the verb stubs in this task's file as `async function <verb>Run(): Promise<number> { return 0; }`
placeholders ONLY for verbs not yet implemented, OR implement P7–P12 before the first
`npm run lint`. Cleanest: implement the dispatcher `case` arms but have each later verb's `*Run`
land in its own task. To avoid unused-import lint errors mid-stream, import each helper in the task
that first uses it. **Executor:** if `no-unused-vars` fails in P6, move the not-yet-used imports into
the task that introduces them.)

- [ ] **Step 6: Commit**

```bash
git add src/commands/prelude.ts src/consort.ts tests/prelude-cmd.test.ts
git commit -m "feat(prelude): command scaffold + init verb + dispatcher"
```

---

### Task P7: `classify` verb

**Files:**
- Modify: `src/commands/prelude.ts` (add `classifyRun`)
- Test: `tests/prelude-cmd.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

```ts
import { classifyRun } from "../src/commands/prelude.js"; // add to imports
// ...
describe("prelude classify", () => {
  it("writes lit-track.txt = ON for an academic topic", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["attention", "architectures"], initDeps());
      const rc = await classifyRun(["attention-architectures"]);
      expect(rc).toBe(0);
      const lt = readFileSync(join(preludeArtDir("attention-architectures"), "lit-track.txt"), "utf8");
      expect(lt.startsWith("ON\n")).toBe(true);
      expect(lt).toContain("reason: auto-detect via keyword scan");
    } finally { cleanup(); }
  });
  it("rc1 when the art dir is missing", async () => {
    const { cleanup } = freshHome();
    try { expect(await classifyRun(["nope"])).toBe(1); } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run → FAIL** (`classifyRun` not exported).

- [ ] **Step 3: Implement `classifyRun`**

```ts
// ---- classify (lit auto-detect) ----
export async function classifyRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: prelude classify <topic>"); return 2; }
  const art = preludeArtDir(topic);
  if (!existsSync(art)) { log.error(`prelude classify: ${art} not found (run prelude init)`); return 1; }
  const topicText = readIf(join(art, "topic.txt")).trim();
  const track = classifyTopic(topicText);
  atomicWrite(join(art, "lit-track.txt"), `${track}\nreason: auto-detect via keyword scan\n`);
  log.ok(`prelude classify: lit-track=${track}`);
  return 0;
}
```

- [ ] **Step 4: Run → PASS.** `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/prelude.ts tests/prelude-cmd.test.ts
git commit -m "feat(prelude): classify verb (writes lit-track.txt)"
```

---

### Task P8: `spawn-all` verb

**Files:**
- Modify: `src/commands/prelude.ts` (add `spawnAllRun` + `SpawnAllDeps`)
- Test: `tests/prelude-cmd.test.ts` (append)

Mirror `score.ts::spawnAllWith` exactly, swapping `scoreArtDir` → `preludeArtDir`. (Reads
`roster.txt`, preflights panes, spawns N parts in parallel, writes `spawn-results.tsv`, returns
`spawnTally`.)

- [ ] **Step 1: Write the failing test (append)** — injected preflight/spawn deps, no real tmux:

```ts
import { spawnAllWith, type PreludeSpawnAllDeps } from "../src/commands/prelude.js";
import { writeFileSync } from "node:fs";
// ...
describe("prelude spawn-all", () => {
  it("preflights then spawns each roster part; rc0 when all ok", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      const deps: PreludeSpawnAllDeps = {
        preflight: async () => { writeFileSync(join(art, "preflight-panes.txt"), "viola\t%1\ncello\t%2\n"); return 0; },
        spawn: async () => 0,
        repoRoot: () => "/repo",
      };
      const rc = await spawnAllWith("x", deps);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "spawn-results.tsv"), "utf8")).toContain("viola\tcodex\t0");
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (copy `score.ts::spawnAllWith` + `SpawnAllDeps`, rename to
`PreludeSpawnAllDeps`, swap `scoreArtDir`→`preludeArtDir`):

```ts
// ---- spawn-all ----
export interface PreludeSpawnAllDeps {
  preflight(args: string[]): Promise<number>;
  spawn(args: string[]): Promise<number>;
  repoRoot(): string;
}
const livePreludeSpawnAllDeps: PreludeSpawnAllDeps = { preflight: preflightRun, spawn: spawnRun, repoRoot };

async function spawnAllRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: prelude spawn-all <topic>"); return 2; }
  return spawnAllWith(topic, livePreludeSpawnAllDeps);
}

export async function spawnAllWith(topic: string, d: PreludeSpawnAllDeps): Promise<number> {
  const art = preludeArtDir(topic);
  const rosterPath = join(art, "roster.txt");
  if (!existsSync(rosterPath)) { log.error(`prelude spawn-all: roster.txt missing at ${rosterPath} (run prelude init)`); return 2; }
  const rows = parseRosterFile(readFileSync(rosterPath, "utf8"));
  if (rows.length < 2) { log.error(`prelude spawn-all: need >=2 parts in roster.txt, got ${rows.length}`); return 2; }

  const pf = await d.preflight([topic, String(rows.length), "--roster", spawnRosterArg(rows), "--art-dir", art]);
  if (pf !== 0) { log.error(`prelude spawn-all: preflight failed (rc=${pf})`); return 2; }

  const panesPath = join(art, "preflight-panes.txt");
  if (!existsSync(panesPath)) { log.error(`prelude spawn-all: preflight wrote no ${panesPath}`); return 2; }
  const panes = parsePanesFile(readFileSync(panesPath, "utf8"));
  const orphans = rows.filter((r) => !panes.has(r.instrument));
  if (orphans.length) { log.error(`prelude spawn-all: parts missing a preflight pane: ${orphans.map((r) => r.instrument).join(", ")}`); return 2; }

  const cwd = d.repoRoot();
  const results: SpawnResult[] = await Promise.all(rows.map(async (r) => {
    const rc = await d.spawn([r.instrument, r.provider, topic, "--target-pane", panes.get(r.instrument)!, "--cwd", cwd]);
    return { instrument: r.instrument, provider: r.provider, rc };
  }));
  atomicWrite(join(art, "spawn-results.tsv"), spawnResultsTsv(results));

  const rc = spawnTally(results.map((r) => r.rc));
  const nOk = results.filter((r) => r.rc === 0).length;
  if (rc === 0) log.ok(`prelude spawn-all: ${nOk}/${rows.length} parts ready`);
  else log.warn(`prelude spawn-all: ${nOk}/${rows.length} parts ready (rc=${rc})`);
  return rc;
}
```

- [ ] **Step 4: Run → PASS.** `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/prelude.ts tests/prelude-cmd.test.ts
git commit -m "feat(prelude): spawn-all verb (preflight + parallel spawn)"
```

---

### Task P9: `research-send` + `research-wait` verbs

**Files:**
- Modify: `src/commands/prelude.ts`
- Test: `tests/prelude-cmd.test.ts` (append)

Mirror `score.ts::researchSendWith`/`researchWaitWith`, with the **art-dir-flat findings path**:
`join(preludeArtDir(topic), "findings-<instrument>.md")` (NOT `partDir`), and the lit-guidance
injection from `lit-track.txt`. Outbox offset/wait still use `outboxPath(instrument, provider, topic)`.

- [ ] **Step 1: Write the failing test (append)**

```ts
import { researchSendWith, researchWaitWith, type ResearchSendDeps, type ResearchWaitDeps } from "../src/commands/prelude.js";
// ...
describe("prelude research-send/wait", () => {
  it("send renders prompt to <inst>_research_prompt.md and writes the offset state", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      await classifyRun(["x"]);
      const art = preludeArtDir("x");
      let sent: string[] = [];
      const deps: ResearchSendDeps = { offsetFor: () => 7, send: async (a) => { sent = a; return 0; } };
      const rc = await researchSendWith("x", "viola", "codex", deps);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "research-viola.txt"), "utf8")).toContain("OFFSET=7");
      const prompt = readFileSync(join(art, "viola_research_prompt.md"), "utf8");
      expect(prompt).toContain(join(art, "findings-viola.md"));
      expect(sent).toEqual(["--from", "maestro", "viola", "x", `@${join(art, "viola_research_prompt.md")}`]);
    } finally { cleanup(); }
  });
  it("wait classifies a done event with findings as FS=ok and writes the .done sentinel", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "research-viola.txt"), "OFFSET=0\n");
      writeFileSync(join(art, "findings-viola.md"), "## Claims\n1. [src/a.ts:1] x\n");
      const deps: ResearchWaitDeps = { wait: async () => ({ event: "done" } as any), multiplier: () => "1" };
      const rc = await researchWaitWith("x", "viola", "codex", deps);
      expect(rc).toBe(0);
      expect(existsSync(join(art, "research-viola.done"))).toBe(true);
      expect(readFileSync(join(art, "research-viola.txt"), "utf8")).toContain("FS=ok");
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (the `ResearchSendDeps`/`ResearchWaitDeps` interfaces + `*With` + live deps,
copied from `score.ts` with the findings path swapped to art-dir-flat and lit-guidance injected):

```ts
// ---- research-send / research-wait ----
export interface ResearchSendDeps {
  offsetFor(instrument: string, model: string, topic: string): number;
  send(args: string[]): Promise<number>;
}
const liveResearchSendDeps: ResearchSendDeps = {
  offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)),
  send: sendRun,
};
async function researchSendRun(rest: string[]): Promise<number> {
  const [topic, instrument, provider] = rest;
  if (!topic || !instrument || !provider) { log.error("usage: prelude research-send <topic> <instrument> <provider>"); return 2; }
  return researchSendWith(topic, instrument, provider, liveResearchSendDeps);
}
export async function researchSendWith(topic: string, instrument: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = preludeArtDir(topic);
  const stateFile = join(art, `research-${instrument}.txt`);
  if (existsSync(stateFile)) { log.error(`prelude research-send: ${stateFile} exists; rm to retry`); return 1; }
  const topicText = readIf(join(art, "topic.txt")).trim();
  if (!topicText) { log.error(`prelude research-send: topic.txt missing/empty at ${art} (run prelude init)`); return 1; }

  const track = readIf(join(art, "lit-track.txt")).startsWith("ON") ? "ON" : "OFF";
  const findingsPath = join(art, `findings-${instrument}.md`); // art-dir-flat (faithful to meditate)
  const promptFile = join(art, `${instrument}_research_prompt.md`);
  atomicWrite(promptFile, composePreludeResearchPrompt(topicText, findingsPath, litGuidance(track)));

  const offset = d.offsetFor(instrument, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "maestro", instrument, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`prelude research-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`prelude research-send: ${instrument} offset=${offset}`);
  return 0;
}

export interface ResearchWaitDeps {
  wait(instrument: string, model: string, topic: string, offset: number, events: string[], timeoutSec: number): Promise<OutboxEvent | null>;
  multiplier(provider: string): string;
}
const liveResearchWaitDeps: ResearchWaitDeps = {
  wait: (i, m, t, off, ev, to) => outboxWaitSince(i, m, t, off, ev, to),
  multiplier: instrumentTimeoutMultiplier,
};
async function researchWaitRun(rest: string[]): Promise<number> {
  const [topic, instrument, provider] = rest;
  if (!topic || !instrument || !provider) { log.error("usage: prelude research-wait <topic> <instrument> <provider>"); return 2; }
  return researchWaitWith(topic, instrument, provider, liveResearchWaitDeps);
}
export async function researchWaitWith(topic: string, instrument: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = preludeArtDir(topic);
  const stateFile = join(art, `research-${instrument}.txt`);
  if (!existsSync(stateFile)) { log.error(`prelude research-wait: ${stateFile} missing (run prelude research-send first)`); return 1; }
  const offset = parseLatestOffset(readFileSync(stateFile, "utf8"));
  if (offset === null) { log.error(`prelude research-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("research"), d.multiplier(provider));
  log.info(`prelude research-wait: ${instrument} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(instrument, provider, topic, offset, ["done", "error", "question"], timeout);

  const findingsPath = join(art, `findings-${instrument}.md`);
  const findingsText = existsSync(findingsPath) ? readFileSync(findingsPath, "utf8") : null;
  const fs = researchState(ev, findingsText);
  if (fs === "question" && ev) {
    atomicWrite(join(art, `question-${instrument}.txt`), JSON.stringify(ev) + "\n");
    const bumped = outboxOffset(outboxPath(instrument, provider, topic));
    appendFileSync(stateFile, `OFFSET=${bumped}\nFS=question\n`);
  } else {
    appendFileSync(stateFile, `FS=${fs}\n`);
  }
  writeFileSync(join(art, `research-${instrument}.done`), "");
  log.ok(`prelude research-wait: ${instrument} FS=${fs}`);
  return 0;
}
```

- [ ] **Step 4: Run → PASS.** `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/prelude.ts tests/prelude-cmd.test.ts
git commit -m "feat(prelude): research-send + research-wait (art-dir-flat findings + lit-guidance)"
```

---

### Task P10: `synth-preliminary` + `confidence` verbs

**Files:**
- Modify: `src/commands/prelude.ts`
- Test: `tests/prelude-cmd.test.ts` (append)

`synth-preliminary` is the input validator (require topic.txt + roster.txt + every
`findings-<instrument>.md`; print the draft path). `confidence` computes S1–S5, prints
`ALL_HOLD`, and records `adversary-skip.txt` (no-flag not-offered / `--decision` path).

- [ ] **Step 1: Write the failing test (append)**

```ts
import { synthPreliminaryRun, confidenceRun } from "../src/commands/prelude.js";
// ...
async function seedFindings(art: string, draft: string): Promise<void> {
  writeFileSync(join(art, "findings-viola.md"), "FlashAttention is fast. https://x.test/p . uncertain about batch.");
  writeFileSync(join(art, "findings-cello.md"), "FlashAttention wins. https://x.test/p .");
  writeFileSync(join(art, "landscape-draft.md"), draft);
}
const DRAFT = [
  "## Approaches", "1. FlashAttention — fused", "## Tradeoff matrix",
  "| Priority | Best fit | Reason |", "| latency | FlashAttention | https://x.test/p |", "## Citations", "- https://x.test/p",
].join("\n");

describe("prelude synth-preliminary", () => {
  it("prints the draft path when all findings exist", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "findings-viola.md"), "a"); writeFileSync(join(art, "findings-cello.md"), "b");
      const rc = await synthPreliminaryRun(["x"]);
      expect(rc).toBe(0);
    } finally { cleanup(); }
  });
  it("rc1 when a part's findings are missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      writeFileSync(join(preludeArtDir("x"), "findings-viola.md"), "a"); // cello missing
      expect(await synthPreliminaryRun(["x"])).toBe(1);
    } finally { cleanup(); }
  });
});

describe("prelude confidence", () => {
  it("no-flag + not-all-hold writes adversary-skip.txt with user_decision: not-offered", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
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
      const art = preludeArtDir("x");
      await seedFindings(art, DRAFT);
      const rc = await confidenceRun(["x", "--decision", "skip"]);
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "adversary-skip.txt"), "utf8")).toContain("user_decision: skip");
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement both verbs**

```ts
// ---- synth-preliminary (input validator) ----
async function synthPreliminaryRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: prelude synth-preliminary <topic>"); return 2; }
  const art = preludeArtDir(topic);
  if (!existsSync(art)) { log.error(`prelude synth-preliminary: ${art} not found — run prelude init`); return 1; }
  for (const f of ["topic.txt", "roster.txt"]) {
    if (!readIf(join(art, f)).trim()) { log.error(`prelude synth-preliminary: missing or empty: ${join(art, f)}`); return 1; }
  }
  const rows = parseRosterFile(readIf(join(art, "roster.txt")));
  const missing = rows.filter((r) => !readIf(join(art, `findings-${r.instrument}.md`)).trim()).map((r) => `findings-${r.instrument}.md`);
  if (missing.length) {
    log.error("prelude synth-preliminary: blocked — missing or empty findings:");
    for (const m of missing) log.error(`  - ${join(art, m)}`);
    return 1;
  }
  const out = join(art, "landscape-draft.md");
  log.ok(`prelude synth-preliminary: inputs validated for ${topic}`);
  process.stdout.write(out + "\n");
  return 0;
}

// ---- confidence (5-signal gate; two-call contract) ----
async function confidenceRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: prelude confidence <topic> [--decision skip|continue]"); return 2; }
  let decision: Decision | null = null;
  const di = rest.indexOf("--decision");
  if (di >= 0) {
    const v = rest[di + 1];
    if (v !== "skip" && v !== "continue") { log.error("prelude confidence: --decision must be 'skip' or 'continue'"); return 2; }
    decision = v;
  }
  const art = preludeArtDir(topic);
  const draft = readIf(join(art, "landscape-draft.md"));
  if (!draft.trim()) { log.error(`prelude confidence: landscape-draft.md missing/empty at ${art}`); return 1; }
  const rows = parseRosterFile(readIf(join(art, "roster.txt")));
  const findings = rows.map((r) => readIf(join(art, `findings-${r.instrument}.md`)));

  const s = computeSignals(draft, findings);
  log.info(`prelude confidence: S1=${s.s1} S2=${s.s2} S3=${s.s3} S4=${s.s4} S5=${s.s5} — ALL_HOLD=${s.allHold}`);
  process.stdout.write(`ALL_HOLD=${s.allHold}\n`);

  if (decision) { // --decision path: record the user's choice
    atomicWrite(join(art, "adversary-skip.txt"), renderSkipRecord({ signals: s, decision, now: isoUtc() }));
    return 0;
  }
  if (!s.allHold) { // gate not offered → record not-offered, fall through to adversary
    atomicWrite(join(art, "adversary-skip.txt"), renderSkipRecord({ signals: s, decision: "not-offered", now: isoUtc() }));
  }
  // ALL_HOLD=true with no flag: write nothing — the Maestro asks, then re-invokes with --decision.
  return 0;
}
```

- [ ] **Step 4: Run → PASS.** `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/prelude.ts tests/prelude-cmd.test.ts
git commit -m "feat(prelude): synth-preliminary validator + confidence gate (two-call)"
```

---

### Task P11: `adversary-send` + `adversary-wait` verbs

**Files:**
- Modify: `src/commands/prelude.ts`
- Test: `tests/prelude-cmd.test.ts` (append)

`adversary-send` guards `landscape-draft.md` non-empty, renders the adversary prompt (inlining the
draft), writes `adversary-<instrument>.md`. `adversary-wait` reuses `verifyState` (done → ok iff the
adversary file is non-empty — matches `cw_consult_wait adversary`'s `-s` check), timeout
`consultTimeout("adversary")`.

- [ ] **Step 1: Write the failing test (append)**

```ts
import { adversarySendWith, adversaryWaitWith } from "../src/commands/prelude.js";
// ...
describe("prelude adversary-send/wait", () => {
  it("send guards the draft, renders the prompt, writes offset state", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "## Approaches\n1. A");
      let sent: string[] = [];
      const rc = await adversarySendWith("x", "viola", "codex", { offsetFor: () => 3, send: async (a) => { sent = a; return 0; } });
      expect(rc).toBe(0);
      expect(readFileSync(join(art, "viola_adversary_prompt.md"), "utf8")).toContain(join(art, "adversary-viola.md"));
      expect(readFileSync(join(art, "adversary-viola.txt"), "utf8")).toContain("OFFSET=3");
      expect(sent[0]).toBe("--from");
    } finally { cleanup(); }
  });
  it("send rc1 when the draft is missing", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      expect(await adversarySendWith("x", "viola", "codex", { offsetFor: () => 0, send: async () => 0 })).toBe(1);
    } finally { cleanup(); }
  });
  it("wait marks AS=ok on a done event with a non-empty critique", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "adversary-viola.txt"), "OFFSET=0\n");
      writeFileSync(join(art, "adversary-viola.md"), "## Verdict\naccept");
      const rc = await adversaryWaitWith("x", "viola", "codex", { wait: async () => ({ event: "done" } as any), multiplier: () => "1" });
      expect(rc).toBe(0);
      expect(existsSync(join(art, "adversary-viola.done"))).toBe(true);
      expect(readFileSync(join(art, "adversary-viola.txt"), "utf8")).toContain("AS=ok");
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (reuse `ResearchSendDeps`/`ResearchWaitDeps` types):

```ts
// ---- adversary-send / adversary-wait ----
async function adversarySendRun(rest: string[]): Promise<number> {
  const [topic, instrument, provider] = rest;
  if (!topic || !instrument || !provider) { log.error("usage: prelude adversary-send <topic> <instrument> <provider>"); return 2; }
  return adversarySendWith(topic, instrument, provider, liveResearchSendDeps);
}
export async function adversarySendWith(topic: string, instrument: string, provider: string, d: ResearchSendDeps): Promise<number> {
  const art = preludeArtDir(topic);
  const draft = readIf(join(art, "landscape-draft.md"));
  if (!draft.trim()) { log.error("prelude adversary-send: landscape-draft.md missing or empty — run synth-preliminary first"); return 1; }
  const stateFile = join(art, `adversary-${instrument}.txt`);
  if (existsSync(stateFile)) { log.error(`prelude adversary-send: ${stateFile} exists; rm to retry`); return 1; }

  const outPath = join(art, `adversary-${instrument}.md`);
  const promptFile = join(art, `${instrument}_adversary_prompt.md`);
  atomicWrite(promptFile, composeAdversaryPrompt(draft, instrument, outPath));

  const offset = d.offsetFor(instrument, provider, topic);
  atomicWrite(stateFile, `OFFSET=${offset}\n`);
  const rc = await d.send(["--from", "maestro", instrument, topic, `@${promptFile}`]);
  if (rc !== 0) { log.error(`prelude adversary-send: send failed (rc=${rc}); ${stateFile} kept (rm to redo)`); return 1; }
  log.ok(`prelude adversary-send: ${instrument} offset=${offset}`);
  return 0;
}

async function adversaryWaitRun(rest: string[]): Promise<number> {
  const [topic, instrument, provider] = rest;
  if (!topic || !instrument || !provider) { log.error("usage: prelude adversary-wait <topic> <instrument> <provider>"); return 2; }
  return adversaryWaitWith(topic, instrument, provider, liveResearchWaitDeps);
}
export async function adversaryWaitWith(topic: string, instrument: string, provider: string, d: ResearchWaitDeps): Promise<number> {
  const art = preludeArtDir(topic);
  const stateFile = join(art, `adversary-${instrument}.txt`);
  if (!existsSync(stateFile)) { log.error(`prelude adversary-wait: ${stateFile} missing (run prelude adversary-send first)`); return 1; }
  const offset = parseLatestOffset(readFileSync(stateFile, "utf8"));
  if (offset === null) { log.error(`prelude adversary-wait: OFFSET not set in ${stateFile}`); return 1; }

  const timeout = scaledTimeout(consultTimeout("adversary"), d.multiplier(provider));
  log.info(`prelude adversary-wait: ${instrument} offset=${offset} timeout=${timeout}s`);
  const ev = await d.wait(instrument, provider, topic, offset, ["done", "error", "question"], timeout);

  const outPath = join(art, `adversary-${instrument}.md`);
  const text = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  const as = verifyState(ev, text); // done → ok iff non-empty; mirrors cw_consult_wait adversary
  if (as === "question" && ev) {
    atomicWrite(join(art, `question-${instrument}.txt`), JSON.stringify(ev) + "\n");
    const bumped = outboxOffset(outboxPath(instrument, provider, topic));
    appendFileSync(stateFile, `OFFSET=${bumped}\nAS=question\n`);
  } else {
    appendFileSync(stateFile, `AS=${as}\n`);
  }
  writeFileSync(join(art, `adversary-${instrument}.done`), "");
  log.ok(`prelude adversary-wait: ${instrument} AS=${as}`);
  return 0;
}
```

- [ ] **Step 4: Run → PASS.** `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/prelude.ts tests/prelude-cmd.test.ts
git commit -m "feat(prelude): adversary-send (draft guard) + adversary-wait (verifyState reuse)"
```

---

### Task P12: `synth-final` + `forensics` + `teardown` + `handoff-extract` verbs

**Files:**
- Modify: `src/commands/prelude.ts`
- Test: `tests/prelude-cmd.test.ts` (append)

- `synth-final`: validator. Require `landscape-draft.md` + `topic.txt`; if `adversary-skip.txt`
  does NOT record `user_decision: skip`, require `adversary-<instrument>.md` for every part. Print
  `landscape-<YYYY-MM-DD>-<topic>.md`.
- `forensics`: `captureArtDir({ artDir, command: "prelude" })` (mirror `score.ts::forensicsRun`).
- `teardown`: orphan-kill (preflight-panes.txt) + `archiveTopic(topic, "prelude")` + print dest
  (mirror `rehearsal.ts::teardownWith`, minus the winner symlink — prelude has no winner). The
  PANE teardown is the directive's separate `coda --pairs` call BEFORE this verb.
- `handoff-extract <art-dir>`: `extractHandoffData(artDir)`; rc2 if null.

- [ ] **Step 1: Write the failing test (append)**

```ts
import { synthFinalRun, forensicsRun as preludeForensicsRun, teardownWith as preludeTeardownWith, handoffExtractRun } from "../src/commands/prelude.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
// ...
describe("prelude synth-final", () => {
  it("rc0 when adversary ran and all critiques exist", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "topic.txt"), "x"); writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: continue\n");
      writeFileSync(join(art, "adversary-viola.md"), "c"); writeFileSync(join(art, "adversary-cello.md"), "c");
      expect(await synthFinalRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
  it("rc0 with only the draft when user_decision: skip", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      const art = preludeArtDir("x");
      writeFileSync(join(art, "landscape-draft.md"), "d");
      writeFileSync(join(art, "adversary-skip.txt"), "user_decision: skip\n");
      expect(await synthFinalRun(["x"])).toBe(0);
    } finally { cleanup(); }
  });
});

describe("prelude teardown", () => {
  it("archives _prelude and prints the dest", async () => {
    const { cleanup } = freshHome();
    try {
      await initWith(["x"], initDeps());
      let dest = "";
      const rc = await preludeTeardownWith(["x"], {
        killPane: async () => {}, archiveTopic: () => { dest = "/archive/x/_prelude-T"; return dest; },
        stdout: (l) => { dest = l; },
      });
      expect(rc).toBe(0);
      expect(dest).toContain("_prelude");
    } finally { cleanup(); }
  });
});

describe("prelude handoff-extract", () => {
  it("rc2 on a missing art-dir / no topic.txt", async () => {
    const art = mkdtempSync(join(tmpdir(), "prelude-empty-"));
    expect(await handoffExtractRun([art])).toBe(2);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement the four verbs**

```ts
// ---- synth-final (input validator) ----
async function synthFinalRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: prelude synth-final <topic>"); return 2; }
  const art = preludeArtDir(topic);
  if (!existsSync(art)) { log.error(`prelude synth-final: ${art} not found`); return 1; }
  if (!readIf(join(art, "landscape-draft.md")).trim()) { log.error("prelude synth-final: landscape-draft.md missing"); return 1; }
  if (!readIf(join(art, "topic.txt")).trim()) { log.error("prelude synth-final: topic.txt missing"); return 1; }

  const skipped = /^user_decision: skip$/m.test(readIf(join(art, "adversary-skip.txt")));
  if (!skipped) {
    const rows = parseRosterFile(readIf(join(art, "roster.txt")));
    const missing = rows.filter((r) => !readIf(join(art, `adversary-${r.instrument}.md`)).trim()).map((r) => `adversary-${r.instrument}.md`);
    if (missing.length) {
      log.error("prelude synth-final: blocked — adversary ran but critiques missing:");
      for (const m of missing) log.error(`  - ${join(art, m)}`);
      return 1;
    }
  }
  const today = isoUtc().slice(0, 10);
  const out = join(art, `landscape-${today}-${topic}.md`);
  log.ok(`prelude synth-final: inputs validated for ${topic} (adversary_ran=${skipped ? 0 : 1})`);
  process.stdout.write(out + "\n");
  return 0;
}

// ---- forensics (thin captureArtDir wrapper) ----
export async function forensicsRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: prelude forensics <topic>"); return 2; }
  const path = captureArtDir({ artDir: preludeArtDir(topic), command: "prelude" });
  if (path) { log.ok(`prelude forensics: captured ${path}`); process.stdout.write(path + "\n"); }
  else log.info("prelude forensics: no mechanical findings (no file written)");
  return 0; // best-effort
}

// ---- teardown (orphan kill + archive; panes torn down by the directive's coda --pairs) ----
export interface PreludeTeardownDeps {
  killPane(pane: string): Promise<void>;
  archiveTopic(topic: string, suite: "prelude"): string | null;
  stdout?: (l: string) => void;
}
const livePreludeTeardownDeps: PreludeTeardownDeps = {
  killPane: (p) => killNow(p),
  archiveTopic: (t, s) => archiveTopic(t, s),
};
async function teardownRun(rest: string[]): Promise<number> { return teardownWith(rest, livePreludeTeardownDeps); }

export async function teardownWith(args: string[], deps: PreludeTeardownDeps): Promise<number> {
  const out = deps.stdout ?? ((l: string): void => { process.stdout.write(l + "\n"); });
  const topic = args[0];
  if (!topic) { log.error("prelude teardown: topic required"); return 2; }
  const art = preludeArtDir(topic);
  if (!existsSync(art) || !statSync(art).isDirectory()) { log.error(`${art} not found`); return 1; }

  const pf = join(art, "preflight-panes.txt");
  if (existsSync(pf)) {
    for (const line of readFileSync(pf, "utf8").split("\n")) {
      const pane = line.trim();
      if (!pane) continue;
      try { await deps.killPane(pane); } catch { /* best-effort */ }
    }
  }
  const dest = deps.archiveTopic(topic, "prelude");
  if (dest) { out(dest); log.ok(`[teardown] archived ${topic} -> ${dest}`); }
  return 0;
}

// ---- handoff-extract (runs against the archived art-dir) ----
async function handoffExtractRun(rest: string[]): Promise<number> {
  const artDir = rest[0];
  if (!artDir) { log.error("usage: prelude handoff-extract <art-dir>"); return 2; }
  const path = extractHandoffData(artDir);
  if (!path) { log.error(`prelude handoff-extract: art-dir or topic.txt missing under ${artDir}`); return 2; }
  log.ok(`prelude handoff-extract: wrote ${path}`);
  process.stdout.write(path + "\n");
  return 0;
}
```

Note the `preflight-panes.txt` line format: `score`/`rehearsal` write `<instrument>\t<pane>` rows,
so `line.trim()` is the whole row, not just a pane id. Mirror `rehearsal.ts::teardownWith` exactly —
it splits nothing and feeds the trimmed line to `killPane` (best-effort; a no-op on the dogfood where
no real panes exist). Keep it byte-identical to rehearsal's loop.

- [ ] **Step 4: Run → PASS.** `npm run typecheck` → clean. Then full `npm run test` + `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/prelude.ts tests/prelude-cmd.test.ts
git commit -m "feat(prelude): synth-final + forensics + teardown + handoff-extract verbs"
```

---

### Task P13: the directive (`commands/prelude.md`)

**Files:**
- Create: `commands/prelude.md`
- Reference: `commands/score.md` + `commands/rehearsal.md` (format model — the same frontmatter,
  TaskCreate block, CLI-invocation idiom `node "$CONSORT_CLI" prelude <verb> …`, args-file minting,
  and `coda --pairs` teardown call).

The directive orchestrates the Maestro through spec §7 Phases 0–10. It is markdown the Maestro
follows — NOT executable code — so there are no unit tests; the dogfood (P14) exercises the verbs it
calls. Author it by mirroring `score.md`'s structure, substituting the prelude phases.

- [ ] **Step 1: Write the frontmatter + intro**

Frontmatter `description:` = "Deep multi-aspect exploration — SOTA surveys, multi-angle thinking,
adversary-tested landscape doc that feeds /consort:score". `argument-hint: <topic>`. `allowed-tools`
matching score.md plus `AskUserQuestion`. Intro paragraph: the Maestro orchestrates an N-part
research pass, classifies the topic, synthesizes a preliminary landscape, runs a 5-signal confidence
gate, optionally runs an adversary round, writes the final landscape + Conclusion, emits
`score-handoff.md`. **The Maestro never runs retrieval — parts are the only retrievers.**

- [ ] **Step 2: TaskCreate block** — 11 rows mirroring spec §7 (0, 1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9/10).

- [ ] **Step 3: Author Phases 0–10** with the exact CLI invocations (each `node "$CONSORT_CLI"
  prelude <verb> …`, resolving `$CONSORT_CLI` the same way score.md does), copying the
  spawn-retry-once structure from score.md Phase 2 and the question-intervention pattern from
  score.md's research wait. Include the two Maestro-authored synthesis blocks verbatim from spec
  §7 (preliminary section set; final section set with Conclusion). Step 5.5 fires `AskUserQuestion`
  only when `ALL_HOLD=true`, then calls `prelude confidence <topic> --decision <skip|continue>`.
  Step 9 runs `coda --pairs <topic>` (pane teardown) THEN `prelude teardown <topic>` (archive),
  rebinds the art-dir to the archive, runs `prelude handoff-extract <archive-art-dir>`, and the
  Maestro Writes `score-handoff.md`. Step 10 prints the landscape doc, the handoff doc, and the
  suggested `/consort:score <…>/score-handoff.md`.

- [ ] **Step 4: Verify** — `node dist/consort.cjs prelude` (after P14 build) prints the usage line;
  grep the directive for any banned token (`grep -nE 'clone-wars|cw_|trooper|commander|master-yoda'
  commands/prelude.md` → no hits). Cross-check every `prelude <verb>` invocation against the verb
  list in `src/commands/prelude.ts::run`.

- [ ] **Step 5: Commit**

```bash
git add commands/prelude.md
git commit -m "feat(prelude): orchestration directive (Phases 0-10)"
```

---

### Task P14: dogfood + dist rebuild

**Files:**
- Create: `scripts/dogfood-prelude-loop.sh`
- Rebuild: `dist/consort.cjs`
- Reference: `scripts/dogfood-rehearsal-loop.sh` (the simulated-parts harness model)

- [ ] **Step 1: Build the bundle**

Run: `npm run build` (esbuild → `dist/consort.cjs`).

- [ ] **Step 2: Write `scripts/dogfood-prelude-loop.sh`**

A bash script mirroring `dogfood-rehearsal-loop.sh`'s structure: set a fresh `CONSORT_HOME`,
`CONSORT_DRY_RUN=1`, and exercise the full chain with **simulated parts** (write `findings-*.md` /
`adversary-*.md` directly instead of spawning codex, whose directory-trust prompt blocks live
spawns). Scenario steps (each asserts rc + an artifact):
1. `prelude init "attention kernels for long context"` → `_prelude/` + roster.txt.
2. `prelude classify <topic>` → lit-track.txt = ON.
3. simulate `findings-<inst>.md` for each roster part.
4. `prelude synth-preliminary <topic>` → prints draft path; write a `landscape-draft.md` fixture.
5. `prelude confidence <topic>` → prints `ALL_HOLD=…`; assert adversary-skip.txt on not-all-hold.
6. `prelude confidence <topic> --decision continue` → adversary-skip.txt user_decision: continue.
7. simulate `adversary-<inst>.md` for each part.
8. `prelude synth-final <topic>` → prints landscape-<date>-<topic>.md path; write the fixture.
9. `prelude forensics <topic>` → rc0.
10. `prelude teardown <topic>` → prints the archive dest; assert `_prelude` moved under archive/.
11. `prelude handoff-extract <archive-art-dir>` → handoff-data.kv with `mode=prelude`,
    `confidence_signals=`, `adversary_findings_paths=`.
12. stale-token scan: `grep -rIE 'clone-wars|cw_|trooper|commander' <art + handoff>` → no hits.

Print `PASS`/`FAIL` per step and a final tally; exit non-zero on any failure.

- [ ] **Step 3: Run the dogfood**

Run: `bash scripts/dogfood-prelude-loop.sh`
Expected: every step PASS; final tally green; exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/dogfood-prelude-loop.sh dist/consort.cjs
git commit -m "feat(prelude): simulated end-to-end dogfood + dist rebuild"
```

---

### Task P15: flip the phase guard + final verification

**Files:**
- Modify: `CLAUDE.md` (the "Current phase guard" section)

- [ ] **Step 1: Run the full gate**

Run, expecting all green:
```bash
npm run typecheck && npm run test && npm run lint && bash scripts/dogfood-prelude-loop.sh
```
Confirm the stale-token test reports 7/7. If `npm run test` count regressed, investigate before
proceeding.

- [ ] **Step 2: Flip the phase guard in `CLAUDE.md`**

In the "Current phase guard — load-bearing" section: move `prelude` into the **Shipped** list (with
its verb set), and change the "Still OUT OF SCOPE" paragraph to state that **all** clone-wars
commands are now ported — nothing remains out of scope. Mirror the wording style of the existing
Shipped paragraph. Example replacement for the OUT-OF-SCOPE paragraph:

> **Fully ported:** every clone-wars command now has a consort equivalent. `prelude` (was meditate)
> ships the lit-track classifier, the 5-signal confidence gate, the adversary round, and the verbs
> `init`/`classify`/`spawn-all`/`research-send`/`research-wait`/`synth-preliminary`/`confidence`/
> `adversary-send`/`adversary-wait`/`synth-final`/`forensics`/`teardown`/`handoff-extract`, plus
> Phases 0–10 of `commands/prelude.md`. There is no remaining unported command.

- [ ] **Step 3: Rebuild dist if any src changed during P15** (it should not have): `npm run build`;
  if `dist/consort.cjs` changed, `git add` it.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(prelude): flip phase guard — prelude shipped, all commands ported"
```

- [ ] **Step 5: Finish the branch**

Use **superpowers:finishing-a-development-branch** — verify the full test suite, then present the
merge/PR options. (Expected path: push `feat/prelude` + open a PR titled
"feat(prelude): port clone-wars meditate to consort".)

---

## Self-Review

**1. Spec coverage:**
- §3 verbs (13): init (P6), classify (P7), spawn-all (P8), research-send/wait (P9),
  synth-preliminary + confidence (P10), adversary-send/wait (P11), synth-final + forensics +
  teardown + handoff-extract (P12). ✓ all 13.
- §4 core modules (5): prelude.ts (P1), preludeLit (P2), preludeConfidence (P3), preludeTurn (P4),
  preludeHandoff (P5). ✓.
- §5 the 5 signals: P3 `computeSignals` + per-signal tests. ✓.
- §6 reconciled handoff: P5 (`extractHandoffData` reads adversary-skip.txt + adversary-*.md). ✓.
- §7 directive Phases 0–10: P13. ✓.
- §8 rebrand/frozen: enforced throughout; stale-token scan in P14/P15. ✓.
- §10 testing/dogfood: per-task unit tests + P14 dogfood. ✓.
- archive suite addition: P1. ✓. dispatcher: P6. ✓. phase-guard flip: P15. ✓.

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code; the directive task (P13)
points at the two sibling directives as the format model and lists every phase's exact invocation —
acceptable for a markdown directive (it is prose the Maestro reads, not compiled code), and the
synthesis section templates are given verbatim in spec §7.

**3. Type consistency:** `preludeArtDir`/`deriveSlug` (P1) used in P6–P12; `RosterRow`/
`parseRosterFile`/`formatRosterFile`/`spawnRosterArg`/`spawnResultsTsv`/`spawnTally`/`parsePanesFile`/
`SpawnResult` imported from `score.ts` (P8/P6); `researchState`/`verifyState`/`parseLatestOffset`/
`scaledTimeout` from `scoreTurn.ts` (P9/P11); `OutboxEvent`/`outboxOffset`/`outboxPath`/
`outboxWaitSince` from `ipc.ts`; `computeSignals`/`renderSkipRecord`/`Decision`/`Signals` (P3) used
in P10; `topApproach` (P3) reused in P5; `classifyTopic` (P2) in P7; `composePreludeResearchPrompt`/
`composeAdversaryPrompt`/`litGuidance` (P4) in P9/P11; `extractHandoffData` (P5) in P12;
`archiveTopic("prelude")` (P1) in P12; `consultTimeout("adversary")` (exists) in P11. All signatures
consistent across tasks. ✓.
