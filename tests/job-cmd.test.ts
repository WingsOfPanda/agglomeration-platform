import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { run } from "../src/commands/job.js";
import { formatJob, jobPath, type JobRecord } from "../src/core/job.js";
import { outboxPath } from "../src/core/ipc.js";

const REC: JobRecord = {
  command: "implement", topic: "demo", session: "ap-demo",
  hub: { agent: "alpha", model: "claude" },
  provider: "codex", finish: "keep", budget_hours: 6, max_rounds: 5,
  args_file: "/tmp/args", started: new Date().toISOString(),
};
/** Write a job record for `demo` under the CURRENT cwd's namespace. */
function seedJob(rec: JobRecord = REC): void {
  const p = jobPath(rec.topic);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, formatJob(rec));
}

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
  it("status / attach / wait / relay all refuse a topic with no record", async () => {
    home();
    expect(await run(["status", "nosuch"])).toBe(1);
    expect(await run(["attach", "nosuch"])).toBe(1);
    expect(await run(["wait", "nosuch"])).toBe(1);
    expect(await run(["relay", "nosuch", "hi"])).toBe(1);
  });
  // The hub branches on 0-vs-1 ("exit 1 means exhausted -> park"), so a record it cannot read has to
  // land on the PARK side. Rc 2 stays reserved for the operator's own typo.
  it("budget-check on an unreadable record fails CLOSED: BUDGET=unknown, exit 1", async () => {
    home();
    const { rc, out } = await capture(() => run(["budget-check", "nosuch"]));
    expect(rc).toBe(1);
    expect(out).toContain("BUDGET=unknown");
  });
  it("an invalid topic slug is refused before anything is read", async () => {
    home();
    expect(await run(["status", "BAD TOPIC"])).toBe(1);
    expect(await run(["mode", "BAD TOPIC"])).toBe(2);
    expect(await run(["budget-check", "BAD TOPIC"])).toBe(2);
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

// capture process.stdout/stderr for the duration of fn() — the KV report goes to stdout and every
// refusal to stderr, so both are only observable here.
async function capture(fn: () => Promise<number>): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try { const rc = await fn(); return { rc, out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

describe("one namespace for the origin and its hub", () => {
  // Every state path derives from process.cwd(); the job hub is launched with cwd=repoRoot(). An
  // origin verb run from a repo SUBDIRECTORY used to resolve its own `_job` tree, so `job mode`
  // answered DETACHED=0 to the hub — the "ordinary attached run" branch, which finishes by pushing
  // and opening a PR.
  it("a verb run from a subdirectory reads the record the hub wrote at the repo root", async () => {
    home();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-repo-")));
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, "docs"));
    const orig = process.cwd();
    try {
      process.chdir(root);
      seedJob();                       // the record as the hub (at the repo root) writes it
      process.chdir(join(root, "docs"));
      expect(await run(["mode", "demo"])).toBe(0);
      expect(process.cwd()).toBe(join(root, "docs"));   // and the caller's cwd is restored
    } finally { process.chdir(orig); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("job relay — the parked check is the only gate on the hub's inbox", () => {
  function seedOutbox(lines: Array<Record<string, unknown>>): void {
    const p = outboxPath(REC.hub.agent, REC.hub.model, REC.topic);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  }
  it("REFUSES (rc 1) when the hub is working — nothing is sent, so no pane is ever touched", async () => {
    home();
    seedJob();
    seedOutbox([{ event: "question", message: "which?" }, { event: "ack" }]);
    const { rc, err } = await capture(() => run(["relay", "demo", "codex"]));
    expect(rc).toBe(1);
    expect(err).toContain("nothing is parked (last event: ack)");
  });
  it("REFUSES a relay onto a FINISHED hub — the task would be written for nobody", async () => {
    home();
    seedJob();
    seedOutbox([{ event: "question", message: "which?" }, { event: "done", summary: "shipped" }]);
    expect((await capture(() => run(["relay", "demo", "codex"]))).rc).toBe(1);
  });
  it("REFUSES when the hub has emitted nothing at all", async () => {
    home();
    seedJob();
    const { rc, err } = await capture(() => run(["relay", "demo", "codex"]));
    expect(rc).toBe(1);
    expect(err).toContain("last event: none");
  });
  it("a missing message is still usage (rc 2), before the outbox is read", async () => {
    home();
    seedJob();
    expect(await run(["relay", "demo", "  "])).toBe(2);
  });
});

describe("job status / attach — shared parked verdict", () => {
  function seedOutbox(text: string): number {
    const p = outboxPath(REC.hub.agent, REC.hub.model, REC.topic);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return Buffer.byteLength(text, "utf8");
  }
  const question = JSON.stringify({ event: "question", message: "which provider?\none line, please" }) + "\n";

  it("status and attach report the same unanswered multiline question", async () => {
    home();
    seedJob();
    seedOutbox(question);
    const status = (await capture(() => run(["status", "demo"]))).out;
    const attach = (await capture(() => run(["attach", "demo"]))).out;
    for (const out of [status, attach]) {
      expect(out).toContain("PARKED=yes");
      expect(out).toContain("PARKED_MESSAGE=which provider?%0Aone line%2C please");
    }
  });
  it("status and attach both suppress a question once the relay cursor covers it", async () => {
    home();
    seedJob();
    const size = seedOutbox(question);
    writeFileSync(join(dirname(jobPath(REC.topic)), "cursor.txt"), String(size) + "\n");
    const status = (await capture(() => run(["status", "demo"]))).out;
    const attach = (await capture(() => run(["attach", "demo"]))).out;
    for (const out of [status, attach]) {
      expect(out).toContain("PARKED=no");
      expect(out).not.toContain("PARKED_MESSAGE=");
    }
    expect(status).toContain("LAST_EVENT=question");   // the event itself is still reported
  });

  it.each([
    ["no outbox", null],
    ["newest ack", question + JSON.stringify({ event: "ack" }) + "\n"],
    ["newest done", question + JSON.stringify({ event: "done" }) + "\n"],
  ])("attach reports PARKED=no with %s", async (_name, outbox) => {
    home();
    seedJob();
    if (outbox !== null) seedOutbox(outbox);
    const { out } = await capture(() => run(["attach", "demo"]));
    expect(out).toContain("PARKED=no");
    expect(out).not.toContain("PARKED_MESSAGE=");
  });
});
