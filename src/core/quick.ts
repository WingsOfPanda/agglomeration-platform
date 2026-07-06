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

export interface QuickArgs { topicText: string; provider?: string; finish: boolean; }

export function parseQuickArgs(tokens: string[]): QuickArgs {
  let provider: string | undefined;
  let finish = true;
  const text: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--finish") { finish = true; continue; }      // legacy: now the default
    if (t === "--no-finish") { finish = false; continue; }
    if (t === "--provider") {
      const v = tokens[i + 1];
      if (v && !v.startsWith("--")) { provider = v; i++; }
      continue; // drop the bare --provider token regardless
    }
    if (t.startsWith("--provider=")) { provider = t.slice("--provider=".length); continue; }
    text.push(t);
  }
  return { topicText: text.join(" ").trim(), provider, finish };
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
      `- Review the work: \`git -C ${f.targetCwd} checkout ${f.branch}\` (diff base: ${f.branchBase})`,
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
    "",
    "## RESUME instructions",
    `- Read RESUME.md for the state pointer; re-run /ap:quick to retry.`,
    "",
  ].join("\n");
}

export interface ResumeFacts { topic: string; branch: string; artDir: string; phase: string; gate: string; }

export function renderResume(f: ResumeFacts): string {
  return [
    `# RESUME — ${f.topic} (aborted at ${f.phase}.${f.gate})`,
    "",
    "## State pointers",
    `- State dir: ${f.artDir}`,
    `- Topic: ${f.topic}`,
    `- Branch: ${f.branch}`,
    "",
    "## Manual resume",
    `- Inspect ${f.artDir}/execute/ for the worker's partial work, then re-run /ap:quick.`,
    "",
  ].join("\n");
}
