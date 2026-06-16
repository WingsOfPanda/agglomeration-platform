#!/usr/bin/env bash
# Port-parity dogfood — exercises the new CLI verbs added in the port-parity workstream
# end-to-end against the REAL built bundle (`node dist/ap.cjs`) and a throwaway
# AP_HOME. Covers the surface that the per-command dogfoods (autoresearch/explore) miss:
#
#   design   offset-reset  — clean-retry cascade wipes findings/diff/state for one worker/phase
#   implement find-latest-doc — newest */_design/design-doc/*-design.md by mtime
#   autoresearch init        — seeds <art>/lib/ from config/autoresearch-lib-seed/ (arena.py present)
#
# State is seeded by hand at the exact filenames the verbs operate on (mirroring the unit
# tests) so the script is self-contained, git-less-cwd-safe, and needs no model panes/tmux.
#
# Self-contained + idempotent: own temp AP_HOME + temp cwd, PASS/FAIL per assertion,
# final tally. Exit 0 iff every assertion passed.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1
# Absolute bundle path: the verbs are run from a throwaway cwd (so repoHash(cwd) matches
# the seeded state dir), where a relative "dist/ap.cjs" would not resolve.
CS="node $REPO/dist/ap.cjs"

AP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/ap-portparity-home.XXXXXX")"
WD="$(mktemp -d "${TMPDIR:-/tmp}/ap-portparity-cwd.XXXXXX")"
export AP_HOME
trap 'rm -rf "$AP_HOME" "$WD"' EXIT

PASS=0
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
# assert <description> <0-if-ok>
assert() { if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1"; fi; }
# wd_out <cmd...> — run from the throwaway cwd $WD in a subshell, echo stdout (stderr dropped).
# The verbs key off repoHash(cwd), so they must run from $WD where the seeded state lives.
wd_out() { ( cd "$WD" || exit 99; "$@" 2>/dev/null ); }
# wd_rc <cmd...> — same, but echo the exit code (no set -e trip).
wd_rc()  { local rc=0; ( cd "$WD" || exit 99; "$@" >/dev/null 2>&1 ) || rc=$?; echo "$rc"; }

# state subdir for our temp cwd: <HOME>/state/<sha256(realpath(cwd))>
REPO_HASH="$(cd "$WD" && node -e 'const{createHash}=require("crypto");const{realpathSync}=require("fs");process.stdout.write(createHash("sha256").update(realpathSync(process.cwd()),"utf8").digest("hex"))')"
STATE="$AP_HOME/state/$REPO_HASH"

############################################################################
# Scenario A — design offset-reset (research clean-retry cascade)
############################################################################
echo "===================================================================="
echo "Scenario A — design offset-reset wipes one worker's research artifacts"
echo "===================================================================="

TOPIC_S=svc
INST_S=bravo
ART_S="$STATE/$TOPIC_S/_design"
PART_S="$STATE/$TOPIC_S/$INST_S-codex"   # <inst>-<model> worker dir
mkdir -p "$ART_S" "$PART_S"

# Seed the research-phase artifacts the cascade must invalidate:
#   worker-dir: findings.md         (the worker's research deliverable)
#   art-dir : diff.md, adjudicated-draft.md, consensus.txt, <x>_only_items.txt
#   state   : research-<inst>.txt (per-worker research state file)
printf 'sim findings for %s\n' "$INST_S" > "$PART_S/findings.md"
printf 'sim diff\n'        > "$ART_S/diff.md"
printf 'sim draft\n'       > "$ART_S/adjudicated-draft.md"
printf 'sim consensus\n'   > "$ART_S/consensus.txt"
printf 'sim only\n'        > "$ART_S/codex_only_items.txt"
printf 'done\n'            > "$ART_S/research-$INST_S.txt"
# An UNRELATED file that must survive (different worker's findings + the metric doc).
printf 'keep me\n'         > "$ART_S/designboard.md"
mkdir -p "$STATE/$TOPIC_S/alpha-codex"
printf 'alpha findings\n' > "$STATE/$TOPIC_S/alpha-codex/findings.md"

or_rc="$(wd_rc $CS design offset-reset "$TOPIC_S" "$INST_S" research)"
assert "A1 design offset-reset research rc 0" "$or_rc"
assert "A2 worker findings.md removed" \
  "$([ ! -f "$PART_S/findings.md" ] && echo 0 || echo 1)"
assert "A3 art diff.md + adjudicated-draft.md removed" \
  "$([ ! -f "$ART_S/diff.md" ] && [ ! -f "$ART_S/adjudicated-draft.md" ] && echo 0 || echo 1)"
assert "A4 glob targets (consensus.txt + *_only_items.txt) removed" \
  "$([ ! -f "$ART_S/consensus.txt" ] && [ ! -f "$ART_S/codex_only_items.txt" ] && echo 0 || echo 1)"
assert "A5 state research-$INST_S.txt removed" \
  "$([ ! -f "$ART_S/research-$INST_S.txt" ] && echo 0 || echo 1)"
assert "A6 unrelated designboard.md + sibling worker findings survive" \
  "$([ -f "$ART_S/designboard.md" ] && [ -f "$STATE/$TOPIC_S/alpha-codex/findings.md" ] && echo 0 || echo 1)"

# --keep-findings leaves the worker deliverable intact (seed a fresh one first).
printf 'fresh findings\n' > "$PART_S/findings.md"
kf_rc="$(wd_rc $CS design offset-reset "$TOPIC_S" "$INST_S" research --keep-findings)"
assert "A7 design offset-reset --keep-findings rc 0 + findings.md preserved" \
  "$([ "$kf_rc" -eq 0 ] && [ -f "$PART_S/findings.md" ] && echo 0 || echo 1)"

############################################################################
# Scenario C — implement find-latest-doc (newest *-design.md by mtime)
############################################################################
echo "===================================================================="
echo "Scenario C — implement find-latest-doc resolves the newest design doc"
echo "===================================================================="

# Empty home (different cwd => no state) -> rc 1 already covered by the unit tests; here we
# seed two */_design/design-doc/*-design.md under our state and assert the newer wins.
DD1="$STATE/topic-old/_design/design-doc"
DD2="$STATE/topic-new/_design/design-doc"
mkdir -p "$DD1" "$DD2"
printf '# old\n' > "$DD1/alpha-design.md"
printf '# new\n' > "$DD2/beta-design.md"
# Make beta strictly newer than alpha.
touch -d '2026-05-01T00:00:00' "$DD1/alpha-design.md"
touch -d '2026-05-30T00:00:00' "$DD2/beta-design.md"

FL_OUT="$(wd_out $CS implement find-latest-doc)"; fl_rc=$?
assert "C1 find-latest-doc rc 0" "$fl_rc"
assert "C2 find-latest-doc prints DOC=<newest> (beta-design.md)" \
  "$(printf '%s' "$FL_OUT" | grep -q '^DOC=.*topic-new/_design/design-doc/beta-design.md$' && echo 0 || echo 1)"

############################################################################
# Scenario D — autoresearch init seeds <art>/lib/ (arena.py present)
############################################################################
echo "===================================================================="
echo "Scenario D — autoresearch init seeds <art>/lib/ from autoresearch-lib-seed"
echo "===================================================================="

# autoresearch init resolves contracts.yaml + autoresearch-lib-seed/ relative to CLAUDE_PLUGIN_ROOT
# (defaulting to cwd); pin it to the repo so config resolves from our throwaway cwd.
RH_OUT="$( cd "$WD" && CLAUDE_PLUGIN_ROOT="$REPO" $CS autoresearch init --slug df-lib-seed 'maximize accuracy for the lib-seed dogfood' 2>/dev/null )"; rh_rc=$?
ART_R="$(printf '%s\n' "$RH_OUT" | sed -n 's/^ART=//p')"
assert "D1 autoresearch init rc 0 + prints ART=" \
  "$([ "$rh_rc" -eq 0 ] && [ -n "$ART_R" ] && echo 0 || echo 1)"
assert "D2 <art>/lib/arena.py seeded" \
  "$([ -n "$ART_R" ] && [ -f "$ART_R/lib/arena.py" ] && echo 0 || echo 1)"
assert "D3 <art>/lib/__init__.py seeded (package marker)" \
  "$([ -n "$ART_R" ] && [ -f "$ART_R/lib/__init__.py" ] && echo 0 || echo 1)"

############################################################################
# Tally
############################################################################
echo "===================================================================="
TOTAL=$((PASS + FAIL))
printf 'TALLY: %d/%d passed (%d failed)\n' "$PASS" "$TOTAL" "$FAIL"
if [ "$FAIL" -eq 0 ]; then echo "RESULT: ALL PASS"; exit 0; else echo "RESULT: FAILURES PRESENT"; exit 1; fi
