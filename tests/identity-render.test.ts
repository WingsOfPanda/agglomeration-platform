// tests/identity-render.test.ts — the render golden for identityWrite.
//
// identity.md used to be re-shipped, 71 of its 74 lines byte-for-byte, as job-hub.md; the two now
// share ONE template with three role-substituted blocks. These fixtures were captured from the
// pre-merge render of BOTH templates, so they are independent of the code that renders them now:
// any drift in the shared body, either role's blocks, or the appendix fails here.
//
// The fixtures are a deliberate freeze of shipped prompt text. Editing the prompt means
// REGENERATING them, never hand-patching the assertion.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { identityWrite, identityPath, type WorkerRole } from "../src/core/ipc.js";
import { workerDir } from "../src/core/paths.js";

const AGENT = "bravo", MODEL = "codex", TOPIC = "demo";
const fixture = (name: string) => readFileSync(join(process.cwd(), "tests", "fixtures", name), "utf8");

describe("identityWrite renders both roles byte-identically to the pre-merge templates", () => {
  const cleanups: Array<() => void> = [];
  const ORIG = process.env.CLAUDE_PLUGIN_ROOT;
  beforeEach(() => { process.env.CLAUDE_PLUGIN_ROOT = process.cwd(); });
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    if (ORIG === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = ORIG;
  });

  /** The rendered identity with the (temp-home) state dir tokenised, which is the only part of the
   *  output that cannot be a constant. outbox.jsonl sits under it, so one replace covers both. */
  function render(role?: WorkerRole): string {
    const h = freshHome(); cleanups.push(h.cleanup);
    const dir = workerDir(AGENT, MODEL, TOPIC);
    mkdirSync(dir, { recursive: true });
    identityWrite(AGENT, MODEL, TOPIC, role ? { role } : undefined);
    return readFileSync(identityPath(AGENT, MODEL, TOPIC), "utf8").replaceAll(dir, "<STATE_DIR>");
  }

  it("worker (the default role)", () => {
    expect(render()).toBe(fixture("identity-worker.md"));
  });

  it("job-hub", () => {
    expect(render("job-hub")).toBe(fixture("identity-job-hub.md"));
  });
});
