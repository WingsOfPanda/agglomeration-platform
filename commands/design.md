---
description: Cross-verified multi-model research synthesized into a deploy-audit-passing design doc — Hub fast-path or escalate to a 2-3 worker ensemble
argument-hint: [--ensemble] <topic — what to research / design>
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, Skill, TodoWrite
---
The arguments for this invocation, verbatim: $ARGUMENTS
Wherever the text below says `\$ARGUMENTS`, it means exactly the text on the line above.
The lines below expand to this command's directive, ending with 2 end markers of the form
`<!-- ap:design n/2 end -->`. If what follows is not that directive (a placeholder, or nothing),
inline shell execution is disabled on this machine (`disableSkillShellExecution`): stop, take no
other action, and say so. If any of the 2 end markers is missing, the directive was truncated in
transit: stop and tell the operator instead of acting.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive design 1 --of 2`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive design 2 --of 2`
