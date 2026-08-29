// src/commands/job.ts — `ap job <sub>`: launch and observe a DETACHED run.
//
// The origin hub (the operator's own Claude Code session) uses these verbs and nothing else. It
// launches with `start`, watches with `status` / `wait`, answers a parked question with `relay`,
// recovers a view after its own restart with `attach`, and tears down with `stop`. It never talks
// to the job's WORKERS — only the job hub does, because a second sender mid-run overwrites a
// running worker's inbox task and the worker idles.

import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { kvParse } from "../args.js";
import { log } from "../core/log.js";
import { atomicWrite } from "../core/atomic.js";
import { readIfExists } from "../core/fsread.js";
import { jobDir, topicDir, repoStateDir, repoRoot, isArtifactDir } from "../core/paths.js";
import { isoUtc } from "../core/archive.js";
import { validateSlug } from "../core/slug.js";
import { envNum } from "../core/env.js";
import { pickRandomAgent } from "../core/agents.js";
import { deriveSlug } from "../core/quick.js";
import { livePaneNonces, ownsPane, sessionExists, sessionPaneIds, killSession, validSessionName, currentSessionName } from "../core/tmux.js";
import { paneMetaRead, paneMetaReadForDir, outboxPath, statusPath, type Clock, type OutboxEvent } from "../core/ipc.js";
import { liveOutboxWait } from "../core/waitLive.js";
import { scanTopicWorkers } from "../core/workerLiveness.js";
import { percentEncode } from "../core/questionCodec.js";
import { runnerAt, classifyDirty, currentBranch, type Runner } from "../core/gitwork.js";
import { branchNameFor } from "../core/branchRecord.js";
import * as J from "../core/job.js";
import { run as spawnRun } from "./spawn.js";
import { run as sendRun } from "./send.js";
import { teardownTopic } from "./stop.js";

function usage(): number {
  process.stderr.write(
    "Usage: job start --command <implement|quick> --args-file <path> [--topic slug] [--provider p]\n" +
    "                 [--budget-hours N] [--max-rounds N] [--hub-model claude]\n" +
    "                 [--no-worktree]   work in the main checkout, as 0.5.35 did\n" +
    "                 [--allow-invisible-doc]  launch even when the implement design doc is uncommitted\n" +
    "       job status <topic>          one-screen composite: what was launched, is it alive, where is it\n" +
    "       job wait <topic>            block until the job hub emits done/error/question\n" +
    "       job relay <topic> <msg|@file>   answer a parked question\n" +
    "       job attach <topic>          re-arm block, after the origin hub restarted\n" +
    "       job list                    every job in this repo\n" +
    "       job stop <topic>            tear down, sweep the session, clear the record\n" +
    "       job mode <topic>            DETACHED=1 (exit 0) / DETACHED=0 (exit 1)\n" +
    "       job budget-check <topic>    BUDGET=within (exit 0) / exceeded (exit 1)\n");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  // ONE namespace for the two processes that share a job. Every state path derives from
  // process.cwd() (paths.ts stateRoot + repoHash), and the job hub is launched with cwd=repoRoot(),
  // so an origin process invoked from a repo SUBDIRECTORY would resolve a different `_job` tree than
  // its own hub: same topic, two records. `job mode` then prints DETACHED=0 to the hub, which takes
  // the directive's "ordinary attached run" branch and finishes by pushing and opening a PR — the
  // exact thing detachment refuses — and identity/status/inbox split along with it. Outside a git
  // repo repoRoot() falls back to cwd, so this is a no-op there.
  // And ONE namespace across the two CHECKOUTS a worktree run has. `repoRoot()` from inside
  // `.ap/worktrees/<topic>` reports the WORKTREE's toplevel, so a verb invoked there hashed a
  // different repo path, found no record, and answered from an empty namespace: `budget-check`
  // printed `BUDGET=unknown` rc 1 — indistinguishable from "budget exhausted" — on a healthy
  // 0.62h/2h run. `mainCheckoutRoot` re-roots ap-created run worktrees only, and leaves every other
  // path (a user's own worktree included) exactly as git reported it.
  const origCwd = process.cwd();
  const root = J.mainCheckoutRoot(repoRoot());
  if (root !== origCwd) process.chdir(root);
  try {
    return await dispatchSub(sub, rest, origCwd);
  } finally {
    // One verb per process on the CLI path (src/ap.ts exits right after), but tests import run() and
    // share a process, so the cwd is restored rather than left moved. A cwd that has since been
    // removed must not turn a completed verb into a throw.
    if (root !== origCwd) { try { process.chdir(origCwd); } catch { /* the caller's cwd is gone */ } }
  }
}

async function dispatchSub(sub: string, rest: string[], origCwd: string): Promise<number> {
  switch (sub) {
    case "start":        return startRun(rest, origCwd);
    case "status":       return statusRun(rest);
    case "wait":         return waitRun(rest);
    case "relay":        return relayRun(rest);
    case "attach":       return attachRun(rest);
    case "list":         return listRun();
    case "stop":         return stopJobRun(rest);
    case "mode":         return modeRun(rest);
    case "budget-check": return budgetCheckRun(rest);
    default:             return usage();
  }
}

// ---------- shared reads ----------

function readJob(topic: string): J.JobRecord | null {
  return J.parseJob(readIfExists(J.jobPath(topic)));
}
function requireJob(topic: string, verb: string): J.JobRecord | null {
  if (!topic || !validateSlug(topic)) { log.error(`job ${verb}: topic must match [a-z0-9-]+ and be <= 32 chars; got: '${topic}'`); return null; }
  const rec = readJob(topic);
  if (!rec) { log.error(`job ${verb}: no readable job for topic '${topic}' (looked at ${J.jobPath(topic)})`); return null; }
  return rec;
}
/** The byte offset of the hub's outbox this origin has already consumed (0 when unrecorded). */
function readCursor(topic: string): number {
  return Number(readIfExists(J.jobCursorPath(topic)).trim()) || 0;
}
function hubState(rec: J.JobRecord): string {
  const m = /"state"\s*:\s*"([^"]*)"/.exec(readIfExists(statusPath(rec.hub.agent, rec.hub.model, rec.topic)));
  return m ? m[1] : "unknown";
}
/** Every pane under this topic that ap can PROVE is its own right now, WITH the nonce that proved
 *  it. Collected before teardown, because teardown archives the pane.json files this reads — and the
 *  nonce is kept rather than discarded because the id alone is not evidence: the kill re-checks it
 *  against a live snapshot taken at kill time. */
async function ownedPanes(topic: string): Promise<Map<string, string>> {
  const td = topicDir(topic);
  const out = new Map<string, string>();
  if (!existsSync(td)) return out;
  const live = await livePaneNonces();
  for (const e of readdirSync(td, { withFileTypes: true })) {
    if (!e.isDirectory() || isArtifactDir(e.name)) continue;
    const m = paneMetaReadForDir(join(td, e.name));
    if (m.paneId && ownsPane(live, m.paneId, m.nonce)) out.set(m.paneId, m.nonce);
  }
  return out;
}
/** Worker-authored text is percent-encoded before it reaches stdout. The hub's outbox is written by
 *  a model; a newline in a `message` would otherwise forge extra KV lines in this very report, which
 *  is the same trick a forged @ap_nonce plays on the pane snapshot. */
const enc = (s: unknown): string => percentEncode(typeof s === "string" ? s : "");

function jobProgressNow(rec: J.JobRecord) {
  const outbox = readIfExists(outboxPath(rec.hub.agent, rec.hub.model, rec.topic));
  const events = J.parseOutbox(outbox);
  const { last, parked } = J.jobProgress(events);
  // A question the origin already answered must stop reporting as parked: job.md tells it to relay
  // whenever PARKED=yes, so a question left standing after its answer is a duplicate-relay loop that
  // writes the hub's inbox again. The relay's cursor is the byte size of the snapshot it answered,
  // so a cursor at or past the outbox's current size means this question is inside what it consumed.
  const stillParked = parked && !J.questionConsumed(Buffer.byteLength(outbox, "utf8"), readCursor(rec.topic)) ? parked : null;
  return { events, last, parked: stillParked };
}

// ---------- the isolated worktree a detached run works in ----------

/** Undo `core.quotePath` (on by default): git wraps a path holding non-ASCII, a quote, a backslash
 *  or a control character in double quotes and C-escapes its BYTES. Printed raw, an operator with a
 *  `desig\303\251n.md` in their tree is shown a name that matches nothing they can type. Octal
 *  escapes are decoded as bytes and only then read back as UTF-8, because one character is several
 *  escapes. A string that is not quoted is returned untouched. */
function unquotePorcelainPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c !== "\\") { for (const b of Buffer.from(c, "utf8")) bytes.push(b); continue; }
    const n = body.charAt(++i);
    if (n >= "0" && n <= "7") { bytes.push(parseInt(body.slice(i, i + 3), 8) & 0xff); i += 2; continue; }
    bytes.push(simple[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The paths in a `git status --porcelain` (v1) listing. Each entry is `XY <path>`, and a rename or
 *  copy is `XY <from> -> <to>` — the DESTINATION is the name that matters, since that is what the
 *  operator now has on disk. Parsed rather than echoed for the same reason `COMMITS` is: an echoed
 *  listing shows ` M docs/spec.md` and `"d\303\251sign.md"` at somebody who has to act on it. */
function dirtyPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let entry = line.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      const arrow = entry.indexOf(" -> ");
      if (arrow >= 0) entry = entry.slice(arrow + 4);
    }
    const p = unquotePorcelainPath(entry);
    if (p) out.push(p);
  }
  return out;
}


/** Create the worktree the WORKER will run in, and return what the record must carry.
 *
 *  Detached runs used to check `feat/<cmd>-<topic>` out in the MAIN checkout, which froze the origin
 *  session out of its own repo for the run's duration: an edit would have landed inside the worker's
 *  diff, and a `git checkout main` would have yanked the branch from under it. Branch checkout and
 *  the index are global to a checkout, so the detached promise never held for the repo itself.
 *
 *  The fork point is COMMITTED HEAD — the operator's uncommitted WIP deliberately stays behind, and
 *  a dirty tree only warns. The worktree is born ON a local base branch `base/<topic>` cut at that
 *  fork point, not detached: `implement branch` (and quick's) refuses a pre-snapshot with a detached
 *  HEAD, which has no restorable start branch, and the obvious remedy — check the main checkout's
 *  branch out here — is impossible, because git refuses to check one branch out in two worktrees.
 *  Hit live on the first worktree dogfood, where the run's hub had to mint that branch by hand. The
 *  branch verbs then fork `feat/<cmd>-<topic>` from it unchanged, and `finish keep` has a real start
 *  branch to restore. The name is DERIVED, never recorded — `start_branch` in the record stays the
 *  MAIN checkout's branch at fork time — and the sweep in `sweepWorktree` deletes it again.
 *
 *  `null` means ABORT the start. Every failure here is fail-closed: a half-made worktree would send
 *  the worker into the main checkout, which is the exact thing this exists to prevent. */
export function startWorktree(root: string, topic: string, r: Runner): { worktree: string; baseSha: string } | null {
  const head = r.run("git", ["rev-parse", "HEAD"]);
  const baseSha = head.stdout.trim();
  if (head.code !== 0 || !baseSha) {
    log.error(`job start: could not read HEAD in ${root} — a detached run forks the committed HEAD into its own worktree, so an unborn branch or a non-repo has nothing to fork. Commit something first, or pass --no-worktree to work in the checkout itself.`);
    return null;
  }
  const worktree = J.worktreePathFor(root, topic);
  if (existsSync(worktree)) {
    log.error(`job start: ${worktree} already exists — an earlier run's worktree was KEPT because it had uncommitted work in it (see 'ap job stop'). Archive or commit what is in it, then: git -C ${root} worktree remove ${worktree}  (add --force to discard), and start again.`);
    return null;
  }
  // Same fail-closed posture as the worktree above: a leftover base branch is an interrupted stop,
  // and reusing it would silently hand this run someone else's fork point (or fail the add anyway).
  const baseBranch = `base/${topic}`;
  if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${baseBranch}`]).code === 0) {
    log.error(`job start: branch ${baseBranch} already exists — an earlier run's worktree base branch outlived its worktree (an interrupted 'ap job stop'). Check what is on it, then clear it by hand: git -C ${root} branch -D ${baseBranch}  (and 'git -C ${root} worktree remove ${worktree}' first if that worktree is still registered), and start again.`);
    return null;
  }
  mkdirSync(dirname(worktree), { recursive: true });
  // `.ap/` is the state root and stateEnsure() gitignores it — but AP_HOME can point the state
  // elsewhere, and then nothing has ever written this file. An un-ignored worktree shows up as
  // untracked content in the checkout it forked from, which is one WIP-snapshot commit away from
  // being committed into somebody's branch.
  const gi = join(root, ".ap", ".gitignore");
  if (!existsSync(gi)) { try { writeFileSync(gi, "*\n"); } catch { /* best effort */ } }
  const add = r.run("git", ["worktree", "add", "-b", baseBranch, worktree, baseSha]);
  if (add.code !== 0) {
    log.error(`job start: 'git worktree add -b ${baseBranch} ${worktree} ${baseSha.slice(0, 8)}' failed (rc ${add.code}) — nothing was launched. Check 'git -C ${root} worktree list' for a stale entry ('git worktree prune' clears those), or pass --no-worktree.`);
    return null;
  }
  // node_modules is the one dependency tree worth carrying: a hardlink clone is seconds and costs no
  // disk, and without it the worker's first act is a multi-minute install. Any other ecosystem is
  // the worker's own problem (D3), and a failure here is never fatal — the worker can still install.
  const deps = join(root, "node_modules");
  if (existsSync(deps)) {
    const dest = join(worktree, "node_modules");
    // First success wins, cheapest first. `cp -al` is GNU's hardlink clone and stays the ONLY call
    // made on Linux; BSD cp (stock macOS) has no -l at all, so it falls through to `-c` (APFS
    // clonefile: copy-on-write, as cheap as the hardlink) and then to a plain recursive copy. A
    // failed attempt can leave a partial tree behind, which would make the next one copy INTO it.
    const modes: Array<[string, string]> = [["-al", "hardlink-cloned"], ["-cR", "clone-copied"], ["-R", "copied"]];
    let mode = "";
    for (const [flag, label] of modes) {
      if (r.run("cp", [flag, deps, dest]).code === 0) { mode = label; break; }
      rmSync(dest, { recursive: true, force: true });
    }
    if (mode) log.ok(`job start: ${mode} node_modules into the worktree`);
    else log.warn(`job start: could not clone node_modules into ${worktree} (cp -al, -cR and -R all failed) — the worker will have to install dependencies itself`);
  }
  const porcelain = r.run("git", ["status", "--porcelain"]).stdout;
  if (classifyDirty(porcelain)) {
    // WHICH files, not just "the tree is dirty". Twice now the invisible file was the design doc the
    // run was launched to implement, and a warning that does not name it is a warning the operator
    // reads as routine WIP noise.
    const paths = dirtyPaths(porcelain);
    const shown = paths.slice(0, 10);
    const more = paths.length - shown.length;
    log.warn(`job start: ${root} has UNCOMMITTED changes and they are NOT in the worktree — it forks committed HEAD (${baseSha.slice(0, 8)}). Nothing of yours was touched or stashed; the run simply will not see that work.`);
    for (const p of shown) log.warn(`  not in the worktree: ${p}`);
    if (more > 0) log.warn(`  +${more} more`);
    log.warn(`  If the run must READ any of those — a design doc especially — stop now: 'ap job stop ${topic}', commit them, and start again.`);
  }
  log.ok(`job start: worktree ${worktree} on ${baseBranch} at ${baseSha.slice(0, 8)}`);
  return { worktree, baseSha };
}

/** Delete the `base/<topic>` branch `startWorktree` cut for a worktree that is now GONE — but only
 *  while it still points at the fork base. A moved branch is somebody's commits: the worker (or the
 *  operator) committed on the base branch instead of `feat/<cmd>-<topic>`, and deleting it would be
 *  the one unrecoverable act in the sweep, so it is kept and named. `-D`, not `-d`: the base sha is
 *  an ancestor of the run's branch, not necessarily of whatever the checkout's HEAD is now. */
function sweepBaseBranch(rec: J.JobRecord, root: string, r: Runner): void {
  const branch = `base/${rec.topic}`;
  if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code !== 0) return;
  const at = r.run("git", ["rev-parse", branch]).stdout.trim();
  if (!rec.base_sha || at !== rec.base_sha) {
    log.warn(`job stop: the branch ${branch} has MOVED off the fork base and is being KEPT — something was committed on the run's base branch rather than on ${branchNameFor(rec.command, rec.topic)}. Inspect: git -C ${root} log ${branch}`);
    return;
  }
  const del = r.run("git", ["branch", "-D", branch]);
  if (del.code !== 0) log.warn(`job stop: could not delete the run's base branch ${branch} (rc ${del.code}) — remove it by hand: git -C ${root} branch -D ${branch}`);
  else log.ok(`job stop: deleted the run's base branch ${branch}`);
}

/** Remove the run's worktree, or say why it is being kept. `true` means the sweep is COMPLETE (the
 *  worktree is gone, or there was never one to remove); `false` keeps the job record, exactly as an
 *  unswept session does — a worktree still on disk is either unarchived work or something ap could
 *  not account for, and both need the operator's eyes before the record that names them is deleted.
 *
 *  The run's `feat/<cmd>-<topic>` branch always survives either way: worktrees share the repo's ref
 *  store. The `base/<topic>` branch the worktree was born on goes with the worktree (see
 *  `sweepBaseBranch`); a KEPT worktree still has it checked out, so it is left alone and unmentioned. */
export function sweepWorktree(rec: J.JobRecord, root: string, r: Runner): boolean {
  const wt = rec.worktree ?? "";
  if (!wt) return true;                                   // --no-worktree, or a pre-0.5.36 record
  // Provenance before removal, the same rule pane ownership follows: ap deletes only what it can
  // prove it created. A record naming any other path is a defect to surface, never a path to rm.
  if (!J.worktreeProvenanced(wt, root)) {
    log.warn(`job stop: the record names a worktree OUTSIDE ${join(root, ".ap", "worktrees")} (${wt}) — ap will not remove a path it cannot prove it created. Deal with it by hand.`);
    return false;
  }
  if (!existsSync(wt)) { r.run("git", ["worktree", "prune"]); sweepBaseBranch(rec, root, r); return true; }
  // The dirty probe runs INSIDE the worktree, not at the root: they are separate working trees over
  // one ref store, and the root's cleanliness says nothing about what the worker left behind.
  if (classifyDirty(runnerAt(wt).run("git", ["status", "--porcelain"]).stdout)) {
    log.warn(`job stop: the worktree ${wt} has UNCOMMITTED work in it and is being KEPT — a crashed worker's unarchived changes look exactly like this. Inspect: git -C ${wt} status`);
    log.warn(`  then either commit them on ${branchNameFor(rec.command, rec.topic)}, or discard: git -C ${root} worktree remove --force ${wt}`);
    return false;
  }
  const rm = r.run("git", ["worktree", "remove", wt]);
  if (rm.code !== 0 || existsSync(wt)) {
    log.warn(`job stop: 'git worktree remove ${wt}' did not complete (rc ${rm.code}) — the worktree is still there. Inspect it, then remove it by hand: git -C ${root} worktree remove --force ${wt}`);
    return false;
  }
  r.run("git", ["worktree", "prune"]);
  log.ok(`job stop: removed the run's worktree ${wt}`);
  sweepBaseBranch(rec, root, r);
  return true;
}

/** How far the run's STARTING branch has moved past the fork base — `null` when that cannot be
 *  answered, which `job stop` and `job status` both render as `?`.
 *
 *  It degrades independently of the branch NAME, as `commands/job.md` documents: the name is known
 *  from the record alone, so a count that fails (branch deleted, unreadable ref, git noise on
 *  stdout) must not also erase the name the operator needs. The count is parsed rather than echoed —
 *  the same discipline `COMMITS` gets — so callers print a number or `?`, never git's words.
 *
 *  The ref read is LOCAL (`refs/heads/<start_branch>`): ap makes no network git calls anywhere, so
 *  this counts what this checkout has fetched, not what the remote holds. Every caller must SAY so;
 *  an unlabelled `0` on a branch whose merges only exist on the forge reads as "not stale". */
export function driftFor(rec: J.JobRecord, r: Runner): number | null {
  if (!rec.base_sha || !rec.start_branch) return null;
  const drift = r.run("git", ["rev-list", "--count", `${rec.base_sha}..refs/heads/${rec.start_branch}`]);
  const text = drift.stdout.trim();
  const count = text === "" ? NaN : Number(text);
  return drift.code === 0 && Number.isFinite(count) ? count : null;
}

/** The push+PR commands for a run that produced commits, plus how far its start branch moved since
 *  the fork. Printed rather than executed: every detached run ends `keep`, so the operator decides,
 *  and drift is the number that decides FOR them — the hub cross-verified against the fork base, so
 *  the further that branch has moved, the less that verification says about a merge today. A PR
 *  re-tests against the updated starting branch; a local merge does not, which is why only the PR
 *  commands are offered. */
export function finishHint(rec: J.JobRecord, r: Runner): void {
  if (!rec.base_sha) return;
  const branch = branchNameFor(rec.command, rec.topic);
  if (r.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code !== 0) return;
  const count = r.run("git", ["rev-list", "--count", `${rec.base_sha}..${branch}`]);
  const commits = Number(count.stdout.trim());
  if (count.code !== 0 || !Number.isFinite(commits) || commits <= 0) return;
  const drift = driftFor(rec, r);
  process.stdout.write(
    `FINISH=pending\nBRANCH=${branch}\nCOMMITS=${commits}\n` +
    `START_BRANCH=${rec.start_branch || "?"}\n` +
    `DRIFT=${drift === null ? "?" : drift}\n` +
    `git push -u origin ${branch}\n` +
    `gh pr create --head ${branch}\n`);
}

// ---------- start ----------

/** REFUSE the launch when the design doc the run exists to implement is uncommitted, and therefore
 *  invisible to the worktree that forks committed HEAD (issue #160). `startWorktree` already warns
 *  about a dirty tree and names the files, but it warns AFTER the worktree, the base branch and the
 *  ~30s hub bootstrap are already paid for, and the operator's only remedy is `job stop`, commit,
 *  relaunch. The one input without which the run is guaranteed to fail is mechanically detectable
 *  before a single resource is created, so it is checked here instead — a refusal, not a warning.
 *
 *  Only the doc POSITIONAL is fatal enough to refuse over: every other dirty file is WIP the run may
 *  legitimately be forking away from, and those keep the warning. `--allow-invisible-doc` is the
 *  escape hatch for an operator who means it (a doc the worker will write itself, say), and the
 *  generic warning still names the file on that path. `quick` is deliberately not gated: its task
 *  is inline text in the args file, not a path the run must read.
 *
 *  Returns 2 to refuse, or 0 to proceed. */
function refuseInvisibleDoc(argsText: string, root: string, origCwd: string, r: Runner): number {
  const doc = J.docFromImplementArgs(argsText);
  if (!doc) return 0;   // no doc positional; `implement init` owns whatever that turns out to be
  // Resolved exactly as `--args-file` is: against the ORIGIN's cwd, because that is where the
  // operator typed it. `git status --porcelain` reports repo-relative paths, so the comparison has
  // to happen in that frame — an absolute doc from another repo simply will not match, which is the
  // right answer (this gate is not the missing-file check; `implement init` is).
  const abs = isAbsolute(doc) ? doc : resolve(origCwd, doc);
  const rel = relative(root, abs);
  // A wholly-untracked DIRECTORY is reported collapsed, as `?? docs/` — git stops descending once it
  // knows the directory is untracked, so the doc inside it is never named. That is exactly the case
  // this gate exists for (a brand-new specs directory), so a trailing-slash entry is matched as the
  // prefix it is. `-uall` would expand it instead, at the cost of walking every untracked tree in
  // the repo on every launch.
  const covers = (p: string): boolean => p === rel || (p.endsWith("/") && rel.startsWith(p));
  if (!dirtyPaths(r.run("git", ["status", "--porcelain"]).stdout).some(covers)) return 0;
  log.error(`job start: the design doc ${rel} exists only as uncommitted work in ${root} — the run's worktree forks committed HEAD and cannot see it. Commit it and start again, or pass --allow-invisible-doc to launch anyway.`);
  return 2;
}

async function startRun(rest: string[], origCwd: string): Promise<number> {
  let command = "", argsFile = "", topic = "", provider = "", hubModel = "claude";
  let budgetHours = 6, maxRounds = 5, useWorktree = true, allowInvisibleDoc = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const take = (): string => { const r = kvParse(a, rest[i + 1]); i += r.shift - 1; return r.value; };
    if (a === "--no-worktree") useWorktree = false;
    else if (a === "--allow-invisible-doc") allowInvisibleDoc = true;
    else if (a === "--command" || a.startsWith("--command=")) command = take();
    else if (a === "--args-file" || a.startsWith("--args-file=")) argsFile = take();
    else if (a === "--topic" || a.startsWith("--topic=")) topic = take();
    else if (a === "--provider" || a.startsWith("--provider=")) provider = take();
    else if (a === "--hub-model" || a.startsWith("--hub-model=")) hubModel = take();
    else if (a === "--budget-hours" || a.startsWith("--budget-hours=")) budgetHours = Number(take());
    else if (a === "--max-rounds" || a.startsWith("--max-rounds=")) maxRounds = Number(take());
    else { log.error(`job start: unknown argument '${a}'`); return 2; }
  }

  if (!J.isJobCommand(command)) { log.error(`job start: --command must be one of ${J.JOB_COMMANDS.join("|")}; got: '${command}'`); return 2; }
  // The operator typed this path from wherever they stood, but run() has already moved this process
  // to the repo root and the job hub reads the record from there — so it is resolved against the
  // ORIGIN's cwd and recorded absolute. A relative path left as typed would exist for the caller and
  // be missing for the hub.
  if (argsFile) argsFile = isAbsolute(argsFile) ? argsFile : resolve(origCwd, argsFile);
  if (!argsFile || !existsSync(argsFile)) { log.error(`job start: --args-file must be an existing path; got: '${argsFile}'`); return 2; }
  if (!Number.isFinite(budgetHours) || budgetHours <= 0) { log.error(`job start: --budget-hours must be a positive number; got: '${budgetHours}'`); return 2; }
  if (!Number.isInteger(maxRounds) || maxRounds <= 0) { log.error(`job start: --max-rounds must be a positive integer; got: '${maxRounds}'`); return 2; }

  const argsText = readIfExists(argsFile).trim();
  if (!topic) {
    topic = command === "implement"
      ? J.topicFromImplementArgs(argsText)
      : deriveSlug(J.stripFlags(argsText, new Set(["--provider"])));
  }
  if (!topic || !validateSlug(topic)) {
    log.error(`job start: could not derive a valid topic from ${argsFile} (got: '${topic}'); pass --topic <slug>`);
    return 2;
  }
  const session = `ap-${topic}`;
  if (!validSessionName(session)) { log.error(`job start: '${session}' is not a usable tmux session name; pick a shorter --topic`); return 2; }
  if (existsSync(J.jobPath(topic))) {
    log.error(`job start: topic '${topic}' already has a job in flight (${J.jobPath(topic)}); run 'ap job stop ${topic}' first`);
    return 2;
  }
  const agent = pickRandomAgent(topic);
  if (!agent) { log.error(`job start: no free agent in the pool for topic '${topic}'`); return 1; }

  // BEFORE the record is written, so an abort here leaves nothing half-launched to clean up. The
  // hub and every `.ap` path stay keyed to the repo ROOT — moving them into the worktree would
  // re-open the namespace split 0.5.34 closed. Only the WORKER's target moves.
  const root = repoRoot();
  const r = runnerAt(root);
  if (command === "implement" && useWorktree && !allowInvisibleDoc) {
    const rc = refuseInvisibleDoc(argsText, root, origCwd, r);
    if (rc) return rc;
  }
  const startBranch = currentBranch(r);
  // The return address for the hub's completion hint, captured here because this is the only moment
  // the ORIGIN's own session is observable: the hub runs in a detached session of ap's making and
  // could never name the one it was launched from. "" outside tmux, and "" is a legal record.
  const originSession = await currentSessionName();
  const wt = useWorktree ? startWorktree(root, topic, r) : null;
  if (useWorktree && !wt) return 1;

  const rec: J.JobRecord = {
    command, topic, session,
    hub: { agent, model: hubModel },
    // Literal, never an option: a detached run has exactly one legal ending — it stops on its
    // branch and the OPERATOR finishes it. The `pr` opt-in was removed 2026-08-18 having never run
    // live, so `--finish` now falls into the unknown-argument refusal above.
    provider, finish: "keep", budget_hours: budgetHours, max_rounds: maxRounds,
    args_file: argsFile, started: isoUtc(),
    worktree: wt?.worktree ?? "", base_sha: wt?.baseSha ?? "", start_branch: startBranch,
    origin_session: originSession,
  };
  mkdirSync(jobDir(topic), { recursive: true });
  // The record is written BEFORE the spawn on purpose: a spawn that dies half-way leaves evidence
  // the operator (and `job stop`) can act on, rather than an unrecorded pane in a session nobody
  // knows the name of.
  atomicWrite(J.jobPath(topic), J.formatJob(rec));

  const rc = await spawnRun([agent, hubModel, topic, "--session", session, "--role", "job-hub", "--cwd", root, J.jobBrief(rec)]);
  if (rc !== 0) {
    log.error(`job start: the job hub failed to spawn (rc ${rc}); the record is left at ${J.jobPath(topic)} — clear it with 'ap job stop ${topic}'${wt ? ` (which also removes the worktree ${wt.worktree})` : ""}`);
    return rc;
  }
  process.stdout.write(
    `TOPIC=${topic}\nSESSION=${session}\nHUB=${agent}-${hubModel}\nJOB=${J.jobPath(topic)}\n` +
    `WORKTREE=${wt ? wt.worktree : "(none — --no-worktree)"}\nBASE=${wt ? wt.baseSha : ""}\n` +
    `ATTACH=tmux attach -t ${session}\n`);
  return 0;
}

// ---------- worker liveness ----------

/** Every worker under the job's topic, classified against one pane snapshot — the hub excluded by
 *  name, because its own liveness is already reported as `LIVENESS=` by `classifyJobLiveness` and
 *  two layers describing the same pane in two vocabularies is how they start disagreeing. Persists,
 *  because both callers here are the run's own scheduled rescans. */
function workerRows(rec: J.JobRecord, snapshot: Map<string, string>, now: number) {
  return scanTopicWorkers(rec.topic, snapshot, now, { exclude: `${rec.hub.agent}-${rec.hub.model}`, persist: true });
}

/** The probe `job wait` hands to the wait's per-poll hook. `job wait` blocks on the HUB's outbox for
 *  up to an hour at a time; a worker that dies under it writes nothing there and its pane is not the
 *  one the wait probes, so without this the death is invisible until the whole budget expires. The
 *  returned event is IN-PROCESS ONLY — it is never appended to any outbox. */
function workerDeathProbe(rec: J.JobRecord, deps: WaitDeps): () => Promise<OutboxEvent | null> {
  return async () => {
    const dead = workerRows(rec, await deps.snapshot(), deps.now()).find((w) => w.dead);
    return dead ? { event: J.WORKER_DEAD_EVENT, worker: dead.worker, verdict: dead.verdict, ts: isoUtc() } : null;
  };
}

// ---------- status ----------

async function statusRun(rest: string[]): Promise<number> {
  const rec = requireJob(rest[0], "status");
  if (!rec) return 1;
  const live = await livePaneNonces();
  const liveness = J.classifyJobLiveness(live, paneMetaRead(rec.hub.agent, rec.hub.model, rec.topic));
  const { events, last, parked: stillParked } = jobProgressNow(rec);
  const now = Date.now();
  const el = J.elapsedHours(rec.started, now);

  process.stdout.write(
    `COMMAND=${rec.command}\nTOPIC=${rec.topic}\nSESSION=${rec.session}\n` +
    `HUB=${rec.hub.agent}-${rec.hub.model}\nLIVENESS=${liveness}\nHUB_STATE=${hubState(rec)}\n` +
    `STARTED=${rec.started}\nELAPSED_H=${el === null ? "?" : el.toFixed(2)}\nBUDGET_H=${rec.budget_hours}\n` +
    `BUDGET=${J.budgetExceeded(rec.started, rec.budget_hours, now) ? "exceeded" : "within"}\n` +
    `FINISH=${rec.finish}\nEVENTS=${events.length}\nLAST_EVENT=${last ? last.event : "none"}\n` +
    `PARKED=${stillParked ? "yes" : "no"}\n`);
  // The worktree facts, DURING the run rather than at teardown. `finishHint` has carried DRIFT since
  // 0.5.38, but only from `job stop` — after the operator's merge decision was already made. One
  // dogfood branch sat through three merges of its starting branch and landed a conflict nobody
  // could have seen coming from anything ap printed. Emitted only for a worktree run: a
  // `--no-worktree` record has no fork base to measure against, and its stdout stays byte-identical.
  //
  // The caveat is not decoration. ap issues ZERO network git calls, so this counts commits on the
  // LOCAL `refs/heads/<start_branch>`. In the exact scenario that motivated the field — PRs
  // squash-merged on the forge, local `main` never pulled — a bare `DRIFT=0` would read as "not
  // stale" and be worse than printing nothing.
  if (rec.worktree) {
    const drift = driftFor(rec, runnerAt(process.cwd()));
    process.stdout.write(
      `WORKTREE=${rec.worktree}\n` +
      `START_BRANCH=${rec.start_branch || "?"}\n` +
      `DRIFT=${drift === null ? "?" : drift} (local ref; ap never fetches)\n`);
  }
  if (stillParked) process.stdout.write(`PARKED_MESSAGE=${enc(stillParked.message ?? stillParked.note ?? "")}\n`);
  if (liveness === "dead") {
    process.stdout.write(`NOTE=${enc(`the job hub's pane is gone. Its workers, if any, are now unsupervised: 'ap list ${rec.topic}' shows them, 'ap job stop ${rec.topic}' tears the whole job down. Nothing is auto-respawned — a second hub waking onto a live worker corrupts the run.`)}\n`);
  }
  // The hub being `alive` and `working` was never the whole answer: issue #157's run read
  // LIVENESS=alive HUB_STATE=working for ten hours with a worker that had never bootstrapped. One
  // line per worker dir, from the records the platform already holds — and the same scan advances
  // the miss counter `job wait`'s mid-wait poll reads, so a status run is a rescan, not a peek.
  for (const w of workerRows(rec, live, now)) process.stdout.write(`WORKER=${w.worker} ${w.verdict}\n`);
  const tail = events.slice(-10);
  if (tail.length) {
    process.stdout.write("--- recent events ---\n");
    for (const e of tail) process.stdout.write(`${e.ts ?? "?"}\t${e.event}\t${enc(e.summary ?? e.note ?? e.message ?? "")}\n`);
  }
  return 0;
}

// ---------- wait / relay / attach ----------

/** The ONE verb a watcher loop reads mechanically, so it answers with exactly one `JS=` line on
 *  every path it reaches — including the paths where there is no job to wait on. A watcher that
 *  cannot execute at all prints nothing, and the canonical loop turns that silence into
 *  `JS=unreachable`; anything ap itself decides must therefore SAY so, or "the run finished" and
 *  "I could not run" stay indistinguishable (the xjp stuck-wait: 22 minutes of a dead poll loop
 *  past the hub's `done`). `requireJob` is deliberately not used: its refusal is stderr-only.
 *
 *  `deps` is injected for one reason: the mid-wait worker rescan is a fake-clock behavior (a worker
 *  alive at call time and gone 45s later), and there is no way to script a tmux snapshot and a
 *  clock through the CLI. The default binds the real pane snapshot and the real clock, so `run()`
 *  is unchanged. */
export interface WaitDeps { snapshot: () => Promise<Map<string, string>>; now: () => number; clock?: Clock }
const realWaitDeps = (): WaitDeps => ({ snapshot: livePaneNonces, now: Date.now });

export async function waitRun(rest: string[], deps: WaitDeps = realWaitDeps()): Promise<number> {
  const topic = rest[0];
  // A mistyped topic reads as TORN, never as standdown: rc 1 and a loud line, because the one thing
  // a typo must not do is look like a finished run and retire the watch.
  if (!topic || !validateSlug(topic)) {
    log.error(`job wait: topic must match [a-z0-9-]+ and be <= 32 chars; got: '${topic}'`);
    process.stdout.write("JS=torn\n");
    return 1;
  }
  // Absent record = the run is over from a watcher's point of view (`job stop` clears it), which is
  // the stand-down the old loop inferred from a second `job mode` call and exited silently on.
  if (!existsSync(J.jobPath(topic))) {
    process.stdout.write("JS=standdown\n");
    return 0;
  }
  // Present but unreadable is the fail-closed side, same doctrine as the 0.5.31 status gate: a torn
  // or half-written record is an operator problem, and a quiet exit would bury it.
  const rec = readJob(topic);
  if (!rec) {
    log.error(`job wait: the record at ${J.jobPath(topic)} exists but cannot be parsed — inspect it, or clear it with 'ap job stop ${topic}'`);
    process.stdout.write("JS=torn\n");
    return 1;
  }
  const budget = envNum("AP_JOB_WAIT_TIMEOUT_S", 3600);
  // The worker rescan runs INSIDE the wait, at the pane probe's own cadence — not once before it.
  // A check before the wait would have been true of #157's very first poll and useless for the
  // next ten hours; the detection bound has to be the cadence, never the 3600s budget.
  const ev = await liveOutboxWait(
    rec.hub.agent, rec.hub.model, rec.topic, readCursor(rec.topic), ["done", "error", "question"], budget,
    deps.clock, workerDeathProbe(rec, deps),
  );
  if (!ev) { process.stdout.write("JS=timeout\n"); return 1; }
  // Still exactly ONE JS= line: the worker's identity and verdict ride the same line, because a
  // second line would be a second `JS=`-shaped token for the loop to mis-branch on.
  if (ev.event === J.WORKER_DEAD_EVENT) {
    process.stdout.write(`JS=worker-dead WORKER=${String(ev.worker ?? "?")} VERDICT=${String(ev.verdict ?? "?")}\n`);
    return 0;
  }
  process.stdout.write(`JS=${ev.event}\n`);
  if (ev.event === "question") process.stdout.write(`QUESTION=${enc(ev.message ?? "")}\n`);
  return 0;
}

async function relayRun(rest: string[]): Promise<number> {
  const rec = requireJob(rest[0], "relay");
  if (!rec) return 1;
  const msg = rest.slice(1).join(" ").trim();
  if (!msg) { log.error("job relay: a message (or @file) is required"); return 2; }
  // ONE read of the outbox settles both halves: whether there is anything to answer, and the offset
  // this relay may consume up to. The parked check is the ONLY gate here — `send` checks pane
  // ownership and nothing else (the busy gate lives in other callers, never in send.ts), so without
  // it a relay onto a working hub overwrites the inbox task it is mid-way through, and a relay onto
  // a finished one writes a task nobody will ever read.
  const { last, parked, cursor } = J.relaySnapshot(readIfExists(outboxPath(rec.hub.agent, rec.hub.model, rec.topic)));
  if (!parked) {
    log.error(`job relay: nothing is parked (last event: ${last ? last.event : "none"}) — refusing to write the job hub's inbox; a write now would clobber its running or finished task`);
    return 1;
  }
  const rc = await sendRun(["--from", "hub", rec.hub.agent, rec.topic, msg]);
  if (rc !== 0) return rc;
  // The SNAPSHOT's offset, never a re-stat after the send: the snapshot ends at the question, so an
  // event the hub appended while the send was in flight stays beyond the cursor and the next
  // `job wait` still sees it. Re-stating here lost a `done` that landed mid-send.
  atomicWrite(J.jobCursorPath(rec.topic), String(cursor) + "\n");
  log.ok(`job relay: answer delivered to ${rec.hub.agent} on ${rec.topic}`);
  return 0;
}

function attachRun(rest: string[]): number {
  const rec = requireJob(rest[0], "attach");
  if (!rec) return 1;
  const { parked } = jobProgressNow(rec);
  process.stdout.write(
    `TOPIC=${rec.topic}\nSESSION=${rec.session}\nHUB=${rec.hub.agent}-${rec.hub.model}\n` +
    `WATCH=tmux attach -t ${rec.session}\nSTATUS=ap job status ${rec.topic}\nWAIT=ap job wait ${rec.topic}\n` +
    `OUTBOX=${outboxPath(rec.hub.agent, rec.hub.model, rec.topic)}\nPARKED=${parked ? "yes" : "no"}\n`);
  if (parked) process.stdout.write(`PARKED_MESSAGE=${enc(parked.message ?? parked.note ?? "")}\n`);
  return 0;
}

// ---------- list ----------

function listRun(): number {
  const repo = repoStateDir();
  const W = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(`${W("TOPIC", 24)} ${W("COMMAND", 10)} ${W("HUB", 20)} ${W("SESSION", 24)} STARTED\n`);
  process.stdout.write(`${"-".repeat(24)} ${"-".repeat(10)} ${"-".repeat(20)} ${"-".repeat(24)} -------\n`);
  if (!existsSync(repo)) return 0;
  for (const t of readdirSync(repo, { withFileTypes: true })) {
    if (!t.isDirectory()) continue;
    const rec = readJob(t.name);
    if (!rec) continue;
    process.stdout.write(`${W(rec.topic, 24)} ${W(rec.command, 10)} ${W(`${rec.hub.agent}-${rec.hub.model}`, 20)} ${W(rec.session, 24)} ${rec.started}\n`);
  }
  return 0;
}

// ---------- stop ----------

async function stopJobRun(rest: string[]): Promise<number> {
  const rec = requireJob(rest[0], "stop");
  if (!rec) return 1;
  // Snapshot ownership BEFORE teardown: teardown archives the pane.json files this evidence lives in.
  // Persist it too, merged over whatever an earlier incomplete stop recorded — without that file a
  // re-run has no pane.json left to read, so it could never prove the session was ours and could
  // never finish the sweep.
  const evidence = J.mergePaneEvidence(readPaneEvidence(rec.topic), await ownedPanes(rec.topic));
  atomicWrite(J.panesEvidencePath(rec.topic), JSON.stringify(evidence) + "\n");
  const recorded = new Map(Object.entries(evidence));
  // The UNGATED teardown, deliberately: `stop <topic>` itself now REFUSES while this record exists
  // (it would kill the job hub mid-run), and this verb is the caller that has already accounted for
  // the hub — the pane evidence above, the session sweep below.
  await teardownTopic(rec.topic);
  if (await sessionExists(rec.session)) {
    const panes = await sessionPaneIds(rec.session);
    // The ownership check is re-run against a snapshot taken NOW, not against the ids collected
    // before teardown: a pane id is never proof by itself, and a %N the server recycled in between
    // carries no @ap_nonce and fails closed.
    const live = await livePaneNonces();
    if (!J.sessionKillable(panes, recorded, live)) {
      const strangers = panes.filter((p) => !ownsPane(live, p, recorded.get(p) ?? ""));
      log.warn(`job stop: session ${rec.session} left intact — ${strangers.length ? `it still holds ${strangers.join(", ")}, which ap cannot prove are its own` : "ap could not enumerate its panes"}. Inspect with: tmux list-panes -s -t =${rec.session}`);
      return keepRecord(rec, "the session was not swept");
    }
    // The kill's own verdict decides, and it is verified: reporting a teardown ap cannot prove and
    // then deleting the record would leave the next `job start <topic>` free to adopt (by name) a
    // session that still holds panes — including strangers'.
    const killed = await killSession(rec.session);
    if (!killed || await sessionExists(rec.session)) {
      log.warn(`job stop: kill-session ${rec.session} did not complete — the session is still there. Inspect with: tmux list-panes -s -t =${rec.session}`);
      return keepRecord(rec, "the session is still alive");
    }
    log.ok(`job stop: killed detached session ${rec.session}`);
  }
  // The hint comes BEFORE the sweep so it is printed on both endings: a kept-dirty worktree is
  // exactly when the operator most needs to be told where the work is and what to run on it.
  const root = repoRoot();
  const r = runnerAt(root);
  finishHint(rec, r);
  if (!sweepWorktree(rec, root, r)) return keepRecord(rec, "the worktree was not swept");
  rmSync(jobDir(rec.topic), { recursive: true, force: true });
  try { rmdirSync(topicDir(rec.topic)); } catch { /* tolerate non-empty */ }
  log.ok(`job stop: ${rec.topic} torn down`);
  return 0;
}

/** The pane evidence an earlier `job stop` persisted; {} for absent or unusable content. */
function readPaneEvidence(topic: string): Record<string, string> {
  try {
    const o = JSON.parse(readIfExists(J.panesEvidencePath(topic))) as Record<string, unknown>;
    if (!o || typeof o !== "object") return {};
    return Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch { return {}; }
}

/** An incomplete teardown KEEPS the job record and says so. The workers are already archived, so a
 *  re-run is safe and — with the pane evidence persisted next to the record — is the only thing that
 *  can still finish the kill. Deleting the record here would strand the session unguarded. */
function keepRecord(rec: J.JobRecord, why: string): number {
  log.warn(`job stop: ${why}, so the job record is KEPT (${J.jobPath(rec.topic)}). Inspect the session, then re-run 'ap job stop ${rec.topic}' to finish the sweep, or clear ${jobDir(rec.topic)} by hand.`);
  return 1;
}

// ---------- mechanical signals the directive branches on ----------

function modeRun(rest: string[]): number {
  const topic = rest[0];
  if (!topic || !validateSlug(topic)) { log.error("usage: job mode <topic>"); return 2; }
  const on = existsSync(J.jobPath(topic));
  process.stdout.write(`DETACHED=${on ? 1 : 0}\n`);
  return on ? 0 : 1;
}

function budgetCheckRun(rest: string[]): number {
  const topic = rest[0];
  if (!topic || !validateSlug(topic)) { log.error(`job budget-check: topic must match [a-z0-9-]+ and be <= 32 chars; got: '${topic}'`); return 2; }
  const rec = readJob(topic);
  // Fail CLOSED toward parking, exactly as budgetExceeded does with a record it cannot interpret:
  // the job hub branches on 0-vs-1 ("exit 1 means exhausted -> write RESUME.md, park, stop"), so an
  // unreadable record has to land on the park side. Rc 2 (usage) is kept for a malformed slug only,
  // because that is the operator's typo, not a running job's state.
  if (!rec) {
    process.stdout.write("BUDGET=unknown\n");
    log.error(`job budget-check: no readable job for topic '${topic}' (looked at ${J.jobPath(topic)}) — treating the budget as exhausted`);
    return 1;
  }
  const now = Date.now();
  const el = J.elapsedHours(rec.started, now);
  const exceeded = J.budgetExceeded(rec.started, rec.budget_hours, now);
  process.stdout.write(`BUDGET=${exceeded ? "exceeded" : "within"}\nELAPSED_H=${el === null ? "?" : el.toFixed(2)}\nBUDGET_H=${rec.budget_hours}\n`);
  return exceeded ? 1 : 0;
}
