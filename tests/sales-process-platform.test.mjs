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
const recordPageSource = readFileSync(new URL('../public/js/record-page.js', import.meta.url), 'utf8');
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

test('semantic metrics are rename invariant and exclude Needs Restaging from stage calculations', () => {
  const definition = { process: { lifecycle: 'published' }, stages: [
    { id: 'intake', display_name: 'Any intake name', semantic_type: 'intake', expected_duration_days: 2 },
    { id: 'present', display_name: 'Customer review', semantic_type: 'proposal_presentation', expected_duration_days: 5 },
    { id: 'closed', display_name: 'Finished', semantic_type: 'terminal' }
  ] };
  const resolver = browserResolver(definition);
  const opportunities = [
    { id:'a', sales_process_stage_id:'intake', job_value:100, updated_at:'2020-01-01' },
    { id:'b', sales_process_stage_id:'present', job_value:200 },
    { id:'c', sales_process_stage_id:'closed', sales_process_assignment:{stage_id:'closed',outcome_type:'won'}, job_value:300 },
    { id:'d', sales_process_stage_id:'closed', sales_process_assignment:{stage_id:'closed',outcome_type:'lost'}, job_value:400 },
    { id:'e', status:'Proposal / Estimate Sent', job_value:500 }
  ];
  const before = resolver.summarize(opportunities, { definition });
  definition.stages.forEach(stage => { stage.display_name = `Renamed ${stage.id}`; });
  const after = resolver.summarize(opportunities, { definition });
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
  assert.deepEqual(JSON.parse(JSON.stringify(before)), { total:5,totalValue:1500,needsRestaging:1,open:3,won:1,lost:1,wonValue:300,proposal:1,presentation:1,closeRate:.5,forecast:150,stageEligible:4 });
  assert.equal(resolver.isStagnant(opportunities[0], Date.parse('2020-01-10')), true);
  assert.equal(resolver.isStagnant(opportunities[4], Date.parse('2020-01-10')), false);
  assert.equal(resolver.forecastProbability(opportunities[0]), .1);
  assert.equal(resolver.forecastProbability(opportunities[4]), 0);
  assert.equal(resolver.hasOpenEstimate({...opportunities[1], estimate_status:'sent'}), true);
  assert.equal(resolver.hasOpenEstimate({...opportunities[4], estimate_status:'sent'}), false);
  assert.equal(resolver.didEnterOutcome(opportunities[1], opportunities[2], 'won'), true);
  assert.equal(resolver.didEnterOutcome(opportunities[2], opportunities[2], 'won'), false);
});

test('reporting and financial consumers use normalized semantics instead of operational labels', () => {
  const frontend = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');
  const reportStart = frontend.indexOf('function salesReports()');
  const reportEnd = frontend.indexOf('\nfunction ', reportStart + 20);
  const report = frontend.slice(reportStart, reportEnd > reportStart ? reportEnd : undefined);
  assert.match(report, /GWSalesProcess\.isWon/);
  assert.match(report, /GWSalesProcess\.isProposal/);
  assert.doesNotMatch(report, /WON_STATUSES|LOST_STATUSES|Proposal \/ Estimate Sent|Presentation & SOW Pitch/);

  const divisionStart = frontend.indexOf('function buildDivisionPipeline()');
  const divisionEnd = frontend.indexOf('\nfunction ', divisionStart + 20);
  const division = frontend.slice(divisionStart, divisionEnd > divisionStart ? divisionEnd : undefined);
  assert.match(division, /GWSalesProcess\.forecastProbability/);
  assert.match(division, /GWSalesProcess\.hasOpenEstimate/);
  assert.doesNotMatch(division, /POTS_STAGES|STAGE_WIN_PROB/);
});

test('Builder preview renders lifecycle impact gates and responsive surfaces', () => {
  const frontend = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/js/premium.css', import.meta.url), 'utf8');
  const start = frontend.indexOf('window.gwPreviewSalesProcess=');
  const end = frontend.indexOf('window.gwAdoptGroundworkTemplate=', start);
  const block = frontend.slice(start, end);
  for (const label of ['Opportunities affected','Value affected','Automatic mappings','Manual mappings','Unknown mappings','Sample transitions','Preview surfaces','Impact changes']) assert.match(block, new RegExp(label));
  assert.match(block, /DB\.salesProcess\.readiness/);
  assert.match(block, /gwPublishSalesProcess/);
  assert.match(block, /previous active version was preserved/);
  assert.match(frontend, /Needs review - select a stage/);
  assert.match(frontend, /Select a reviewed stage before approving this opportunity/);
  assert.match(css, /spb-preview-grid/);
  assert.match(css, /@media\(max-width:768px\)[^{]*\{[^}]*\.spb-preview-grid|@media\(max-width:768px\)\{\.spb-preview-heading/);
});

test('StageTracker follows published stage IDs and renamed display order', () => {
  const definition = { process:{ lifecycle:'published' }, stages:[
    { id:'renamed-intake', display_name:'Welcome', semantic_type:'intake', state:'active', stage_order:1 },
    { id:'renamed-review', display_name:'Scope Review', semantic_type:'proposal_presentation', state:'active', stage_order:2 },
    { id:'renamed-terminal', display_name:'Finished', semantic_type:'terminal', state:'active', stage_order:3 }
  ] };
  const context = { window:{ _gwSalesProcess:definition }, document:{ addEventListener(){}, querySelectorAll(){ return []; } } };
  vm.runInNewContext(resolverSource, context);
  vm.runInNewContext(recordPageSource, context);
  const html = context.window.GW.record.StageTracker(['Old Intake','Old Proposal'], { sales_process_stage_id:'renamed-review' });
  assert.match(html, /Welcome/);
  assert.match(html, /Scope Review/);
  assert.match(html, /is-current/);
  assert.doesNotMatch(html, /Old Intake|Old Proposal|Finished/);
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
