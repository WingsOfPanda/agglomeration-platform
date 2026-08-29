// tests/state-rooting.test.ts — one run, one state tree.
//
// Every state path derives from process.cwd() (paths.ts stateRoot + repoHash), so which tree a verb
// touched used to be decided by where the hub happened to be standing. From inside a run's own
// worktree -- `<root>/.ap/worktrees/<topic>`, ap-created BY CONSTRUCTION -- that hashed the
// WORKTREE, and the run split across two trees: `turn-send` reported a missing agent.txt from one
// cwd and "outbox not found" from the other, and a worker rightly refused a nudge naming an inbox
// its identity.md did not name. #150 fixed the class for the `job` verbs; this pins it for the other
// eight families.
//
// The table below is the point: one row per verb FAMILY, so a family added later without re-rooting
// fails its own row rather than being silently exempt. Nothing here spawns a real pane — a tmux shim
// earlier on PATH answers `-V` and fails every placement, which is the same answer a tmux-less CI box
// gives once the version check has passed.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { repoHash } from "../src/core/paths.js";
import { inboxPath, identityPath } from "../src/core/ipc.js";
import { startWorktree } from "../src/commands/job.js";
import { worktreePathFor } from "../src/core/job.js";
import { runnerAt } from "../src/core/gitwork.js";
import { run as quickRun } from "../src/commands/quick.js";
import { run as implementRun } from "../src/commands/implement.js";
import { run as spawnRun } from "../src/commands/spawn.js";
import { run as sendRun } from "../src/commands/send.js";
import { run as designRun } from "../src/commands/design.js";
import { run as exploreRun } from "../src/commands/explore.js";
import { run as bridgeRun } from "../src/commands/bridge.js";
import { run as autoresearchRun } from "../src/commands/autoresearch.js";
import { run as stopRun } from "../src/commands/stop.js";
import { run as listRun } from "../src/commands/list.js";
import { run as collectRun } from "../src/commands/collect.js";
import { run as preflightRun } from "../src/commands/preflight.js";

const TOPIC = "demo";
const AGENT = "alpha";
const MODEL = "codex";
const DECOY_MODEL = "claude";   // the provider a MIS-rooted verb would report; see decoyTree

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const cleanups: Array<() => void> = [];
const ORIG_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
const PLUGIN_ROOT = process.cwd();   // captured BEFORE any chdir: identityWrite reads its template from here
beforeEach(() => { process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT; });
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (ORIG_PLUGIN_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = ORIG_PLUGIN_ROOT;
});

interface Fixture { root: string; wt: string; home: string; }

/** A throwaway repo with one commit on `main`, made the current directory, with a fresh AP_HOME, an
 *  ap-created run worktree, and a PATH where `tmux` reports 3.4 and fails every placement while the
 *  provider binaries merely exist. `git init -b` is avoided so this works on older gits. */
function fixture(): Fixture {
  const h = freshHome();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-rooting-")));
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "ap tests");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");

  const shim = join(h.home, "shim");
  mkdirSync(shim, { recursive: true });
  // `-V` answers so spawn clears its version gate; every placement (split-window/new-session/
  // respawn-pane) fails, so spawn stops right AFTER prepareWorkerState -- which is exactly the state
  // write this file is about. No real pane is ever created.
  writeFileSync(join(shim, "tmux"), '#!/bin/sh\ncase "$1" in\n  -V) echo "tmux 3.4"; exit 0 ;;\n  set-option|set|show-options|show|display-message|list-panes|kill-pane) exit 0 ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
  for (const b of ["codex", "claude"]) writeFileSync(join(shim, b), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const path0 = process.env.PATH;
  const tmux0 = process.env.TMUX;
  const cwd0 = process.cwd();
  process.env.PATH = `${shim}:${path0}`;
  process.env.TMUX = "/tmp/fake-tmux,1,0";   // inTmuxSession() is env-only; no server is ever contacted
  process.chdir(root);
  cleanups.push(() => {
    process.chdir(cwd0);
    process.env.PATH = path0;
    if (tmux0 === undefined) delete process.env.TMUX; else process.env.TMUX = tmux0;
    // The worktree registration lives in the repo we are about to delete, so nothing survives it.
    rmSync(root, { recursive: true, force: true });
    h.cleanup();
  });

  const started = startWorktree(root, TOPIC, runnerAt(root));
  if (!started) throw new Error("fixture: startWorktree failed");
  return { root, wt: worktreePathFor(root, TOPIC), home: h.home };
}

async function capture(fn: () => Promise<number>): Promise<{ rc: number; text: string }> {
  const chunks: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
  // spawn rethrows placement failures after writing its state; the rc is not the observable here.
  try { const rc = await fn(); return { rc, text: chunks.join("") }; }
  catch { return { rc: -1, text: chunks.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

/** Every repo-hash directory that exists under this AP_HOME. Sampled either side of the invocation:
 *  the DELTA is the tree the verb itself brought into existence, which is the write-side half of the
 *  invariant (a seed or a decoy planted beforehand is not evidence of anything the verb did). */
function stateTrees(home: string): string[] {
  const d = join(home, "state");
  return existsSync(d) ? readdirSync(d).sort() : [];
}
function treesCreated(home: string, before: string[]): string[] {
  return stateTrees(home).filter((t) => !before.includes(t)).sort();
}

/** The tree a MIS-rooted verb would land in, given the tree this row was seeded into: the main
 *  checkout, whenever the row is seeded somewhere else. Rows plant a DECOY there — same shape,
 *  different provider — so a verb that resolved the wrong tree reports a wrong-but-plausible answer
 *  instead of a bare "not found" that is textually identical to the right tree's "not found". Without
 *  it a mis-rooting that misses BOTH trees is indistinguishable from correct behaviour. */
function decoyTree(f: Fixture, treeCwd: string): string | null {
  return treeCwd === f.root ? null : f.root;
}

/** Seed a topic dir under a NAMED tree, bypassing cwd entirely — the orphan cases need state planted
 *  in a tree the current cwd does not resolve to. */
function seedTopicDir(home: string, cwd: string, topic: string): string {
  const d = join(home, "state", repoHash(cwd), topic);
  mkdirSync(d, { recursive: true });
  return d;
}

/** One worker dir under a NAMED tree — the shape `stop`, `list` and `collect` all read: a pane.json
 *  naming the pair and an empty outbox. NO pane id, deliberately: that is today's archive-only
 *  teardown path, so nothing here depends on a tmux server having panes. */
function seedWorker(home: string, cwd: string, model: string): string {
  const wd = join(home, "state", repoHash(cwd), TOPIC, `${AGENT}-${model}`);
  mkdirSync(wd, { recursive: true });
  writeFileSync(join(wd, "pane.json"), JSON.stringify({ agent: AGENT, model, spawned_at: "t" }) + "\n");
  writeFileSync(join(wd, "outbox.jsonl"), "");
  return wd;
}
/** Both sides of a row: the tree under test, plus the decoy the OTHER tree gets (see decoyTree). */
function seedWorkerPair(f: Fixture, treeCwd: string): void {
  for (const [cwd, model] of [[treeCwd, MODEL], [decoyTree(f, treeCwd), DECOY_MODEL]] as const) {
    if (cwd) seedWorker(f.home, cwd, model);
  }
}

interface Row {
  family: string;
  /** Plants whatever the verb reads into the tree `treeCwd` resolves to — named explicitly, because
   *  the guard case seeds a user worktree's own tree and the matrix case seeds the main one. */
  seed: (f: Fixture, treeCwd: string) => void;
  /** The IDENTICAL invocation, issued once from the root and once from the worktree. */
  invoke: () => Promise<number>;
}

/** One row per verb family. Each verb is chosen because its outcome NAMES the state path it
 *  resolved (or, for spawn, writes state before it stops), so a verb that resolved the worktree tree
 *  cannot produce the same observation as one that resolved the main tree. */
const ROWS: Row[] = [
  {
    family: "quick",
    // The field symptom itself: agent.txt found from one cwd, "outbox not found" from the other.
    seed: (f, treeCwd) => {
      for (const [cwd, model] of [[treeCwd, MODEL], [decoyTree(f, treeCwd), DECOY_MODEL]] as const) {
        if (!cwd) continue;
        const art = join(f.home, "state", repoHash(cwd), TOPIC, "_quick");
        mkdirSync(art, { recursive: true });
        writeFileSync(join(art, "agent.txt"), AGENT + "\n");
        writeFileSync(join(art, "selected-provider.txt"), model + "\n");
      }
    },
    invoke: () => quickRun(["turn-send", TOPIC, "1"]),
  },
  {
    family: "implement",
    seed: () => { /* the missing-art-dir error names the resolved path */ },
    invoke: () => implementRun(["summary", TOPIC]),
  },
  {
    family: "spawn",
    seed: () => { /* nothing: the observable is WHICH tree identity.md lands in */ },
    invoke: () => spawnRun([AGENT, MODEL, TOPIC]),
  },
  {
    family: "send",
    // With the worker dir present, send gets past resolveModel and names the worker; without it, it
    // reports "state dir absent". Two different answers from two different trees.
    seed: (f, treeCwd) => {
      for (const [cwd, model] of [[treeCwd, MODEL], [decoyTree(f, treeCwd), DECOY_MODEL]] as const) {
        if (!cwd) continue;
        const wd = join(f.home, "state", repoHash(cwd), TOPIC, `${AGENT}-${model}`);
        mkdirSync(wd, { recursive: true });
        writeFileSync(join(wd, "outbox.jsonl"), "");
      }
    },
    invoke: () => sendRun([AGENT, TOPIC, "hello"]),
  },
  {
    family: "design",
    seed: () => { /* the missing-draft-dir error names the resolved path */ },
    invoke: () => designRun(["assemble", TOPIC]),
  },
  {
    family: "explore",
    seed: () => { /* the missing-art-dir error names the resolved path */ },
    invoke: () => exploreRun(["survivors", TOPIC]),
  },
  {
    family: "bridge",
    seed: (f, treeCwd) => {
      for (const [cwd, model] of [[treeCwd, MODEL], [decoyTree(f, treeCwd), DECOY_MODEL]] as const) {
        if (!cwd) continue;
        const art = join(f.home, "state", repoHash(cwd), TOPIC, "_bridge");
        mkdirSync(art, { recursive: true });
        writeFileSync(join(art, "agent.txt"), AGENT + "\n");
        writeFileSync(join(art, "selected-provider.txt"), model + "\n");
      }
    },
    invoke: () => bridgeRun(["round-send", TOPIC, "1"]),
  },
  {
    family: "autoresearch",
    seed: () => { /* the missing-workers-dir error names the resolved path */ },
    invoke: () => autoresearchRun(["score", TOPIC]),
  },
  {
    family: "stop",
    // The field symptom (#164): `no worker '<agent>' on topic '<topic>'` from a worktree cwd while
    // the worker sat under the ROOT hash — teardown fell through, panes left alive, nothing
    // archived. With the worker present, stop NAMES the archive it wrote, and that path carries the
    // hash of whichever tree it resolved.
    seed: (f, treeCwd) => seedWorkerPair(f, treeCwd),
    invoke: () => stopRun([AGENT, TOPIC]),
  },
  {
    family: "list",
    // Either a worker row (naming the model the resolved tree recorded) or "no workers deployed"
    // naming the state dir it looked in — two different answers from two different trees.
    seed: (f, treeCwd) => seedWorkerPair(f, treeCwd),
    invoke: () => listRun([TOPIC]),
  },
  {
    family: "collect",
    // resolveModel is the fork: the resolved tree's model in "tailing outbox for ...", or the same
    // false "no worker" stop emitted. --timeout 1 so the tail path is a second, not ten minutes.
    seed: (f, treeCwd) => seedWorkerPair(f, treeCwd),
    invoke: () => collectRun([AGENT, TOPIC, "--timeout", "1"]),
  },
  {
    family: "preflight",
    // Nothing to seed: the observable is WHICH tree the default `_consult` art dir is created in
    // (the `--art-dir` override takes an absolute path and was never cwd-sensitive).
    seed: () => { /* the art-dir mkdir is the write this row is about */ },
    invoke: () => preflightRun([TOPIC, "2", "--list", `${AGENT}:${MODEL},bravo:${MODEL}`]),
  },
];

interface Observation { rc: number; text: string; trees: string[]; }

/** Run one row against a FRESH fixture, from `from`. A fresh fixture per side (rather than two runs
 *  against one) keeps the first invocation's writes from changing what the second one sees. */
async function observe(row: Row, from: "root" | "worktree"): Promise<Observation> {
  const f = fixture();
  row.seed(f, f.root);
  const rootHash = repoHash(f.root);
  const wtHash = repoHash(f.wt);
  const before = stateTrees(f.home);
  if (from === "worktree") process.chdir(f.wt);
  const cap = await capture(row.invoke);
  process.chdir(f.root);
  // Normalize what is per-fixture (tmpdirs, hashes) so the two sides are comparable as text; the
  // hash tokens are the whole point — a resolved path reads <ROOTHASH> or <WTHASH>, never both.
  const text = cap.text
    .split(rootHash).join("<ROOTHASH>")
    .split(wtHash).join("<WTHASH>")
    .split(f.home).join("<HOME>")
    .split(f.root).join("<ROOT>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>")
    .replace(/\d{8}T\d{6}Z/g, "<TS>");   // archiveTs (separator-free), as it appears in stop's archive path
  const trees = treesCreated(f.home, before).map((t) => (t === rootHash ? "<ROOTHASH>" : t === wtHash ? "<WTHASH>" : t));
  return { rc: cap.rc, text, trees };
}

describe("every verb family resolves ONE state tree from either checkout", () => {
  it.each(ROWS)("$family: invoked from inside the run's worktree resolves the ROOT tree", async (row) => {
    const fromRoot = await observe(row, "root");
    const fromWorktree = await observe(row, "worktree");
    expect(fromWorktree.rc).toBe(fromRoot.rc);
    expect(fromWorktree.text).toBe(fromRoot.text);
    // ...and whatever state exists afterwards sits in the same tree either way. A verb that writes
    // nothing leaves both sides empty; one that writes (spawn) must have written to <ROOTHASH>.
    expect(fromWorktree.trees).toEqual(fromRoot.trees);
    expect(fromWorktree.trees).not.toContain("<WTHASH>");
  });
});

describe("the over-broad guard: a user's OWN worktree is left exactly as git reported it", () => {
  /** A worktree the USER made (the standard parallel-session discipline), outside `.ap/worktrees/`.
   *  Re-homing it into the main repo's state namespace would be a worse failure than the one this
   *  fixes, so its verbs must keep resolving their own tree — exactly as a plain checkout does. */
  function userWorktree(f: Fixture): string {
    // Three segments deep, exactly like the near-miss the guard exists for (`/repo/wt/feature/
    // checkout`): the inverse string surgery recovers the MAIN root from it, and only the provenance
    // check stops that recovery from being used.
    const wt = join(f.root, "wt", "feature", "mine");
    git(f.root, "worktree", "add", "-q", "-b", "user-branch", wt);
    return realpathSync(wt);
  }

  /** Run one row standing in `kind`, with its state seeded into the tree that checkout resolves to,
   *  and normalize by THAT checkout's hash. A user worktree that behaves like a plain checkout is
   *  the property; anything re-homed shows up as an unreplaced hash. */
  async function observeAt(row: Row, kind: "plain-root" | "user-worktree"): Promise<Observation> {
    const f = fixture();
    const cwd = kind === "plain-root" ? f.root : userWorktree(f);
    row.seed(f, cwd);
    const before = stateTrees(f.home);
    process.chdir(cwd);
    const cap = await capture(row.invoke);
    process.chdir(f.root);
    const label = (h: string): string => (h === repoHash(cwd) ? "<OWNHASH>" : h === repoHash(f.root) ? "<MAINHASH>" : h === repoHash(f.wt) ? "<RUNWTHASH>" : h);
    const text = cap.text
      .split(repoHash(cwd)).join("<OWNHASH>")
      .split(repoHash(f.root)).join("<MAINHASH>")
      .split(repoHash(f.wt)).join("<RUNWTHASH>")
      .split(f.home).join("<HOME>")
      .split(cwd).join("<CWD>")
      .split(f.root).join("<ROOT>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>")
      .replace(/\d{8}T\d{6}Z/g, "<TS>");
    return { rc: cap.rc, text, trees: treesCreated(f.home, before).map(label) };
  }

  it.each(ROWS)("$family: from a user worktree, behaves exactly like a plain checkout", async (row) => {
    const plain = await observeAt(row, "plain-root");
    const mine = await observeAt(row, "user-worktree");
    expect(mine.rc).toBe(plain.rc);
    expect(mine.text).toBe(plain.text);
    expect(mine.trees).toEqual(plain.trees);
    expect(mine.trees).not.toContain("<MAINHASH>");   // never re-homed into the main repo's namespace
  });
});

describe("orphaned state — a run that started before uniform rooting fails CLOSED", () => {
  it.each(ROWS)("$family: state only under the worktree hash -> rc 2 naming both paths", async (row) => {
    const f = fixture();
    const stranded = seedTopicDir(f.home, f.wt, TOPIC);
    process.chdir(f.wt);
    const cap = await capture(row.invoke);
    process.chdir(f.root);
    expect(cap.rc).toBe(2);
    expect(cap.text).toContain(stranded);                                       // the worktree-side path
    expect(cap.text).toContain(join(f.home, "state", repoHash(f.root), TOPIC));  // and the main-side one
    expect(cap.text).toContain("ap will not move a run's state for you");        // the remedy, not a migration
  });

  it("state under the ROOT hash is normal operation — no refusal", async () => {
    const f = fixture();
    seedTopicDir(f.home, f.root, TOPIC);
    process.chdir(f.wt);
    const cap = await capture(() => exploreRun(["survivors", TOPIC]));
    process.chdir(f.root);
    expect(cap.rc).toBe(1);                       // explore's own "art dir not found", not the refusal
    expect(cap.text).not.toContain("ap will not move a run's state for you");
  });

  it("state under BOTH hashes -> the root wins and nothing refuses (the post-fix steady state)", async () => {
    const f = fixture();
    seedTopicDir(f.home, f.root, TOPIC);
    seedTopicDir(f.home, f.wt, TOPIC);
    process.chdir(f.wt);
    const cap = await capture(() => exploreRun(["survivors", TOPIC]));
    process.chdir(f.root);
    expect(cap.rc).toBe(1);
    expect(cap.text).not.toContain("ap will not move a run's state for you");
  });

  it("no re-root, no refusal: a plain checkout with stranded state elsewhere is untouched", async () => {
    const f = fixture();
    seedTopicDir(f.home, f.wt, TOPIC);
    const cap = await capture(() => exploreRun(["survivors", TOPIC]));   // cwd is the ROOT
    expect(cap.rc).toBe(1);
    expect(cap.text).not.toContain("ap will not move a run's state for you");
  });
});

// #164: the four verbs #155 missed. The table above already pins that each one RESOLVES the root
// tree; these pin the two things a table of text comparisons cannot see — that stop's destructive
// half (archive, .last_pane, the topic rmdir, the --all sweep) lands on the root tree, and that the
// orphan refusal happens BEFORE any of it.
describe("the four verbs #155 missed: stop/list/collect/preflight operate on the ROOT tree", () => {
  it("stop archives the ROOT worker and cleans the ROOT topic dir, leaving the worktree tree alone", async () => {
    const f = fixture();
    const rootWorker = seedWorker(f.home, f.root, MODEL);
    const rootTopic = join(f.home, "state", repoHash(f.root), TOPIC);
    writeFileSync(join(rootTopic, ".last_pane"), "%9\tnonce\n");
    // A topic dir under the WORKTREE tree too — so this is also the both-trees steady state (no
    // refusal, the root wins) AND the decoy cleanupTopicDir would have deleted from a raw cwd.
    const wtTopic = seedTopicDir(f.home, f.wt, TOPIC);
    writeFileSync(join(wtTopic, ".last_pane"), "%8\tnonce\n");

    process.chdir(f.wt);
    const cap = await capture(() => stopRun([AGENT, TOPIC]));
    process.chdir(f.root);

    expect(cap.rc).toBe(0);
    expect(cap.text).toContain(`archived ${AGENT}-${MODEL}`);
    expect(existsSync(rootWorker)).toBe(false);                                   // moved to the archive
    expect(readdirSync(join(f.home, "archive", repoHash(f.root), TOPIC))).toHaveLength(1);
    expect(existsSync(join(rootTopic, ".last_pane"))).toBe(false);                // cleanupTopicDir ran here
    expect(existsSync(rootTopic)).toBe(false);                                    // ...and emptied the dir
    expect(existsSync(join(wtTopic, ".last_pane"))).toBe(true);                   // never the worktree tree
    expect(existsSync(join(f.home, "archive", repoHash(f.wt)))).toBe(false);
  });

  it("stop --all from inside the run worktree sweeps the ROOT state dir", async () => {
    const f = fixture();
    const rootWorker = seedWorker(f.home, f.root, MODEL);
    const stray = seedTopicDir(f.home, f.wt, "other");   // only in the worktree tree; not --all's to sweep
    process.chdir(f.wt);
    const cap = await capture(() => stopRun(["--all", "--yes"]));
    process.chdir(f.root);
    expect(cap.rc).toBe(0);
    expect(cap.text).toContain(`archived ${AGENT}-${MODEL}`);
    expect(existsSync(rootWorker)).toBe(false);
    expect(existsSync(stray)).toBe(true);
  });

  it("list prints the ROOT-keyed worker's row from inside the run worktree", async () => {
    const f = fixture();
    seedWorker(f.home, f.root, MODEL);
    process.chdir(f.wt);
    const cap = await capture(() => listRun([TOPIC]));
    process.chdir(f.root);
    expect(cap.rc).toBe(0);
    expect(cap.text).toMatch(new RegExp(`^${AGENT}\\s+${MODEL}\\s+${TOPIC}\\b`, "m"));
    expect(cap.text).not.toContain("no workers deployed");
  });

  it("collect resolves the ROOT-keyed worker from inside the run worktree", async () => {
    const f = fixture();
    seedWorker(f.home, f.root, MODEL);
    process.chdir(f.wt);
    const cap = await capture(() => collectRun([AGENT, TOPIC, "--timeout", "1"]));
    process.chdir(f.root);
    expect(cap.text).toContain(`tailing outbox for ${AGENT}-${MODEL}`);
    expect(cap.text).not.toContain(`no worker '${AGENT}'`);
  });

  it("preflight's default art dir lands under the ROOT topic dir", async () => {
    const f = fixture();
    process.chdir(f.wt);
    await capture(() => preflightRun([TOPIC, "2", "--list", `${AGENT}:${MODEL},bravo:${MODEL}`]));
    process.chdir(f.root);
    expect(existsSync(join(f.home, "state", repoHash(f.root), TOPIC, "_consult"))).toBe(true);
    expect(existsSync(join(f.home, "state", repoHash(f.wt)))).toBe(false);
  });
});

describe("stop refuses a stranded run WITHOUT touching it", () => {
  it("state only under the worktree hash -> rc 2, nothing archived and nothing deleted", async () => {
    const f = fixture();
    const strandedWorker = seedWorker(f.home, f.wt, MODEL);
    const strandedTopic = join(f.home, "state", repoHash(f.wt), TOPIC);
    writeFileSync(join(strandedTopic, ".last_pane"), "%7\tnonce\n");
    process.chdir(f.wt);
    const cap = await capture(() => stopRun([AGENT, TOPIC]));
    process.chdir(f.root);
    expect(cap.rc).toBe(2);
    expect(cap.text).toContain("ap will not move a run's state for you");
    // The refusal precedes teardownBatch AND cleanupTopicDir: the run the operator has to decide
    // about is exactly as they left it.
    expect(existsSync(strandedWorker)).toBe(true);
    expect(existsSync(join(strandedTopic, ".last_pane"))).toBe(true);
    expect(existsSync(join(f.home, "archive"))).toBe(false);
  });
});

describe("the reproduced field case: spawn from the worktree, send from the root", () => {
  it("identity.md lands in the ROOT tree and names the inbox `send` computes there", async () => {
    const f = fixture();
    process.chdir(f.wt);
    await capture(() => spawnRun([AGENT, MODEL, TOPIC]));   // stops at the placement, after the state write
    process.chdir(f.root);

    const rootIdentity = identityPath(AGENT, MODEL, TOPIC);            // resolved from the ROOT
    const wtIdentity = join(f.home, "state", repoHash(f.wt), TOPIC, `${AGENT}-${MODEL}`, "identity.md");
    expect(existsSync(rootIdentity)).toBe(true);
    expect(existsSync(wtIdentity)).toBe(false);

    // The worker refuses any nudge naming an inbox its identity.md does not name — that refusal is
    // what turned this bug into a visible stall, and it stays. So the two paths must be one path.
    const declared = /Your inbox: `([^`]+)`/.exec(readFileSync(rootIdentity, "utf8"))?.[1];
    expect(declared).toBe(inboxPath(AGENT, MODEL, TOPIC));
    expect(stateTrees(f.home)).toEqual([repoHash(f.root)]);
  });
});
