import { describe, it, expect } from "vitest";
import * as C from "../src/core/colors.js";

describe("colors", () => {
  it("clusterFor maps agents to color clusters", () => {
    expect(C.clusterFor("bravo")).toBe("azure");
    expect(C.clusterFor("lima")).toBe("amber");
    expect(C.clusterFor("golf")).toBe("sage");
    expect(C.clusterFor("quebec")).toBe("slate");
    expect(C.clusterFor("victor")).toBe("ivory");
    expect(C.clusterFor("yankee")).toBe("violet");
    expect(C.clusterFor("zzz-unknown")).toBe("neutral");
  });
  it("colorFor returns Morandi primary; unknown → white", () => {
    expect(C.colorFor("bravo")).toBe("colour110");
    expect(C.colorFor("zzz-unknown")).toBe("white");
  });
  it("labelFor: <cluster>-<agent>:<model>:<topic>", () => {
    expect(C.labelFor("bravo", "codex", "auth-review")).toBe("azure-bravo:codex:auth-review");
  });
  it("labelFmt: colored striped border fragment", () => {
    const f = C.labelFmt("bravo", "codex", "demo");
    expect(f).toBe("#[fg=colour110,bold]azure-bravo#[default]:#[fg=colour187,bold]codex#[default]:demo");
  });
  it("labelFor collapses the agent segment for non-clustered (fallback) names", () => {
    expect(C.labelFor("zzz", "codex", "design-x")).toBe("neutral:codex:design-x");
    expect(C.labelFor("cody", "codex", "design-x")).toBe("neutral:codex:design-x");
  });
  it("labelFmt collapses the agent segment for non-clustered names", () => {
    expect(C.labelFmt("zzz", "codex", "demo")).toBe(
      "#[fg=white,bold]neutral#[default]:#[fg=default,bold]codex#[default]:demo",
    );
  });
  it("ansiFromColor: colourNNN and bare number", () => {
    expect(C.ansiFromColor("colour110")).toBe("\x1b[38;5;110m");
    expect(C.ansiFromColor("42")).toBe("\x1b[38;5;42m");
    expect(C.ansiFromColor("white")).toBe("");
  });
  it("renderBannerHead: DONE banner, no MISSION ACCOMPLISHED", () => {
    const head = C.renderBannerHead("azure-bravo:codex:demo", "colour110");
    expect(head).toContain("DONE — pane closing");
    expect(head).toContain("azure-bravo:codex:demo");
    expect(head).not.toContain("MISSION ACCOMPLISHED");
    expect(head).toContain("━");
  });
});
