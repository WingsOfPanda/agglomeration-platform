# Publish-readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agglomeration-platform` cleanly installable via the Claude Code marketplace by closing the concrete publish gaps and locking installability behind a test.

**Architecture:** Marketplace-only distribution (keep `package.json` `"private": true`; no npm, no Codex). A new `tests/manifest.test.ts` guards manifest validity + version sync. README gains the missing `/ap:bridge` row and a getting-started path. `.gitignore` and the GitHub repo description are corrected. A `0.3.0 → 0.3.1` bump ships it — no `src/` change, so `dist/ap.cjs` stays byte-identical.

**Tech Stack:** TypeScript, Vitest, esbuild (committed `dist/ap.cjs`), `gh` CLI, JSON manifests.

**Spec:** `docs/superpowers/specs/2026-06-15-publish-readiness-design.md`

---

## File Structure

- **Create:** `tests/manifest.test.ts` — installability gate (manifest parse, source/dist paths exist, version sync, name consistency).
- **Modify:** `package.json` — version `0.3.0 → 0.3.1`.
- **Modify:** `.claude-plugin/marketplace.json` — `plugins[0].version` `0.3.0 → 0.3.1`.
- **Modify:** `.claude-plugin/plugin.json` — version `0.3.0 → 0.3.1`.
- **Modify:** `README.md` — add `/ap:bridge` Commands row + a "Getting started" subsection.
- **Modify:** `.gitignore` — replace stale `.consort/` with `.ap/`.
- **External (no file):** GitHub repo description via `gh repo edit`.

---

## Task 1: Manifest installability gate (test)

This test is a regression guard: it passes against the current tree (all three manifests already at `0.3.0`, all paths present). Task 2 then proves the guard bites by desyncing a version and watching it go red.

**Files:**
- Create: `tests/manifest.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

describe("plugin manifests (installability gate)", () => {
  const marketplace = read(".claude-plugin/marketplace.json");
  const plugin = read(".claude-plugin/plugin.json");
  const pkg = read("package.json");

  it("marketplace has a non-empty plugins array", () => {
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
  });

  it("each marketplace plugin source resolves to an existing directory", () => {
    for (const p of marketplace.plugins) {
      const dir = join(ROOT, p.source);
      expect(existsSync(dir), `source ${p.source} missing`).toBe(true);
      expect(statSync(dir).isDirectory(), `source ${p.source} not a dir`).toBe(true);
    }
  });

  it("plugin UserPromptSubmit hook references an existing dist/ap.cjs", () => {
    const cmd = plugin.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? "";
    expect(cmd).toContain("dist/ap.cjs");
    expect(existsSync(join(ROOT, "dist", "ap.cjs"))).toBe(true);
  });

  it("version is in sync across package.json, marketplace, and plugin manifests", () => {
    expect(marketplace.plugins[0].version).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
  });

  it("plugin name is consistent (ap)", () => {
    expect(plugin.name).toBe("ap");
    expect(marketplace.plugins[0].name).toBe("ap");
  });
});
```

- [ ] **Step 2: Run the test — expect PASS (invariant already holds)**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS, 5 tests green. (Unlike classic TDD, the guarded invariant is already true today; Task 2 demonstrates the red path.)

- [ ] **Step 3: Commit**

```bash
git add tests/manifest.test.ts
git commit -m "test(manifest): guard plugin manifest validity + version sync"
```

---

## Task 2: Version bump 0.3.0 → 0.3.1

**Files:**
- Modify: `package.json:3`
- Modify: `.claude-plugin/marketplace.json:12`
- Modify: `.claude-plugin/plugin.json:3`

- [ ] **Step 1: Bump `package.json` only (to trigger the guard)**

In `package.json`, change:
```json
  "version": "0.3.0",
```
to:
```json
  "version": "0.3.1",
```

- [ ] **Step 2: Run the manifest test — expect FAIL (guard bites)**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL on "version is in sync…" — `expected "0.3.1" received "0.3.0"`. This proves the gate catches a desynced manifest. The other 4 tests stay green.

- [ ] **Step 3: Bump the two plugin manifests**

In `.claude-plugin/marketplace.json`, change the plugin's `"version": "0.3.0"` to `"version": "0.3.1"`.
In `.claude-plugin/plugin.json`, change the top-level `"version": "0.3.0"` to `"version": "0.3.1"`.

- [ ] **Step 4: Run the manifest test — expect PASS**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS, 5 tests green.

- [ ] **Step 5: Rebuild the bundle and confirm it is byte-identical**

Run: `npm run build && git diff --stat dist/`
Expected: no output from `git diff --stat dist/` (no `src/` changed, so `dist/ap.cjs` is unchanged). If `dist/ap.cjs` shows as modified, STOP and investigate — the bundle should not change from a version-only edit.

- [ ] **Step 6: Commit**

```bash
git add package.json .claude-plugin/marketplace.json .claude-plugin/plugin.json
git commit -m "chore(release): bump to 0.3.1"
```

---

## Task 3: README — add `/ap:bridge` and a getting-started path

**Files:**
- Modify: `README.md` (Commands table near line 54; new subsection after Requirements near line 38)

- [ ] **Step 1: Add the `/ap:bridge` row to the Commands table**

In `README.md`, immediately after the `**`/ap:stop`**` table row, add:
```markdown
| **`/ap:bridge`** | Cross-repo work — open one persistent worker inside a *different* git repo (repo B) and co-develop with it over open-ended rounds, finishing as a PR there, while the hub stays in repo A. |
```

- [ ] **Step 2: Mention `bridge` in the flow paragraph**

In `README.md`, change the closing sentence of the Commands section from:
```markdown
`check` / `list` / `review` / `stop` are the operational glue.
```
to:
```markdown
`check` / `list` / `review` / `stop` are the operational glue, and `bridge` reaches into a second repo.
```

- [ ] **Step 3: Add a "Getting started" subsection**

In `README.md`, after the `### Requirements` list (before the `---` that closes the Install section), add:
```markdown

### Getting started

1. Install (above), then open a Claude Code session in the repo you want to work in.
2. Run **`/ap:check`** — it detects which model CLIs (`codex` / `claude` / `agy` / `opencode`) are on
   your `PATH` and lets you pick the active provider set.
3. For a fast, unattended change, run **`/ap:quick "<describe the change>"`** — one worker implements
   it on its own branch while you watch the pane; the hub briefs, verifies, and finishes.
4. For research-driven work, follow **`/ap:explore` → `/ap:design` → `/ap:implement`**.
5. **`/ap:list`** shows active workers; **`/ap:stop`** tears them down with a `DONE` banner.
```

- [ ] **Step 4: Verify the README reflects all shipped commands**

Run:
```bash
for c in $(ls commands | sed 's/\.md$//'); do grep -q "ap:$c" README.md || echo "MISSING in README: $c"; done
```
Expected: no `MISSING` lines (all 10 commands appear in README).

- [ ] **Step 5: Run the stale-token gate (the README mentions the rename, ensure no banned token)**

Run: `npx vitest run tests/stale-tokens.test.ts`
Expected: PASS (README isn't scanned by the gate, but this confirms nothing regressed).

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): add /ap:bridge row and a getting-started path"
```

---

## Task 4: `.gitignore` — `.consort/` → `.ap/`

**Files:**
- Modify: `.gitignore:4`

- [ ] **Step 1: Replace the stale entry**

In `.gitignore`, change the line `.consort/` to `.ap/`. Leave every other line (`node_modules/`, `.codegraph/`, `*.tmp`, `.antigravitycli/`) untouched.

- [ ] **Step 2: Verify**

Run: `cat .gitignore`
Expected: contains `.ap/`, does NOT contain `.consort/`.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(gitignore): track .ap/ state dir, drop pre-rebrand .consort/"
```

---

## Task 5: GitHub repo description

No file change — sets repository metadata for marketplace discovery.

- [ ] **Step 1: Set the description**

Run:
```bash
gh repo edit WingsOfPanda/agglomeration-platform \
  --description "Multi-model tmux pane orchestration for Claude Code"
```

- [ ] **Step 2: Verify**

Run: `gh repo view WingsOfPanda/agglomeration-platform --json description`
Expected: `{"description":"Multi-model tmux pane orchestration for Claude Code"}`

---

## Task 6: Full verification, clean-clone smoke, and PR

**Files:** none (verification + delivery)

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run test && npm run lint && npm run build`
Expected: typecheck clean; all tests pass (including the new `tests/manifest.test.ts` and the unchanged `tests/stale-tokens.test.ts`); lint clean; build succeeds.

- [ ] **Step 2: Confirm `dist/` unchanged after the final build**

Run: `git diff --stat dist/`
Expected: no output.

- [ ] **Step 3: Clean-clone smoke (shipped tree is self-sufficient, no node_modules)**

Run:
```bash
TMP=$(mktemp -d); git archive HEAD | tar -x -C "$TMP"
node "$TMP/dist/ap.cjs"; echo "dispatch-exit=$?"
APH=$(mktemp -d); echo '{"prompt":"hi","session_id":"s","cwd":"'"$TMP"'"}' \
  | AP_HOME="$APH" node "$TMP/dist/ap.cjs" hook user-prompt-submit; echo "hook-exit=$?"
node -e 'const fs=require("fs"),p=require("path"),r=process.argv[1];
  const mp=JSON.parse(fs.readFileSync(p.join(r,".claude-plugin/marketplace.json")));
  for(const x of mp.plugins){if(!fs.existsSync(p.join(r,x.source)))throw new Error("missing "+x.source)}
  if(!fs.existsSync(p.join(r,"dist/ap.cjs")))throw new Error("missing dist");
  console.log("manifest paths OK")' "$TMP"
rm -rf "$TMP" "$APH"
```
Expected: `ap: missing subcommand` then `dispatch-exit=0`, `hook-exit=0`, and `manifest paths OK`. Proves the archived tree (no `node_modules`) installs and runs.

- [ ] **Step 4: Push the branch and open the PR**

Run:
```bash
git push -u origin publish/marketplace-readiness
gh pr create --base main --title "chore(publish): marketplace install-readiness" \
  --body "$(cat <<'BODY'
Publish-readiness for the Claude Code marketplace install path. Marketplace-only
(keeps package.json private:true), Claude Code only.

- test(manifest): new installability gate — manifest validity, source/dist paths, version sync
- chore(release): 0.3.0 -> 0.3.1 across package.json + both manifests (dist unchanged)
- docs(readme): /ap:bridge row + getting-started path
- chore(gitignore): .consort/ -> .ap/
- GitHub repo description set (external)

Verified: typecheck, test, lint, build all green; dist byte-identical; clean-clone
smoke (git archive -> node dist/ap.cjs dispatch + hook + manifest paths) passes.

Spec: docs/superpowers/specs/2026-06-15-publish-readiness-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```
Expected: PR created against `main`.

- [ ] **Step 5: Final manual acceptance (human-in-the-loop)**

From a clean Claude Code session: `/plugin marketplace add WingsOfPanda/agglomeration-platform`
then `/plugin install ap@agglomeration-platform`. Confirm the `/ap:*` commands appear and `/ap:check`
runs. (This step is performed by the user; note the result on the PR.)

---

## Self-Review

**Spec coverage:**
- README `/ap:bridge` + getting-started → Task 3 ✓
- GitHub description → Task 5 ✓
- `.gitignore` `.consort/` → `.ap/` → Task 4 ✓
- Manifest-validity + version-sync test → Task 1 ✓
- Version bump 0.3.0 → 0.3.1 (dist byte-identical) → Task 2 ✓
- Keep `private: true` / no npm / no Codex → unchanged by design (no task touches them) ✓
- Verification (local gate, clean-clone smoke, manual install) → Task 6 ✓
- Stale-token gate stays green → Task 3 Step 5 + Task 6 Step 1 ✓

**Placeholder scan:** none — all code, commands, and expected outputs are concrete.

**Type/name consistency:** `tests/manifest.test.ts` field accesses (`marketplace.plugins[0].version/.name`, `plugin.version/.name/.hooks.UserPromptSubmit[0].hooks[0].command`, `pkg.version`) match the real manifests read in Task 1. Version string `0.3.1` is consistent across Tasks 2/6 and the PR body.
