# agglomeration-platform

A Claude Code plugin that orchestrates other model CLIs — `codex`, `claude`, `agy`, `opencode` — as
tmux panes you can attach to. You type `/ap:quick`, `/ap:implement`, `/ap:design`, `/ap:explore`,
`/ap:autoresearch` and the rest in a Claude Code session; that session briefs the workers, verifies
what they produce, and finishes the run.

## Install

```text
/plugin marketplace add WingsOfPanda/agglomeration-platform
/plugin install ap@agglomeration-platform
```

## Update

`/plugin` → update `ap` → `/reload-plugins`.

If your Claude Code sets `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1`, an update can leave you
on a stale clone that `/plugin marketplace update` cannot recover. Re-add the marketplace once:

```text
/plugin marketplace remove agglomeration-platform
/plugin marketplace add WingsOfPanda/agglomeration-platform
```

## Requirements

- Claude Code, with plugins enabled.
- tmux 3.0 or newer — every worker is a real pane, and an attached run splits the hub's own pane, so
  the hub session must itself run inside tmux; a `--detached` launch only needs the binary on `PATH`.
- At least one model CLI on `PATH`, installed and logged in — `codex`, `claude`, `agy` or
  `opencode`. Workers inherit your existing CLI auth; an unauthenticated CLI shows up as a worker
  that never reports ready (a bootstrap timeout), not a clear error. Run `/ap:check` to see what is
  available.
- node 18.17 or newer — the plugin is one bundle run by `node`.
- Inline shell execution enabled. Each `/ap:*` command expands its directive through `!` lines in
  the command file. With `disableSkillShellExecution` set, those lines are replaced by a placeholder
  and the command has nothing to act on; it will tell you so and stop.
- No Bash `ask` or `deny` permission rule matching `node …/dist/ap.cjs directive …`. Rules are
  evaluated deny, then ask, then allow, so an `allow` rule does not override a matching one, and any
  `/ap:*` invocation then aborts with `Shell command permission check failed`. Remove or narrow the
  rule.

Workers act on your repository unattended and reach the network. Point them only at repositories and
tasks you would trust an unattended agent with.

## Diagnostics

When ap itself fails — a worker pane that dies at spawn or mid-turn, a worktree, verb or directive
that misbehaves — it files one GitHub issue per run on this repository, with the run's metadata (the
topic's slug, hostname, username, paths, providers, repository origin) and, for a spawn failure, the
pane's last screen lines. The task text you typed, your repository's code and the worker's output
are not sent. It asks once per machine before the first filing; answer "Never on this machine" or
run `ap review consent no` to keep records in a local queue instead, and `ap review consent yes` to
change your mind (also the fix for a machine that answered on 0.6.0 or 0.6.1 while it could not
reach the tracker). Report anything else here by hand: Issues are open.

## License

Proprietary — see `LICENSE`. You may download, cache and run this artifact unmodified;
redistribution, modification, derivative works and extraction of the text embedded in the bundle are
not permitted. Copyright (c) 2026 WOP.
