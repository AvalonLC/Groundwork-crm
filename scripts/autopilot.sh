#!/usr/bin/env bash
# Unattended driver. Runs both gates, then waves FROM..TO, stopping on first failure.
#   DRIVER=claude FROM=1 TO=6 bash scripts/autopilot.sh
set -uo pipefail
DRIVER="${DRIVER:-claude}"; FROM="${FROM:-0}"; TO="${TO:-6}"
export PLAN="${PLAN:-pro}"        # pro throttles parallel agents
export PERM="${PERM:-acceptEdits}"
mkdir -p logs
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="logs/autopilot-$STAMP.log"
HB="logs/HEARTBEAT.md"

note(){ printf '%s | %s\n' "$(date -u +%H:%M:%SZ)" "$1" | tee -a "$LOG"; }
beat(){ cat > "$HB" <<HEART
# Autopilot heartbeat
updated : $(date -u +%FT%TZ)
driver  : $DRIVER
stage   : $1
waves   : $(git tag | grep -c 'wave-.*-green') green of $((TO-FROM+1))
tags    : $(git tag | tr '\n' ' ')
last    : $(tail -1 status.log 2>/dev/null || echo none)
blocked : $(ls BLOCKED-*.md 2>/dev/null | tr '\n' ' ' || echo none)
HEART
}

note "=== AUTOPILOT START  driver=$DRIVER  waves $FROM..$TO ==="
beat "preflight"

note "--- gate 1: preflight ---"
if ! bash scripts/preflight.sh >>"$LOG" 2>&1; then
  RC=$?
  note "PREFLIGHT NOT CLEAN (exit $RC). See $LOG. Nothing was built."
  beat "halted: preflight"; exit $RC
fi
note "preflight clean"

note "--- gate 2: harness self-test (zero tokens) ---"
if ! bash scripts/harness-selftest.sh >>"$LOG" 2>&1; then
  note "SELFTEST FAILED. Harness is not sound. Nothing was built."
  beat "halted: selftest"; exit 1
fi
note "harness verified"

for W in $(seq "$FROM" "$TO"); do
  beat "wave $W running"
  note "--- wave $W start ---"
  EXPECTED=$(node -e "const t=require('./tasks.json');console.log(t.tasks.filter(x=>x.wave===$W).length)")

  if ! bash scripts/run-wave.sh "$W" "$DRIVER" >>"$LOG" 2>&1; then
    note "WAVE $W FAILED — stopping. Nothing merged from failed tasks."
    { echo "## Wave $W halted $(date -u +%FT%TZ)"; echo; cat status.log 2>/dev/null; } >> docs/PUNCHLIST.md
    beat "halted: wave $W"; exit 1
  fi

  GRADED=$(wc -l < status.log)
  if [ "$GRADED" -lt "$EXPECTED" ]; then
    note "wave $W: $GRADED of $EXPECTED graded (PLAN=$PLAN throttles parallelism)"
    note "re-running wave $W for the remaining tasks"
    if ! bash scripts/run-wave.sh "$W" "$DRIVER" >>"$LOG" 2>&1; then
      note "WAVE $W second pass FAILED — stopping."
      beat "halted: wave $W pass2"; exit 1
    fi
  fi

  if ! git tag | grep -q "wave-$W-green"; then
    note "WAVE $W did not tag green — stopping."; beat "halted: wave $W untagged"; exit 1
  fi
  note "wave $W GREEN ($GRADED/$EXPECTED tasks)"
done

beat "complete"
note "=== ALL WAVES GREEN. Review docs/PUNCHLIST.md and BLOCKED-*.md ==="
note "Production D1 was NOT touched. Promote manually when awake."
