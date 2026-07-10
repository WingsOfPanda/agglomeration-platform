// src/core/exploreTurn.ts — research + adversary prompt builders for /ap:explore
// (port of config/prompt-templates/meditate/{research,adversary}.md, rebranded). These bodies do
// NOT carry their own done-event line or END_OF_INSTRUCTION: explore sends them via `send` →
// `inboxWrite`, which appends exactly one done instruction + one END_OF_INSTRUCTION (same contract
// as design's composeResearchPrompt/composeVerifyPrompt). Embedding a second here produced a
// duplicate END_OF_INSTRUCTION in the inbox, which desynced codex workers' terminal `done` event.

/** The {{LIT_GUIDANCE}} block for the research prompt, keyed on the lit-track classification. */
export function litGuidance(track: "ON" | "OFF"): string {
  return track === "ON"
    ? "The topic is academic / SOTA-shaped. Prioritize peer-reviewed papers (arXiv, conference " +
      "proceedings) over blog posts or vendor docs. List 3+ recent papers, projects, or benchmarks " +
      "with citations including authors, year, venue, URL/DOI where available."
    : "The topic is not academic-shaped. Brief SOTA-evidence section is fine — list 1-2 anchor " +
      "sources or write 'Not applicable' with a one-line reason.";
}

/** The whole-landscape guard sentence EVERY research lens ends with. Load-bearing partition guard:
 *  a hard code/lit split at N=2 gives disjoint citation vocabularies → every draft citation is
 *  solo → S2 systematically false (src/core/exploreConfidence.ts soloCitations). A weighting keeps
 *  vocabularies overlapping on central sources. */
export const LENS_GUARD =
  "This is an emphasis, not a boundary — you must still cover the WHOLE landscape; " +
  "do not skip an approach because it sits outside your emphasis.";

/** Per-provider research lens — a WEIGHTING, never a partition. Keyed on provider NAME in code,
 *  deliberately NOT a contracts.yaml field (the frozen key list stays untouched; provider names
 *  are as stable as the closed provider set). */
export const RESEARCH_LENSES: Readonly<Record<string, string>> = {
  codex:
    "Weight your investigation toward repo-code evidence: read the implementation, run runtime " +
    "probes/experiments where cheap, judge implementation feasibility first-hand. " + LENS_GUARD,
  claude:
    "Weight your investigation toward literature and web synthesis: papers, RFCs, vendor docs, " +
    "cross-domain analogues, conceptual frames. " + LENS_GUARD,
};

const NEUTRAL_LENS = "No special emphasis — balance code and literature evidence as the topic demands. " + LENS_GUARD;

/** The research lens for a provider; agy/opencode/unknown get the neutral default. */
export function researchLens(provider: string): string {
  return RESEARCH_LENSES[provider] ?? NEUTRAL_LENS;
}

/** Research-phase prompt (port of meditate/research.md). Expose the landscape; do NOT recommend. */
export function composeExploreResearchPrompt(topic: string, writeTo: string, lit: string, lens: string, selfassessTo: string): string {
  const t = topic.trim();
  return [
    "Investigate the following topic from multiple angles. Your job is not to",
    "recommend; your job is to expose the landscape — approaches, tradeoffs,",
    "SOTA evidence, and open questions.",
    "",
    `Topic: ${t}`,
    "",
    `Research lens: ${lens}`,
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
    "  Hub's identity prompt suggested. Cite at least 3 sources you found on",
    "  your own — this is an anti-correlated-blind-spots guard.",
    "",
    "  ## Open questions",
    "  - <question 1 that the research could not resolve>",
    "  - <question 2>",
    "",
    "  ## Notes",
    "  <any free-form additions; not parsed by the Hub>",
    "",
    `SECOND output file — write your self-assessment to ${selfassessTo} with this structure:`,
    "",
    "  # Self-assessment",
    "",
    "  <one line per approach you listed: `<confidence>: <approach name>`,",
    "  where <confidence> is high | medium | low>",
    "",
    "  ## Least sure",
    "  - <the claim you are least confident in, with its [citation]>",
    "  - ...",
    "",
    "The self-assessment is hub-side accountability material — do NOT embed it in the",
    "findings file; keep the two files separate.",
    "",
    "Citation format options:",
    "  - <file path>:<line>          e.g. src/auth/store.py:42",
    "  - <file path>:<line-range>    e.g. src/auth/refresh.py:15-30",
    "  - <URL>                       e.g. https://arxiv.org/abs/2401.04088",
    "  - paper:<id>                  e.g. paper:arxiv:2401.04088",
    "  - runtime: <command>          e.g. runtime: pytest tests/test_x.py",
    "",
    "Every Approach AND every Tradeoff bullet MUST have a citation in [brackets].",
    "Bullets without citations will be silently dropped by the Hub's synthesis —",
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
    "Surface the landscape; the Hub will synthesize the tradeoff matrix and a",
    "separate adversary round will challenge the synthesis before the final landscape",
    "doc is written.",
  ].join("\n");
}

/** A distinct adversary attack angle. `emphasis` lines render as the PRIMARY-angle bullet block. */
export interface AdversaryLens { name: string; emphasis: string[] }

/** Distinct attack lenses, assigned by list.txt row index (`index % ADVERSARY_LENSES.length`) so
 *  concurrent adversaries do not duplicate the same critique. Emphasis-only: the full attack-surface
 *  list stays in every prompt, so N=2 keeps whole-surface coverage. Index 2 is reached only at N=3. */
export const ADVERSARY_LENSES: readonly AdversaryLens[] = [
  {
    name: "citation-fidelity",
    emphasis: [
      "Open every cited file/URL/paper in the draft AND in the raw peer findings files.",
      "Verify each claim is actually supported by its citation; flag over-reached citations",
      "where the source says less (or something other) than the claim attached to it.",
    ],
  },
  {
    name: "frame-exclusion",
    emphasis: [
      "Hunt approaches that were missed or wrongly excluded from the landscape.",
      "Attack frames the synthesis adopted that shut out valid alternatives, comparing the",
      "draft against what the raw peer findings files actually contain.",
    ],
  },
  {
    name: "staleness-and-correlation",
    emphasis: [
      "Attack stale SOTA claims (a paper from 3+ years ago marked \"current SOTA\") and",
      "convergent findings that may share a correlated blind spot (all workers read the",
      "same paper, all missed the same recent development).",
    ],
  },
];

/** Adversary-phase prompt (port of meditate/adversary.md). Inlines the draft to challenge; lists
 *  raw peer findings PATHS (not contents — workers open them with their own tools) and assigns a
 *  distinct primary attack lens per worker. */
export function composeAdversaryPrompt(
  landscapeDraft: string, agent: string, outPath: string,
  opts: { peerFindingsPaths: string[]; lens: AdversaryLens; priorityTargets?: string[]; lowConfidenceClaims?: string[] },
): string {
  return [
    "You are now playing adversary against a synthesized landscape doc that",
    "was built from your earlier research findings (and the findings of your",
    "fellow workers). Your job is to break confidence in the synthesis — not",
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
    ...(opts.peerFindingsPaths.length ? [
      "Raw evidence behind the draft — your fellow workers' unfiltered findings files:",
      ...opts.peerFindingsPaths.map((p) => `- ${p}`),
      "Open them with your own tools and check whether the draft faithfully",
      "represents them: a weak peer claim the synthesis absorbed uncritically is a",
      "finding; so is peer evidence the synthesis dropped or distorted.",
      "",
    ] : []),
    `Your PRIMARY attack angle — ${opts.lens.name} — spend most of your effort here:`,
    ...opts.lens.emphasis.map((l) => `- ${l}`),
    "",
    ...(opts.priorityTargets?.length ? [
      "Priority targets — these citations are corroborated by only ONE worker; open each",
      "and verify the claim it anchors FIRST:",
      ...opts.priorityTargets.map((t) => `- ${t}`),
      "",
    ] : []),
    ...(opts.lowConfidenceClaims?.length ? [
      "Self-flagged low-confidence claims — the workers themselves are least sure of",
      "these; verify them first:",
      ...opts.lowConfidenceClaims.map((c) => `- ${c}`),
      "",
    ] : []),
    "Attack surface — prioritize these failure modes:",
    "- Approaches that were missed or wrongly excluded from the landscape",
    "- Tradeoff matrix rows where the \"Best fit\" assignment is wrong or weakly justified",
    "- Citations that don't actually support the claim attached to them",
    "  (open the cited file/URL and verify the claim is grounded)",
    "- Convergent findings across workers that may share a correlated blind spot",
    "  (e.g., all read the same paper, all missed the same recent development)",
    "- Frames the synthesis adopted that exclude valid alternative frames",
    "  (e.g., assumed online inference when batch is also valid)",
    "- Open questions that should have been answered but were filed instead",
    "- SOTA claims that are stale (paper from 3+ years ago marked \"current SOTA\")",
    "",
    `Output requirements — write to ${outPath}:`,
    "",
    `  # Adversary critique: ${agent}'s pass`,
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
  ].join("\n");
}

/** Post-gate gap-enrichment prompt (Phase 7c). Peer-only bucket items in → one confirm/extend/
 *  refute turn out. Answers feed ONLY the final landscape doc + design-handoff Evidence — never
 *  the draft, the gate, or the recorded signals (gate-as-loop-predicate stays a rejected
 *  non-goal). Same no-fence contract as the other builders in this file. */
export function composeGapPrompt(bucketItems: string[], outPath: string): string {
  const items = bucketItems.map((l, i) => `${i + 1}. ${l}`).join("\n");
  return [
    "Your fellow workers surfaced the approaches below during research; you did not",
    "cover them. The run's confidence gate recorded low cross-worker overlap, so each",
    "item currently rests on a single worker's evidence.",
    "",
    "For EACH item, do ONE of:",
    "",
    "  CONFIRM — corroborate it with your OWN evidence (cite a file/line/URL/paper)",
    "  EXTEND  — confirm it and add material the original worker missed",
    "  REFUTE  — explain why it is wrong, with counter-evidence",
    "",
    "Items:",
    items,
    "",
    `Write your answers to ${outPath} with this EXACT structure:`,
    "",
    "  # Gap enrichment",
    "",
    "  ## Answers",
    "  1. <CONFIRM|EXTEND|REFUTE> <original [citation] and text>",
    "     <your evidence, with [citation] anchors>",
    "  2. ...",
    "",
    "Your answers feed ONLY the final landscape doc and the design handoff — the draft",
    "is not re-synthesized and the confidence gate does not re-run. If you cannot tell",
    "from available evidence, say so explicitly — do not pad.",
  ].join("\n");
}
