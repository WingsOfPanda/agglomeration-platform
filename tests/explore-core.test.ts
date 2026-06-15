import { describe, it, expect } from "vitest";
import { freshHome } from "./helpers/tmpHome.js";
import { exploreArtDir, deriveSlug } from "../src/core/explore.js";

describe("explore core paths", () => {
  it("exploreArtDir ends in _explore under the topic dir", () => {
    const { cleanup } = freshHome();
    try {
      const art = exploreArtDir("foo-bar");
      expect(art.endsWith("/foo-bar/_explore")).toBe(true);
    } finally { cleanup(); }
  });
  it("re-exports deriveSlug (cap-20, bare slug)", () => {
    expect(deriveSlug("Deep Think About Attention")).toBe("deep-think-about-att");
    expect(deriveSlug("  ")).toBe("");
  });
});
