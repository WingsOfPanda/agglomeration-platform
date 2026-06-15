/** Split text into trimmed, non-blank, non-`#`-comment lines. Shared by the provider-list and
 *  list/design line parsers so the "one item per line, skip blank + #-comment, trim" predicate
 *  has a single source of truth. */
export function splitNonCommentLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
}
