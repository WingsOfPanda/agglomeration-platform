// src/commands/quick.ts
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc } from "../core/archive.js";
import { repoRoot } from "../core/paths.js";
import { jobPath } from "../core/job.js";
import { quickArtDir, quickExecDir, deriveSlug, parseQuickArgs, parseBranchArgs, detectTestCommand, renderSummary, renderResume, type SummaryFacts } from "../core/quick.js";
import { runForensics, runFlag } from "../core/forensics.js";
import { agentBinary } from "../core/contracts.js";
import { haveCmd } from "../core/deps.js";
import { pickRandomAgent } from "../core/agents.js";
import { runnerAt, preSnapshot, createOrResumeBranch, finishBranch, classifyDirty, currentBranch, hasDistinctBranch, stashPush, stashPopOnBranch, targetProblem } from "../core/gitwork.js";
import type { Runner } from "../core/gitwork.js";
import { outboxOffset, outboxPath } from "../core/ipc.js";
import { composeRound1Prompt, composeFixPrompt } from "../core/turn.js";
import { sendRound, waitRound, type RoundDescriptor, type RoundSendDeps, type RoundWaitDeps } from "../core/roundProtocol.js";
import { envNum, DEFAULT_TURN_BUDGET_S } from "../core/env.js";
import { run as sendRun } from "./send.js";
import { readIfExists, readIfExistsOrNull, readField, kvField } from "../core/fsread.js";
import { branchNameFor, readBranchRecord } from "../core/branchRecord.js";
import { invisibleInTarget, pathTokensFrom } from "../core/implementScope.js";

function usage(): number {
  log.error("usage: quick <init|branch|turn-send|turn-wait|detect-test|finish|forensics|summary> ...");
  return 2;
}

export interface InitDeps {
  haveCmd(name: string): boolean;
  agentBinary(name: string): string | undefined;
  pickRandomAgent(topic: string): string | null;
}
const liveInitDeps: InitDeps = { haveCmd, agentBinary, pickRandomAgent };

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest, { valueFlags: new Set(["--provider"]) }));
    case "branch": return branchRun(rest);
    case "turn-send": return turnSendRun(rest);
    case "turn-wait": return turnWaitRun(rest);
    case "detect-test": return detectTestRun(rest);
    case "finish": return finishRun(rest);
    case "forensics": return forensicsRun(rest);
    case "flag": return runFlag("quick", rest[0], rest.slice(1).join(" "));
    case "summary": return summaryRun(rest);
    default: return usage();
  }
}

// ---- forensics (delegates to core runForensics). Feeds /ap:review. ----
export async function forensicsRun(rest: string[]): Promise<number> {
  return runForensics("quick", quickArtDir, rest[0]);
}

async function initRun(tokens: string[]): Promise<number> {
  return initWith(tokens, liveInitDeps);
}

export async function initWith(tokens: string[], d: InitDeps): Promise<number> {
  const { topicText, provider: provArg, finish, stashWip, target: targetArg } = parseQuickArgs(tokens);
  if (targetArg) {
    const bad = targetProblem(targetArg);
    if (bad) { log.error(`quick init: ${bad}`); return 1; }
  }
  if (!topicText) { log.error("quick init: topic text is empty"); return 1; }
  const slug = deriveSlug(topicText);
  if (!slug) { log.error("quick init: topic produced an empty slug; provide alphanumerics"); return 1; }

  const provider = provArg ?? "codex";
  const binary = d.agentBinary(provider);
  if (!binary) { log.error(`quick init: provider '${provider}' has no entry in contracts.yaml`); return 3; }
  if (!d.haveCmd(binary)) { log.error(`quick init: ${provider}'s binary '${binary}' is not on PATH`); return 3; }

  const art = quickArtDir(slug);
  if (existsSync(art)) { log.error(`quick init: topic already in flight: ${art}`); log.error("  run /ap:stop or pick a different topic"); return 2; }

  const agent = d.pickRandomAgent(slug);
  if (!agent) { log.error(`quick init: no available agent in the pool for '${slug}'`); return 1; }

  const exec = quickExecDir(slug);
  mkdirSync(exec, { recursive: true });
  atomicWrite(join(art, "topic.txt"), slug + "\n");
  atomicWrite(join(art, "topic-text.txt"), topicText);
  atomicWrite(join(art, "selected-provider.txt"), provider + "\n");
  atomicWrite(join(art, "agent.txt"), agent + "\n");
  atomicWrite(join(art, "timing.txt"), `started=${isoUtc()}\n`);
  atomicWrite(join(exec, "provider.txt"), provider + "\n");
  atomicWrite(join(exec, "finish.txt"), (finish ? "yes" : "no") + "\n");
  // A durable record of what was REQUESTED — nothing reads this file. The branch step gets the flag
  // from the `STASH_WIP=` line echoed below (the directive re-reading $ARGUMENTS by eye is what
  // dropped it whenever the topic text was long); the file outlives that echo in the archived state
  // dir, where a forensics reader can still see the flag was asked for.
  atomicWrite(join(exec, "stash-wip-requested.txt"), (stashWip ? "yes" : "no") + "\n");

  // Echoed, never recorded here: `quick branch` is what writes target_cwd.txt, and it is passed the
  // same --target. A detached run's target is the isolated worktree `job start` forked, so nothing
  // in this run touches the checkout the operator is still using.
  const target = targetArg || repoRoot();
  log.ok(`quick init: topic=${slug} agent=${agent} provider=${provider} finish=${finish ? "yes" : "no"} stash-wip=${stashWip ? "yes" : "no"}`);
  process.stdout.write(`SLUG=${slug}\nAGENT=${agent}\nPROVIDER=${provider}\nFINISH=${finish ? "yes" : "no"}\nTARGET=${target}\nSTASH_WIP=${stashWip ? "yes" : "no"}\n`);
  return 0;
}
async function branchRun(rest: string[]): Promise<number> {
  const { topic, stashWip, target: targetArg } = parseBranchArgs(rest);
  if (!topic) { log.error("usage: quick branch [--target <abs>] <topic> [--stash-wip]"); return 2; }
  if (targetArg) {
    const bad = targetProblem(targetArg);
    if (bad) { log.error(`quick branch: ${bad}`); return 1; }
  }
  const target = targetArg || repoRoot();
  return branchWith(topic, target, runnerAt(target), stashWip);
}

/** The stash name a --stash-wip park carries — also the identity finish restores by. */
function stashWipMessage(topic: string): string { return `ap-quick-${topic}-wip`; }

/** The `--stash-wip` marker written by `quick branch`, or null when this run parked nothing. The
 *  message falls back to the canonical name for a marker written before the name was recorded. */
function readStashMarker(exec: string, topic: string): { sha: string; message: string } | null {
  const raw = readIfExistsOrNull(join(exec, "stash-wip.txt"));
  if (raw === null) return null;
  const [sha, name] = raw.split("\n")[0].trim().split("\t");
  return { sha: sha ?? "", message: name || stashWipMessage(topic) };
}

/** The state namespace, reachable ONLY by an absolute path: the state dir is keyed to the repo ROOT
 *  (sha256 of its realpath), so a relative `_quick/...` resolves against whatever cwd the worker
 *  happens to hold — which under `--target` is not the repo the state dir belongs to. */
const STATE_RELATIVE_PREFIXES = ["_quick/", "_implement/", ".ap/"];

/** Warn-only brief lint (2026-08-23-brief-path-correctness-design.md, C2). Reads the hub's
 *  `task-brief.md` and reports two classes of path citation that cannot resolve where the worker
 *  will stand:
 *
 *   1. INVISIBLE — cited paths that exist in the origin checkout and are MISSING in the target,
 *      through the shared `invisibleInTarget` predicate. The differential is what keeps this channel
 *      worth reading: a plain missing-path check fires on every file the brief intends to CREATE.
 *   2. STATE_RELATIVE — a RELATIVE path into the state namespace. Unconditional, because it is never
 *      correct: this is exactly the `_quick/topic-text.txt` citation that cost a field run a whole
 *      question round. This class alone files ONE forensics flag, so /ap:review can trend it; the
 *      invisible class warns and records without a flag (a brief may legitimately cite an
 *      about-to-be-created file that happens to exist here).
 *
 *  Both classes land in `<exec>/brief-lint.txt` — the layer that knows records its own verdict,
 *  because stdout is gone once the reading hub's turn ends. rc is NOT this function's to change (rc
 *  1 stays reserved for not-a-git-repo) and the brief is never rewritten. Called AFTER the
 *  `target_cwd.txt` write so a not-git abort records nothing at all. */
function lintBrief(topic: string, target: string, exec: string): void {
  const brief = readIfExistsOrNull(join(quickArtDir(topic), "task-brief.md"));
  if (brief === null) return;
  const cited: string[] = [];
  for (const line of brief.split("\n")) cited.push(...pathTokensFrom(line));
  const root = repoRoot();
  const invisible = invisibleInTarget(cited, root, target);
  const stateRelative: string[] = [];
  for (const p of cited) {
    if (isAbsolute(p) || stateRelative.includes(p)) continue;
    if (STATE_RELATIVE_PREFIXES.some((pre) => p.startsWith(pre))) stateRelative.push(p);
  }
  for (const p of invisible) {
    log.warn(`quick branch: brief cites ${p}, which exists in ${root} but NOT in the target ${target} — the worker cannot read it; cite it absolute or commit it first`);
  }
  for (const p of stateRelative) {
    log.warn(`quick branch: brief cites the state path ${p} RELATIVE — the state dir is keyed to the repo root and never travels with --target; cite it absolute`);
  }
  atomicWrite(join(exec, "brief-lint.txt"),
    `MAIN_ROOT=${root}\nTARGET_CWD=${target}\n` +
    `INVISIBLE_IN_TARGET=${invisible.length}\n` + invisible.map((p) => `INVISIBLE_PATH=${p}\n`).join("") +
    `STATE_RELATIVE=${stateRelative.length}\n` + stateRelative.map((p) => `STATE_RELATIVE_PATH=${p}\n`).join(""));
  // ONE flag, for the state-relative class only.
  if (stateRelative.length > 0) {
    runFlag("quick", topic, `brief-state-relative: the brief cites ${stateRelative.length} state path(s) RELATIVE (${stateRelative.join(", ")}) — unresolvable from the worker's cwd; state paths must be cited absolute`);
  }
}

/** Testable core: snapshot + branch the target repo, recording execute/ facts. */
export async function branchWith(topic: string, target: string, r: Runner, stashWip = false): Promise<number> {
  const exec = quickExecDir(topic);
  mkdirSync(exec, { recursive: true }); // atomicWrite does not create parents, and `quick branch`
                                        // can run without an init (a bare re-run) — an EEXIST throw
                                        // here would land AFTER the tree was already emptied.
  // --stash-wip: park pre-existing WIP BEFORE preSnapshot, so the branch forks from clean HEAD and
  // the PR base carries no unrelated snapshot commit. An unstashable tree must not block the run.
  // The dirty gate reads --untracked-files=all: a repo with `status.showUntrackedFiles no` makes a
  // bare --porcelain report a clean tree that git will still refuse to leave behind.
  if (stashWip && classifyDirty(r.run("git", ["status", "--porcelain", "--untracked-files=all"]).stdout)) {
    const message = stashWipMessage(topic);
    const st = stashPush(r, message);
    switch (st.outcome) {
      case "parked":
        log.ok(`quick branch: stashed pre-existing WIP as '${message}' (restored at finish)`);
        break;
      case "partial":
        log.warn(`quick branch: --stash-wip parked '${message}' but the tree is STILL dirty — some paths could not be stashed (e.g. a nested repo or submodule content)`);
        log.warn(`  those residual paths stay in the tree for the snapshot path below, exactly as they would without the flag`);
        break;
      case "failed-with-entry":
        log.warn(`quick branch: --stash-wip reported failure but LEFT a stash entry '${message}' — finish will restore it`);
        log.warn(`  the tree may still hold the same changes; if it does, the WIP snapshot commit below commits them too`);
        break;
      case "none":
        break; // git stashed nothing (e.g. only submodule content changed) — no park to record
      case "failed":
        log.warn(`quick branch: --stash-wip could not stash the tree; falling back to a WIP snapshot commit`);
        break;
    }
    // The marker is written AFTER the logging: the log line is the user's only pointer if this write
    // fails, and a stash nobody knows about is the failure this whole path guards. Every outcome that
    // left an entry gets one — including `failed-with-entry`, whose sha can be empty, so the test is
    // `entryExists` and NOT `st.sha`: an unresolvable ref still parked the user's work.
    if (st.entryExists) {
      atomicWrite(join(exec, "stash-wip.txt"), `${st.sha}\t${message}\n`);
    }
  }
  const snap = preSnapshot(r, "quick", topic);
  if (snap.state === "not-git") { log.error(`quick branch: ${target} is not a git repository`); return 1; }
  const branch = branchNameFor("quick", topic);
  const outcome = createOrResumeBranch(r, branch);
  // Refuse BEFORE anything is written: a leftover branch from a SQUASH-merged run of this same topic
  // is not a continuation of this checkout, and resuming it opens a PR re-proposing merged work.
  // ap touches nobody's branch — the operator picks the remedy.
  if (outcome === "stale") {
    log.error(`quick branch: ${branch} already exists in ${target} and has diverged from the current HEAD (its commits are likely already merged, e.g. by a squash merge) — refusing to resume it`);
    log.error(`  delete it (git -C ${target} branch -D ${branch}), rename it (git -C ${target} branch -m ${branch} <new-name>), or check it out by hand and re-run`);
    return 1;
  }
  const onBranch = outcome !== "failed";
  atomicWrite(join(exec, "target_cwd.txt"), target + "\n");
  lintBrief(topic, target, exec);
  atomicWrite(join(exec, "start-branch.txt"), snap.branch + "\n");
  atomicWrite(join(exec, "branch-base.sha"), snap.baseSha + "\n");
  // The branch the run is ACTUALLY on, the way implement records its `recorded`: a failed checkout
  // leaves HEAD on the start branch, and writing the intended name there is what lets a leftover
  // feat/quick-<topic> from an earlier run pass finish's guard and ship as a PR containing none of
  // this run's work. The worker's round-1 prompt reads this file too.
  atomicWrite(join(exec, "branch.txt"), (onBranch ? branch : snap.branch) + "\n");
  if (!onBranch) { log.warn(`quick branch: checkout ${branch} failed; staying on ${snap.branch}`); }
  log.ok(`quick branch: ${branch} (snapshot=${snap.state}, base=${snap.baseSha.slice(0, 8)})`);
  return 0;
}
export type TurnSendDeps = RoundSendDeps;
export type TurnWaitDeps = RoundWaitDeps;

const QUICK_TURN_TIMEOUT = envNum("AP_QUICK_TURN_TIMEOUT", DEFAULT_TURN_BUDGET_S);

/** quick's half of the shared send/wait skeleton (src/core/roundProtocol.ts). */
const QUICK_ROUND: RoundDescriptor = {
  command: "quick",
  label: (verb) => `quick turn-${verb}`,
  initHint: "run quick init",
  gateNoun: "turn",
  artDir: quickArtDir,
  execDir: quickExecDir,
  stateFile: (exec, round) => join(exec, `turn-${round}.txt`),
  promptFile: (exec, round) => join(exec, `turn-prompt-${round}.md`),
  bundle: (exec, round) => ({ path: join(exec, `fix-prompt-${round}.md`), missingWording: "fix bundle missing" }),
  composeFirst: ({ art, exec, topic }) => composeRound1Prompt(
    readIfExists(join(art, "task-brief.md")),
    readField(join(exec, "branch.txt")) || branchNameFor("quick", topic),
  ),
  composeFollowup: composeFixPrompt,
  timeoutS: () => QUICK_TURN_TIMEOUT,
  questionFile: (exec, round) => join(exec, `question-${round}.txt`),
};

async function turnSendRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  const round = Number(roundStr);
  if (!topic || !Number.isInteger(round) || round < 1) { log.error("usage: quick turn-send <topic> <round>=1.."); return 2; }
  return turnSendWith(topic, round, {
    offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)),
    send: (args) => sendRun(args),
  });
}

export async function turnSendWith(topic: string, round: number, d: TurnSendDeps): Promise<number> {
  return sendRound(QUICK_ROUND, topic, round, d);
}

async function turnWaitRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  const round = Number(roundStr);
  if (!topic || !Number.isInteger(round) || round < 1) { log.error("usage: quick turn-wait <topic> <round>=1.."); return 2; }
  return turnWaitWith(topic, round, {});
}

export async function turnWaitWith(topic: string, round: number, d: TurnWaitDeps): Promise<number> {
  return waitRound(QUICK_ROUND, topic, round, d);
}
async function detectTestRun(rest: string[]): Promise<number> {
  const cwd = rest[0] || repoRoot();
  process.stdout.write(detectTestCommand(cwd) + "\n");
  return 0;
}
async function finishRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: quick finish <topic>"); return 2; }
  const target = readField(join(quickExecDir(topic), "target_cwd.txt")) || repoRoot();
  return finishWith(topic, runnerAt(target), haveCmd("gh"));
}

/** Restore a --stash-wip park onto the (just-restored) start branch, returning the line
 *  finish-result.txt appends (`"stash-wip-kept\n"`, or "" when there is nothing to report). Never
 *  drops the stash: a wrong HEAD, an identity mismatch, an unreadable stash list or a pop conflict
 *  all KEEP both the entry and the marker, and record a hub flag so the WIP surfaces in /ap:review
 *  long after this run's state is archived.
 *  The one case that removes the marker WITHOUT popping is a verified absence — the list read fine
 *  and holds no entry with our message (the user popped it by hand). Nothing is left to keep, and a
 *  marker pointing at nothing would only make every later finish warn about a stash that is gone. */
function restoreStashWip(topic: string, exec: string, r: Runner, startBranch: string): string {
  const parked = readStashMarker(exec, topic);
  if (!parked) return "";
  const { sha, message } = parked;
  const marker = join(exec, "stash-wip.txt");
  const kept = (): string => {
    const target = readField(join(exec, "target_cwd.txt")) || "<target>";
    runFlag("quick", topic, `stash-wip-kept: WIP still stashed as '${message}' in ${target}; restore: git checkout ${startBranch} then git stash pop`);
    return "stash-wip-kept\n";
  };
  // The start-branch checkout above can fail SILENTLY (a worker that left the tree dirty blocks it),
  // so the pop goes through stashPopOnBranch, which proves HEAD before touching the stash.
  const { outcome, head } = stashPopOnBranch(r, message, sha, startBranch);
  if (outcome === "wrong-head") {
    log.warn(`quick finish: HEAD is on '${head || "(detached)"}', not the start branch '${startBranch}' — NOT popping`);
    log.warn(`  the WIP stays stashed as '${message}': git checkout ${startBranch}  then  git stash pop <ref>`);
    return kept();
  }
  switch (outcome) {
    case "popped":
      rmSync(marker, { force: true });
      log.ok(`quick finish: restored stashed WIP '${message}'`);
      return "";
    case "not-found":
      rmSync(marker, { force: true });
      log.warn(`quick finish: no stash entry named '${message}' (popped already?); nothing to restore`);
      return "";
    case "list-failed":
      log.warn(`quick finish: could not read the stash list — assuming '${message}' is still parked, NOT popping`);
      return kept();
    case "identity-mismatch":
      log.warn(`quick finish: stash identity mismatch — not popping; the entry named '${message}' is not the one this run parked (expected sha ${sha || "(unrecorded)"})`);
      return kept();
    default: // conflict-kept
      log.warn(`quick finish: stashed WIP '${message}' did NOT restore — it is KEPT in the stash`);
      log.warn(`  recover it by hand in the target repo: git stash list  then  git stash pop <ref>`);
      log.warn(`  the park included untracked files, so a conflicted pop may ALREADY have extracted some of them:`);
      log.warn(`  if the pop says "<file> already exists", remove those extracted files first (or git checkout <ref> -- .), then pop again`);
      return kept();
  }
}

export async function finishWith(topic: string, r: Runner, hasGh: boolean): Promise<number> {
  const exec = quickExecDir(topic);
  const rec = readBranchRecord("quick", { dir: exec });
  const branch = rec.branch;
  const startBranch = rec.startBranch || "main";
  // The mechanical half of a detached run's "push nothing, open no PR" — the directive's prose does
  // not stop a mis-instructed hub. A `_job` record for this topic means nobody is watching, so
  // publication is off whatever finish.txt says: the run ends on its branch and the OPERATOR
  // finishes it (the `--finish pr` opt-in was removed 2026-08-18, taking the recorded-action
  // indirection with it). It routes to the branch-only arm below rather than refusing outright: that
  // arm restores the start branch and pops a --stash-wip park, and a bare refusal here would strand
  // the operator's stashed WIP.
  const detachedJob = existsSync(jobPath(topic));
  if (detachedJob) log.warn(`quick finish: a detached job record is present (${jobPath(topic)}) — publication is disabled; the run ends on its branch and the operator finishes it`);
  const doFinish = readField(join(exec, "finish.txt")) === "yes" && !detachedJob;

  if (!doFinish) {
    r.run("git", ["checkout", "-q", startBranch]);
    const kept = restoreStashWip(topic, exec, r, startBranch);
    atomicWrite(join(exec, "finish-result.txt"), `none\tbranch-only (kept ${branch})\n` + kept);
    log.ok(`quick finish: branch-only — kept ${branch}, restored ${startBranch}`);
    return 0;
  }
  // branch.txt records the branch the run actually ended on, so a failed checkout arrives here as
  // `branch === startBranch` and is refused below. The ref probe still earns its place: the branch can
  // be gone by finish time (deleted by hand, or a state dir carried over from another run), and a
  // finish that trusts the record would push a ref that does not exist and record `pr-failed-kept` — a
  // PR problem, when the truth is there was no branch to act on. Refuse loudly instead, and say so.
  if (!hasDistinctBranch(r, branch, startBranch)) {
    const named = branch || "(unrecorded)";
    // The recover line names a branch to CREATE, and quick has no --branch flag, so that name is
    // always the topic-derived one: the record either already IS it (its ref went missing) or is the
    // start branch, and `git checkout -b main` while on main is a dead end.
    log.warn(`quick finish: no branch '${named}' distinct from the start branch '${startBranch}' — NOTHING was pushed and no PR was opened`);
    log.warn(`  recover: re-run the branch step in the target repo (git checkout -b ${branchNameFor("quick", topic)}), commit the work, then finish again`);
    r.run("git", ["checkout", "-q", startBranch]);
    // Where the work actually sits is READ BACK, never assumed: this checkout is best-effort and a
    // dirty tree blocks it silently, so a flag naming the start branch could send the user looking
    // on a branch the run never reached. Recorded for the summary as well, and BEFORE the result:
    // this refusal covers three shapes (nothing recorded / the record is the start branch / the ref
    // went away), and the real HEAD is the only pointer true in all three.
    const head = currentBranch(r) || "(detached)";
    atomicWrite(join(exec, "finish-head.txt"), head + "\n");
    const keptNoBranch = restoreStashWip(topic, exec, r, startBranch);
    atomicWrite(join(exec, "finish-result.txt"), "none\tno-branch\n" + keptNoBranch);
    runFlag("quick", topic, `finish-no-branch: the recorded branch '${named}' is missing or is the start branch '${startBranch}' — nothing was pushed, no PR opened; the work (if any) is on '${head}'`);
    return 0;
  }
  const brief = readIfExists(join(quickArtDir(topic), "task-brief.md"));
  const verify = readField(join(exec, "verify-result.txt"));
  const res = finishBranch(r, {
    branch, startBranch, hasGh,
    title: `quick: ${branch}`,
    body: `${brief}\n\nVerify: ${verify}\n\n(Automated quick branch — review and merge into ${startBranch}.)`,
  });
  const kept = restoreStashWip(topic, exec, r, startBranch);
  atomicWrite(join(exec, "finish-result.txt"), `${res.action}\t${res.outcome}\n` + kept);
  log.ok(`quick finish: ${res.action} → ${res.outcome}`);
  return 0;
}
async function summaryRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: quick summary <topic> [--aborted <phase> <gate> <reason...>]"); return 2; }
  const art = quickArtDir(topic);
  const exec = quickExecDir(topic);

  const rec = readBranchRecord("quick", { dir: exec });
  const started = kvField(join(art, "timing.txt"), "started") || "unknown";
  let ended: string | undefined;
  let duration: number | undefined;

  const i = rest.indexOf("--aborted");
  const aborted = i >= 0;
  if (!aborted) {
    ended = isoUtc();
    const s = Date.parse(started), e = Date.parse(ended);
    duration = Number.isFinite(s) && Number.isFinite(e) ? Math.round((e - s) / 1000) : 0;
    atomicWrite(join(art, "timing.txt"), `started=${started}\nended=${ended}\nduration=${duration}\n`);
  }

  const facts: SummaryFacts = {
    topic,
    status: aborted ? "aborted" : "ok",
    started, ended, duration,
    provider: readField(join(art, "selected-provider.txt")) || "unknown",
    agent: readField(join(art, "agent.txt")) || "unknown",
    branch: rec.branch || "unknown",
    verify: readField(join(exec, "verify-result.txt")) || "unknown",
    diffStats: readField(join(exec, "diff-stats.txt")) || "unknown",
    archived: readField(join(art, "archived-path.txt")) || "(not archived)",
    targetCwd: readField(join(exec, "target_cwd.txt")) || "<target>",
    branchBase: rec.baseSha || "<base>",
    finishResult: readField(join(exec, "finish-result.txt")),
    finishHead: readField(join(exec, "finish-head.txt")) || "unknown",
    abortedPhase: aborted ? rest[i + 1] : undefined,
    abortedGate: aborted ? rest[i + 2] : undefined,
    abortedReason: aborted ? rest.slice(i + 3).join(" ") || "unknown" : undefined,
  };

  atomicWrite(join(art, "SUMMARY.md"), renderSummary(facts));
  if (aborted) {
    // An abort leaves a --stash-wip park unrestored (finish never ran), and HEAD may still be on
    // the quick branch — so RESUME points at the stash AND at the checkout that must precede a pop.
    const stashName = readStashMarker(exec, topic)?.message ?? "";
    const startBranch = rec.startBranch || "<start-branch>";
    atomicWrite(join(art, "RESUME.md"), renderResume({
      topic, branch: facts.branch, artDir: art, phase: facts.abortedPhase ?? "unknown", gate: facts.abortedGate ?? "unknown",
      stashNote: stashName
        ? `Pre-existing WIP is parked in stash '${stashName}' — restore with: git -C ${facts.targetCwd} checkout ${startBranch}  then  git stash pop <ref>`
        : undefined,
    }));
  }
  log.ok(`quick summary: wrote ${join(art, "SUMMARY.md")}`);
  return 0;
}
