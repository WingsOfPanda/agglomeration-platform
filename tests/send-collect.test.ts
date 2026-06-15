import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as collect } from "../src/commands/collect.js";
import { run as send } from "../src/commands/send.js";
import { workerDir } from "../src/core/paths.js";

afterEach(() => { delete process.env.AP_HOME; });
function seed(i: string, m: string, t: string, outbox: string) {
  const h = mkdtempSync(join(tmpdir(), "sc-")); process.env.AP_HOME = h;
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
    process.env.AP_HOME = mkdtempSync(join(tmpdir(), "snd-"));
    expect(await send(["ghost", "demo", "hello"])).toBe(1);
  });
  it("worker dir present but pane.json missing → exit 1", async () => {
    const h = mkdtempSync(join(tmpdir(), "snd2-")); process.env.AP_HOME = h;
    const d = workerDir("bravo", "codex", "demo"); mkdirSync(d, { recursive: true });
    // no pane.json written
    expect(await send(["bravo", "demo", "hello"])).toBe(1);
  });
});
