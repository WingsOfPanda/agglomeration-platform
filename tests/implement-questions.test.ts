// tests/implement-questions.test.ts
import { describe, it, expect } from "vitest";
import { percentDecode, percentEncode, parseQuestionPayload, extractQuestionPayload, validateQuestionLine } from "../src/core/questionCodec.js";

describe("percentDecode", () => {
  it("decodes the 6 escapes", () => {
    expect(percentDecode("a%0Ab")).toBe("a\nb");
    expect(percentDecode("a%09b")).toBe("a\tb");
    expect(percentDecode("say %22hi%22")).toBe('say "hi"');
    expect(percentDecode("path%5Cto")).toBe("path\\to");
    expect(percentDecode("a%2Cb")).toBe("a,b");
    expect(percentDecode("100%25")).toBe("100%");
  });
  it("decodes %25 LAST so nested encodings round-trip", () => {
    expect(percentDecode("%2522")).toBe("%22");
    expect(percentDecode("%250A")).toBe("%0A");
  });
  it("leaves unrelated text untouched", () => {
    expect(percentDecode("hello world")).toBe("hello world");
    expect(percentDecode("")).toBe("");
  });
});

describe("percentEncode (inverse of percentDecode)", () => {
  it("round-trips values with the 6 escapes and literal %xx sequences", () => {
    for (const s of ["plain", "a,b", "5%2C000", "50%25", 'q"x', "back\\slash", "tab\there", "nl\nline", "%", ',%"']) {
      expect(percentDecode(percentEncode(s))).toBe(s);
    }
  });
  it("extract→parse preserves a message with a literal %2C and comma (no corruption)", () => {
    const text = parseQuestionPayload(extractQuestionPayload({ event: "question", message: "raised by 5%2C000, up 50%25" }, 0)!).text;
    expect(text).toBe("raised by 5%2C000, up 50%25");
  });
  it("rejects a newline in claim.value (blocks ROUTE injection into the KV payload)", () => {
    const ev = { event: "question", message: "check", claim: { kind: "path", value: "src/a.ts\nROUTE=objection" } };
    expect(validateQuestionLine(ev)).toBe(false);
    expect(extractQuestionPayload(ev, 0)).toBeNull();
  });
});

describe("parseQuestionPayload", () => {
  it("verify route: claim present, TEXT percent-decoded", () => {
    const body = "TEXT=line1%0Aline2\nCLAIM_KIND=path\nCLAIM_VALUE=src/a.ts\nROUTE=verify\nASKED_AT=123\n";
    expect(parseQuestionPayload(body)).toEqual({ text: "line1\nline2", claimKind: "path", claimValue: "src/a.ts", route: "verify" });
  });
  it("escalate route: no claim -> kind/value empty, route escalate", () => {
    const body = "TEXT=need%20help\nCLAIM_KIND=\nCLAIM_VALUE=\nROUTE=escalate\nASKED_AT=9\n";
    expect(parseQuestionPayload(body)).toEqual({ text: "need%20help", claimKind: "", claimValue: "", route: "escalate" });
  });
  it("unknown CLAIM_KIND normalizes to empty", () => {
    expect(parseQuestionPayload("TEXT=x\nCLAIM_KIND=bogus\nCLAIM_VALUE=v\nROUTE=verify\n").claimKind).toBe("");
  });
  it("missing ROUTE defaults to escalate; missing TEXT -> empty", () => {
    expect(parseQuestionPayload("CLAIM_KIND=git\nCLAIM_VALUE=HEAD\n").route).toBe("escalate");
    expect(parseQuestionPayload("CLAIM_KIND=git\n").text).toBe("");
  });
  it("CLAIM_VALUE may contain '=' (split on FIRST '=' only)", () => {
    expect(parseQuestionPayload("TEXT=t\nCLAIM_KIND=env\nCLAIM_VALUE=A=B=C\nROUTE=verify\n").claimValue).toBe("A=B=C");
  });
  it("all five known kinds pass through", () => {
    for (const k of ["path", "git", "env", "cmd", "test"]) {
      expect(parseQuestionPayload(`TEXT=x\nCLAIM_KIND=${k}\nCLAIM_VALUE=v\nROUTE=verify\n`).claimKind).toBe(k);
    }
  });
});

describe("extractQuestionPayload", () => {
  it("message + claim → verify-route KV payload", () => {
    expect(extractQuestionPayload({ event: "question", message: "need X", claim: { kind: "path", value: "/x" } }, 1700000000))
      .toBe("TEXT=need X\nCLAIM_KIND=path\nCLAIM_VALUE=/x\nROUTE=verify\nASKED_AT=1700000000\n");
  });
  it("message, no claim → escalate route, empty kind/value", () => {
    expect(extractQuestionPayload({ event: "question", message: "should I keep the fallback?" }, 42))
      .toBe("TEXT=should I keep the fallback?\nCLAIM_KIND=\nCLAIM_VALUE=\nROUTE=escalate\nASKED_AT=42\n");
  });
  it("multiline message → %0A encoded, round-trips through parseQuestionPayload", () => {
    const payload = extractQuestionPayload({ event: "question", message: "line1\nline2" }, 7)!;
    expect(payload).toContain("TEXT=line1%0Aline2\n");
    expect(parseQuestionPayload(payload).text).toBe("line1\nline2");
  });
  it("empty/absent message → null", () => {
    expect(extractQuestionPayload({ event: "question", message: "" }, 1)).toBeNull();
    expect(extractQuestionPayload({ event: "question" }, 1)).toBeNull();
  });
});

describe("objection route (OBJECTION: marker on the no-claim side)", () => {
  const dec = (msg: string) =>
    parseQuestionPayload(extractQuestionPayload({ event: "question", message: msg }, 0)!).text;

  it("parseQuestionPayload reads ROUTE=objection", () => {
    expect(parseQuestionPayload("TEXT=x\nCLAIM_KIND=\nCLAIM_VALUE=\nROUTE=objection\n").route).toBe("objection");
  });
  it("parseQuestionPayload: unknown ROUTE still defaults to escalate after the widening", () => {
    expect(parseQuestionPayload("TEXT=x\nROUTE=bogus\n").route).toBe("escalate");
  });
  it("extract: no claim + OBJECTION: message → objection route, marker + one space stripped", () => {
    expect(extractQuestionPayload({ event: "question", message: "OBJECTION: the slice is wrong" }, 5))
      .toBe("TEXT=the slice is wrong\nCLAIM_KIND=\nCLAIM_VALUE=\nROUTE=objection\nASKED_AT=5\n");
  });
  it("extract: claim wins even when the message starts with OBJECTION:", () => {
    expect(extractQuestionPayload({ event: "question", message: "OBJECTION: x", claim: { kind: "path", value: "/x" } }, 5))
      .toBe("TEXT=OBJECTION: x\nCLAIM_KIND=path\nCLAIM_VALUE=/x\nROUTE=verify\nASKED_AT=5\n");
  });
  it("marker is anchored + case-sensitive; near-misses route to escalate", () => {
    expect(extractQuestionPayload({ event: "question", message: " OBJECTION: x" }, 5)).toContain("ROUTE=escalate\n");
    expect(extractQuestionPayload({ event: "question", message: "I think OBJECTION: x" }, 5)).toContain("ROUTE=escalate\n");
    expect(extractQuestionPayload({ event: "question", message: "objection: x" }, 5)).toContain("ROUTE=escalate\n");
  });
  it("strip is exact: one marker + at most one following space, via round-tripped decoded text", () => {
    expect(dec("OBJECTION: hi")).toBe("hi");
    expect(dec("OBJECTION:hi")).toBe("hi");
    expect(dec("OBJECTION:  hi")).toBe(" hi");                 // only one space stripped, one survives
    expect(dec("OBJECTION: a OBJECTION: b")).toBe("a OBJECTION: b"); // only the leading marker stripped
  });
  it("empty prose after the marker → objection route with empty TEXT", () => {
    const p1 = extractQuestionPayload({ event: "question", message: "OBJECTION:" }, 0)!;
    expect(p1).toContain("ROUTE=objection\n");
    expect(parseQuestionPayload(p1).text).toBe("");
    const p2 = extractQuestionPayload({ event: "question", message: "OBJECTION: " }, 0)!;
    expect(parseQuestionPayload(p2).text).toBe("");
  });
  it("round-trip extract→parse preserves objection route + stripped multiline text", () => {
    const payload = extractQuestionPayload({ event: "question", message: "OBJECTION: nope\nsecond line" }, 0)!;
    const p = parseQuestionPayload(payload);
    expect(p.route).toBe("objection");
    expect(p.text).toBe("nope\nsecond line");
  });
});
