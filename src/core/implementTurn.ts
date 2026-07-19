// src/core/implementTurn.ts — single-worker TURN machinery for `implement` (Phase A).
// Byte-faithful port of deploy-turn-wait.sh (the TS= state machine) + deploy_build_turn_prompt_round1
// and deploy_build_turn_prompt_fix. Mirrors designTurn.ts conventions; prompt composers OMIT
// END_OF_INSTRUCTION and the done line (inboxWrite appends them). A question round-trip is ONE
// logical turn; the re-armed wait reads the LATEST OFFSET= line (designTurn.parseLatestOffset).
import type { OutboxEvent } from "./ipc.js";
import { dirname } from "node:path";

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

const BRANCH_DISCIPLINE =
  "BRANCH DISCIPLINE (hard rule):\n" +
  "- You are operating on the conductor's current branch in the target\n" +
  "  repository. Do NOT run 'git checkout', 'git switch',\n" +
  "  'git branch -m', or create new branches.\n" +
  "- Commit per task with Conventional Commits prefixes on the current\n" +
  "  branch (rule already stated above).\n" +
  "- If your work genuinely needs a fresh branch, abort with\n" +
  '  {"event":"error","reason":"branch-discipline: needed new branch"}\n' +
  "  and let the conductor decide.\n";

function blockers(testCmd: string): string {
  const suiteLine = testCmd
    ? `  is NOT for running your test suite. Running '${testCmd}' is your job.\n  Banned values fail with rc=2.\n`
    : "  is NOT for running your test suite. Running your repository's test suite is your job.\n  Banned values fail with rc=2.\n";
  return (
    "BLOCKERS / QUESTIONS (read carefully):\n" +
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

/** Round-1 plan+implement+self-verify prompt body (port of deploy_build_turn_prompt_round1). MUST
 *  NOT include END_OF_INSTRUCTION or the done line. */
export function composeRound1Prompt(args: { designPath: string; planPath: string; verifyPath: string; round?: number; testCmd: string }): string {
  const { designPath, planPath, verifyPath, testCmd } = args;
  const round = args.round ?? 1;
  const testLog = `${dirname(verifyPath)}/test-output-${round}.log`;
  const durationLog = `${dirname(verifyPath)}/worker-test-duration-${round}.txt`;
  return [
    `You are entering ROUND ${round} of /ap:implement.`,
    "",
    "This is a single-turn workflow: you will write the implementation plan,",
    "implement it, run the test suite, and write the verify report — all in",
    "one autonomous run. The conductor will only re-engage when you emit done.",
    "",
    "RESUME CHECK (do this BEFORE starting):",
    `- If ${planPath} already exists, skip the planning phase — read the`,
    "  existing plan and proceed to implementation.",
    "- If `git log --oneline` shows commits past the design-doc commit on",
    `  this branch, identify the next pending task from ${planPath}'s checkbox`,
    "  state and continue from there. Do not redo already-committed tasks.",
    `- If ${verifyPath} already exists, you previously completed implementation`,
    `  — re-run the test suite and update ${verifyPath} if test outcomes changed.`,
    "",
    `PHASE 1: Plan (skip if ${planPath} exists)`,
    "  Read the design doc at:",
    `    ${designPath}`,
    "  Produce a comprehensive, task-by-task implementation plan. For each",
    "  task, identify its scope, intended changes, dependencies, and focused",
    "  verification. Write the plan to:",
    `    ${planPath}`,
    "",
    "PHASE 2: Implement",
    `  Walk ${planPath} task-by-task. Keep each change scoped to its task,`,
    "  review the resulting diff against the plan, and commit per task",
    "  (Conventional Commits prefix). Run",
    testCmd
      ? `  the full test suite (\`${testCmd}\`) after each task and confirm green.`
      : "  the repository's full test suite after each task and confirm green.",
    "",
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
    "  Also record how long the test suite itself took, in whole wall-clock",
    "  seconds, and write it as `TEST_DURATION_S=<seconds>` (one line) to:",
    `    ${durationLog}`,
    "  The Hub reads this: if your suite ran longer than its verify budget it",
    "  trusts your report instead of independently re-running — so measure the",
    "  actual suite run.",
    "",
    BRANCH_DISCIPLINE,
    blockers(testCmd),
  ].join("\n");
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
    "  Also record the suite's wall-clock seconds as `TEST_DURATION_S=<seconds>`",
    `  (one line) to: ${durationLog}`,
    "",
    BRANCH_DISCIPLINE,
    blockers(testCmd),
  ].join("\n");
}
