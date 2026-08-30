// tests/review-cmd.test.ts — the /ap:review verbs over a FAKE gh runner. No test may reach live
// `gh`: every verb takes an injectable runner, and the paths that use the default one (usage
// errors, flush) are kept off `gh` by the env guard in tests/helpers/setupEnv.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { captureStdout } from "./helpers/captureStdout.js";
import { surveyWith, archiveWith, flushWith, run } from "../src/commands/review.js";
import { AP_ISSUES_REPO, readConsent, writeConsent } from "../src/core/forensics.js";
import type { ForensicsRunner } from "../src/core/forensics.js";

type Reply = { code?: number; stdout?: string; stderr?: string };
function fake(reply: (cmd: string, args: string[]) => Reply | void = () => ({})) {
  const calls: string[][] = [];
  const runner: ForensicsRunner = {
    run(cmd, args) {
      calls.push([cmd, ...args]);
      const r = reply(cmd, args) ?? {};
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
  return { runner, calls };
}

type Cmt = { body: string; createdAt: string };
const apc = (at: string, body = "detail"): Cmt => ({ body: `<!-- ap-forensics run=r kind=findings -->\n${body}`, createdAt: at });
const mark = (at: string): Cmt => ({ body: `<!-- ap-triaged at=${at} -->\ntriaged by /ap:review`, createdAt: at });
const at = (day: string) => `2026-08-${day}T00:00:00Z`;

interface FakeIssue { number: number; title: string; createdAt: string; labels?: { name: string }[]; comments?: Cmt[]; url?: string }
const issue = (o: Partial<FakeIssue> & { number: number; title: string; createdAt: string }): FakeIssue =>
  ({ labels: [], comments: [], url: `https://github.com/${AP_ISSUES_REPO}/issues/${o.number}`, ...o });

/** A runner whose `gh issue list` returns this issue set. */
const lister = (issues: FakeIssue[]) => fake((_c, a) => (a[0] === "issue" && a[1] === "list" ? { stdout: JSON.stringify(issues) } : {}));

function seedQueue(home: string, name = "20260830T000000.000Z-r1-flag-9999abcd.md"): void {
  const dir = join(home, "forensics", "queue");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "---\nrun_id: r1\nkind: flag\ncommand: quick\nart_dir: /nonexistent\nattempts: 0\n---\n\nbody\n");
}

describe("review survey", () => {
  let h: { home: string; cleanup: () => void };
  let out: ReturnType<typeof captureStdout>;
  beforeEach(() => { h = freshHome(); out = captureStdout(); });
  afterEach(() => { out.restore(); h.cleanup(); });

  // #1 untriaged, #2 triaged (label + marker, nothing newer), #3 triaged-but-RECURRED.
  const corpus = [
    issue({ number: 1, title: "[ap:quick] spawn rc=124 at /a/b", createdAt: at("01"), comments: [apc(at("02"))] }),
    issue({ number: 2, title: "[ap:quick] spawn rc=137 at /c/d", createdAt: at("03"), labels: [{ name: "triaged" }], comments: [mark(at("04"))] }),
    issue({ number: 3, title: "[ap:design] doc missing", createdAt: at("01"), labels: [{ name: "triaged" }], comments: [mark(at("02")), apc(at("05"))] }),
  ];

  it("TSV rows for the untriaged issues (a recurrence re-opens a triaged one) + TRENDS clusters", async () => {
    const { runner } = lister(corpus);
    expect(await surveyWith({ runner })).toBe(0);
    const lines = out.text().trim().split("\n");
    const rows = lines.slice(0, lines.indexOf("TRENDS"));
    expect(rows).toEqual([
      `1\t[ap:quick] spawn rc=124 at /a/b\t1\t${at("02")}\thttps://github.com/${AP_ISSUES_REPO}/issues/1`,
      `3\t[ap:design] doc missing\t2\t${at("05")}\thttps://github.com/${AP_ISSUES_REPO}/issues/3`,
    ]);
    // The two quick issues normalize to one title -> one TRENDS row; last = the newest event in it.
    expect(lines[lines.indexOf("TRENDS") + 1]).toBe(`[ap:quick] spawn rc=<n> at <path>\t2\t0\t${at("01")}\t${at("03")}`);
  });

  it("issues the one spec'd `gh issue list` argv", async () => {
    const { runner, calls } = lister([]);
    await surveyWith({ runner });
    expect(calls).toEqual([[
      "gh", "issue", "list", "--repo", AP_ISSUES_REPO, "--state", "open",
      "--search", 'in:title "[ap:"',
      "--json", "number,title,createdAt,labels,comments,url", "--limit", "200",
    ]]);
  });

  it("--command filters by title prefix (rows and trends)", async () => {
    const { runner } = lister(corpus);
    await surveyWith({ runner, command: "design" });
    const t = out.text();
    expect(t).toContain("3\t[ap:design] doc missing");
    expect(t).not.toContain("[ap:quick]");
  });

  it("--since drops issues whose last event is older than the cutoff", async () => {
    const now = Date.parse(at("10"));
    const { runner } = lister([
      issue({ number: 4, title: "[ap:quick] stale", createdAt: at("01"), comments: [apc(at("02"))] }),
      issue({ number: 5, title: "[ap:quick] fresh", createdAt: at("01"), comments: [apc(at("09"))] }),
    ]);
    await surveyWith({ runner, since: "2d", now });
    const t = out.text();
    expect(t).toContain("5\t[ap:quick] fresh");
    expect(t).not.toContain("[ap:quick] stale");
  });

  it("a bad --since is rc 2 before any gh call", async () => {
    const { runner, calls } = lister([]);
    expect(await surveyWith({ runner, since: "2w" })).toBe(2);
    expect(calls).toEqual([]);
  });

  it("--all is rejected (rc 2) — issues are open or triaged, not archived files", async () => {
    expect(await run(["survey", "--all"])).toBe(2);
  });

  it("a failing gh issue list is rc 1, not a crash", async () => {
    const { runner } = fake(() => ({ code: 1, stderr: "gh: not authenticated" }));
    expect(await surveyWith({ runner })).toBe(1);
  });

  it("reports QUEUE=<remaining> for records the bounded flush could not drain", async () => {
    seedQueue(h.home);
    const { runner, calls } = lister([]);
    await surveyWith({ runner });
    expect(out.text()).toContain("QUEUE=1");
    expect(calls).toHaveLength(1);                          // the list only: nothing was filed
  });

  it("prints CONSENT=needed until this box has answered", async () => {
    const { runner } = lister([]);
    await surveyWith({ runner });
    expect(out.text()).toContain("CONSENT=needed");
    writeConsent("yes");
    const after = captureStdout();
    await surveyWith({ runner });
    expect(after.text()).not.toContain("CONSENT=needed");
    after.restore();
  });
});

describe("review archive", () => {
  let h: { home: string; cleanup: () => void };
  beforeEach(() => { h = freshHome(); });
  afterEach(() => h.cleanup());

  it("creates the label once, then labels each issue", async () => {
    const { runner, calls } = fake();
    expect(await archiveWith(["7", "9"], { runner })).toBe(0);
    expect(calls).toEqual([
      ["gh", "label", "create", "triaged", "--repo", AP_ISSUES_REPO, "--description", "triaged by /ap:review"],
      ["gh", "issue", "edit", "7", "--repo", AP_ISSUES_REPO, "--add-label", "triaged"],
      ["gh", "issue", "edit", "9", "--repo", AP_ISSUES_REPO, "--add-label", "triaged"],
    ]);
  });

  it("falls back to the marker comment when this account cannot label", async () => {
    const { runner, calls } = fake((_c, a) => (a[1] === "edit" ? { code: 1, stderr: "not a collaborator" } : {}));
    expect(await archiveWith(["7"], { runner, now: new Date("2026-08-30T12:00:00Z") })).toBe(0);
    const comment = calls.find((c) => c[1] === "issue" && c[2] === "comment");
    expect(comment?.slice(0, 7)).toEqual(["gh", "issue", "comment", "7", "--repo", AP_ISSUES_REPO, "--body"]);
    expect(comment?.[7]).toBe("<!-- ap-triaged at=2026-08-30T12:00:00Z -->\ntriaged by /ap:review");
  });

  it("rc 1 when neither the label nor the comment lands", async () => {
    const { runner } = fake(() => ({ code: 1 }));
    expect(await archiveWith(["7"], { runner })).toBe(1);
  });

  it("rc 2 on no numbers / a non-numeric argument", async () => {
    expect(await run(["archive"])).toBe(2);
    expect(await run(["archive", "/x/y.md"])).toBe(2);
  });

  it("every gh argv carries --repo <the tracker>", async () => {
    const { runner: r1, calls: c1 } = lister([issue({ number: 1, title: "[ap:quick] x", createdAt: at("01") })]);
    const out = captureStdout();
    await surveyWith({ runner: r1 });
    out.restore();
    const { runner: r2, calls: c2 } = fake((_c, a) => (a[1] === "edit" ? { code: 1 } : {}));
    await archiveWith(["1"], { runner: r2 });
    const calls = [...c1, ...c2];
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) expect(c[c.indexOf("--repo") + 1]).toBe(AP_ISSUES_REPO);
  });
});

describe("review flush / consent", () => {
  let h: { home: string; cleanup: () => void };
  let out: ReturnType<typeof captureStdout>;
  beforeEach(() => { h = freshHome(); out = captureStdout(); });
  afterEach(() => { out.restore(); h.cleanup(); });

  it("flush reports what it filed and what is still queued", async () => {
    seedQueue(h.home);
    const { runner, calls } = fake();
    expect(await flushWith(runner)).toBe(0);
    expect(out.text()).toBe("FILED=0\nQUEUE=1\n");           // env guard: queued, never filed
    expect(calls).toEqual([]);
  });

  it("flush on an empty queue is rc 0 with zeroes", async () => {
    expect(await flushWith(fake().runner)).toBe(0);
    expect(out.text()).toBe("FILED=0\nQUEUE=0\n");
  });

  it("consent yes|no writes the per-box answer", async () => {
    expect(await run(["consent", "yes"])).toBe(0);
    expect(readConsent()).toBe("yes");
    expect(out.text()).toContain("CONSENT=yes");
    expect(await run(["consent", "no"])).toBe(0);
    expect(readConsent()).toBe("no");
  });

  it("consent with anything else is a usage error", async () => {
    expect(await run(["consent", "maybe"])).toBe(2);
    expect(await run(["consent"])).toBe(2);
    expect(readConsent()).toBeNull();
  });

  it("an unknown verb is a usage error", async () => {
    expect(await run(["nope"])).toBe(2);
  });
});
