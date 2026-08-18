import { describe, it, expect } from "vitest";
import * as T from "../src/core/tmux.js";

describe("detached session placement — pure arg builders", () => {
  it("sessionTarget produces tmux's exact-match form", () => {
    expect(T.sessionTarget("ap-foo")).toBe("=ap-foo");
  });

  it("newSessionArgs: detached, prints the pane id, optional cwd", () => {
    expect(T.newSessionArgs("ap-foo", "LAUNCH", "/repo")).toEqual(
      ["new-session", "-P", "-F", "#{pane_id}", "-d", "-s", "ap-foo", "-c", "/repo", "LAUNCH"]);
    expect(T.newSessionArgs("ap-foo", "LAUNCH")).toEqual(
      ["new-session", "-P", "-F", "#{pane_id}", "-d", "-s", "ap-foo", "LAUNCH"]);
  });

  it("newSessionArgs names the session BARE — `-s` creates it, `=` is a lookup form", () => {
    expect(T.newSessionArgs("ap-foo", "LAUNCH")).toContain("ap-foo");
    expect(T.newSessionArgs("ap-foo", "LAUNCH")).not.toContain("=ap-foo");
  });

  it("newWindowArgs: detached, prints the pane id, exact-match session target", () => {
    expect(T.newWindowArgs("ap-foo", "LAUNCH", "/repo")).toEqual(
      ["new-window", "-P", "-F", "#{pane_id}", "-d", "-t", "=ap-foo:", "-c", "/repo", "LAUNCH"]);
    expect(T.newWindowArgs("ap-foo", "LAUNCH")).toEqual(
      ["new-window", "-P", "-F", "#{pane_id}", "-d", "-t", "=ap-foo:", "LAUNCH"]);
  });

  it("hasSessionArgs uses the exact-match target", () => {
    expect(T.hasSessionArgs("ap-foo")).toEqual(["has-session", "-t", "=ap-foo"]);
  });

  // The regression these `=` forms exist for: a BARE session target is PREFIX-matched, so with only
  // `ap-foobar` on the server, `has-session -t ap-foo` exits 0 and `new-window -t ap-foo:` opens its
  // window inside `ap-foobar` — a worker silently placed in a stranger's session.
  it("every session-scoped target is '='-prefixed, so a prefix cannot resolve to a longer name", () => {
    for (const args of [T.newWindowArgs("ap-foo", "L"), T.hasSessionArgs("ap-foo")]) {
      const target = args[args.indexOf("-t") + 1];
      expect(target.startsWith("=")).toBe(true);
    }
  });

  it("cwd is threaded as -c, and omitted entirely when absent", () => {
    expect(T.newSessionArgs("s", "L", "/w")).toContain("-c");
    expect(T.newWindowArgs("s", "L", "/w")).toContain("-c");
    expect(T.newSessionArgs("s", "L")).not.toContain("-c");
    expect(T.newWindowArgs("s", "L")).not.toContain("-c");
  });

  it("the launch command is always the LAST argument", () => {
    expect(T.newSessionArgs("s", "LAUNCH", "/w").at(-1)).toBe("LAUNCH");
    expect(T.newWindowArgs("s", "LAUNCH", "/w").at(-1)).toBe("LAUNCH");
  });
});

describe("validSessionName", () => {
  it("accepts the names ap actually mints", () => {
    expect(T.validSessionName("ap-foo")).toBe(true);
    expect(T.validSessionName(`ap-${"x".repeat(32)}`)).toBe(true); // longest possible ap-<topic>
    expect(T.validSessionName("a")).toBe(true);
    expect(T.validSessionName("ap_1-2")).toBe(true);
    expect(T.validSessionName("x".repeat(64))).toBe(true);
  });

  it("rejects tmux target separators, flag-like names, empty, and over-long", () => {
    expect(T.validSessionName("ap:foo")).toBe(false);  // ':' separates session from window
    expect(T.validSessionName("ap.foo")).toBe(false);  // '.' separates window from pane
    expect(T.validSessionName("-ap")).toBe(false);     // would parse as a flag
    expect(T.validSessionName("ap foo")).toBe(false);
    expect(T.validSessionName("")).toBe(false);
    expect(T.validSessionName("x".repeat(65))).toBe(false);
  });
});
