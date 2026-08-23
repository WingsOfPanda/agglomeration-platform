# `--args-file` position refusal (PR D)

Date: 2026-08-23. Source: `/ap:review` forensics cluster F4 (2 runs, 3 records, both boxes).

## Problem

`applyArgsFile` expands the one-shot args file **only when `--args-file` is `argv[0]`**
(`src/args.ts:64`: `if (argv[0] !== "--args-file") return [...argv];`). Every command directive says
to put it first, but a hub that writes `--target <wt> --args-file <p>` gets two different failures:

- `implement init` — rc 2 `unknown flag` (safe; its own parser refuses).
- `quick init` — **silent**: the literal flag text becomes the TOPIC, minting a junk state dir
  (`args-file-home-liupa` in the field record) and leaving the args file unconsumed on disk. Caught
  only because the hub noticed the slug (xjp `two-part-measurement`, `09-29-41-quick-flag-…`, plus
  the `19-49-27` worker note recording the same slip).

A silent mis-parse that creates state under a garbage topic is the defect; the rc-2 refusal is the
already-correct behavior.

## Goal

Any `--args-file` that reaches a verb in a non-zero position produces a clean rc-2 refusal naming
the requirement, on every verb that owns a prose body — never a junk topic, never a consumed or
orphaned args file. `job start --args-file`, which parses the flag itself and must receive the path
unexpanded, is unaffected.

## Architecture

`applyArgsFile(argv, opts?)` gains one guard on the **no-expansion path only**: when `opts` was
passed AND any token in `argv` is `--args-file` or `--args-file=…`, throw `ArgsFileError` instead of
returning `[...argv]`.

`opts`-presence is the discriminator, and it is exact rather than coincidental: the opts-passing
call sites are precisely the five verbs that take a free-form prose body (so an unrecognized flag
is swallowed into the topic instead of refused), while the no-opts sites either own their own
unknown-flag branch or must pass the flag through. Enumerated from
`grep -rn "applyArgsFile(" src/`:

| Call site | opts? | Today, flag in a later position | After |
|---|---|---|---|
| `src/commands/quick.ts:41` (init) | yes | **silent junk topic** | rc 2 refusal |
| `src/commands/design.ts:47` (init) | yes | silent junk topic | rc 2 refusal |
| `src/commands/explore.ts:49` (init) | yes | silent junk topic | rc 2 refusal |
| `src/commands/bridge.ts:35` (init) | yes | silent junk topic | rc 2 refusal |
| `src/commands/autoresearch.ts:2120` (init) | yes | silent junk topic | rc 2 refusal |
| `src/commands/implement.ts:110` (init) | no | rc 2 `unknown flag` (own parser) | unchanged |
| `src/commands/implement.ts:117` (branch) | no | rc 2 (own parser) | unchanged |
| `src/commands/autoresearch.ts:2129/2134/2141` | no | own parsers | unchanged |
| `src/ap.ts:43` (top level, every subcommand) | no | passthrough — **required** by `job start` | unchanged |

`src/ap.ts:43` is the load-bearing no-opts site: `ap job start --args-file <p>` reaches it as
`["start","--args-file","<p>"]`, is deliberately not expanded, and the path is parsed at
`src/commands/job.ts:310` and validated at `:325`. A throw there would break every detached run.

An `ArgsFileError` thrown from inside a verb currently escapes `dispatch` as rc 1 + a stack:
`src/core/dispatch.ts:13` converts only `KvError` and `SlugError`. It gains `ArgsFileError`.

Two invariants hold by construction: the throw happens only where **no** expansion occurred, so a
loaded body is never re-scanned for the flag; and nothing is deleted on the refusal path, so the
operator's args file survives for a corrected retry.

**Rejected:** a position-agnostic scanner at the dispatcher. It cannot disambiguate a value-flag
whose value is literally `--args-file` (`kvParse` takes the next token blindly and each verb owns a
different `valueFlags` set), and it would have to special-case `job start`.

## Components

- `src/args.ts` — `applyArgsFile`: the opts-gated scan + throw on the no-expansion path; a comment
  at the gate stating that opts-presence stands in for "this verb owns a prose body and has no
  unknown-flag branch", so a later reader does not read it as coincidence.
- `src/core/dispatch.ts` — `dispatch`: add `|| e instanceof ArgsFileError` to the clean-rc-2 branch.
- `tests/args.test.ts` — the new cases below.
- `dist/ap.cjs` — rebuilt and committed.

## Testing

- `tests/args.test.ts` — `applyArgsFile(["--provider","codex","--args-file",f],{valueFlags:new Set(["--provider"])})`
  throws `ArgsFileError`, and `existsSync(f)` is still true afterwards (the file is not consumed).
- `tests/args.test.ts` — `applyArgsFile(["job","start","--args-file",f])` (no opts) returns argv
  unchanged and does not throw: the `job start` passthrough, pinned.
- `tests/args.test.ts` — `applyArgsFile(["--args-file",f],{...})` still expands normally (the
  argv[0] path is untouched), and a body containing the literal text `--args-file` inside the
  loaded prose does not throw (no re-scan after expansion).
- `tests/args.test.ts` — an `ArgsFileError` raised inside a handler passed to `dispatch` returns
  rc 2 and writes the message to stderr, not a stack.
- **Mutations that must turn these red:** delete the scan so the function returns `[...argv]`;
  drop the `opts` gate so the no-opts `job start` case also throws; remove `ArgsFileError` from the
  `dispatch` clause.

## Success Criteria

- `node dist/ap.cjs quick init --target /tmp/x --args-file /tmp/p` exits 2 with a message naming
  the first-argument requirement, creates no state dir, and leaves `/tmp/p` on disk.
- `ap job start --command quick --args-file <p>` is byte-identical in behavior (existing detached
  tests stay green).
- `npm run typecheck && npm test && npm run lint && npm run build` green; `dist/ap.cjs` committed.
