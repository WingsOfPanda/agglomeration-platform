import { describe, it, expect } from "vitest";
import { paneListedFor } from "../src/core/design.js";

const TSV = "bravo\t%5\ncharlie\t%6\n";
describe("paneListedFor (L10)", () => {
  it("true when the agent+pane pair is listed", () => {
    expect(paneListedFor(TSV, "bravo", "%5")).toBe(true);
  });
  it("false when the pane belongs to a different agent", () => {
    expect(paneListedFor(TSV, "bravo", "%6")).toBe(false);
  });
  it("false when the pane is foreign / unlisted", () => {
    expect(paneListedFor(TSV, "bravo", "%99")).toBe(false);
  });
});
