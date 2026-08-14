// src/core/implementQuestions.ts — the implement-side QUESTION-CLAIM verifier: dispatch a claim of
// kind {path,git,env,cmd,test} and format the hub's reply.
//
// UNWIRED BY DECISION. No command calls verifyClaim/formatReply; the hub answers a routed claim in
// the directive instead. Adjudicated 2026-07-06 (memory: simplify-sweep-2026-07-06-skips) — the
// finding was placement, never deletion, so this stays as the port of the prior plugin's
// worker-question lib and keeps its tests. The WIRED half of the protocol — the payload codec the
// hub actually runs — moved to core/questionCodec.ts.
//
// Side effects (git ref resolution, command lookup, diagnostic test runs) shell through an injected
// Runner so unit tests stay pure. Filesystem (path) + environment (env) checks read ambient state.
import { existsSync, accessSync, constants, statSync } from "node:fs";
import type { Runner } from "./gitwork.js";

export interface VerifyResult { rc: 0 | 1 | 2; evidence: string; }

/** Strip trailing newline(s), matching bash `$(...)` capture (which strips all trailing newlines)
 *  + the reply's own printf '%s\n'. */
function trimTrailingNewline(s: string): string { return s.replace(/\n+$/, ""); }

/** Verify a claim of `kind` carrying `value`. rc=0 confirmed / rc=1 refuted / rc=2 unverifiable
 *  (empty kind|value, unknown kind, banned test command, test timeout=exit 124). Never throws. */
export function verifyClaim(kind: string, value: string, runner?: Runner): VerifyResult {
  if (!kind || !value) return { rc: 2, evidence: "" };
  switch (kind) {
    case "path": {
      try {
        if (existsSync(value)) {
          accessSync(value, constants.R_OK);
          let detail = value;
          try { const st = statSync(value); detail = `${st.isDirectory() ? "d" : "-"} ${st.size} ${value}`; } catch { /* keep bare value */ }
          return { rc: 0, evidence: detail };
        }
      } catch { /* not readable -> refuted */ }
      return { rc: 1, evidence: "" };
    }
    case "git": {
      if (!runner) return { rc: 1, evidence: "" };
      const r = runner.run("git", ["rev-parse", "--verify", value]);
      if (r.code === 0) return { rc: 0, evidence: trimTrailingNewline(r.stdout) };
      return { rc: 1, evidence: "" };
    }
    case "env": {
      const val = process.env[value];
      if (val !== undefined && val !== "") return { rc: 0, evidence: val };
      return { rc: 1, evidence: "" };
    }
    case "cmd": {
      if (!runner) return { rc: 1, evidence: "" };
      const r = runner.run("command", ["-v", "--", value]);
      if (r.code === 0) return { rc: 0, evidence: trimTrailingNewline(r.stdout) };
      return { rc: 1, evidence: "" };
    }
    case "test": {
      if (value.startsWith("tests/run.sh") || value.startsWith("bash tests/run.sh")) return { rc: 2, evidence: "" };
      if (!runner) return { rc: 2, evidence: "" };
      const r = runner.run("timeout", ["30", "bash", "-c", "--", value]);
      const evidence = trimTrailingNewline(r.stdout);
      if (r.code === 124) return { rc: 2, evidence };
      if (r.code === 0) return { rc: 0, evidence };
      return { rc: 1, evidence };
    }
    default:
      return { rc: 2, evidence: "" };
  }
}

/** Format the inbox.md reply body for the worker (rebranded From: hub). Begins with FOUND /
 *  NOT FOUND / UNVERIFIABLE and ends with "Resume implementation.\n". kind=test inserts a NOTE. */
export function formatReply(kind: string, value: string, rc: number, evidence: string): string {
  const verdict = rc === 0 ? "FOUND" : rc === 1 ? "NOT FOUND" : "UNVERIFIABLE";
  let body =
    `From: hub\n\n` +
    `Verdict: ${verdict}\n` +
    `Claim kind: ${kind}\n` +
    `Claim value: ${value}\n\n` +
    `Evidence:\n` +
    `${evidence}\n\n`;
  if (kind === "test") {
    body +=
      `NOTE: kind=test was a diagnostic check only — running your full test\n` +
      `suite is your job, not mine. Use this protocol for short verification\n` +
      `queries, not for offloading work.\n\n`;
  }
  body += `Resume implementation.\n`;
  return body;
}
