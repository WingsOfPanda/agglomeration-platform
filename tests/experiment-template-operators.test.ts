// tests/experiment-template-operators.test.ts — the worker's experiment template lists seven
// operators, but `experiment-send` dispatches only DISPATCH_OPERATORS (src/core/autoresearchExperiment.ts)
// and refuses the rest with rc 2. The template must present exactly the dispatchable set as moves
// the Hub sends, and mark the other three as lesson categories, so hub and worker briefs describe
// one contract.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH_OPERATORS } from "../src/core/autoresearchExperiment.js";

const tpl = readFileSync(join(process.cwd(), "config", "prompt-templates", "autoresearch", "experiment.md"), "utf8");
const bullets = [...tpl.matchAll(/^  - \*\*([a-z-]+)\*\*\s+— (.*)$/gm)].map((m) => [m[1], m[2]] as const);

describe("experiment.md operator table vs DISPATCH_OPERATORS", () => {
  it("every dispatchable operator is a plain (dispatched) bullet", () => {
    for (const op of DISPATCH_OPERATORS) {
      const row = bullets.find(([name]) => name === op);
      expect(row, op).toBeDefined();
      expect(row![1]).not.toContain("lesson-only");
    }
  });
  it("every other listed operator is marked lesson-only", () => {
    const extra = bullets.filter(([name]) => !(DISPATCH_OPERATORS as readonly string[]).includes(name));
    expect(extra.map(([n]) => n).sort()).toEqual(["crossover", "debug", "literature-refresh"]);
    for (const [, desc] of extra) expect(desc).toContain("lesson-only, never dispatched");
  });
  it("the intro names the four dispatched operators", () => {
    for (const op of DISPATCH_OPERATORS) expect(tpl).toContain("`" + op + "`");
  });
});
