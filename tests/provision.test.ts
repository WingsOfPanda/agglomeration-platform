// tests/provision.test.ts — the site-packages shadow detector and the PYTHONPATH pin it derives.
//
// Everything runs over a SYNTHETIC site tree under an injected `home`/`env`: no interpreter, no
// subprocess, and `process.env.HOME` is never touched (that would also flip wrapLaunch's default).
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinFor, pinReport, pythonPin, shadowHits, siteDirs, type ShadowHit } from "../src/core/provision.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
/** A fake HOME whose user site is `<home>/.local/lib/python3.12/site-packages`, returned too. */
function homeWithSite(): { home: string; site: string } {
  const home = tmp("ap-prov-home-");
  const site = join(home, ".local", "lib", "python3.12", "site-packages");
  mkdirSync(site, { recursive: true });
  return { home, site };
}
/** A fake repo root with `src/` and `pkg/`, and its ap-created worktree carrying the same. */
function repoAndWorktree(): { root: string; target: string } {
  const root = tmp("ap-prov-repo-");
  const target = join(root, ".ap", "worktrees", "demo");
  for (const base of [root, target]) { mkdirSync(join(base, "src"), { recursive: true }); mkdirSync(join(base, "pkg"), { recursive: true }); }
  return { root, target };
}
const ENV = {} as NodeJS.ProcessEnv;
const finderText = (mapping: string, namespaces = "{}") =>
  `from importlib.machinery import PathFinder\n\nMAPPING: dict[str, str] = ${mapping}\nNAMESPACES: dict[str, list[str]] = ${namespaces}\n\nclass _EditableFinder:\n    pass\n`;

describe("shadowHits — what on the box resolves this repo from the main checkout", () => {
  it("a plain .pth line under the root is a hit whose importRoot is that directory (the iriscortex-src.pth shape)", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    writeFileSync(join(site, "iriscortex-src.pth"), `${join(root, "src")}\n`);
    expect(shadowHits(root, home, ENV)).toEqual([{ source: `${join(site, "iriscortex-src.pth")}:1`, importRoot: join(root, "src") }]);
  });

  it("a .pth line naming the root ITSELF is a hit with importRoot = root", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    writeFileSync(join(site, "proj.pth"), `${root}\n`);
    expect(shadowHits(root, home, ENV).map((h) => h.importRoot)).toEqual([root]);
  });

  // The prefix test is `root` or `root + "/"`, never `includes`: a sibling checkout whose name merely
  // starts with the root's is a different tree, and pinning it would re-root the wrong project.
  it("a line naming <root>-old is NOT a hit, and neither is a relative line that resolves elsewhere", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    writeFileSync(join(site, "other.pth"), `${root}-old\n${root}-old/src\nsome/relative/dir\n`);
    expect(shadowHits(root, home, ENV)).toEqual([]);
  });

  it("blank and # lines are skipped, as site.addpackage skips them", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    writeFileSync(join(site, "c.pth"), `# ${root}\n\n   \n${join(root, "pkg")}\n`);
    expect(shadowHits(root, home, ENV)).toEqual([{ source: `${join(site, "c.pth")}:4`, importRoot: join(root, "pkg") }]);
  });

  // The live shape on this box: an exec-only .pth whose sibling finder carries the MAPPING. The value
  // is the PACKAGE dir; the import root python needs is its parent.
  it("a __editable___*_finder.py MAPPING naming <root>/pkg is a hit with importRoot = <root>", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    const finder = join(site, "__editable___pkg_0_1_0_finder.py");
    writeFileSync(finder, finderText(`{'pkg': '${join(root, "pkg")}'}`));
    writeFileSync(join(site, "__editable__.pkg-0.1.0.pth"), "import __editable___pkg_0_1_0_finder; __editable___pkg_0_1_0_finder.install()\n");
    expect(shadowHits(root, home, ENV)).toEqual([{ source: `${finder}:3`, importRoot: root }]);
  });

  // The live artifact's NAMESPACES dict names 55 subdirectories of the same tree. They are NOT import
  // roots — reading them would turn one hit into fifty-six and the pin into a 56-entry list.
  it("a populated NAMESPACES line adds no hit: only the MAPPING value's parent is an import root", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    const finder = join(site, "__editable___ns_finder.py");
    writeFileSync(finder, finderText(`{'pkg': '${join(root, "pkg")}'}`,
      `{'pkg.sub': ['${join(root, "pkg", "sub")}'], 'pkg.sub.deeper': ['${join(root, "pkg", "sub", "deeper")}'], 'pkg.tests': ['${join(root, "pkg", "tests")}']}`));
    expect(shadowHits(root, home, ENV)).toEqual([{ source: `${finder}:3`, importRoot: root }]);
  });

  // A MAPPING value that IS the root has no import root inside the repo: its parent is OUTSIDE, and
  // re-rooting that would export `<worktree>/..` — the worktrees dir — onto PYTHONPATH.
  it("a MAPPING value equal to the root itself yields no hit rather than a pin outside the worktree", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    writeFileSync(join(site, "__editable___self_finder.py"), finderText(`{'repo': '${root}'}`));
    expect(shadowHits(root, home, ENV)).toEqual([]);
  });

  it("a src-layout MAPPING (<root>/src/pkg) re-roots to <root>/src, and a foreign MAPPING is ignored", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    const finder = join(site, "__editable___two_finder.py");
    writeFileSync(finder, finderText(`{'pkg': '${join(root, "src", "pkg")}', 'other': '/elsewhere/other'}`));
    expect(shadowHits(root, home, ENV)).toEqual([{ source: `${finder}:3`, importRoot: join(root, "src") }]);
  });

  // An exec line the sibling finder accounts for is the ordinary setuptools case: no extra hit. One
  // NO finder accounts for that NAMES this checkout is the hand-rolled `import sys;
  // sys.path.insert(0, '<main>')` idiom #183 describes, which cannot be resolved to an import root
  // textually — warned about, never pinned.
  it("an exec line WITH its sibling finder parsed adds nothing; one with NO finder that names the root is a warn-only hit", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    writeFileSync(join(site, "__editable___pkg_finder.py"), finderText(`{'pkg': '${join(root, "pkg")}'}`));
    writeFileSync(join(site, "__editable__.pkg.pth"), "import __editable___pkg_finder; __editable___pkg_finder.install()\n");
    writeFileSync(join(site, "hand-rolled.pth"), `import sys; sys.path.insert(0, '${root}')\n`);
    const hits = shadowHits(root, home, ENV);
    expect(hits).toEqual([
      { source: `${join(site, "__editable___pkg_finder.py")}:3`, importRoot: root },
      { source: `${join(site, "hand-rolled.pth")}:1`, importRoot: null },
    ]);
  });

  // setuptools' distutils-precedence.pth and virtualenv's _virtualenv.pth are exec-only, finder-less,
  // and present in every venv. A warn on them would fire on every run on every box — the exact
  // clean-box silence this layer promises. Naming the root is what makes an exec line this repo's.
  it("an exec line that names NOTHING under the root is silent, however finder-less (distutils-precedence.pth, _virtualenv.pth)", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    writeFileSync(join(site, "distutils-precedence.pth"), "import os; var = 'SETUPTOOLS_USE_DISTUTILS'; enabled = os.environ.get(var, 'local') == 'local'; enabled and __import__('_distutils_hack').add_shim();\n");
    writeFileSync(join(site, "_virtualenv.pth"), "import _virtualenv\n");
    writeFileSync(join(site, "other-proj.pth"), `import sys; sys.path.insert(0, '${root}-old')\n`);
    expect(shadowHits(root, home, ENV)).toEqual([]);
  });

  // Python source is not whitespace-delimited: the commonest spellings of the #183 idiom put the root
  // straight after a quote or a comma. The root is recognised as a BOUNDED substring, so a sibling
  // tree whose name merely extends the root's (`<root>-old`) stays silent.
  it("append('<root>') and insert(0,'<root>') — no whitespace around the root — are warn-only hits; <root>-old is not", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    writeFileSync(join(site, "a.pth"), `import sys; sys.path.append('${root}')\n`);
    writeFileSync(join(site, "b.pth"), `import sys; sys.path.insert(0,'${root}')\n`);
    writeFileSync(join(site, "c.pth"), `import os, sys; sys.path[:0] = ["${join(root, "src")}"]\n`);
    writeFileSync(join(site, "d.pth"), `import sys; sys.path.insert(0,'${root}-old')\n`);
    writeFileSync(join(site, "e.pth"), `import sys; sys.path.append('${root}-old/src')\n`);
    expect(shadowHits(root, home, ENV)).toEqual([
      { source: `${join(site, "a.pth")}:1`, importRoot: null },
      { source: `${join(site, "b.pth")}:1`, importRoot: null },
      { source: `${join(site, "c.pth")}:1`, importRoot: null },
    ]);
  });

  it("an unreadable finder leaves its exec line unaccounted for: named root -> warn-only hit", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    // a finder that is a DIRECTORY reads as unreadable, so nothing under it was parsed
    mkdirSync(join(site, "__editable___pkg_finder.py"));
    writeFileSync(join(site, "__editable__.pkg.pth"), `import __editable___pkg_finder; __editable___pkg_finder.install()  # ${root}\n`);
    expect(shadowHits(root, home, ENV)).toEqual([{ source: `${join(site, "__editable__.pkg.pth")}:1`, importRoot: null }]);
  });

  it("an injected home with no .local/lib returns [] without throwing", () => {
    const home = tmp("ap-prov-empty-");
    const { root } = repoAndWorktree();
    expect(shadowHits(root, home, ENV)).toEqual([]);
    expect(shadowHits(root, join(home, "does-not-exist"), ENV)).toEqual([]);
  });

  it("a VIRTUAL_ENV (and CONDA_PREFIX) in the injected env is scanned, before the user site", () => {
    const { home, site } = homeWithSite();
    const { root } = repoAndWorktree();
    const venv = tmp("ap-prov-venv-");
    const vsite = join(venv, "lib", "python3.11", "site-packages");
    mkdirSync(vsite, { recursive: true });
    writeFileSync(join(vsite, "v.pth"), `${join(root, "src")}\n`);
    writeFileSync(join(site, "u.pth"), `${root}\n`);
    expect(siteDirs(home, { VIRTUAL_ENV: venv } as NodeJS.ProcessEnv)).toEqual([{ dir: vsite, prefix: venv }, { dir: site, prefix: join(home, ".local") }]);
    expect(shadowHits(root, home, { VIRTUAL_ENV: venv } as NodeJS.ProcessEnv).map((h) => h.importRoot)).toEqual([join(root, "src"), root]);
    expect(shadowHits(root, home, { CONDA_PREFIX: venv } as NodeJS.ProcessEnv).map((h) => h.importRoot)).toEqual([join(root, "src"), root]);
  });

  // `python -m venv .venv` (and uv's layout) put the venv INSIDE the repo. Its own site dir is then
  // under the root, and its `easy-install.pth`-style relative entries (`.`, `./x.egg`) resolve there —
  // that is the venv's tree, not a shadow of the checkout it sits in. Anything in that same venv that
  // names the repo proper (a `.pth` line, a finder MAPPING) is still exactly the shadow this detects.
  it("a venv INSIDE the repo: its own entries are not shadows, while entries there naming <root>/src or <root>/pkg still hit", () => {
    const home = tmp("ap-prov-empty-");
    const { root } = repoAndWorktree();
    const venv = join(root, ".venv");
    const vsite = join(venv, "lib", "python3.12", "site-packages");
    mkdirSync(vsite, { recursive: true });
    writeFileSync(join(vsite, "easy-install.pth"), ".\n./foo.egg\n");
    writeFileSync(join(vsite, "abs.pth"), `${join(vsite, "bar.egg")}\n`);
    const env = { VIRTUAL_ENV: venv } as NodeJS.ProcessEnv;
    expect(shadowHits(root, home, env)).toEqual([]);
    expect(shadowHits(root, home, ENV, [venv])).toEqual([]);          // the teardown widening, same rule
    writeFileSync(join(vsite, "proj.pth"), `${join(root, "src")}\n`);
    const finder = join(vsite, "__editable___pkg_finder.py");
    writeFileSync(finder, finderText(`{'pkg': '${join(root, "pkg")}'}`));
    expect(shadowHits(root, home, env)).toEqual([
      { source: `${finder}:3`, importRoot: root },
      { source: `${join(vsite, "proj.pth")}:1`, importRoot: join(root, "src") },
    ]);
  });

  it("the teardown widening scans the extra prefixes' site dirs too", () => {
    const home = tmp("ap-prov-empty-");
    const { root } = repoAndWorktree();
    const extra = join(root, ".venv");
    const xsite = join(extra, "lib", "python3.12", "site-packages");
    mkdirSync(xsite, { recursive: true });
    writeFileSync(join(xsite, "x.pth"), `${root}\n`);
    expect(shadowHits(root, home, ENV)).toEqual([]);
    expect(shadowHits(root, home, ENV, [extra]).map((h) => h.importRoot)).toEqual([root]);
  });
});

describe("pythonPin — the import root is derived and re-rooted, never a blind worktree root", () => {
  const hit = (importRoot: string | null): ShadowHit => ({ source: "x.pth:1", importRoot });

  it("an import root equal to the root maps to target; <root>/src maps to <target>/src", () => {
    const { root, target } = repoAndWorktree();
    expect(pythonPin(root, target, [hit(root)])).toEqual({ pin: target, unsafe: false, missing: [] });
    expect(pythonPin(root, target, [hit(join(root, "src"))])).toEqual({ pin: join(target, "src"), unsafe: false, missing: [] });
    expect(pythonPin(root, target, [hit(root), hit(join(root, "src"))]).pin).toBe(`${target}:${join(target, "src")}`);
  });

  // PYTHONPATH silently accepts a directory that is not there, so an entry with no counterpart in
  // the worktree is dropped AND named — never added as false confidence.
  it("an entry with no counterpart in target lands in missing and is dropped from the pin", () => {
    const { root, target } = repoAndWorktree();
    mkdirSync(join(root, "gone"));
    expect(pythonPin(root, target, [hit(join(root, "gone")), hit(root)])).toEqual({ pin: target, unsafe: false, missing: [join(target, "gone")] });
  });

  it("duplicates collapse, and warn-only hits contribute nothing", () => {
    const { root, target } = repoAndWorktree();
    expect(pythonPin(root, target, [hit(root), hit(null), hit(root)])).toEqual({ pin: target, unsafe: false, missing: [] });
    expect(pythonPin(root, target, [hit(null)])).toEqual({ pin: "", unsafe: false, missing: [] });
  });

  // The pin is interpolated into a single-quoted shell word and split on ":" by python: an entry
  // carrying a quote, `$`, a backtick, a backslash, a newline or a colon empties the pin instead.
  it("a target containing ' or $ (or a backtick, backslash, newline or :) sets unsafe with an EMPTY pin", () => {
    for (const bad of ["it's", "a$b", "a`b", "a\\b", "a\nb", "a:b", 'a"b']) {
      const parent = tmp("ap-prov-unsafe-");
      const root = join(parent, "repo"); mkdirSync(root);
      const target = join(root, ".ap", "worktrees", bad); mkdirSync(target, { recursive: true });
      expect(pythonPin(root, target, [hit(root)])).toEqual({ pin: "", unsafe: true, missing: [] });
    }
  });
});

describe("pinFor — the ONE gate all three application sites share", () => {
  function shadowed(): { home: string; root: string; target: string } {
    const { home, site } = homeWithSite();
    const { root, target } = repoAndWorktree();
    writeFileSync(join(site, "s.pth"), `${join(root, "src")}\n`);
    return { home, root, target };
  }
  it("is non-empty for <root>/.ap/worktrees/<topic> under a shadow fixture, re-rooted", () => {
    const { home, root, target } = shadowed();
    expect(pinFor(root, target, home, ENV)).toBe(join(target, "src"));
    expect(pinReport(root, target, home, ENV).hits).toHaveLength(1);
  });
  // The provenance gate, not a bare `!==`: an attached --target at an unrelated checkout must never
  // have THIS repo's re-rooted import path injected ahead of its own stdlib.
  it("is empty for a target that is not worktree-provenanced under root (attached --target elsewhere)", () => {
    const { home, root } = shadowed();
    const elsewhere = tmp("ap-prov-elsewhere-");
    mkdirSync(join(elsewhere, "src"));
    expect(pinFor(root, elsewhere, home, ENV)).toBe("");
    expect(pinFor(root, join(root, "wt", "feature"), home, ENV)).toBe("");
    expect(pinReport(root, elsewhere, home, ENV).hits).toEqual([]);
  });
  it("is empty for target === root (the hub pane's shape), and on a clean box", () => {
    const { home, root, target } = shadowed();
    expect(pinFor(root, root, home, ENV)).toBe("");
    expect(pinFor(root, target, tmp("ap-prov-clean-"), ENV)).toBe("");
  });
});
