// src/core/review.ts — pure logic for /ap:review (triage over the run issues).
// The review half of the forensics system; the capture half lives in core/forensics.ts.
// parseMechanicalFindings is the exact inverse of forensics.renderArtForensics's
// `- **<source>** <key> _(source: <context>)_` bullet.
import type { Finding } from "./forensics.js";

export interface ForensicsMetaParsed { command: string; topic: string; nFindings: number; }

/** Parse a captured forensics file's YAML frontmatter. Missing keys -> "" / 0. */
export function parseForensicsFrontmatter(text: string): ForensicsMetaParsed {
  const field = (k: string): string => {
    const m = text.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };
  const n = Number(field("n_findings_mechanical"));
  return { command: field("command"), topic: field("topic"), nFindings: Number.isFinite(n) ? n : 0 };
}

const BULLET = /^- \*\*(.+?)\*\* (.*?) _\(source: (.*)\)_$/;
/** Parse the `## Mechanical findings` bullets back into Finding[]. Malformed lines are skipped. */
export function parseMechanicalFindings(text: string): Finding[] {
  const out: Finding[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(BULLET);
    if (m) out.push({ source: m[1], key: m[2], context: m[3] });
  }
  return out;
}

/** Parse a `--since` spec (`<N>d` or `<N>h`) into a cutoff epoch-ms relative to `now`. Throws on bad spec. */
export function parseSince(spec: string, now: number): number {
  const m = spec.match(/^(\d+)([dh])$/);
  if (!m) throw new Error(`--since must be <N>d or <N>h (got '${spec}')`);
  const n = Number(m[1]);
  return now - (m[2] === "d" ? n * 86_400_000 : n * 3_600_000);
}

/** Replace per-run volatile tokens so the "same problem" in a different run collapses to one class.
 *  Order matters: ISO timestamps first (they contain digits), then SHA-like hex, then absolute
 *  paths, then any remaining bare integers. */
export function normalizeVolatile(s: string): string {
  return s
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\/[^\s"']+/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .trim();
}

// ---------------------------------------------------------------------------
// Triage over GitHub issues (spec 2026-08-30 §E). Shape = the `gh issue list --json
// number,title,createdAt,labels,comments,url` payload; these are pure predicates over it.

/** First line of the fallback triage marker comment (`<!-- ap-triaged at=<ISO> -->`). */
export const AP_TRIAGED_MARKER = "<!-- ap-triaged";
/** Marker line every ap-filed comment carries (`<!-- ap-forensics run=… kind=… -->`). */
const AP_FORENSICS_MARKER = "<!-- ap-forensics";
const TRIAGED_LABEL = "triaged";

export interface GhComment { body: string; createdAt: string; }
export interface GhIssue {
  number: number;
  title: string;
  createdAt: string;
  labels?: { name: string }[];
  comments?: GhComment[];
  url?: string;
}

const firstLine = (body: string): string => body.split("\n", 1)[0].trim();
const ms = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

/** Triaged iff (the `triaged` label OR an `<!-- ap-triaged …` marker comment) AND no ap-forensics
 *  comment is newer than the newest marker comment — a recurrence re-opens triage. A label with no
 *  marker comment carries no timestamp to compare against, so it stays triaged (spec §E). */
export function isTriaged(issue: GhIssue): boolean {
  const comments = issue.comments ?? [];
  const markers = comments.filter((c) => firstLine(c.body).startsWith(AP_TRIAGED_MARKER));
  const labelled = (issue.labels ?? []).some((l) => l.name === TRIAGED_LABEL);
  if (!labelled && markers.length === 0) return false;
  if (markers.length === 0) return true;
  const newestMarker = Math.max(...markers.map((c) => ms(c.createdAt)));
  return !comments.some((c) => firstLine(c.body).startsWith(AP_FORENSICS_MARKER) && ms(c.createdAt) > newestMarker);
}

/** Newest ap-forensics comment time, else the issue's own createdAt (spec §E `--since`). */
export function lastEventAt(issue: GhIssue): string {
  let best = "";
  for (const c of issue.comments ?? []) {
    if (firstLine(c.body).startsWith(AP_FORENSICS_MARKER) && ms(c.createdAt) > ms(best)) best = c.createdAt;
  }
  return best || issue.createdAt;
}

export interface TitleCluster { title: string; open: number; seenAgain: number; first: string; last: string; }

/** Group issues by normalized title; keep only clusters worth a TRENDS row (>=2 open issues, or at
 *  least one "seen again" recurrence comment). Sorted by open desc, then title asc. */
export function clusterByTitle(issues: GhIssue[]): TitleCluster[] {
  const by = new Map<string, TitleCluster>();
  for (const i of issues) {
    const title = normalizeVolatile(i.title);
    const seenAgain = (i.comments ?? []).filter((c) => c.body.includes("seen again")).length;
    const last = lastEventAt(i);
    const c = by.get(title);
    if (!c) by.set(title, { title, open: 1, seenAgain, first: i.createdAt, last });
    else {
      c.open += 1;
      c.seenAgain += seenAgain;
      if (ms(i.createdAt) < ms(c.first)) c.first = i.createdAt;
      if (ms(last) > ms(c.last)) c.last = last;
    }
  }
  return [...by.values()]
    .filter((c) => c.open >= 2 || c.seenAgain >= 1)
    .sort((a, b) => b.open - a.open || a.title.localeCompare(b.title));
}
