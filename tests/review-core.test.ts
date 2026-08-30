// tests/review-core.test.ts — pure logic for /ap:review.
import { describe, it, expect } from "vitest";
import {
  parseSince, parseForensicsFrontmatter, parseMechanicalFindings,
} from "../src/core/review.js";

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

describe("parseForensicsFrontmatter", () => {
  const doc =
    "---\ncommand: implement\ntopic: add-oauth\ntopic_slug: add-oauth\n" +
    "repo_hash: abc\nart_dir: /x\ninvoked_at: 2026-05-30T00:00:00Z\nn_findings_mechanical: 3\n---\n\n## Mechanical findings\n";
  it("parses command / topic / n_findings", () => {
    expect(parseForensicsFrontmatter(doc)).toEqual({ command: "implement", topic: "add-oauth", nFindings: 3 });
  });
  it("missing keys -> empty / 0", () => {
    expect(parseForensicsFrontmatter("no frontmatter here")).toEqual({ command: "", topic: "", nFindings: 0 });
  });
  it("non-numeric n_findings_mechanical -> 0 (NaN guard)", () => {
    expect(parseForensicsFrontmatter("n_findings_mechanical: not-a-number")).toEqual({ command: "", topic: "", nFindings: 0 });
  });
});

describe("parseMechanicalFindings", () => {
  it("parses bullets back into findings (inverse of renderArtForensics)", () => {
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

import { findingSignature, normalizeVolatile } from "../src/core/review.js";

describe("normalizeVolatile", () => {
  it("strips ts / sha / path / bare ints", () => {
    expect(normalizeVolatile("at /home/x/y.ts:42 sha 3827f1c4f6 t 2026-05-30T00:00:00Z n 7"))
      .toBe("at <path> sha <sha> t <ts> n <n>");
  });
});

describe("findingSignature (per-source)", () => {
  it("audit_log -> first ISSUE token (drops trailing fields)", () => {
    expect(findingSignature({ source: "audit_log", key: "ISSUE=unresolved_placeholder", context: "audit.log" }))
      .toBe("audit_log||ISSUE=unresolved_placeholder");
    expect(findingSignature({ source: "audit_log", key: "ISSUE=todo_marker SECTION=ASK", context: "audit.log" }))
      .toBe("audit_log||ISSUE=todo_marker");
  });
  it("status -> state verbatim", () => {
    expect(findingSignature({ source: "status", key: "state=error", context: "worker=golf" }))
      .toBe("status||state=error");
  });
  it("spawn_results -> rc + reason word (lowercased)", () => {
    expect(findingSignature({ source: "spawn_results", key: "rc=124 reason=Timeout waiting", context: "worker=golf" }))
      .toBe("spawn_results||rc=124 reason=timeout");
  });
  it("spawn_results with no reason -> bare rc (empty reason column)", () => {
    expect(findingSignature({ source: "spawn_results", key: "rc=124", context: "worker=golf" }))
      .toBe("spawn_results||rc=124");
  });
  it("outbox -> event + reason from JSON (volatile bits ignored)", () => {
    expect(findingSignature({ source: "outbox", key: '{"event":"error","reason":"dispatch_timeout","ts":"2026-05-30T00:00:00Z"}', context: "worker=golf" }))
      .toBe("outbox||event=error reason=dispatch_timeout");
    expect(findingSignature({ source: "outbox", key: '{"event":"question"}', context: "worker=golf" }))
      .toBe("outbox||event=question");
  });
  it("outbox non-JSON key -> normalized-class fallback", () => {
    expect(findingSignature({ source: "outbox", key: "not json sha 3827f1c4f6", context: "worker=golf" }))
      .toBe("outbox||not json sha <sha>");
  });
  it("session_log -> volatile-normalized error class", () => {
    expect(findingSignature({ source: "session_log", key: "[error] failed at /home/x/y.ts:42 sha 3827f1c4f6", context: "dispatch.log" }))
      .toBe("session_log||[error] failed at <path> sha <sha>");
  });
  it("unknown source -> coarse fallback", () => {
    expect(findingSignature({ source: "weird", key: "x 2026-05-30T00:00:00Z", context: "c" }))
      .toBe("weird||x <ts>");
  });
});

import { parseTrendLedger, accrue, renderTrendDigest, reviewedTarget } from "../src/core/review.js";

describe("trend ledger", () => {
  it("parse: null / corrupt -> empty; valid -> counts", () => {
    expect(parseTrendLedger(null)).toEqual({ counts: {} });
    expect(parseTrendLedger("not json")).toEqual({ counts: {} });
    expect(parseTrendLedger("[]")).toEqual({ counts: {} });
    expect(parseTrendLedger('{"x":1}')).toEqual({ counts: {} });
    const l = parseTrendLedger('{"counts":{"a||x":{"count":2,"firstSeen":"2026-05-01","lastSeen":"2026-05-02"}}}');
    expect(l.counts["a||x"].count).toBe(2);
  });
  it("accrue: first-seen sets both dates; repeat bumps count + lastSeen", () => {
    const l = { counts: {} as Record<string, { count: number; firstSeen: string; lastSeen: string }> };
    accrue(l, [{ source: "status", key: "state=error", context: "worker=a" }], "2026-05-01");
    expect(l.counts["status||state=error"]).toEqual({ count: 1, firstSeen: "2026-05-01", lastSeen: "2026-05-01" });
    accrue(l, [{ source: "status", key: "state=error", context: "worker=b" }], "2026-05-03");
    expect(l.counts["status||state=error"]).toEqual({ count: 2, firstSeen: "2026-05-01", lastSeen: "2026-05-03" });
  });
  it("renderTrendDigest: count desc then signature asc; topN", () => {
    const l = { counts: { "a||x": { count: 1, firstSeen: "d", lastSeen: "d" }, "b||y": { count: 5, firstSeen: "d", lastSeen: "d" } } };
    expect(renderTrendDigest(l).map((r) => r.signature)).toEqual(["b||y", "a||x"]);
    expect(renderTrendDigest(l, 1).map((r) => r.signature)).toEqual(["b||y"]);
  });
});

describe("reviewedTarget", () => {
  const root = "/home/u/.ap/forensics";
  it("live file -> .reviewed/<date>/<file>", () => {
    expect(reviewedTarget(root, `${root}/2026-05-30/11-00-00-implement-x.md`))
      .toBe(`${root}/.reviewed/2026-05-30/11-00-00-implement-x.md`);
  });
  it("already reviewed -> unchanged (idempotent)", () => {
    expect(reviewedTarget(root, `${root}/.reviewed/2026-05-30/f.md`)).toBe(`${root}/.reviewed/2026-05-30/f.md`);
  });
  it("not under root -> null", () => {
    expect(reviewedTarget(root, "/tmp/x.md")).toBeNull();
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
  it("label with no marker comment has no timestamp to beat -> stays triaged", () => {
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
