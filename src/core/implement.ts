// src/core/implement.ts
// CORE paths / parse / target-resolution + provider-detection for /ap:implement.
// Byte-faithful port of the prior bash plugin's deploy core helpers (cosmetic rebrand: _deploy/ ->
// _implement/, worker-noun -> "worker", deploy env prefix -> AP_IMPLEMENT_*). Logic preserved verbatim.
import { join, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { topicDir } from "./paths.js";
import { kvParse } from "../args.js";

/** `_implement` art dir for a topic. Honors AP_IMPLEMENT_ART_DIR_OVERRIDE; else <topicDir>/_implement. */
export function implementArtDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  const override = process.env.AP_IMPLEMENT_ART_DIR_OVERRIDE;
  if (override) return override;
  return join(topicDir(topic, opts), "_implement");
}

/** Topic state dir for a implement invocation. */
export function implementTopicDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return topicDir(topic, opts);
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
  force: boolean;
}

export class ImplementArgError extends Error { code = 2; }

/** Parse the implement args tokens (port of deploy-init's argv parser). Default branch-on; --no-branch
 *  opts out. --max-rounds is REJECTED (the directive strips it before init). */
export function parseImplementArgs(tokens: string[]): ImplementArgs {
  let branchMode: "branch" | "no-branch" = "branch";
  let branchName: string | undefined;
  let topic: string | undefined;
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
    if (t.startsWith("-")) throw new ImplementArgError(`implement init: unknown flag '${t}'`);
    rest.push(t);
  }
  return { rest: rest.join(" "), branchMode, branchName, topic, force };
}

/** Port of deploy_detect_provider. plugin.json present -> claude; else codex. (The --provider override
 *  is intentionally dropped at the directive level; implement.md uses a runtime claude-confirm gate.) */
export function detectProvider(repoRoot: string): "codex" | "claude" {
  return existsSync(join(repoRoot, ".claude-plugin", "plugin.json")) ? "claude" : "codex";
}

export interface IterTarget { slug: string; cwd: string; }

/** Port of deploy_iter_targets. Single-repo synthesizes one 'main' row from target_cwd.txt; absent -> []. */
export function iterTargets(topic: string, opts?: { home?: string; cwd?: string }): IterTarget[] {
  const art = implementArtDir(topic, opts);
  const targetCwdFile = join(art, "target_cwd.txt");
  if (existsSync(targetCwdFile)) {
    const cwd = readFileSync(targetCwdFile, "utf8").replace(/\n$/, "");
    return [{ slug: "main", cwd }];
  }
  return [];
}
