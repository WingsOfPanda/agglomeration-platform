#!/usr/bin/env bash
# Phase C ACCEPTANCE GATE + Phase D wind-down — simulated-workers dogfood for /ap:autoresearch.
#
# Drives the REAL CLI verbs (init/metric/experiment-send/score/monitor/status-brief)
# across simulated experiment rounds, then exercises the Phase-D wind-down verbs
# (finalize/consensus/handoff-extract/forensics/teardown) on Scenario A's scored topic.
# codex IS on PATH (so init's codex gate passes),
# but live codex pane spawns are blocked by codex 0.135.0's directory-trust prompt +
# need tmux, so the PARTS are SIMULATED: we scaffold their state + outbox by hand
# instead of `spawn-all`, then dispatch/score/monitor against that state.
# AP_DRY_RUN=1 makes experiment-send skip the tmux pane nudge.
#
# Self-contained + idempotent: creates its own temp AP_HOME, runs, prints
# PASS/FAIL per assertion + a final tally. Exit 0 iff every assertion passed.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
CS="node dist/ap.cjs"

AP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/ap-autoresearch-dogfood.XXXXXX")"
export AP_HOME
trap 'rm -rf "$AP_HOME"' EXIT

PASS=0
FAIL=0
check() { # <description> <0-if-ok>
  if [ "$2" -eq 0 ]; then printf 'PASS  %s\n' "$1"; PASS=$((PASS + 1));
  else printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); fi
}
# Run a command, capture rc without tripping set -e.
rc_of() { local rc=0; "$@" >/dev/null 2>&1 || rc=$?; echo "$rc"; }

# --- helpers shared by every scenario --------------------------------------

# Scaffold one simulated worker: its _autoresearch state (state.txt + experiments dir)
# AND the standard worker dir (<topicDir>/<inst>-codex/{pane.json,outbox.jsonl}) that
# resolveModel + experiment-send + monitor read.
scaffold_part() { # <art> <topicDir> <inst>
  local art="$1" topicDir="$2" inst="$3"
  mkdir -p "$art/workers/$inst/experiments"
  printf 'exp_counter=0\nphase=idle\ncurrent_exp_id=\nlast_event=spawn\n' > "$art/workers/$inst/state.txt"
  mkdir -p "$topicDir/$inst-codex"
  printf '%s\n' "{\"agent\":\"$inst\",\"model\":\"codex\",\"pane_id\":\"%${RANDOM}\"}" > "$topicDir/$inst-codex/pane.json"
  : > "$topicDir/$inst-codex/outbox.jsonl"
}

# Write a frozen-schema result.json for one experiment.
write_result() { # <art> <inst> <expId> <metricValue>
  local art="$1" inst="$2" eid="$3" mv="$4"
  cat > "$art/workers/$inst/experiments/$eid/result.json" <<EOF
{"branch_id":"$eid","approach_label":"approach-$eid","metric_name":"accuracy","metric_value":$mv,"status":"ok","runtime_s":40.0,"log_paths":[],"checkpoint_path":null,"notes":"simulated $eid acc=$mv"}
EOF
  printf '%s\n' "{\"event\":\"done\",\"summary\":\"$eid acc=$mv\",\"ts\":\"2026-05-30T10:00:00Z\"}" \
    >> "$topicDir/$inst-codex/outbox.jsonl"
}

# Dispatch one experiment (dry-run, no pane nudge); worker must be phase=idle.
dispatch() { # <topic> <inst> <expId> <label> <brief>
  AP_DRY_RUN=1 $CS autoresearch experiment-send "$1" "$2" "$3" "$4" "$5"
}

completion_line() { $CS autoresearch status-brief "$1" 2>/dev/null | grep 'Completion check' || true; }

############################################################################
# Scenario A — floor -> target+K stop
############################################################################
echo "===================================================================="
echo "Scenario A — floor -> target+K (default stop)"
echo "===================================================================="

OUT="$($CS autoresearch init --slug df-mnist "maximize mnist accuracy under 100k params" 2>/dev/null)"
TOPIC="$(printf '%s\n' "$OUT" | sed -n 's/^TOPIC=//p')"
ART="$(printf '%s\n' "$OUT" | sed -n 's/^ART=//p')"
topicDir="${ART%/_autoresearch}"
check "A1 init prints TOPIC + ART; art dir exists" \
  "$([ -n "$TOPIC" ] && [ -n "$ART" ] && [ -d "$ART" ] && echo 0 || echo 1)"
# init seeds <art>/lib/ from config/autoresearch-lib-seed/ (arena helper + package marker).
check "A1b init seeded <art>/lib/arena.py + __init__.py" \
  "$([ -f "$ART/lib/arena.py" ] && [ -f "$ART/lib/__init__.py" ] && echo 0 || echo 1)"

$CS autoresearch metric "$TOPIC" --kv "primary_metric=accuracy,direction=maximize,min_acceptable=>= 0.90,target=>= 0.99,K_corroboration=2,plateau_window=5,plateau_threshold=0.01" >/dev/null 2>&1
check "A2 metric.md written" "$([ -f "$ART/metric.md" ] && echo 0 || echo 1)"

# Simulate spawn of 2 agents (first two from agents.yaml = bravo, alpha).
INST_A=bravo
INST_B=alpha
printf '%s\n%s\n' "$INST_A" "$INST_B" > "$ART/workers.txt"
scaffold_part "$ART" "$topicDir" "$INST_A"
scaffold_part "$ART" "$topicDir" "$INST_B"
check "A3 simulated spawn: workers.txt + 2 worker dirs + 2 outboxes" \
  "$([ -f "$ART/workers.txt" ] && [ -f "$topicDir/$INST_A-codex/outbox.jsonl" ] && [ -f "$topicDir/$INST_B-codex/outbox.jsonl" ] && echo 0 || echo 1)"

# --- Round 1 dispatch (exp-001 to each worker) -------------------------------
r=0
dispatch "$TOPIC" "$INST_A" exp-001 "baseline-a" "a LeNet CNN baseline, no augmentation" >/dev/null 2>&1 || r=$?
dispatch "$TOPIC" "$INST_B" exp-001 "baseline-b" "a small MLP baseline, dropout only" >/dev/null 2>&1 || r=$?
check "A4 round-1 dispatch rc 0 (both workers)" "$r"

p_a="$ART/workers/$INST_A/experiments/exp-001/prompt.md"
check "A5 prompt.md exists, NO {{ leftover" \
  "$([ -f "$p_a" ] && ! grep -q '{{' "$p_a" && echo 0 || echo 1)"
check "A6 inbox.md has END_OF_INSTRUCTION" \
  "$(grep -q 'END_OF_INSTRUCTION' "$topicDir/$INST_A-codex/inbox.md" && echo 0 || echo 1)"
st="$(cat "$ART/workers/$INST_A/state.txt")"
check "A7 state: phase=working current_exp_id=exp-001 exp_counter=1" \
  "$(printf '%s' "$st" | grep -q 'phase=working' && printf '%s' "$st" | grep -q 'current_exp_id=exp-001' && printf '%s' "$st" | grep -q 'exp_counter=1' && echo 0 || echo 1)"

# --- Simulate the round-1 experiments (both BELOW floor) -------------------
write_result "$ART" "$INST_A" exp-001 0.85
write_result "$ART" "$INST_B" exp-001 0.88

sc_rc="$(rc_of $CS autoresearch score "$TOPIC")"
check "A8 score rc 0" "$sc_rc"
# scoreboard sorted higher-metric first: rank 1 must be alpha (0.88) over bravo (0.85).
rank1="$(grep -E '^\| 1 \|' "$ART/scoreboard.md" || true)"
check "A9 scoreboard sorted (rank 1 = alpha 0.8800)" \
  "$(printf '%s' "$rank1" | grep -q 'alpha' && printf '%s' "$rank1" | grep -q '0.8800' && echo 0 || echo 1)"
# results.tsv: header + 2 data rows.
nrows="$(wc -l < "$ART/results.tsv")"
check "A10 results.tsv header + 2 rows (3 lines)" "$([ "$nrows" -eq 3 ] && echo 0 || echo 1)"
# race-guard: both workers flipped to phase=idle (current_exp_id's result.json present).
check "A11 both workers flipped to phase=idle after score" \
  "$(grep -q 'phase=idle' "$ART/workers/$INST_A/state.txt" && grep -q 'phase=idle' "$ART/workers/$INST_B/state.txt" && echo 0 || echo 1)"

# --- status-brief shows the table + floor_met=no ---------------------------
sb="$($CS autoresearch status-brief "$TOPIC" 2>/dev/null)"
check "A12 status-brief prints | Worker | table" \
  "$(printf '%s' "$sb" | grep -q '| Worker |' && echo 0 || echo 1)"
check "A13 completion line floor_met=no (both below 0.90)" \
  "$(printf '%s' "$sb" | grep -q 'Completion check:.*floor_met=no' && echo 0 || echo 1)"

# --- Round 2 (cross floor + reach target x K=2 on bravo) ------------------
# bravo: exp-002=0.992, exp-003=0.995  (both >= target 0.99, strictly improving => K_so_far=2)
# alpha : exp-002=0.91 (crosses floor, not at target)
r=0
dispatch "$TOPIC" "$INST_A" exp-002 "augment-a" "add data augmentation + wider conv" >/dev/null 2>&1 || r=$?
dispatch "$TOPIC" "$INST_B" exp-002 "augment-b" "add batchnorm + label smoothing" >/dev/null 2>&1 || r=$?
check "A14 round-2 dispatch rc 0" "$r"
write_result "$ART" "$INST_A" exp-002 0.992
write_result "$ART" "$INST_B" exp-002 0.910
$CS autoresearch score "$TOPIC" >/dev/null 2>&1
cl="$(completion_line "$TOPIC")"
check "A15 after exp-002: floor_met=yes (floor crossed)" \
  "$(printf '%s' "$cl" | grep -q 'floor_met=yes' && echo 0 || echo 1)"

# bravo exp-003 = 0.995 — second strictly-improving at-target experiment => K=2.
r=0
dispatch "$TOPIC" "$INST_A" exp-003 "augment-a2" "tune LR schedule on the augmented pipeline" >/dev/null 2>&1 || r=$?
check "A16 round-3 dispatch rc 0 (bravo exp-003)" "$r"
write_result "$ART" "$INST_A" exp-003 0.995
$CS autoresearch score "$TOPIC" >/dev/null 2>&1
cl="$(completion_line "$TOPIC")"
check "A17 target_met=yes K_so_far=2 K_required=2 (floor->target+K stop)" \
  "$(printf '%s' "$cl" | grep -q 'floor_met=yes' && printf '%s' "$cl" | grep -q 'target_met=yes' && printf '%s' "$cl" | grep -q 'K_so_far=2 K_required=2' && echo 0 || echo 1)"

############################################################################
# Scenario B — plateau stop (fresh topic)
############################################################################
echo "===================================================================="
echo "Scenario B — floor + plateau + no-target (default stop)"
echo "===================================================================="

OUT="$($CS autoresearch init --slug df-plateau "maximize plateau accuracy" 2>/dev/null)"
TOPIC_B="$(printf '%s\n' "$OUT" | sed -n 's/^TOPIC=//p')"
ART_B="$(printf '%s\n' "$OUT" | sed -n 's/^ART=//p')"
topicDir_B="${ART_B%/_autoresearch}"
# floor 0.90, target 0.99 (never met), plateau defaults (window 5, threshold 0.01).
$CS autoresearch metric "$TOPIC_B" --kv "primary_metric=accuracy,direction=maximize,min_acceptable=>= 0.90,target=>= 0.99,K_corroboration=2,plateau_window=5,plateau_threshold=0.01" >/dev/null 2>&1

INST_P=charlie
printf '%s\n' "$INST_P" > "$ART_B/workers.txt"
# scaffold_part uses the global $topicDir; point it at B's worker dir explicitly.
mkdir -p "$ART_B/workers/$INST_P/experiments"
printf 'exp_counter=0\nphase=idle\ncurrent_exp_id=\nlast_event=spawn\n' > "$ART_B/workers/$INST_P/state.txt"
mkdir -p "$topicDir_B/$INST_P-codex"
printf '%s\n' "{\"agent\":\"$INST_P\",\"model\":\"codex\",\"pane_id\":\"%9\"}" > "$topicDir_B/$INST_P-codex/pane.json"
: > "$topicDir_B/$INST_P-codex/outbox.jsonl"

# ~5 experiments, all floor-met (>=0.90), none at target, tight spread (< 0.01).
i=1
for m in 0.905 0.906 0.904 0.905 0.906; do
  eid="$(printf 'exp-%03d' "$i")"
  AP_DRY_RUN=1 $CS autoresearch experiment-send "$TOPIC_B" "$INST_P" "$eid" "plateau" "incremental tweak $i" >/dev/null 2>&1
  cat > "$ART_B/workers/$INST_P/experiments/$eid/result.json" <<EOF
{"branch_id":"$eid","approach_label":"plateau","metric_name":"accuracy","metric_value":$m,"status":"ok","runtime_s":40.0,"log_paths":[],"checkpoint_path":null,"notes":"plateau $eid"}
EOF
  printf '%s\n' "{\"event\":\"done\",\"summary\":\"$eid acc=$m\",\"ts\":\"2026-05-30T10:00:00Z\"}" >> "$topicDir_B/$INST_P-codex/outbox.jsonl"
  $CS autoresearch score "$TOPIC_B" >/dev/null 2>&1
  i=$((i + 1))
done
cl="$($CS autoresearch status-brief "$TOPIC_B" 2>/dev/null | grep 'Completion check' || true)"
check "B1 completion line floor_met=yes target_met=no plateau=yes" \
  "$(printf '%s' "$cl" | grep -q 'floor_met=yes' && printf '%s' "$cl" | grep -q 'target_met=no' && printf '%s' "$cl" | grep -q 'plateau=yes' && echo 0 || echo 1)"

############################################################################
# Scenario C — monitor --once
############################################################################
echo "===================================================================="
echo "Scenario C — monitor --once (cursor advance + parseable done line)"
echo "===================================================================="

# Reuse Scenario B's worker (charlie) — its outbox already has done lines.
# Pre-write liveness-cursor.txt=0 under workerStateDir, then monitor --once.
printf '0' > "$ART_B/workers/$INST_P/liveness-cursor.txt"
OUTBOX_C="$topicDir_B/$INST_P-codex/outbox.jsonl"
SIZE_C="$(wc -c < "$OUTBOX_C")"
MON_OUT="$($CS autoresearch monitor "$TOPIC_B" "$INST_P" --once 2>/dev/null)"
# First emitted line must parse as {"worker":INST,"event":"done",...}.
FIRST_LINE="$(printf '%s\n' "$MON_OUT" | head -1)"
PARSE_OK="$(printf '%s' "$FIRST_LINE" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const o=JSON.parse(s.trim());process.exit(o.worker==="'"$INST_P"'"&&o.event==="done"?0:1);}catch{process.exit(1);}
});')" && PARSE_OK=0 || PARSE_OK=$?
check "C1 monitor --once prints a parseable {worker,event:done} line" "$PARSE_OK"
CUR_AFTER="$(cat "$ART_B/workers/$INST_P/liveness-cursor.txt")"
check "C2 liveness-cursor.txt advanced to outbox byte size ($SIZE_C)" \
  "$([ "$CUR_AFTER" = "$SIZE_C" ] && echo 0 || echo 1)"

############################################################################
# Scenario D — wind-down (finalize -> consensus -> handoff-extract -> teardown/forensics)
############################################################################
echo "===================================================================="
echo "Scenario D — wind-down on Scenario A's scored topic"
echo "===================================================================="

# D1 finalize: structured halt.flag, then finalize -> session-summary.md ## Halt.
printf 'halted_by=hub\nhalted_at=2026-05-30T12:00:00Z\nreason=converged target+K\n' > "$ART/halt.flag"
fin_rc="$(rc_of $CS autoresearch finalize "$TOPIC")"
check "D1 finalize rc 0" "$fin_rc"
check "D2 session-summary.md has ## Halt + reason" \
  "$([ -f "$ART/session-summary.md" ] && grep -q '## Halt' "$ART/session-summary.md" && grep -q 'reason=converged' "$ART/session-summary.md" && echo 0 || echo 1)"

# D3 consensus: latest-ok per worker -> consensus.md.
con_rc="$(rc_of $CS autoresearch consensus "$TOPIC")"
check "D3 consensus rc 0 + consensus.md ## Agreed/## Contested" \
  "$([ "$con_rc" -eq 0 ] && [ -f "$ART/consensus.md" ] && grep -q '## Agreed' "$ART/consensus.md" && grep -q '## Contested' "$ART/consensus.md" && echo 0 || echo 1)"

# D4 handoff-extract (takes the ART-DIR): winner = bravo/exp-003 @ 0.9950.
he_rc="$(rc_of $CS autoresearch handoff-extract "$ART")"
KV="$ART/handoff-data.kv"
check "D4 handoff-extract rc 0 + kv winner=bravo metric=0.9950 + code_dir + mode=autoresearch" \
  "$([ "$he_rc" -eq 0 ] && grep -q '^winner_agent=bravo$' "$KV" && grep -q '^winner_metric=0.9950$' "$KV" && grep -q '^winner_code_dir=workers/bravo/experiments/exp-003/code/$' "$KV" && grep -q '^mode=autoresearch$' "$KV" && echo 0 || echo 1)"

# D5 forensics: best-effort, rc 0.
fo_rc="$(rc_of $CS autoresearch forensics "$TOPIC")"
check "D5 forensics rc 0 (best-effort)" "$fo_rc"

# D6 teardown: winner symlink + archive. Make the winner code dir real first.
mkdir -p "$ART/workers/bravo/experiments/exp-003/code"
TD_OUT="$($CS autoresearch teardown "$TOPIC" 2>/dev/null)" && td_rc=0 || td_rc=$?
ARCHIVE_ROOT="$AP_HOME/archive"
check "D6 teardown rc 0 + printed archive dest under archive/" \
  "$([ "$td_rc" -eq 0 ] && printf '%s' "$TD_OUT" | grep -q '/archive/.*/_autoresearch-' && echo 0 || echo 1)"
check "D7 topic _autoresearch archived (live art dir gone; archive present)" \
  "$([ ! -d "$ART" ] && [ -d "$ARCHIVE_ROOT" ] && find "$ARCHIVE_ROOT" -name '_autoresearch-*' -type d | grep -q . && echo 0 || echo 1)"

# D8 no stale tokens in any archived wind-down artifact.
check "D8 no master-yoda / MISSION ACCOMPLISHED / consult-handoff in archive" \
  "$(! grep -rIl -e 'master-yoda' -e 'MISSION ACCOMPLISHED' -e 'consult-handoff' "$ARCHIVE_ROOT" 2>/dev/null | grep -q . && echo 0 || echo 1)"

############################################################################
# Tally
############################################################################
echo "===================================================================="
TOTAL=$((PASS + FAIL))
printf 'TALLY: %d/%d passed (%d failed)\n' "$PASS" "$TOTAL" "$FAIL"
if [ "$FAIL" -eq 0 ]; then echo "RESULT: ALL PASS"; exit 0; else echo "RESULT: FAILURES PRESENT"; exit 1; fi
