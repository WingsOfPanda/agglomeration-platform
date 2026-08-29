// src/core/questionCodec.ts — the WIRED half of the implement QUESTION protocol: the payload codec
// the hub uses to turn a worker's `question` outbox event into a question-<worker>-<round>.txt KV
// payload and read it back. Byte-faithful port of the prior bash plugin's deploy-questions lib
// (payload extractor) + the worker-question line validator, rebranded for ap. Pure: no filesystem,
// no subprocess. The hub verifies the routed claim itself per commands/implement.md (the parked
// claim-verify module was deleted in the 0.5.59 purge; see git history for implementQuestions.ts).
import type { OutboxEvent } from "./ipc.js";

/** Percent-decode the 6 escapes (TEXT field). %0A->nl, %09->tab, %22->", %5C->\, %2C->comma,
 *  %25->%. Order matters: %25 is decoded LAST so nested encodings like %2522 round-trip. */
export function percentDecode(s: string): string {
  return s
    .replaceAll("%0A", "\n")
    .replaceAll("%09", "\t")
    .replaceAll("%22", '"')
    .replaceAll("%5C", "\\")
    .replaceAll("%2C", ",")
    .replaceAll("%25", "%"); // literal-percent escape — must be LAST
}

/** Exact inverse of percentDecode — encode the same 6 escapes so a message round-trips through the
 *  KV payload unchanged. `%` FIRST (mirroring percentDecode's %25-LAST), so a literal `%` becomes
 *  `%25` and a message that itself contains `%2C`/`%0A` survives instead of being decoded on the way
 *  out. Without this, a message like `5%2C000` would decode to `5,000`. */
export function percentEncode(s: string): string {
  return s
    .replaceAll("%", "%25") // literal-percent escape — must be FIRST
    .replaceAll("\n", "%0A")
    .replaceAll("\t", "%09")
    .replaceAll('"', "%22")
    .replaceAll("\\", "%5C")
    .replaceAll(",", "%2C");
}

export type ClaimKind = "path" | "git" | "env" | "cmd" | "test" | "";
export type ClaimRoute = "verify" | "escalate" | "objection";

export interface QuestionPayload { text: string; claimKind: ClaimKind; claimValue: string; route: ClaimRoute; }

const KNOWN_KINDS = new Set<ClaimKind>(["path", "git", "env", "cmd", "test"]);

/** Parse a question-<worker>-<round>.txt payload body. KEY=value lines: TEXT (percent-encoded),
 *  CLAIM_KIND, CLAIM_VALUE, ROUTE. Value = everything after the FIRST '=' on the first matching
 *  line. ROUTE defaults to escalate; CLAIM_KIND/VALUE default to "" when absent. */
export function parseQuestionPayload(body: string): QuestionPayload {
  const first = (key: string): string | null => {
    for (const line of body.split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      if (line.slice(0, eq) === key) return line.slice(eq + 1);
    }
    return null;
  };
  const rawText = first("TEXT");
  const text = rawText === null ? "" : percentDecode(rawText);
  const rawKind = first("CLAIM_KIND") ?? "";
  const claimKind: ClaimKind = KNOWN_KINDS.has(rawKind as ClaimKind) ? (rawKind as ClaimKind) : "";
  const claimValue = first("CLAIM_VALUE") ?? "";
  const rawRoute = first("ROUTE") ?? "escalate";
  const route: ClaimRoute = rawRoute === "verify" ? "verify" : rawRoute === "objection" ? "objection" : "escalate";
  return { text, claimKind, claimValue, route };
}

/** Port of the prior plugin's worker-question validate-line helper: a question event is well-formed iff
 *  its message is non-empty printable-ASCII (+tab/newline) with no raw escaped quote/backslash, AND any
 *  present `claim` has kind in {path,git,env,cmd,test} and a non-empty value. Returns false otherwise so
 *  the caller downgrades to TS=failed rather than routing a malformed claim to verify. */
export function validateQuestionLine(ev: OutboxEvent): boolean {
  const message = typeof ev.message === "string" ? ev.message : "";
  if (message === "") return false;
  if (!/^[\x09\x0A\x20-\x7E]*$/.test(message)) return false;      // printable ASCII + tab + newline only
  if (message.includes('\\"') || message.includes("\\\\")) return false; // raw escapes belong percent-encoded
  const claim = ev.claim as { kind?: string; value?: string } | undefined;
  if (claim) {
    const kind = typeof claim.kind === "string" ? claim.kind : "";
    const value = typeof claim.value === "string" ? claim.value : "";
    if (!KNOWN_KINDS.has(kind as ClaimKind) || value === "") return false;
    if (/[\r\n]/.test(value)) return false; // a newline in claim.value would inject KV lines (ROUTE forgery)
  }
  return true;
}

/** Conductor-side extractor (port of deploy_question_extract_to_payload, deploy-questions.sh:15):
 *  a question OutboxEvent -> the KV payload file body. ap uses the frozen `message` field for
 *  the reason text (the prior plugin used `text`); `claim:{kind,value}` is the implement discriminator.
 *  Only the newline is percent-encoded at extract time (%0A) — parseQuestionPayload's full table
 *  decodes it. Returns null when there is no usable message. */
export function extractQuestionPayload(ev: OutboxEvent, askedAt: number): string | null {
  if (!validateQuestionLine(ev)) return null;
  let message = ev.message as string;
  const claim = ev.claim as { kind?: string; value?: string } | undefined;
  // Claim-wins precedence: a claim is always `verify`; the OBJECTION: marker is consulted ONLY on
  // the no-claim side, widening the prior two-way discriminant on its else branch only.
  const route: ClaimRoute = claim ? "verify" : /^OBJECTION:/.test(message) ? "objection" : "escalate";
  if (route === "objection") message = message.replace(/^OBJECTION: ?/, ""); // strip one marker + at most one space
  const encoded = percentEncode(message);
  const kind = claim && typeof claim.kind === "string" ? claim.kind : "";
  const value = claim && typeof claim.value === "string" ? claim.value : "";
  return `TEXT=${encoded}\nCLAIM_KIND=${kind}\nCLAIM_VALUE=${value}\nROUTE=${route}\nASKED_AT=${askedAt}\n`;
}
