// src/core/provision.ts — worktree environment parity: detect a site-packages SHADOW of this repo and
// derive the PYTHONPATH pin that makes a run worktree import its own tree.
//
// A detached run works in `<root>/.ap/worktrees/<topic>`, but a path-configuration file in the
// operator's site-packages (`iriscortex-src.pth`, or a setuptools editable finder's MAPPING) resolves
// the package from the MAIN checkout for every interpreter on the box — torchrun children of a
// worktree pytest run included (issues #183, #197). PYTHONPATH is the one mechanism that survives
// every hop a real job crosses, so ap derives ONE pin here and applies it at the three places it
// chooses a cwd: the worker pane (`spawn`), the hub's own test re-run (`implement verify-tests`), and
// the brief a quick hub prefixes onto its own gate run.
//
// Pure: `fs` reads and string surgery. No interpreter is ever consulted and no subprocess runs. Every
// read sits inside a `try` — an unreadable or absent site dir is silence, and silence is today's
// behaviour (no pin, no warn), the safe direction for an advisory channel.
//
// ponytail: only the user site (`<home>/.local`), `VIRTUAL_ENV` and `CONDA_PREFIX` are scanned, never
// the system site dirs, and no interpreter is asked — the upgrade path is `site.getsitepackages()`
// from the job's own python, which costs a python subprocess ap does not have.
// ponytail: a PEP 660 backend that installs its finder at `sys.meta_path[0]` and writes no plain
// `.pth` is invisible to a textual scan; it degrades to today's behaviour.
// ponytail: PYTHONPATH precedes the stdlib, so a pinned import root holding a stdlib-colliding
// top-level name (`types.py`, `select.py`) shadows it for every interpreter in the pane. Checked
// clean for the dogfood repo; written down rather than discovered later.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathTokensFrom } from "./implementScope.js";
import { worktreeProvenanced } from "./job.js";

/** One thing on the box that resolves this repo from the main checkout. `importRoot` is the directory
 *  python would put on `sys.path` for it (the `.pth` line itself, or the parent of a finder MAPPING
 *  value) — or `null` for a `.pth` exec line no parsed finder accounts for, which cannot be resolved
 *  textually and is therefore WARNED about and never pinned. */
export interface ShadowHit { source: string; importRoot: string | null; }

const under = (root: string, p: string): boolean => p === root || p.startsWith(root + sep);

/** `<prefix>/lib/python<ver>/site-packages`, the version discovered by listing rather than guessed. */
function siteDirsUnder(prefix: string): string[] {
  const lib = join(prefix, "lib");
  let names: string[];
  try { names = readdirSync(lib); } catch { return []; }
  return names.filter((n) => n.startsWith("python")).map((n) => join(lib, n, "site-packages")).filter((d) => existsSync(d));
}

/** A site dir together with the PREFIX that owns it — the `VIRTUAL_ENV` / `CONDA_PREFIX` value, the
 *  user site's `<home>/.local`, or a teardown extra. The prefix is what tells a venv that lives INSIDE
 *  the repo (`python -m venv .venv`, uv's layout) apart from the repo: an entry that resolves under
 *  the venv's own tree is that venv's, never a shadow of the checkout it happens to sit in. */
export interface SiteDir { dir: string; prefix: string; }

/** The site dirs a scan covers, in precedence order, de-duplicated by dir. `extraPrefixes` is the
 *  teardown widening (`<root>/.venv`, `<root>/venv` — a venv inside the worktree dies with it and is
 *  not scanned); a launch-time scan passes none. */
export function siteDirs(home: string, env: NodeJS.ProcessEnv, extraPrefixes: string[] = []): SiteDir[] {
  const prefixes = [env.VIRTUAL_ENV, env.CONDA_PREFIX, join(home, ".local"), ...extraPrefixes].filter((p): p is string => Boolean(p));
  const out: SiteDir[] = [];
  for (const prefix of prefixes) for (const dir of siteDirsUnder(prefix)) if (!out.some((s) => s.dir === dir)) out.push({ dir, prefix });
  return out;
}

/** A path under `root` that is NOT inside the prefix owning the site dir it was read from — the one
 *  test every signal shares. `<root>/.venv/lib/python3.12/site-packages` is under the repo root and
 *  under the venv prefix: the venv's own `easy-install.pth` entries (`.`, `./x.egg`) land there. */
const shadows = (root: string, prefix: string, p: string): boolean => under(root, p) && !under(prefix, p);

/** The hits a setuptools editable finder's `MAPPING` line yields, or null when the file could not be
 *  read (so its exec line in the sibling `.pth` stays unaccounted for). `NAMESPACES` is deliberately
 *  not read: subdirectories of the same tree, no new import root. */
function finderHits(file: string, root: string, prefix: string): ShadowHit[] | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const out: ShadowHit[] = [];
  text.split("\n").forEach((line, i) => {
    if (!/^MAPPING\b/.test(line)) return;
    for (const tok of pathTokensFrom(line)) {
      if (!isAbsolute(tok) || !under(root, tok)) continue;
      // The MAPPING value is the PACKAGE dir; its parent is what goes on sys.path. A value that IS the
      // root has no import root inside the repo to re-root, so it is skipped rather than pinned wrong.
      const importRoot = dirname(tok);
      if (shadows(root, prefix, importRoot)) out.push({ source: `${file}:${i + 1}`, importRoot });
    }
  });
  return out;
}

/** The hits one `.pth` yields, read the way `site.addpackage` does: blank and `#` lines skipped, an
 *  `import ` / `import\t` line executed (here: accounted for by a parsed sibling finder, or — when the
 *  line itself names this checkout — a warn-only hit), anything else joined onto the site dir.
 *
 *  The exec-line warn is gated on the line NAMING the root, not emitted for every unaccounted hook:
 *  setuptools' own `distutils-precedence.pth` and virtualenv's `_virtualenv.pth` are exec-only lines
 *  with no finder sibling and sit in every venv, so an unconditional warn would fire on every run on
 *  every box and break the clean-box silence this layer promises. The hand-rolled
 *  `import sys; sys.path.insert(0, '<main checkout>')` idiom of issue #183 carries its path textually
 *  and is still caught; a hook that computes the path degrades to today's behaviour. */
function pthHits(file: string, site: SiteDir, root: string, parsedFinders: Set<string>): ShadowHit[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const out: ShadowHit[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) return;
    if (line.startsWith("import ") || line.startsWith("import\t")) {
      const mod = line.slice("import".length).trim().split(/[;\s]/)[0] ?? "";
      if (parsedFinders.has(mod)) return;
      if (pathTokensFrom(line).some((t) => isAbsolute(t) && shadows(root, site.prefix, t))) out.push({ source: `${file}:${i + 1}`, importRoot: null });
      return;
    }
    const p = resolve(site.dir, line);
    if (shadows(root, site.prefix, p)) out.push({ source: `${file}:${i + 1}`, importRoot: p });
  });
  return out;
}

/** Everything in the scanned site dirs that resolves `root` from the main checkout. `home` and `env`
 *  are parameters so tests inject a synthetic site tree and never mutate `process.env.HOME` (which
 *  would also flip `wrapLaunch`'s bashrc default). */
export function shadowHits(root: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env, extraPrefixes: string[] = []): ShadowHit[] {
  const out: ShadowHit[] = [];
  for (const site of siteDirs(home, env, extraPrefixes)) {
    let names: string[];
    try { names = readdirSync(site.dir).sort(); } catch { continue; }
    // Finders FIRST: an exec line is accounted for only by a finder that was actually parsed.
    const parsed = new Set<string>();
    for (const n of names) {
      if (!/^__editable___.*_finder\.py$/.test(n)) continue;
      const hits = finderHits(join(site.dir, n), root, site.prefix);
      if (hits === null) continue;
      parsed.add(n.slice(0, -".py".length));
      out.push(...hits);
    }
    for (const n of names) if (n.endsWith(".pth")) out.push(...pthHits(join(site.dir, n), site, root, parsed));
  }
  return out;
}

export interface PinResult { pin: string; unsafe: boolean; missing: string[]; }

/** The pin is interpolated into a single-quoted shell word, and PYTHONPATH is colon-separated: an
 *  entry carrying any of these would either escape the quoting or split the pin. Input validation at a
 *  trust boundary — the entry is derived from the operator's own paths, but it is still a string
 *  ap did not write. */
const UNSAFE = /['"`$\\\n:]/;

/** Map every pinnable hit's import root onto `target` (`<root>/src` -> `<target>/src`; the root itself
 *  -> `target`), drop what does not exist there (PYTHONPATH accepts a missing directory silently, so
 *  it is NAMED instead), de-dupe, join. `unsafe` empties the pin: an unpinned worker is today's
 *  behaviour, a shell-escaped one is not. */
export function pythonPin(root: string, target: string, hits: ShadowHit[]): PinResult {
  const entries: string[] = [];
  const missing: string[] = [];
  for (const h of hits) {
    if (h.importRoot === null) continue;
    const mapped = join(target, relative(root, h.importRoot));
    if (!existsSync(mapped)) { if (!missing.includes(mapped)) missing.push(mapped); continue; }
    if (!entries.includes(mapped)) entries.push(mapped);
  }
  const unsafe = entries.some((e) => UNSAFE.test(e));
  return { pin: unsafe ? "" : entries.join(":"), unsafe, missing };
}

export interface PinReport extends PinResult { hits: ShadowHit[]; }
const NO_PIN: PinReport = { hits: [], pin: "", unsafe: false, missing: [] };

/** The ONE gate every application site shares. Empty unless `target` is a worktree ap itself created
 *  under `root`: `spawn --cwd` is validated only as an existing absolute path, so an attached
 *  `--target` at an unrelated checkout must never have THIS repo's re-rooted import path injected
 *  ahead of its own stdlib, and the hub pane (spawned at the root) stays unpinned so nothing the hub
 *  does in the main checkout is re-rooted. */
export function pinReport(root: string, target: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): PinReport {
  if (!worktreeProvenanced(target, root)) return NO_PIN;
  const hits = shadowHits(root, home, env);
  return { hits, ...pythonPin(root, target, hits) };
}

/** The pin string alone — `""` means "apply nothing", byte-identical to today at every site. */
export function pinFor(root: string, target: string, home?: string, env?: NodeJS.ProcessEnv): string {
  return pinReport(root, target, home, env).pin;
}
