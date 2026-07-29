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

test('semantic reporting is invariant to renamed stages and excludes restaging from stage metrics', () => {
  const definition = {
    process: { lifecycle: 'published' },
    stages: [
      { id: 'stage-open', display_name: 'Completely Renamed Open Stage', semantic_type: 'active_qualification' },
      { id: 'stage-proposal', display_name: 'Custom Review Conversation', semantic_type: 'proposal_presentation' },
      { id: 'stage-closed', display_name: 'Finished', semantic_type: 'terminal' }
    ],
    assignments: [
      { opportunity_id: 'open', stage_id: 'stage-open', outcome_type: '' },
      { opportunity_id: 'proposal', stage_id: 'stage-proposal', outcome_type: '' },
      { opportunity_id: 'won', stage_id: 'stage-closed', outcome_type: 'won' },
      { opportunity_id: 'lost', stage_id: 'stage-closed', outcome_type: 'lost' }
    ]
  };
  const resolver = browserResolver(definition);
  const opportunities = [{ id: 'open', status: 'Closed Lost' }, { id: 'proposal', status: 'Mystery' }, { id: 'won', status: 'New Lead' }, { id: 'lost', status: 'Sold / Activation' }, { id: 'restage', status: 'Unknown' }];
  assert.deepEqual(opportunities.filter(resolver.isWon).map(item => item.id), ['won']);
  assert.deepEqual(opportunities.filter(resolver.isLost).map(item => item.id), ['lost']);
  assert.deepEqual(opportunities.filter(resolver.isProposal).map(item => item.id), ['proposal']);
  assert.deepEqual(opportunities.filter(resolver.includedInStageMetrics).map(item => item.id), ['open','proposal','won','lost']);
  assert.equal(resolver.isOverallOpen(opportunities.at(-1)), true);
  assert.equal(resolver.needsRestaging(opportunities.at(-1)), true);
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

test('authenticated bootstrap hydrates the active semantic process with company-scoped assignments', () => {
  const start = server.indexOf("app.get('/api/auth/bootstrap'");
  const end = server.indexOf('// ══════════════════════════════════════════════════════════════════════════════', start);
  const block = server.slice(start, end);
  assert.match(block, /sales_process_company_state/);
  assert.match(block, /sales_stage_assignments WHERE company_id=\? AND process_version_id=\?/);
  assert.match(block, /sales_migration_mappings WHERE company_id=\? AND process_version_id=\? AND review_state='approved'/);
  assert.match(server, /window\._gwSalesProcess\s+=\s+bs\.data\.salesProcess \|\| null/);
  assert.doesNotMatch(block, /gw_leads/);
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
  assert.match(block, /internalStatusIdByTemplateId\.get\(association\.internal_status_id\)/);
  assert.match(block, /remapStructuredJson/);
  assert.match(block, /INSERT INTO sales_academy_associations/);
  assert.doesNotMatch(block, /`\$\{versionId\}_closed`/);
});

test('stable transition handler enforces evidence confirmation and normalized paths', () => {
  const start = server.indexOf("app.on(['PUT', 'POST'], ['/api/opportunities/:id/sales-stage'");
  const end = server.indexOf('// ══════════════════════════════════════════════════════════════════════════════', start);
  const block = server.slice(start, end);
  assert.ok(block.length > 5000);
  assert.match(block, /body\.confirm !== true/);
  assert.match(block, /sales_stage_checklist_evidence/);
  assert.match(block, /FROM estimates WHERE company_id=\? AND opp_id=\?/);
  assert.match(block, /FROM calendar_events WHERE company_id=\? AND opp_id=\?/);
  assert.match(block, /normalizedPathCount/);
  assert.match(block, /Number\(normalizedPathCount\?\.n \|\| 0\) === 0/);
  assert.match(block, /missing = \{ required:/);
  assert.match(block, /manager_review/);
  assert.match(block, /pathRequiresManager/);
  assert.match(block, /manager_required/);
  assert.match(block, /typeof value === 'boolean' \? value/);
  assert.match(block, /status=\?,pipeline_stage=\?/);
  assert.doesNotMatch(block, /gw_leads/);
});

test('published sales context is company scoped and exposes the full Stage Guide read model', () => {
  const start = server.indexOf("app.get('/api/opportunities/:id/sales-context'");
  const end = server.indexOf('// Stable transitions update only normalized assignments.', start);
  const block = server.slice(start, end);
  assert.ok(block.length > 5000);
  assert.match(block, /SELECT \* FROM opportunities WHERE id=\? AND company_id=\?/);
  for (const table of ['sales_stage_requirements', 'sales_stage_guides', 'sales_process_resources', 'sales_stage_transition_paths', 'sales_stage_internal_statuses', 'sales_stage_checklist_evidence', 'sales_academy_associations', 'sales_academy_company_content']) {
    assert.match(block, new RegExp(table));
  }
  assert.match(block, /requirement_groups/);
  assert.match(block, /missing_required/);
  assert.match(block, /known_data/);
  assert.match(block, /missing_information/);
  assert.match(block, /days_in_stage/);
  assert.doesNotMatch(block, /gw_leads/);
});

test('Stage Guide and Call Companion use published content and explicit confirmations', () => {
  const client = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');
  const guideStart = client.indexOf('window.gwLoadStageGuide');
  const guideEnd = client.indexOf('function opportunityDetail', guideStart);
  const guide = client.slice(guideStart, guideEnd);
  assert.match(guide, /DB\.salesProcess\.context/);
  assert.match(guide, /requirement_groups/);
  assert.match(guide, /Allowed destinations/);
  assert.match(guide, /DB\.salesProcess\.transition/);
  assert.match(guide, /if \(!confirm\(/);
  assert.doesNotMatch(guide, /setOppField\([^)]*status/);

  const companionStart = client.indexOf('window.openCallCompanion');
  const companionEnd = client.indexOf('// ── Call Companion: shared prompt', companionStart);
  const companion = client.slice(companionStart, companionEnd);
  assert.match(companion, /normalizedConfig\.sections/);
  assert.match(companion, /Required capture fields/);
  assert.match(companion, /Warning signs/);
  assert.match(companion, /Completion guidance/);
  assert.match(companion, /Nothing will be sent, scheduled, created, or transitioned/);
  assert.match(companion, /Save this reviewed transcript/);
  assert.match(companion, /Save this reviewed draft as an opportunity note/);
});

test('published Academy playbook separates immutable core skills from tenant content in process order', () => {
  const start = server.indexOf("app.get('/api/academy/playbook'");
  const end = server.indexOf('// Copy-on-adopt guarantees', start);
  const block = server.slice(start, end);
  assert.ok(block.length > 2500);
  assert.match(block, /WHERE cs\.company_id=\?/);
  assert.match(block, /company_id='__global__' AND is_global=1 AND active=1/);
  assert.match(block, /sales_academy_associations/);
  assert.match(block, /sales_academy_company_content c[\s\S]+WHERE c\.company_id=\? AND c\.process_version_id=\?/);
  assert.match(block, /ORDER BY display_order/);
  assert.match(block, /manager_only/);
  assert.doesNotMatch(block, /gw_leads/);
  assert.doesNotMatch(block, /UPDATE|DELETE|INSERT/);
});

test('Academy landing renders core library and company playbook without mutating global content', () => {
  const client = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');
  const start = client.indexOf('async function academyHome');
  const end = client.indexOf('function academyPhaseDetail', start);
  const block = client.slice(start, end);
  assert.match(block, /DB\.academyPlaybook\.get\(\)/);
  assert.match(block, /Groundwork Core Skill Library/);
  assert.match(block, /Company Playbook/);
  assert.match(block, /publishedPlaybook\.stages/);
  assert.doesNotMatch(block, /sales_academy_skills.*(?:PUT|POST|DELETE)/i);
});
