import { describe, it, expect } from "vitest";
import { teardownBatch, GRACEFUL_BATCH_WAIT_MS, run as stopRun } from "../src/commands/stop.js";

/** `live` is the tmux snapshot (pane id -> its live @ap_nonce); `recorded` is what each agent's
 *  pane.json says. By default every agent records the nonce its pane actually carries — the healthy
 *  path — so a test only spells out the pair it is bending. */
function deps(live: Record<string, string>, recorded?: Record<string, string>) {
  const calls = { graceful: 0, killNow: 0, sleep: 0, archive: 0 };
  const archived: string[] = [];
  return {
    calls,
    archived,
    d: {
      paneMetaRead: (i: string, _m: string, _t: string) => ({ paneId: `%${i}`, nonce: recorded?.[`%${i}`] ?? live[`%${i}`] ?? "" }),
      livePaneNonces: async () => new Map(Object.entries(live)),
      killGraceful: async () => { calls.graceful++; },
      killNow: async () => { calls.killNow++; },
      stateArchive: (i: string, m: string, _t: string, suffix?: string) => {
        calls.archive++; archived.push(`${i}-${m}${suffix ? `-${suffix}` : ""}`); return `/archive/${i}-${m}`;
      },
      sleep: async (_ms: number) => { calls.sleep++; },
      lastPanePath: () => "/tmp/none/.last_pane",
      readLastPane: () => "",
      removeLastPane: () => {},
      pluginRoot: "/plugin",
    },
  };
}

const PAIRS = [
  { agent: "bravo", model: "codex" }, { agent: "alpha", model: "codex" }, { agent: "charlie", model: "codex" },
];

describe("stop batch", () => {
  it("sleeps ONCE for a 3-pane batch and killNow each; archive all", async () => {
    const { calls, archived, d } = deps({ "%bravo": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "%alpha": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "%charlie": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    await teardownBatch("demo", PAIRS, d as any);
    expect(calls.graceful).toBe(3);
    expect(calls.sleep).toBe(1);              // ONE wait for the whole batch
    expect(calls.killNow).toBe(3);
    expect(calls.archive).toBe(3);
    expect(archived).toEqual(["bravo-codex", "alpha-codex", "charlie-codex"]); // no stalepane marker
  });
  it("no alive panes → no graceful, no sleep, but still archives every pair", async () => {
    const { calls, archived, d } = deps({});
    await teardownBatch("demo", [{ agent: "bravo", model: "codex" }], d as any);
    expect(calls.graceful).toBe(0);
    expect(calls.sleep).toBe(0);
    expect(calls.archive).toBe(1);
    expect(archived).toEqual(["bravo-codex"]);   // pane absent = the plain orphan path, unmarked
  });
  it("GRACEFUL_BATCH_WAIT_MS is 9000", () => { expect(GRACEFUL_BATCH_WAIT_MS).toBe(9000); });
  it("--all without --yes refuses (exit 2), no teardown", async () => {
    expect(await stopRun(["--all"])).toBe(2);
  });
});

// The finding this closes: tmux restarts its %N counter on a fresh server, so a never-archived
// pane.json can name a pane that now belongs to somebody else. The id being LIVE is what used to
// authorize the kill.
describe("stop batch: pane ownership", () => {
  it("live id + mismatched nonce → NO kill, warns, still archives (marked stalepane)", async () => {
    const err: string[] = [];
    const se = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
    const { calls, archived, d } = deps({ "%bravo": "somebody-elses-pane" }, { "%bravo": "0dd00000-0000-4000-8000-000000000001" });
    try { await teardownBatch("demo", [{ agent: "bravo", model: "codex" }], d as any); }
    finally { process.stderr.write = se; }
    expect(calls.graceful).toBe(0);
    expect(calls.killNow).toBe(0);
    expect(calls.sleep).toBe(0);
    expect(archived).toEqual(["bravo-codex-stalepane"]);
    expect(err.join("")).toContain("is not ours (nonce mismatch)");
  });
  it("legacy pane.json (no nonce) → NO kill, archives marked, warns with the manual kill line", async () => {
    const err: string[] = [];
    const se = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
    const { calls, archived, d } = deps({ "%bravo": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { "%bravo": "" });
    try { await teardownBatch("demo", [{ agent: "bravo", model: "codex" }], d as any); }
    finally { process.stderr.write = se; }
    expect(calls.graceful).toBe(0);
    expect(calls.killNow).toBe(0);
    expect(archived).toEqual(["bravo-codex-stalepane"]);
    expect(err.join("")).toContain("tmux kill-pane -t %bravo");
  });
  it("one stale pane in a batch does not stop the others being torn down", async () => {
    const { calls, archived, d } = deps(
      { "%bravo": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "%alpha": "stranger", "%charlie": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, { "%alpha": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    );
    await teardownBatch("demo", PAIRS, d as any);
    expect(calls.graceful).toBe(2);
    expect(calls.killNow).toBe(2);
    expect(archived).toEqual(["bravo-codex", "alpha-codex-stalepane", "charlie-codex"]);
  });
  it("an unowned pane is never handed to killGraceful (the respawn -k that destroys it)", async () => {
    const seen: string[] = [];
    const { d } = deps({ "%bravo": "stranger" }, { "%bravo": "0dd00000-0000-4000-8000-000000000001" });
    (d as { killGraceful: (p: string) => Promise<void> }).killGraceful = async (p) => { seen.push(p); };
    await teardownBatch("demo", [{ agent: "bravo", model: "codex" }], d as any);
    expect(seen).toEqual([]);
  });
});
