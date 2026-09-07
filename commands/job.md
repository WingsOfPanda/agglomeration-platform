---
description: Observe and control a DETACHED /ap:implement or /ap:quick run — status, parked questions, re-attach after a restart, teardown
argument-hint: status|attach|relay|list|stop <topic> [message]
allowed-tools: Bash, Read, AskUserQuestion
---
The arguments for this invocation, verbatim: $ARGUMENTS
Wherever the text below says `\$ARGUMENTS`, it means exactly the text on the line above.
The lines below expand to this command's directive, ending with 1 end marker of the form
`<!-- ap:job n/1 end -->`. If what follows is not that directive (a placeholder, or nothing),
inline shell execution is disabled on this machine (`disableSkillShellExecution`): stop, take no
other action, and say so. If the end marker is missing, the directive was truncated in
transit: stop and tell the operator instead of acting.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive job 1 --of 1`
