// src/commands/duet.ts — /consort:duet collaborative cross-repo session.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { applyArgsFile } from "../args.js";
import { atomicWrite } from "../core/atomic.js";
import { isoUtc } from "../core/archive.js";
import { instrumentBinary } from "../core/contracts.js";
import { haveCmd } from "../core/deps.js";
import { pickRandomInstrument } from "../core/instruments.js";
import { runnerAt } from "../core/gitwork.js";
import { runForensics, runFlag } from "../core/forensics.js";
import { parseDuetArgs, deriveSlug, duetArtDir, duetExecDir } from "../core/duet.js";

function usage(): number {
  log.error("usage: duet <init|branch|round-send|round-wait|relay|detect-test|finish|forensics|flag|summary> ...");
  return 2;
}

export async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "init": return initRun(applyArgsFile(rest, { valueFlags: new Set(["--provider", "--repo"]) }));
    case "forensics": return runForensics("duet", duetArtDir, rest[0]);
    case "flag": return runFlag("duet", rest[0], rest.slice(1).join(" "));
    default: return usage();
  }
}

export interface InitDeps {
  haveCmd(bin: string): boolean;
  instrumentBinary(provider: string): string | undefined;
  pickRandomInstrument(slug: string): string | null;
  isGitRepo(dir: string): boolean;
  headSha(dir: string): string;
}
const liveInitDeps: InitDeps = {
  haveCmd, instrumentBinary, pickRandomInstrument,
  isGitRepo: (dir) => runnerAt(dir).run("git", ["rev-parse", "--is-inside-work-tree"]).code === 0,
  headSha: (dir) => runnerAt(dir).run("git", ["rev-parse", "HEAD"]).stdout.trim(),
};

async function initRun(tokens: string[]): Promise<number> { return initWith(tokens, liveInitDeps); }

export async function initWith(tokens: string[], d: InitDeps): Promise<number> {
  const { repo, taskText, provider: provArg, inPlace } = parseDuetArgs(tokens);
  if (!taskText) { log.error("duet init: task text is empty"); return 1; }
  if (!repo) { log.error("duet init: --repo <abs-path> is required"); return 1; }
  if (!repo.startsWith("/") || /\s/.test(repo)) { log.error(`duet init: --repo must be a whitespace-free absolute path: '${repo}'`); return 1; }
  if (!existsSync(repo)) { log.error(`duet init: --repo does not exist: ${repo}`); return 1; }
  if (!inPlace && !d.isGitRepo(repo)) { log.error(`duet init: --repo is not a git repository (use --in-place to skip isolation): ${repo}`); return 1; }

  const slug = deriveSlug(taskText);
  if (!slug) { log.error("duet init: task produced an empty slug; provide alphanumerics"); return 1; }

  const provider = provArg ?? "codex";
  const binary = d.instrumentBinary(provider);
  if (!binary) { log.error(`duet init: provider '${provider}' has no entry in contracts.yaml`); return 3; }
  if (!d.haveCmd(binary)) { log.error(`duet init: ${provider}'s binary '${binary}' is not on PATH`); return 3; }

  const art = duetArtDir(slug);
  if (existsSync(art)) { log.error(`duet init: topic already in flight: ${art}`); log.error("  run /consort:coda or pick a different task"); return 2; }

  const instrument = d.pickRandomInstrument(slug);
  if (!instrument) { log.error(`duet init: no available instrument in the pool for '${slug}'`); return 1; }

  const mode = inPlace ? "in-place" : "branch";
  const exec = duetExecDir(slug);
  mkdirSync(exec, { recursive: true });
  atomicWrite(join(art, "topic.txt"), slug + "\n");
  atomicWrite(join(art, "topic-text.txt"), taskText);
  atomicWrite(join(art, "selected-provider.txt"), provider + "\n");
  atomicWrite(join(art, "instrument.txt"), instrument + "\n");
  atomicWrite(join(art, "timing.txt"), `started=${isoUtc()}\n`);
  atomicWrite(join(exec, "provider.txt"), provider + "\n");
  atomicWrite(join(exec, "mode.txt"), mode + "\n");
  atomicWrite(join(exec, "target_cwd.txt"), repo + "\n");      // INVARIANT: init owns this (branch is skipped under --in-place)
  atomicWrite(join(exec, "repo-b-head.txt"), (inPlace ? "" : d.headSha(repo)) + "\n");

  log.ok(`duet init: topic=${slug} instrument=${instrument} provider=${provider} mode=${mode} repo=${repo}`);
  process.stdout.write(`SLUG=${slug}\nINSTRUMENT=${instrument}\nPROVIDER=${provider}\nMODE=${mode}\nTARGET=${repo}\n`);
  return 0;
}
