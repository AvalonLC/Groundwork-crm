import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../scripts/backfill-job-budget-versions.mjs';

/**
 * Unit tests for scripts/backfill-job-budget-versions.mjs's CLI argument
 * parsing ONLY. This is deliberately the only piece of the CLI wrapper
 * worth its own test: every actual safety property (dry-run default,
 * confirmation token, backup confirmation, audit attribution, tenant
 * scoping, idempotency, etc.) is already covered by src/db/backfill-
 * write-repos.test.ts and src/engines/backfill-write.test.ts (98 tests,
 * PR #110) against the functions this script merely calls. Importing
 * parseArgs (rather than shelling out to the whole script) also never
 * triggers the module's getPlatformProxy/D1 side effects, per the
 * import.meta.url entrypoint guard at the bottom of that file.
 */

test('parseArgs: defaults to local, dry-run, no safety flags set', () => {
  const args = parseArgs(['--company', 'acct_x', '--as-of', '2026-08-01']);
  assert.equal(args.company, 'acct_x');
  assert.equal(args.asOf, '2026-08-01');
  assert.equal(args.remote, false);
  assert.equal(args.environment, 'local');
  assert.equal(args.apply, false);
  assert.equal(args.backupConfirmed, false);
  assert.equal(args.confirm, undefined);
  assert.equal(args.approvedBy, undefined);
});

test('parseArgs: --remote sets both remote=true and environment="remote"', () => {
  const args = parseArgs(['--remote', '--company', 'acct_x', '--as-of', '2026-08-01']);
  assert.equal(args.remote, true);
  assert.equal(args.environment, 'remote');
});

test('parseArgs: --local explicitly still resolves to environment="local"', () => {
  const args = parseArgs(['--local', '--company', 'acct_x', '--as-of', '2026-08-01']);
  assert.equal(args.remote, false);
  assert.equal(args.environment, 'local');
});

test('parseArgs: apply path captures all four safety flags', () => {
  const args = parseArgs([
    '--company', 'acct_x', '--as-of', '2026-08-01',
    '--apply', '--confirm', 'abc123', '--backup-confirmed', '--approved-by', 'Tyler Ridge',
  ]);
  assert.equal(args.apply, true);
  assert.equal(args.confirm, 'abc123');
  assert.equal(args.backupConfirmed, true);
  assert.equal(args.approvedBy, 'Tyler Ridge');
});

test('parseArgs: --help sets help=true without requiring --company/--as-of', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
  assert.equal(args.company, undefined);
});

test('parseArgs: an unrecognized flag exits the process rather than being silently ignored', () => {
  // parseArgs itself calls process.exit(1) synchronously on an unknown
  // flag (matching this script's "fail loud, never guess" convention) --
  // spawn a subprocess to observe that exit rather than letting it kill
  // the test runner.
  const result = spawnSync(process.execPath, [
    '-e',
    `import('${new URL('../scripts/backfill-job-budget-versions.mjs', import.meta.url).href}').then(m => m.parseArgs(['--nope']))`,
  ]);
  assert.equal(result.status, 1);
});

test('parseArgs: environment is never independently settable -- always derives from --local/--remote', () => {
  // There is deliberately no --environment flag: BackfillManifestEnvironment
  // is "local" | "remote" and must always match where the manifest actually
  // ran (validateManifestForExecution enforces this on the write side); a
  // separate --environment flag could let a caller claim "remote" while
  // actually targeting local D1, or vice versa. parseArgs calls
  // process.exit(1) (not throw) on any unrecognized flag including
  // --environment, so this must run out-of-process like the test above.
  const result = spawnSync(process.execPath, [
    '-e',
    `import('${new URL('../scripts/backfill-job-budget-versions.mjs', import.meta.url).href}').then(m => m.parseArgs(['--company', 'x', '--as-of', '2026-01-01', '--environment', 'production']))`,
  ]);
  assert.equal(result.status, 1);
});
