// tests/forensics-issue.test.ts — the GitHub-issue backend of core/forensics.
// EVERY test drives the `gh` boundary through a FAKE runner and asserts the exact argv; the suite's
// AP_FORENSICS_BACKEND=queue guard (tests/helpers/setupEnv.ts) is lifted only where a test needs the
// filing path, and even then no real `gh` is reachable — the fake runner is the only one passed in.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import {
  AP_ISSUES_REPO, fileFinding, flushQueue, queueRecord, runIdentity, issueTitle, scrubSecrets,
  readConsent, writeConsent, readIssueTxt, recordHubFlag, captureSpawnFailure, runReflect,
  commandArtDir, type ForensicsRunner, type RunIdentity, type FlushResult,
} from "../src/core/forensics.js";
import { forensicsQueueDir, topicDir, workerDir } from "../src/core/paths.js";

let h: { home: string; cleanup: () => void };
beforeEach(() => { h = freshHome(); });
afterEach(() => { h.cleanup(); process.env.AP_FORENSICS_BACKEND = "queue"; });

/** Let this test reach the filing path (the fake runner is still the only `gh` it can reach). */
function allowFiling(): void { writeConsent("yes"); delete process.env.AP_FORENSICS_BACKEND; }

interface Script { list?: { code: number; stdout: string }; create?: { code: number; stdout: string }; comment?: { code: number; stdout: string } }

/** A `gh` that records every argv. `byTitle` scripts per-title create outcomes (run isolation). */
function fake(s: Script = {}, byTitle: Record<string, { code: number; stdout: string }> = {}) {
  const calls: string[][] = [];
  const r: ForensicsRunner = {
    run(cmd, args) {
      calls.push([cmd, ...args]);
      if (cmd === "git") return { code: 0, stdout: "https://github.com/o/r.git\n", stderr: "" };
      const verb = args[1];
      if (verb === "list") return { ...(s.list ?? { code: 0, stdout: "[]" }), stderr: "" };
      if (verb === "create") {
        const title = args[args.indexOf("--title") + 1];
        const scripted = byTitle[title] ?? s.create ?? { code: 0, stdout: `https://github.com/${AP_ISSUES_REPO}/issues/7\n` };
        return { ...scripted, stderr: "" };
      }
      return { ...(s.comment ?? { code: 0, stdout: "" }), stderr: "" };
    },
  };
  return { calls, r, gh: () => calls.filter((c) => c[0] === "gh") };
}

const RUN = (command = "quick", topic = "auth") => ({ command, topic, artDir: commandArtDir(command, topic) });
function seedArt(command = "quick", topic = "auth"): string {
  const art = commandArtDir(command, topic);
  mkdirSync(art, { recursive: true });
  return art;
}
function queued(): string[] {
  const dir = forensicsQueueDir();
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
}
const IDENTITY: RunIdentity = {
  version: "0.0.0", host: "box", user: "u", platform: "linux", node: "v22", providers: "", repo: "r",
};

describe("fileFinding: the gh boundary", () => {
  it("create carries --repo (never the caller's checkout) and the title/body", () => {
    allowFiling(); seedArt();
    const f = fake();
    const res = fileFinding("flag", RUN(), "[ap:quick] boom", "- **hub_flag** boom _(source: x)_\n", f.r);
    expect(res.status).toBe("filed");
    expect(res.line).toBe(`ISSUE=https://github.com/${AP_ISSUES_REPO}/issues/7`);
    const create = f.gh().find((c) => c[2] === "create")!;
    expect(create.slice(0, 6)).toEqual(["gh", "issue", "create", "--repo", AP_ISSUES_REPO, "--title"]);
    expect(create[6]).toBe("[ap:quick] boom");
    expect(create[7]).toBe("--body");
    expect(create[8]).toContain("<!-- ap-forensics run=");
    // every gh call in the flow names the tracker explicitly
    for (const c of f.gh()) expect(c).toContain(AP_ISSUES_REPO);
    expect(readIssueTxt(RUN().artDir)).toMatchObject({ number: "7" });
  });

  it("a second finding on the same run COMMENTS on the recorded number", () => {
    allowFiling(); seedArt();
    const f = fake();
    fileFinding("flag", RUN(), "[ap:quick] boom", "one\n", f.r);
    const res = fileFinding("findings", RUN(), "[ap:quick] boom", "two\n", f.r);
    expect(res.status).toBe("filed");
    const comment = f.gh().find((c) => c[2] === "comment")!;
    expect(comment.slice(0, 6)).toEqual(["gh", "issue", "comment", "7", "--repo", AP_ISSUES_REPO]);
    expect(comment[7]).toContain("<!-- ap-forensics run=");
    expect(comment[7]).toContain("kind=findings");
    expect(f.gh().filter((c) => c[2] === "create")).toHaveLength(1);   // still ONE issue
  });

  it("dedup: an open issue with the same title is commented on, not re-created", () => {
    allowFiling(); seedArt();
    const title = issueTitle("quick", "the worker died at 2026-08-30T10:00:00Z");
    const f = fake({ list: { code: 0, stdout: JSON.stringify([{ number: 42, title, labels: ["triaged"] }]) } });
    const res = fileFinding("flag", RUN(), title, "body\n", f.r);
    expect(res.number).toBe("42");                                     // a TRIAGED but open issue still matches
    const list = f.gh().find((c) => c[2] === "list")!;
    expect(list).toEqual(["gh", "issue", "list", "--repo", AP_ISSUES_REPO, "--state", "open",
      "--search", 'in:title "[ap:quick]"', "--json", "number,title", "--limit", "100"]);
    expect(f.gh().some((c) => c[2] === "create")).toBe(false);
    const comment = f.gh().find((c) => c[2] === "comment")!;
    expect(comment[3]).toBe("42");
    expect(comment[7]).toContain("seen again — run ");
    expect(readIssueTxt(RUN().artDir)).toMatchObject({ number: "42" });
  });

  it("queue-first: the record exists BEFORE the first gh call and is gone after it succeeds", () => {
    allowFiling(); seedArt();
    const seenAtFirstCall: number[] = [];
    const f = fake();
    const spy: ForensicsRunner = { run: (c, a) => { if (c === "gh") seenAtFirstCall.push(queued().length); return f.r.run(c, a); } };
    fileFinding("flag", RUN(), "[ap:quick] boom", "body\n", spy);
    expect(seenAtFirstCall[0]).toBe(1);                                // written before gh ran
    expect(queued()).toHaveLength(0);                                  // deleted after it succeeded
  });

  it("a failing gh (and a timeout-shaped result) leaves the record queued, warns, and never throws", () => {
    allowFiling(); seedArt();
    const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      const res = fileFinding("flag", RUN(), "[ap:quick] boom", "body\n",
        fake({ create: { code: 1, stdout: "" } }).r);                  // execFileSync's ETIMEDOUT shape
      expect(res.status).toBe("queued");
      expect(res.line).toBe(`QUEUED=${res.path}`);
      expect(queued()).toHaveLength(1);
      expect(err.mock.calls.map(String).join("")).toContain("record left queued");
    } finally { err.mockRestore(); }
  });

  it("the per-run lock keeps a concurrent filer from opening a second issue", () => {
    allowFiling(); const art = seedArt();
    writeFileSync(join(art, "issue.lock"), "");                        // another filer holds it
    const f = fake();
    const res = fileFinding("flag", RUN(), "[ap:quick] boom", "body\n", f.r);
    expect(res.status).toBe("queued");
    expect(f.gh()).toHaveLength(0);
    expect(queued()).toHaveLength(1);
  });

  it("two filings in the same millisecond produce two queue records", () => {
    seedArt();
    const now = "2026-08-30T10:00:00.000Z";
    queueRecord({ kind: "flag", runId: "r1", command: "quick", topic: "auth", artDir: seedArt(), nFindings: 1, body: "a\n", identity: IDENTITY, now });
    queueRecord({ kind: "flag", runId: "r1", command: "quick", topic: "auth", artDir: seedArt(), nFindings: 1, body: "b\n", identity: IDENTITY, now });
    expect(queued()).toHaveLength(2);
  });

  it("writes one findings.log line per kind, for the autoresearch corpus digest", () => {
    seedArt();
    recordHubFlag({ command: "quick", topic: "auth", note: "one" });
    recordHubFlag({ command: "quick", topic: "auth", note: "two" });
    const lines = readFileSync(join(RUN().artDir, "findings.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith(" flag"))).toBe(true);
  });

  // NOTE: captureSpawnFailure takes no runner (its callers are deep inside `spawn`), so this test
  // MUST stay on the env guard — lifting it here would put a live `gh` on the public tracker.
  it("a spawn failure is its own run, recorded under the WORKER dir", () => {
    const wd = workerDir("lima", "codex", "plan-x"); mkdirSync(wd, { recursive: true });
    const line = captureSpawnFailure({ agent: "lima", model: "codex", topic: "plan-x", reason: "binary_not_found", detail: "no codex on PATH" });
    expect(queued()).toHaveLength(1);
    expect(line).toContain("QUEUED=");
    const rec = readFileSync(join(forensicsQueueDir(), queued()[0]), "utf8");
    expect(rec).toContain(`art_dir: ${wd}`);
    expect(rec).toContain("title: [ap:spawn] binary_not_found");
    expect(existsSync(join(wd, "findings.log"))).toBe(true);
  });

  it("the same slug run twice opens two issues (init resets issue.txt)", () => {
    allowFiling(); const art = seedArt();
    const f = fake();
    fileFinding("flag", RUN(), "[ap:quick] one", "a\n", f.r);
    rmSync(join(art, "issue.txt"), { force: true });                   // what `quick init` does
    fileFinding("flag", RUN(), "[ap:quick] two", "b\n", f.r);
    expect(f.gh().filter((c) => c[2] === "create")).toHaveLength(2);
  });

  it("design then implement on ONE slug are two runs → two issues", () => {
    allowFiling(); seedArt("design", "auth"); seedArt("implement", "auth");
    const f = fake();
    fileFinding("findings", RUN("design", "auth"), "[ap:design] a", "a\n", f.r);
    fileFinding("findings", RUN("implement", "auth"), "[ap:implement] b", "b\n", f.r);
    expect(f.gh().filter((c) => c[2] === "create")).toHaveLength(2);
    expect(existsSync(join(commandArtDir("design", "auth"), "issue.txt"))).toBe(true);
    expect(existsSync(join(commandArtDir("implement", "auth"), "issue.txt"))).toBe(true);
  });

  it("two runs whose run_ids collide in one second stay separate through the queue", () => {
    allowFiling();
    const design = seedArt("design", "auth"), impl = seedArt("implement", "auth");
    const now = "2026-08-30T10:00:00.000Z";                            // one second, two runs
    queueRecord({ kind: "findings", runId: "x-auth-20260830T100000Z", command: "design", topic: "auth", artDir: design,
      nFindings: 1, title: "[ap:design] a", body: "a\n", identity: IDENTITY, now });
    queueRecord({ kind: "findings", runId: "x-auth-20260830T100000Z", command: "implement", topic: "auth", artDir: impl,
      nFindings: 1, title: "[ap:implement] b", body: "b\n", identity: IDENTITY, now });
    const f = fake();
    expect(flushQueue(f.r)).toMatchObject({ filed: 2, remaining: 0 });
    expect(f.gh().filter((c) => c[2] === "create")).toHaveLength(2);   // NOT one create + one comment
  });
});

describe("consent", () => {
  it("absent → CONSENT=needed, the record is queued, and gh is NEVER spawned", () => {
    delete process.env.AP_FORENSICS_BACKEND; seedArt();
    expect(readConsent()).toBe(null);
    const f = fake();
    const res = fileFinding("flag", RUN(), "[ap:quick] boom", "body\n", f.r);
    expect(res.status).toBe("consent");
    expect(res.line).toBe("CONSENT=needed");
    expect(queued()).toHaveLength(1);
    expect(f.gh()).toHaveLength(0);
  });

  it("'no' queues permanently — flush files nothing either", () => {
    delete process.env.AP_FORENSICS_BACKEND; seedArt();
    writeConsent("no");
    expect(readConsent()).toBe("no");
    const f = fake();
    expect(fileFinding("flag", RUN(), "[ap:quick] boom", "body\n", f.r).status).toBe("queued");
    expect(flushQueue(f.r)).toEqual({ filed: 0, remaining: 1, failed: 0 } satisfies FlushResult);
    expect(f.gh()).toHaveLength(0);
  });

  it("'yes' files; the env guard still WINS over it (fail-closed)", () => {
    seedArt(); writeConsent("yes");
    const f = fake();
    process.env.AP_FORENSICS_BACKEND = "queue";
    expect(fileFinding("flag", RUN(), "[ap:quick] boom", "b\n", f.r).status).toBe("queued");
    expect(f.gh()).toHaveLength(0);
    delete process.env.AP_FORENSICS_BACKEND;
    expect(fileFinding("flag", RUN(), "[ap:quick] boom", "b\n", f.r).status).toBe("filed");
  });
});

describe("flushQueue", () => {
  /** One run's create + comment, stamped either side of a UTC midnight. */
  function seedMidnightRun(art: string): void {
    queueRecord({ kind: "flag", runId: "r1", command: "quick", topic: "auth", artDir: art, nFindings: 1,
      title: "[ap:quick] the create", body: "CREATE\n", identity: IDENTITY, now: "2026-08-30T23:59:59.900Z" });
    queueRecord({ kind: "findings", runId: "r1", command: "quick", topic: "auth", artDir: art, nFindings: 1,
      body: "COMMENT\n", identity: IDENTITY, now: "2026-08-31T00:00:00.100Z" });
  }

  it("replays a run create-first then its comments, across a UTC midnight, and empties the queue", () => {
    allowFiling(); const art = seedArt();
    seedMidnightRun(art);
    const f = fake();
    expect(flushQueue(f.r)).toEqual({ filed: 2, remaining: 0, failed: 0 } satisfies FlushResult);
    const order = f.gh().filter((c) => c[2] === "create" || c[2] === "comment").map((c) => c[2]);
    expect(order).toEqual(["create", "comment"]);
    expect(readIssueTxt(art)).toMatchObject({ run_id: "r1", number: "7" });
  });

  it("per-run isolation: one run's failure never blocks another run", () => {
    allowFiling(); const art = seedArt();
    queueRecord({ kind: "flag", runId: "bad", command: "quick", topic: "auth", artDir: art, nFindings: 1,
      title: "[ap:quick] bad", body: "x\n", identity: IDENTITY, now: "2026-08-30T10:00:00.000Z" });
    queueRecord({ kind: "flag", runId: "good", command: "quick", topic: "other", artDir: join(topicDir("other"), "_quick"), nFindings: 1,
      title: "[ap:quick] good", body: "y\n", identity: IDENTITY, now: "2026-08-30T10:00:01.000Z" });
    const f = fake({}, { "[ap:quick] bad": { code: 1, stdout: "" } });
    expect(flushQueue(f.r)).toMatchObject({ filed: 1, remaining: 1, failed: 0 });
  });

  it("a permanently failing record is dead-lettered at 3 attempts and never blocks the flush again", () => {
    allowFiling(); const art = seedArt();
    const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      queueRecord({ kind: "flag", runId: "bad", command: "quick", topic: "auth", artDir: art, nFindings: 1,
        title: "[ap:quick] bad", body: "x\n", identity: IDENTITY, now: "2026-08-30T10:00:00.000Z" });
      const f = fake({ create: { code: 1, stdout: "" } });
      flushQueue(f.r); flushQueue(f.r);
      expect(queued()).toHaveLength(1);
      expect(flushQueue(f.r)).toMatchObject({ filed: 0, failed: 1, remaining: 0 });
      expect(readdirSync(forensicsQueueDir()).some((n) => n.endsWith(".failed"))).toBe(true);
      expect(err.mock.calls.map(String).join("")).toContain("dead-lettered");
    } finally { err.mockRestore(); }
  });

  it("is bounded: an exhausted budget stops the drain and reports what is left", () => {
    allowFiling(); const art = seedArt();
    seedMidnightRun(art);
    const f = fake();
    expect(flushQueue(f.r, { maxMs: -1 })).toEqual({ filed: 0, remaining: 2, failed: 0 } satisfies FlushResult);
    expect(f.gh().filter((c) => c[2] === "create")).toHaveLength(0);
  });

  it("a successful filing drains what the offline stretch left behind", () => {
    allowFiling(); const art = seedArt();
    queueRecord({ kind: "flag", runId: "old", command: "quick", topic: "other", artDir: join(topicDir("other"), "_quick"),
      nFindings: 1, title: "[ap:quick] older run", body: "old\n", identity: IDENTITY, now: "2026-08-30T09:00:00.000Z" });
    const f = fake();
    expect(fileFinding("flag", { command: "quick", topic: "auth", artDir: art }, "[ap:quick] now", "new\n", f.r).status).toBe("filed");
    expect(f.gh().filter((c) => c[2] === "create").map((c) => c[c.indexOf("--title") + 1]).sort())
      .toEqual(["[ap:quick] now", "[ap:quick] older run"]);
    expect(queued()).toHaveLength(0);
  });
});

describe("scrubSecrets", () => {
  const cases: Array<[string, string]> = [
    ["token ghs_" + "A".repeat(30), "token <redacted>"],
    ["ghp_" + "b".repeat(36), "<redacted>"],
    ["github_pat_" + "c".repeat(40), "<redacted>"],
    ["sk-" + "d".repeat(32), "<redacted>"],
    ["AKIA" + "E".repeat(16), "<redacted>"],
    ["Authorization: Bearer abc.def.ghi", "Authorization: Bearer <redacted>"],
    ["password=hunter2", "password=<redacted>"],
    ["api_key: swordfish", "api_key: <redacted>"],
    ["https://user:pw@example.com/x", "https://<redacted>@example.com/x"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "<redacted>"],
  ];
  for (const [raw, want] of cases) {
    it(`redacts: ${raw.slice(0, 28).replace(/\n/g, " ")}`, () => {
      expect(scrubSecrets(raw)).toBe(want);
    });
  }
  it("leaves ordinary run prose alone (paths, hosts, topics post verbatim)", () => {
    const s = "/home/u/repo/src/core/forensics.ts on box-7 for topic add-oauth";
    expect(scrubSecrets(s)).toBe(s);
  });
  it("a credential in the finding text never reaches the posted body or title", () => {
    allowFiling(); seedArt();
    const f = fake();
    fileFinding("flag", RUN(), issueTitle("quick", "leaked ghp_" + "z".repeat(36)), "body ghp_" + "z".repeat(36) + "\n", f.r);
    const create = f.gh().find((c) => c[2] === "create")!;
    expect(create.join(" ")).not.toContain("ghp_");
    expect(create.join(" ")).toContain("<redacted>");
  });
});

describe("issueTitle + runIdentity", () => {
  it("normalizes the volatile half so two boxes produce ONE title", () => {
    const a = issueTitle("quick", "worker /tmp/run-1 died at 2026-08-30T10:00:00Z after 12 turns");
    const b = issueTitle("quick", "worker /tmp/run-9 died at 2026-08-31T23:11:02Z after 44 turns");
    expect(a).toBe(b);
    expect(a.startsWith("[ap:quick] ")).toBe(true);
  });
  it("caps the title at 80 characters of finding text", () => {
    const t = issueTitle("design", "x".repeat(200));
    expect(t.length).toBe("[ap:design] ".length + 80);
  });
  it("reports host, user, platform, node, the run's providers and the origin with userinfo stripped", () => {
    seedArt();
    mkdirSync(join(topicDir("auth"), "alpha-codex"), { recursive: true });
    const r: ForensicsRunner = { run: () => ({ code: 0, stdout: "https://u:pw@github.com/o/r.git\n", stderr: "" }) };
    const id = runIdentity(RUN(), r);
    expect(id.host).toBe(hostname());
    expect(id.platform).toBe(process.platform);
    expect(id.node).toBe(process.version);
    expect(id.providers).toBe("alpha:codex");
    expect(id.repo).toBe("https://<redacted>@github.com/o/r.git");
    expect(id.user).toBeTruthy();
  });
  it("falls back to the repo hash when there is no origin", () => {
    seedArt();
    const id = runIdentity(RUN(), { run: () => ({ code: 1, stdout: "", stderr: "" }) });
    expect(id.repo).toMatch(/^[0-9a-f]{64}$/);
  });
  it("the created body carries the identity block", () => {
    allowFiling(); seedArt();
    mkdirSync(join(topicDir("auth"), "alpha-codex"), { recursive: true });
    const f = fake();
    fileFinding("findings", RUN(), "[ap:quick] boom", "- **outbox** boom _(source: worker=alpha-codex)_\n", f.r);
    const body = f.gh().find((c) => c[2] === "create")![8];
    for (const row of ["| ap version |", "| command | quick |", "| topic |", "| run id |", "| host / user |",
      "| platform |", "| providers | alpha:codex |", "| repo |", "| art dir |", "| filed at |"]) {
      expect(body).toContain(row);
    }
    expect(body).toContain("### Mechanical findings");
  });
});

describe("reflect", () => {
  function reflectionFile(text: string): string {
    const p = join(h.home, "reflection.md");
    writeFileSync(p, text);
    return p;
  }

  it("with no run issue: prints NO_RUN_ISSUE, rc 0", () => {
    seedArt();
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
    try { expect(runReflect("quick", "auth", "@" + reflectionFile("notes"))).toBe(0); } finally { spy.mockRestore(); }
    expect(out.join("")).toContain("NO_RUN_ISSUE");
  });

  it("posts once, then refuses the second reflect for that run with rc 1", () => {
    const art = seedArt();
    writeFileSync(join(art, "issue.txt"), "run_id=r1\nnumber=7\nurl=u\n");
    expect(runReflect("quick", "auth", "@" + reflectionFile("what I would try first"))).toBe(0);
    expect(readIssueTxt(art)).toMatchObject({ reflected: true });
    expect(queued().some((n) => n.includes("-reflection-"))).toBe(true);
    expect(runReflect("quick", "auth", "@" + reflectionFile("again"))).toBe(1);
  });

  it("a fresh run on the same slug reflects again (the reflected flag is per run)", () => {
    const design = seedArt("design", "auth"); const impl = seedArt("implement", "auth");
    writeFileSync(join(design, "issue.txt"), "run_id=d1\nnumber=7\nreflected=1\n");
    writeFileSync(join(impl, "issue.txt"), "run_id=i1\nnumber=8\n");
    expect(runReflect("design", "auth", "@" + reflectionFile("x"))).toBe(1);
    expect(runReflect("implement", "auth", "@" + reflectionFile("x"))).toBe(0);
  });

  it("rc 2 on a missing topic, a missing file arg, or an unreadable file", () => {
    seedArt();
    expect(runReflect("quick", undefined, "@x")).toBe(2);
    expect(runReflect("quick", "auth", undefined)).toBe(2);
    expect(runReflect("quick", "auth", "@" + join(h.home, "nope.md"))).toBe(2);
  });
});
