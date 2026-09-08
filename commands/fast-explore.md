---
description: Fast landscape for a small idea — two pinned workers research and cross-verify, the hub writes one landscape doc and a handoff for /ap:design; no gate, no adversary, no interviews
argument-hint: <topic — a small idea>
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, TodoWrite
---
The arguments for this invocation, verbatim: $ARGUMENTS
Wherever the text below says `\$ARGUMENTS`, it means exactly the text on the line above.
The lines below expand to this command's directive, ending with 1 end marker of the form
`<!-- ap:fast-explore n/1 end -->`. If what follows is not that directive (a placeholder, or nothing),
inline shell execution is disabled on this machine (`disableSkillShellExecution`): stop, take no
other action, and say so. If the end marker is missing, the directive was truncated in
transit: stop and tell the operator instead of acting.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive fast-explore 1 --of 1`
