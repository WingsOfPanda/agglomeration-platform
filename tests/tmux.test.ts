import { describe, it, expect } from "vitest";
import * as T from "../src/core/tmux.js";

describe("tmux arg builders", () => {
  it("splitRightArgs: -h, capture pane id, cwd, target", () => {
    expect(T.splitRightArgs("LAUNCH", "%1", "/repo")).toEqual(
      ["split-window", "-P", "-F", "#{pane_id}", "-h", "-t", "%1", "-c", "/repo", "LAUNCH"]);
    expect(T.splitRightArgs("LAUNCH", undefined, "/repo")).toEqual(
      ["split-window", "-P", "-F", "#{pane_id}", "-h", "-c", "/repo", "LAUNCH"]);
  });
  it("splitDownArgs: -v, requires target", () => {
    expect(T.splitDownArgs("LAUNCH", "%2", "/repo")).toEqual(
      ["split-window", "-P", "-F", "#{pane_id}", "-v", "-t", "%2", "-c", "/repo", "LAUNCH"]);
  });
  it("respawnArgs: -k, optional cwd", () => {
    expect(T.respawnArgs("%3", "LAUNCH", "/repo")).toEqual(
      ["respawn-pane", "-k", "-t", "%3", "-c", "/repo", "LAUNCH"]);
    expect(T.respawnArgs("%3", "LAUNCH")).toEqual(["respawn-pane", "-k", "-t", "%3", "LAUNCH"]);
  });
  it("wrapLaunch: bashrc wrap when present", () => {
    expect(T.wrapLaunch("codex --foo", true)).toBe("bash -ic 'exec codex --foo'");
    expect(T.wrapLaunch("codex --foo", false)).toBe("codex --foo");
  });
  it("setOptionArgs / sendKeysLiteralArgs / sendKeysEnterArgs", () => {
    expect(T.setOptionArgs("%1", "@cs_color", "colour110")).toEqual(
      ["set-option", "-p", "-t", "%1", "@cs_color", "colour110"]);
    expect(T.sendKeysLiteralArgs("%1", "Read x")).toEqual(["send-keys", "-t", "%1", "-l", "Read x"]);
    expect(T.sendKeysEnterArgs("%1")).toEqual(["send-keys", "-t", "%1", "Enter"]);
  });
  it("sentinelCommand holds pane open with colored label", () => {
    const c = T.sentinelCommand("#[fg=colour110,bold]strings-violin#[default]");
    expect(c).toContain("reserved — awaiting spawn");
    expect(c).toContain("sleep infinity");
  });
});
