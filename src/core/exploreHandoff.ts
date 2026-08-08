// src/core/exploreHandoff.ts — handoff-data.kv extraction for /ap:explore (port of the
// extract-handoff-data helper in meditate.sh). RECONCILED reads: confidence_signals from
// adversary-skip.txt, adversary_findings_paths from adversary-*.md (the bash read filenames the
// directive never wrote). Key set + order is FROZEN.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic.js";
import { isoUtc } from "./archive.js";
import { log } from "./log.js";
import { topApproach as firstApproach } from "./exploreConfidence.js"; // reuse the same first-approach scan
import { readIfExistsOrNull as readIf } from "./fsread.js";
import { parseListFile, lastTag } from "./roster.js";

/** What happened to one cross-verification leg (crossverify / adversary): `covered` — a wait
 *  ACCEPTED some worker's artifact for it; `benign` — the run deliberately closed the leg with
 *  nothing to do (no peer claims to verify / the confidence gate skipped the adversary); `lost` —
 *  it was supposed to run and did not. */
export type LegStatus = "covered" | "benign" | "lost";

/** The run's cross-verification headline: `ok` both legs covered, `gate-skipped` the adversary was
 *  deliberately gated off and cross-verify held, `none` both legs lost (the 2026-07-31 lockout:
 *  two independent research docs, nothing checking either against the other), `partial` anything
 *  in between. */
export type CrossVerification = "ok" | "gate-skipped" | "partial" | "none";

export interface CoverageStamp { value: CrossVerification; crossverify: LegStatus; adversary: LegStatus; }

export interface HandoffInput {
  topic: string;
  landscapeDoc?: string;
  topApproach: string;
  findingsPaths: string[];
  confidenceSignals: string;
  adversaryFindingsPaths: string[];
  tradeoffMatrixPresent: boolean;
  /** Omitted for a degraded (single-worker) run and for a run with no roster to judge — see
   *  `crossVerificationCoverage`. Omitted means the two coverage lines are not emitted at all. */
  coverage?: CoverageStamp;
  generatedTs: string;
}

/** handoff-data.kv body. Key ORDER is load-bearing. Conditional lines omitted when empty. */
export function buildHandoffKv(i: HandoffInput): string {
  const L: string[] = [];
  L.push(`mode=${i.topApproach ? "explore" : "explore-no-convergence"}`);
  L.push(`topic=${i.topic}`);
  if (i.landscapeDoc) L.push(`landscape_doc=${i.landscapeDoc}`);
  if (i.topApproach) L.push(`top_approach=${i.topApproach}`);
  if (i.findingsPaths.length) L.push(`findings_paths=${i.findingsPaths.join(",")}`);
  if (i.confidenceSignals) L.push(`confidence_signals=${i.confidenceSignals}`);
  if (i.adversaryFindingsPaths.length) L.push(`adversary_findings_paths=${i.adversaryFindingsPaths.join(",")}`);
  L.push(`tradeoff_matrix_present=${i.tradeoffMatrixPresent}`);
  // Additive since 2026-08-08 (the liveness-guards spec): the ONE documented extension of the frozen
  // key set, placed ahead of the frozen tail so every consumer's tail offsets are untouched. The
  // detail line is what lets Phase 9c name WHICH leg ran instead of guessing.
  if (i.coverage) {
    L.push(`cross_verification=${i.coverage.value}`);
    L.push(`cross_verification_detail=crossverify=${i.coverage.crossverify},adversary=${i.coverage.adversary}`);
  }
  L.push("session_path=.");
  L.push("topic_txt_path=topic.txt");
  L.push(`generated_ts=${i.generatedTs}`);
  return L.join("\n") + "\n";
}

/** Either a stamp, or a documented reason there is none: a degraded run (one worker — the DEGRADED
 *  stamp already carries the honest caveat, and a solo worker's adversary pass is self-review, not
 *  cross-verification) or no roster at all (nothing to judge coverage against). */
export type CoverageResult =
  | { kind: "stamp"; stamp: CoverageStamp }
  | { kind: "degraded" }
  | { kind: "no-roster" };

/** The wait's OWN acceptance verdicts. A leg counts as covered when a wait accepted an artifact for
 *  it — never when `<KEY>=ok` appears: explore.md forbids gating on that value, `VS=ok` can sit
 *  beside `AC=expired`, and verifyState answers `missing` for a worker that replied but wrote
 *  nothing. Each layer publishes its verdict; this one reads that verdict, it does not re-derive it. */
const ACCEPTED = new Set(["sentinel", "quiescent"]);

/** One leg's status. `covered` when any worker's state file carries an accepted `AC=`; else `benign`
 *  when every worker's skip was the run's own deliberate no-op; else `lost`. */
function legStatus(artDir: string, agents: string[], phase: string, benign: (agent: string) => boolean): LegStatus {
  if (agents.some((a) => ACCEPTED.has(lastTag(readIf(join(artDir, `${phase}-${a}.txt`)) ?? "", "AC") ?? ""))) {
    return "covered";
  }
  return agents.every(benign) ? "benign" : "lost";
}

/** Cross-verification coverage, read from what each layer RECORDED about itself.
 *
 *  crossverify's benign marker is `crossverify-claims-<agent>.txt` existing and empty: the send verb
 *  writes that file immediately before its "no peer claims to verify" skip, and the dispatch guard
 *  returns BEFORE it is written — so its existence discriminates the deliberate no-op from a guard
 *  skip exactly. adversary's is the confidence gate's own record, `user_decision: skip`.
 *
 *  Matrix: both covered → ok; the adversary gated off while cross-verify held (covered or benign) →
 *  gate-skipped; both lost → none; anything else → partial. */
export function crossVerificationCoverage(artDir: string): CoverageResult {
  const list = readIf(join(artDir, "list.txt"));
  if (list === null) return { kind: "no-roster" };
  const agents = parseListFile(list).map((r) => r.agent);
  if (agents.length < 2) return { kind: "degraded" };

  const claimsEmpty = (a: string): boolean => {
    const claims = readIf(join(artDir, `crossverify-claims-${a}.txt`));
    return claims !== null && claims.trim() === "";
  };
  const gateSkipped = /^user_decision: skip$/m.test(readIf(join(artDir, "adversary-skip.txt")) ?? "");

  const crossverify = legStatus(artDir, agents, "crossverify", claimsEmpty);
  const adversary = legStatus(artDir, agents, "adversary", () => gateSkipped);

  const value: CrossVerification =
    crossverify === "covered" && adversary === "covered" ? "ok"
      : adversary === "benign" && crossverify !== "lost" ? "gate-skipped"
        : crossverify === "lost" && adversary === "lost" ? "none"
          : "partial";
  return { kind: "stamp", stamp: { value, crossverify, adversary } };
}

/** Walk an art dir → write handoff-data.kv. Returns the path, or null if art-dir/topic.txt missing. */
export function extractHandoffData(artDir: string, now?: Date): string | null {
  if (!existsSync(artDir) || !statSync(artDir).isDirectory()) return null;
  const topicTxt = readIf(join(artDir, "topic.txt"));
  if (topicTxt === null) return null;
  const topic = topicTxt.replace(/\n/g, " ").replace(/ +$/, "");

  const names = readdirSync(artDir);
  // landscape: prefer the non-draft (final) match, else landscape-draft.md. Sorted so .find picks
  // the lexically-first non-draft deterministically (matches the bash `for f in landscape-*.md`).
  const landscapes = names.filter((n) => /^landscape-.*\.md$/.test(n)).sort();
  const landscapeDoc = landscapes.find((n) => n !== "landscape-draft.md")
    ?? (landscapes.includes("landscape-draft.md") ? "landscape-draft.md" : undefined);

  const findingsPaths = names.filter((n) => /^findings-.*\.md$/.test(n)).sort();
  const adversaryFindingsPaths = names.filter((n) => /^adversary-.*\.md$/.test(n)).sort();

  let top = "", tradeoff = false;
  if (landscapeDoc) {
    const doc = readFileSync(join(artDir, landscapeDoc), "utf8");
    top = firstApproach(doc);
    tradeoff = /^## Tradeoff matrix/m.test(doc);
  }

  // RECONCILED: confidence_signals from adversary-skip.txt's signals_passed line → CSV.
  let confidenceSignals = "";
  const skip = readIf(join(artDir, "adversary-skip.txt"));
  if (skip) {
    const m = skip.split("\n").find((l) => l.startsWith("signals_passed:"));
    if (m) confidenceSignals = m.replace(/^signals_passed:\s*/, "").trim().replace(/\s+/g, ",");
  }

  const cov = crossVerificationCoverage(artDir);
  if (cov.kind === "no-roster") {
    log.warn(`explore handoff: no list.txt at ${artDir} — cross-verification coverage not stamped (nothing to judge it against)`);
  }
  if (cov.kind === "stamp" && cov.stamp.value === "none") {
    log.warn("explore handoff: cross_verification=none — zero cross-verification; the landscape is an unverified single-pass survey");
  }

  const body = buildHandoffKv({
    topic, landscapeDoc, topApproach: top, findingsPaths, confidenceSignals,
    adversaryFindingsPaths, tradeoffMatrixPresent: tradeoff,
    coverage: cov.kind === "stamp" ? cov.stamp : undefined, generatedTs: isoUtc(now),
  });
  const dest = join(artDir, "handoff-data.kv");
  atomicWrite(dest, body);
  return dest;
}
