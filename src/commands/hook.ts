// UserPromptSubmit hook. No-op: hub re-entry for interrupted campaigns is served by
// `autoresearch resume <topic>` (campaign spine); this hook stays reserved.
export async function run(_args: string[]): Promise<number> { return 0; }
