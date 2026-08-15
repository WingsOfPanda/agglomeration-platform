import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { run as collect } from "../src/commands/collect.js";
import { run as send } from "../src/commands/send.js";
import { workerDir } from "../src/core/paths.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h.home; }
function seed(i: string, m: string, t: string, outbox: string) {
  home();
  const d = workerDir(i, m, t); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "pane.json"), JSON.stringify({ pane_id: "%1", agent: i, model: m, spawned_at: "t" }));
  writeFileSync(join(d, "outbox.jsonl"), outbox);
}

describe("collect", () => {
  it("done → exit 0", async () => {
    seed("bravo", "codex", "demo", `{"event":"done","summary":"ok","ts":"t"}\n`);
    expect(await collect(["bravo", "demo", "--timeout", "3"])).toBe(0);
  });
  it("error → exit 1", async () => {
    seed("bravo", "codex", "demo", `{"event":"error","message":"boom","fatal":true,"ts":"t"}\n`);
    expect(await collect(["bravo", "demo", "--timeout", "3"])).toBe(1);
  });
  it("false-positive immunity: progress quoting done does not resolve", async () => {
    seed("bravo", "codex", "demo", `{"event":"progress","note":"\\"event\\":\\"done\\""}\n`);
    expect(await collect(["bravo", "demo", "--timeout", "1"])).toBe(1); // timeout, not done
  });
  it("timeout → exit 1", async () => {
    seed("bravo", "codex", "demo", "");
    expect(await collect(["bravo", "demo", "--timeout", "1"])).toBe(1);
  });
});

describe("send error paths", () => {
  it("--from with no sender → exit 2", async () => {
    seed("bravo", "codex", "demo", ""); // reuse seed helper; returns before any state read
    expect(await send(["--from"])).toBe(2);
  });
  it("arity < 3 → exit 2", async () => {
    expect(await send(["bravo", "demo"])).toBe(2);
  });
  it("no state dir for the worker → exit 1", async () => {
    home();
    expect(await send(["ghost", "demo", "hello"])).toBe(1);
  });
  it("worker dir present but pane.json missing → exit 1", async () => {
    home();
    const d = workerDir("bravo", "codex", "demo"); mkdirSync(d, { recursive: true });
    // no pane.json written
    expect(await send(["bravo", "demo", "hello"])).toBe(1);
  });
});

// send TYPES the nudge into the pane and presses Enter, so a pane id that a restarted tmux handed
// to another program must never be accepted — the finding reproduced exactly that (the nudge ran in
// a stranger's shell).
describe("send pane ownership", () => {
  function seedOwner(nonce: string | null) {
    home();
    const d = workerDir("bravo", "codex", "demo"); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "pane.json"), JSON.stringify({
      pane_id: "%1", ...(nonce === null ? {} : { pane_nonce: nonce }), agent: "bravo", model: "codex", spawned_at: "t",
    }));
    writeFileSync(join(d, "outbox.jsonl"), "");
  }
  const probes = () => {
    const sent: string[] = [];
    return { sent, deps: (owned: boolean) => ({ paneOwned: async () => owned, paneSend: async (p: string) => { sent.push(p); } }) };
  };

  it("nonce matches → nudges the pane (the healthy path is unchanged)", async () => {
    seedOwner("n1");
    const { sent, deps } = probes();
    expect(await send(["bravo", "demo", "hello"], deps(true))).toBe(0);
    expect(sent).toEqual(["%1"]);
  });
  it("nonce mismatch → exit 1 with the orphan message and NOTHING typed into the pane", async () => {
    seedOwner("n1");
    const { sent, deps } = probes();
    const err: string[] = [];
    const se = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
    try { expect(await send(["bravo", "demo", "hello"], deps(false))).toBe(1); }
    finally { process.stderr.write = se; }
    expect(sent).toEqual([]);                       // mutation pin: drop the gate and this fails
    expect(err.join("")).toContain("is gone or is no longer ours (orphan)");
  });
  it("legacy pane.json (no nonce) is unverifiable → refused by the real probe, no tmux call", async () => {
    seedOwner(null);
    const { sent } = probes();
    // paneSend is still injected, but paneOwned is the REAL one: an empty recorded nonce is refused
    // before any tmux call, so this exercises the shipped gate rather than a fake.
    expect(await send(["bravo", "demo", "hello"], { paneOwned: (await import("../src/core/tmux.js")).paneOwned, paneSend: async (p: string) => { sent.push(p); } })).toBe(1);
    expect(sent).toEqual([]);
  });
});

describe("send/collect reject unsafe agent/topic slugs (path-segment gate)", () => {
  it("send rejects a traversal topic or agent (rc 2, before any state read)", async () => {
    expect(await send(["alpha", "../evil", "hi"])).toBe(2);
    expect(await send(["../x", "demo", "hi"])).toBe(2);
  });
  it("collect rejects a traversal topic or agent (rc 2)", async () => {
    expect(await collect(["alpha", "../evil"])).toBe(2);
    expect(await collect(["../x", "demo"])).toBe(2);
  });
});
