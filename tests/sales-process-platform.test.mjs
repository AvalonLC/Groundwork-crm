import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const server = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0051_sales_process_platform_completion.sql', import.meta.url), 'utf8');
const resolverSource = readFileSync(new URL('../public/js/sales-process.js', import.meta.url), 'utf8');
const migrationsDirectory = new URL('../migrations/', import.meta.url);

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

test('every immutable catalog template has a usable stage outcome and transition graph', () => {
  const directory = mkdtempSync(join(tmpdir(), 'groundwork-template-catalog-'));
  const database = join(directory, 'catalog.sqlite');
  try {
    for (const name of readdirSync(migrationsDirectory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      execFileSync('sqlite3', ['-bail', database], { input: readFileSync(new URL(name, migrationsDirectory)) });
    }
    const rows = execFileSync('sqlite3', ['-json', database, `
      SELECT v.id,
        (SELECT COUNT(*) FROM sales_process_stages s WHERE s.company_id=v.company_id AND s.process_version_id=v.id) AS stages,
        (SELECT COUNT(*) FROM sales_stage_outcomes o WHERE o.company_id=v.company_id AND o.process_version_id=v.id) AS outcomes,
        (SELECT COUNT(*) FROM sales_stage_transition_paths t WHERE t.company_id=v.company_id AND t.process_version_id=v.id) AS transitions
      FROM sales_process_versions v JOIN sales_processes p ON p.id=v.process_id AND p.company_id=v.company_id
      WHERE v.company_id='__global__' AND p.is_template=1
        AND v.id IN ('tpl_groundwork_field_service_v2','tpl_design_build_v1','tpl_maintenance_v1','tpl_fast_turn_v1','tpl_commercial_bid_v1')
      ORDER BY v.id;
    `], { encoding: 'utf8' });
    const templates = JSON.parse(rows);
    assert.equal(templates.length, 5);
    for (const template of templates) {
      assert.ok(template.stages >= 5, `${template.id} lacks a meaningful stage graph`);
      assert.ok(template.outcomes >= 2, `${template.id} lacks terminal outcomes`);
      assert.ok(template.transitions >= 4, `${template.id} lacks configured transitions`);
    }
    const groundwork = templates.find(template => template.id === 'tpl_groundwork_field_service_v2');
    assert.equal(groundwork.stages, 7);
    assert.ok(groundwork.transitions >= 15);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('template adoption remaps outcomes transitions and academy associations', () => {
  const start = server.indexOf("app.post('/api/sales-process/drafts/from-template'");
  const end = server.indexOf("app.put('/api/sales-process/drafts/:versionId/stages'", start);
  const block = server.slice(start, end);
  assert.match(block, /stageIdByTemplateId\.get\(outcome\.stage_id\)/);
  assert.match(block, /stageIdByTemplateId\.get\(transition\.from_stage_id\)/);
  assert.match(block, /stageIdByTemplateId\.get\(transition\.to_stage_id\)/);
  assert.match(block, /INSERT INTO sales_academy_associations/);
  assert.doesNotMatch(block, /`\$\{versionId\}_closed`/);
});
