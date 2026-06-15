#!/usr/bin/env bash
# Port-parity dogfood — exercises the new CLI verbs added in the port-parity workstream
# end-to-end against the REAL built bundle (`node dist/ap.cjs`) and a throwaway
# AP_HOME. Covers the surface that the per-command dogfoods (rehearsal/prelude) miss:
#
#   score   offset-reset  — clean-retry cascade wipes findings/diff/state for one worker/phase
#   perform drop-worker     — rewrites workers.txt, removing one row + reports new N
#   perform find-latest-doc — newest */_score/design-doc/*-design.md by mtime
#   rehearsal init        — seeds <art>/lib/ from config/rehearsal-lib-seed/ (arena.py present)
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
# Scenario A — score offset-reset (research clean-retry cascade)
############################################################################
echo "===================================================================="
echo "Scenario A — score offset-reset wipes one worker's research artifacts"
echo "===================================================================="

TOPIC_S=svc
INST_S=violin
ART_S="$STATE/$TOPIC_S/_score"
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
printf 'keep me\n'         > "$ART_S/scoreboard.md"
mkdir -p "$STATE/$TOPIC_S/viola-codex"
printf 'viola findings\n' > "$STATE/$TOPIC_S/viola-codex/findings.md"

or_rc="$(wd_rc $CS score offset-reset "$TOPIC_S" "$INST_S" research)"
assert "A1 score offset-reset research rc 0" "$or_rc"
assert "A2 worker findings.md removed" \
  "$([ ! -f "$PART_S/findings.md" ] && echo 0 || echo 1)"
assert "A3 art diff.md + adjudicated-draft.md removed" \
  "$([ ! -f "$ART_S/diff.md" ] && [ ! -f "$ART_S/adjudicated-draft.md" ] && echo 0 || echo 1)"
assert "A4 glob targets (consensus.txt + *_only_items.txt) removed" \
  "$([ ! -f "$ART_S/consensus.txt" ] && [ ! -f "$ART_S/codex_only_items.txt" ] && echo 0 || echo 1)"
assert "A5 state research-$INST_S.txt removed" \
  "$([ ! -f "$ART_S/research-$INST_S.txt" ] && echo 0 || echo 1)"
assert "A6 unrelated scoreboard.md + sibling worker findings survive" \
  "$([ -f "$ART_S/scoreboard.md" ] && [ -f "$STATE/$TOPIC_S/viola-codex/findings.md" ] && echo 0 || echo 1)"

# --keep-findings leaves the worker deliverable intact (seed a fresh one first).
printf 'fresh findings\n' > "$PART_S/findings.md"
kf_rc="$(wd_rc $CS score offset-reset "$TOPIC_S" "$INST_S" research --keep-findings)"
assert "A7 score offset-reset --keep-findings rc 0 + findings.md preserved" \
  "$([ "$kf_rc" -eq 0 ] && [ -f "$PART_S/findings.md" ] && echo 0 || echo 1)"

############################################################################
# Scenario B — perform drop-worker (rewrite workers.txt, drop one row)
############################################################################
echo "===================================================================="
echo "Scenario B — perform drop-worker removes a row + reports new N"
echo "===================================================================="

TOPIC_P=mr
ART_P="$STATE/$TOPIC_P/_perform"
mkdir -p "$ART_P"
# workers.txt = 3-col TSV (slug \t cwd \t provider) per the multiInit format. drop-worker
# matches on col 0 (the agent slug) and must keep the other rows byte-faithfully.
printf 'violin\t/repo/a\tcodex\nviola\t/repo/b\tcodex\ncello\t/repo/c\tclaude\n' > "$ART_P/workers.txt"

DP_OUT="$(wd_out $CS perform drop-worker "$TOPIC_P" viola)"; dp_rc=$?
assert "B1 perform drop-worker rc 0" "$dp_rc"
assert "B2 drop-worker prints N=2" \
  "$(printf '%s' "$DP_OUT" | grep -q '^N=2$' && echo 0 || echo 1)"
assert "B3 viola row gone; violin + cello remain" \
  "$(! grep -q '^viola' "$ART_P/workers.txt" && grep -q '^violin' "$ART_P/workers.txt" && grep -q '^cello' "$ART_P/workers.txt" && echo 0 || echo 1)"
assert "B4 workers.txt now has exactly 2 rows" \
  "$([ "$(wc -l < "$ART_P/workers.txt")" -eq 2 ] && echo 0 || echo 1)"
# dropping a non-existent agent -> rc 1 (not 2; usage is well-formed).
no_rc="$(wd_rc $CS perform drop-worker "$TOPIC_P" ghost)"
assert "B5 drop-worker unknown agent rc 1" "$([ "$no_rc" -eq 1 ] && echo 0 || echo 1)"

############################################################################
# Scenario C — perform find-latest-doc (newest *-design.md by mtime)
############################################################################
echo "===================================================================="
echo "Scenario C — perform find-latest-doc resolves the newest design doc"
echo "===================================================================="

# Empty home (different cwd => no state) -> rc 1 already covered by the unit tests; here we
# seed two */_score/design-doc/*-design.md under our state and assert the newer wins.
DD1="$STATE/topic-old/_score/design-doc"
DD2="$STATE/topic-new/_score/design-doc"
mkdir -p "$DD1" "$DD2"
printf '# old\n' > "$DD1/alpha-design.md"
printf '# new\n' > "$DD2/beta-design.md"
# Make beta strictly newer than alpha.
touch -d '2026-05-01T00:00:00' "$DD1/alpha-design.md"
touch -d '2026-05-30T00:00:00' "$DD2/beta-design.md"

FL_OUT="$(wd_out $CS perform find-latest-doc)"; fl_rc=$?
assert "C1 find-latest-doc rc 0" "$fl_rc"
assert "C2 find-latest-doc prints DOC=<newest> (beta-design.md)" \
  "$(printf '%s' "$FL_OUT" | grep -q '^DOC=.*topic-new/_score/design-doc/beta-design.md$' && echo 0 || echo 1)"

############################################################################
# Scenario D — rehearsal init seeds <art>/lib/ (arena.py present)
############################################################################
echo "===================================================================="
echo "Scenario D — rehearsal init seeds <art>/lib/ from rehearsal-lib-seed"
echo "===================================================================="

# rehearsal init resolves contracts.yaml + rehearsal-lib-seed/ relative to CLAUDE_PLUGIN_ROOT
# (defaulting to cwd); pin it to the repo so config resolves from our throwaway cwd.
RH_OUT="$( cd "$WD" && CLAUDE_PLUGIN_ROOT="$REPO" $CS rehearsal init --slug df-lib-seed 'maximize accuracy for the lib-seed dogfood' 2>/dev/null )"; rh_rc=$?
ART_R="$(printf '%s\n' "$RH_OUT" | sed -n 's/^ART=//p')"
assert "D1 rehearsal init rc 0 + prints ART=" \
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
