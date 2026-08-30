// tests/review-core.test.ts — pure logic for /ap:review.
import { describe, it, expect } from "vitest";
import { parseSince, parseMechanicalFindings } from "../src/core/review.js";

describe("parseSince", () => {
  it("Nd / Nh to cutoff epoch-ms", () => {
    const now = 1_000_000_000_000;
    expect(parseSince("2d", now)).toBe(now - 2 * 86_400_000);
    expect(parseSince("6h", now)).toBe(now - 6 * 3_600_000);
  });
  it("rejects a bad spec", () => {
    expect(() => parseSince("2w", 0)).toThrow();
    expect(() => parseSince("x", 0)).toThrow();
  });
});

describe("parseMechanicalFindings", () => {
  it("parses bullets back into findings (inverse of renderFindingBullets)", () => {
    const body =
      "## Mechanical findings\n\n" +
      "- **audit_log** ISSUE=todo_marker _(source: audit.log)_\n" +
      '- **outbox** {"event":"error","reason":"timeout"} _(source: worker=golf)_\n';
    expect(parseMechanicalFindings(body)).toEqual([
      { source: "audit_log", key: "ISSUE=todo_marker", context: "audit.log" },
      { source: "outbox", key: '{"event":"error","reason":"timeout"}', context: "worker=golf" },
    ]);
  });
  it("key with spaces round-trips (non-greedy key / greedy context boundary)", () => {
    const body = "- **spawn_results** rc=124 reason=timeout _(source: worker=golf)_\n";
    expect(parseMechanicalFindings(body)).toEqual([
      { source: "spawn_results", key: "rc=124 reason=timeout", context: "worker=golf" },
    ]);
  });
  it("skips malformed lines", () => {
    expect(parseMechanicalFindings("- not a finding\nrandom text")).toEqual([]);
  });
});

import { normalizeVolatile } from "../src/core/review.js";

describe("normalizeVolatile", () => {
  it("strips ts / sha / path / bare ints", () => {
    expect(normalizeVolatile("at /home/x/y.ts:42 sha 3827f1c4f6 t 2026-05-30T00:00:00Z n 7"))
      .toBe("at <path> sha <sha> t <ts> n <n>");
  });
});

import { AP_TRIAGED_MARKER, isTriaged, lastEventAt, clusterByTitle } from "../src/core/review.js";
import type { GhIssue } from "../src/core/review.js";

const issue = (o: Partial<GhIssue>): GhIssue =>
  ({ number: 1, title: "[ap:quick] boom", createdAt: "2026-08-01T00:00:00Z", ...o });
const forensicsComment = (at: string) => ({ body: "<!-- ap-forensics run=r kind=flag -->\nseen again", createdAt: at });
const triagedComment = (at: string) => ({ body: `${AP_TRIAGED_MARKER} at=${at} -->\ntriaged by /ap:review`, createdAt: at });

describe("isTriaged", () => {
  it("no label, no marker -> untriaged", () => {
    expect(isTriaged(issue({ comments: [forensicsComment("2026-08-01T01:00:00Z")] }))).toBe(false);
  });
  it("triaged label -> triaged", () => {
    expect(isTriaged(issue({ labels: [{ name: "triaged" }] }))).toBe(true);
  });
  it("an unrelated label does not count", () => {
    expect(isTriaged(issue({ labels: [{ name: "bug" }] }))).toBe(false);
  });
  it("marker comment counts exactly like the label", () => {
    expect(isTriaged(issue({ comments: [triagedComment("2026-08-02T00:00:00Z")] }))).toBe(true);
  });
  it("the marker must be the comment's FIRST line", () => {
    expect(isTriaged(issue({ comments: [{ body: `chatter\n${AP_TRIAGED_MARKER} at=x -->`, createdAt: "2026-08-02T00:00:00Z" }] }))).toBe(false);
  });
  it("recurrence newer than the newest marker -> untriaged again", () => {
    expect(isTriaged(issue({
      labels: [{ name: "triaged" }],
      comments: [triagedComment("2026-08-02T00:00:00Z"), forensicsComment("2026-08-03T00:00:00Z")],
    }))).toBe(false);
  });
  it("a forensics comment OLDER than the marker leaves it triaged", () => {
    expect(isTriaged(issue({
      comments: [forensicsComment("2026-08-01T00:00:00Z"), triagedComment("2026-08-02T00:00:00Z")],
    }))).toBe(true);
  });
  it("re-triaging after a recurrence (newest marker wins) -> triaged", () => {
    expect(isTriaged(issue({
      comments: [triagedComment("2026-08-02T00:00:00Z"), forensicsComment("2026-08-03T00:00:00Z"), triagedComment("2026-08-04T00:00:00Z")],
    }))).toBe(true);
  });
  // Only reachable for a label applied BY HAND in the GitHub UI: `review archive` always leaves the
  // timestamped marker beside the label, so an ap-triaged issue always has something to beat.
  it("a hand-applied label with no marker comment has no timestamp to beat -> stays triaged", () => {
    expect(isTriaged(issue({ labels: [{ name: "triaged" }], comments: [forensicsComment("2026-08-05T00:00:00Z")] }))).toBe(true);
  });
});

describe("lastEventAt", () => {
  it("newest ap-forensics comment", () => {
    expect(lastEventAt(issue({ comments: [forensicsComment("2026-08-03T00:00:00Z"), forensicsComment("2026-08-02T00:00:00Z")] })))
      .toBe("2026-08-03T00:00:00Z");
  });
  it("no ap comments (or only non-ap ones) -> createdAt", () => {
    expect(lastEventAt(issue({}))).toBe("2026-08-01T00:00:00Z");
    expect(lastEventAt(issue({ comments: [{ body: "a human comment", createdAt: "2026-08-09T00:00:00Z" }] })))
      .toBe("2026-08-01T00:00:00Z");
  });
  it("a triage marker is not an event", () => {
    expect(lastEventAt(issue({ comments: [triagedComment("2026-08-09T00:00:00Z")] }))).toBe("2026-08-01T00:00:00Z");
  });
});

describe("clusterByTitle", () => {
  it("normalized titles collapse; >=2 open issues make a row", () => {
    const rows = clusterByTitle([
      issue({ number: 1, title: "[ap:quick] spawn rc=124 at /a/b", createdAt: "2026-08-01T00:00:00Z" }),
      issue({ number: 2, title: "[ap:quick] spawn rc=137 at /c/d", createdAt: "2026-08-04T00:00:00Z",
              comments: [forensicsComment("2026-08-05T00:00:00Z")] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ open: 2, seenAgain: 1, first: "2026-08-01T00:00:00Z", last: "2026-08-05T00:00:00Z" });
    expect(rows[0].title).toBe(normalizeVolatile("[ap:quick] spawn rc=124 at /a/b"));
  });
  it("a lone issue with no recurrence is not a trend row", () => {
    expect(clusterByTitle([issue({})])).toEqual([]);
  });
  it("a lone issue with a 'seen again' comment IS a trend row", () => {
    const rows = clusterByTitle([issue({ comments: [forensicsComment("2026-08-02T00:00:00Z")] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ open: 1, seenAgain: 1, last: "2026-08-02T00:00:00Z" });
  });
  it("sorted by open desc, then title asc", () => {
    const rows = clusterByTitle([
      issue({ number: 1, title: "[ap:zulu] b" }), issue({ number: 2, title: "[ap:zulu] b" }),
      issue({ number: 3, title: "[ap:alpha] a" }), issue({ number: 4, title: "[ap:alpha] a" }),
      issue({ number: 5, title: "[ap:alpha] a" }),
    ]);
    expect(rows.map((r) => [r.title, r.open])).toEqual([["[ap:alpha] a", 3], ["[ap:zulu] b", 2]]);
  });
});
