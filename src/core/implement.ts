// src/core/implement.ts
// CORE paths / parse / target-resolution + provider-detection for /ap:implement.
// Byte-faithful port of the prior bash plugin's deploy core helpers (cosmetic rebrand: _deploy/ ->
// _implement/, worker-noun -> "worker", deploy env prefix -> AP_IMPLEMENT_*). Logic preserved verbatim.
import { join, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { topicDir } from "./paths.js";
import { kvParse } from "../args.js";

/** `_implement` art dir for a topic: <topicDir>/_implement. */
export function implementArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_implement");
}

/** Port of deploy_derive_topic: basename, strip leading YYYY-MM-DD-, then trailing -design.md else .md. */
export function deriveTopicFromPath(p: string): string {
  if (!p) return "";
  let base = basename(p);
  base = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  if (base.endsWith("-design.md")) base = base.slice(0, -"-design.md".length);
  else if (base.endsWith(".md")) base = base.slice(0, -".md".length);
  return base;
}

/** Topic-slug guard (port of the predecessor plugin's deploy topic assertion; same shape as
 *  spawn's 32-char cap). True iff `topic` matches ^[a-z0-9][a-z0-9-]{0,31}$ (1-32 chars, kebab,
 *  no leading dash). */
export function assertImplementTopic(topic: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(topic);
}

export interface ImplementArgs {
  rest: string;
  branchMode: "branch" | "no-branch";
  branchName?: string;
  topic?: string;
  /** An explicit target checkout, overriding the repo root. A detached run's `job start` creates an
   *  isolated worktree and passes it here, so the worker never checks a branch out in the main
   *  checkout the operator is still using. */
  target?: string;
  force: boolean;
}

export class ImplementArgError extends Error { code = 2; }

/** Parse the implement args tokens (port of deploy-init's argv parser). Default branch-on; --no-branch
 *  opts out. --max-rounds is REJECTED (the directive strips it before init). */
export function parseImplementArgs(tokens: string[]): ImplementArgs {
  let branchMode: "branch" | "no-branch" = "branch";
  let branchName: string | undefined;
  let topic: string | undefined;
  let target: string | undefined;
  let force = false;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--max-rounds" || t.startsWith("--max-rounds=")) {
      throw new ImplementArgError("--max-rounds must be stripped by the directive before init");
    }
    if (t === "--force") { force = true; continue; }
    if (t === "--no-branch") { branchMode = "no-branch"; continue; }
    if (t === "--branch" || t.startsWith("--branch=")) {
      const { value, shift } = kvParse(t, tokens[i + 1]); branchName = value; if (shift === 2) i++; continue;
    }
    if (t === "--topic" || t.startsWith("--topic=")) {
      const { value, shift } = kvParse(t, tokens[i + 1]); topic = value; if (shift === 2) i++; continue;
    }
    if (t === "--target" || t.startsWith("--target=")) {
      const { value, shift } = kvParse(t, tokens[i + 1]); target = value; if (shift === 2) i++; continue;
    }
    if (t.startsWith("-")) throw new ImplementArgError(`implement init: unknown flag '${t}'`);
    rest.push(t);
  }
  return { rest: rest.join(" "), branchMode, branchName, topic, target, force };
}

/** Port of deploy_detect_provider. plugin.json present -> claude; else codex. (The --provider override
 *  is intentionally dropped at the directive level; implement.md uses a runtime claude-confirm gate.) */
export function detectProvider(repoRoot: string): "codex" | "claude" {
  return existsSync(join(repoRoot, ".claude-plugin", "plugin.json")) ? "claude" : "codex";
}

/** The single target checkout recorded in target_cwd.txt; "" when the file is absent (single-repo:
 *  its state files are all keyed by the literal slug "main"). */
export function targetCwd(topic: string, opts?: { home?: string; cwd?: string }): string {
  const f = join(implementArtDir(topic, opts), "target_cwd.txt");
  return existsSync(f) ? readFileSync(f, "utf8").replace(/\n$/, "") : "";
}
