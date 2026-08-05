#!/usr/bin/env bash
# usage: ./scripts/run-wave.sh <wave> [claude|codex]
set -uo pipefail
WAVE="${1:?usage: run-wave.sh <wave> [claude|codex]}"
DRIVER="${2:-claude}"
# Per-wave driver override, e.g. DRIVER_W4=codex DRIVER_W6=codex
eval "OVERRIDE=\${DRIVER_W${WAVE}:-}"
[ -n "$OVERRIDE" ] && DRIVER="$OVERRIDE"
# Unattended requires non-interactive permissions. Their terminal shows
# "manual mode on", which prompts on every edit and would hang all night.
PERM="${PERM:-acceptEdits}"
# Precision waves get the stronger model; bulk transcription gets the faster one.
case "$WAVE" in
  0|1|2|3) MODEL="${MODEL:-opus}" ;;
  *)       MODEL="${MODEL:-sonnet}" ;;
esac
ROOT="$(pwd)"
mkdir -p logs
: > status.log

echo "=== wave $WAVE  driver=$DRIVER  model=$MODEL  perm=$PERM  $(date -u +%FT%TZ) ==="

node scripts/check-deps.js "$WAVE" || exit 1

if [ -n "${ONLY_TASK:-}" ]; then TASKS="$ONLY_TASK"
else TASKS=$(node scripts/tasks-in-wave.js "$WAVE"); fi
[ -z "$TASKS" ] && { echo "no tasks in wave $WAVE"; exit 1; }

for TASK in $TASKS; do
  (
    WT="../wt-$TASK"
    git worktree add "$WT" -b "agent/$TASK" main >/dev/null 2>&1 \
      || { echo "$TASK FAIL(worktree)" >> "$ROOT/status.log"; exit 0; }
    cd "$WT" || exit 0

    # Share the parent's node_modules rather than reinstalling per worktree.
    # CRITICAL: exclude it locally FIRST. A symlink named node_modules is not
    # matched by a "node_modules/" gitignore entry, and `git add -A` will
    # happily commit it — which poisons main with a self-referential link.
    printf 'node_modules\n.wrangler\nlogs\nstatus.log\ntest-results.json\n' \
      >> "$(git rev-parse --git-dir)/info/exclude"
    if [ -d "$ROOT/node_modules" ]; then
      ln -s "$ROOT/node_modules" node_modules 2>/dev/null || true
    fi
    if ! node -e 'require.resolve("vitest")' >/dev/null 2>&1; then
      npm install --silent --no-audit --no-fund >/dev/null 2>&1
    fi
    if ! node -e 'require.resolve("vitest")' >/dev/null 2>&1; then
      echo "$TASK FAIL(deps-missing)" >> "$ROOT/status.log"; exit 0
    fi

    PROMPT="$(node "$ROOT/scripts/render-prompt.js" "$TASK")"

    case "$DRIVER" in
      claude) claude -p "$PROMPT" \
                 --permission-mode "$PERM" \
                 --model "$MODEL" \
                 --output-format stream-json \
                 > "$ROOT/logs/$TASK.jsonl" 2>&1 ;;
      codex)  # CODEX_FLAGS lets you add sandbox/approval flags without editing this.
              # shellcheck disable=SC2086
              codex exec ${CODEX_FLAGS:-} "$PROMPT" > "$ROOT/logs/$TASK.log" 2>&1 ;;
      noop)   # harness self-test: no agent, no tokens. Applies a known-good
              # patch so the gate has something real to grade.
              bash "$ROOT/scripts/noop-driver.sh" "$TASK" > "$ROOT/logs/$TASK.log" 2>&1 ;;
      *)      echo "unknown driver $DRIVER"; exit 1 ;;
    esac

    # Defensive: if the agent staged/committed node_modules anyway, strip it.
    git rm -r --cached -q node_modules 2>/dev/null && \
      git commit -q --amend --no-edit 2>/dev/null || true

    # ---- THE GATE. The agent's opinion is irrelevant. ----
    GATE="$(node "$ROOT/scripts/gate-for.js" "$TASK")"
    if node "$ROOT/scripts/verify-scope.js" "$TASK" "$ROOT" > "$ROOT/logs/$TASK.gate.log" 2>&1 \
       && eval "$GATE" >> "$ROOT/logs/$TASK.gate.log" 2>&1 \
       && node "$ROOT/scripts/verify-gate-coverage.js" "$TASK" >> "$ROOT/logs/$TASK.gate.log" 2>&1; then
      echo "$TASK PASS" >> "$ROOT/status.log"
      git push -u origin "agent/$TASK" >/dev/null 2>&1
    else
      echo "$TASK FAIL" >> "$ROOT/status.log"
    fi
  ) &
done
wait

echo "--- results ---"; cat status.log

node scripts/merge-passing.js "$WAVE" || exit 1

if grep -q FAIL status.log; then
  echo "WAVE $WAVE HAS FAILURES — not tagging. Review logs/ then re-run."
  [ -z "${ALLOW_PARTIAL:-}" ] && exit 1
fi

echo "--- wave regression ---"
npm test && npm run typecheck || { echo "WAVE $WAVE REGRESSION FAILED — not tagging"; exit 1; }

git tag "wave-$WAVE-green" && git push --tags >/dev/null 2>&1
echo "=== wave $WAVE GREEN — tagged wave-$WAVE-green ==="
