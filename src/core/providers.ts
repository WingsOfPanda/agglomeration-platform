import { existsSync, readFileSync } from "node:fs";

/** Parse a providers-*.txt body: one provider per line; skip blank and #-comment lines; trim. */
export function parseProviderList(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** Read + parse a provider-list file. Missing or unreadable → []. */
export function readProviderList(path: string): string[] {
  if (!existsSync(path)) return [];
  try { return parseProviderList(readFileSync(path, "utf8")); } catch { return []; }
}
