import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, readFileSync as rfs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import * as F from "../src/core/forensics.js";
import { scrapeOutbox, scrapeArtDir, captureArtDir } from "../src/core/forensics.js";
import { workerDir, forensicsQueueDir } from "../src/core/paths.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h.home; }
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
    const r = await F.captureFailure({ agent: "bravo", model: "codex", topic: "demo", paneId: "%1", reason: "kaboom" as never }, deps());
    expect(r).toEqual({ ok: false, code: 2 });
  });
});

describe("forensics scrapers", () => {
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
});

describe("scrapeArtDir", () => {
  it("collects findings from the sibling worker dirs, deduped", () => {
    const td = mkdtempSync(join(tmpdir(), "fz-"));
    const art = join(td, "_design"); mkdirSync(art, { recursive: true });
    const worker = join(td, "alpha-codex"); mkdirSync(worker, { recursive: true });
    writeFileSync(join(worker, "outbox.jsonl"), '{"event":"error","reason":"x"}\n{"event":"error","reason":"x"}\n');
    const f = scrapeArtDir(art);
    expect(f).toHaveLength(1);                                    // the duplicate line collapses
    expect(f[0]).toMatchObject({ source: "outbox", context: "worker=alpha-codex" });
  });
});

/** Every queue record written under the current AP_HOME. */
function queued(): string[] {
  const dir = forensicsQueueDir();
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : [];
}

describe("captureArtDir", () => {
  /** A topic dir whose one worker recorded an error event. */
  function seed(): string {
    const td = join(mkdtempSync(join(tmpdir(), "ft-")), "mytopic");
    const art = join(td, "_design"); mkdirSync(art, { recursive: true });
    const w = join(td, "alpha-codex"); mkdirSync(w, { recursive: true });
    writeFileSync(join(w, "outbox.jsonl"), '{"event":"error","reason":"boom"}\n');
    return art;
  }

  it("zero findings → '' and nothing queued", () => {
    home();
    const art = join(mkdtempSync(join(tmpdir(), "fa-")), "clean", "_design"); mkdirSync(art, { recursive: true });
    expect(captureArtDir({ artDir: art, command: "design" })).toBe("");
    expect(queued()).toHaveLength(0);
  });
  it("findings → one queue record under <home>/forensics/queue/, returns the QUEUED= line", () => {
    home();
    const art = seed();
    const line = captureArtDir({ artDir: art, command: "design" });
    const files = queued();
    expect(files).toHaveLength(1);
    expect(line).toBe(`QUEUED=${files[0]}`);
    const md = rfs(files[0], "utf8");
    expect(md).toContain("command: design");
    expect(md).toContain("topic_slug: mytopic");
    expect(md).toContain("title: [ap:design] ");
    expect(md).toContain("boom");
  });
  it("two captures for one run → two queue records (no name collision)", () => {
    home();
    const art = seed();
    captureArtDir({ artDir: art, command: "design" });
    captureArtDir({ artDir: art, command: "design" });
    expect(queued()).toHaveLength(2);
  });
});
