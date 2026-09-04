// src/core/implementTurn.ts — single-worker TURN machinery for `implement` (Phase A).
// Byte-faithful port of deploy-turn-wait.sh (the TS= state machine) + deploy_build_turn_prompt_round1
// and deploy_build_turn_prompt_fix. Mirrors designTurn.ts conventions; prompt composers OMIT
// END_OF_INSTRUCTION and the done line (inboxWrite appends them). A question round-trip is ONE
// logical turn; the re-armed wait reads the LATEST OFFSET= line (designTurn.parseLatestOffset).
import type { OutboxEvent } from "./ipc.js";
import { dirname, join } from "node:path";

export type ImplementState = "ok" | "failed" | "timeout" | "question";

/** Map a single-worker turn's wait outcome to TS= (port of the `case "$EVENT"` block in
 *  deploy-turn-wait.sh:59-93). null -> timeout; question -> question; done + verify present AND
 *  non-empty -> ok else failed; error / unknown -> failed. */
export function implementState(ev: OutboxEvent | null, verifyText: string | null): ImplementState {
  if (!ev) return "timeout";
  if (ev.event === "question") return "question";
  if (ev.event === "done") return verifyText !== null && verifyText.length > 0 ? "ok" : "failed";
  return "failed";
}

/** The verdicts a WORKER may open its verify report with (distinct from `TEST_VERDICTS`, which is the
 *  HUB's own re-run classification). Exported so the directive-contract test can assert that
 *  `commands/implement.md` carries a Stage 2 branch for each one. The composers below deliberately do
 *  NOT build their verdict line from this const: a mirrored gate moves with its implementation, so
 *  deleting a verdict here would mutate prompt and assertion together and stay green. Keep the
 *  composers' `VERDICT: PASS|PARTIAL|FAIL` a LITERAL. */
export const WORKER_VERDICTS = ["PASS", "PARTIAL", "FAIL"] as const;

/** Report contract shared by both turn composers: the ENV line, the skipped-leg => PARTIAL rule, and
 *  the MUTATION: requirement for gates the round adds. The verdict LINE is not here on purpose (see
 *  WORKER_VERDICTS) — each composer spells it out literally. */
const REPORT_CONTRACT = [
  "  Line 2 of the report MUST be:",
  "    ENV: shell=<as observed>; suite=<cmd>; legs=<ran ... / skipped ... + why>; build=<generated or native artifacts present, or rebuilt by you>",
  "  If ANY leg was skipped for an environment reason, the verdict is PARTIAL",
  "  — a green default leg is not PASS.",
  "",
  "  For every test or gate you ADD, write:",
  "    MUTATION: <file:line> <the change you made to break it> -> <observed failure>",
  "  A gate you never watched fail is not evidence. A gate must assert a",
  "  SPEC-derived expectation — a literal, or an independently recomputed",
  "  value — never the implementation's own output read back at itself.",
];

/** The single-`done` contract both turn composers carry (2026-09-04-parallel-slices-design.md, J).
 *  A worker that emits `done` after every task ended its turn at the FIRST one; `progress` is
 *  terminal for no wait, so the habit is harmless the moment the worker follows this line. The
 *  premature-`done` hold covers the worker that does not. */
const SINGLE_DONE =
  "Emit `done` exactly ONCE, after the verify report is written. Per-task\n" +
  'completions are `progress` events ({"event":"progress","note":"task N committed: ..."}),\n' +
  "never `done`.";

const BRANCH_DISCIPLINE =
  "BRANCH DISCIPLINE (hard rule):\n" +
  "- You are operating on the conductor's current branch in the target\n" +
  "  repository. Do NOT run 'git checkout', 'git switch',\n" +
  "  'git branch -m', or create new branches.\n" +
  "- Commit per task with Conventional Commits prefixes on the current\n" +
  "  branch.\n" +
  "- If your work genuinely needs a fresh branch, abort with\n" +
  '  {"event":"error","reason":"branch-discipline: needed new branch"}\n' +
  "  and let the conductor decide.\n";

function blockers(testCmd: string): string {
  const suiteLine = testCmd
    ? `  is NOT for running your test suite. Running '${testCmd}' is your job.\n  Banned values fail with rc=2.\n`
    : "  is NOT for running your test suite. Running your repository's test suite is your job.\n  Banned values fail with rc=2.\n";
  return (
    "BLOCKERS / QUESTIONS:\n" +
    "- If a referenced path, file, checkpoint, git ref, env var, or\n" +
    "  command is NOT where the notes say it is, DO NOT search the\n" +
    "  filesystem yourself, DO NOT invent a workaround. Halt and ask by\n" +
    "  appending ONE question event to your outbox.jsonl, then stop:\n" +
    '    {"event":"question","message":"<why you are asking>",' +
    '"claim":{"kind":"<path|git|env|cmd|test>","value":"<the value to check>"},"ts":"<iso>"}\n' +
    '  Omit the "claim" object for a judgment question (no ground-truth to check).\n' +
    "- If you believe the PLAN ITSELF is wrong — a design flaw, a contradiction,\n" +
    "  or an approach that will not work (NOT a missing referent) — do NOT\n" +
    "  silently implement it. Halt and append ONE question whose message begins\n" +
    '  "OBJECTION:" explaining why, OMIT the "claim" object, then stop. The\n' +
    "  Hub will revise the plan or tell you to proceed.\n" +
    "- The Hub verifies the claim and replies via your inbox.md, then re-engages you.\n" +
    "- After reading any inbox.md reply, acknowledge by appending an ack event:\n" +
    '    {"event":"ack","task_summary":"<what you read>","ts":"<iso>"}\n' +
    "- The 'test' kind runs a diagnostic command under a 30s timeout — it\n" +
    suiteLine
  );
}
export { blockers };

/** PHASE 3 of every build-shaped turn. `testLog` / `durationLog` are ARGUMENTS, not derived from
 *  `verifyPath` + round: parallel slices share one art dir, so a derived name collides
 *  (2026-09-04-parallel-slices-design.md, E). */
function phase3SelfVerify(verifyPath: string, testLog: string, durationLog: string): string[] {
  return [
    "PHASE 3: Self-verify",
    "  Verify with fresh evidence: run the full test suite and tee output to:",
    `    ${testLog}`,
    "  Claim only what this run demonstrates; report skipped or partial checks",
    "  explicitly. Write a structured verify report to:",
    `    ${verifyPath}`,
    "",
    "  The report MUST start with `VERDICT: PASS|PARTIAL|FAIL` on the first",
    "  line, followed by per-requirement evidence (file:line citations) and a",
    "  short summary.",
    "",
    ...REPORT_CONTRACT,
    "",
    "  Also record how long the test suite itself took, in whole wall-clock",
    "  seconds, and write it as `TEST_DURATION_S=<seconds>` (one line) to:",
    `    ${durationLog}`,
    "  The Hub reads this: if your suite ran longer than its verify budget it",
    "  trusts your report instead of independently re-running — so measure the",
    "  actual suite run.",
    "",
  ];
}

/** The round-1 skeleton the round-1, slice and prelude turns share. Called with the defaults below it
 *  reproduces the 0.5.68 round-1 body BYTE FOR BYTE (pinned against a fixture in
 *  tests/implement-turn-slices.test.ts). Only PHASE 1 and PHASE 2 are injected, because those are
 *  exactly what the slice and prelude turns re-scope (spec E). */
function roundOneShapedBody(o: {
  round: number;
  sliceBlock?: string;
  planPath: string;
  verifyPath: string;
  testLog: string;
  durationLog: string;
  testCmd: string;
  phase1: string[];
  phase2: string[];
}): string {
  return [
    ...(o.sliceBlock ? [o.sliceBlock, ""] : []),
    `You are entering ROUND ${o.round} of /ap:implement.`,
    "",
    "This is a single-turn workflow: you will write the implementation plan,",
    "implement it, run the test suite, and write the verify report — all in",
    "one autonomous run. The conductor will only re-engage when you emit done.",
    SINGLE_DONE,
    "",
    "RESUME CHECK (do this BEFORE starting):",
    `- If ${o.planPath} already exists, skip the planning phase — read the`,
    "  existing plan and proceed to implementation.",
    "- If `git log --oneline` shows commits past the design-doc commit on",
    `  this branch, identify the next pending task from ${o.planPath}'s checkbox`,
    "  state and continue from there. Do not redo already-committed tasks.",
    `- If ${o.verifyPath} already exists, you previously completed implementation`,
    `  — re-run the test suite and update ${o.verifyPath} if test outcomes changed.`,
    "",
    ...o.phase1,
    "",
    ...o.phase2,
    "",
    ...phase3SelfVerify(o.verifyPath, o.testLog, o.durationLog),
    BRANCH_DISCIPLINE,
    blockers(o.testCmd),
  ].join("\n");
}

/** Round-1 plan+implement+self-verify prompt body (port of deploy_build_turn_prompt_round1). MUST
 *  NOT include END_OF_INSTRUCTION or the done line. */
export function composeRound1Prompt(args: { designPath: string; planPath: string; verifyPath: string; round?: number; testCmd: string }): string {
  const { designPath, planPath, verifyPath, testCmd } = args;
  const round = args.round ?? 1;
  return roundOneShapedBody({
    round, planPath, verifyPath, testCmd,
    testLog: `${dirname(verifyPath)}/test-output-${round}.log`,
    durationLog: `${dirname(verifyPath)}/worker-test-duration-${round}.txt`,
    phase1: [
      `PHASE 1: Plan (skip if ${planPath} exists)`,
      "  Read the design doc at:",
      `    ${designPath}`,
      "  Produce a comprehensive, task-by-task implementation plan. For each",
      "  task, identify its scope, intended changes, dependencies, and focused",
      "  verification. Write the plan to:",
      `    ${planPath}`,
    ],
    phase2: [
      "PHASE 2: Implement",
      `  Walk ${planPath} task-by-task. Keep each change scoped to its task,`,
      "  review the resulting diff against the plan, and commit per task",
      "  (Conventional Commits prefix). Run",
      testCmd
        ? `  the full test suite (\`${testCmd}\`) after each task and confirm green.`
        : "  the repository's full test suite after each task and confirm green.",
    ],
  });
}

/** Fix-round prompt body (round >= 2; port of deploy_build_turn_prompt_fix). `bundleText` is the
 *  on-disk fix bundle, embedded VERBATIM (the bash `cat`s it raw). Same fence-omission note. */
export function composeFixPrompt(round: number, bundleText: string, verifyPath: string, testCmd: string): string {
  const testLog = `${dirname(verifyPath)}/test-output-${round}.log`;
  const durationLog = `${dirname(verifyPath)}/worker-test-duration-${round}.txt`;
  return [
    `You are entering ROUND ${round} of /ap:implement (fix loop).`,
    "",
    "This is a single-turn workflow: address each issue below, re-run the test",
    "suite, and write the verify report — all in one autonomous run.",
    SINGLE_DONE,
    "",
    "RESUME CHECK (do this BEFORE starting):",
    "- Check `git log --oneline` for commits since the previous round's",
    "  verify report was written. If some issues already have addressing",
    "  commits, identify which remain unaddressed and start from those.",
    `- If ${verifyPath} already exists, re-run tests and update it if outcomes`,
    "  changed.",
    "",
    "ISSUES TO ADDRESS:",
    "",
    bundleText,
    "",
    "ROUTING:",
    "- For each issue tagged [bug] or [regression]: start with a concrete",
    "  hypothesis, reproduce or collect evidence, and identify a supported root",
    "  cause before editing. Do not stack speculative fixes; if an attempt fails,",
    "  stop and reassess the hypothesis.",
    "- For each issue tagged [spec-gap]: re-plan the gap against the design and",
    "  update the implementation plan before editing.",
    "- Never hand-edit a committed evidence/measurement record to satisfy an",
    "  issue; re-run its producer and commit the regenerated record, or halt",
    "  with a question event.",
    "- After EACH fix commit: dispatch a code-review subagent scoped to the fix",
    "  commit's SHA. Ask it to compare the change with the issue, design, and",
    "  tests and look for regressions. Address Critical and Important findings",
    "  before moving to the next issue.",
    "",
    "For EACH issue: implement the fix, commit per fix (Conventional Commits",
    "prefix `fix:`, `feat:`, or `test:` as appropriate), run the",
    "code-review subagent on the new commit, then re-run the full test suite.",
    "Do NOT skip any listed issue.",
    "",
    "After all issues are addressed AND the test suite is green:",
    "  Run the full test suite, tee output to:",
    `    ${testLog}`,
    "  Write the verify report to:",
    `    ${verifyPath}`,
    "  The report MUST start with `VERDICT: PASS|PARTIAL|FAIL`.",
    ...REPORT_CONTRACT,
    "",
    "  Also record the suite's wall-clock seconds as `TEST_DURATION_S=<seconds>`",
    `  (one line) to: ${durationLog}`,
    "",
    BRANCH_DISCIPLINE,
    blockers(testCmd),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parallel slices (2026-09-04-parallel-slices-design.md, B / E / G / J). The lead's plan turn writes
// the machine-readable plan a verb can partition; the slice, prelude and absorb turns are the
// round-1 body with the phases the fan-out re-scopes swapped out. None of these emits
// END_OF_INSTRUCTION or the done line — inboxWrite appends both.
// ---------------------------------------------------------------------------

/** The lead's turns that are named rather than numbered: outside MAX_ROUNDS, lead-only, and each
 *  with its own completion evidence (see evidencePathFor). */
export const NAMED_ROUNDS = ["plan", "grill", "prelude", "absorb"] as const;
export type NamedRound = (typeof NAMED_ROUNDS)[number];

/** Where a turn's COMPLETION EVIDENCE lives (spec J — the premature-`done` hold resolves it, and
 *  turn-wait classifies TS=ok on it). The plan and grill turns write no verify report, so keying
 *  them on one would hold every healthy plan turn; a slice gets a per-agent report because parallel
 *  slices share the art dir. `agent` is the lead's call-sign for every lead turn. */
export function evidencePathFor(art: string, round: number | string, agent: string): string {
  const r = String(round);
  if (r === "plan" || r === "grill") return join(art, "plan.md");
  if (r === "prelude" || r === "absorb") return join(art, `verify-report-${r}.md`);
  return join(art, agent === "lead" ? `verify-report-${r}.md` : `verify-report-${agent}-${r}.md`);
}

/** The task contract restated for the grill turn — the same shape composePlanPrompt spells out at
 *  length, short enough to re-send with a refusal. */
const PLAN_CONTRACT_BRIEF = [
  "THE PLAN CONTRACT (unchanged):",
  "  - Head each task with `### T<n>: <title>`, then exactly one `files:` line",
  "    (repo-relative paths, comma-separated, no globs, a directory ends with",
  "    `/`) and one `depends:` line (task ids this task needs finished first,",
  "    or `none`), then the task's free text.",
  "  - End the plan with a `## Slices` section: one `prelude:` line (`none`",
  "    when nothing is a prerequisite) and one `slice:` line per group of tasks",
  "    that can run concurrently.",
];

/** Plan-only turn (1P.0): read the design, write plan.md, emit done, implement NOTHING. The two
 *  contracts are what make the plan machine-readable — `slice-check` parses the tasks and the hub
 *  decides the split from the `## Slices` proposal. */
export function composePlanPrompt(args: { designPath: string; planPath: string; maxSlices: number }): string {
  const { designPath, planPath, maxSlices } = args;
  return [
    "You are writing the implementation PLAN for /ap:implement — nothing else.",
    "",
    "This turn produces one file. Read the design doc, write the plan, emit done.",
    "Do NOT implement anything, do NOT edit any file other than the plan, do NOT",
    "commit. The implementation turns come after, and they read what you write here.",
    "",
    "PHASE 1: Plan",
    "  Read the design doc at:",
    `    ${designPath}`,
    "  Produce a comprehensive, task-by-task implementation plan. For each",
    "  task, identify its scope, intended changes, dependencies, and focused",
    "  verification. Write the plan to:",
    `    ${planPath}`,
    "",
    "TASK CONTRACT (a verb parses this — the shape is exact):",
    "",
    "    ### T1: <title>",
    "    files: src/core/gate.ts, src/core/gateKinds.ts",
    "    depends: none",
    "    <scope, intended changes, focused verification — free text>",
    "    ### T2: <title>",
    "    files: src/train/shards.ts",
    "    depends: T1",
    "",
    "  - Number the tasks T1, T2, ... and give each heading a title.",
    "  - `files:` lists every file the task creates or edits, comma-separated,",
    "    as repo-relative paths. No absolute paths, no globs (`*`, `?`, `[`);",
    "    a directory ends with `/`. The Hub uses these paths to keep parallel",
    "    workers off each other's files, so an omitted file is a collision.",
    "  - `depends:` lists the task ids this task needs finished first, or `none`.",
    "",
    "SLICE PROPOSAL (the last section of the plan):",
    "",
    "    ## Slices",
    "    prelude: T1, T2",
    "    slice: T3, T5",
    "    slice: T4",
    "",
    "  This is YOUR view of what can run CONCURRENTLY — you cut the tasks, so",
    "  you know their coupling best. What a good split looks like:",
    "  - `prelude:` names the tasks other tasks depend on; they are implemented",
    "    first, serially, before the rest start. Write `prelude: none` when",
    "    nothing is a prerequisite.",
    "  - Each `slice:` line is one worker's tasks. Tasks that share a file go on",
    "    the SAME line — two workers must never edit one file.",
    "  - A slice is worth at least a real hour of work; a ten-minute slice is not",
    "    worth its own worktree.",
    `  - At most ${maxSlices} \`slice:\` lines. Write ONE \`slice:\` line when the`,
    "    work does not split.",
    "  - The Hub DECIDES the grouping from this proposal — it may merge slices,",
    "    move a task into the prelude, or keep your proposal as it is. Propose;",
    "    the decision is not yours.",
    "",
    "When the plan is written, emit done.",
  ].join("\n");
}

/** Grill turn (1P.1, once per run): `slice-check` refused the plan's cut, and only the lead can
 *  re-cut it. The refusal lines go in VERBATIM — they name the exact tasks and paths at fault. */
export function composeGrillPrompt(args: { hubText: string; planPath: string; refusalLines: string[] }): string {
  const { hubText, planPath, refusalLines } = args;
  return [
    "The slice check REFUSED the plan you wrote at:",
    `    ${planPath}`,
    "",
    "ITS REFUSAL LINES, VERBATIM:",
    "",
    ...refusalLines,
    "",
    "WHAT THE HUB WAS TRYING TO GROUP, AND WHY:",
    "",
    hubText,
    "",
    ...PLAN_CONTRACT_BRIEF,
    "",
    "RE-CUT THE TASKS. You may split a task so a shared file moves into the",
    "prelude, fold two coupled tasks into one, or declare a dependency you had",
    "left implicit — what the Hub alone cannot do is change the cut. Rewrite",
    `${planPath} (its tasks AND its \`## Slices\` proposal) so the check passes,`,
    "then emit done.",
    "",
    "Do NOT implement anything and do NOT edit any file other than the plan.",
  ].join("\n");
}

/** A slice worker's round 1 (1P.4): the round-1 body under a SLICE mandate. `mandateText` is the
 *  hub-written label + tasks + owned absolute paths; the peers and out-of-slice rules below are the
 *  same for every slice. `testLog` / `durationLog` are explicit — see phase3SelfVerify. */
export function composeSliceRound1Prompt(args: {
  designPath: string; planPath: string; mandateText: string; verifyPath: string;
  testLog: string; durationLog: string; testCmd: string;
}): string {
  const { designPath, planPath, mandateText, verifyPath, testLog, durationLog, testCmd } = args;
  const sliceBlock = [
    "YOUR SLICE:",
    "",
    mandateText,
    "",
    "You are one of several slice workers running IN PARALLEL on this topic, each",
    "in its own git worktree on its own branch. The tasks and the files named",
    "above are yours; the plan's other tasks belong to your peers, who are",
    "working on them right now.",
    "",
    "OUT-OF-SLICE RULE (hard): never create, edit, or delete a file outside the",
    "paths above. If your tasks genuinely need a change elsewhere, record it in",
    "your verify report under a `## Out-of-slice changes needed` heading — the",
    "file, the line, and the exact change — and continue. The Hub carries it to",
    "the worker that owns that path.",
  ].join("\n");
  return roundOneShapedBody({
    round: 1, sliceBlock, planPath, verifyPath, testLog, durationLog, testCmd,
    phase1: [
      "PHASE 1: Scope (already planned)",
      "  The design doc is at:",
      `    ${designPath}`,
      `  ${planPath} is already written; your tasks are the ones named above —`,
      "  do not re-plan, do not touch other tasks. Read both for context, then",
      "  start implementing.",
    ],
    phase2: [
      "PHASE 2: Implement",
      "  Walk YOUR tasks task-by-task. Keep each change scoped to its task,",
      "  review the resulting diff against the plan, and commit per task",
      "  (Conventional Commits prefix). Run",
      testCmd
        ? `  the suite (\`${testCmd}\` as detected in your worktree) after each task;`
        : "  the suite (as detected in your worktree) after each task;",
      "  failures in tests you did not touch that name files outside your slice",
      "  are not yours to fix — list them in the report.",
    ],
  });
}

/** The serial prelude turn (1P.2), lead-only: the round-1 body scoped to the prerequisite tasks.
 *  PHASE 2's first sentence is replaced as well — the shipped one says "walk plan.md task-by-task",
 *  which would have the lead implement the WHOLE plan while the slices are about to. */
export function composePreludePrompt(args: {
  designPath: string; planPath: string; preludeIds: string[]; verifyPath: string;
  testLog: string; durationLog: string; testCmd: string;
}): string {
  const { designPath, planPath, preludeIds, verifyPath, testLog, durationLog, testCmd } = args;
  const ids = preludeIds.join(", ");
  return roundOneShapedBody({
    round: 1, planPath, verifyPath, testLog, durationLog, testCmd,
    phase1: [
      "PHASE 1: Scope (already planned)",
      "  The design doc is at:",
      `    ${designPath}`,
      `  ${planPath} is written. Your scope is ONLY tasks ${ids}; the rest will`,
      "  be implemented by parallel slice workers after you emit done.",
    ],
    phase2: [
      "PHASE 2: Implement",
      `  Walk ONLY tasks ${ids} of ${planPath} task-by-task. Keep each change`,
      "  scoped to its task, review the resulting diff against the plan, and",
      "  commit per task (Conventional Commits prefix). Run",
      testCmd
        ? `  the full test suite (\`${testCmd}\`) after each task and confirm green.`
        : "  the repository's full test suite after each task and confirm green.",
    ],
  });
}

/** The absorb turn (1P.8), lead-only, on the INTEGRATED branch: the round-1 PHASE 2/3 shape over the
 *  issues the slices left. `git merge` is not forbidden by BRANCH DISCIPLINE — checkout/switch/branch
 *  are — so the lead may merge a conflicting slice branch into the branch it is on. */
export function composeAbsorbPrompt(args: {
  designPath: string; planPath: string; issuesText: string; verifyPath: string;
  testLog: string; durationLog: string; testCmd: string;
}): string {
  const { designPath, planPath, issuesText, verifyPath, testLog, durationLog, testCmd } = args;
  return [
    "You are entering the ABSORB turn of /ap:implement.",
    "",
    "The parallel slice workers have finished and their branches are merged into",
    "the branch you are on. This turn closes what they left: implement each issue",
    "below, run the test suite, and write the verify report — all in one",
    "autonomous run.",
    SINGLE_DONE,
    "",
    "CONTEXT:",
    "  The design doc is at:",
    `    ${designPath}`,
    "  The plan is at:",
    `    ${planPath}`,
    "",
    "ISSUES TO ABSORB:",
    "",
    issuesText,
    "",
    "ROUTING:",
    "- For each issue tagged [slice]: those plan tasks were never implemented.",
    `  Plan them against ${planPath} and the design doc, implement them, and`,
    "  commit per task (Conventional Commits prefix).",
    "- For each issue tagged [integration]: that slice branch did not merge. Run",
    "  `git merge <branch>` on the branch you are on, resolve every conflict",
    "  keeping BOTH intents — the slice's and this branch's — and commit the",
    "  merge. Do NOT drop one side to make the conflict go away.",
    "- For each issue tagged [spec-gap]: a slice needed a change in a file it did",
    "  not own. Apply the exact change named, at the file and line named.",
    "",
    "PHASE 2: Implement",
    "  Walk the issues above one by one. Keep each change scoped to its issue,",
    "  review the resulting diff against the plan, and commit per issue",
    "  (Conventional Commits prefix). Run",
    testCmd
      ? `  the full test suite (\`${testCmd}\`) after each issue and confirm green.`
      : "  the repository's full test suite after each issue and confirm green.",
    "",
    ...phase3SelfVerify(verifyPath, testLog, durationLog),
    BRANCH_DISCIPLINE,
    blockers(testCmd),
  ].join("\n");
}
