import { existsSync, readFileSync } from "node:fs";

/** File contents as utf8, or "" when the path does not exist. */
export function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** File contents as utf8, or null when the path does not exist. */
export function readIfExistsOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** First line of a single-value state file, trimmed; "" if absent. */
export function readField(path: string): string {
  return readIfExists(path).split("\n")[0].trim();
}

/** A `key=value` line's value from a KV file (key regex-escaped); "" if absent/unmatched. */
export function kvField(path: string, key: string): string {
  if (!existsSync(path)) return "";
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = readFileSync(path, "utf8").match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}
