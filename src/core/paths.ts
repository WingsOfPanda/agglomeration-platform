import { createHash } from "node:crypto";
import { realpathSync, mkdirSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { assertSlug } from "./slug.js";

export function globalRoot(home?: string): string {
  return home ?? process.env.AP_HOME ?? join(homedir(), ".ap");
}

/** Plugin install root. Precedence: explicit CLAUDE_PLUGIN_ROOT override -> self-locate from the
 *  running bundle (<root>/dist/ap.cjs) -> process.cwd(). The self-locate tier fixes the case
 *  where command files interpolate ${CLAUDE_PLUGIN_ROOT} into the bundle path but never export it,
 *  so the node child would otherwise fall back to cwd (the target repo). The existsSync guard on a
 *  known shipped asset keeps tests/`node -e` (argv[1] not the bundle) on the cwd fallback. Single
 *  source of truth. */
export function pluginRoot(): string {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  try {
    const root = dirname(dirname(realpathSync(process.argv[1])));
    if (existsSync(join(root, "config", "prompt-templates", "identity.md"))) return root;
  } catch { /* argv[1] missing/unreadable — fall through */ }
  return process.cwd();
}

export function stateRoot(opts?: { home?: string; cwd?: string }): string {
  if (opts?.home) return opts.home;
  if (process.env.AP_HOME) return process.env.AP_HOME;
  return join(opts?.cwd ?? process.cwd(), ".ap");
}

function ensureGitignore(dir: string): void {
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
}

export function stateEnsure(): string {
  const root = stateRoot();
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "archive"), { recursive: true });
  ensureGitignore(root);
  return root;
}

export function repoHash(cwd: string = process.cwd()): string {
  let real: string;
  try { real = realpathSync(cwd); } catch { real = cwd; }
  return createHash("sha256").update(real, "utf8").digest("hex");
}

export function repoStateDir(opts?: { home?: string; cwd?: string }): string {
  return join(stateRoot(opts), "state", repoHash(opts?.cwd));
}
/** The containment choke point: every art dir (design/explore/implement/quick/bridge/autoresearch),
 *  archive, stop, preflight and ipc path derives from these two, so gating the segments here refuses
 *  a `../` topic/agent for every verb at once instead of at ~90 call sites. `model` stays ungated —
 *  it comes from contracts.yaml, not from an operator arg, and spawn never validated it either. */
export function topicDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(repoStateDir(opts), assertSlug("topic", topic));
}
export function workerDir(agent: string, model: string, topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), `${assertSlug("agent", agent)}-${model}`);
}

/** The detached-job art dir. `_job` is an art dir like `_implement`/`_quick`, so isArtifactDir
 *  already keeps every worker scan (list, stop, archive) from mistaking it for a worker. */
export function jobDir(topic: string, opts?: { home?: string; cwd?: string }): string {
  return join(topicDir(topic, opts), "_job");
}

/** Resolve a state-dir path for COMPARISON: realpath when it exists, otherwise the path itself with
 *  any trailing slashes dropped. A tree that is symlinked (the workaround a field run reached for)
 *  must compare EQUAL to its target, and a path that no longer resolves must still compare, not
 *  throw. Mirrors repoHash's realpath-or-self discipline. */
function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p.replace(/(.)\/+$/, "$1"); }
}
/** Do two paths name the same state directory? The one comparison behind the hub-side state-tree
 *  agreement guard (send) -- symlink-tolerant by construction, so the guard fires on a genuinely
 *  different tree and never on the same tree reached by another name. */
export function sameStateDir(a: string, b: string): boolean {
  return realOrSelf(a) === realOrSelf(b);
}

export function repoRoot(cwd: string = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

export function isArtifactDir(p: string): boolean {
  return basename(p.replace(/\/+$/, "")).startsWith("_");
}

export function runArgsFile(command: string, prefix?: string): string {
  stateEnsure();
  const argsDir = join(stateRoot(), "_args");
  mkdirSync(argsDir, { recursive: true });
  const f = mkdtempSync(join(argsDir, `${prefix ?? command}.`)) + "/args";
  writeFileSync(f, ""); // placeholder file at a unique path
  return f;
}

export function activeProvidersPath(gRoot: string = globalRoot()): string {
  const active = join(gRoot, "providers-active.txt");
  return existsSync(active) ? active : join(gRoot, "providers-available.txt");
}
