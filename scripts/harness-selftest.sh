#!/usr/bin/env bash
# Proves the harness works end-to-end with ZERO agent tokens.
# Run this after preflight, before wave 1.
set -uo pipefail
ROOT="$(pwd)"; pass=0; fail=0
say(){ printf '\n\033[1m== %s\033[0m\n' "$1"; }
chk(){ if eval "$2" >/dev/null 2>&1; then echo "  PASS   $1"; pass=$((pass+1));
       else echo "  FAIL   $1"; fail=$((fail+1)); fi; }

say "0. dependencies present (gates cannot run without them)"
chk "node_modules installed"        "test -d node_modules"
chk "vitest resolvable"             "node -e 'require.resolve(\"vitest\")'"
chk "node_modules NOT tracked"      "! git ls-files | grep -qx node_modules"
chk "node_modules is a real dir"    "test -d node_modules -a ! -L node_modules"
if [ ! -d node_modules ]; then
  echo "  ==> run: npm install   (gates will all FAIL without it)"; exit 1
fi

say "1. pre-push hook actually blocks bad commits"
tmp=$(mktemp -d)
for probe in "wrangler d1 migrations apply DB --remote" "const x = DB_PROD" "const r = 39.49" "it.skip('x', () => {})"; do
  echo "$probe" > "$tmp/probe.ts"
  cp "$tmp/probe.ts" ./_probe.ts && git add ./_probe.ts >/dev/null 2>&1
  if git diff --cached ./_probe.ts | grep -qE '^\+.*(--remote|DB_PROD|39\.49|\.skip\()'; then
    echo "  PASS   hook pattern matches: $(printf %.34s "$probe")"; pass=$((pass+1))
  else
    echo "  FAIL   hook pattern MISSED: $(printf %.34s "$probe")"; fail=$((fail+1))
  fi
  git reset -q ./_probe.ts >/dev/null 2>&1; rm -f ./_probe.ts
done
rm -rf "$tmp"

say "2. prompt rendering produces a usable brief"
P="$(node scripts/render-prompt.js E2-burden 2>/dev/null)"
chk "prompt non-empty"              "test -n \"\$P\""
chk "prompt names the gate"         "echo \"\$P\" | grep -q 'npm test'"
chk "prompt embeds the fixture"     "echo \"\$P\" | grep -q '40.62'"
chk "prompt lists forbidden items"  "echo \"\$P\" | grep -qi 'forbidden'"
chk "prompt marks test read-only"   "echo \"\$P\" | grep -q 'READ-ONLY'"
chk "prompt bans 39.49"             "echo \"\$P\" | grep -q '39.49'"

say "3. dependency gating refuses to skip ahead"
chk "wave 3 blocked (no wave-1/2 tag)" "! node scripts/check-deps.js 3"

say "4. gate lookup + coverage verifier resolve"
chk "gate-for returns a command"    "node scripts/gate-for.js E2-burden | grep -q npm"
chk "coverage verifier exits clean on no-op" "node scripts/verify-gate-coverage.js W1-repos"

say "5. LIVE DRY RUN: real runner, noop driver, real gate  (no tokens)"
# Satisfy every wave BELOW the dry-run wave, derived from tasks.json so this
# never breaks again when a wave is added.
DRY_WAVE=2
for w in $(node -e "const t=require('./tasks.json');console.log(t.waves.filter(x=>x.id<$DRY_WAVE).map(x=>x.id).join(' '))"); do
  git tag -f "wave-$w-green" >/dev/null 2>&1
done
ONLY_TASK=E2-burden bash scripts/run-wave.sh 2 noop > logs/selftest-wave2.log 2>&1
DRY=$?
chk "runner completed"              "test $DRY -eq 0 -o -s logs/selftest-wave2.log"
chk "E2-burden was graded"          "grep -q 'E2-burden' status.log"
chk "E2-burden PASSED its gate"     "grep -q 'E2-burden PASS' status.log"
chk "wave-2-green tag created"      "git tag | grep -q wave-2-green"

say "6. rollback works"
chk "prior wave tags resolve"       "git rev-parse wave-1-green"

say "7. teardown"
for b in $(git branch --list 'agent/*' | tr -d ' *+'); do
  git worktree remove --force "../wt-${b#agent/}" >/dev/null 2>&1
  git branch -D "$b" >/dev/null 2>&1
done
for w in $(node -e "const t=require('./tasks.json');console.log(t.waves.map(x=>x.id).join(' '))"); do
  git tag -d "wave-$w-green" >/dev/null 2>&1
done
git worktree prune >/dev/null 2>&1
git checkout -q -- . 2>/dev/null
# The noop driver's reference engine must never persist — E2-burden owns it.
git rm -q --cached src/engines/burden.ts src/engines/types.ts 2>/dev/null || true
rm -f src/engines/burden.ts src/engines/types.ts
git commit -q -m "selftest teardown: drop noop reference impl" 2>/dev/null || true
chk "worktrees cleaned"             "test \$(git worktree list | wc -l) -le 1"
chk "agent branches removed"        "test -z \"\$(git branch --list 'agent/*')\""
chk "noop reference impl removed"   "! test -f src/engines/burden.ts"
chk "BH-13 test still intact"        "grep -q 'not.toBe(39.49)' src/engines/burden.test.ts"

printf '\n  %s passed · %s failed\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  echo "  ==> HARNESS NOT READY. Fix before spending tokens."; exit 1
fi
echo "  ==> Harness verified end-to-end. Safe to run: ./scripts/run-wave.sh 1"
