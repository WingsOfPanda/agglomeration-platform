import { describe, it, expect } from "vitest";
import { paneNonceFor } from "../src/core/roster.js";

const TSV = "bravo\t%5\tn5\ncharlie\t%6\tn6\n";
describe("paneNonceFor (L10)", () => {
  it("returns the recorded nonce when the agent+pane pair is listed", () => {
    expect(paneNonceFor(TSV, "bravo", "%5")).toBe("n5");
  });
  it("null when the pane belongs to a different agent", () => {
    expect(paneNonceFor(TSV, "bravo", "%6")).toBeNull();
  });
  it("null when the pane is foreign / unlisted", () => {
    expect(paneNonceFor(TSV, "bravo", "%99")).toBeNull();
  });
  it("a legacy 2-column row is listed but unverifiable (empty nonce, never null)", () => {
    expect(paneNonceFor("bravo\t%5\n", "bravo", "%5")).toBe("");
  });
});
