// Shared row splitter for the `.tsv` sidecars. Pure: text in, cells out — blank lines and the
// header row (`<headerToken>...`) are skipped, every other line is tab-split. Each artifact module
// wraps this with its own header token + field names; nobody outside them indexes a column.

export function splitTsvRows(text: string, headerToken: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith(headerToken)) continue;
    rows.push(line.split("\t"));
  }
  return rows;
}
