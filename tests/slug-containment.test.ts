// tests/slug-containment.test.ts — the topic/agent path-segment gate (0.5.27).
// Every case here was a REPRODUCED traversal against the committed dist: an out-of-charset topic or
// agent reached `join()` unchecked and the verb acted on a normalized path outside the state root.
// The sandbox layout is <box>/home (AP_HOME, the whole state root) + <box>/canary.txt (outside it),
// so a traversal that escapes is visible as a change to <box> and nothing real is ever reachable.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { captureStdout } from "./helpers/captureStdout.js";
import { assertSlug, SlugError, validateSlug } from "../src/core/slug.js";
import { dispatch } from "../src/core/dispatch.js";
import { repoStateDir, topicDir, workerDir } from "../src/core/paths.js";
import { designArtDir } from "../src/core/design.js";
import { autoresearchArtDir } from "../src/core/autoresearch.js";
import { statusPath } from "../src/core/ipc.js";
import { globalRoot } from "../src/core/paths.js";
import { run as designRun } from "../src/commands/design.js";
import { run as implementRun } from "../src/commands/implement.js";
import { run as autoresearchRun } from "../src/commands/autoresearch.js";
import { run as stopRun } from "../src/commands/stop.js";
import { run as exploreRun } from "../src/commands/explore.js";
import { run as quickRun } from "../src/commands/quick.js";
import { run as bridgeRun } from "../src/commands/bridge.js";
import { run as preflightRun } from "../src/commands/preflight.js";

const CANARY = "DO NOT TOUCH\n";
const boxes: string[] = [];
afterEach(() => { delete process.env.AP_HOME; while (boxes.length) rmSync(boxes.pop()!, { recursive: true, force: true }); });

/** A throwaway sandbox: AP_HOME (the state root) nested one level inside it, a canary beside it. */
function sandbox(): { box: string; canary: string } {
  const box = mkdtempSync(join(tmpdir(), "ap-slug-"));
  boxes.push(box);
  mkdirSync(join(box, "home", "state"), { recursive: true });
  process.env.AP_HOME = join(box, "home");
  const canary = join(box, "canary.txt");
  writeFileSync(canary, CANARY);
  return { box, canary };
}

/** Nothing escaped the state root: the canary is byte-identical and no new entry appeared beside it. */
function outsideUntouched(box: string, canary: string): void {
  expect(readFileSync(canary, "utf8")).toBe(CANARY);
  expect(readdirSync(box).sort()).toEqual(["canary.txt", "home"]);
}

function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => { buf += String(chunk); return true; };
  return { text: () => buf, restore: () => { (process.stderr as any).write = orig; } };
}

/** rc 2 + exactly one stderr line naming the refused segment, and nothing written outside. */
async function expectRefusal(
  fn: () => Promise<number>, box: string, canary: string,
  msg: RegExp = /must match \[a-z0-9-\]\+ and be <= 32 chars/,
): Promise<string> {
  const err = captureStderr();
  try {
    expect(await fn()).toBe(2);
  } finally { err.restore(); }
  expect(err.text().trimEnd().split("\n")).toHaveLength(1);
  expect(err.text()).toMatch(msg);
  outsideUntouched(box, canary);
  return err.text();
}

const upsTo = (from: string, to: string): number => relative(from, to).split(sep).length;
/** An agent that makes `<phase>-<agent>.txt` land ON the canary: one `..` per level up to the box,
 *  plus two — one to leave the `<phase>-..` segment the glue creates, one for the `..` it swallowed. */
const gluedAgent = (art: string, box: string): string => "../".repeat(upsTo(art, box) + 2) + "canary";
/** An agent that is its own path segment (`<dir>/<agent>/…`) and lands on `<box>/canary`. */
const segmentAgent = (dir: string, box: string): string => "../".repeat(upsTo(dir, box)) + "canary";

describe("assertSlug", () => {
  it("accepts everything the slug minters emit", () => {
    for (const s of ["a", "auth-review", "add-oauth", "exp-001-x", "0", "x".repeat(32)])
      expect(assertSlug("topic", s)).toBe(s);
  });
  it("rejects traversal, absolute, empty, over-length, uppercase and separators", () => {
    for (const s of ["..", "../evil", "../../../canary", "/etc/passwd", "a/b", "", "x".repeat(33), "Bad", "has space", "a.b", "x\u0000y"])
      expect(() => assertSlug("agent", s)).toThrow(SlugError);
  });
  it("carries rc 2 and the existing wording, per kind", () => {
    try { assertSlug("topic", "../x"); expect.unreachable(); }
    catch (e) {
      expect(e).toBeInstanceOf(SlugError);
      expect((e as SlugError).code).toBe(2);
      expect((e as SlugError).message).toBe("topic must match [a-z0-9-]+ and be <= 32 chars; got: '../x'");
    }
    expect(() => assertSlug("agent", "../x")).toThrow(/^agent must match/);
  });
  it("leaves validateSlug's verdicts unchanged (the three verbs that call it directly)", () => {
    expect(validateSlug("auth-review")).toBe(true);
    expect(validateSlug("../evil")).toBe(false);
  });
});

describe("path choke point", () => {
  it("topicDir/workerDir refuse a traversal segment", () => {
    sandbox();
    expect(() => topicDir("../evil")).toThrow(SlugError);
    expect(() => workerDir("../evil", "codex", "demo")).toThrow(SlugError);
  });
  it("valid slugs build the same paths as before (byte-identical)", () => {
    sandbox();
    expect(topicDir("demo")).toBe(join(repoStateDir(), "demo"));
    expect(workerDir("alpha", "codex", "demo")).toBe(join(repoStateDir(), "demo", "alpha-codex"));
  });
});

describe("dispatch", () => {
  it("renders a SlugError as one stderr line + rc 2, not a stack", async () => {
    const err = captureStderr();
    let rc: number;
    try { rc = await dispatch(async () => { assertSlug("topic", "../x"); return 0; }, []); }
    finally { err.restore(); }
    expect(rc).toBe(2);
    expect(err.text()).toBe("topic must match [a-z0-9-]+ and be <= 32 chars; got: '../x'\n");
  });
});

describe("traversal regressions — topic segment", () => {
  it("design archive: refuses instead of renaming a dir outside the state root", async () => {
    const { box, canary } = sandbox();
    const bad = `${"../".repeat(upsTo(repoStateDir(), box))}canary.txt`;
    expect(resolve(repoStateDir(), bad)).toBe(canary);          // the reach the gate refuses
    await expectRefusal(() => dispatch(designRun, ["archive", bad]), box, canary);
  });
  it("design offset-reset: refuses an out-of-charset topic", async () => {
    const { box, canary } = sandbox();
    await expectRefusal(() => dispatch(designRun, ["offset-reset", "../../../victim", "alpha", "research"]), box, canary);
  });
  it("stop: refuses instead of renaming a dir outside the state root", async () => {
    const { box, canary } = sandbox();
    const bad = `${"../".repeat(upsTo(repoStateDir(), box))}canary.txt`;
    expect(resolve(repoStateDir(), bad)).toBe(canary);
    await expectRefusal(() => dispatch(stopRun, [bad]), box, canary);
  });
  it("implement reset-status: refuses an out-of-charset topic", async () => {
    const { box, canary } = sandbox();
    await expectRefusal(() => dispatch(implementRun, ["reset-status", "../../../victim", "alpha"]), box, canary);
  });
  it("autoresearch drop-worker: refuses an out-of-charset topic", async () => {
    const { box, canary } = sandbox();
    await expectRefusal(() => dispatch(autoresearchRun, ["drop-worker", "../../../victim", "alpha"]), box, canary);
  });
  // `flag` writes to globalRoot()/forensics/<date>/<time>-<command>-flag-<topic>.md with the literal
  // "(hub-flag)" as its art dir — no art-dir helper runs, so the topicDir choke point never sees it.
  it("<command> flag: all six verbs refuse instead of naming a file under globalRoot()", async () => {
    const { box, canary } = sandbox();
    const feedDir = join(globalRoot(), "forensics", "2026-01-01");
    const bad = gluedAgent(feedDir, box);                       // same glue as `<phase>-<agent>`
    expect(resolve(feedDir, `00-00-00-quick-flag-${bad}.md`)).toBe(join(box, "canary.md"));
    for (const cmd of [designRun, exploreRun, implementRun, quickRun, bridgeRun, autoresearchRun])
      await expectRefusal(() => dispatch(cmd, ["flag", bad, "an observation"]), box, canary);
  });
  it("preflight: refuses at the shared gate (its private <=64 regex is gone)", async () => {
    const { box, canary } = sandbox();
    await expectRefusal(() => dispatch(preflightRun, ["../../../victim", "2", "--list", "alpha:codex,bravo:codex"]), box, canary);
    // the bound is now the choke point's 32, not preflight's old 64
    await expectRefusal(() => dispatch(preflightRun, ["x".repeat(33), "2", "--list", "alpha:codex,bravo:codex"]), box, canary);
  });
});

describe("traversal regressions — agent segment", () => {
  it("design offset-reset: refuses the agent that deletes an arbitrary file (valid topic)", async () => {
    const { box, canary } = sandbox();
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    const bad = gluedAgent(art, box);
    expect(resolve(art, `research-${bad}.txt`)).toBe(canary);   // the rmSync target the gate refuses
    await expectRefusal(() => dispatch(designRun, ["offset-reset", "t", bad, "research"]), box, canary);
  });
  it("design <phase>-send/-wait: refuses the agent spelled into the art dir", async () => {
    const { box, canary } = sandbox();
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    const bad = gluedAgent(art, box);
    expect(resolve(art, `research-${bad}.txt`)).toBe(canary);   // the state file both halves spell
    await expectRefusal(() => dispatch(designRun, ["research-send", "t", bad, "codex"]), box, canary);
    await expectRefusal(() => dispatch(designRun, ["research-wait", "t", bad, "codex"]), box, canary);
  });
  it("autoresearch monitor: refuses the agent it would mkdir a lane for", async () => {
    const { box, canary } = sandbox();
    const art = autoresearchArtDir("t"); mkdirSync(join(art, "workers"), { recursive: true });
    const bad = segmentAgent(join(art, "workers"), box);
    expect(resolve(join(art, "workers"), bad)).toBe(join(box, "canary"));
    await expectRefusal(() => dispatch(autoresearchRun, ["monitor", "t", bad, "--once"]), box, canary);
  });
  it("autoresearch verify-*/inspect-*: refuse the agent that names the experiment dir", async () => {
    const { box, canary } = sandbox();
    const art = autoresearchArtDir("t"); mkdirSync(join(art, "workers"), { recursive: true });
    const bad = segmentAgent(join(art, "workers"), box);
    expect(resolve(join(art, "workers"), bad)).toBe(join(box, "canary"));
    for (const args of [
      ["verify-plan", "t", bad, "exp-001"],
      ["verify-check", "t", bad, "exp-001", "--run-failed"],
      ["inspect-plan", "t", bad, "exp-001"],
      ["inspect-check", "t", bad, "exp-001", "--run-failed"],
    ]) await expectRefusal(() => dispatch(autoresearchRun, args), box, canary);
  });
  it("autoresearch verify-*/inspect-*: refuse a traversal exp-id (the segment below the agent)", async () => {
    const { box, canary } = sandbox();
    const art = autoresearchArtDir("t");
    const expDir = join(art, "workers", "alpha", "experiments");
    mkdirSync(expDir, { recursive: true });
    const badExp = `${"../".repeat(upsTo(expDir, box))}canary`;
    expect(resolve(expDir, badExp)).toBe(join(box, "canary"));  // where the verdict sidecar would land
    for (const args of [
      ["verify-plan", "t", "alpha", badExp],
      ["verify-check", "t", "alpha", badExp, "--run-failed"],
      ["inspect-plan", "t", "alpha", badExp],
      ["inspect-check", "t", "alpha", badExp, "--run-failed"],
    ]) await expectRefusal(() => dispatch(autoresearchRun, args), box, canary, /exp-id must match/);
  });
  // implement reset-status is NOT gated on its agent: resolveModel matches it against real dir names
  // (which contain no separator), so a traversal agent finds no worker and the verb exits before its
  // one write — and that write goes through statusPath -> workerDir, which the choke point covers.
  it("implement reset-status: a traversal agent finds no worker (rc 1) and writes nothing", async () => {
    const { box, canary } = sandbox();
    expect(await dispatch(implementRun, ["reset-status", "t", "../../../canary"])).toBe(1);
    outsideUntouched(box, canary);
  });
});

describe("happy path — valid slugs behave exactly as before", () => {
  it("design offset-reset clears the phase state (rc 0)", async () => {
    const { box, canary } = sandbox();
    const art = designArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "research-alpha.txt"), "OFFSET=5\nFS=failed\n");
    writeFileSync(join(art, "question-alpha.txt"), "{}\n");
    expect(await dispatch(designRun, ["offset-reset", "t", "alpha", "research"])).toBe(0);
    expect(existsSync(join(art, "research-alpha.txt"))).toBe(false);
    expect(existsSync(join(art, "question-alpha.txt"))).toBe(false);
    outsideUntouched(box, canary);
  });
  it("autoresearch drop-worker prunes workers.txt (rc 0)", async () => {
    const { box, canary } = sandbox();
    const art = autoresearchArtDir("t"); mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "workers.txt"), "alpha\nbravo\n");
    expect(await dispatch(autoresearchRun, ["drop-worker", "t", "alpha"])).toBe(0);
    expect(readFileSync(join(art, "workers.txt"), "utf8")).toBe("bravo\n");
    outsideUntouched(box, canary);
  });
  it("<command> flag records the observation under globalRoot() (rc 0)", async () => {
    const { box, canary } = sandbox();
    const out = captureStdout();
    let rc: number;
    try { rc = await dispatch(quickRun, ["flag", "t", "an observation"]); } finally { out.restore(); }
    expect(rc).toBe(0);
    const path = out.text().trim();
    expect(path.startsWith(join(globalRoot(), "forensics"))).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("an observation");
    outsideUntouched(box, canary);
  });
  it("implement reset-status forces the worker back to idle (rc 0)", async () => {
    const { box, canary } = sandbox();
    const wd = workerDir("alpha", "codex", "t"); mkdirSync(wd, { recursive: true });
    writeFileSync(join(wd, "pane.json"), JSON.stringify({ pane_id: "%1", agent: "alpha", model: "codex", spawned_at: "t" }));
    writeFileSync(join(wd, "status.json"), `{"state":"working"}\n`);
    expect(await dispatch(implementRun, ["reset-status", "t", "alpha"])).toBe(0);
    expect(readFileSync(statusPath("alpha", "codex", "t"), "utf8")).toBe(`{"state":"idle","last_event":"force-reset"}\n`);
    outsideUntouched(box, canary);
  });
});
