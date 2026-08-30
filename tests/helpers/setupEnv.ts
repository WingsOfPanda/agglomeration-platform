// tests/helpers/setupEnv.ts — vitest `setupFiles`, so it runs BEFORE any test file's imports.
//
// FAIL-CLOSED: forensics files run diagnostics as GitHub issues on a PUBLIC tracker. The env guard
// wins over consent at forensics' single choke point, so neither a test nor a `dist/ap.cjs` child
// process that inherits this env can ever shell out to `gh` — every record lands in the queue dir
// under the test's own AP_HOME.
process.env.AP_FORENSICS_BACKEND = "queue";
//
// The two turn-budget knobs are read by `envNum` at MODULE LOAD (quick.ts's QUICK_TURN_TIMEOUT,
// bridge.ts's DUET_TURN_TIMEOUT), so a developer or CI runner that exports either one — both are
// documented, operator-facing knobs — would change what the suite sees before a single test runs.
// Any test that wants a non-default budget sets it and re-imports the module itself.
delete process.env.AP_QUICK_TURN_TIMEOUT;
delete process.env.AP_DUET_TURN_TIMEOUT;
