---
description: Triage the ap forensics issues that quick/design/implement/explore/autoresearch file on the tracker — surface what is still untriaged, cluster recurring patterns with their lifetime trend, hand each fix off, then mark them triaged
allowed-tools: Bash, Read, AskUserQuestion
---

# /ap:review

Every ap command files what went wrong during a run as a GitHub issue on
`WingsOfPanda/agglomeration-platform` — one issue per run, titled `[ap:<command>] <first finding>`,
with the run metadata in the body and the hub's flags, the mechanical findings and the hub's
reflection as comments. A failed `spawn` files its own. Every box that runs ap files into the same
tracker, so this is the whole fleet's feedback, not this machine's.

This command triages what is still **untriaged**: survey the open issues, read them, cluster the
recurring ones, suggest one action each, hand the fixes off, then mark what you reviewed.
**Zero arguments needed.**

Let `CS="node ${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs"`.

## Steps

1. **Survey.** `$CS review survey` (pass through a user-supplied `--command <name>` /
   `--since <Nd|Nh>` only if they typed one — neither is required). It first flushes any locally
   queued records (bounded), then prints:
   - one TSV row per **untriaged** open issue: `<number>\t<title>\t<comments>\t<last_event>\t<url>`;
   - a `TRENDS` line, then one row per recurring title cluster:
     `<title>\t<open>\t<seen_again>\t<first>\t<last>`;
   - `QUEUE=<remaining>` when records could not be flushed — surface that number to the user, those
     problems are not on the tracker yet.

   An issue counts as triaged once it carries the `triaged` label or an `<!-- ap-triaged ... -->`
   marker comment — until a newer forensics comment lands on it, which makes it untriaged again. So
   a pattern that recurs after you triaged it comes back here on its own.

   A survey that FAILS (rc 1 — `gh` missing, unauthenticated, offline: no rows and no `TRENDS`)
   still prints `QUEUE=`/`CONSENT=needed` on stdout. Answer the consent question per step 2, then
   retry the survey; never read a failed survey as a healthy one.

2. **Consent — asked once per machine.** If a command prints `CONSENT=needed`, this machine has
   never answered whether ap may file to the public tracker. Call **AskUserQuestion**. Header
   `Issues`; question: "ap files run diagnostics as issues on the public repo
   github.com/WingsOfPanda/agglomeration-platform — one issue per run with the topic, hostname,
   username, paths, worker output and hub notes, for every repo you run ap in from this machine.
   Allow?"; options `Allow (recommended for the team)` / `Never on this machine` / `Not now`.
   Allow → `$CS review consent yes`, then `$CS review flush`, then re-run the survey.
   Never → `$CS review consent no` (records stay local, permanently).
   Not now → nothing; say the queue is holding and stop.

3. **Healthy short-circuit.** Zero issue rows before `TRENDS` → print
   `no untriaged ap issues; ap has been healthy` and stop (report `QUEUE=` if it is non-zero).
   Nothing to read, nothing to archive.

4. **Read the issues.** For each surveyed number:
   `gh issue view <n> --repo WingsOfPanda/agglomeration-platform --comments`
   (batch them into one Bash call with `---SEP---` separators). The body carries the run metadata
   block — ap version, command, topic, host/user, platform, providers, repo, art dir — and the
   comments carry the flags, the mechanical findings and the hub's reflection.

5. **Cluster.** Group issues whose failure matches — same normalized title, or the same
   `source` + meaningful `key`/`context` token across their findings (e.g. all
   `outbox` timeout events; all `part_note` flags on the same claim; all
   `spawn_failure reason=<reason>`). Rank clusters by count, descending.

6. **Annotate with the trend.** Match each cluster to its `TRENDS` row and state the lifetime
   recurrence from it — e.g. `3 open · 8 seen-again · first 2026-04-18, last 2026-08-29`. Say when
   a cluster spans more than one host or user: the same failure on two boxes is a platform bug, not
   a local one.

7. **Suggest one action per cluster:**
   - **3+ occurrences across distinct topics** → a fix now, or a spec topic under
     `docs/superpowers/specs/` when it needs a design first.
   - **2 occurrences** → watch list; a fix only if it is obvious and small.
   - **1 occurrence** → one-off, no action.

   Give every actionable cluster its hand-off line, verbatim and runnable:
   `/ap:quick "<the fix, one sentence>. Closes #<n>"` — or, when it needs a design doc first,
   `/ap:design "<the problem>"` then `/ap:implement <doc>` with `Closes #<n>` in the PR body.
   The `Closes #<n>` is what ties the fix back to the evidence.

8. **Surface the summary:**
   ```
   ## ap triage (<N> untriaged issues)

   ### Cluster 1 — <pattern> (<open> open · <seen_again> seen again · <first> → <last>)
   #<n> <title> — <url>
   Suggested action: <one concrete next step>
   Hand off: /ap:quick "<fix>. Closes #<n>"

   ### Cluster 2 — <pattern> (...)
   ...
   ```

9. **Mark them triaged.** `$CS review archive <n1> <n2> ...` with the numbers you actually reviewed
   — it runs `gh issue edit <n> --repo WingsOfPanda/agglomeration-platform --add-label triaged`, and
   when this account cannot label the repo it posts an `<!-- ap-triaged ... -->` marker comment
   instead (the survey treats the two identically). Report `<N> issues triaged`.

   Marking runs **after** the summary, so an interrupted run never hides problems you did not see.
   **Closing** an issue stays the maintainer's call — `gh issue close <n> --repo
   WingsOfPanda/agglomeration-platform` once the fix has landed, or let the `Closes #<n>` PR do it.
