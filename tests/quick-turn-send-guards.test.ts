import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./helpers/tmpHome.js";
import { turnSendWith } from "../src/commands/quick.js";
import { quickArtDir, quickExecDir } from "../src/core/quick.js";
import { workerDir } from "../src/core/paths.js";

let env: { home: string; cleanup: () => void };
beforeEach(() => { env = freshHome(); });
afterEach(() => { env.cleanup(); });

function stageQuick(topic: string, agent: string, provider: string) {
  const art = quickArtDir(topic);
  mkdirSync(art, { recursive: true });
  mkdirSync(quickExecDir(topic), { recursive: true }); // real `quick init` always creates the exec dir before turn-send
  writeFileSync(join(art, "agent.txt"), agent + "\n");
  writeFileSync(join(art, "selected-provider.txt"), provider + "\n");
  const pd = workerDir(agent, provider, topic);
  mkdirSync(pd, { recursive: true });
  return { art, pd };
}
const deps = { offsetFor: () => 0, send: async () => 0 };

describe("quick turn-send guards", () => {
  it("L7: fails when the worker outbox is absent ('was it spawned?')", async () => {
    stageQuick("topic-a", "bravo", "claude"); // no outbox.jsonl
    expect(await turnSendWith("topic-a", 1, deps)).toBe(1);
  });
  it("M2: fails when the worker is not idle (previous turn in flight)", async () => {
    const { pd } = stageQuick("topic-b", "bravo", "claude");
    writeFileSync(join(pd, "outbox.jsonl"), "");
    writeFileSync(join(pd, "status.json"), JSON.stringify({ state: "working" }) + "\n");
    expect(await turnSendWith("topic-b", 1, deps)).toBe(1);
  });
  it("proceeds (rc 0) when outbox exists and the worker is idle", async () => {
    const { pd } = stageQuick("topic-c", "bravo", "claude");
    writeFileSync(join(pd, "outbox.jsonl"), "");
    writeFileSync(join(pd, "status.json"), JSON.stringify({ state: "idle" }) + "\n");
    writeFileSync(join(quickArtDir("topic-c"), "task-brief.md"), "do x");
    expect(await turnSendWith("topic-c", 1, deps)).toBe(0);
  });
});
