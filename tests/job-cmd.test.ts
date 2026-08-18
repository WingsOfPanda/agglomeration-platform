import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { run } from "../src/commands/job.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h.home; }
function argsFile(text: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "ap-args-")), "args");
  writeFileSync(f, text);
  return f;
}

describe("job start — launch-time refusals (nothing is spawned)", () => {
  it("refuses a command outside the two wired ones", async () => {
    home();
    expect(await run(["start", "--command", "explore", "--args-file", argsFile("x")])).toBe(2);
  });
  it("refuses a missing args file", async () => {
    home();
    expect(await run(["start", "--command", "implement", "--args-file", "/nope/args"])).toBe(2);
  });
  it("REFUSES --finish merge and --finish pr — nothing leaves the branch unattended", async () => {
    home();
    const f = argsFile("docs/x-design.md");
    expect(await run(["start", "--command", "implement", "--args-file", f, "--finish", "merge"])).toBe(2);
    expect(await run(["start", "--command", "implement", "--args-file", f, "--finish", "pr"])).toBe(2);
    expect(await run(["start", "--command", "implement", "--args-file", f, "--finish", "discard"])).toBe(2);
  });
  it("refuses a non-positive budget or round count", async () => {
    home();
    const f = argsFile("docs/x-design.md");
    expect(await run(["start", "--command", "implement", "--args-file", f, "--budget-hours", "0"])).toBe(2);
    expect(await run(["start", "--command", "implement", "--args-file", f, "--budget-hours", "abc"])).toBe(2);
    expect(await run(["start", "--command", "implement", "--args-file", f, "--max-rounds", "0"])).toBe(2);
  });
  it("refuses when no topic can be derived and none was given", async () => {
    home();
    expect(await run(["start", "--command", "implement", "--args-file", argsFile("--no-branch")])).toBe(2);
  });
  it("refuses an unknown argument rather than silently ignoring it", async () => {
    home();
    expect(await run(["start", "--command", "implement", "--args-file", argsFile("x.md"), "--bogus", "1"])).toBe(2);
  });
});

describe("job verbs on a topic with no job", () => {
  it("mode prints DETACHED=0 and exits 1, so a directive can branch on it", async () => {
    home();
    expect(await run(["mode", "nosuch"])).toBe(1);
  });
  it("status / attach / wait / relay / budget-check all refuse a topic with no record", async () => {
    home();
    expect(await run(["status", "nosuch"])).toBe(1);
    expect(await run(["attach", "nosuch"])).toBe(1);
    expect(await run(["wait", "nosuch"])).toBe(1);
    expect(await run(["relay", "nosuch", "hi"])).toBe(1);
    expect(await run(["budget-check", "nosuch"])).toBe(2);
  });
  it("an invalid topic slug is refused before anything is read", async () => {
    home();
    expect(await run(["status", "BAD TOPIC"])).toBe(1);
    expect(await run(["mode", "BAD TOPIC"])).toBe(2);
  });
  it("list on an empty repo prints only the header", async () => {
    home();
    expect(await run(["list"])).toBe(0);
  });
  it("an unknown subcommand is usage (rc 2)", async () => {
    home();
    expect(await run(["frobnicate"])).toBe(2);
    expect(await run([])).toBe(2);
  });
});
