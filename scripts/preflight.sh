#!/usr/bin/env bash
# Wave 0 gate. Every line must PASS before wave 1.
# usage: npm run preflight          (static checks only)
#        npm run preflight -- live  (also burns ~1 agent turn to prove auth)
set -uo pipefail
MODE="${1:-static}"
ok=0; fail=0; warn=0
chk(){ if eval "$2" >/dev/null 2>&1; then echo "  PASS   $1"; ok=$((ok+1));
       else echo "  FAIL   $1"; fail=$((fail+1)); fi; }
soft(){ if eval "$2" >/dev/null 2>&1; then echo "  PASS   $1"; ok=$((ok+1));
        else echo "  WARN   $1"; warn=$((warn+1)); fi; }
todo=0
todo(){ if eval "$2" >/dev/null 2>&1; then echo "  PASS   $1"; ok=$((ok+1));
        else echo "  TODO   $1  <-- you must do this"; todo=$((todo+1)); fi; }

echo "=== Groundwork preflight ($MODE) ==="

echo "-- toolchain --"
chk "node >= 20"                  "node -e 'process.exit(+process.versions.node.split(\".\")[0]>=20?0:1)'"
chk "npm present"                 "command -v npm"
chk "node_modules installed"      "test -d node_modules"
chk "npx wrangler responds"       "./node_modules/.bin/wrangler --version"

echo "-- git wiring --"
chk "git repo initialised"        "git rev-parse --git-dir"
todo "remote 'origin' set"        "git remote get-url origin"
chk "on branch main"             "test \"\$(git rev-parse --abbrev-ref HEAD)\" = main"
PROTECTED_GREP="$(grep -v '^#' .agent-protected 2>/dev/null | grep -v '^$' | paste -sd'|' - )"
chk "working tree clean (excl. protected)" "test -z \"\$(git status --porcelain | grep -vE \"\${PROTECTED_GREP:-^\\$}\")\""
chk "no in-progress src/ edits (excl. protected)" "test -z \"\$(git status --porcelain -- src/ 2>/dev/null | grep -vE \"\${PROTECTED_GREP:-^\\$}\")\""
todo "origin reachable"           "git ls-remote --exit-code origin HEAD"
chk "hooksPath = .githooks"       "test \"\$(git config core.hooksPath)\" = '.githooks'"
chk "pre-push hook executable"    "test -x .githooks/pre-push"
chk "worktree cmd available"      "git worktree list"

echo "-- contract + graph --"
chk "CLAUDE.md non-empty"         "test -s CLAUDE.md"
chk "AGENTS.md non-empty"         "test -s AGENTS.md"
chk "tasks.json parses"           "node -e 'JSON.parse(require(\"fs\").readFileSync(\"tasks.json\"))'"
chk "graph valid, no collisions"  "node scripts/validate-tasks.js"
chk "golden.json parses"          "node scripts/check-fixtures.js"
chk "every spec_ref file exists"  "node scripts/check-specrefs.js"
chk "finance config files valid"  "node scripts/validate-finance-config.js"

echo "-- the equipment double-count guard --"
chk "BH-13 present"               "grep -q 'BH-13' src/engines/burden.test.ts"
chk "BH-13 asserts 40.62"         "grep -q '40.62' src/engines/burden.test.ts"
chk "BH-13 rejects 39.49"         "grep -q 'not.toBe(39.49)' src/engines/burden.test.ts"
chk "fixture says 40.62"          "node -e 'const g=require(\"./fixtures/golden.json\");process.exit(g.burden_labor_no_equipment.expect.burdened_rate.toFixed(2)===\"40.62\"?0:1)'"
chk "39.49 absent (except BH-13)" "test -z \"\$(grep -rln '39\\.49' --include='*.ts' --include='*.json' --include='*.sql' src fixtures migrations 2>/dev/null | grep -v 'burden.test.ts')\""

echo "-- prod-safety guards --"
chk "no --remote in src/"         "! grep -rn -- '--remote' src/ 2>/dev/null"
chk "no --remote in run-wave"     "! grep -n -- '--remote' scripts/run-wave.sh 2>/dev/null"
chk "no DB_PROD in src/"          "! grep -rn 'DB_PROD' src/ scripts/*.js 2>/dev/null"
chk "hook blocks npm run deploy"  "grep -q 'npm run deploy' .githooks/pre-push"
chk "hook blocks db:migrate:prod" "grep -q 'db:migrate:prod' .githooks/pre-push"
chk "hook blocks pages deploy"    "grep -qF 'wrangler (pages )?deploy' .githooks/pre-push"
chk "scope enforcer present"      "test -s scripts/verify-scope.js"
chk "scope gate wired into runner" "grep -q 'verify-scope.js' scripts/run-wave.sh"
chk "hook blocks --remote"        "grep -q 'wrangler.*--remote' .githooks/pre-push"
chk "hook blocks 39.49"           "grep -q '39' .githooks/pre-push"
chk "hook protects burden.test"   "grep -q 'burden.test.ts' .githooks/pre-push"

echo "-- cloudflare bindings --"
WR=""; for f in wrangler.jsonc wrangler.json wrangler.toml; do [ -f "$f" ] && WR="$f" && break; done
chk "wrangler config found"       "test -n \"$WR\""
chk "D1 binding"                  "grep -qi 'd1_databases' \"$WR\""
todo "D1 database_id filled in"   "! grep -q REPLACE_WITH \"$WR\""
chk "Vectorize binding"           "grep -qi vectorize \"$WR\""
chk "R2 binding"                  "grep -qi 'r2_buckets' \"$WR\""
chk "Workers AI binding"          "grep -qiE '\"ai\"|\\[ai\\]' \"$WR\""
# This project deploys as Cloudflare Pages, which has no native Cron Trigger support
# (that's a Workers-only feature). The nightly recovery rollup (W3-rollup) needs a
# companion Worker with its own cron trigger, or an external scheduled caller hitting
# an authenticated internal endpoint. Not a config line to check for — flagged in
# docs/spec/RECOVERY.md instead, resolved before W3-rollup starts.
echo "  SKIP   cron trigger  (Pages has no native cron — see docs/spec/RECOVERY.md)"
soft "wrangler authenticated"     "./node_modules/.bin/wrangler whoami"
soft "local D1 migrates"          "npm run db:local"

echo "-- agent CLI --"
chk "claude or codex on PATH"     "command -v claude || command -v codex"
if [ "$MODE" = "live" ]; then
  chk "claude AUTHENTICATED"      "test \"\$(claude -p 'Reply with the single word READY and nothing else.' 2>/dev/null | tr -d '[:space:]')\" = 'READY'"
else
  echo "  SKIP   claude AUTHENTICATED  (run: npm run preflight -- live)"
fi

echo
echo "  $ok passed · $fail failed · $todo todo · $warn warned"
[ "$warn" -gt 0 ] && echo "  WARN = needs a Cloudflare login/setup step, not a blocker for wave 1 tests."
if [ "$fail" -gt 0 ]; then
  echo "  ==> BROKEN HARNESS. Fix the FAIL lines before anything else."; exit 1
fi
if [ "$todo" -gt 0 ]; then
  echo
  echo "  Harness is sound. Complete the TODO items above:"
  echo "    git remote add origin git@github.com:<you>/groundwork-finance-os.git"
  echo "    git push -u origin main"
  echo "    ./node_modules/.bin/wrangler d1 create groundwork   # paste id into wrangler.jsonc"
  exit 2
fi
echo "  ==> All green. Next: bash scripts/harness-selftest.sh"
