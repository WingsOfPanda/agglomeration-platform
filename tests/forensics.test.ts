import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readFileSync as rfs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as F from "../src/core/forensics.js";
import { scrapeAuditLog, scrapeOutbox, scrapeStatus, scrapeSpawnResults, scrapeLogs, scrapeArtDir, renderArtForensics, captureArtDir } from "../src/core/forensics.js";
import { workerDir } from "../src/core/paths.js";

afterEach(() => { delete process.env.AP_HOME; });
function home() { const h = mkdtempSync(join(tmpdir(), "fx-")); process.env.AP_HOME = h; return h; }
const deps = (scroll = "") => ({
  workerDir,
  capturePane: async () => scroll,
  atomicWriteSync: (d: string, c: string) => writeFileSync(d, c),
  isWritableDir: (d: string) => existsSync(d),
  now: () => "2026-05-21T10:00:00Z",
});

describe("forensics", () => {
  it("timeout, no event_line → file with sentinel", async () => {
    home(); mkdirSync(workerDir("bravo", "codex", "demo"), { recursive: true });
    const r = await F.captureFailure({ agent: "bravo", model: "codex", topic: "demo", paneId: "%999", reason: "timeout" }, deps("line A\nline B"));
    expect(r.ok).toBe(true);
    const txt = readFileSync(join(workerDir("bravo", "codex", "demo"), "failure-reason.txt"), "utf8");
    expect(txt).toContain("# Spawn bootstrap failure");
    expect(txt).toContain("fail_reason:   timeout");
    expect(txt).toContain("ready_timeout: unknown");
    expect(txt).toContain("## Pane scrollback (last 50 lines, captured BEFORE pane kill)");
    expect(txt).toContain("no error event before timeout");
    expect(txt).toContain("line A\nline B");
  });
  it("error_event with event_line stored verbatim", async () => {
    home(); mkdirSync(workerDir("bravo", "codex", "demo"), { recursive: true });
    const evt = '{"event":"error","reason":"codex_bootstrap_failed","ts":"2026-05-21T10:00:00Z"}';
    const r = await F.captureFailure({ agent: "bravo", model: "codex", topic: "demo", paneId: "%9", reason: "error_event", eventLine: evt }, deps());
    expect(r.ok).toBe(true);
    const txt = readFileSync(join(workerDir("bravo", "codex", "demo"), "failure-reason.txt"), "utf8");
    expect(txt).toContain("fail_reason:   error_event");
    expect(txt).toContain(evt);
  });
  it("missing/unwritable dir → code 1, no file", async () => {
    home();
    const r = await F.captureFailure({ agent: "ghost", model: "codex", topic: "demo", paneId: "%1", reason: "timeout" }, deps());
    expect(r).toEqual({ ok: false, code: 1 });
  });
  it("invalid reason → code 2", async () => {
    home(); mkdirSync(workerDir("bravo", "codex", "demo"), { recursive: true });
    const r = await F.captureFailure({ agent: "bravo", model: "codex", topic: "demo", paneId: "%1", reason: "kaboom" as any }, deps());
    expect(r).toEqual({ ok: false, code: 2 });
  });
});

describe("forensics scrapers", () => {
  it("audit.log → ^ISSUE= lines", () => {
    expect(scrapeAuditLog("VERDICT=FAIL\nISSUE=no_goal_section\nISSUE=tbd_marker\n"))
      .toEqual([{ source: "audit_log", key: "ISSUE=no_goal_section", context: "audit.log" },
                { source: "audit_log", key: "ISSUE=tbd_marker", context: "audit.log" }]);
  });
  it("outbox → error/question events via JSON.parse, labelled by worker; skips non-JSON + done", () => {
    const ob = '{"event":"done","summary":"ok"}\nnot json\n{"event":"error","reason":"boom"}\n{"event":"question","message":"?"}\n';
    const f = scrapeOutbox(ob, "alpha");
    expect(f.map((x) => x.source)).toEqual(["outbox", "outbox"]);
    expect(f.every((x) => x.context === "worker=alpha")).toBe(true);
    expect(f[0].key).toContain('"event":"error"');
  });
  it("scrapeOutbox captures FLAG:-prefixed notes as part_note, ignores routine notes", () => {
    const lines = [
      '{"event":"progress","note":"50% done"}',
      '{"event":"progress","note":"FLAG: the harness skipped 3 cases"}',
      '{"event":"done","summary":"ok","note":"FLAG: leftover temp file"}',
      '{"event":"error","message":"boom"}',
      '{"event":"question","message":"which?"}',
    ].join("\n");
    const f = scrapeOutbox(lines, "bravo");
    expect(f.filter((x) => x.source === "part_note").map((x) => x.key)).toEqual([
      "the harness skipped 3 cases",
      "leftover temp file",
    ]);
    expect(f.filter((x) => x.source === "outbox").length).toBe(2); // error + question unchanged
    expect(f).toHaveLength(4);
  });
  it("scrapeOutbox FLAG: marker is case-insensitive and tolerates leading space", () => {
    const f = scrapeOutbox('{"event":"progress","note":"  flag: lowercase works"}', "golf");
    expect(f).toEqual([{ source: "part_note", key: "lowercase works", context: "worker=golf" }]);
  });
  it("status.json state=error; spawn-results rc!=0; logs [error]/log_error", () => {
    expect(scrapeStatus('{"state":"error","updated":"x"}', "charlie")).toEqual([{ source: "status", key: "state=error", context: "worker=charlie" }]);
    expect(scrapeStatus('{"state":"ready"}', "charlie")).toEqual([]);
    expect(scrapeSpawnResults("alpha\tcodex\t0\t\ncharlie\tclaude\t1\tspawn-failed\n").map((x) => x.context)).toEqual(["worker=charlie"]);
    expect(scrapeLogs("all good\n[error] boom\nplain\n", "dispatch.log").length).toBe(1);
  });
});

describe("scrapeArtDir + render", () => {
  it("collects findings across the art dir + sibling worker dirs, deduped", () => {
    const topicDir = mkdtempSync(join(tmpdir(), "fz-"));
    const art = join(topicDir, "_design"); mkdirSync(join(art, "design-doc"), { recursive: true });
    writeFileSync(join(art, "design-doc", "audit.log"), "VERDICT=FAIL\nISSUE=no_goal_section\n");
    writeFileSync(join(art, "spawn-results.tsv"), "alpha\tcodex\t1\tspawn-failed\n");
    const worker = join(topicDir, "alpha-codex"); mkdirSync(worker, { recursive: true });
    writeFileSync(join(worker, "outbox.jsonl"), '{"event":"error","reason":"x"}\n');
    writeFileSync(join(worker, "status.json"), '{"state":"error"}');
    const f = scrapeArtDir(art);
    expect(f.some((x) => x.source === "audit_log")).toBe(true);
    expect(f.some((x) => x.source === "outbox" && x.context === "worker=alpha-codex")).toBe(true);
    expect(f.some((x) => x.source === "status")).toBe(true);
    expect(f.some((x) => x.source === "spawn_results")).toBe(true);
  });
  it("render emits frontmatter + bullets", () => {
    const md = renderArtForensics({ command: "design", topicSlug: "t", repoHash: "abc", artDir: "/a", invokedAt: "2026-05-29T00:00:00Z" },
      [{ source: "audit_log", key: "ISSUE=no_goal_section", context: "audit.log" }]);
    expect(md).toContain("command: design");
    expect(md).toContain("n_findings_mechanical: 1");
    expect(md).toContain("## Mechanical findings");
    expect(md).toContain("- **audit_log** ISSUE=no_goal_section _(source: audit.log)_");
  });
});

describe("captureArtDir", () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.AP_HOME; });
  afterEach(() => { if (prev === undefined) delete process.env.AP_HOME; else process.env.AP_HOME = prev; });

  it("zero findings → '' and no file", () => {
    const home = mkdtempSync(join(tmpdir(), "fh-")); process.env.AP_HOME = home;
    const art = join(mkdtempSync(join(tmpdir(), "fa-")), "clean", "_design"); mkdirSync(art, { recursive: true });
    expect(captureArtDir({ artDir: art, command: "design", now: new Date("2026-05-29T12:00:00Z") })).toBe("");
  });
  it("findings → writes under <home>/forensics/<date>/, returns the path", () => {
    const home = mkdtempSync(join(tmpdir(), "fh-")); process.env.AP_HOME = home;
    const topicDir = join(mkdtempSync(join(tmpdir(), "ft-")), "mytopic"); const art = join(topicDir, "_design");
    mkdirSync(join(art, "design-doc"), { recursive: true });
    writeFileSync(join(art, "design-doc", "audit.log"), "ISSUE=no_goal_section\n");
    const p = captureArtDir({ artDir: art, command: "design", now: new Date("2026-05-29T12:34:56Z") });
    expect(p).toContain(join(home, "forensics", "2026-05-29"));
    expect(p).toMatch(/12-34-56-design-mytopic\.md$/);
    expect(existsSync(p)).toBe(true);
    expect(rfs(p, "utf8")).toContain("ISSUE=no_goal_section");
  });
  it("two captures in the same UTC second do not overwrite (suffix -2)", () => {
    const home = mkdtempSync(join(tmpdir(), "fh-")); process.env.AP_HOME = home;
    const art = join(mkdtempSync(join(tmpdir(), "ft-")), "mytopic", "_design");
    mkdirSync(join(art, "design-doc"), { recursive: true });
    writeFileSync(join(art, "design-doc", "audit.log"), "ISSUE=no_goal_section\n");
    const now = new Date("2026-05-29T12:34:56Z");
    const p1 = captureArtDir({ artDir: art, command: "design", now });
    const p2 = captureArtDir({ artDir: art, command: "design", now });
    expect(p1).not.toBe(p2);
    expect(existsSync(p1)).toBe(true);
    expect(existsSync(p2)).toBe(true);
    expect(p2).toMatch(/12-34-56-design-mytopic-2\.md$/);
  });
});
