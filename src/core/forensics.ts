import { readFileSync, readdirSync, mkdirSync, existsSync, openSync, closeSync, rmSync, renameSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { globalRoot, repoHash, workerDir, topicDir, forensicsQueueDir, issuesConsentPath, pluginRoot } from "./paths.js";
import { assertSlug } from "./slug.js";
import { atomicWrite } from "./atomic.js";
import { isoUtc } from "./archive.js";
import { log } from "./log.js";
import { parseEvent } from "./ipc.js";
import { normalizeVolatile } from "./review.js";

/** Why a spawn never reached `ready`. `timeout`/`error_event` are the two the ready-wait itself
 *  can reach; `killed` is the spawn PROCESS being SIGTERMed mid-wait (the caller's own deadline
 *  firing first), and `pane_dead` is the worker's pane dying during bootstrap, caught by the
 *  wait's liveness probe instead of at the full deadline. */
export type FailureReason = "timeout" | "error_event" | "killed" | "pane_dead";
const FAILURE_REASONS: ReadonlySet<string> = new Set<FailureReason>(["timeout", "error_event", "killed", "pane_dead"]);
export const SCROLLBACK_LINES = 50;
export const NO_EVENT_SENTINEL = "no error event before timeout";
export const FAILURE_FILENAME = "failure-reason.txt";

/** The one tracker every `gh issue`/`gh label` invocation targets. `gh` otherwise infers the repo
 *  from the CALLER's checkout, which would file a teammate's run into their own project. */
export const AP_ISSUES_REPO = "WingsOfPanda/agglomeration-platform";

export interface CaptureFailureInput {
  agent: string; model: string; topic: string; paneId: string;
  reason: FailureReason; eventLine?: string; readyTimeout?: string | number;
}
export type CaptureFailureResult = { ok: true; path: string } | { ok: false; code: 1 | 2 };

export interface ForensicsDeps {
  workerDir(i: string, m: string, t: string): string;
  capturePane(paneId: string, lines: number): Promise<string>;
  atomicWriteSync(dest: string, content: string): void;
  isWritableDir(dir: string): boolean;
  now?: () => string;
}

export function renderFailureReport(f: {
  timestamp: string; agent: string; model: string; topic: string;
  paneId: string; reason: FailureReason; readyTimeout: string; scrollback: string; eventLine?: string;
}): string {
  const meta =
    `timestamp:     ${f.timestamp}\n` +
    `agent:    ${f.agent}\n` +
    `model:         ${f.model}\n` +
    `topic:         ${f.topic}\n` +
    `pane_id:       ${f.paneId}\n` +
    `fail_reason:   ${f.reason}\n` +
    `ready_timeout: ${f.readyTimeout}\n`;
  // An eventLine is supplied only when an event actually arrived (the ready-wait passes it for
  // `error_event` and for the synthetic `pane_dead` error, and never for `timeout`/`killed`), so
  // keying off its presence rather than off one reason name is behavior-identical for the two
  // original reasons and lets `pane_dead` carry its event instead of the no-event sentinel.
  const evt = f.eventLine ? f.eventLine : NO_EVENT_SENTINEL;
  return `# Spawn bootstrap failure\n${meta}\n` +
    `## Pane scrollback (last 50 lines, captured BEFORE pane kill)\n${f.scrollback}\n\n` +
    `## Event context\n${evt}\n`;
}

export async function captureFailure(input: CaptureFailureInput, deps: ForensicsDeps): Promise<CaptureFailureResult> {
  if (!input.agent || !input.model || !input.topic) return { ok: false, code: 1 };
  if (!FAILURE_REASONS.has(input.reason)) return { ok: false, code: 2 };
  const dir = deps.workerDir(input.agent, input.model, input.topic);
  if (!deps.isWritableDir(dir)) return { ok: false, code: 1 };
  const scrollback = await deps.capturePane(input.paneId, SCROLLBACK_LINES).catch(() => "");
  const dest = `${dir}/${FAILURE_FILENAME}`;
  const doc = renderFailureReport({
    timestamp: (deps.now ?? (() => isoUtc()))(),
    agent: input.agent, model: input.model, topic: input.topic,
    paneId: input.paneId, reason: input.reason,
    readyTimeout: input.readyTimeout == null ? "unknown" : String(input.readyTimeout),
    scrollback, eventLine: input.eventLine,
  });
  deps.atomicWriteSync(dest, doc);
  return { ok: true, path: dest };
}

export interface Finding { source: string; key: string; context: string; }

/** outbox.jsonl: JSON.parse each line (skip non-JSON). Keep event error|question (source=outbox);
 *  also keep any event whose `note` is FLAG:-prefixed (source=part_note, FLAG: stripped). */
export function scrapeOutbox(text: string, worker: string): Finding[] {
  const out: Finding[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    const o = parseEvent(l);
    if (!o) continue;
    if (o.event === "error" || o.event === "question") out.push({ source: "outbox", key: l.trim(), context: `worker=${worker}` });
    else if (typeof o.note === "string" && /^\s*FLAG:/i.test(o.note)) out.push({ source: "part_note", key: o.note.replace(/^\s*FLAG:\s*/i, "").trim(), context: `worker=${worker}` });
  }
  return out;
}

/** Best-effort walk of an art dir's sibling worker dirs → deduped Finding[]. Each read is
 *  individually guarded; any failure contributes nothing (never throws). Worker label = the worker
 *  dir's basename. */
export function scrapeArtDir(artDir: string): Finding[] {
  const out: Finding[] = [];
  const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  // sibling worker dirs live under the TOPIC dir (parent of _design): <topic>/<inst>-<model>/
  try {
    for (const d of readdirSync(dirname(artDir), { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith("_") || d.name.startsWith(".")) continue;
      const ob = read(join(dirname(artDir), d.name, "outbox.jsonl")); if (ob !== null) out.push(...scrapeOutbox(ob, d.name));
    }
  } catch { /* */ }
  const seen = new Set<string>();
  return out.filter((f) => { const k = `${f.source}|${f.key}|${f.context}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The `- **<source>** <key> _(source: <context>)_` bullet block — review.parseMechanicalFindings is
 *  its exact inverse, and the posted issue body carries it verbatim. */
export function renderFindingBullets(findings: Finding[]): string {
  return findings.map((f) => `- **${f.source}** ${f.key} _(source: ${f.context})_`).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The `gh` boundary
// ---------------------------------------------------------------------------

export interface ForensicsRunResult { code: number; stdout: string; stderr: string }
export interface ForensicsRunner { run(cmd: string, args: string[]): ForensicsRunResult }

/** The per-call ceiling every real forensics subprocess runs under; flushQueue budgets against it. */
export const CALL_TIMEOUT_MS = 15_000;

/** Forensics' OWN runner: time-boxed (a hung `gh` must never hold a run open) and cwd-free (every
 *  call carries `--repo`). A timeout surfaces as `{ code: 1 }` — execFileSync's ETIMEDOUT error has
 *  no `status`. Never the cwd-bound gitwork Runner: that one has no timeout slot. */
export function forensicsRunner(): ForensicsRunner {
  return {
    run(cmd, args) {
      // The env guard is fail-closed at the ONE boundary that can reach the live tracker, so every
      // caller (fileFinding, flushQueue, review survey/archive) is covered, now and later. `git`
      // still runs: runIdentity needs it, and it touches nothing remote.
      if (cmd === "gh" && process.env.AP_FORENSICS_BACKEND === "queue") {
        return { code: 1, stdout: "", stderr: "AP_FORENSICS_BACKEND=queue: refusing to spawn gh" };
      }
      try {
        const stdout = execFileSync(cmd, args, { encoding: "utf8", timeout: CALL_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, stdout, stderr: "" };
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
        return {
          code: typeof err.status === "number" ? err.status : 1,
          stdout: err.stdout != null ? String(err.stdout) : "",
          stderr: err.stderr != null ? String(err.stderr) : "",
        };
      }
    },
  };
}

/** The runner handed to identity collection when the gate says "do not file": every call fails, so
 *  nothing is spawned and the callers take their own no-subprocess fallbacks. */
const NO_RUN: ForensicsRunner = { run: () => ({ code: 1, stdout: "", stderr: "" }) };

// ---------------------------------------------------------------------------
// Consent (ask once per box) + the env guard
// ---------------------------------------------------------------------------

export function readConsent(): "yes" | "no" | null {
  try {
    const v = readFileSync(issuesConsentPath(), "utf8").trim();
    return v === "yes" || v === "no" ? v : null;
  } catch { return null; }
}

export function writeConsent(v: "yes" | "no"): void {
  mkdirSync(globalRoot(), { recursive: true });
  atomicWrite(issuesConsentPath(), v + "\n");
}

type Gate = "file" | "queue" | "consent";
/** The single choke point. `AP_FORENSICS_BACKEND=queue` wins over consent and never spawns `gh` —
 *  fail-closed, and what keeps the test suite (and its child processes) off the live tracker. */
function gate(): Gate {
  if (process.env.AP_FORENSICS_BACKEND === "queue") return "queue";
  const c = readConsent();
  return c === "yes" ? "file" : c === "no" ? "queue" : "consent";
}

// ---------------------------------------------------------------------------
// Scrub, title, identity, rendering
// ---------------------------------------------------------------------------

const SCRUBS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted>"],
  [/gh[posur]_[A-Za-z0-9]{20,}/g, "<redacted>"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "<redacted>"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "<redacted>"],
  [/AKIA[0-9A-Z]{16}/g, "<redacted>"],
  [/(bearer\s+)\S+/gi, "$1<redacted>"],
  [/\b(token|password|passwd|secret|api[_-]?key)(\s*[=:]\s*)\S+/gi, "$1$2<redacted>"],
  [/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://<redacted>@"],
];

/** Best-effort credential denylist — it REDUCES exposure, it does not bound it (unlabelled
 *  high-entropy strings, JWTs and confidential prose still pass), which is why filing is gated by
 *  an explicit per-machine consent. */
export function scrubSecrets(s: string): string {
  let out = s;
  for (const [re, to] of SCRUBS) out = out.replace(re, to);
  return out;
}

/** `[ap:<command>] <first finding, normalized, <=80 chars>` — normalizeVolatile so the same failure
 *  on two boxes produces the SAME title (that is what dedup-on-create matches on). */
export function issueTitle(command: string, first: string): string {
  const body = normalizeVolatile(scrubSecrets(first)).replace(/\s+/g, " ").trim();
  return `[ap:${command}] ${body.slice(0, 80)}`.trim();
}

export interface RunRef { command: string; topic: string; artDir: string }
export interface RunIdentity {
  version: string; host: string; user: string; platform: string; node: string;
  providers: string; repo: string;
}

/** ap's own version, read from the package.json beside the running bundle (dist/ap.cjs), with the
 *  plugin root as the fallback the test/`node -e` paths land on. */
function apVersion(): string {
  const bases = [typeof __dirname === "string" ? join(__dirname, "..") : "", pluginRoot()];
  for (const base of bases) {
    if (!base) continue;
    try {
      const v = (JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { version?: string }).version;
      if (typeof v === "string" && v) return v;
    } catch { /* next */ }
  }
  return "unknown";
}

export function runIdentity(run: RunRef, r: ForensicsRunner = forensicsRunner()): RunIdentity {
  let providers = "";
  try {
    providers = readdirSync(dirname(run.artDir), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
      .map((d) => d.name.replace("-", ":")).sort().join(", ");
  } catch { /* no worker dirs */ }
  let repo = "";
  const origin = r.run("git", ["remote", "get-url", "origin"]);
  if (origin.code === 0 && origin.stdout.trim()) repo = scrubSecrets(origin.stdout.trim());
  if (!repo) { try { repo = repoHash(); } catch { repo = "unknown"; } }
  return {
    version: apVersion(), host: hostname(), user: safeUser(), platform: process.platform,
    node: process.version, providers, repo,
  };
}

function safeUser(): string { try { return userInfo().username; } catch { return "unknown"; } }

/** The metadata block every created issue opens with. */
export function renderIssueBody(o: {
  runId: string; command: string; kind: FindingKind; topicText: string; artDir: string;
  filedAt: string; identity: RunIdentity; section: string; body: string;
}): string {
  const rows: Array<[string, string]> = [
    ["ap version", o.identity.version], ["command", o.command], ["topic", o.topicText],
    ["run id", o.runId], ["host / user", `${o.identity.host} / ${o.identity.user}`],
    ["platform", `${o.identity.platform} · node ${o.identity.node}`],
    ["providers", o.identity.providers], ["repo", o.identity.repo],
    ["art dir", o.artDir], ["filed at", o.filedAt],
  ];
  // Every row value is scrubbed HERE, not at its source: `topic` is operator-typed prose (the most
  // likely place for a pasted credential) and the whitespace collapse keeps a newline in it from
  // injecting extra table rows. `body` arrives already scrubbed; re-scrubbing is idempotent.
  const cell = (v: string): string => scrubSecrets(v).replace(/\s+/g, " ").trim();
  return `<!-- ap-forensics run=${o.runId} cmd=${o.command} v=${o.identity.version} kind=${o.kind} -->\n` +
    "### Run\n| | |\n|---|---|\n" +
    rows.map(([k, v]) => `| ${k} | ${cell(v)} |`).join("\n") + "\n\n" +
    `### ${o.section}\n${o.body}`;
}

export function renderComment(runId: string, kind: FindingKind, body: string): string {
  return `<!-- ap-forensics run=${runId} kind=${kind} -->\n${body}`;
}

// ---------------------------------------------------------------------------
// The run record (<artDir>/issue.txt) + the offline queue
// ---------------------------------------------------------------------------

export type FindingKind = "findings" | "spawn_failure" | "flag" | "reflection";

interface IssueTxt { run_id: string; number?: string; url?: string; reflected?: boolean }

function issueTxtPath(artDir: string): string { return join(artDir, "issue.txt"); }

export function readIssueTxt(artDir: string): IssueTxt | null {
  let text: string;
  try { text = readFileSync(issueTxtPath(artDir), "utf8"); } catch { return null; }
  const f = (k: string): string | undefined => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
  const run_id = f("run_id");
  if (!run_id) return null;
  return { run_id, number: f("number"), url: f("url"), reflected: f("reflected") === "1" };
}

function writeIssueTxt(artDir: string, rec: IssueTxt): void {
  mkdirSync(artDir, { recursive: true });
  atomicWrite(issueTxtPath(artDir), `run_id=${rec.run_id}\n` +
    (rec.number ? `number=${rec.number}\n` : "") + (rec.url ? `url=${rec.url}\n` : "") +
    (rec.reflected ? "reflected=1\n" : ""));
}

const SECTION: Record<FindingKind, string> = {
  findings: "Mechanical findings", spawn_failure: "Spawn failure", flag: "Flag", reflection: "Hub reflection",
};

function issueUrl(n: string): string { return `https://github.com/${AP_ISSUES_REPO}/issues/${n}`; }

/** `<YYYYMMDDTHHMMSS.mmmZ>` — date first so a queue spanning midnight sorts chronologically. */
function stamp(iso: string): string { return iso.replace(/[-:]/g, ""); }

export interface QueueRecordInput {
  kind: FindingKind; runId: string; command: string; topic: string; artDir: string;
  nFindings: number; title?: string; body: string; identity: RunIdentity; now: string; attempts?: number;
}

/** Write one queue record and return its path. `pid`+`rand4` in the name makes two filings in the
 *  same millisecond collision-free. */
export function queueRecord(rec: QueueRecordInput): string {
  const dir = forensicsQueueDir();
  mkdirSync(dir, { recursive: true });
  const name = `${stamp(rec.now)}-${rec.runId}-${rec.kind}-${process.pid}${randomBytes(2).toString("hex")}.md`;
  const fm = ["---",
    `command: ${rec.command}`, `topic: ${rec.topic}`, `topic_slug: ${rec.topic}`,
    `repo_hash: ${safeRepoHash()}`, `art_dir: ${rec.artDir}`, `invoked_at: ${rec.now}`,
    `n_findings_mechanical: ${rec.nFindings}`,
    "queued: true", `kind: ${rec.kind}`, `run_id: ${rec.runId}`, `attempts: ${rec.attempts ?? 0}`,
    ...(rec.title ? [`title: ${rec.title}`] : []),
    `version: ${rec.identity.version}`, `host: ${rec.identity.host}`, `user: ${rec.identity.user}`,
    `platform: ${rec.identity.platform}`, `node: ${rec.identity.node}`,
    `providers: ${rec.identity.providers}`, `repo: ${rec.identity.repo}`,
    "---", ""].join("\n");
  const path = join(dir, name);
  atomicWrite(path, fm + rec.body);
  return path;
}

function safeRepoHash(): string { try { return repoHash(); } catch { return "unknown"; } }

function mapPath(): string { return join(forensicsQueueDir(), "map.txt"); }
function mapLookup(runId: string): string | undefined {
  try {
    for (const line of readFileSync(mapPath(), "utf8").split("\n")) {
      const [id, n] = line.split("\t");
      if (id === runId && n) return n.trim();
    }
  } catch { /* no map yet */ }
  return undefined;
}
function mapRecord(runId: string, number: string): void {
  try { mkdirSync(forensicsQueueDir(), { recursive: true }); appendFileSync(mapPath(), `${runId}\t${number}\n`); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// gh calls
// ---------------------------------------------------------------------------

/** An open issue with this exact title, or "" — the same failure on two boxes must land on ONE
 *  issue. `gh` failing at the lookup means "no dedup", never "do not file". */
function findOpenIssue(r: ForensicsRunner, command: string, title: string): string {
  const res = r.run("gh", ["issue", "list", "--repo", AP_ISSUES_REPO, "--state", "open",
    "--search", `in:title "[ap:${command}]"`, "--json", "number,title", "--limit", "100"]);
  if (res.code !== 0) return "";
  try {
    const rows = JSON.parse(res.stdout) as Array<{ number?: number; title?: string }>;
    const hit = rows.find((x) => x.title === title);
    return hit?.number != null ? String(hit.number) : "";
  } catch { return ""; }
}

function ghCreate(r: ForensicsRunner, title: string, body: string): { number: string; url: string } | null {
  const res = r.run("gh", ["issue", "create", "--repo", AP_ISSUES_REPO, "--title", title, "--body", body]);
  if (res.code !== 0) return null;
  const url = res.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const number = url.match(/\/(\d+)\s*$/)?.[1] ?? "";
  return number ? { number, url } : null;
}

function ghComment(r: ForensicsRunner, number: string, body: string): boolean {
  return r.run("gh", ["issue", "comment", number, "--repo", AP_ISSUES_REPO, "--body", body]).code === 0;
}

// ---------------------------------------------------------------------------
// fileFinding — the one create-or-comment path
// ---------------------------------------------------------------------------

export interface FileResult {
  status: "filed" | "queued" | "consent" | "skipped";
  /** The line the verbs print: `ISSUE=<url>` / `QUEUED=<path>` / `CONSENT=needed` / "". */
  line: string;
  path?: string; url?: string; number?: string;
}

function topicText(run: RunRef): string {
  for (const f of ["topic-text.txt", "topic.txt"]) {
    try { const t = readFileSync(join(run.artDir, f), "utf8").trim(); if (t) return t; } catch { /* next */ }
  }
  return run.topic;
}

/** Append one `<ISO> <kind>` line to `<artDir>/findings.log` — the local trace the autoresearch
 *  corpus digest counts (the dated forensics tree it used to walk is gone). */
function traceLine(artDir: string, kind: FindingKind, now: string): void {
  try { mkdirSync(artDir, { recursive: true }); appendFileSync(join(artDir, "findings.log"), `${now} ${kind}\n`); } catch { /* best-effort */ }
}

let flushing = false;

/** Create-or-comment, queue-first. Never throws, never blocks a run: the queue record is written
 *  BEFORE the first `gh` call and deleted after it succeeds, so a hang, a SIGTERM or a crash all
 *  degrade to "queued". */
export function fileFinding(
  kind: FindingKind, run: RunRef, title: string, body: string, r: ForensicsRunner = forensicsRunner(),
): FileResult {
  try {
    const now = isoUtc();
    traceLine(run.artDir, kind, now);
    const existing = readIssueTxt(run.artDir);
    const runId = existing?.run_id ?? `${safeRepoHash().slice(0, 8)}-${run.topic}-${stamp(now).replace(/\.\d+Z$/, "Z")}`;
    // The run record exists from FIRST contact, `number` absent until a create lands (spec §A). That
    // is what keeps run_id stable across an offline run, makes the "an earlier filing is still
    // queued" branch below reachable, and lets recordHubReflection queue rather than drop. Written
    // HERE, one statement after the read, so a concurrent filer's `number` is never clobbered.
    if (!existing) writeIssueTxt(run.artDir, { run_id: runId });
    // The gate decides BEFORE anything shells out: `no`/`queue`/unanswered must never spawn a
    // subprocess, and runIdentity's `git remote get-url` is one. It falls back to the repo hash.
    const g = gate();
    const identity = runIdentity(run, g === "file" ? r : NO_RUN);
    const scrubbedTitle = scrubSecrets(title);
    const scrubbedBody = scrubSecrets(body);
    const isCreate = !existing;
    const nFindings = (scrubbedBody.match(/^- \*\*/gm) ?? []).length;
    const doc = isCreate
      ? renderIssueBody({
        runId, command: run.command, kind, topicText: topicText(run), artDir: run.artDir,
        filedAt: now, identity, section: SECTION[kind], body: scrubbedBody,
      })
      : renderComment(runId, kind, scrubbedBody);

    const qpath = queueRecord({
      kind, runId, command: run.command, topic: run.topic, artDir: run.artDir,
      nFindings, title: isCreate ? scrubbedTitle : undefined, body: doc, identity, now,
    });

    if (g !== "file") return { status: g === "queue" ? "queued" : "consent", line: g === "queue" ? `QUEUED=${qpath}` : "CONSENT=needed", path: qpath };

    // An earlier filing for this run is still queued: this one must land AFTER it.
    if (existing && !existing.number) return { status: "queued", line: `QUEUED=${qpath}`, path: qpath };

    if (existing?.number) {
      if (!ghComment(r, existing.number, doc)) return queuedWarn(qpath);
      rmSync(qpath, { force: true });
      return finish({ status: "filed", line: `ISSUE=${existing.url ?? issueUrl(existing.number)}`, url: existing.url ?? issueUrl(existing.number), number: existing.number }, r);
    }

    // Create under a per-run lock: a second concurrent filer must not open a second issue.
    let lock: number;
    try { lock = openSync(join(run.artDir, "issue.lock"), "wx"); }
    catch {
      const now2 = readIssueTxt(run.artDir);
      if (!now2?.number) return { status: "queued", line: `QUEUED=${qpath}`, path: qpath };
      if (!ghComment(r, now2.number, renderComment(now2.run_id, kind, scrubbedBody))) return queuedWarn(qpath);
      rmSync(qpath, { force: true });
      return finish({ status: "filed", line: `ISSUE=${now2.url ?? issueUrl(now2.number)}`, url: now2.url ?? issueUrl(now2.number), number: now2.number }, r);
    }
    try {
      const dup = findOpenIssue(r, run.command, scrubbedTitle);
      if (dup) {
        const again = renderComment(runId, kind, `seen again — run ${runId} on ${identity.host}\n\n${scrubbedBody}`);
        if (!ghComment(r, dup, again)) return queuedWarn(qpath);
        writeIssueTxt(run.artDir, { run_id: runId, number: dup, url: issueUrl(dup) });
        mapRecord(runId, dup);
        rmSync(qpath, { force: true });
        return finish({ status: "filed", line: `ISSUE=${issueUrl(dup)}`, url: issueUrl(dup), number: dup }, r);
      }
      const made = ghCreate(r, scrubbedTitle, doc);
      if (!made) return queuedWarn(qpath);
      writeIssueTxt(run.artDir, { run_id: runId, number: made.number, url: made.url });
      mapRecord(runId, made.number);
      rmSync(qpath, { force: true });
      return finish({ status: "filed", line: `ISSUE=${made.url}`, url: made.url, number: made.number }, r);
    } finally {
      closeSync(lock);
      rmSync(join(run.artDir, "issue.lock"), { force: true });
    }
  } catch { return { status: "skipped", line: "" }; }
}

function queuedWarn(qpath: string): FileResult {
  log.warn(`forensics: gh call failed; record left queued at ${qpath}`);
  return { status: "queued", line: `QUEUED=${qpath}`, path: qpath };
}

/** Every successful filing also drains whatever the offline stretch left behind — bounded, so a
 *  long queue cannot hold the run open (a full drain is `review flush`'s job). */
function finish(res: FileResult, r: ForensicsRunner): FileResult {
  if (!flushing) {
    flushing = true;
    try { flushQueue(r, { maxMs: 30_000 }); } catch { /* best-effort */ } finally { flushing = false; }
  }
  return res;
}

// ---------------------------------------------------------------------------
// flushQueue
// ---------------------------------------------------------------------------

export interface FlushResult { filed: number; remaining: number; failed: number }

interface QueuedRec { name: string; path: string; runId: string; kind: FindingKind; command: string; artDir: string; title?: string; attempts: number; body: string }

function parseQueued(dir: string, name: string): QueuedRec | null {
  let text: string;
  try { text = readFileSync(join(dir, name), "utf8"); } catch { return null; }
  const end = text.indexOf("\n---\n", 3);
  if (!text.startsWith("---\n") || end < 0) return null;
  const fm = text.slice(4, end);
  const body = text.slice(end + 5).replace(/^\n/, "");
  const f = (k: string): string => fm.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1]?.trim() ?? "";
  const runId = f("run_id");
  if (!runId) return null;
  return {
    name, path: join(dir, name), runId, kind: (f("kind") || "findings") as FindingKind,
    command: f("command"), artDir: f("art_dir"), title: f("title") || undefined,
    attempts: Number(f("attempts")) || 0, body,
  };
}

function bumpAttempts(rec: QueuedRec): boolean {
  const next = rec.attempts + 1;
  try {
    const text = readFileSync(rec.path, "utf8").replace(/^attempts: \d+$/m, `attempts: ${next}`);
    if (next >= 3) {
      atomicWrite(rec.path, text);
      renameSync(rec.path, rec.path + ".failed");
      log.warn(`forensics: dead-lettered ${rec.path}.failed after ${next} failed attempts`);
      return true;
    }
    atomicWrite(rec.path, text);
  } catch { /* best-effort */ }
  return false;
}

/** Replay the queue: grouped by run, the create first, then that run's comments in name order. Runs
 *  are independent — one run's failure aborts only its own remaining records. */
export function flushQueue(r: ForensicsRunner = forensicsRunner(), opts: { maxMs?: number } = {}): FlushResult {
  const dir = forensicsQueueDir();
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { return { filed: 0, remaining: 0, failed: 0 }; }
  const recs = names.map((n) => parseQueued(dir, n)).filter((x): x is QueuedRec => x !== null);
  if (gate() !== "file") return { filed: 0, remaining: recs.length, failed: 0 };

  // Grouped by run_id AND art dir: the run_id's timestamp has 1-second resolution, so a design and
  // an implement run on one slug filing in the same second share the string while being two runs
  // with two issues — grouping them together would replay one run's create for both.
  const byRun = new Map<string, QueuedRec[]>();
  for (const rec of recs) {
    const key = `${rec.runId}\t${rec.artDir}`;
    const list = byRun.get(key);
    if (list) list.push(rec); else byRun.set(key, [rec]);
  }
  const deadline = Date.now() + (opts.maxMs ?? 30_000);
  // Checked before EVERY gh call, not once per record: a call started with less than its own
  // timeout left is what turned a 30 s bound into a 60 s one. Each call is capped at
  // CALL_TIMEOUT_MS, so refusing to start one inside that window keeps the drain inside maxMs.
  const outOfTime = (): boolean => Date.now() + CALL_TIMEOUT_MS > deadline;
  let filed = 0, failed = 0;

  for (const list of byRun.values()) {
    const runId = list[0].runId;
    list.sort((a, b) => (a.title ? 0 : 1) - (b.title ? 0 : 1) || (a.name < b.name ? -1 : 1));
    // map.txt is the fallback for a run whose art dir is GONE (archived/torn down) — consulting it
    // while the art dir still exists would hand a same-second run_id collision the other run's issue.
    const art = list[0].artDir;
    let number = readIssueTxt(art)?.number ?? (existsSync(art) ? undefined : mapLookup(runId));
    for (const rec of list) {
      if (outOfTime()) return tally(dir, filed, failed);
      // Its create is still queued, or dead-lettered: age this one out too, or a run whose create
      // can never land keeps its comments (and QUEUE=<n>) alive forever.
      if (!number && !rec.title) { if (bumpAttempts(rec)) failed++; break; }
      let ok: boolean;
      if (number) ok = ghComment(r, number, rec.body);
      else {
        const dup = findOpenIssue(r, rec.command, rec.title!);
        if (outOfTime()) return tally(dir, filed, failed);
        if (dup) { ok = ghComment(r, dup, rec.body); if (ok) number = dup; }
        else { const made = ghCreate(r, rec.title!, rec.body); ok = made !== null; if (made) number = made.number; }
        if (ok && number) {
          mapRecord(runId, number);
          // Merge, never overwrite: `reflected=1` on the record must survive the flush or a second
          // `reflect` for the run stops being refused.
          if (existsSync(rec.artDir)) writeIssueTxt(rec.artDir, { ...readIssueTxt(rec.artDir), run_id: runId, number, url: issueUrl(number) });
        }
      }
      if (!ok) { if (bumpAttempts(rec)) failed++; break; }
      rmSync(rec.path, { force: true });
      filed++;
    }
  }
  return tally(dir, filed, failed);
}

function tally(dir: string, filed: number, failed: number): FlushResult {
  let remaining = 0;
  try { remaining = readdirSync(dir).filter((n) => n.endsWith(".md")).length; } catch { /* gone */ }
  return { filed, remaining, failed };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** The art dir every command's forensics/flag/reflect verb records under: `<topicDir>/_<command>`
 *  (`_quick`, `_design`, `_implement`, `_explore`, `_autoresearch`, `_bridge`). */
export function commandArtDir(command: string, topic: string): string {
  return join(topicDir(topic), `_${command}`);
}

/** Best-effort forensics capture for an art dir. Returns the verb's status LINE (`ISSUE=<url>` /
 *  `QUEUED=<path>` / `CONSENT=needed`), or "" on zero findings or ANY failure. Never throws. */
export function captureArtDir(opts: { artDir: string; command: string; now?: Date }): string {
  try {
    const findings = scrapeArtDir(opts.artDir);
    if (findings.length === 0) return "";
    const topicSlug = basename(dirname(opts.artDir));
    return fileFinding("findings", { command: opts.command, topic: topicSlug, artDir: opts.artDir },
      issueTitle(opts.command, findings[0].key), renderFindingBullets(findings)).line;
  } catch { return ""; }
}

/** Shared body for each command's `forensics` wind-down verb: usage-guard the topic, capture, report.
 *  Best-effort — rc 0 unless the topic arg is missing (rc 2). */
export function runForensics(command: string, artDirFor: (topic: string) => string, topic: string | undefined): number {
  if (!topic) { log.error(`usage: ${command} forensics <topic>`); return 2; }
  const line = captureArtDir({ artDir: artDirFor(topic), command });
  if (line) { log.ok(`${command} forensics: ${line}`); process.stdout.write(line + "\n"); }
  else log.info(`${command} forensics: no mechanical findings (nothing filed)`);
  return 0;
}

/** A spawn/bootstrap failure is its OWN run: `spawn` is a CLI verb with no owning command in
 *  process, so the run record lives under the worker dir. Returns the status line, "" on any error.
 *
 *  It also prints `SPAWN_FAILED reason=<reason>` on STDOUT — the ONE machine-readable line the
 *  quick/implement directives branch on to decide whether a cold start earns a retry (`pane_dead`,
 *  `timeout`) or is deterministic (`binary_not_found`, `config_error`, ...). It lives here, at the
 *  single choke point every failure path already crosses, so no site can ship without it; it is a
 *  CLI contract, so keep it before the catch-all — a failure that cannot be filed still prints. */
export function captureSpawnFailure(opts: {
  agent: string; model: string; topic: string;
  reason: string; detail: string; failureReportPath?: string; now?: Date;
}): string {
  process.stdout.write(`SPAWN_FAILED reason=${opts.reason}\n`);
  try { // NOTE: swallows everything — a topic/path validation must run in the CALLER, outside this catch
    const ctx = `worker=${opts.agent}-${opts.model}`;
    const findings: Finding[] = [
      { source: "spawn_failure", key: `reason=${opts.reason} ${opts.detail}`.replace(/\s+/g, " ").trim(), context: ctx },
    ];
    if (opts.failureReportPath) findings.push({ source: "spawn_failure", key: `failure_report=${opts.failureReportPath}`, context: ctx });
    const art = workerDir(opts.agent, opts.model, opts.topic);
    return fileFinding("spawn_failure", { command: "spawn", topic: opts.topic, artDir: art },
      `[ap:spawn] ${opts.reason}`, renderFindingBullets(findings)).line;
  } catch { return ""; }
}

/** Record a Hub suspicion as a comment on (or the creator of) the run's issue. Teardown-independent
 *  (lands even on abort/handoff). Returns the status line, "" on an empty note / any error. */
export function recordHubFlag(opts: { command: string; topic: string; note: string; now?: Date }): string {
  try { // NOTE: swallows everything — a topic/path validation must run in the CALLER, outside this catch
    const note = opts.note.trim();
    if (!note) return "";
    const finding: Finding = { source: "hub_flag", key: note, context: `from=hub command=${opts.command}` };
    return fileFinding("flag", { command: opts.command, topic: opts.topic, artDir: commandArtDir(opts.command, opts.topic) },
      issueTitle(opts.command, note), renderFindingBullets([finding])).line;
  } catch { return ""; }
}

/** Shared `<command> flag <topic> <note>` verb: usage-guard, record, report. rc 2 on missing
 *  topic/empty note, else rc 0 (best-effort; mirrors runForensics). */
export function runFlag(command: string, topic: string | undefined, note: string): number {
  if (!topic || !note.trim()) { log.error(`usage: ${command} flag <topic> <observation>`); return 2; }
  // Gate HERE and not in recordHubFlag: that body is inside a catch-all that would swallow the
  // refusal and report success. The internal callers pass an already-gated topic.
  assertSlug("topic", topic);
  const line = recordHubFlag({ command, topic, note });
  if (line) { log.ok(`${command} flag: ${line}`); process.stdout.write(line + "\n"); }
  else log.info(`${command} flag: nothing recorded`);
  return 0;
}

/** The hub's 3-5 bullets, posted once per run. `null` when there is no run issue to comment on. */
export function recordHubReflection(command: string, topic: string, text: string, r: ForensicsRunner = forensicsRunner()): FileResult | null | "done" {
  const art = commandArtDir(command, topic);
  const rec = readIssueTxt(art);
  if (!rec) return null;
  if (rec.reflected) return "done";
  const res = fileFinding("reflection", { command, topic, artDir: art }, issueTitle(command, "hub reflection"), text, r);
  if (res.status !== "skipped") writeIssueTxt(art, { ...rec, reflected: true });
  return res;
}

/** `<command> reflect <TOPIC> @<file>` — the hub's own read of the run, as a comment. */
export function runReflect(command: string, topic: string | undefined, fileArg: string | undefined): number {
  if (!topic || !fileArg) { log.error(`usage: ${command} reflect <topic> @<file>`); return 2; }
  assertSlug("topic", topic);
  const path = fileArg.startsWith("@") ? fileArg.slice(1) : fileArg;
  let text: string;
  try { text = readFileSync(path, "utf8").trim(); } catch { log.error(`${command} reflect: unreadable file: ${path}`); return 2; }
  if (!text) { log.error(`${command} reflect: empty reflection file: ${path}`); return 2; }
  const res = recordHubReflection(command, topic, text);
  if (res === null) { process.stdout.write("NO_RUN_ISSUE\n"); return 0; }
  if (res === "done") { log.error(`${command} reflect: this run's reflection was already posted`); return 1; }
  if (res.line) process.stdout.write(res.line + "\n");
  return 0;
}
