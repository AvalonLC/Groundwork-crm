/* A routine merge must not be able to reach production.
 *
 * deploy.yml used to trigger on `push: branches: [main]`, so every merge applied
 * remote D1 migrations and published to groundwork-crm.com. On 2026-09-07 three
 * engineering PRs merged twenty seconds apart produced three production
 * deployments and three `migrations apply --remote` runs in under a minute.
 * Nothing was wrong with the changes; nobody chose to deploy three times.
 *
 * These pin the separation. They read the workflow text rather than parsing YAML
 * because this repo has no YAML dependency (package.json: fflate and hono), and
 * adding one to assert a handful of lines is not a trade worth making.
 *
 * Run: node --test tests/deploy-workflow-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** Workflow text with comments stripped — prose about a trigger is not a trigger. */
const code = deploy.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');

test('DG-01 production deploy has no automatic trigger', () => {
  // The whole point. A `push:` or `pull_request:` key here re-couples merging
  // to shipping.
  assert.doesNotMatch(code, /^\s*push:/m, 'deploy.yml triggers on push again');
  assert.doesNotMatch(code, /^\s*pull_request:/m, 'deploy.yml triggers on pull_request');
  assert.doesNotMatch(code, /^\s*schedule:/m, 'deploy.yml runs on a schedule');
  assert.match(code, /workflow_dispatch:/, 'deploy.yml can no longer be dispatched at all');
});

test('DG-02 merging still runs full verification', () => {
  // Decoupling deployment must not decouple checking. ci.yml keeps running on
  // push to main, so a merge is still gated — it just does not ship.
  assert.match(ci, /push:\s*\{?\s*branches:\s*\[\s*main/, 'ci.yml no longer runs on push to main');
  assert.match(ci, /pull_request:/, 'ci.yml no longer runs on pull requests');
});

test('DG-03 migrations and deployment each require their own approval', () => {
  // Two environments, not one. Publishing a Worker is reversible by redeploying
  // the previous build; a migration is not, so it gets its own reviewer prompt
  // rather than riding along on the deployment approval.
  assert.match(code, /environment: production-database/, 'the migration job lost its protected environment');
  assert.match(code, /environment: production\s*$/m, 'the deploy job lost its protected environment');
});

test('DG-04 migrations run before the deploy, and a failed migration blocks it', () => {
  // The Worker that lands expects the schema to already be there. Deploying
  // first would serve new code against an old database for the length of the
  // migration run.
  assert.match(code, /needs: \[preflight, verify, migrate\]/, 'deploy no longer waits for migrate');
  assert.match(
    code, /needs\.migrate\.result != 'failure'/,
    'a failed migration no longer blocks the deploy',
  );
  // migrate is skipped when run_migrations=no, and a skipped dependency would
  // otherwise skip deploy — always() keeps it reachable. Without the result
  // checks above, always() would also let a FAILED migration through.
  assert.match(code, /if: always\(\)/);
  assert.match(code, /needs\.verify\.result == 'success'/);
});

test('DG-05 only one production deployment runs at a time', () => {
  assert.match(code, /concurrency:/);
  assert.match(code, /group: production-deploy/);
  // Cancelling a half-applied `d1 migrations apply --remote` is worse than
  // queueing behind it.
  assert.match(code, /cancel-in-progress: false/, 'a queued deploy can now cancel a running migration');
});

test('DG-06 the ref being shipped is re-verified, not assumed', () => {
  // A dispatch can name any ref, including one that never went through a PR,
  // so "it passed CI" has to be made true of the artifact actually deployed.
  const verify = code.slice(code.indexOf('  verify:'), code.indexOf('  migrate:'));
  for (const step of ['npm run typecheck', 'npm test', 'npm run e2e', 'npm run build']) {
    assert.ok(verify.includes(step), `the verify job no longer runs ${step}`);
  }
});

test('DG-07 the run records what it shipped', () => {
  assert.match(code, /GITHUB_STEP_SUMMARY/, 'the deploy no longer records the commit it shipped');
  assert.match(code, /needs\.preflight\.outputs\.sha/);
  assert.match(code, /outputs\.migrations/, 'the migration set is no longer recorded');
});

test('DG-08 a dispatch must be confirmed in words', () => {
  assert.match(code, /inputs\.confirm != 'DEPLOY'/, 'the confirmation phrase check is gone');
});

test('DG-09 the runbook exists and covers rollback and smoke checks', () => {
  // A gate nobody knows how to operate gets worked around.
  const runbook = readFileSync(new URL('../docs/RUNBOOK-deploy.md', import.meta.url), 'utf8');
  for (const heading of ['## Deploying', '## Smoke checks', '## Rollback']) {
    assert.ok(runbook.includes(heading), `RUNBOOK-deploy.md is missing "${heading}"`);
  }
  // The smoke list must stay non-mutating: it is run against live customer data.
  assert.match(runbook, /Do not charge a card or record a payment/);
  // Migrations are forward-only here; a runbook that implies otherwise is worse
  // than none.
  assert.match(runbook, /Migrations do not roll back/);
  assert.match(code, /docs\/RUNBOOK-deploy\.md/, 'the workflow no longer points at the runbook');
});
