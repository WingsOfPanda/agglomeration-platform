// tests/with-main-checkout.test.ts — the re-rooting wrapper every command verb's run() delegates to.
//
// tests/state-rooting.test.ts pins the OBSERVABLE (each verb family resolves one tree, and a split
// run is refused) through the verbs themselves. This pins the three things the wrapper itself owns
// and no verb can show: the refusal returns 2 WITHOUT chdir-ing or running the verb, the success
// path runs the verb from the main checkout and hands the caller's cwd back, and a cwd that vanished
// mid-verb is swallowed rather than turned into a throw.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { topicDir } from "../src/core/paths.js";
import { withMainCheckout, worktreePathFor } from "../src/core/job.js";

const TOPIC = "demo";
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** A repo with one commit and a real ap-created run worktree at `<root>/.ap/worktrees/demo`, with
 *  the worktree as the current directory and a fresh AP_HOME. */
function fixture(): { root: string; wt: string; home: string } {
  const h = freshHome();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-wmc-")));
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "ap tests");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const wt = worktreePathFor(root, TOPIC);
  git(root, "worktree", "add", "-q", "-b", TOPIC, wt);
  const cwd0 = process.cwd();
  process.chdir(wt);
  cleanups.push(() => {
    process.chdir(cwd0);
    rmSync(root, { recursive: true, force: true });
    h.cleanup();
  });
  return { root, wt, home: h.home };
}

async function capture(fn: () => Promise<number>): Promise<{ rc: number; text: string }> {
  const chunks: string[] = [];
  const se = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
  try { return { rc: await fn(), text: chunks.join("") }; }
  finally { process.stderr.write = se; }
}

describe("withMainCheckout", () => {
  it("runs the verb from the MAIN checkout and hands the caller's cwd back", async () => {
    const f = fixture();
    let seen = "";
    const rc = await withMainCheckout(async () => { seen = process.cwd(); return 7; });
    expect(seen).toBe(f.root);        // the verb saw the main checkout, not the worktree it was called from
    expect(rc).toBe(7);               // and its rc is passed through untouched
    expect(process.cwd()).toBe(f.wt); // restored
  });

  it("refuses stranded state with rc 2, without chdir-ing and without running the verb", async () => {
    const f = fixture();
    const stranded = topicDir(TOPIC, { cwd: f.wt });
    mkdirSync(stranded, { recursive: true });
    let ran = false;
    const cap = await capture(() => withMainCheckout(async () => { ran = true; return 0; }));
    expect(cap.rc).toBe(2);
    expect(ran).toBe(false);
    expect(process.cwd()).toBe(f.wt);
    expect(cap.text).toContain(stranded);
    expect(cap.text).toContain("ap will not move a run's state for you");
  });

  it("a cwd removed mid-verb does not turn a completed verb into a throw", async () => {
    const f = fixture();
    const rc = await withMainCheckout(async () => { rmSync(f.wt, { recursive: true, force: true }); return 0; });
    expect(rc).toBe(0);                 // the failed restore is swallowed
    expect(process.cwd()).toBe(f.root); // and the process stays where the verb ran
  });
});
