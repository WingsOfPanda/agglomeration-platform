import { describe, it, expect } from "vitest";
import { parseScoreboard, buildHandoffKv } from "../src/core/autoresearchHandoff.js";

const SB = [
  "<!-- scoreboard schema_version=2 -->", "# Scoreboard", "",
  "| Rank | Experiment | Agent | Metric | Status | Runtime | Approach | metric_name |",
  "|---|---|---|---|---|---|---|---|",
  "| 1 | exp-003 | bravo | 0.9950 | ok | 40.00s | augment-a2 | accuracy |",
  "| 2 | exp-002 | alpha | 0.9100 | ok | 41.00s | augment-b | accuracy |",
  "| ~3 | exp-001 | charlie | n/a | partial | 5.00s | baseline | accuracy |",
].join("\n") + "\n";

describe("parseScoreboard", () => {
  it("picks first-ok winner + next-ok runner-ups (skips partial)", () => {
    const r = parseScoreboard(SB);
    expect(r.winner).toMatchObject({ expId: "exp-003", agent: "bravo", metric: "0.9950", status: "ok" });
    expect(r.runnerUps.map((x) => x.agent)).toEqual(["alpha"]);
    expect(r.rows.length).toBe(3); // all data rows incl. the partial
  });
  it("winner null when no ok row", () => {
    const md = SB.replace(/ ok /g, " partial ");
    expect(parseScoreboard(md).winner).toBeNull();
  });
});

describe("buildHandoffKv", () => {
  it("winner branch — exact key order + winner_code_dir always emitted", () => {
    const kv = buildHandoffKv({
      topic: "autoresearch-x", landscapeDoc: "autoresearch-2026-05-30-x.md", hasMetricMd: true,
      generatedTs: "2026-05-30T11:00:00Z",
      winner: { agent: "bravo", exp: "exp-003", approach: "augment-a2", metric: "0.9950",
                checkpoint: "workers/bravo/experiments/exp-003/model.pt", notes: "best run",
                codeDir: "workers/bravo/experiments/exp-003/code/" },
      runnerUps: [{ agent: "alpha", exp: "exp-002", metric: "0.9100", approach: "augment-b" }],
    });
    expect(kv.split("\n").filter(Boolean)).toEqual([
      "mode=autoresearch", "topic=autoresearch-x", "landscape_doc=autoresearch-2026-05-30-x.md",
      "winner_agent=bravo", "winner_exp=exp-003", "winner_approach=augment-a2", "winner_metric=0.9950",
      "winner_checkpoint=workers/bravo/experiments/exp-003/model.pt", "winner_notes=best run",
      "winner_code_dir=workers/bravo/experiments/exp-003/code/",
      "finalists=bravo/exp-003:0.9950;alpha/exp-002:0.9100",
      "runner_up_1=alpha/exp-002:0.9100:augment-b",
      "mandates_block_path=metric.md", "session_path=.", "topic_txt_path=topic.txt",
      "generated_ts=2026-05-30T11:00:00Z",
    ]);
  });
  it("winner branch omits conditional keys (no checkpoint/notes/landscape), approach default unknown", () => {
    const kv = buildHandoffKv({
      topic: "autoresearch-x", hasMetricMd: false, generatedTs: "t",
      winner: { agent: "bravo", exp: "exp-003", approach: "", metric: "0.99",
                codeDir: "workers/bravo/experiments/exp-003/code/" },
      runnerUps: [{ agent: "alpha", exp: "exp-002", metric: "0.91", approach: "" }],
    });
    expect(kv.split("\n").filter(Boolean)).toEqual([
      "mode=autoresearch", "topic=autoresearch-x",
      "winner_agent=bravo", "winner_exp=exp-003", "winner_approach=unknown", "winner_metric=0.99",
      "winner_code_dir=workers/bravo/experiments/exp-003/code/",
      "finalists=bravo/exp-003:0.99;alpha/exp-002:0.91",
      "runner_up_1=alpha/exp-002:0.91:unknown",
      "session_path=.", "topic_txt_path=topic.txt", "generated_ts=t",
    ]);
  });
  it("emits finalists line in stable position (after winner_code_dir, before runner_up_1) with top-k agent/exp:metric entries", () => {
    const kv = buildHandoffKv({
      topic: "autoresearch-x", hasMetricMd: false, generatedTs: "t",
      winner: { agent: "bravo", exp: "exp-003", approach: "augment-a2", metric: "0.9950",
                codeDir: "workers/bravo/experiments/exp-003/code/" },
      runnerUps: [
        { agent: "alpha", exp: "exp-002", metric: "0.9100", approach: "augment-b" },
        { agent: "charlie", exp: "exp-005", metric: "0.8800", approach: "augment-c" },
      ],
    });
    const lines = kv.split("\n");
    const fi = lines.findIndex((l) => l.startsWith("finalists="));
    const ci = lines.findIndex((l) => l.startsWith("winner_code_dir="));
    const wi = lines.findIndex((l) => l.startsWith("winner_exp="));
    const ri = lines.findIndex((l) => l.startsWith("runner_up_1="));
    expect(fi).toBeGreaterThan(wi);
    expect(fi).toBeGreaterThan(ci);
    expect(ri).toBeGreaterThan(fi);
    // winner first, then runner-ups, each formatted agent/exp:metric, top-3 cap
    expect(lines[fi]).toBe("finalists=bravo/exp-003:0.9950;alpha/exp-002:0.9100;charlie/exp-005:0.8800");
  });
  it("finalists caps at k=3 (drops the 4th row)", () => {
    const kv = buildHandoffKv({
      topic: "autoresearch-x", hasMetricMd: false, generatedTs: "t",
      winner: { agent: "bravo", exp: "exp-003", approach: "a", metric: "0.99", codeDir: "d/" },
      runnerUps: [
        { agent: "alpha", exp: "exp-002", metric: "0.91", approach: "b" },
        { agent: "charlie", exp: "exp-005", metric: "0.88", approach: "c" },
        { agent: "delta", exp: "exp-009", metric: "0.80", approach: "d" },
      ],
    });
    const finalists = kv.split("\n").find((l) => l.startsWith("finalists="));
    expect(finalists).toBe("finalists=bravo/exp-003:0.99;alpha/exp-002:0.91;charlie/exp-005:0.88");
  });
  it("no-winner branch", () => {
    const kv = buildHandoffKv({ topic: "autoresearch-x", hasMetricMd: false, generatedTs: "t", winner: null, runnerUps: [] });
    expect(kv.split("\n").filter(Boolean)).toEqual([
      "mode=autoresearch-no-winner", "topic=autoresearch-x", "session_path=.", "topic_txt_path=topic.txt", "generated_ts=t",
    ]);
    expect(kv).not.toContain("finalists=");
  });
});
