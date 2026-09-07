---
description: Light pipeline — one worker implements a clear single-repo change unattended on its own branch; the conductor briefs, verifies, and finishes by default. No research, no design doc, no gates.
argument-hint: <topic-text> [--detached] [--provider codex|claude|agy|opencode] [--no-finish] [--stash-wip]
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion
---
The arguments for this invocation, verbatim: $ARGUMENTS
Wherever the text below says `\$ARGUMENTS`, it means exactly the text on the line above.
The lines below expand to this command's directive, ending with 2 end markers of the form
`<!-- ap:quick n/2 end -->`. If what follows is not that directive (a placeholder, or nothing),
inline shell execution is disabled on this machine (`disableSkillShellExecution`): stop, take no
other action, and say so. If any of the 2 end markers is missing, the directive was truncated in
transit: stop and tell the operator instead of acting.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive quick 1 --of 2`
!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive quick 2 --of 2`
