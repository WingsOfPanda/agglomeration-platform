import { readFileSync, existsSync, rmSync } from "node:fs";

export class ArgsFileError extends Error { code = 2; }
export class KvError extends Error { code = 2; constructor(public flag: string) { super(`${flag} requires a value`); } }

export function tokenizeArgsLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inS = false, inD = false, started = false;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (inS) { if (ch === "'") inS = false; else cur += ch; continue; }
    if (inD) { if (ch === '"') inD = false; else cur += ch; continue; }
    if (ch === "'") { inS = true; started = true; continue; }
    if (ch === '"') { inD = true; started = true; continue; }
    if (ch === " " || ch === "\t") { if (started) { out.push(cur); cur = ""; started = false; } continue; }
    cur += ch; started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** The fail-closed answer for a path that is not there — thrown by BOTH loaders. The file is
 *  one-shot (consumed by the first init that reads it), so a retry after a failed init used to load
 *  `[]` and die one verb later on "topic text is empty" / "exactly one design-doc path is required":
 *  the symptom, never the cause. `ArgsFileError` carries rc 2. */
function missingArgsFile(path: string): ArgsFileError {
  return new ArgsFileError(`args file not found: ${path} (a one-shot args file is consumed by the first init that reads it; re-mint with --mint-args-file)`);
}

function loadArgsFile(path: string): string[] {
  if (!existsSync(path)) throw missingArgsFile(path);
  // The conductor writes $ARGUMENTS verbatim, which may span multiple lines (a
  // multi-paragraph topic). Read the WHOLE file; collapse newlines to spaces so line
  // breaks act as token separators without gluing words across the seam. Reading only
  // the first line silently dropped everything after the first newline.
  const raw = readFileSync(path, "utf8").replace(/\r?\n/g, " ");
  return tokenizeArgsLine(raw);
}

export interface ArgsFileOpts { valueFlags: Set<string>; }

/** Verbatim-tail loader for prose-body commands: peel LEADING `--flag [value]` pairs (a flag in
 *  `valueFlags` without `=` consumes the next whitespace-delimited token), then take the rest of the
 *  file as ONE verbatim body token — internal whitespace, newlines, apostrophes, and quotes intact.
 *  Mirrors the legacy plugin's verbatim-cat delivery; does NOT shell-tokenize the body. */
function loadArgsFileVerbatim(path: string, valueFlags: Set<string>): string[] {
  if (!existsSync(path)) throw missingArgsFile(path);
  const raw = readFileSync(path, "utf8");
  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  const flags: string[] = [];
  let i = 0;
  for (;;) {
    while (i < raw.length && isWs(raw[i])) i++;            // skip whitespace before the next token
    if (i >= raw.length) break;
    if (!(raw[i] === "-" && raw[i + 1] === "-")) break;     // first token not starting with "--": body starts here (all consecutive leading "--" tokens are peeled — see header)
    let j = i;
    while (j < raw.length && !isWs(raw[j])) j++;            // read the flag token
    const flag = raw.slice(i, j);
    flags.push(flag);
    i = j;
    if (valueFlags.has(flag) && !flag.includes("=")) {      // separate-token value flag: consume its value
      while (i < raw.length && isWs(raw[i])) i++;
      let k = i;
      while (k < raw.length && !isWs(raw[k])) k++;
      if (k > i) { flags.push(raw.slice(i, k)); i = k; }
    }
  }
  const body = raw.slice(i).trim();
  return body ? [...flags, body] : flags;
}

export function applyArgsFile(argv: string[], opts?: ArgsFileOpts): string[] {
  if (argv[0] !== "--args-file") {
    // `opts` present is not a coincidence: it marks exactly the verbs that take a free-form prose
    // body and therefore have no unknown-flag branch, so a misplaced `--args-file` is swallowed into
    // the topic (junk state dir, args file left orphaned) instead of refused. The no-opts call sites
    // either own an unknown-flag branch or must pass the flag through verbatim
    // (`ap job start --args-file <p>` parses the path itself), so they are never scanned.
    if (opts && argv.some((a) => a === "--args-file" || a.startsWith("--args-file=")))
      throw new ArgsFileError("--args-file must be the first argument");
    return [...argv];
  }
  const path = argv[1];
  if (!path) throw new ArgsFileError("--args-file requires a path");
  const tokens = opts ? loadArgsFileVerbatim(path, opts.valueFlags) : loadArgsFile(path);
  try { rmSync(path, { force: true }); } catch { /* ignore */ }   // consume the one-shot args file
  return [...tokens, ...argv.slice(2)];
}

export interface KvParseResult { value: string; shift: 1 | 2; }
export function kvParse(flag: string, next?: string): KvParseResult {
  if (flag.includes("=")) return { value: flag.slice(flag.indexOf("=") + 1), shift: 1 };
  if (next === undefined) throw new KvError(flag);
  return { value: next, shift: 2 };
}
