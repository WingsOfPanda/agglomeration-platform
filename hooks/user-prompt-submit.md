# user-prompt-submit hook (stub)

The plugin's UserPromptSubmit hook dispatches to `dist/ap.cjs hook user-prompt-submit`.
In the foundation it is a no-op (no active-session resume logic yet — that lands with
the `rehearsal` command). Implemented as `src/commands/hook.ts` in Plan 02.
