import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveMemoryScope } from "../src/core/autoresearchMemoryStore.js";
import { parseMetricMd } from "../src/core/autoresearchMetric.js";
import { policyFromMetric } from "../src/core/autoresearchLessonMap.js";
import { repoHash } from "../src/core/paths.js";

const metricMd = (primary: string, direction?: string): string =>
  `# Research goal\n\n**Primary metric:** ${primary}\n` + (direction ? `**Direction:** ${direction}\n` : "");

// The scope preamble both callers (finalize's lesson write, the dispatch retrieve) used to
// carry inline. Pinned once here instead of twice through the verbs.
describe("resolveMemoryScope", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-mem-scope-"));
    process.env.AP_HOME = home;
  });
  afterEach(() => {
    delete process.env.AP_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("null on an out-of-taxonomy family (an unknown family must never reach scopeKey)", () => {
    expect(resolveMemoryScope(metricMd("wibbliness"), {})).toBeNull();
  });

  it("null on empty text — the shape an absent metric.md reaches both callers as", () => {
    expect(resolveMemoryScope("", {})).toBeNull();
  });

  it("resolves family, direction, policy and thresholds for an in-taxonomy metric", () => {
    const text = metricMd("accuracy", "maximize");
    const scope = resolveMemoryScope(text, {});
    expect(scope?.family).toBe("accuracy");
    expect(scope?.direction).toBe("maximize");
    expect(scope?.thresholds.primaryMetric).toBe("accuracy");
    expect(scope?.policy).toEqual(policyFromMetric(parseMetricMd(text)));   // the store adds no policy of its own
  });

  it("an absent Direction defaults to maximize; minimize is carried through", () => {
    expect(resolveMemoryScope(metricMd("accuracy"), {})?.direction).toBe("maximize");
    expect(resolveMemoryScope(metricMd("accuracy", "minimize"), {})?.direction).toBe("minimize");
  });

  it("defaults storeRoot to <globalRoot>/autoresearch-memory and repoHash to this repo", () => {
    const scope = resolveMemoryScope(metricMd("accuracy"), {});
    expect(scope?.storeRoot).toBe(join(home, "autoresearch-memory"));
    expect(scope?.repoHash).toBe(repoHash());
  });

  it("explicit storeRoot / repoHash win over the defaults", () => {
    const scope = resolveMemoryScope(metricMd("accuracy"), { storeRoot: "/tmp/elsewhere", repoHash: "repoZ" });
    expect(scope?.storeRoot).toBe("/tmp/elsewhere");
    expect(scope?.repoHash).toBe("repoZ");
  });
});
