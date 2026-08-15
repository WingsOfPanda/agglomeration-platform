import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const OURS = "11111111-1111-4111-8111-111111111111";
  const THEIRS = "22222222-2222-4222-8222-222222222222";
  const HEXY = "abcdefab-cdef-4abc-8def-abcdefabcdef";
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
    const snap = T.parsePaneNonces(`%1\t${OURS}\n%2\t${THEIRS}\n%3\t\n`);
    expect(T.ownsPane(snap, "%1", OURS)).toBe(true);
    expect(T.ownsPane(snap, "%2", OURS)).toBe(false);   // id reused by another program
    expect(T.ownsPane(snap, "%3", OURS)).toBe(false);   // live pane, never stamped by ap
    expect(T.ownsPane(snap, "%9", OURS)).toBe(false);   // pane gone
  });
  it("ownsPane: an empty RECORDED nonce (legacy pane.json) never matches, not even an unstamped pane", () => {
    const snap = T.parsePaneNonces(`%1\t\n%2\t${OURS}\n`);
    expect(T.ownsPane(snap, "%1", "")).toBe(false);
    expect(T.ownsPane(snap, "%2", "")).toBe(false);
  });
  it("ownsPane: only a platform-minted UUID is honoured, however exactly it matches", () => {
    // A recorded nonce that did not come from randomUUID cannot authorize anything — a hand-edited
    // pane.json or a crafted preflight row must not become an ownership proof by matching itself.
    expect(T.ownsPane(T.parsePaneNonces("%1\tours"), "%1", "ours")).toBe(false);
    expect(T.ownsPane(T.parsePaneNonces("%1\t*"), "%1", "*")).toBe(false);
    const upper = HEXY.toUpperCase();
    expect(T.ownsPane(T.parsePaneNonces(`%1\t${upper}`), "%1", upper)).toBe(false);
  });

  // tmux allows a NEWLINE inside a pane option, so a hostile pane's @ap_nonce can append lines to
  // `list-panes -a` output — the single oracle every kill/nudge consults.
  describe("forged @ap_nonce rows", () => {
    // %1 is the hostile pane; %9 is not on this server at all. tmux's own id list cannot be forged.
    const FORGED = `%1\tx\n%9\t${OURS}\n`;
    it("a phantom row for a pane that is NOT on the server is dropped", () => {
      expect(T.ownsPane(T.parsePaneNonces(FORGED, new Set(["%1"])), "%9", OURS)).toBe(false);
      // Without tmux's id list the phantom would be indistinguishable from a real row — which is
      // exactly why livePaneNonces always passes one.
      expect(T.ownsPane(T.parsePaneNonces(FORGED), "%9", OURS)).toBe(true);
    });
    it("a phantom row that overwrites a REAL pane's answer poisons that id instead", () => {
      const snap = T.parsePaneNonces(`%1\tx\n%2\t${OURS}\n%2\t${THEIRS}\n`, new Set(["%1", "%2"]));
      expect(T.ownsPane(snap, "%2", OURS)).toBe(false);
      expect(T.ownsPane(snap, "%2", THEIRS)).toBe(false);
      expect(snap.has("%2")).toBe(true);   // still LIVE — just no longer provably ours
    });
    it("rows whose id field is not a real %N are dropped", () => {
      const snap = T.parsePaneNonces(`bogus\t${OURS}\n  %1\t${OURS}\n%1\t${OURS}\n`);
      expect(snap.has("bogus")).toBe(false);
      expect(snap.has("  %1")).toBe(false);
      expect(T.ownsPane(snap, "%1", OURS)).toBe(true);
    });
  });
  it("paneOwned short-circuits an empty recorded nonce without touching tmux", async () => {
    // No tmux server is reachable in the suite: reaching execa would reject, not return false.
    await expect(T.paneOwned("%1", "")).resolves.toBe(false);
  });
});

// CI (and any headless box, container, or user who has not started tmux) has NO tmux server. The
// probes must ANSWER there, not throw: an unguarded `tmux list-panes` rejection propagated out of
// paneOwned and failed a test that never meant to touch tmux at all.
// A PATH shim is what makes this testable without a server — and without ever contacting the real
// one: `tmux` resolves to a stub that fails exactly as a serverless tmux does.
describe("no tmux server / no tmux at all", () => {
  const withFakeTmux = async <R>(body: string | null, fn: () => Promise<R>): Promise<R> => {
    const dir = mkdtempSync(join(tmpdir(), "ap-notmux-"));
    if (body !== null) writeFileSync(join(dir, "tmux"), body, { mode: 0o755 });
    const orig = process.env.PATH;
    process.env.PATH = dir;   // ONLY the stub (or nothing) is reachable
    try { return await fn(); } finally { process.env.PATH = orig; }
  };
  // What tmux really prints with no server running, and its exit code.
  const NO_SERVER = "#!/bin/sh\necho 'error connecting to /tmp/tmux-1001/default (No such file or directory)' >&2\nexit 1\n";

  it("no server: livePaneNonces resolves to an EMPTY map, never rejects", async () => {
    await withFakeTmux(NO_SERVER, async () => {
      await expect(T.livePaneNonces()).resolves.toEqual(new Map());
    });
  });
  it("tmux not installed at all: same answer (ENOENT is not an exception either)", async () => {
    await withFakeTmux(null, async () => {
      await expect(T.livePaneNonces()).resolves.toEqual(new Map());
    });
  });
  it("paneOwned resolves FALSE (not ours) rather than rejecting — the CI failure", async () => {
    await withFakeTmux(NO_SERVER, async () => {
      await expect(T.paneOwned("%1", "11111111-1111-4111-8111-111111111111")).resolves.toBe(false);
    });
  });
  it("an empty snapshot stays fail-closed: it means NOT ours, never assume-ours", async () => {
    expect(T.ownsPane(new Map(), "%1", "11111111-1111-4111-8111-111111111111")).toBe(false);
  });
  it("paneNonceSet reports failure instead of throwing (the caller fails closed on it)", async () => {
    await withFakeTmux(NO_SERVER, async () => {
      await expect(T.paneNonceSet("%1", "11111111-1111-4111-8111-111111111111")).resolves.toBe(false);
    });
    await withFakeTmux("#!/bin/sh\nexit 0\n", async () => {
      await expect(T.paneNonceSet("%1", "11111111-1111-4111-8111-111111111111")).resolves.toBe(true);
    });
  });
});
