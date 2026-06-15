// src/core/bridge.ts — pure helpers for /ap:bridge (collaborative cross-repo session).
import { join } from "node:path";
import { topicDir } from "./paths.js";

export { deriveSlug } from "./quick.js"; // one slug algorithm across commands

export interface BridgeArgs {
  repo?: string;       // repo B absolute path (the --repo value flag)
  taskText: string;    // the opening task (verbatim tail)
  provider?: string;
  inPlace: boolean;    // --in-place: edit repo B's current branch, no isolation
}

/** Mirror of parseQuickArgs, with --repo (value flag) and --in-place (boolean) added.
 *  --repo / --provider consume the next token only if present and not another flag (also the =form). */
export function parseBridgeArgs(tokens: string[]): BridgeArgs {
  let repo: string | undefined;
  let provider: string | undefined;
  let inPlace = false;
  const text: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--in-place") { inPlace = true; continue; }
    if (t === "--repo") { const v = tokens[i + 1]; if (v && !v.startsWith("--")) { repo = v; i++; } continue; }
    if (t.startsWith("--repo=")) { repo = t.slice("--repo=".length); continue; }
    if (t === "--provider") { const v = tokens[i + 1]; if (v && !v.startsWith("--")) { provider = v; i++; } continue; }
    if (t.startsWith("--provider=")) { provider = t.slice("--provider=".length); continue; }
    text.push(t);
  }
  return { repo, taskText: text.join(" ").trim(), provider, inPlace };
}

export function bridgeArtDir(topic: string): string { return join(topicDir(topic), "_bridge"); }
export function bridgeExecDir(topic: string): string { return join(bridgeArtDir(topic), "execute"); }

export interface BridgeResumeFacts {
  topic: string; repo: string; branch: string; mode: string; lastRound: number;
  task: string; phase: string; gate: string;
}
export function renderBridgeResume(f: BridgeResumeFacts): string {
  const restore = f.mode === "in-place"
    ? "(in-place run — no branch was cut; nothing to restore)"
    : `git -C ${f.repo} checkout <your-original-branch>   # the worker's work is on ${f.branch}`;
  return [
    `# RESUME — ${f.topic} (aborted at ${f.phase}.${f.gate})`,
    "",
    "## State pointers",
    `- Repo B: ${f.repo}`,
    `- Branch: ${f.branch} (mode: ${f.mode})`,
    `- Last round: ${f.lastRound}`,
    "",
    "## Opening task",
    f.task.trim(),
    "",
    "## Restore",
    `- ${restore}`,
    "- Forensic pointer only: /ap:bridge cannot auto-resume an in-flight slug — run /ap:stop to clear it, then re-run.",
    "",
  ].join("\n");
}

export interface BridgeSummaryFacts {
  topic: string; status: "ok" | "aborted"; started: string; ended?: string; duration?: number;
  provider: string; agent: string; repo: string; mode: string; branch: string;
  rounds: number; verify: string; diffStats: string; archived: string; finishResult: string;
  abortedPhase?: string; abortedGate?: string; abortedReason?: string;
}
export function renderBridgeSummary(f: BridgeSummaryFacts): string {
  const lines = [
    "---",
    "command: bridge",
    `topic: ${f.topic}`,
    `status: ${f.status}`,
    "---",
    "",
    `# bridge — ${f.topic}`,
    "",
    `- Repo B: ${f.repo}`,
    `- Mode: ${f.mode}`,
    `- Branch: ${f.branch}`,
    `- Agent: ${f.agent} (${f.provider})`,
    `- rounds: ${f.rounds}`,
    `- Verify: ${f.verify}`,
    `- Diff: ${f.diffStats}`,
    `- Finish: ${f.finishResult}`,
    `- Archived: ${f.archived}`,
    `- Timing: started=${f.started} ended=${f.ended ?? "(running)"} duration=${f.duration ?? 0}s`,
  ];
  if (f.status === "aborted") {
    lines.push("", `## Aborted`, `- Phase: ${f.abortedPhase ?? "unknown"}`, `- Gate: ${f.abortedGate ?? "unknown"}`, `- Reason: ${f.abortedReason ?? "unknown"}`);
  }
  lines.push("");
  return lines.join("\n");
}
