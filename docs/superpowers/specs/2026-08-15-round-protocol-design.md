# The single-worker round protocol: one skeleton, two descriptors — design

**Date:** 2026-08-15 · **Origin:** the four-walk architecture review (walk 3 candidate 3 / walk 4
candidate 2 — two explorers converged on it independently), Wave B PR-2. · **Scope:** one PR
(0.5.24), byte-identical throughout. Zero behavior changes.

> **Scope guard (adjudicated 2026-07-06, re-affirmed in grilling Q8).** This is NOT the spec-gated
> `quick`↔`bridge` command merge. Both commands keep their own verbs, args, artifacts, directives
> and state filenames; only the send/wait SKELETON is shared — exactly as `explore` and `design`
> already share `phaseWait`. And `implement` stays a plain caller, NOT a third descriptor: its
> extras (provider timeout multiplier, question payload + OBJECTIONS counter, `.done` marker, a
> different log format) would each be a hook used by one row, which is relocation, not
> concentration.

## Problem

`quick.turnSendWith`/`turnWaitWith` and `bridge.roundSendWith`/`roundWaitWith` are the same twelve
statements in the same order. The send bodies differ in exactly ten tokens (verified by reading
both at 0.5.23):

| slot | quick | bridge |
|---|---|---|
| art/exec dirs | `quickArtDir`/`quickExecDir` | `bridgeArtDir`/`bridgeExecDir` |
| label | `quick turn-send` | `bridge round-send` |
| init hint | `run quick init` | `run bridge init` |
| gate noun | `turn` | `round` |
| state file | `turn-<n>.txt` | `round-<n>.txt` |
| prompt file | `turn-prompt-<n>.md` | `round-prompt-<n>.md` |
| bundle file | `fix-prompt-<n>.md` | `followup-<n>.md` |
| bundle-missing wording | `fix bundle missing` | `follow-up bundle missing` |
| round-1 composer | `composeRound1Prompt(brief, branch)` reading `task-brief.md` + `branch.txt` (fallback `feat/quick-<topic>`) | `composeBridgeBrief(task, repo, branch)` reading `topic-text.txt` + `target_cwd.txt` + `branch.txt` (fallback `the current branch`) |
| follow-up composer | `composeFixPrompt` | `composeBridgeFollowup` |

Everything else is identical — including the ORDER-SENSITIVE part where the bugs live: gate →
state-file idempotency refusal → compose → prompt write → **offset captured BEFORE the send** →
`OFFSET=` written → send → keep-state-on-failure. The wait bodies differ only in dirs, label,
timeout constant, state filename and the `recordHubFlag` command tag.

Two corrections from the implementation's own enumeration (2026-08-15):

- The wait's missing-state error names the **send** verb (`... missing (run quick turn-send first)`),
  so both verbs come out of the one `label(verb)` slot — the wait body is not label-uniform.
- The question filename is **identical** in both commands (`question-<round>.txt`); it stays a
  descriptor slot so every frozen state filename lives in one place, but it is a degenerate slot and
  the swapped-slot mutation pin cannot reach it.

The cost is not hypothetical: 0.5.15 had to wire the identical `onVeto` lambda and the same
`sleep?` field into three files — the exact per-copy edit the PHASES table was built to end — and
0.5.23 (B1) had to convert three call sites again.

## Goal

One `sendRound`/`waitRound` skeleton parameterized by a per-command descriptor; quick and bridge
become ~10-line descriptors; every frozen filename lives in the descriptor, so the on-disk bytes
and every log line are unchanged.

## Architecture

`src/core/roundProtocol.ts`:

```ts
export interface RoundDescriptor {
  command: "quick" | "bridge";
  label(verb: "send" | "wait"): string;      // "quick turn-send" | "bridge round-wait"
  initHint: string;                          // "run quick init"
  gateNoun: string;                          // "turn" | "round"
  artDir(topic: string): string;
  execDir(topic: string): string;
  stateFile(exec: string, round: number): string;
  promptFile(exec: string, round: number): string;
  bundle(exec: string, round: number): { path: string; missingWording: string };
  composeFirst(ctx: { art: string; exec: string; topic: string }): string;
  composeFollowup(bundleText: string, round: number): string;
  timeoutS(): number;                        // QUICK_TURN_TIMEOUT | DUET_TURN_TIMEOUT
  questionFile(exec: string, round: number): string;
}
export async function sendRound(desc, topic, round, d): Promise<number>
export async function waitRound(desc, topic, round, d): Promise<number>
```

`sendRound` owns the twelve statements verbatim; `waitRound` owns the wait body, calling B1's
`awaitTurn` with `{confirm: true}` and binding `onFlag` to
`recordHubFlag({command: desc.command, ...})`, then `classifyTurn` + `recordWaitOutcome` +
the question capture exactly as today. The four existing exports (`turnSendWith`, `turnWaitWith`,
`roundSendWith`, `roundWaitWith`) remain as thin bindings so no test import breaks — as do each
command's `TurnSendDeps`/`TurnWaitDeps` TYPE exports, now aliases of `RoundSendDeps`/`RoundWaitDeps`
(`tests/bridge-cmd.test.ts` imports both by name; the spec's export inventory had missed them).

IMPLEMENTER: derive every slot value from the SHIPPED source, not from this table — it is the
review's map, the code is the truth. Any site that does not fit the descriptor exactly is a
STOP-and-report, never a silently widened slot. (An A5 blocker came from a spec asserting a
uniform shape where two sites differed.)

## Components

- `src/core/roundProtocol.ts` (new) · `src/commands/quick.ts` + `src/commands/bridge.ts` (descriptors
  + thin bindings). `implement.ts` untouched.
- `tests/` — see Testing. Version 0.5.23 → 0.5.24 (three manifests) + rebuilt committed dist.

## Testing

- ALL existing quick/bridge suites pass with ZERO assertion edits (they pin the frozen filenames and
  log lines); permitted: import/wiring only.
- New skeleton suite over both descriptors: gate refusal, state-file idempotency refusal, missing
  bundle (each command's exact wording), offset-captured-before-send (pinned by capturing state at
  send time), send-failure keeps the state file, question re-arm's OFFSET bump.
- Mutation: swapping two descriptor slot values must fail a test; moving the offset capture after
  the send must fail; dropping the gate must fail.
- Full gate green; dist rebuilt+committed.

## Success Criteria

- quick's and bridge's send/wait bodies are descriptors, not twelve-statement copies; a future
  wait-protocol change touches ONE skeleton (the 0.5.15/0.5.23 three-file edit becomes one).
- Every state filename, prompt filename, log line and rc byte-identical, proven by a dist-level
  differential over both commands.
- Gate green; 0.5.24.
