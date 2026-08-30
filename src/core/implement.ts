// src/core/implement.ts
// CORE paths / parse / target-resolution + provider-detection for /ap:implement.
// Byte-faithful port of the prior bash plugin's deploy core helpers (cosmetic rebrand: _deploy/ ->
// _implement/, worker-noun -> "worker", deploy env prefix -> AP_IMPLEMENT_*). Logic preserved verbatim.
import { join, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { topicDir } from "./paths.js";
import { kvParse } from "../args.js";
import { atomicWrite } from "./atomic.js";
import { readIfExists } from "./fsread.js";
import { recordHubFlag } from "./forensics.js";

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

// ---- provider fallback (0.5.64) — shared by BOTH `set-provider` verbs and their readers --------
// The directive switches a codex worker that failed to spawn twice over to claude. One file records
// it (`<art>/provider-fallback.txt`) and three surfaces read it back: `job status`'s KV stream,
// quick's SUMMARY.md provider line, and the flag on the run's issue. The line format is spelled
// once, here, so those three cannot drift apart. Lives in this core (not a module of its own, and
// not in forensics.ts whose catch-all would swallow a failed write) because it is the smaller of the
// two cores the two `set-provider` verbs already route through.

/** The CLOSED reason set `set-provider --reason` accepts — exactly the cold-start reasons the
 *  spawn-retry itself retries. Closed because all three sinks above are line-structured: free text
 *  injects `KEY=value` lines into `job status` and breaks the SUMMARY bullet's markdown. */
export const FALLBACK_REASONS: ReadonlySet<string> = new Set(["pane_dead", "timeout"]);

/** Write `<art>/provider-fallback.txt` and file the switch as a flag on the RUN's issue. Throws if
 *  the write fails (the verb turns that into rc 1); the flag is best-effort, as everywhere. */
export function recordProviderFallback(command: string, art: string, topic: string, from: string, to: string, reason: string): void {
  atomicWrite(join(art, "provider-fallback.txt"), `PROVIDER_FALLBACK=${from}->${to} reason=${reason}\n`);
  recordHubFlag({ command, topic, note: `PROVIDER_FALLBACK ${from}->${to} reason=${reason}: codex worker failed at spawn twice; continuing with claude` });
}

/** The recorded switch, or null when there was none. `raw` is the file's single line — what
 *  `job status` echoes verbatim; the parts are what quick's provider string composes from. */
export function readProviderFallback(art: string): { raw: string; from: string; to: string; reason: string } | null {
  const raw = readIfExists(join(art, "provider-fallback.txt")).trim();
  const m = /^PROVIDER_FALLBACK=(\S+)->(\S+) reason=(\S+)$/.exec(raw);
  return m ? { raw, from: m[1], to: m[2], reason: m[3] } : null;
}

/** Split `<topic> <provider> [--reason <r>]` into its positionals and the optional reason, shared
 *  by both `set-provider` verbs. `badReason` = the flag was given with no value (usage, rc 2);
 *  `reason: undefined` = the flag was absent, which is the pre-0.5.64 path in every respect. */
export function parseSetProviderArgs(rest: string[]): { pos: string[]; reason?: string; badReason: boolean } {
  const i = rest.indexOf("--reason");
  if (i < 0) return { pos: rest, badReason: false };
  const reason = rest[i + 1];
  return { pos: [...rest.slice(0, i), ...rest.slice(i + 2)], reason: reason ?? "", badReason: reason === undefined };
}
