# Shipped Config Always Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plugin always read the shipped (versioned) `contracts.yaml`/`agents.yaml` so config fixes land on every update, drop the stale `~/.ap` config shadow, and self-heal the existing copies.

**Architecture:** `contractsPath()`/`agentsPath()` return the `pluginRoot()/config/<file>` path unconditionally (no `globalRoot()` shadow). `/ap:check` stops auto-copying config into `~/.ap` and gains an idempotent `migrateConfigShadow()` self-heal that renames any leftover `~/.ap/contracts.yaml`/`agents.yaml` to `.bak`. Test fixtures inject shipped config via `CLAUDE_PLUGIN_ROOT` instead of the removed `AP_HOME` shadow.

**Tech Stack:** TypeScript (Node 18 target), esbuild single-bundle (`dist/ap.cjs`), vitest, eslint.

## Global Constraints

- `contractsPath()` and `agentsPath()` MUST return `join(pluginRoot(), "config", "<file>")` unconditionally — no `~/.ap`/`globalRoot()` shadow branch.
- `pluginRoot()` is unchanged (`CLAUDE_PLUGIN_ROOT` → self-locate from bundle → `process.cwd()`).
- `contracts.yaml`/`agents.yaml` **keys and filenames are unchanged** — only the directory they're read from changes. No wire-protocol change; `contracts.yaml` is read at... no — this IS a bundled-code change (resolvers + check), so `dist/ap.cjs` MUST be rebuilt.
- `providers-available.txt` / `providers-active.txt` are NOT touched by this work.
- `migrateConfigShadow` is best-effort (`try/catch`, `log.warn` on failure, never throws) and idempotent (no shadow → no-op).
- No emojis in shipped output; errors to stderr via `log.error`.
- Test fixtures inject shipped config via `CLAUDE_PLUGIN_ROOT=<tmp>` + `<tmp>/config/<file>` (the established seam). `AP_HOME` is only for state dirs / staging a shadow.
- Version is 3-way synced (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`); current `0.3.9` → ships as `0.3.10`. `tests/manifest.test.ts` enforces it.

---

### Task 1: Resolvers always read shipped config

`contractsPath()`/`agentsPath()` stop honoring the `~/.ap` shadow. Because the test fixtures currently inject via that shadow (`AP_HOME`), migrate them to `CLAUDE_PLUGIN_ROOT` in the same task and add a test proving a shadow is now ignored.

**Files:**
- Modify: `src/core/contracts.ts` (imports + `contractsPath`)
- Modify: `src/core/agents.ts` (imports + `agentsPath`)
- Test: `tests/contracts.test.ts`, `tests/agents.test.ts`

**Interfaces:**
- Produces: `contractsPath(): string` → `join(pluginRoot(), "config", "contracts.yaml")`; `agentsPath(): string` → `join(pluginRoot(), "config", "agents.yaml")`. Both ignore any `~/.ap/<file>`.

- [ ] **Step 1: Migrate the test seams to `CLAUDE_PLUGIN_ROOT` and add shadow-ignored tests**

In `tests/contracts.test.ts`: add `mkdirSync` to the `node:fs` import, and replace the helper + `afterEach`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
// ...
afterEach(() => { delete process.env.CLAUDE_PLUGIN_ROOT; delete process.env.AP_HOME; });
function withContracts(yaml: string) {
  const root = mkdtempSync(join(tmpdir(), "ct-"));
  mkdirSync(join(root, "config"), { recursive: true });
  process.env.CLAUDE_PLUGIN_ROOT = root;
  process.env.AP_HOME = mkdtempSync(join(tmpdir(), "ct-home-")); // empty temp: neutralizes the real ~/.ap shadow
  writeFileSync(join(root, "config", "contracts.yaml"), yaml);
  return root;
}
```

(The empty `AP_HOME` matters: before Step 3 the old resolver still checks `globalRoot()/contracts.yaml`; pointing `AP_HOME` at an empty dir means no shadow leaks in from the real `~/.ap`, so the pre-existing cases pass via the `pluginRoot` fallback and only the shadow-ignored test fails.)

Add this test inside `describe("contracts", ...)`:

```ts
it("ignores a ~/.ap/contracts.yaml shadow; always reads shipped", () => {
  withContracts(SAMPLE);                                  // shipped: codex ready_timeout_s 90
  const shadow = mkdtempSync(join(tmpdir(), "shadow-"));
  process.env.AP_HOME = shadow;
  writeFileSync(join(shadow, "contracts.yaml"), "codex:\n  binary: codex\n  ready_timeout_s: 999\n");
  expect(K.agentReadyTimeout("codex")).toBe(90);          // shipped wins, shadow ignored
});
```

In `tests/agents.test.ts`: extend `afterEach` to clear `CLAUDE_PLUGIN_ROOT`, and replace `home()` so the pool is injected via `CLAUDE_PLUGIN_ROOT` (keep `AP_HOME` for the worker-state seeding):

```ts
afterEach(() => { delete process.env.AP_HOME; delete process.env.CLAUDE_PLUGIN_ROOT; delete process.env.CLAUDE_CODE_SESSION_ID; });
function home() {
  const h = mkdtempSync(join(tmpdir(), "in-"));
  process.env.AP_HOME = h;
  const pr = mkdtempSync(join(tmpdir(), "pr-"));
  mkdirSync(join(pr, "config"), { recursive: true });
  process.env.CLAUDE_PLUGIN_ROOT = pr;
  writeFileSync(join(pr, "config", "agents.yaml"), "agents:\n  - bravo\n  - alpha\n  - charlie\n");
  return h;
}
```

Add this test inside `describe("agents", ...)`:

```ts
it("loadAgentPool ignores a ~/.ap/agents.yaml shadow; reads shipped pool", () => {
  home();
  writeFileSync(join(process.env.AP_HOME!, "agents.yaml"), "agents:\n  - ghost\n");
  expect(I.loadAgentPool()).toEqual(["bravo", "alpha", "charlie"]); // shadow ignored
});
```

- [ ] **Step 2: Run tests to verify the shadow-ignored cases FAIL (and the rest pass)**

Run: `npx vitest run tests/contracts.test.ts tests/agents.test.ts`
Expected: the two new "ignores a … shadow" tests FAIL (current resolvers prefer the `~/.ap` shadow → codex=999 / pool=[ghost]). All pre-existing cases PASS (they now inject via `CLAUDE_PLUGIN_ROOT`, which the resolver's fallback branch already reads).

- [ ] **Step 3: Change the resolvers to always read shipped**

In `src/core/contracts.ts`, drop `globalRoot` from the import and simplify `contractsPath`:

```ts
import { globalRoot, pluginRoot } from "./paths.js";
```
becomes
```ts
import { pluginRoot } from "./paths.js";
```
and
```ts
export function contractsPath(): string {
  const user = join(globalRoot(), "contracts.yaml");
  return existsSync(user) ? user : join(pluginRoot(), "config", "contracts.yaml");
}
```
becomes
```ts
export function contractsPath(): string {
  return join(pluginRoot(), "config", "contracts.yaml");
}
```
(`existsSync` stays — `contractsExist()` still uses it.)

In `src/core/agents.ts`, drop `globalRoot` from the import and simplify `agentsPath`:

```ts
import { globalRoot, repoStateDir, topicDir, workerDir, isArtifactDir, pluginRoot } from "./paths.js";
```
becomes
```ts
import { repoStateDir, topicDir, workerDir, isArtifactDir, pluginRoot } from "./paths.js";
```
and
```ts
export function agentsPath(): string {
  const user = join(globalRoot(), "agents.yaml");
  return existsSync(user) ? user : join(pluginRoot(), "config", "agents.yaml");
}
```
becomes
```ts
export function agentsPath(): string {
  return join(pluginRoot(), "config", "agents.yaml");
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run tests/contracts.test.ts tests/agents.test.ts`
Expected: PASS — the two shadow-ignored tests now pass (resolvers ignore the shadow), and every pre-existing case still passes.

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts.ts src/core/agents.ts tests/contracts.test.ts tests/agents.test.ts
git commit -m "feat(config): contractsPath/agentsPath always read shipped config (drop ~/.ap shadow)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `/ap:check` stops copying, self-heals the shadow, fixes the error string

**Files:**
- Modify: `src/commands/check.ts` (imports, copy block → presence check, `migrateConfigShadow`, error string)
- Modify: `commands/check.md` (drop the manual `cp` refresh tip)
- Test: `tests/check.test.ts`

**Interfaces:**
- Consumes: `contractsPath()` (Task 1), `pluginRoot()`, `globalRoot()`.
- Produces: `migrateConfigShadow(): void` (module-private self-heal called inside `healthCheck`).

- [ ] **Step 1: Write the failing tests**

In `tests/check.test.ts`, replace the existing `it("ensures globalRoot and copies config when AP_HOME dir does not pre-exist", ...)` test with these two (it currently asserts the files ARE copied; they no longer are). Add `writeFileSync` to the `node:fs` import if not already present:

```ts
it("does NOT copy config into ~/.ap (reads shipped instead)", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "sc-")), "nested-not-yet"); // does NOT exist
  const prev = process.env.AP_HOME; process.env.AP_HOME = home;
  process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
  try {
    await check([]);                                       // must not throw
    expect(exists(join(home, "contracts.yaml"))).toBe(false); // no longer auto-copied
    expect(exists(join(home, "agents.yaml"))).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.AP_HOME; else process.env.AP_HOME = prev;
  }
});
it("migrateConfigShadow: a stale ~/.ap/contracts.yaml is backed up to .bak and removed", async () => {
  const home = mkdtempSync(join(tmpdir(), "mg-"));
  const prev = process.env.AP_HOME; process.env.AP_HOME = home;
  process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
  writeFileSync(join(home, "contracts.yaml"), "codex:\n  ready_timeout_s: 999\n"); // stale shadow
  try {
    await check([]);
    expect(exists(join(home, "contracts.yaml"))).toBe(false);    // shadow removed
    expect(exists(join(home, "contracts.yaml.bak"))).toBe(true); // backed up
  } finally {
    if (prev === undefined) delete process.env.AP_HOME; else process.env.AP_HOME = prev;
  }
});
```

(`exists` is the existing alias `import { ... existsSync as exists } from "node:fs"` at the top of `tests/check.test.ts`; add `writeFileSync` to that same import.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/check.test.ts`
Expected: FAIL — `check([])` still copies, so `contracts.yaml`/`agents.yaml` DO exist (first test fails), and the shadow is left in place, not renamed (second test fails: `.bak` absent).

- [ ] **Step 3: Update `check.ts` — imports, copy block, self-heal, error string**

(a) Swap `copyFileSync` for `renameSync` and add `contractsPath` to the contracts import:

```ts
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
```
becomes
```ts
import { existsSync, readFileSync, renameSync, mkdirSync } from "node:fs";
```
and
```ts
import { contractsExist, listAgents, agentBinary, agentConsultValidated } from "../core/contracts.js";
```
becomes
```ts
import { contractsExist, contractsPath, listAgents, agentBinary, agentConsultValidated } from "../core/contracts.js";
```

(b) Add `migrateConfigShadow` immediately after the `applyPaneBorders()` function:

```ts
/** Self-heal: ~/.ap/<file> config shadows are no longer read (the plugin reads the shipped,
 *  versioned config directly). Back up + remove any leftover shadow so it can't mask shipped
 *  updates. Best-effort and idempotent: no shadow -> no-op. */
function migrateConfigShadow(): void {
  for (const f of ["contracts.yaml", "agents.yaml"]) {
    const shadow = join(globalRoot(), f);
    if (!existsSync(shadow)) continue;
    try {
      renameSync(shadow, `${shadow}.bak`);
      log.ok(`config: removed stale shadow ~/.ap/${f} -> ${f}.bak (now tracking shipped)`);
    } catch { log.warn(`config: could not back up stale shadow ${shadow}`); }
  }
}
```

(c) Replace the copy-if-absent block (the `for (const f of ["contracts.yaml", "agents.yaml"]) { const dest = join(globalRoot(), f); ... }` loop) with a self-heal + shipped-presence check:

```ts
  migrateConfigShadow();
  for (const f of ["contracts.yaml", "agents.yaml"]) {
    const shipped = join(pluginRoot(), "config", f);
    if (existsSync(shipped)) log.ok(`config: ${f}`);
    else { log.error(`config: ${f} not shipped at ${shipped} — partial install`); fail = 1; }
  }
```

(d) Fix the now-misleading error path to print the path actually checked:

```ts
  if (!contractsExist()) { log.error(`contracts.yaml not found at ${join(globalRoot(), "contracts.yaml")}`); fail = 1; }
```
becomes
```ts
  if (!contractsExist()) { log.error(`contracts.yaml not found at ${contractsPath()}`); fail = 1; }
```

- [ ] **Step 4: Update `commands/check.md` — drop the manual refresh tip**

In `commands/check.md`, replace the `skip` bullet (it advertised a manual `cp` refresh that's no longer needed):

```markdown
- **`skip`** (0 validated providers) — stop here. If `skipped` is non-empty, add:
  `tip: your contracts.yaml may predate the current provider set; refresh it with
  cp "${CLAUDE_PLUGIN_ROOT}/config/contracts.yaml" ~/.ap/contracts.yaml`.
```
becomes
```markdown
- **`skip`** (0 validated providers) — stop here. (Config tracks the installed plugin version
  automatically — `/ap:check` self-heals any stale `~/.ap/contracts.yaml` shadow to `.bak`; no
  manual refresh.)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/check.test.ts`
Expected: PASS — `check([])` no longer copies config into `~/.ap` (first test), and a pre-existing shadow is renamed to `.bak` + removed (second test).

- [ ] **Step 6: Commit**

```bash
git add src/commands/check.ts commands/check.md tests/check.test.ts
git commit -m "feat(check): stop auto-copying config; self-heal the stale ~/.ap shadow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Release 0.3.10 — version bump, rebuild dist, full gate

**Files:**
- Modify: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`0.3.9` → `0.3.10`)
- Modify: `dist/ap.cjs` (rebuilt — this change touches bundled code)

- [ ] **Step 1: Bump the version in all three manifests**

Set `"version": "0.3.10"` in `package.json`, `.claude-plugin/plugin.json`, and the plugin entry in `.claude-plugin/marketplace.json` (each currently `0.3.9`).

- [ ] **Step 2: Verify the manifest sync test passes**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS (the three versions agree at 0.3.10).

- [ ] **Step 3: Rebuild the committed bundle**

Run: `npm run build`
Expected: esbuild writes `dist/ap.cjs` with no errors (this is a real code change, so the bundle changes).

- [ ] **Step 4: Run the full gate**

Run: `npm run typecheck && npm run test && npm run lint && npm run build`
Expected: typecheck clean; all tests pass (incl. the updated `contracts`/`agents`/`check` suites); eslint clean (no unused `globalRoot`/`copyFileSync` imports remain); build clean.

- [ ] **Step 5: Smoke-test that the resolver reads shipped through the bundle**

Run:
```bash
node dist/ap.cjs check 2>&1 | grep -E "config: (contracts|agents)\.yaml" | head -2
```
Expected: prints `config: contracts.yaml` and `config: agents.yaml` (shipped config found via the bundle; no copy step).

- [ ] **Step 6: Commit**

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json dist/ap.cjs
git commit -m "chore(release): shipped-config-always-wins, bump to 0.3.10

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `contractsPath()`/`agentsPath()` always shipped → Task 1. ✓
- Stop auto-copying in check → Task 2 (copy block replaced). ✓
- `migrateConfigShadow()` backup+remove, idempotent → Task 2 + tests. ✓
- Fix stale error string → Task 2 step 3(d). ✓
- Docs: drop the `cp` tip → Task 2 step 4. ✓
- Test seam `AP_HOME` → `CLAUDE_PLUGIN_ROOT` → Task 1 (contracts/agents) + Task 2 (check uses CLAUDE_PLUGIN_ROOT=cwd, unchanged). ✓
- Shadow-ignored + migration tests → Task 1 + Task 2. ✓
- `providers-*.txt` untouched → no task modifies them. ✓
- Version 3-way bump + dist rebuild → Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the exact before/after; every run step has an explicit expected result. ✓

**Type consistency:** `contractsPath()`/`agentsPath()`/`migrateConfigShadow()` signatures are consistent across tasks; Task 2 consumes `contractsPath` from Task 1's module; the `["contracts.yaml", "agents.yaml"]` file list is identical in `migrateConfigShadow` and the presence check. ✓
