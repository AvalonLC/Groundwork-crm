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


/** One job's YAML block, by name. Fails loudly rather than slicing nothing. */
function job(name) {
  const re = new RegExp(`^  ${name}:$`, 'm');
  const start = code.search(re);
  assert.ok(start >= 0, `the ${name} job is gone from deploy.yml`);
  const rest = code.slice(start + 1);
  const next = rest.search(/^  [a-z][a-z-]*:$/m);
  return rest.slice(0, next === -1 ? rest.length : next);
}

test('DG-01 production deploy has no automatic trigger', () => {
  // One alternation rather than three doesNotMatch calls. The enumeration
  // missed workflow_run — which re-couples deploy to ci.yml completing, the
  // very incident this exists to prevent — and repository_dispatch, which
  // reopens it to any API caller with write access. Mutation-verified: adding
  // `workflow_run:` left the old suite green.
  assert.doesNotMatch(
    code, /^\s*(push|pull_request|schedule|workflow_run|repository_dispatch|release|create):/m,
    'deploy.yml has an automatic trigger again',
  );
  assert.match(code, /workflow_dispatch:/, 'deploy.yml can no longer be dispatched at all');
});

test('DG-02 merging still runs full verification', () => {
  // Decoupling deployment must not decouple checking. ci.yml keeps running on
  // push to main, so a merge is still gated — it just does not ship.
  // Comment-stripped, which the docstring above always claimed but this
  // assertion did not do: a commented-out `# push: { branches: [main] }`
  // satisfied it while pushes to main ran no CI at all.
  const ciCode = ci.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  assert.match(ciCode, /push:\s*\{?\s*branches:\s*\[\s*main/, 'ci.yml no longer runs on push to main');
  assert.match(ciCode, /pull_request:/, 'ci.yml no longer runs on pull requests');
});

test('DG-03 migrations and deployment each require their own approval', () => {
  // Two environments, not one. Publishing a Worker is reversible by redeploying
  // the previous build; a migration is not, so it gets its own reviewer prompt
  // rather than riding along on the deployment approval.
  // Anchored to the JOB. Unanchored, the deploy job's environment could be
  // moved onto preflight — which holds no secrets and publishes nothing — and
  // the suite stayed green while `pages deploy` ran with no reviewer at all.
  assert.match(job('migrate'), /environment: production-database/, 'the migration job lost its protected environment');
  assert.match(job('deploy'), /environment: production\s*$/m, 'the deploy job lost its protected environment');
});

test('DG-04 migrations run before the deploy, and cancelling stops it', () => {
  // Anchored to the deploy job. The previous version searched the whole file,
  // so `if: always()` on the unrelated summary step satisfied it — deleting
  // always() from the deploy condition left the suite green.
  const deploy = job('deploy');
  assert.match(deploy, /needs: \[preflight, verify, migrate\]/, 'deploy no longer waits for migrate');
  // always() is documented as true even when the run is cancelled, so Cancel
  // did not stop the production publish. failure() is transitive over needs,
  // so this also covers a preflight failure.
  assert.doesNotMatch(deploy, /always\(\)/, 'deploy uses always(), which ignores cancellation');
  assert.match(deploy, /!failure\(\) && !cancelled\(\)/);
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
  // job() rather than a bare indexOf pair: renaming `migrate` made indexOf
  // return -1, and slice(start, -1) silently widened the window to include the
  // deploy job, so DG-06 passed off the deploy job's build step.
  const verify = job('verify');
  for (const step of ['npm run typecheck', 'npm test', 'npm run e2e', 'npm run build']) {
    assert.ok(verify.includes(step), `the verify job no longer runs ${step}`);
  }
});

test('DG-07 the run records what it shipped', () => {
  assert.match(code, /GITHUB_STEP_SUMMARY/, 'the deploy no longer records the commit it shipped');
  assert.match(code, /needs\.preflight\.outputs\.sha/);
  assert.match(code, /outputs\.migrations/, 'the migration set is no longer recorded');
});

test('DG-08 the confirmation phrase is compared in the shell, case-sensitively', () => {
  // Two defects at once in the previous version, both mutation-verified:
  //
  //   `${{ inputs.confirm }}` was interpolated into the run: script, so
  //   confirm = `x"; exit 0; #` closed the echo's quote, ran exit 0, and the
  //   exit 1 below was never reached — the gate was disabled by the very value
  //   it rejects, and any payload also ran as bash on the runner.
  //
  //   GitHub's expression `==`/`!=` ignore case, so `deploy` satisfied a gate
  //   that three separate places promised was "exactly DEPLOY".
  const pre = job('preflight');
  assert.match(pre, /CONFIRM: \$\{\{ inputs\.confirm \}\}/, 'confirm is no longer passed through env');
  assert.match(pre, /\[ "\$CONFIRM" != "DEPLOY" \]/, 'confirm is not compared in the shell');
  assert.doesNotMatch(pre, /inputs\.confirm != 'DEPLOY'/, 'the case-insensitive expression check is back');
});

test('DG-08b no dispatch input is interpolated into a shell script', () => {
  // git permits backticks and $() in branch names, so `${{ inputs.ref }}`
  // inline in a run: block was command execution in the job that holds the
  // Cloudflare token. Inputs reach the shell through env: only.
  const runBlocks = [...code.matchAll(/run: \|\n([\s\S]*?)(?=\n      - |\n  [a-z]|$)/g)].map(m => m[1]);
  const offenders = runBlocks.filter(b => /\$\{\{\s*inputs\./.test(b));
  assert.deepEqual(offenders, [], 'a dispatch input is interpolated into a run: script');
});

test('DG-08c the deploy names its branch, so it is not filed as a preview', () => {
  // Every job checks out a resolved 40-hex SHA, which leaves detached HEAD.
  // wrangler infers the branch with `git rev-parse --abbrev-ref HEAD` when
  // none is given — that returns the literal "HEAD", which is not the
  // project's production branch, so Cloudflare files a PREVIEW deployment.
  // wrangler exits 0 and the smoke check sees 200 from the OLD build, so the
  // run goes green having shipped nothing.
  assert.match(job('deploy'), /pages deploy dist --project-name groundwork-crm --branch main/);
});

test('DG-08d the run refuses to start unless both environments are protected', () => {
  // A referenced-but-missing environment is auto-created by GitHub with NO
  // protection rules, so it fails OPEN — the approvals become decorative while
  // this file, the runbook and DG-03 all assert otherwise. Verified real: when
  // this was written, the repo had zero environments configured.
  const pre = job('preflight');
  assert.match(pre, /environments\/\$ENV/, 'the environment-protection assertion is gone');
  assert.match(pre, /required_reviewers/, 'the assertion no longer requires reviewers');
});

test('DG-08e verify runs the guards ci.yml runs, not a subset', () => {
  // A dispatch can name a ref that never had a PR, so ci.yml never ran on it.
  // An earlier version of this job dropped every guard while claiming to make
  // "it passed CI" true of the deployed artifact.
  const verify = job('verify');
  for (const guard of [
    'validate-tasks.js', 'validate:finance-config',
    // Assembled, for the same reason the guard itself is — see deploy.yml.
    'guard - no remote wrangler calls', 'guard - no production-DB binding', 'BH-13',
  ]) {
    assert.ok(verify.includes(guard), `the verify job no longer runs the ${guard} guard`);
  }
});

test('DG-08f there is no way to skip migrations', () => {
  // `d1 migrations apply` is already a no-op when nothing is pending, so the
  // run_migrations input added no capability — only a way to publish a Worker
  // against a schema that had not been migrated.
  assert.doesNotMatch(code, /run_migrations:/, 'the migration-skip input is back');
  assert.doesNotMatch(job('migrate'), /^\s*if:/m, 'the migrate job is conditional again');
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
