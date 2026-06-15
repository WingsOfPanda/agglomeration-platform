// tests/bridge-core.test.ts
import { describe, it, expect } from "vitest";
import { parseBridgeArgs, deriveSlug, bridgeArtDir, bridgeExecDir } from "../src/core/bridge.js";

describe("parseBridgeArgs", () => {
  it("captures --repo (value flag), --provider, --in-place; rest is the verbatim task", () => {
    const a = parseBridgeArgs(["--repo", "/abs/repoB", "--provider", "claude", "--in-place", "wire up", "the", "thing"]);
    expect(a.repo).toBe("/abs/repoB");
    expect(a.provider).toBe("claude");
    expect(a.inPlace).toBe(true);
    expect(a.taskText).toBe("wire up the thing");
  });
  it("supports --repo=… and --provider=… inline forms; default no in-place, no provider", () => {
    const a = parseBridgeArgs(["--repo=/x", "--provider=codex", "do it"]);
    expect(a.repo).toBe("/x");
    expect(a.provider).toBe("codex");
    expect(a.inPlace).toBe(false);
    expect(a.taskText).toBe("do it");
  });
  it("a bare --repo with no value leaves repo undefined and does not eat the task", () => {
    const a = parseBridgeArgs(["--repo", "--provider", "codex", "task here"]);
    expect(a.repo).toBeUndefined();
    expect(a.taskText).toBe("task here");
  });
});

describe("bridge path helpers", () => {
  it("art dir is _bridge under the topic dir; exec is execute under that", () => {
    const art = bridgeArtDir("my-topic");
    expect(art.endsWith("/my-topic/_bridge")).toBe(true);
    expect(bridgeExecDir("my-topic")).toBe(art + "/execute");
  });
  it("re-exports deriveSlug (single slug algorithm)", () => {
    expect(deriveSlug("Add OAuth Login!")).toBe("add-oauth-login");
  });
});

import { renderBridgeSummary, renderBridgeResume } from "../src/core/bridge.js";

describe("renderBridgeResume", () => {
  it("records repo B, branch+mode, last round, task, and a restore pointer (no auto-resume)", () => {
    const md = renderBridgeResume({
      topic: "t", repo: "/abs/repoB", branch: "feat/bridge-t", mode: "branch",
      lastRound: 3, task: "do the thing", phase: "round", gate: "round-wait",
    });
    expect(md).toContain("# RESUME — t (aborted at round.round-wait)");
    expect(md).toContain("/abs/repoB");
    expect(md).toContain("feat/bridge-t");
    expect(md).toContain("Last round: 3");
    expect(md).toContain("do the thing");
    expect(md).toMatch(/cannot auto-resume/i);
  });
});

describe("renderBridgeSummary", () => {
  it("emits a command: bridge frontmatter and the cross-repo facts", () => {
    const md = renderBridgeSummary({
      topic: "t", status: "ok", started: "s", ended: "e", duration: 5,
      provider: "codex", agent: "alpha", repo: "/abs/repoB", mode: "branch",
      branch: "feat/bridge-t", rounds: 4, verify: "PASS", diffStats: "1 file",
      archived: "/arch", finishResult: "pr\tpr-opened",
    });
    expect(md).toMatch(/^---\ncommand: bridge\n/);
    expect(md).toContain("/abs/repoB");
    expect(md).toContain("rounds: 4");
  });
});
