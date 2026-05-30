import { describe, it, expect } from "vitest";
import { freshHome } from "./helpers/tmpHome.js";
import { preludeArtDir, deriveSlug } from "../src/core/prelude.js";

describe("prelude core paths", () => {
  it("preludeArtDir ends in _prelude under the topic dir", () => {
    const { cleanup } = freshHome();
    try {
      const art = preludeArtDir("foo-bar");
      expect(art.endsWith("/foo-bar/_prelude")).toBe(true);
    } finally { cleanup(); }
  });
  it("re-exports deriveSlug (cap-20, bare slug)", () => {
    expect(deriveSlug("Deep Think About Attention")).toBe("deep-think-about-att");
    expect(deriveSlug("  ")).toBe("");
  });
});
