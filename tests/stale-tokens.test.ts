import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

// Fails if Star-Wars / clone-wars residue appears in shipped source, config, or commands.
// Excludes node_modules, dist, docs (the design doc legitimately discusses the rename),
// and this test file itself.
describe("stale-token gate", () => {
  const banned = ["clone-wars", "cw_", "master-yoda", "MISSION ACCOMPLISHED", "@cw_", "@cs_"];
  // Rebrand worker-noun residue: "trooper" -> "part", "commander" -> "instrument".
  // Checked case-insensitively so prose ("Troopers") and identifiers alike are caught.
  // The shipped tree must use part/instrument, never these.
  //
  // consort -> agglomeration-platform rebrand (2026-06-15): brand bans added per-PR.
  // PR1 brand adds "@cs_" (tmux opts -> @ap_) above and "consort" below (-> ap /
  // agglomeration-platform; case-insensitive so it also catches CONSORT_HOME/.consort/Consort).
  // Bare "cs_" is intentionally NOT banned: it is a substring of docs_/specs_ (false positives),
  // and consort never had a bare cs_ fn prefix.
  const bannedCaseInsensitive = ["trooper", "commander", "consort"];
  const scan = (token: string, ci: boolean): string => {
    let out = "";
    try {
      out = execSync(
        `grep -rIn${ci ? "i" : ""} --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=docs ` +
        `--exclude-dir=.git --exclude=stale-tokens.test.ts -- ${JSON.stringify(token)} ` +
        `src config commands hooks .claude-plugin || true`,
        { cwd: process.cwd(), encoding: "utf8" },
      );
    } catch { /* grep exit 1 = no match */ }
    return out.trim();
  };
  for (const token of banned) {
    it(`no shipped file contains '${token}'`, () => { expect(scan(token, false)).toBe(""); });
  }
  for (const token of bannedCaseInsensitive) {
    it(`no shipped file contains '${token}' (case-insensitive; rebrand)`, () => { expect(scan(token, true)).toBe(""); });
  }
});
