import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const server = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0051_sales_process_platform_completion.sql', import.meta.url), 'utf8');
const resolverSource = readFileSync(new URL('../public/js/sales-process.js', import.meta.url), 'utf8');

function browserResolver(process = null) {
  const context = { window: { _gwSalesProcess: process } };
  vm.runInNewContext(resolverSource, context);
  return context.window.GWSalesProcess;
}

test('platform completion migration is additive and company indexed', () => {
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE|RENAME)\b/i);
  for (const table of ['sales_process_company_state', 'sales_migration_snapshots', 'sales_migration_snapshot_items', 'sales_stage_checklist_evidence', 'sales_academy_associations']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /idx_sales_transition_company[\s\S]+company_id/);
  assert.match(migration, /idx_sales_snapshot_items_opportunity[\s\S]+company_id/);
});

test('shared resolver follows assignment, approved mapping, legacy, then restaging order', () => {
  const published = { process: { lifecycle: 'published' }, stages: [{ id: 's1', stable_key: 'intake', semantic_type: 'intake' }] };
  let resolver = browserResolver(published);
  assert.equal(resolver.resolve({ sales_process_stage_id: 's1', status: 'Closed Lost' }).source, 'assignment');
  assert.equal(resolver.resolve({ sales_process_mapping: { review_state: 'approved', final_stage_id: 's1' } }).source, 'approved_mapping');
  assert.equal(resolver.resolve({ status: 'Mystery' }).source, 'needs_restaging');
  assert.equal(resolver.resolve({ status: '' }).source, 'needs_restaging');
  assert.equal(resolver.resolve({ status: 'Presentation & SOW Pitch' }).source, 'needs_restaging');
  resolver = browserResolver(null);
  assert.equal(resolver.resolve({ status: 'Sold / Activation' }).outcome, 'won');
});

test('canonical server resolver is tenant scoped and never reads platform leads', () => {
  const start = server.indexOf('async function resolveSalesOpportunityStage');
  const end = server.indexOf("app.get('/api/sales-process/templates'", start);
  const block = server.slice(start, end);
  assert.ok(block.length > 1000);
  assert.doesNotMatch(block, /gw_leads/);
  assert.match(block, /opportunities WHERE id=\? AND company_id=\?/);
  assert.match(block, /m\.company_id=\? AND m\.opportunity_id=\?/);
  assert.match(block, /resolution: 'needs_restaging'/);
});

test('global blocks, skills, and distinct templates are immutable seeds', () => {
  for (const key of ['lead_intake','contact_attempts','qualification_call','consultation','site_visit','needs_assessment','scope_discovery','estimate_development','proposal_preparation','estimate_presentation','negotiation','decision_follow_up','contract','deposit','won','lost','disqualified','nurture']) assert.match(migration, new RegExp(`'${key}'`));
  for (const template of ['High-Ticket Design-Build','Recurring Maintenance','Fast-Turn Service Sales','Commercial Bid Work']) assert.match(migration, new RegExp(template));
});
