# user-prompt-submit hook (intentional no-op)

The plugin's UserPromptSubmit hook dispatches to `dist/ap.cjs hook user-prompt-submit`
(`src/commands/hook.ts`), which is a **permanent no-op** returning 0. It exists so the
plugin can register the hook wiring without side effects.

There is deliberately no active-session resume logic here: `autoresearch` shipped
running its loop **inline** (see `commands/autoresearch.md`, "runs this loop inline"),
not via a UserPromptSubmit re-entry, so the hook has no work to do.
