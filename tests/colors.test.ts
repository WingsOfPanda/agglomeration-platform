import { describe, it, expect } from "vitest";
import * as C from "../src/core/colors.js";

describe("colors", () => {
  it("clusterFor maps agents to orchestral sections", () => {
    expect(C.clusterFor("violin")).toBe("strings");
    expect(C.clusterFor("trumpet")).toBe("brass");
    expect(C.clusterFor("oboe")).toBe("woodwinds");
    expect(C.clusterFor("timpani")).toBe("percussion");
    expect(C.clusterFor("piano")).toBe("keys");
    expect(C.clusterFor("lute")).toBe("early");
    expect(C.clusterFor("zzz-unknown")).toBe("tutti");
  });
  it("colorFor returns Morandi primary; unknown → white", () => {
    expect(C.colorFor("violin")).toBe("colour110");
    expect(C.colorFor("zzz-unknown")).toBe("white");
  });
  it("labelFor: <section>-<agent>:<model>:<topic>", () => {
    expect(C.labelFor("violin", "codex", "auth-review")).toBe("strings-violin:codex:auth-review");
  });
  it("labelFmt: colored striped border fragment", () => {
    const f = C.labelFmt("violin", "codex", "demo");
    expect(f).toBe("#[fg=colour110,bold]strings-violin#[default]:#[fg=colour187,bold]codex#[default]:demo");
  });
  it("labelFor collapses the agent segment for non-orchestral (fallback) names", () => {
    expect(C.labelFor("tutti", "codex", "design-x")).toBe("tutti:codex:design-x");
    expect(C.labelFor("cody", "codex", "design-x")).toBe("tutti:codex:design-x");
  });
  it("labelFmt collapses the agent segment for non-orchestral names", () => {
    expect(C.labelFmt("tutti", "codex", "demo")).toBe(
      "#[fg=white,bold]tutti#[default]:#[fg=default,bold]codex#[default]:demo",
    );
  });
  it("ansiFromColor: colourNNN and bare number", () => {
    expect(C.ansiFromColor("colour110")).toBe("\x1b[38;5;110m");
    expect(C.ansiFromColor("42")).toBe("\x1b[38;5;42m");
    expect(C.ansiFromColor("white")).toBe("");
  });
  it("renderBannerHead: DONE banner, no MISSION ACCOMPLISHED", () => {
    const head = C.renderBannerHead("strings-violin:codex:demo", "colour110");
    expect(head).toContain("DONE — pane closing");
    expect(head).toContain("strings-violin:codex:demo");
    expect(head).not.toContain("MISSION ACCOMPLISHED");
    expect(head).toContain("━");
  });
});
