# Forensics as GitHub issues — design

**Date:** 2026-08-30
**Version:** 0.5.62
**Scope:** `src/core/forensics.ts` backend swap (file → GitHub issue, with an offline queue and an
ask-once consent gate), one new `reflect` entry, `src/commands/review.ts` re-based on `gh issue`,
one-paragraph directive changes in six `commands/*.md` + a rewrite of `commands/review.md`, tests.
**Wire protocol untouched.**
**Provenance:** grilled 2026-08-30 (16 questions over 4 rounds); `/codex:adversarial-review` on the
first draft returned 8 findings, all 8 execution-verified as real by an independent Opus panel and
folded in below (§A run record, §C queue, §D scrub, §E triage, §G consent, §H tests, §F corpus).

## Problem

Every ap command records what went wrong at teardown (`captureArtDir`), on spawn failure
(`captureSpawnFailure`) and whenever the hub flags something (`recordHubFlag`) — all into
`~/.ap/forensics/<date>/*.md` on the box that ran the command (`src/core/forensics.ts:152`).
`/ap:review` then surveys those files, clusters them by a normalized signature, accrues a lifetime
trend ledger and files them under `.reviewed/`. Measured over three months (97 local records, 140 on
xjp):

- Feedback is **box-local**. The maintainer has to ssh into every box that runs ap (today xjp, via a
  standing rule) to see what happened there; a teammate's box is invisible.
- The trend machinery does not cluster: `.trends.json` holds 223 signatures for 243 events (92 %
  singletons) because `hub_flag`/`part_note` prose never normalizes to the same key.
- Four of the eight scrapers (`audit_log`, `status`, `spawn_results`, `session_log`) have never
  produced a finding.
- The record and the fix live in different places: the fix is a PR on
  `WingsOfPanda/agglomeration-platform`, the evidence is a markdown file nobody links from it.

## Goal

An ap problem becomes a **GitHub issue on `WingsOfPanda/agglomeration-platform`** the moment it is
observed, from whichever box and user ran the command — after that box's user has said **yes once**
to filing there — with one issue per run, mid-run flags and the hub's reflection as comments on it,
full debugging detail (the users are teammates), and only credential-shaped strings scrubbed. Filing
never blocks or fails a run: every `gh` call is time-boxed, the record is written to a local queue
*before* the call and removed after it succeeds, and the queue is flushed later by the next successful
filing or by `/ap:review`. `/ap:review` becomes triage over the open issues (cluster, suggest, hand
off to `/ap:quick` with `Closes #n`, mark `triaged`); the local trend ledger, `.reviewed/` archive
and the remote-box ssh pull are retired.

## Architecture

### A. The run issue

**Tracker.** One exported constant `AP_ISSUES_REPO = "WingsOfPanda/agglomeration-platform"`
(`src/core/forensics.ts`), passed as `--repo` on **every** `gh issue` / `gh label` invocation — the
verbs' and the directive's alike. `gh` otherwise infers the repo from the *caller's* checkout
(`Runner` is cwd-bound and every verb `chdir`s to the target repo), which would file a teammate's
run into their project's tracker. With `--repo`, filing also works when cwd is not a git repo.

**Run record** = `<artDir>/issue.txt` (the command's own `_<suite>` art dir — `_quick`, `_design`,
`_implement`, `_explore`, `_autoresearch`, `_bridge`), written at FIRST contact with `run_id` only
and gaining `number`/`url` when a create lands. Not the topic dir: it is shared by every command on
that slug and is never archived or removed (`archiveTopic` moves only `_<suite>`,
`src/core/archive.ts:61-75`), so design→implement on one slug would inherit the design run's issue
and `reflected=1`. No init resets it: every init refuses a slug whose art dir already exists
(`topic already in flight`, rc 2), so a repeated slug never re-enters a live record.
```
run_id=<repo_hash[:8]>-<topic_slug>-<YYYYMMDDTHHMMSSZ of first filing>
number=<issue number>        (absent while queued)
url=<issue url>              (absent while queued)
reflected=1                  (present once the reflection comment is posted)
```
**Spawn failures are their own run**: `spawn` is a CLI verb invoked from the directives with no
owning command in-process, so `captureSpawnFailure` keeps its signature and records at
`workerDir(agent, model, topic)/issue.txt`, title `[ap:spawn] <reason>`.

**Create-or-comment.** All four kinds go through one function
`fileFinding(kind, run, title, body, r = forensicsRunner())`:
- no `issue.txt` → **create** under a per-run lock (`openSync(join(artDir, "issue.lock"), "wx")`;
  a second concurrent filer that loses the lock waits for `issue.txt` or queues) →
  `gh issue create --repo <R> --title <T> --body <B>`; on success write `issue.txt`.
- `issue.txt` with `number` → **comment**: `gh issue comment <n> --repo <R> --body <B>`.
- `issue.txt` without `number` (an earlier filing queued) → queue this one too (§C).

**Title** = `[ap:<command>] <first finding, normalized, ≤80 chars>` — the flag text (flag-created
issue), the spawn-failure reason, or the first mechanical finding key — normalized by the existing
`normalizeVolatile` (`src/core/review.ts:41`) so the same failure on two boxes produces the same
title. `topic` is in the body, not the title.

**Dedup on create.** `gh issue list --repo <R> --state open --search "in:title \"[ap:<command>]\""
--json number,title --limit 100`; an exact title match → comment there (`seen again — run <run_id>
on <hostname>` + body) and record that number. Closed issues never match. A triaged-but-open issue
*does* match — the recurrence comment is what makes it untriaged again (§E). `gh` failing at the
lookup → skip dedup, create. The cross-run same-title race (two boxes creating in the same second)
is accepted: `clusterByTitle` absorbs it.

**Issue body** (create): metadata block, then the record.
```markdown
<!-- ap-forensics run=<run_id> cmd=<command> v=<version> kind=<kind> -->
### Run
| | |
|---|---|
| ap version | <version> |
| command | <command> |
| topic | <topic text, verbatim> |
| run id | <run_id> |
| host / user | <os.hostname()> / <os.userInfo().username> |
| platform | <process.platform> · node <process.version> |
| providers | <agent:provider, … from the worker dirs present> |
| repo | <origin URL with any userinfo stripped, else repo_hash> |
| art dir | <abs path> |
| filed at | <ISO Z> |

### <Mechanical findings | Spawn failure | Flag>
<the record body, verbatim in today's `- **<source>** <key> _(source: …)_` bullet schema>
```
Comments carry the marker line `<!-- ap-forensics run=<run_id> kind=flag|reflection|findings -->`
and the record body. Labels are **not** applied by the verbs (non-collaborators cannot label).

**Kinds.** `findings` (teardown; only when ≥1 finding — a clean run files nothing), `spawn_failure`,
`flag` (`recordHubFlag`, incl. the internal callers at `implement.ts:275`, `roundProtocol.ts:118`,
`phaseTable.ts:296/464`, `artifact.ts:249`), and the new `reflection` (§B).

**Local trace for autoresearch.** `fileFinding` also appends one line `<ISO> <kind>` to
`<artDir>/findings.log` (best-effort; for a hub flag with no art dir yet, `join(topicDir(topic),
"_" + command)`). `corpusDigestWith` (`src/commands/autoresearch.ts:1952-1984`) derives
`forensics_flags` from that file in each archived campaign dir instead of walking the dated
forensics tree (which stops existing); the `forensicsRoot` dep goes.

**Version.** Read at runtime from `package.json` beside the bundle
(`join(__dirname, "..", "package.json")`), fallback `unknown`.

### B. Hub reflection → comment

The hub Writes its 3-5 bullets to a temp file and runs `$CS <command> reflect <TOPIC> @<file>` →
`recordHubReflection` posts kind `reflection` and sets `reflected=1`; a second `reflect` for the same
run is refused with rc 1. With no `issue.txt` it prints `NO_RUN_ISSUE`, rc 0. Directive guidance:
"write for a teammate who will debug this from the issue alone: what the findings mean, what the hub
did, what you'd try first". No public-audience redaction rule (settled).

### C. Offline queue — queue-first, time-boxed, per-run ordered

**Runner.** Forensics has its **own** `forensicsRunner()` — `execFileSync` with `timeout: 15_000`
and `killSignal: "SIGKILL"`, stdin ignored; a timeout surfaces as a non-zero result (the existing
catch shape maps `ETIMEDOUT` to code 1). It is never the cwd-bound `gitwork` Runner (no opts slot,
no timeout). Every `gh` call in this spec goes through it.

**Queue-first.** `fileFinding` writes the queue record **before** its first `gh` call and deletes it
after the call succeeds; a hang, a hub `SIGTERM`, or a crash all degrade to "queued", never to a lost
record. Any non-zero `gh` exit — binary missing, unauthenticated, network, API, timeout — leaves the
record queued, logs one `warn` line naming the path, and returns 0. `runForensics`/`runFlag` print
`ISSUE=<url>` on success, `QUEUED=<path>` when queued, or `CONSENT=needed` (§G).

**Layout.** `~/.ap/forensics/queue/<YYYYMMDDTHHMMSS.mmmZ>-<run_id>-<kind>-<pid><rand4>.md` (date
first so a queue spanning midnight sorts correctly; pid+rand4 makes same-millisecond concurrent
filers collision-free — the `atomicWrite` idiom). Frontmatter: today's keys + `queued: true`,
`kind`, `run_id`, `attempts: <n>`, `title:` (creates only), and the identity block.
`~/.ap/forensics/queue/map.txt` holds `run_id → number` for runs whose art dir is gone.

**Flush** (`review flush`; also attempted automatically **after** the current record's own filing,
bounded by **30 s wall clock**, full drain only in `review flush` with progress output): group
records by `run_id`; per run replay the create (the record carrying `title:`) first — with dedup —
then its comments in name order; runs are independent, so one run's failure aborts only that run's
remaining records and the flush continues with the others. A failed record's `attempts` is bumped;
at 3 it is renamed `.failed` (dead letter) with one `warn` line. A crash after GitHub accepted a
comment but before the local delete replays it once — accepted (dedup-on-create downgrades a
duplicate create to "seen again"; a duplicate comment is harmless). On the happy path nothing stays
under `~/.ap/forensics/`.

### D. Secret scrub — best-effort denylist

Every posted line (title, body, comment) passes `scrubSecrets`: `gh[posur]_[A-Za-z0-9]{20,}`,
`github_pat_[A-Za-z0-9_]{20,}`, `sk-[A-Za-z0-9_-]{16,}`, `AKIA[0-9A-Z]{16}`, `(?i)bearer\s+\S+`,
`(?i)\b(token|password|passwd|secret|api[_-]?key)\s*[=:]\s*\S+`, URL userinfo
`://[^/\s:@]+:[^/\s@]+@` → `://<redacted>@`, and PEM blocks
`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`. The value becomes
`<redacted>`. This **reduces, it does not bound**: unlabelled high-entropy strings, Slack `xox*`, JWTs
and confidential prose still pass — which is why filing is gated by consent (§G). Nothing else is
redacted (settled Q12a/Q13): paths, hostnames, usernames, topic text, worker prose and JSON events
post verbatim; the origin URL posts with userinfo stripped (the one identity field that mechanically
carries a credential).

### E. `/ap:review` = triage over issues

`review survey [--since <Nd|Nh>] [--command <name>]` (verb name kept; new backend):
1. `review flush` first (bounded as in §C — the survey reports `QUEUE=<remaining>`).
2. One call: `gh issue list --repo <R> --state open --search "in:title \"[ap:\"" --json
   number,title,createdAt,labels,comments,url --limit 200`. **Client-side triage predicate**: an
   issue is *triaged* iff (it carries the `triaged` label OR a comment whose first line is
   `<!-- ap-triaged at=<ISO> -->`) AND no `<!-- ap-forensics …` comment is newer than the newest
   triage marker. So a recurrence on a triaged issue makes it untriaged again, and the
   non-collaborator comment fallback counts exactly like the label. `--since` compares the newest
   ap-marker comment time (else `createdAt`). Output: one TSV row per untriaged issue
   `<number>\t<title>\t<comments>\t<last_event>\t<url>`, then `TRENDS` with one row per
   normalized-title cluster having ≥2 open issues or ≥1 "seen again" comment:
   `<title>\t<open>\t<seen_again>\t<first>\t<last>`. `--all` is removed.
3. Zero rows → the directive prints "no untriaged ap issues; ap has been healthy".

`review archive <number>…` (name kept): `gh issue edit <n> --repo <R> --add-label triaged`
(best-effort `gh label create triaged --repo <R>` once); when labelling fails (no rights) it posts
the marker comment `<!-- ap-triaged at=<ISO> -->\ntriaged by /ap:review` instead. One shared marker
constant in `src/core/review.ts`. Closing stays the maintainer's call (`gh issue close --repo <R>`).

`review consent yes|no` — §G. `review flush` — §C.

The directive (`commands/review.md`) rewritten: consent check → survey → read each issue
(`gh issue view <n> --repo <R> --comments`) → cluster → per cluster one action and the hand-off
`/ap:quick "<fix>. Closes #<n>"` (or `/ap:implement` when it needs a spec) → present → archive the
reviewed numbers. The remote-box ssh pull is dropped (every box files its own issues).

### F. Deletions

- Scrapers `scrapeAuditLog`, `scrapeStatus`, `scrapeSpawnResults`, `scrapeLogs` (never fired).
- The trend ledger (`.trends.json`, `accrue`, `parseTrendLedger`, `findingSignature`'s per-source
  branches except `normalizeVolatile`), `reviewedTarget`, `.reviewed/`, recursive `walkForensics`,
  `--all`, the dated `<date>/<time>-<name>.md` layout and `freeFeedPath` (its same-second guard is
  replaced by the pid+rand4 queue name).
- `corpusDigestWith`'s `forensicsRoot` walk (replaced by `findings.log`, §A).
- The standing rule "ap:review must include remote-box forensics" (memory; update after ship).

Existing `~/.ap/forensics/<date>/` and `.reviewed/` trees are left in place; nothing reads them.
No migration of pre-0.5.62 records.

### G. Consent — ask once per box

Filing to a public tracker is gated at the **single choke point**: `fileFinding` and `flushQueue`
both read `~/.ap/issues-consent` (one line, `yes` or `no`, written by `review consent yes|no`).
- `yes` → file. `no` → never shell out; records are written to the queue dir as today's local file
  and `runForensics`/`runFlag` print `QUEUED=<path>` (the local-file behaviour, permanently).
- **absent** → queue the record and print `CONSENT=needed`. The directives handle it once: at the
  forensics step of an attached run, and at the start of `/ap:review`, on `CONSENT=needed` fire
  **AskUserQuestion** (Header `Issues`): *"ap files run diagnostics as issues on the public repo
  github.com/WingsOfPanda/agglomeration-platform — one issue per run with the topic, hostname,
  username, paths, worker output and hub notes, for every repo you run ap in from this machine.
  Allow?"* — `Allow (recommended for the team)` / `Never on this machine` / `Not now`. Allow →
  `$CS review consent yes` then `$CS review flush`; Never → `$CS review consent no`; Not now →
  nothing (asked again next time). Mid-run flags never ask; detached jobs never ask (they queue).
- `AP_FORENSICS_BACKEND=queue` (env) forces the queue path regardless of consent — fail-closed, used
  by the test setup (§H).

README's "Security posture" block gains one clause naming that ap files run diagnostics as public
GitHub issues after a one-time per-machine consent, and how to decline (`ap review consent no`).

### H. Test seam — no test may reach live `gh`

- `fileFinding(..., r = forensicsRunner())`: unit tests pass a fake runner and assert exact argv.
- `tests/helpers/setupEnv.ts` (already wired in `vitest.config.ts`) sets
  `process.env.AP_FORENSICS_BACKEND = "queue"`; the real backend honours it before any `gh` call,
  so the five internal flag callers and the `dist/ap.cjs` child processes that inherit `process.env`
  (`tests/turn-confirm.test.ts:491` etc.) all land in the queue dir, never on GitHub.
- The three helper readers that walk `<forensics>/<date>/<file>` (`tests/turn-confirm.test.ts:85-93`,
  `tests/artifact-completeness.test.ts:60-66`, `tests/implement-cmd.test.ts:409-412`) are
  re-pointed at the flat queue dir; the `tests/implement-cmd.test.ts:330` stdout pin moves to the
  `QUEUED=` line.

## Components

- `src/core/forensics.ts` — `AP_ISSUES_REPO`; `forensicsRunner()` (15 s timeout); keep the three
  entry-point signatures; `fileFinding(kind, run, title, body, r?)` with lock, dedup, queue-first,
  consent + env gate, `findings.log` line; `recordHubReflection` + `runReflect`; `runIdentity()`
  (version / hostname / user / platform / node / providers / origin-stripped); `issueTitle`,
  `renderIssueBody`, `renderComment`, `scrubSecrets`; `queueRecord`, `flushQueue(r, { maxMs })`,
  `map.txt`; `readConsent`/`writeConsent`; `issue.txt` read/write; remove the four scrapers.
  `runForensics`/`runFlag` print `ISSUE=`/`QUEUED=`/`CONSENT=needed`.
- `src/core/paths.ts` — `forensicsQueueDir()`, `issuesConsentPath()`.
- `src/core/review.ts` — keep `normalizeVolatile`, `parseMechanicalFindings`; delete the ledger; add
  `AP_TRIAGED_MARKER`, `isTriaged(issue)`, `lastEventAt(issue)`, `clusterByTitle(issues)`.
- `src/commands/review.ts` — `survey` (flush + one `gh issue list` + predicate + TSV/TRENDS),
  `archive` (label / marker-comment fallback), `flush`, `consent yes|no`; `--since`/`--command`
  kept, `--all` removed.
- `src/commands/{quick,design,implement,explore,autoresearch,bridge}.ts` — init resets
  `<artDir>/issue.txt`; dispatch case `reflect <TOPIC> @<file>` → `runReflect(command, topic, file)`.
- `src/commands/spawn.ts` — spawn-failure run record under the worker dir (signature unchanged).
- `src/commands/autoresearch.ts` — `corpusDigestWith` counts `findings.log` lines per archived
  campaign; `forensicsRoot` dep removed.
- `commands/{quick,design,implement,explore,autoresearch,bridge}.md` — forensics step surfaces
  `ISSUE=`/`QUEUED=`/`CONSENT=needed` (+ the consent AskUserQuestion, attached runs only);
  reflection step → `$CS <cmd> reflect <TOPIC> @<file>` with the teammate-audience guidance;
  `## Flagging suspicions` says flags become comments on the run's issue (queued offline / before
  consent). `commands/review.md` rewritten per §E + §G. `commands/job.md` (detached): never ask.
- `README.md` — the security-posture clause (§G).
- **Tests** (fresh `AP_HOME`, fake runner, `AP_FORENSICS_BACKEND=queue` in setup):
  - `tests/forensics-issue.test.ts` (new): create argv incl. `--repo` from a cwd that is an
    unrelated repo; comment argv; lock (second concurrent create waits/queues, one issue); dedup
    (fake list match → comment argv + number recorded; triaged-but-open still matches); queue-first
    (record exists before the runner is called, gone after success); non-zero / timeout-shaped
    runner result → queued, rc 0, warn; flush grouping by run, create-before-comment across a UTC
    midnight, per-run failure isolation, `attempts` → `.failed` at 3, bounded auto-flush; two filings
    in one ms → two queue files; `scrubSecrets` table (incl. PEM, URL userinfo, `ghs_`);
    `issueTitle` normalization; identity block; `runReflect` once then rc 1, `NO_RUN_ISSUE`;
    consent absent → `CONSENT=needed` + queued, `no` → queued forever, `yes` → filed; env guard
    wins over consent; `findings.log` line per kind; spawn-failure run under the worker dir;
    same-slug sequential runs → two issues; design→implement on one slug → two issues, implement's
    `reflect` not refused.
  - `tests/forensics*.test.ts`, `tests/quick-forensics.test.ts` — re-pointed; deleted-scraper cases
    removed. The three helper readers re-pointed (§H).
  - `tests/autoresearch-corpus.test.ts` — seeds `prior/findings.log` instead of a fake forensics tree.
  - `tests/review-core.test.ts`, `tests/review-cmd.test.ts` — `isTriaged` predicate table (label,
    marker comment, recurrence newer than marker → untriaged), `lastEventAt`, `clusterByTitle`,
    survey TSV/TRENDS over a fake issue list, `--since`/`--command`, archive argv + fallback comment,
    consent verb, `--all` rejected, every argv carries `--repo WingsOfPanda/agglomeration-platform`.
  - `tests/review-directive.test.ts` (new, whitespace-collapsed pins): each command's `.md` names
    `<cmd> reflect <TOPIC> @`, `ISSUE=`, `QUEUED=`, `CONSENT=needed`; `commands/review.md` carries
    `review flush`, `review consent`, `Closes #`, `--add-label triaged`, `--repo
    WingsOfPanda/agglomeration-platform` on its `gh` lines, and no `ssh`/`xjp`/`.reviewed`;
    `commands/job.md` says detached runs never ask for consent.
- `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — 0.5.62;
  `dist/ap.cjs` rebuilt and committed by the hub.

## Testing

Pure unit tests as enumerated; the `gh` boundary is the fake runner's recorded argv, the file
boundary is a fresh `AP_HOME`, and the env guard — enforced inside `forensicsRunner` itself, so it
covers `review survey`/`archive` as well as filing — makes live `gh` unreachable from any test or
child process. Live: the first ≥0.5.62 `/ap:quick` on this box (one deliberate `flag`) must ask
for consent once, then show one issue with the identity block, the flag/findings/reflection
comments, `issue.txt` under `_quick`; `/ap:review` lists it, `archive` labels it; a second run on
the same slug opens a second issue; then the same on xjp.

## Success Criteria

- `npm run typecheck`, `lint`, `test` green; `dist/ap.cjs` fresh; stale-token gate untouched.
- Every `gh` argv in `src/` and in `commands/review.md` carries `--repo WingsOfPanda/agglomeration-platform`.
- A run with findings/flags produces exactly one open issue `[ap:<command>] …` with the metadata
  block, one comment per flag/findings/reflection, and `<artDir>/issue.txt`; a clean run files and
  writes nothing; two runs on one slug → two issues.
- With no consent → nothing posted, `CONSENT=needed`, queued; `no` → never posted; `yes` → posted.
- With `gh` absent, failing or hung (15 s) → rc 0, one queue record, run unaffected; `review flush`
  drains in run order, dead-letters a permanently failing record, and never blocks on it.
- The same failure on two boxes → one issue plus a `seen again` comment; a recurrence on a triaged
  issue shows up in the next survey.
- Credential patterns in §D never reach GitHub (table-tested); origin posts without userinfo.
- No code path writes `~/.ap/forensics/<date>/`, `.reviewed/` or `.trends.json`; `forensics_flags`
  in the autoresearch corpus keeps counting.
- No test can spawn live `gh` (env guard set in setup and enforced at the `gh` boundary itself;
  asserted by a test that unsets consent and checks the runner was never invoked).

## Non-goals (settled — do not re-propose)

- A private feedback repo / making the plugin repo private (Q2); body-level redaction beyond §D
  (Q6/Q12/Q13); a config knob instead of the ask-once consent (Q16).
- Keeping a full local copy on the happy path (Q14); per-finding or per-signature issues (Q3);
  the hub running `gh` from the directive for filing (Q4); failing a run when filing fails (Q5);
  `flag --private` (Q9); verb-applied labels (Q10); migrating pre-0.5.62 records; the four
  never-firing scrapers (Q15).
- A locked idempotent journal for the queue — dedup-on-create plus the per-run lock and per-run
  flush ordering cover the real cases; the cross-run same-title double-create and the
  crash-after-success duplicate comment are accepted.
- Fixing `archive.ts:74`'s `rmSync(td, { recursive: false })` (throws EISDIR even on an empty topic
  dir — pre-existing, out of scope).
