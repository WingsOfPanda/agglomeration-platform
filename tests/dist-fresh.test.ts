import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stale-dist gate: dist/ap.cjs is committed and is the artifact a zero-build install actually runs,
// but every other test imports from src/, so a dev who edits src and forgets `npm run build` would
// see a green suite while shipping stale runtime behavior. This test rebuilds src with the EXACT
// flags from package.json (only the outfile redirected) and asserts the bytes match the committed
// bundle, so drift fails in `npm run test` — locally and in CI.
const ROOT = process.cwd();

describe("dist freshness", () => {
  // Byte-identity with the committed bundle is only guaranteed on the platform that BUILDS releases
  // (Linux, the primary platform): esbuild byte-determinism across platforms is not a bet a merge
  // should depend on, so the macOS CI job stays out of this — Linux (local + the ubuntu job) holds
  // the line.
  it.skipIf(process.platform === "darwin")("committed dist/ap.cjs matches a fresh build of src (run `npm run build` and commit if this fails)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const build = String(pkg.scripts.build); // "esbuild src/ap.ts --bundle ... --outfile=dist/ap.cjs"
    const out = join(mkdtempSync(join(tmpdir(), "distfresh-")), "ap.cjs");
    // Reuse package.json's build flags verbatim so this can never drift from the real build; only
    // redirect --outfile so we do not clobber the committed bundle.
    const args = build.split(/\s+/).slice(1).map((a) => (a.startsWith("--outfile=") ? `--outfile=${out}` : a));
    const esbuild = join(ROOT, "node_modules", ".bin", "esbuild");
    execFileSync(esbuild, args, { cwd: ROOT });
    const fresh = readFileSync(out);
    const committed = readFileSync(join(ROOT, "dist", "ap.cjs"));
    expect(fresh.equals(committed)).toBe(true);
  });
});
