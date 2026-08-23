// src/commands/bridge.ts — /ap:bridge collaborative cross-repo session.
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc } from "../core/archive.js";
import { agentBinary } from "../core/contracts.js";
import { haveCmd } from "../core/deps.js";
import { pickRandomAgent } from "../core/agents.js";
import { runnerAt, preSnapshot, createOrResumeBranch, currentBranch, finishBranchPrMerge, shortstat } from "../core/gitwork.js";
import type { Runner } from "../core/gitwork.js";
import { readIfExists, readField, kvField } from "../core/fsread.js";
import { branchNameFor, readBranchRecord } from "../core/branchRecord.js";
import { runForensics, runFlag } from "../core/forensics.js";
import { detectTestCommand } from "../core/quick.js";
import { repoRoot } from "../core/paths.js";
import { mainCheckoutRoot, orphanRefusal, orphanedTopicState, worktreeTopic } from "../core/job.js";
import { parseBridgeArgs, deriveSlug, bridgeArtDir, bridgeExecDir, renderBridgeSummary, renderBridgeResume } from "../core/bridge.js";
import type { BridgeSummaryFacts } from "../core/bridge.js";
import { composeBridgeBrief, composeBridgeFollowup } from "../core/bridgeTurn.js";
import { sendRound, waitRound, type RoundDescriptor, type RoundSendDeps, type RoundWaitDeps } from "../core/roundProtocol.js";
import { envNum, DEFAULT_TURN_BUDGET_S } from "../core/env.js";
import { outboxOffset, outboxPath } from "../core/ipc.js";
import { run as sendRun } from "./send.js";

function usage(): number {
  log.error("usage: bridge <init|branch|round-send|round-wait|relay|detect-test|finish|forensics|flag|summary> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  // ONE state tree per run, whatever directory the hub is standing in. Every state path derives from
  // process.cwd() (paths.ts stateRoot + repoHash), so a verb invoked from inside the run's own
  // worktree -- `<root>/.ap/worktrees/<topic>` -- hashed the WORKTREE and split the run across two
  // trees: half its state written where the other half could not see it. `mainCheckoutRoot` re-roots
  // ap-created run worktrees ONLY and leaves every other path (a user's own worktree included)
  // exactly as git reported it. Outside a git repo repoRoot() falls back to cwd, so this is a no-op.
  // (bridge's state belongs to repo A even though its WORK happens in repo B, so the state tree is
  // rooted here exactly as every other verb's is; `--repo` is work-location-only.)
  const origCwd = process.cwd();
  const gitRoot = repoRoot();
  const root = mainCheckoutRoot(gitRoot);
  const wtTopic = worktreeTopic(gitRoot);
  const stranded = orphanedTopicState(wtTopic, gitRoot, root);
  if (stranded) { for (const l of orphanRefusal(wtTopic, stranded, root).split("\n")) log.error(l); return 2; }
  if (root !== origCwd) process.chdir(root);
  try {
    return await dispatchVerb(args);
  } finally {
    // One verb per process on the CLI path (src/ap.ts exits right after), but tests import run() and
    // share a process, so the cwd is restored rather than left moved. A cwd that has since been
    // removed must not turn a completed verb into a throw.
    if (root !== origCwd) { try { process.chdir(origCwd); } catch { /* the caller's cwd is gone */ } }
  }
}

async function dispatchVerb(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest, { valueFlags: new Set(["--provider", "--repo"]) }));
    case "branch": return branchRun(rest);
    case "round-send": return roundSendRun(rest);
    case "round-wait": return roundWaitRun(rest);
    case "relay": return relayRun(rest);
    case "detect-test": return detectTestRun(rest);
    case "finish": return finishRun(rest);
    case "summary": return summaryRun(rest);
    case "forensics": return runForensics("bridge", bridgeArtDir, rest[0]);
    case "flag": return runFlag("bridge", rest[0], rest.slice(1).join(" "));
    default: return usage();
  }
}

export interface InitDeps {
  haveCmd(bin: string): boolean;
  agentBinary(provider: string): string | undefined;
  pickRandomAgent(slug: string): string | null;
  isGitRepo(dir: string): boolean;
  headSha(dir: string): string;
}
const liveInitDeps: InitDeps = {
  haveCmd, agentBinary, pickRandomAgent,
  isGitRepo: (dir) => runnerAt(dir).run("git", ["rev-parse", "--is-inside-work-tree"]).code === 0,
  headSha: (dir) => runnerAt(dir).run("git", ["rev-parse", "HEAD"]).stdout.trim(),
};

async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, liveInitDeps); }

export async function initWith(tokens: string[], d: InitDeps): Promise<number> {
  const { repo, taskText, provider: provArg, inPlace } = parseBridgeArgs(tokens);
  if (!taskText) { log.error("bridge init: task text is empty"); return 1; }
  if (!repo) { log.error("bridge init: --repo <abs-path> is required"); return 1; }
  if (!repo.startsWith("/") || /\s/.test(repo)) { log.error(`bridge init: --repo must be a whitespace-free absolute path: '${repo}'`); return 1; }
  if (!existsSync(repo)) { log.error(`bridge init: --repo does not exist: ${repo}`); return 1; }
  if (!inPlace && !d.isGitRepo(repo)) { log.error(`bridge init: --repo is not a git repository (use --in-place to skip isolation): ${repo}`); return 1; }

  const slug = deriveSlug(taskText);
  if (!slug) { log.error("bridge init: task produced an empty slug; provide alphanumerics"); return 1; }

  const provider = provArg ?? "codex";
  const binary = d.agentBinary(provider);
  if (!binary) { log.error(`bridge init: provider '${provider}' has no entry in contracts.yaml`); return 3; }
  if (!d.haveCmd(binary)) { log.error(`bridge init: ${provider}'s binary '${binary}' is not on PATH`); return 3; }

  const art = bridgeArtDir(slug);
  if (existsSync(art)) { log.error(`bridge init: topic already in flight: ${art}`); log.error("  run /ap:stop or pick a different task"); return 2; }

  const agent = d.pickRandomAgent(slug);
  if (!agent) { log.error(`bridge init: no available agent in the pool for '${slug}'`); return 1; }

  const mode = inPlace ? "in-place" : "branch";
  const exec = bridgeExecDir(slug);
  mkdirSync(exec, { recursive: true });
  atomicWrite(join(art, "topic.txt"), slug + "\n");
  atomicWrite(join(art, "topic-text.txt"), taskText);
  atomicWrite(join(art, "selected-provider.txt"), provider + "\n");
  atomicWrite(join(art, "agent.txt"), agent + "\n");
  atomicWrite(join(art, "timing.txt"), `started=${isoUtc()}\n`);
  atomicWrite(join(exec, "provider.txt"), provider + "\n");
  atomicWrite(join(exec, "mode.txt"), mode + "\n");
  atomicWrite(join(exec, "target_cwd.txt"), repo + "\n");      // INVARIANT: init owns this (branch is skipped under --in-place)
  atomicWrite(join(exec, "repo-b-head.txt"), (inPlace ? "" : d.headSha(repo)) + "\n");

  log.ok(`bridge init: topic=${slug} agent=${agent} provider=${provider} mode=${mode} repo=${repo}`);
  process.stdout.write(`SLUG=${slug}\nAGENT=${agent}\nPROVIDER=${provider}\nMODE=${mode}\nTARGET=${repo}\n`);
  return 0;
}

async function branchRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: bridge branch <topic>"); return 2; }
  const target = readField(join(bridgeExecDir(topic), "target_cwd.txt"));
  if (!target) { log.error("bridge branch: target_cwd.txt missing — run bridge init first"); return 1; }
  return branchWith(topic, target, runnerAt(target));
}

export async function branchWith(topic: string, target: string, r: Runner): Promise<number> {
  const snap = preSnapshot(r, "bridge", topic);
  if (snap.state === "not-git") { log.error(`bridge branch: ${target} is not a git repository`); return 1; }
  const branch = branchNameFor("bridge", topic);
  // Single-occupancy: refuse if repo B is already on a DIFFERENT bridge branch from another live session.
  if (snap.branch.startsWith(branchNameFor("bridge", "")) && snap.branch !== branch) {
    log.error(`bridge branch: ${target} is already on ${snap.branch} (another bridge session?) — refusing`);
    return 1;
  }
  const outcome = createOrResumeBranch(r, branch);
  // Refuse BEFORE anything is written, joining the rc-1 aborts above: bridge's finish MERGES, so
  // resuming a leftover from a SQUASH-merged run of this topic would merge already-merged work back.
  // The hub turns this rc into `bridge summary --aborted setup branch` (commands/bridge.md).
  if (outcome === "stale") {
    log.error(`bridge branch: ${branch} already exists in ${target} and has diverged from the current HEAD (its commits are likely already merged, e.g. by a squash merge) — refusing to resume it`);
    log.error(`  delete it (git -C ${target} branch -D ${branch}), rename it (git -C ${target} branch -m ${branch} <new-name>), or check it out by hand and re-run`);
    return 1;
  }
  const onBranch = outcome !== "failed";
  const exec = bridgeExecDir(topic);
  atomicWrite(join(exec, "start-branch.txt"), snap.branch + "\n");
  atomicWrite(join(exec, "branch-base.sha"), snap.baseSha + "\n");
  // The branch the run is ACTUALLY on, the way quick records it: a failed checkout leaves HEAD on the
  // start branch, and writing the intended name there is what lets a leftover feat/bridge-<topic> from
  // an earlier run pass finish's guard — and bridge's finish MERGES, so that ships a PR containing none
  // of this run's work. The worker's round-1 brief reads this file too.
  atomicWrite(join(exec, "branch.txt"), (onBranch ? branch : snap.branch) + "\n");
  if (!onBranch) { log.warn(`bridge branch: checkout ${branch} failed; staying on ${snap.branch}`); }
  log.ok(`bridge branch: ${branch} (snapshot=${snap.state}, base=${snap.baseSha.slice(0, 8)})`);
  return 0;
}

export type TurnSendDeps = RoundSendDeps;
export type TurnWaitDeps = RoundWaitDeps;

const DUET_TURN_TIMEOUT = envNum("AP_DUET_TURN_TIMEOUT", DEFAULT_TURN_BUDGET_S);

/** bridge's half of the shared send/wait skeleton (src/core/roundProtocol.ts). */
const BRIDGE_ROUND: RoundDescriptor = {
  command: "bridge",
  label: (verb) => `bridge round-${verb}`,
  initHint: "run bridge init",
  gateNoun: "round",
  artDir: bridgeArtDir,
  execDir: bridgeExecDir,
  stateFile: (exec, round) => join(exec, `round-${round}.txt`),
  promptFile: (exec, round) => join(exec, `round-prompt-${round}.md`),
  bundle: (exec, round) => ({ path: join(exec, `followup-${round}.md`), missingWording: "follow-up bundle missing" }),
  composeFirst: ({ art, exec }) => composeBridgeBrief(
    readIfExists(join(art, "topic-text.txt")),
    readField(join(exec, "target_cwd.txt")),
    readField(join(exec, "branch.txt")) || "the current branch",
  ),
  composeFollowup: composeBridgeFollowup,
  timeoutS: () => DUET_TURN_TIMEOUT,
  questionFile: (exec, round) => join(exec, `question-${round}.txt`),
};

async function roundSendRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  const round = Number(roundStr);
  if (!topic || !Number.isInteger(round) || round < 1) { log.error("usage: bridge round-send <topic> <round>=1.."); return 2; }
  return roundSendWith(topic, round, {
    offsetFor: (i, m, t) => outboxOffset(outboxPath(i, m, t)),
    send: (args) => sendRun(args),
  });
}

export async function roundSendWith(topic: string, round: number, d: TurnSendDeps): Promise<number> {
  return sendRound(BRIDGE_ROUND, topic, round, d);
}

async function roundWaitRun(rest: string[]): Promise<number> {
  const [topic, roundStr] = rest;
  const round = Number(roundStr);
  if (!topic || !Number.isInteger(round) || round < 1) { log.error("usage: bridge round-wait <topic> <round>=1.."); return 2; }
  return roundWaitWith(topic, round, {});
}

export async function roundWaitWith(topic: string, round: number, d: TurnWaitDeps): Promise<number> {
  return waitRound(BRIDGE_ROUND, topic, round, d);
}

async function relayRun(rest: string[]): Promise<number> {
  const [topic, roundStr, ...answerParts] = rest;
  const round = Number(roundStr);
  if (!topic || !Number.isInteger(round) || round < 1 || answerParts.length === 0) {
    log.error("usage: bridge relay <topic> <round> <answer|@file>"); return 2;
  }
  const art = bridgeArtDir(topic);
  const agent = readField(join(art, "agent.txt"));
  const provider = readField(join(art, "selected-provider.txt"));
  if (!agent || !provider) { log.error("bridge relay: missing agent/provider (run bridge init)"); return 1; }
  const answer = answerParts.join(" ");
  // NOTE: round-wait already bumped OFFSET past the question; relay only sends + records.
  const rc = await sendRun(["--from", "hub", agent, topic, answer]);
  if (rc !== 0) { log.error(`bridge relay: send failed (rc=${rc})`); return 1; }
  appendFileSync(BRIDGE_ROUND.questionFile(bridgeExecDir(topic), round), `RELAYED=${answer}\n`);
  log.ok(`bridge relay: round=${round} answered`);
  return 0;
}

async function detectTestRun(rest: string[]): Promise<number> {
  const cwd = rest[0] || repoRoot();
  process.stdout.write(detectTestCommand(cwd) + "\n");
  return 0;
}

async function finishRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: bridge finish <topic>"); return 2; }
  const target = readField(join(bridgeExecDir(topic), "target_cwd.txt"));
  if (!target) { log.error("bridge finish: target_cwd.txt missing/empty — refusing (will NOT fall back to the conductor repo)"); return 1; }
  return finishWith(topic, runnerAt(target), haveCmd("gh"));
}

export async function finishWith(topic: string, r: Runner, hasGh: boolean): Promise<number> {
  const exec = bridgeExecDir(topic);
  const rec = readBranchRecord("bridge", { dir: exec });
  if (rec.mode === "in-place") {
    atomicWrite(join(exec, "finish-result.txt"), "none\tin-place (commits on the current branch)\n");
    log.ok("bridge finish: in-place — commits left on the current branch");
    return 0;
  }
  const branch = rec.branch;
  const startBranch = rec.startBranch || "main";
  if (rec.baseSha) {
    const ds = shortstat(r, rec.baseSha);
    atomicWrite(join(exec, "diff-stats.txt"), (ds || "(no changes)") + "\n");
  }
  const task = readIfExists(join(bridgeArtDir(topic), "topic-text.txt"));
  const verify = readField(join(exec, "verify-result.txt"));
  const res = finishBranchPrMerge(r, {
    branch, base: startBranch, hasGh,
    title: `bridge: ${branch}`,
    body: `${task}\n\nVerify: ${verify}\n\n(Automated bridge branch — merged into ${startBranch}.)`,
  });
  atomicWrite(join(exec, "finish-result.txt"), `${res.action}\t${res.outcome}\n`);
  // The finisher's refusal — the branch is missing or IS the start branch, which is what a failed
  // `bridge branch` checkout now records — is a silent `none` in the record, so it gets a flag of its
  // own. Where the work actually sits is READ BACK, never assumed: this arm performs no checkout, so
  // HEAD is still wherever the branch step left it.
  // A refused base checkout is the same shape of silence — the finisher stopped before acting and
  // recorded it — so it takes the same read-back and flag, with its own cause. The CONSEQUENCE
  // depends on which arm refused: the remote arm stops after the push with a PR possibly open, the
  // no-remote arm never pushed anything, and a flag that claimed a PR either way would be the same
  // false record this outcome exists to prevent.
  if (res.outcome === "no-branch" || res.outcome === "base-checkout-failed") {
    const head = currentBranch(r) || "(detached)";
    const left = res.action === "local-merge"
      ? "this repo has no remote, so nothing was pushed and no PR exists"
      : "the branch WAS pushed and any PR opened for it is still open, unmerged";
    const why = res.outcome === "no-branch"
      ? `the recorded branch '${branch || "(unrecorded)"}' is missing or is the start branch '${startBranch}' — nothing was pushed, no PR opened`
      : `the checkout of the base branch '${startBranch}' was refused (check the checkout's own error: e.g. a dirty tree, the base held by another worktree, or the base ref gone) — nothing was merged and the local base was NOT updated; ${left}`;
    runFlag("bridge", topic, `finish-${res.outcome}: ${why}; the work (if any) is on '${head}'`);
  }
  log.ok(`bridge finish: ${res.action} → ${res.outcome}`);
  return 0;
}

async function summaryRun(rest: string[]): Promise<number> {
  const topic = rest[0];
  if (!topic) { log.error("usage: bridge summary <topic> [--aborted <phase> <gate> <reason...>]"); return 2; }
  const art = bridgeArtDir(topic);
  const exec = bridgeExecDir(topic);
  const started = kvField(join(art, "timing.txt"), "started") || "unknown";
  let ended: string | undefined, duration: number | undefined;
  const i = rest.indexOf("--aborted");
  const aborted = i >= 0;
  if (!aborted) {
    ended = isoUtc();
    const s = Date.parse(started), e = Date.parse(ended);
    duration = Number.isFinite(s) && Number.isFinite(e) ? Math.round((e - s) / 1000) : 0;
    atomicWrite(join(art, "timing.txt"), `started=${started}\nended=${ended}\nduration=${duration}\n`);
  }
  // count rounds = highest round-<n>.txt present (files are contiguous 1..K: round-send refuses to
  // overwrite an existing round-<n>.txt and the directive only ever advances the round by +1)
  let rounds = 0; while (existsSync(BRIDGE_ROUND.stateFile(exec, rounds + 1))) rounds++;

  const rec = readBranchRecord("bridge", { dir: exec });
  const facts: BridgeSummaryFacts = {
    topic, status: aborted ? "aborted" : "ok", started, ended, duration,
    provider: readField(join(art, "selected-provider.txt")) || "unknown",
    agent: readField(join(art, "agent.txt")) || "unknown",
    repo: readField(join(exec, "target_cwd.txt")) || "<repo>",
    // The RAW mode.txt, not the record's: this field is displayed (SUMMARY's `- Mode:` and RESUME's
    // restore line), and a hand-edited or corrupt value must show up rather than read as `branch`.
    // rec.mode is the DECISION (finish's in-place arm), which normalizes on purpose.
    mode: readField(join(exec, "mode.txt")) || "branch",
    branch: rec.branch || "(none)",
    rounds,
    verify: readField(join(exec, "verify-result.txt")) || "unknown",
    diffStats: readField(join(exec, "diff-stats.txt")) || "unknown",
    archived: readField(join(art, "archived-path.txt")) || "(not archived)",
    finishResult: readField(join(exec, "finish-result.txt")) || "(not finished)",
    abortedPhase: aborted ? rest[i + 1] : undefined,
    abortedGate: aborted ? rest[i + 2] : undefined,
    abortedReason: aborted ? rest.slice(i + 3).join(" ") || "unknown" : undefined,
  };
  atomicWrite(join(art, "SUMMARY.md"), renderBridgeSummary(facts));
  if (aborted) {
    atomicWrite(join(art, "RESUME.md"), renderBridgeResume({
      topic, repo: facts.repo, branch: facts.branch, mode: facts.mode, lastRound: rounds,
      task: readIfExists(join(art, "topic-text.txt")),
      phase: facts.abortedPhase ?? "unknown", gate: facts.abortedGate ?? "unknown",
    }));
  }
  log.ok(`bridge summary: wrote ${join(art, "SUMMARY.md")}`);
  return 0;
}
