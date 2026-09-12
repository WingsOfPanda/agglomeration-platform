---
description: Implement a deploy-schema design doc — audit, spawn one worker to plan/implement/self-verify, Hub cross-verifies and runs a bounded fix-loop, then finish + teardown (single-repo)
argument-hint: [--detached] [--no-branch] [--branch <n>] [--topic <slug>] [--max-rounds N] [<design-doc-path>]
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, Skill, TodoWrite, mcp__codegraph
---
The arguments for this invocation, verbatim: $ARGUMENTS
Wherever the text below says `\$ARGUMENTS`, it means exactly the text on the line above.
The lines below expand to this command's directive, ending with 5 end markers of the form
`<!-- ap:implement n/5 end -->`. If what follows is not that directive (a placeholder, or nothing),
inline shell execution is disabled on this machine (`disableSkillShellExecution`): stop, take no
other action, and say so. If any of the 5 end markers is missing, the directive was truncated in
transit: stop and tell the operator instead of acting.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive implement 1 --of 5`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive implement 2 --of 5`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive implement 3 --of 5`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive implement 4 --of 5`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive implement 5 --of 5`
