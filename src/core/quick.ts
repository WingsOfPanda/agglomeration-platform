import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { topicDir } from "./paths.js";

export function quickArtDir(topic: string): string { return join(topicDir(topic), "_quick"); }
export function quickExecDir(topic: string): string { return join(quickArtDir(topic), "execute"); }

/** Lowercase → [a-z0-9-] → collapse dashes → trim → cap 20 → trim trailing dash. "" if no alphanumerics. */
export function deriveSlug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  return s;
}

export interface QuickArgs { topicText: string; provider?: string; finish: boolean; stashWip: boolean; target?: string; }

export function parseQuickArgs(tokens: string[]): QuickArgs {
  let provider: string | undefined;
  let target: string | undefined;
  let finish = true;
  let stashWip = false;
  const text: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--finish") { finish = true; continue; }      // legacy: now the default
    if (t === "--no-finish") { finish = false; continue; }
    if (t === "--stash-wip") { stashWip = true; continue; } // acted on by `quick branch`, never topic text
    if (t === "--provider") {
      const v = tokens[i + 1];
      if (v && !v.startsWith("--")) { provider = v; i++; }
      continue; // drop the bare --provider token regardless
    }
    if (t.startsWith("--provider=")) { provider = t.slice("--provider=".length); continue; }
    // Its VALUE must be consumed, not left to fall through: a bare path does not start with `--`,
    // so an unconsumed one would end up inside the topic text and change the derived slug.
    if (t === "--target") {
      const v = tokens[i + 1];
      if (v && !v.startsWith("--")) { target = v; i++; }
      continue;
    }
    if (t.startsWith("--target=")) { target = t.slice("--target=".length); continue; }
    text.push(t);
  }
  return { topicText: text.join(" ").trim(), provider, finish, stashWip, target };
}

export interface BranchArgs { topic: string; stashWip: boolean; target?: string; }

/** `quick branch [--stash-wip] [--target <abs>] <topic>` — the topic is the first token that is
 *  neither a flag nor a flag's value, so the flags parse on either side of it. "" topic when only
 *  flags were given (usage rc 2). Unknown `--flags` are still ignored rather than refused, as they
 *  always were here; only `--target` also swallows the token after it. */
export function parseBranchArgs(rest: string[]): BranchArgs {
  let topic = "", target: string | undefined, stashWip = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--stash-wip") { stashWip = true; continue; }
    if (t === "--target") {
      const v = rest[i + 1];
      if (v && !v.startsWith("--")) { target = v; i++; }
      continue;
    }
    if (t.startsWith("--target=")) { target = t.slice("--target=".length); continue; }
    if (t.startsWith("--")) continue;
    if (!topic) topic = t;
  }
  return { topic, stashWip, target };
}

/** Repo test command by file presence (never executes). Precedence:
 *  tests/run.sh > package.json "test" > Makefile test: > pytest > cargo test > go test.
 *  "" if none — a "" makes the hub verify-tests step emit VERDICT=none (no independent re-run),
 *  so a missing ecosystem here silently drops back to trusting the worker's own log. */
export function detectTestCommand(root: string): string {
  if (existsSync(join(root, "tests", "run.sh"))) return "bash tests/run.sh";
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try { if (JSON.parse(readFileSync(pkg, "utf8"))?.scripts?.test) return "npm test"; } catch { /* not JSON */ }
  }
  const mk = join(root, "Makefile");
  if (existsSync(mk)) {
    try { if (/^test:/m.test(readFileSync(mk, "utf8"))) return "make test"; } catch { /* unreadable */ }
  }
  if ((existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "setup.cfg"))) && existsSync(join(root, "tests"))) return "pytest";
  if (existsSync(join(root, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(root, "go.mod"))) return "go test ./...";
  return "";
}

export interface SummaryFacts {
  topic: string;
  status: "ok" | "aborted";
  started: string;
  ended?: string;
  duration?: number | string;
  provider: string;
  agent: string;
  branch: string;
  verify: string;
  diffStats: string;
  archived: string;
  targetCwd: string;
  branchBase: string;
  /** The first line of `execute/finish-result.txt` (`<action>\t<outcome>`), as bridge's summary
   *  reads it — what the run's finish actually did, so the hints below cannot contradict it. */
  finishResult: string;
  /** The HEAD `quick finish` read back after a `no-branch` refusal (`execute/finish-head.txt`). */
  finishHead: string;
  abortedPhase?: string;
  abortedGate?: string;
  abortedReason?: string;
}

export function renderSummary(f: SummaryFacts): string {
  const head = [
    "---",
    "command: quick",
    `topic: ${f.topic}`,
    `status: ${f.status}`,
    `started: ${f.started}`,
  ];
  if (f.status === "ok") {
    head.push(`ended: ${f.ended ?? "unknown"}`, `duration_seconds: ${f.duration ?? 0}`, "---", "");
    // A `no-branch` finish pushed nothing, so a checkout hint could name a branch that does not
    // exist. It covers three shapes though — nothing recorded, the record IS the start branch, or a
    // ref that went away — and only ONE of them means no branch was cut (a re-run that started on
    // feat/quick-<topic> lands here with the branch present and holding the work). So the line claims
    // nothing about the branch and names the HEAD finish read back. Outcome matched whole, not as a
    // substring: `branch-only (kept feat/quick-no-branch-x)` is not this case.
    const whereToLook = f.finishResult.split("\t")[1] === "no-branch"
      ? `- Nothing was pushed and no PR was opened — HEAD is on \`${f.finishHead}\` in ${f.targetCwd} (diff base: ${f.branchBase})`
      : `- Review the work: \`git -C ${f.targetCwd} checkout ${f.branch}\` (diff base: ${f.branchBase})`;
    return [
      ...head,
      "## Result",
      `- Provider: ${f.provider}`,
      `- Agent: ${f.agent}`,
      `- Branch: ${f.branch}`,
      `- Verify: ${f.verify}`,
      `- Diff: ${f.diffStats}`,
      "",
      "## Where to look",
      whereToLook,
      `- Archived state: ${f.archived}`,
      "",
    ].join("\n");
  }
  head.push(
    `aborted_phase: ${f.abortedPhase ?? "unknown"}`,
    `aborted_gate: ${f.abortedGate ?? "unknown"}`,
    `aborted_reason: ${f.abortedReason ?? "unknown"}`,
    "---",
    "",
  );
  return [
    ...head,
    "## Why aborted",
    `- ${f.abortedReason ?? "unknown"}`,
    // A fallback whose claude spawn ALSO fails aborts with the same `spawn-failed` reason as a
    // plain double-codex failure, so without this the two are indistinguishable. Gated on the
    // marker `quick summary` composes into the provider fact, never printed unconditionally: an
    // early abort has no selected-provider.txt yet and would render `- Provider: unknown`.
    ...(f.provider.includes("(fallback from ") ? [`- Provider: ${f.provider}`] : []),
    "",
    "## RESUME instructions",
    `- Read RESUME.md for the state pointer; re-run /ap:quick to retry.`,
    "",
  ].join("\n");
}

export interface ResumeFacts { topic: string; branch: string; artDir: string; phase: string; gate: string; stashNote?: string; }

export function renderResume(f: ResumeFacts): string {
  return [
    `# RESUME — ${f.topic} (aborted at ${f.phase}.${f.gate})`,
    "",
    "## State pointers",
    `- State dir: ${f.artDir}`,
    `- Topic: ${f.topic}`,
    `- Branch: ${f.branch}`,
    "",
    ...(f.stashNote ? ["## Parked WIP", `- ${f.stashNote}`, ""] : []),
    "## Manual resume",
    `- Inspect ${f.artDir}/execute/ for the worker's partial work, then re-run /ap:quick.`,
    "",
  ].join("\n");
}
