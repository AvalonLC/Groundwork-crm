import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0049_sales_process_runtime_safeguards.sql', import.meta.url), 'utf8');
const migrationReview = readFileSync(new URL('../migrations/0050_sales_process_migration_review.sql', import.meta.url), 'utf8');
const frontend = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');

test('sales-process runtime never accesses platform leads', () => {
  const block = server.slice(server.indexOf('VERSIONED SALES PROCESS'), server.indexOf('NAV PERMISSIONS'));
  assert.ok(block.length > 1000);
  assert.doesNotMatch(block, /\b(?:FROM|JOIN|UPDATE|INTO)\s+gw_leads\b/i);
});

test('tenant data reads and writes retain company scope', () => {
  assert.match(server, /WHERE a\.company_id=\? AND a\.opportunity_id=\?/);
  assert.match(server, /opportunities WHERE id=\? AND company_id=\?/);
  assert.match(server, /sales_process_stages WHERE company_id=\? AND process_version_id=\?/);
});

test('runtime safeguards are additive and preserve prior migrations', () => {
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(migration, /ALTER\s+TABLE/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sales_stage_transition_events/);
});

test('migration review schema changes are additive columns only', () => {
  assert.doesNotMatch(migrationReview, /\b(?:DROP|TRUNCATE|RENAME)\b/i);
  const operations = migrationReview.match(/ALTER\s+TABLE[^;]+;/gi) || [];
  assert.equal(operations.length, 2);
  operations.forEach(operation => assert.match(operation, /^ALTER\s+TABLE\s+sales_migration_mappings\s+ADD\s+COLUMN\b/i));
});

test('migration proposals snapshot assignments and readiness rejects assignment drift', () => {
  assert.match(server, /assignment_snapshot\)/);
  assert.match(server, /code: 'stale_assignment'/);
  assert.match(server, /sales_stage_assignments WHERE company_id=\?/);
});

test('unknown labels remain in Needs Restaging', () => {
  assert.match(frontend, /status:'Needs Restaging'/);
  assert.match(frontend, /!knownStatuses\.has\(o\.status\)/);
});

test('stable transitions reject stale writes and validate configured outcomes', () => {
  assert.match(server, /expectedStageId !== String\(assignment\.stage_id/);
  assert.match(server, /sales_process_stage_id=\?/);
  assert.match(server, /SELECT id FROM sales_stage_outcomes/);
  assert.match(server, /company_id=\? AND process_version_id=\? AND stage_id=\? AND semantic_type=\?/);
});
