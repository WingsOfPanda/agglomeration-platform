import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  // `--finish` is gone (removed 2026-08-18, having never run live): a detached run has exactly one
  // legal ending, so even `--finish keep` is now just an unknown argument. Nothing is spawned and no
  // worktree is made — the refusal is the first thing the parse loop does.
  it("REFUSES --finish in every form, as an unknown argument", async () => {
    home();
    const f = argsFile("docs/x-design.md");
    for (const action of ["keep", "pr", "merge", "discard"]) {
      const { rc, err } = await capture(() => run(["start", "--command", "implement", "--args-file", f, "--finish", action]));
      expect(rc).toBe(2);
      expect(err).toContain("unknown argument '--finish'");
    }
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
  // `wait` is deliberately NOT in this list: a watcher polls it, so a missing record is a
  // stand-down it must SAY out loud (rc 0, JS=standdown) rather than a stderr-only refusal.
  it("status / attach / relay all refuse a topic with no record", async () => {
    home();
    expect(await run(["status", "nosuch"])).toBe(1);
    expect(await run(["attach", "nosuch"])).toBe(1);
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

// The watcher's whole contract. A poll loop cannot tell "the run finished" from "I could not
// execute" unless every answer is a line: on xjp a watcher whose claude binary had been replaced
// mid-run spun silently for 22 minutes past the hub's `done`. So every path through the verb prints
// exactly one JS= line, and the loop turns the one remaining silence — ap never ran — into
// JS=unreachable.
describe("job wait always speaks — exactly one JS= line per invocation", () => {
  function seedOutbox(lines: Array<Record<string, unknown>>): void {
    const p = outboxPath(REC.hub.agent, REC.hub.model, REC.topic);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  }
  const JS = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("JS="));

  it("no record: JS=standdown and rc 0 — from a watcher's seat the run is over", async () => {
    home();
    const { rc, out } = await capture(() => run(["wait", "nosuch"]));
    expect(rc).toBe(0);
    expect(JS(out)).toEqual(["JS=standdown"]);
  });

  it("a record that is present but unparseable: JS=torn, rc 1, and it names the file", async () => {
    home();
    const p = jobPath("demo");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{half-writ");
    const { rc, out, err } = await capture(() => run(["wait", "demo"]));
    expect(rc).toBe(1);
    expect(JS(out)).toEqual(["JS=torn"]);
    expect(err).toContain(p);
  });

  // Fail closed, the 0.5.31 doctrine: an empty file is mid-write or truncated, never a stand-down.
  it("an EMPTY record file is torn, not standdown", async () => {
    home();
    const p = jobPath("demo");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "");
    const { rc, out } = await capture(() => run(["wait", "demo"]));
    expect(rc).toBe(1);
    expect(JS(out)).toEqual(["JS=torn"]);
  });

  it("a mistyped topic is torn too — a typo must never read as a finished run", async () => {
    home();
    const { rc, out } = await capture(() => run(["wait", "BAD TOPIC"]));
    expect(rc).toBe(1);
    expect(JS(out)).toEqual(["JS=torn"]);
  });

  it("a terminal event already in the outbox: JS=<event>, rc 0, question carrying its payload", async () => {
    home();
    seedJob();
    seedOutbox([{ event: "done", summary: "shipped" }]);
    const done = await capture(() => run(["wait", "demo"]));
    expect(done.rc).toBe(0);
    expect(JS(done.out)).toEqual(["JS=done"]);
    seedOutbox([{ event: "question", message: "merge or keep?\nsay which" }]);
    const q = await capture(() => run(["wait", "demo"]));
    expect(q.rc).toBe(0);
    expect(JS(q.out)).toEqual(["JS=question"]);
    // percent-encoded, so the payload can never forge a second KV line at the watcher
    expect(q.out).toContain("QUESTION=merge or keep?%0Asay which");
  });

  it("nothing to report before the budget expires: JS=timeout, rc 1", async () => {
    home();
    seedJob();
    const prev = process.env.AP_JOB_WAIT_TIMEOUT_S;
    process.env.AP_JOB_WAIT_TIMEOUT_S = "1";
    try {
      const { rc, out } = await capture(() => run(["wait", "demo"]));
      expect(rc).toBe(1);
      expect(JS(out)).toEqual(["JS=timeout"]);
    } finally {
      if (prev === undefined) delete process.env.AP_JOB_WAIT_TIMEOUT_S; else process.env.AP_JOB_WAIT_TIMEOUT_S = prev;
    }
  });
});

// Producer<->consumer contract: the watcher loop lives in prose, in two files, and the tokens it
// branches on are printed by the verb above. Both must move together, and the loop itself must stay
// one text — a fix applied to one directive and not the other is how the pair silently diverges.
describe("job wait tokens <-> the directives' canonical loop", () => {
  const md = (p: string) => readFileSync(join(process.cwd(), "commands", p), "utf8");
  const implement = md("implement.md");
  const quick = md("quick.md");
  const LOOP = `   \`\`\`
   Monitor(persistent: true, description: 'detached job <TOPIC>', command: '
     while :; do
       OUT=$($CS job wait <TOPIC> 2>/dev/null)
       case "$OUT" in
         *"JS=done"*|*"JS=error"*|*"JS=question"*) printf "%s\\n" "$OUT"; exit 0;;
         *"JS=standdown"*) printf "JS=standdown\\n"; exit 0;;
         *"JS=timeout"*) ;;
         *) printf "JS=unreachable\\n%s\\n" "$OUT"; exit 1;;
       esac
     done')
   \`\`\``;

  it("both directives carry the loop, byte for byte", () => {
    expect(implement, "implement.md's Monitor loop drifted from the canonical text").toContain(LOOP);
    expect(quick, "quick.md's Monitor loop drifted from the canonical text").toContain(LOOP);
  });

  // The loop ran through `grep -E` until 0.5.43. On the box this fix comes from, grep resolved
  // through the same shimmed binary that had broken — one dependency the watch does not need.
  it("the loop shells out to nothing but ap itself", () => {
    expect(LOOP).not.toContain("grep");
    expect(LOOP).not.toContain("job mode");
    // and the pre-0.5.43 shape is gone from both files, not merely joined by the new one
    for (const text of [implement, quick]) {
      expect(text).not.toContain("| grep -E");
      expect(text).not.toContain("$CS job mode <TOPIC> >/dev/null");
    }
  });

  it("every JS= token the verb can print is a documented branch in both directives", () => {
    for (const tok of ["JS=done", "JS=error", "JS=question", "JS=timeout", "JS=standdown", "JS=torn", "JS=unreachable"]) {
      // `JS=torn` reaches a reader only through the loop's catch-all, so it is the ONE token the
      // prose need not name; the others are branches an origin hub has to know by name.
      if (tok === "JS=torn") continue;
      expect(implement, `implement.md documents no ${tok} branch`).toContain(tok);
      expect(quick, `quick.md documents no ${tok} branch`).toContain(tok);
    }
  });

  it("both carry the untrusted-hint rule for a push from the job hub", () => {
    for (const [name, text] of [["implement.md", implement], ["quick.md", quick]] as const) {
      expect(text, `${name} lost the hint rule`).toContain("HINT, never a verdict");
      expect(text, `${name} must send the reader to the mechanical check`).toContain("job status");
    }
    expect(implement).toContain("implement flag");
    expect(quick).toContain("quick flag");
  });
});

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
    ["no outbox", null, 0, "none"],
    ["newest ack", question + JSON.stringify({ event: "ack" }) + "\n", 2, "ack"],
    ["newest done", question + JSON.stringify({ event: "done" }) + "\n", 2, "done"],
  ])("status and attach report PARKED=no with %s", async (_name, outbox, events, lastEvent) => {
    home();
    seedJob();
    if (outbox !== null) seedOutbox(outbox);
    const status = (await capture(() => run(["status", "demo"]))).out;
    const attach = (await capture(() => run(["attach", "demo"]))).out;
    for (const out of [status, attach]) {
      expect(out).toContain("PARKED=no");
      expect(out).not.toContain("PARKED_MESSAGE=");
    }
    expect(status).toContain(`EVENTS=${events}`);
    expect(status).toContain(`LAST_EVENT=${lastEvent}`);
    if (lastEvent === "none") expect(status).not.toContain("--- recent events ---");
    else {
      expect(status).toContain("--- recent events ---\n");
      expect(status).toContain(`?\t${lastEvent}\t\n`);
    }
  });
});
