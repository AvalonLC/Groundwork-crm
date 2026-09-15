#!/usr/bin/env node
/**
 * Report what production is running that the deploy workflow never shipped.
 * READ ONLY. No database, no credentials, no writes.
 *
 * Why this exists
 * ---------------
 * On 2026-09-15 production was found serving code whose schema had never been
 * applied: migrations 0088 (invoice void/archive/audit) and 0089 (lead import)
 * were on main and live in the running bundle, while the last run that applied
 * migrations was 248f586 on 2026-09-09. `GET /api/invoices` was selecting
 * `archived_at` against a table without the column.
 *
 * It went unnoticed because every check asked the wrong question. Reading
 * deploy.yml's run history answers "did the WORKFLOW deploy", and that was
 * reported as "production is unchanged". Those are the same sentence only if
 * the workflow is the sole route to production, and it is not: a Cloudflare
 * Pages Git integration, configured in the Cloudflare dashboard and invisible
 * to this repository, builds and ships `main` on every push.
 *
 * So this script never asks what a workflow did. It compares two things it can
 * observe directly:
 *
 *   1. migrations on main vs. migrations present at the last commit whose run
 *      actually applied them — the set difference is what production's schema
 *      is missing under code that already assumes it.
 *   2. the SHA-256 of the bundle production serves vs. the one on main. If
 *      production matches main while main is ahead of that last deployed
 *      commit, something outside this repository shipped it.
 *
 * Both are answerable with git and one public HTTP GET.
 *
 *   node scripts/check-production-drift.mjs
 *   node scripts/check-production-drift.mjs --json
 *   node scripts/check-production-drift.mjs --no-fetch          # git only
 *   node scripts/check-production-drift.mjs --since-sha=<sha>   # pin the baseline
 *
 * Exit: 0 no drift · 1 drift found · 2 refused · 3 could not determine.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const PROD_ASSET = 'https://groundwork-crm.com/js/app_premium.js';
const REPO_ASSET = 'public/js/app_premium.js';
const WORKFLOW = 'deploy.yml';

/**
 * The step or job that applies migrations, under either workflow shape.
 * Before PR #139 deploy.yml was one job ("Build & Deploy") with a step called
 * "Apply CRM D1 migrations"; after it, a dedicated job "Apply remote D1
 * migrations" behind the production-database environment. The last run that
 * actually migrated used the old shape, so matching only the new job name
 * finds nothing and reports every migration ever written as unapplied.
 */
const APPLIES_MIGRATIONS = /apply\b.*\bd1 migrations/i;

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

if (flag('--remote')) {
  console.error('Refusing --remote. This script reads no database at all; there is nothing for that flag to mean.');
  process.exit(2);
}

const asJson = flag('--json');
const inActions = process.env.GITHUB_ACTIONS === 'true';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Migration filenames at a ref. Excludes migrations/finance/, which CLAUDE.md
 *  keeps only as a record of a database that no longer exists. */
function migrationsAt(ref) {
  const out = git(['ls-tree', '-r', '--name-only', ref, '--', 'migrations']);
  return out
    .split('\n')
    .filter(p => /^migrations\/[^/]+\.sql$/.test(p))
    .map(p => p.slice('migrations/'.length))
    .sort();
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Most recent commit whose deploy.yml run actually applied migrations. */
function lastMigratedSha() {
  const runs = JSON.parse(execFileSync('gh', [
    'run', 'list', '--workflow', WORKFLOW, '--status', 'success',
    '--limit', '30', '--json', 'databaseId,headSha,createdAt',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

  for (const run of runs) {
    const detail = JSON.parse(execFileSync('gh', [
      'run', 'view', String(run.databaseId), '--json', 'jobs',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

    for (const job of detail.jobs ?? []) {
      const units = [job, ...(job.steps ?? [])];
      if (units.some(u => APPLIES_MIGRATIONS.test(u.name ?? '') && u.conclusion === 'success')) {
        return { sha: run.headSha, runId: run.databaseId, at: run.createdAt };
      }
    }
  }
  return null;
}

// ── baseline ────────────────────────────────────────────────────────────────
const pinned = value('--since-sha');
let baseline;

if (pinned) {
  baseline = { sha: git(['rev-parse', pinned]).trim(), runId: null, at: null, pinned: true };
} else {
  try {
    baseline = lastMigratedSha();
  } catch {
    console.error('Could not read workflow runs. Is the GitHub CLI installed and authenticated (gh auth status)?');
    process.exit(3);
  }
  if (!baseline) {
    console.error(`No ${WORKFLOW} run in the last 30 successes applied migrations. Pass --since-sha to set a baseline.`);
    process.exit(3);
  }
}

const head = (() => {
  for (const ref of ['origin/main', 'main']) {
    try { return { ref, sha: git(['rev-parse', ref]).trim() }; } catch { /* try the next */ }
  }
  console.error('Neither origin/main nor main resolves. Fetch first.');
  process.exit(3);
})();

// ── 1. schema drift ─────────────────────────────────────────────────────────
const onHead = migrationsAt(head.sha);
const atBaseline = migrationsAt(baseline.sha);
const unapplied = onHead.filter(m => !atBaseline.includes(m));
const vanished = atBaseline.filter(m => !onHead.includes(m));

// ── 2. code drift ───────────────────────────────────────────────────────────
let code = { checked: false };
if (!flag('--no-fetch')) {
  try {
    const res = await fetch(PROD_ASSET, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const served = sha256(Buffer.from(await res.arrayBuffer()));
    const onMain = sha256(execFileSync('git', ['show', `${head.sha}:${REPO_ASSET}`], { maxBuffer: 1 << 28 }));
    const onBaseline = sha256(execFileSync('git', ['show', `${baseline.sha}:${REPO_ASSET}`], { maxBuffer: 1 << 28 }));
    code = {
      checked: true,
      asset: PROD_ASSET,
      served,
      matchesHead: served === onMain,
      matchesBaseline: served === onBaseline,
      // Production carrying main's bytes while main is ahead of the last
      // deployed commit means a path other than the workflow shipped it.
      shippedOutsideWorkflow: served === onMain && head.sha !== baseline.sha,
    };
  } catch (e) {
    code = { checked: false, error: String(e.message ?? e) };
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const drift = unapplied.length > 0 || vanished.length > 0 || code.shippedOutsideWorkflow === true;

if (asJson) {
  console.log(JSON.stringify({
    baseline, head, unapplied, vanished, code, drift,
  }, null, 2));
} else {
  const short = s => s.slice(0, 7);
  console.log('Production drift');
  console.log('────────────────');
  console.log(`  baseline   ${short(baseline.sha)}${baseline.pinned ? '  (pinned via --since-sha)' : `  run ${baseline.runId}  ${baseline.at}`}`);
  console.log(`  ${head.ref.padEnd(10)} ${short(head.sha)}`);
  console.log(`  migrations ${atBaseline.length} at baseline → ${onHead.length} on ${head.ref}`);
  console.log('');

  if (unapplied.length) {
    console.log(`  UNAPPLIED IN PRODUCTION (${unapplied.length}) — code on ${head.ref} may already query this schema:`);
    for (const m of unapplied) console.log(`    ${m}`);
  } else {
    console.log('  No unapplied migrations.');
  }

  if (vanished.length) {
    console.log('');
    console.log(`  PRESENT AT BASELINE BUT GONE FROM ${head.ref} (${vanished.length}) — a migration was renamed or removed`);
    console.log('  after it had been applied. Production still carries its effects:');
    for (const m of vanished) console.log(`    ${m}`);
  }

  console.log('');
  if (!code.checked) {
    console.log(`  Served bundle not checked${code.error ? ` (${code.error})` : ' (--no-fetch)'}.`);
  } else if (code.shippedOutsideWorkflow) {
    console.log(`  Production serves ${head.ref}'s bundle, but the workflow last deployed ${short(baseline.sha)}.`);
    console.log('  Something outside this repository is deploying — check for a Cloudflare Pages');
    console.log('  Git integration (dashboard → Pages → groundwork-crm → Builds & deployments).');
  } else if (code.matchesBaseline) {
    console.log(`  Production serves the baseline bundle (${short(baseline.sha)}), as expected.`);
  } else {
    console.log('  Production serves a bundle matching neither the baseline nor ' + head.ref + '.');
  }
}

if (inActions && unapplied.length) {
  console.log(`::warning title=Unapplied migrations in production::${unapplied.join(', ')} ` +
    `present on ${head.ref} but not at the last migrated commit ${baseline.sha.slice(0, 7)}. ` +
    `Dispatch "Deploy to production" to apply them.`);
}
if (inActions && code.shippedOutsideWorkflow) {
  console.log('::warning title=Deployed outside the workflow::Production serves this branch\'s bundle, ' +
    'which the deploy workflow never shipped. A second deploy path is active.');
}

process.exit(drift ? 1 : 0);
