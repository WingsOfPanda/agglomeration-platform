---
description: Deep multi-aspect exploration — SOTA surveys, multi-angle thinking, adversary-tested landscape doc that feeds /ap:design
argument-hint: <topic>
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, WebFetch, Skill, TaskCreate, TaskUpdate
---
The arguments for this invocation, verbatim: $ARGUMENTS
Wherever the text below says `\$ARGUMENTS`, it means exactly the text on the line above.
The lines below expand to this command's directive, ending with 3 end markers of the form
`<!-- ap:explore n/3 end -->`. If what follows is not that directive (a placeholder, or nothing),
inline shell execution is disabled on this machine (`disableSkillShellExecution`): stop, take no
other action, and say so. If any of the 3 end markers is missing, the directive was truncated in
transit: stop and tell the operator instead of acting.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive explore 1 --of 3`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive explore 2 --of 3`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive explore 3 --of 3`
