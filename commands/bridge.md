---
description: Use when a task requires changes in a DIFFERENT git repository than the one you're working in — rather than cd-ing away, open one persistent claude/codex worker inside that other repo (repo B) and co-develop with it over open-ended rounds, relaying questions both ways with the user, finishing as a PR there.
argument-hint: --repo <abs-repo-path> <opening task> [--provider codex|claude|agy|opencode] [--in-place]
allowed-tools: Bash, Write, Read, Edit, AskUserQuestion
---
The arguments for this invocation, verbatim: $ARGUMENTS
Wherever the text below says `\$ARGUMENTS`, it means exactly the text on the line above.
The lines below expand to this command's directive, ending with 1 end marker of the form
`<!-- ap:bridge n/1 end -->`. If what follows is not that directive (a placeholder, or nothing),
inline shell execution is disabled on this machine (`disableSkillShellExecution`): stop, take no
other action, and say so. If the end marker is missing, the directive was truncated in
transit: stop and tell the operator instead of acting.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/ap.cjs" directive bridge 1 --of 1`
