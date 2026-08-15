import { describe, it, expect } from "vitest";
import * as T from "../src/core/tmux.js";

describe("tmux arg builders", () => {
  it("splitRightArgs: -h -d (detached), capture pane id, cwd, target", () => {
    expect(T.splitRightArgs("LAUNCH", "%1", "/repo")).toEqual(
      ["split-window", "-P", "-F", "#{pane_id}", "-h", "-d", "-t", "%1", "-c", "/repo", "LAUNCH"]);
    expect(T.splitRightArgs("LAUNCH", undefined, "/repo")).toEqual(
      ["split-window", "-P", "-F", "#{pane_id}", "-h", "-d", "-c", "/repo", "LAUNCH"]);
  });
  it("splitDownArgs: -v -d (detached), requires target", () => {
    expect(T.splitDownArgs("LAUNCH", "%2", "/repo")).toEqual(
      ["split-window", "-P", "-F", "#{pane_id}", "-v", "-d", "-t", "%2", "-c", "/repo", "LAUNCH"]);
  });
  it("preflightSplitArgs: -d detached, direction flag, target, optional cwd", () => {
    expect(T.preflightSplitArgs("-h", "%0")).toEqual(
      ["split-window", "-P", "-F", "#{pane_id}", "-h", "-d", "-t", "%0"]);
    expect(T.preflightSplitArgs("-v", "%1", "/repo")).toEqual(
      ["split-window", "-P", "-F", "#{pane_id}", "-v", "-d", "-t", "%1", "-c", "/repo"]);
  });
  it("respawnArgs: -k, optional cwd", () => {
    expect(T.respawnArgs("%3", "LAUNCH", "/repo")).toEqual(
      ["respawn-pane", "-k", "-t", "%3", "-c", "/repo", "LAUNCH"]);
    expect(T.respawnArgs("%3", "LAUNCH")).toEqual(["respawn-pane", "-k", "-t", "%3", "LAUNCH"]);
  });
  it("paneBorderArgs: status top + @ap_-aware format + active-border hook (no @cw_)", () => {
    const a = T.paneBorderArgs();
    expect(a[0]).toEqual(["set-option", "-g", "pane-border-status", "top"]);
    expect(a[1][0]).toBe("set-option");
    expect(a[1]).toContain("pane-border-format");
    expect(a[1][3]).toContain("#{@ap_label_fmt}");
    expect(a[1][3]).toContain("#{pane_title}"); // fallback for unlabeled panes
    expect(a[2][0]).toBe("set-hook");
    expect(a[2][1]).toBe("-g");
    expect(a[2][2]).toBe("after-select-pane");
    // rebrand: never reference the clone-wars @cw_ keys
    expect(JSON.stringify(a)).not.toContain("@cw_");
  });
  it("wrapLaunch: bashrc wrap when present", () => {
    expect(T.wrapLaunch("codex --foo", true)).toBe("bash -ic 'exec codex --foo'");
    expect(T.wrapLaunch("codex --foo", false)).toBe("codex --foo");
  });
  it("setOptionArgs / sendKeysLiteralArgs / sendKeysEnterArgs", () => {
    expect(T.setOptionArgs("%1", "@ap_color", "colour110")).toEqual(
      ["set-option", "-p", "-t", "%1", "@ap_color", "colour110"]);
    expect(T.sendKeysLiteralArgs("%1", "Read x")).toEqual(["send-keys", "-t", "%1", "-l", "Read x"]);
    expect(T.sendKeysEnterArgs("%1")).toEqual(["send-keys", "-t", "%1", "Enter"]);
  });
  it("sentinelCommand holds pane open with colored label", () => {
    const c = T.sentinelCommand("#[fg=colour110,bold]azure-bravo#[default]");
    expect(c).toContain("reserved — awaiting spawn");
    expect(c).toContain("sleep infinity");
  });
  it("windowBorderStatusArgs sets pane-border-status top on the target window", () => {
    expect(T.windowBorderStatusArgs("%5")).toEqual(["set-option", "-w", "-t", "%5", "pane-border-status", "top"]);
  });
  it("paneNonceSetArgs stamps @ap_nonce on the pane (a per-pane set-option)", () => {
    expect(T.paneNonceSetArgs("%1", "abc-123")).toEqual(["set-option", "-p", "-t", "%1", "@ap_nonce", "abc-123"]);
  });
});

// The pane id is not ownership evidence: tmux restarts %N from 0 on a fresh server, so a recorded
// id can name a pane that now belongs to another program.
describe("pane ownership nonce", () => {
  it("parsePaneNonces: id↔nonce map from the tab-separated list-panes format", () => {
    const m = T.parsePaneNonces("%0\tn-zero\n%1\tn-one\n%2\tn-two");
    expect(m.get("%0")).toBe("n-zero");
    expect(m.get("%2")).toBe("n-two");
    expect(m.size).toBe(3);
  });
  it("parsePaneNonces: an unstamped pane has an EMPTY nonce field, and blank lines are skipped", () => {
    const m = T.parsePaneNonces("%0\t\n\n%1\tours\n");
    expect(m.get("%0")).toBe("");
    expect(m.get("%1")).toBe("ours");
    expect(m.size).toBe(2);
  });
  it("parsePaneNonces: a line with no tab at all still registers the pane as unstamped", () => {
    expect(T.parsePaneNonces("%7").get("%7")).toBe("");
  });
  it("parsePaneNonces: a nonce is taken whole, even if it somehow contains a tab", () => {
    expect(T.parsePaneNonces("%1\ta\tb").get("%1")).toBe("a\tb");
  });
  it("ownsPane: true only when the live nonce IS the recorded one", () => {
    const snap = T.parsePaneNonces("%1\tours\n%2\tsomebody-elses\n%3\t\n");
    expect(T.ownsPane(snap, "%1", "ours")).toBe(true);
    expect(T.ownsPane(snap, "%2", "ours")).toBe(false);   // id reused by another program
    expect(T.ownsPane(snap, "%3", "ours")).toBe(false);   // live pane, never stamped by ap
    expect(T.ownsPane(snap, "%9", "ours")).toBe(false);   // pane gone
  });
  it("ownsPane: an empty RECORDED nonce (legacy pane.json) never matches, not even an unstamped pane", () => {
    const snap = T.parsePaneNonces("%1\t\n%2\tours\n");
    expect(T.ownsPane(snap, "%1", "")).toBe(false);
    expect(T.ownsPane(snap, "%2", "")).toBe(false);
  });
  it("paneOwned short-circuits an empty recorded nonce without touching tmux", async () => {
    // No tmux server is reachable in the suite: reaching execa would reject, not return false.
    await expect(T.paneOwned("%1", "")).resolves.toBe(false);
  });
});
