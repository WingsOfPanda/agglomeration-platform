---
description: Gracefully end parts (FINE banner) and archive their state
argument-hint: <topic> | <instrument> <topic> | --all --yes
allowed-tools: Bash, Write
---

# /ap:coda

Gracefully end parts (FINE banner) and archive their state.

## Steps

1. Run this Bash block to mint an args path and capture it:
   `node ${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs coda --mint-args-file`
   (prints an absolute path under `.ap/_args/`).
2. **Write** `$ARGUMENTS` into that exact path using the Write tool (never echo it into a shell).
3. Run: `node ${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs coda --args-file <path-from-step-1>`
