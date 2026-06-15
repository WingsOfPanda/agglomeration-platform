---
description: Show active workers (panes + state); optionally scoped to a topic
argument-hint: [<topic>]
allowed-tools: Bash, Write
---

# /ap:list

Show every active worker across topics, or scope to a single topic.

## Steps

1. Run this Bash block to mint an args path and capture it:
   `node ${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs list --mint-args-file`
   (prints an absolute path under `.ap/_args/`).
2. **Write** `$ARGUMENTS` into that exact path using the Write tool (never echo it into a shell).
3. Run: `node ${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs list --args-file <path-from-step-1>`
