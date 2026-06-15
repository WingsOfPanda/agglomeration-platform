import { existsSync, readFileSync } from "node:fs";
import { splitNonCommentLines } from "./text.js";

/** Parse a providers-*.txt body: one provider per line; skip blank and #-comment lines; trim. */
export function parseProviderList(text: string): string[] {
  return splitNonCommentLines(text);
}

/** Read + parse a provider-list file. Missing or unreadable → []. */
export function readProviderList(path: string): string[] {
  if (!existsSync(path)) return [];
  try { return parseProviderList(readFileSync(path, "utf8")); } catch { return []; }
}

export type ListDecision = "skip" | "auto" | "prompt";

export interface ListPlan {
  detected: string[];   // validated, detected (menu is built from this)
  prior: string[];      // prior selection reconciled against `detected`
  dropped: string[];    // human-readable notes for prior entries no longer present
  decision: ListDecision;
  auto?: string;        // present only when decision === "auto"
}

/** Pure: reconcile the prior selection against the validated-detected set; compute the prompt decision. */
export function planList(input: { detectedValidated: string[]; prior: string[] }): ListPlan {
  const detected = [...input.detectedValidated];
  const prior = input.prior.filter((p) => detected.includes(p));
  const dropped = input.prior.filter((p) => !detected.includes(p)).map((p) => `${p} (no longer detected)`);
  if (detected.length === 0) return { detected, prior, dropped, decision: "skip" };
  if (detected.length === 1) return { detected, prior, dropped, decision: "auto", auto: detected[0] };
  return { detected, prior, dropped, decision: "prompt" };
}

/** Render a providers-*.txt body: two header lines (timestamp + subtitle), then one provider per line. */
export function formatProviderFile(providers: string[], isoStamp: string, subtitle: string): string {
  return `# generated ${isoStamp} by /ap:check\n# ${subtitle}\n${providers.join("\n")}${providers.length ? "\n" : ""}`;
}

/** The providers-active.txt body. */
export function formatActiveFile(providers: string[], isoStamp: string): string {
  return formatProviderFile(providers, isoStamp, "active providers selected by user");
}
