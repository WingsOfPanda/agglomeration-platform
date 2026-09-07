---
description: Triage the ap forensics issues that quick/design/implement/explore/autoresearch file on the tracker — surface what is still untriaged, cluster recurring patterns with their lifetime trend, hand each fix off, then mark them triaged
allowed-tools: Bash, Read, AskUserQuestion
---
The arguments for this invocation, verbatim: $ARGUMENTS
Wherever the text below says `\$ARGUMENTS`, it means exactly the text on the line above.
The lines below expand to this command's directive, ending with 1 end marker of the form
`<!-- ap:review n/1 end -->`. If what follows is not that directive (a placeholder, or nothing),
inline shell execution is disabled on this machine (`disableSkillShellExecution`): stop, take no
other action, and say so. If the end marker is missing, the directive was truncated in
transit: stop and tell the operator instead of acting.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive review 1 --of 1`
