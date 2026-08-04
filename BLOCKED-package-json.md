# BLOCKED: package.json missing Finance OS scripts/deps

`package.json` was modified outside this session (by Tyler or a linter) between
the last preflight run (green, 43/0/0/1) and the harness self-test attempt.
The finance scripts and devDependencies added earlier are no longer present:

Missing scripts: `test`, `test:watch`, `typecheck`, `e2e`, `preflight`, `db:local`, `db:reset`
Missing devDependencies: `@cloudflare/workers-types`, `@playwright/test`, `typescript`, `vitest`

Also present: an intentional edit to `dev:local` (`--d1=DB` instead of
`--d1=DB=avalon-sales-hub-production`) — left as-is, not reverted.

## Impact
- `npm run preflight` will fail with "missing script" until `preflight` is restored.
- Wave 1+ tasks that gate on `npm test`, `npm run typecheck`, `npm run db:local`,
  `npm run db:reset` cannot run.
- Wave 0 (spec derivation) is unaffected — its gate calls `node scripts/*.js` directly.

## What I need from Tyler
Confirm whether this was intentional (e.g. reverted on purpose while editing
something else) or accidental, and whether to re-add the finance scripts/deps.
Per standing policy this session does not modify package.json again without
explicit go-ahead.

## What I'm doing meanwhile
Proceeding with Wave 0 (docs/spec derivation), which has no package.json dependency.
