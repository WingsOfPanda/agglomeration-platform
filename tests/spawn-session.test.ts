import { describe, it, expect, afterEach } from "vitest";
import { freshHome } from "./helpers/tmpHome.js";
import { parseSpawnArgs, run } from "../src/commands/spawn.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function home() { const h = freshHome(); cleanups.push(h.cleanup); return h.home; }

describe("parseSpawnArgs", () => {
  it("takes the three positionals and defaults every flag to empty", () => {
    expect(parseSpawnArgs(["alpha", "codex", "demo"])).toEqual({
      agent: "alpha", model: "codex", topic: "demo",
      mode: "", cwd: "", targetPane: "", preflightArtDir: "", session: "", initial: "",
    });
  });

  it("parses --session in both the space and the = form", () => {
    expect(parseSpawnArgs(["a", "codex", "t", "--session", "ap-t"]).session).toBe("ap-t");
    expect(parseSpawnArgs(["a", "codex", "t", "--session=ap-t"]).session).toBe("ap-t");
  });

  it("keeps the pre-existing flags working alongside --session", () => {
    const p = parseSpawnArgs(["a", "codex", "t", "--mode", "read-only", "--cwd", "/repo", "--session", "ap-t"]);
    expect(p.mode).toBe("read-only");
    expect(p.cwd).toBe("/repo");
    expect(p.session).toBe("ap-t");
  });

  it("the first non-flag token begins the initial prompt, and the rest is joined onto it", () => {
    const p = parseSpawnArgs(["a", "codex", "t", "--cwd", "/repo", "do", "the", "thing"]);
    expect(p.cwd).toBe("/repo");
    expect(p.initial).toBe("do the thing");
    expect(p.session).toBe("");
  });

  it("--target-pane and --preflight-art-dir still parse (the respawn placement)", () => {
    const p = parseSpawnArgs(["a", "codex", "t", "--target-pane", "%3", "--preflight-art-dir", "/art"]);
    expect(p.targetPane).toBe("%3");
    expect(p.preflightArtDir).toBe("/art");
  });
});

describe("spawn placement flags — rejections (no pane is ever created)", () => {
  it("refuses --session together with --target-pane", async () => {
    home();
    expect(await run(["alpha", "codex", "demo", "--session", "ap-demo", "--target-pane", "%1"])).toBe(2);
  });

  it("refuses a session name carrying a tmux target separator", async () => {
    home();
    expect(await run(["alpha", "codex", "demo", "--session", "ap:demo"])).toBe(2);
    expect(await run(["alpha", "codex", "demo", "--session", "ap.demo"])).toBe(2);
  });

  it("refuses a flag-like session name", async () => {
    home();
    expect(await run(["alpha", "codex", "demo", "--session", "-ap"])).toBe(2);
  });

  it("still refuses a bad topic before it ever looks at placement", async () => {
    home();
    expect(await run(["alpha", "codex", "BAD TOPIC", "--session", "ap-demo"])).toBe(2);
  });
});
