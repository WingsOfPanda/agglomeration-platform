// src/commands/review.ts — /ap:review verbs over the issue tracker (spec 2026-08-30 §E/§G).
// survey = bounded flush + ONE `gh issue list` + the client-side triage predicate; archive = mark
// triaged (label, marker comment when this account cannot label); flush = the full drain; consent =
// the ask-once gate. Every gh argv carries `--repo AP_ISSUES_REPO`: gh otherwise infers the repo
// from the CALLER's checkout. Predicates live in core/review.ts, the gh boundary in core/forensics.ts.
import { log } from "../core/log.js";
import { isoUtc } from "../core/archive.js";
import {
  parseSince, isTriaged, lastEventAt, clusterByTitle, AP_TRIAGED_MARKER,
} from "../core/review.js";
import type { GhIssue } from "../core/review.js";
import {
  AP_ISSUES_REPO, forensicsRunner, flushQueue, readConsent, writeConsent,
} from "../core/forensics.js";
import type { ForensicsRunner } from "../core/forensics.js";

const out = (s: string): void => { process.stdout.write(s + "\n"); };
const ms = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

export interface SurveyOpts { command?: string; since?: string; now?: number; runner?: ForensicsRunner }

/** Flush what is queued (bounded — a survey must never hang on `gh`), then list the open ap issues
 *  once and print the untriaged ones as TSV plus the recurring-title TRENDS block. */
export async function surveyWith(o: SurveyOpts = {}): Promise<number> {
  let cutoff: number | null = null;
  if (o.since) {
    try { cutoff = parseSince(o.since, o.now ?? Date.now()); }
    catch (e: any) { log.error(`review survey: ${e?.message ?? e}`); return 2; }
  }
  const r = o.runner ?? forensicsRunner();
  const flushed = flushQueue(r, { maxMs: 30_000 });
  const res = r.run("gh", ["issue", "list", "--repo", AP_ISSUES_REPO, "--state", "open",
    "--search", 'in:title "[ap:"',
    "--json", "number,title,createdAt,labels,comments,url", "--limit", "200"]);
  if (res.code !== 0) { log.error(`review survey: gh issue list failed (rc ${res.code}): ${res.stderr.trim()}`); return 1; }
  let issues: GhIssue[];
  try { issues = JSON.parse(res.stdout.trim() || "[]") as GhIssue[]; }
  catch { log.error("review survey: gh issue list returned unparseable JSON"); return 1; }
  if (o.command) issues = issues.filter((i) => i.title.startsWith(`[ap:${o.command}]`));

  let n = 0;
  for (const i of issues) {
    if (isTriaged(i)) continue;
    const last = lastEventAt(i);
    if (cutoff !== null && ms(last) < cutoff) continue;
    out(`${i.number}\t${i.title}\t${i.comments?.length ?? 0}\t${last}\t${i.url ?? ""}`);
    n++;
  }
  // Trends are the LIFETIME picture, so they cluster every open issue — a triaged one still counts
  // towards a recurring pattern. Everything non-row prints after TRENDS: the directive's healthy
  // short-circuit reads "zero rows before TRENDS".
  out("TRENDS");
  for (const c of clusterByTitle(issues)) out(`${c.title}\t${c.open}\t${c.seenAgain}\t${c.first}\t${c.last}`);
  if (flushed.remaining > 0) out(`QUEUE=${flushed.remaining}`);
  if (readConsent() === null) out("CONSENT=needed");
  log.info(`review survey: ${n} untriaged issue(s)`);
  return 0;
}

export interface ArchiveOpts { now?: Date; runner?: ForensicsRunner }

/** Mark the reviewed issues triaged. The label is the primary marker; a non-collaborator cannot
 *  label, so a failed edit falls back to the marker comment `isTriaged` reads identically. */
export async function archiveWith(numbers: string[], o: ArchiveOpts = {}): Promise<number> {
  const r = o.runner ?? forensicsRunner();
  r.run("gh", ["label", "create", "triaged", "--repo", AP_ISSUES_REPO, "--description", "triaged by /ap:review"]);
  let done = 0, failed = 0;
  for (const n of numbers) {
    if (r.run("gh", ["issue", "edit", n, "--repo", AP_ISSUES_REPO, "--add-label", "triaged"]).code === 0) { done++; continue; }
    const body = `${AP_TRIAGED_MARKER} at=${isoUtc(o.now)} -->\ntriaged by /ap:review`;
    if (r.run("gh", ["issue", "comment", n, "--repo", AP_ISSUES_REPO, "--body", body]).code === 0) done++;
    else { log.warn(`review archive: could not mark #${n} triaged`); failed++; }
  }
  log.ok(`review archive: ${done} issue(s) triaged`);
  return failed > 0 ? 1 : 0;
}

/** The one unbounded drain (`fileFinding`'s auto-flush and `survey` are both time-boxed). */
export async function flushWith(r: ForensicsRunner = forensicsRunner()): Promise<number> {
  const res = flushQueue(r, { maxMs: Infinity });
  out(`FILED=${res.filed}`);
  out(`QUEUE=${res.remaining}`);
  if (res.failed > 0) out(`FAILED=${res.failed}`);
  log.ok(`review flush: ${res.filed} filed, ${res.remaining} queued, ${res.failed} dead-lettered`);
  return 0;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0]; const rest = args.slice(1);
  if (verb === "survey") {
    const o: SurveyOpts = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--all") { log.error("review survey: --all was removed (issues are open or triaged, not archived files)"); return 2; }
      else if (rest[i] === "--command") o.command = rest[++i];
      else if (rest[i] === "--since") o.since = rest[++i];
      else { log.error(`review survey: unknown flag '${rest[i]}'`); return 2; }
    }
    return surveyWith(o);
  }
  if (verb === "archive") {
    if (rest.length === 0) { log.error("usage: review archive <number...>"); return 2; }
    const bad = rest.find((n) => !/^\d+$/.test(n));
    if (bad !== undefined) { log.error(`review archive: not an issue number: '${bad}'`); return 2; }
    return archiveWith(rest);
  }
  if (verb === "flush") return flushWith();
  if (verb === "consent") {
    const v = rest[0];
    if (v !== "yes" && v !== "no") { log.error("usage: review consent <yes|no>"); return 2; }
    writeConsent(v);
    out(`CONSENT=${v}`);
    log.ok(`review consent: ${v}`);
    return 0;
  }
  log.error("usage: review <survey|archive|flush|consent> ...");
  return 2;
}
