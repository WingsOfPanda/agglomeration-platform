import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenizeArgsLine, applyArgsFile, expandArgsFile, kvParse, ArgsFileError, KvError } from "../src/args.js";
import { dispatch } from "../src/core/dispatch.js";

describe("args", () => {
  it("tokenize preserves quoted phrases + literal metachars", () => {
    expect(tokenizeArgsLine('bravo codex demo "hello world"')).toEqual(["bravo", "codex", "demo", "hello world"]);
    expect(tokenizeArgsLine('a "; touch /tmp/x; #"')).toEqual(["a", "; touch /tmp/x; #"]);
  });
  it("applyArgsFile passthrough + empty", () => {
    expect(applyArgsFile(["foo", "bar"])).toEqual(["foo", "bar"]);
    expect(applyArgsFile([])).toEqual([]);
  });
  it("applyArgsFile loads + consumes + appends", () => {
    const f = join(mkdtempSync(join(tmpdir(), "af-")), "args");
    writeFileSync(f, 'bravo codex auth-review "hello world"');
    expect(applyArgsFile(["--args-file", f, "extra1"])).toEqual(["bravo", "codex", "auth-review", "hello world", "extra1"]);
    expect(existsSync(f)).toBe(false); // consumed
  });
  it("applyArgsFile: no path throws code 2", () => {
    expect(() => applyArgsFile(["--args-file"])).toThrow(ArgsFileError);
  });
  it("applyArgsFile: missing file fails closed — rc 2 and the re-mint hint, no-opts and verbatim alike", () => {
    const msg = "args file not found: /nope/x (a one-shot args file is consumed by the first init that reads it; re-mint with --mint-args-file)";
    expect(() => applyArgsFile(["--args-file", "/nope/x", "extra"])).toThrow(ArgsFileError);
    expect(() => applyArgsFile(["--args-file", "/nope/x", "extra"])).toThrow(msg);
    expect(() => applyArgsFile(["--args-file", "/nope/x"], { valueFlags: new Set<string>() })).toThrow(msg);
    let code = -1;
    try { applyArgsFile(["--args-file", "/nope/x"]); } catch (e) { code = (e as ArgsFileError).code; }
    expect(code).toBe(2);
  });
  it("applyArgsFile preserves content after the first newline (multi-line $ARGUMENTS)", () => {
    const f = join(mkdtempSync(join(tmpdir(), "af-")), "args");
    writeFileSync(f, "enhance debug mode\nENHANCEMENT one\nENHANCEMENT two");
    expect(applyArgsFile(["--args-file", f])).toEqual([
      "enhance", "debug", "mode", "ENHANCEMENT", "one", "ENHANCEMENT", "two",
    ]);
  });
  it("applyArgsFile: a flag on line 1 and a multi-line topic body all survive", () => {
    const f = join(mkdtempSync(join(tmpdir(), "af-")), "args");
    writeFileSync(f, "--ensemble\nresearch the thing\nwith more detail");
    expect(applyArgsFile(["--args-file", f])).toEqual([
      "--ensemble", "research", "the", "thing", "with", "more", "detail",
    ]);
  });
  it("applyArgsFile handles CRLF line endings", () => {
    const f = join(mkdtempSync(join(tmpdir(), "af-")), "args");
    writeFileSync(f, "alpha beta\r\ngamma");
    expect(applyArgsFile(["--args-file", f])).toEqual(["alpha", "beta", "gamma"]);
  });
  it("applyArgsFile: consecutive and trailing newlines yield no empty tokens", () => {
    const f = join(mkdtempSync(join(tmpdir(), "af-")), "args");
    writeFileSync(f, "one\n\ntwo\n");
    expect(applyArgsFile(["--args-file", f])).toEqual(["one", "two"]);
  });
  it("kvParse forms", () => {
    expect(kvParse("--mode=test")).toEqual({ value: "test", shift: 1 });
    expect(kvParse("--mode", "v")).toEqual({ value: "v", shift: 2 });
    expect(kvParse("--targets", "")).toEqual({ value: "", shift: 2 }); // empty ok
    expect(kvParse("--mode=a=b=c")).toEqual({ value: "a=b=c", shift: 1 }); // first = only
    expect(() => kvParse("--mode")).toThrow(KvError);
  });
});

describe("applyArgsFile verbatim-tail (prose mode)", () => {
  function af(content: string): string {
    const f = join(mkdtempSync(join(tmpdir(), "afv-")), "args");
    writeFileSync(f, content);
    return f;
  }
  const opts = (flags: string[]) => ({ valueFlags: new Set(flags) });

  it("preserves apostrophes and quotes in the body (no shell-tokenizing)", () => {
    expect(applyArgsFile(["--args-file", af('fix the worker\'s "UI" today')], opts([])))
      .toEqual(['fix the worker\'s "UI" today']);
  });
  it("preserves internal newlines / paragraphs verbatim", () => {
    expect(applyArgsFile(["--args-file", af("para one\n\npara two\nmore")], opts([])))
      .toEqual(["para one\n\npara two\nmore"]);
  });
  it("an internal --word stays inside the verbatim body", () => {
    expect(applyArgsFile(["--args-file", af("use --force carefully please")], opts([])))
      .toEqual(["use --force carefully please"]);
  });
  it("empty body yields just the flags (no empty token)", () => {
    expect(applyArgsFile(["--args-file", af("--ensemble")], opts([]))).toEqual(["--ensemble"]);
  });
  it("trims a trailing newline the Write tool appends", () => {
    expect(applyArgsFile(["--args-file", af("body text\n")], opts([]))).toEqual(["body text"]);
  });
  it("consumes the args file (like the no-opts path)", () => {
    const f = af("hello there");
    applyArgsFile(["--args-file", f], opts([]));
    expect(existsSync(f)).toBe(false);
  });
  it("no-opts path is unchanged (still shell-tokenizes, glues the unterminated quote)", () => {
    expect(applyArgsFile(["--args-file", af("fix the worker's thing")]))
      .toEqual(["fix", "the", "workers thing"]);
  });
  it("a value-flag with no following value pushes only the flag (no empty token)", () => {
    expect(applyArgsFile(["--args-file", af("--targets")], opts(["--targets"]))).toEqual(["--targets"]);
  });
});

describe("applyArgsFile position refusal", () => {
  function af(content: string): string {
    const f = join(mkdtempSync(join(tmpdir(), "afp-")), "args");
    writeFileSync(f, content);
    return f;
  }

  it("a prose-body verb refuses a non-first --args-file and leaves the file on disk", () => {
    const f = af("some topic body");
    expect(() => applyArgsFile(["--provider", "codex", "--args-file", f], { valueFlags: new Set(["--provider"]) }))
      .toThrow(ArgsFileError);
    expect(existsSync(f)).toBe(true); // not consumed: a corrected retry can still read it
  });

  it("the no-opts `job start` passthrough is unaffected", () => {
    const f = af("some topic body");
    const argv = ["job", "start", "--args-file", f];
    expect(applyArgsFile(argv)).toEqual(argv);
    expect(existsSync(f)).toBe(true);
  });

  it("argv[0] --args-file still expands, and a body naming --args-file is not re-scanned", () => {
    const f = af("never pass --args-file late");
    expect(applyArgsFile(["--args-file", f], { valueFlags: new Set<string>() }))
      .toEqual(["never pass --args-file late"]);
    expect(existsSync(f)).toBe(false); // consumed as usual
  });

  it("dispatch converts an ArgsFileError into rc 2 with the message on stderr", async () => {
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { errs.push(String(s)); return true; };
    let rc = -1;
    try { rc = await dispatch(async () => { throw new ArgsFileError("--args-file must be the first argument"); }, []); }
    finally { (process.stderr as any).write = orig; }
    expect(rc).toBe(2);
    expect(errs.join("")).toBe("--args-file must be the first argument\n"); // message, not a stack
  });
});

describe("expandArgsFile (the verb-level no-opts loader)", () => {
  function af(content: string): string {
    const f = join(mkdtempSync(join(tmpdir(), "afh-")), "args");
    writeFileSync(f, content);
    return f;
  }

  it("a non-first --args-file pair is expanded IN PLACE: tokens on both sides keep their order, file consumed", () => {
    const f = af("docs/design.md --topic add-oauth");
    expect(expandArgsFile(["--no-worktree", "--args-file", f, "--target", "/wt"]))
      .toEqual(["--no-worktree", "docs/design.md", "--topic", "add-oauth", "--target", "/wt"]);
    expect(existsSync(f)).toBe(false);
  });

  it("any position: index 1, index 3, and last", () => {
    expect(expandArgsFile(["a", "--args-file", af("X Y")])).toEqual(["a", "X", "Y"]);
    expect(expandArgsFile(["a", "b", "c", "--args-file", af("X")])).toEqual(["a", "b", "c", "X"]);
    expect(expandArgsFile(["a", "b", "c", "--args-file", af("X"), "d"])).toEqual(["a", "b", "c", "X", "d"]);
  });

  it("a positional-first verb keeps its positional first: `<topic> --args-file <reason>` never swaps them", () => {
    expect(expandArgsFile(["realtopic", "--args-file", af("budget blown")])).toEqual(["realtopic", "budget", "blown"]);
  });

  it("argv[0] pair is exactly applyArgsFile's shape (tokens, then the tail)", () => {
    const f = af("docs/design.md");
    expect(expandArgsFile(["--args-file", f, "--target", "/wt"])).toEqual(["docs/design.md", "--target", "/wt"]);
    expect(existsSync(f)).toBe(false);
  });

  it("no --args-file at all is a passthrough", () => {
    expect(expandArgsFile(["--target", "/wt", "docs/design.md"])).toEqual(["--target", "/wt", "docs/design.md"]);
  });

  it("a trailing --args-file with no path is rc 2, never a neighbour token read as the path", () => {
    expect(() => expandArgsFile(["--target", "/wt", "--args-file"])).toThrow(ArgsFileError);
    expect(() => expandArgsFile(["--target", "/wt", "--args-file"])).toThrow("--args-file requires a path");
  });

  it("a second --args-file pair is refused BEFORE either file is consumed", () => {
    const a = af("AAA"), b = af("BBB");
    expect(() => expandArgsFile(["--target", "/wt", "--args-file", a, "--args-file", b])).toThrow("--args-file may be given once");
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it("the top-level dispatch shape [verb, ..., --args-file, p] passes through applyArgsFile untouched, file kept (ap.ts never expands)", () => {
    for (const argv of [["quick", "init", "--args-file", af("topic body")], ["job", "start", "--command", "quick", "--args-file", af("topic body")]]) {
      expect(applyArgsFile(argv)).toEqual(argv);
      expect(existsSync(argv[argv.length - 1])).toBe(true);
    }
    // The site itself: src/ap.ts calls the plain loader and never the expanding one.
    const ap = readFileSync(join(process.cwd(), "src", "ap.ts"), "utf8");
    expect(ap).toMatch(/applyArgsFile\(rest\)/);
    expect(ap).not.toMatch(/expandArgsFile/);
  });
});

describe("src/ap.ts top-level dispatch, built and executed", () => {
  // A source-text pin cannot see an inline expansion, so the real site is exercised: build src/ap.ts
  // with package.json's own esbuild flags (as dist-fresh does) and run the bundle.
  it.skipIf(process.platform === "win32")("a non-first pair reaches the verb UNCONSUMED; an argv[0] pair is consumed (today's list/stop/check contract)", () => {
    const ROOT = process.cwd();
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const out = join(mkdtempSync(join(tmpdir(), "aptop-")), "ap.cjs");
    const args = String(pkg.scripts.build).split(/\s+/).slice(1).map((a) => (a.startsWith("--outfile=") ? `--outfile=${out}` : a));
    execFileSync(join(ROOT, "node_modules", ".bin", "esbuild"), args, { cwd: ROOT });
    const home = mkdtempSync(join(tmpdir(), "aptop-home-"));
    const run = (argv: string[]) => spawnSync(process.execPath, [out, ...argv], { cwd: home, env: { ...process.env, AP_HOME: home }, encoding: "utf8" });

    const kept = join(home, "kept"); writeFileSync(kept, "topic body\n");
    const r1 = run(["quick", "frob", "--args-file", kept]);   // rest = [frob, --args-file, p]: not rest[0]
    expect(r1.status).toBe(2);
    expect(r1.stderr).toMatch(/usage: quick/);                // the verb's usage, never an args-file error
    expect(existsSync(kept)).toBe(true);

    const eaten = join(home, "eaten"); writeFileSync(eaten, "");
    const r2 = run(["list", "--args-file", eaten]);           // rest[0] IS --args-file: consumed here
    expect(r2.status).toBe(0);
    expect(existsSync(eaten)).toBe(false);
  });
});
