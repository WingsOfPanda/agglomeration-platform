import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderList, readProviderList } from "../src/core/providers.js";

describe("parseProviderList", () => {
  it("keeps providers, skips blank + # lines, trims whitespace", () => {
    expect(parseProviderList("# header\n\ncodex\n  claude  \n#trailing\n")).toEqual(["codex", "claude"]);
  });
  it("empty input → []", () => {
    expect(parseProviderList("")).toEqual([]);
  });
});

describe("readProviderList", () => {
  it("missing file → []", () => {
    expect(readProviderList("/no/such/providers.txt")).toEqual([]);
  });
  it("reads + parses an on-disk file", () => {
    const f = join(mkdtempSync(join(tmpdir(), "pl-")), "providers.txt");
    writeFileSync(f, "# generated …\ncodex\nclaude\n");
    expect(readProviderList(f)).toEqual(["codex", "claude"]);
  });
});
