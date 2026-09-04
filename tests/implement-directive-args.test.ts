// tests/implement-directive-args.test.ts — the /ap:implement directive tells the hub to filter
// `$ARGUMENTS` before writing the args file, because `implement init` rejects `--max-rounds` (both
// spellings, src/core/implement.ts) and `--detached` as unknown flags. The strip step and the Write
// step must name the same three forms, or a hub that follows the Write step literally hands
// `--max-rounds=N` or `--detached` to init and the run aborts at Stage 0.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const doc = readFileSync(join(process.cwd(), "commands", "implement.md"), "utf8");
const stage0 = doc.slice(doc.indexOf("## Stage 0"), doc.indexOf("## Stage 1"));

describe("implement.md Stage 0 args-file filtering", () => {
  it("the strip step names --detached and both --max-rounds spellings", () => {
    const strip = stage0.slice(stage0.indexOf("1. **Strip"), stage0.indexOf("2. Mint"));
    expect(strip).toContain("`--max-rounds`");
    expect(strip).toContain("`--max-rounds=`");
    expect(strip).toContain("`--detached`");
  });
  it("the Write step drops the same three forms, not only the space-form pair", () => {
    const write = stage0.slice(stage0.indexOf("3. **Write tool:**"), stage0.indexOf("4. **Audit"));
    expect(write).toContain("`--detached`");
    expect(write).toContain("`--max-rounds <N>`");
    expect(write).toContain("`--max-rounds=<N>`");
  });
});
