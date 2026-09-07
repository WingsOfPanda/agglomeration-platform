---
description: Advisor-driven autoresearch — lock a measurable metric, sweep SOTA, spawn 2-3 persistent codex workers, and adaptively dispatch experiments until a target/plateau/budget stop. Explore-only; promotion to real code is /ap:implement.
argument-hint: <objective-text> [--metric k=v,...] [--time-budget none|<N>h|<N>s] [--slug s] [--seed-from path]
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion, WebSearch, Skill, TaskCreate, TaskUpdate, TaskStop, Monitor
---
The arguments for this invocation, verbatim: $ARGUMENTS
Wherever the text below says `\$ARGUMENTS`, it means exactly the text on the line above.
The lines below expand to this command's directive, ending with 3 end markers of the form
`<!-- ap:autoresearch n/3 end -->`. If what follows is not that directive (a placeholder, or nothing),
inline shell execution is disabled on this machine (`disableSkillShellExecution`): stop, take no
other action, and say so. If any of the 3 end markers is missing, the directive was truncated in
transit: stop and tell the operator instead of acting.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive autoresearch 1 --of 3`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive autoresearch 2 --of 3`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive autoresearch 3 --of 3`
