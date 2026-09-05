import { describe, it, expect } from "vitest";
import * as T from "../src/core/tmux.js";

describe("detached session placement — pure arg builders", () => {
  it("sessionTarget produces tmux's exact-match form", () => {
    expect(T.sessionTarget("ap-foo")).toBe("=ap-foo");
  });

  it("newSessionArgs: detached, prints the pane id, optional cwd", () => {
    expect(T.newSessionArgs("ap-foo", "LAUNCH", "/repo")).toEqual(
      ["new-session", "-P", "-F", "#{pane_id}", "-d", "-s", "ap-foo", "-x", "240", "-y", "100", "-c", "/repo", "LAUNCH"]);
    expect(T.newSessionArgs("ap-foo", "LAUNCH")).toEqual(
      ["new-session", "-P", "-F", "#{pane_id}", "-d", "-s", "ap-foo", "-x", "240", "-y", "100", "LAUNCH"]);
  });

  // An UNATTACHED session is sized by `default-size` (80x24), so without this the lead plus the
  // slice panes would be splitting a 24-row window before anyone ever attaches.
  it("newSessionArgs sizes the session at creation", () => {
    expect(T.DETACHED_SESSION_COLS).toBe(240);
    expect(T.DETACHED_SESSION_ROWS).toBe(100);
    const a = T.newSessionArgs("ap-foo", "LAUNCH");
    expect(a[a.indexOf("-x") + 1]).toBe(String(T.DETACHED_SESSION_COLS));
    expect(a[a.indexOf("-y") + 1]).toBe(String(T.DETACHED_SESSION_ROWS));
  });

  it("newSessionArgs names the session BARE — `-s` creates it, `=` is a lookup form", () => {
    expect(T.newSessionArgs("ap-foo", "LAUNCH")).toContain("ap-foo");
    expect(T.newSessionArgs("ap-foo", "LAUNCH")).not.toContain("=ap-foo");
  });

  it("hasSessionArgs uses the exact-match target", () => {
    expect(T.hasSessionArgs("ap-foo")).toEqual(["has-session", "-t", "=ap-foo"]);
  });

  // The regression these `=` forms exist for: a BARE session target is PREFIX-matched, so with only
  // `ap-foobar` on the server, `has-session -t ap-foo` exits 0 — a worker silently placed in a
  // stranger's session.
  it("every session-scoped target is '='-prefixed, so a prefix cannot resolve to a longer name", () => {
    const args = T.hasSessionArgs("ap-foo");
    expect(args[args.indexOf("-t") + 1].startsWith("=")).toBe(true);
  });

  it("cwd is threaded as -c, and omitted entirely when absent", () => {
    expect(T.newSessionArgs("s", "L", "/w")).toContain("-c");
    expect(T.newSessionArgs("s", "L")).not.toContain("-c");
  });

  it("the launch command is always the LAST argument", () => {
    expect(T.newSessionArgs("s", "LAUNCH", "/w").at(-1)).toBe("LAUNCH");
  });
});

describe("window height — pure arg builder", () => {
  it("asks tmux for the window's rows, with and without a target", () => {
    expect(T.windowHeightArgs("%3")).toEqual(["display-message", "-p", "-t", "%3", "#{window_height}"]);
    expect(T.windowHeightArgs()).toEqual(["display-message", "-p", "#{window_height}"]);
  });
});

describe("detached session teardown — pure arg builders", () => {
  it("killSessionArgs uses the exact-match target", () => {
    expect(T.killSessionArgs("ap-foo")).toEqual(["kill-session", "-t", "=ap-foo"]);
  });
  it("sessionPanesArgs scopes to the SESSION with -s, not the current window", () => {
    expect(T.sessionPanesArgs("ap-foo")).toEqual(["list-panes", "-s", "-t", "=ap-foo", "-F", "#{pane_id}"]);
  });
  it("both teardown targets are '='-prefixed — a kill must never hit a prefix match", () => {
    for (const args of [T.killSessionArgs("ap-foo"), T.sessionPanesArgs("ap-foo")]) {
      expect(args[args.indexOf("-t") + 1]).toBe("=ap-foo");
    }
  });
});

describe("verifiableNonce", () => {
  it("accepts exactly the shape randomUUID mints", () => {
    expect(T.verifiableNonce("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe(true);
  });
  it("rejects everything a recorded nonce could otherwise be, so those read as UNKNOWN", () => {
    expect(T.verifiableNonce("")).toBe(false);            // pre-nonce pane.json
    expect(T.verifiableNonce("not-a-uuid")).toBe(false);
    expect(T.verifiableNonce("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBe(false);  // uppercase is not what we mint
  });
  it("agrees with ownsPane: an unverifiable nonce can never own a pane", () => {
    expect(T.ownsPane(new Map([["%1", ""]]), "%1", "")).toBe(false);
    expect(T.ownsPane(new Map([["%1", "not-a-uuid"]]), "%1", "not-a-uuid")).toBe(false);
  });
});

describe("the origin session's own name — pure builder + parser", () => {
  it("displayMessageArgs asks tmux to print one format, nothing else", () => {
    expect(T.displayMessageArgs("#S")).toEqual(["display-message", "-p", "#S"]);
  });

  it("parseSessionName takes the first line, trimmed", () => {
    expect(T.parseSessionName("ap-origin\n")).toBe("ap-origin");
    expect(T.parseSessionName("  ap-origin  ")).toBe("ap-origin");
    expect(T.parseSessionName("ap-origin\nsecond line\n")).toBe("ap-origin");
  });

  // This value is interpolated into the job hub's brief, so a name ap cannot vouch for is dropped
  // rather than carried through: "" costs only the hint, and the hub is told to skip it.
  it("anything tmux itself would not accept as a name reads as no return address", () => {
    expect(T.parseSessionName("")).toBe("");
    expect(T.parseSessionName("\n")).toBe("");
    expect(T.parseSessionName("my session")).toBe("");
    expect(T.parseSessionName("ORIGIN_SESSION=x")).toBe("");
    expect(T.parseSessionName("-flaggy")).toBe("");
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
