import { describe, it, expect } from "vitest";
import { gracefulRespawnCommand, paneLabelSetArgs } from "../src/core/tmux.js";

describe("tmux graceful + labels", () => {
  it("gracefulRespawnCommand cats snapshot, runs _banner, removes snapshot", () => {
    const cmd = gracefulRespawnCommand("/tmp/snap.txt", "/plugin", "azure-bravo:codex:demo", "colour110");
    expect(cmd).toContain("cat '/tmp/snap.txt'");
    expect(cmd).toContain("node '/plugin/dist/ap.cjs' _banner 'azure-bravo:codex:demo' 'colour110'");
    expect(cmd).toContain("rm -f '/tmp/snap.txt'");
  });
  it("paneLabelSetArgs returns three @ap_* set-option arg arrays", () => {
    const sets = paneLabelSetArgs("%1", "bravo", "codex", "demo");
    expect(sets.map((s) => s[4])).toEqual(["@ap_label", "@ap_color", "@ap_label_fmt"]);
    expect(sets[0]).toContain("azure-bravo:codex:demo");
    expect(sets[1]).toContain("colour110");
  });
});
