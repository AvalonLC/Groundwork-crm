import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

let app;
let mf;
let db;
const tokens = { admin: 'admin-token', manager: 'manager-token', representative: 'representative-token', foreign: 'foreign-token' };

const schema = `
CREATE TABLE companies (id TEXT PRIMARY KEY, active INTEGER, subscription_status TEXT, trial_expires_at TEXT);
CREATE TABLE reps (id TEXT PRIMARY KEY, company_id TEXT, role TEXT, is_super_admin INTEGER, active INTEGER);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE opportunities (id TEXT PRIMARY KEY, company_id TEXT, client TEXT, status TEXT, pipeline_stage TEXT, sales_process_stage_id TEXT, rep_id TEXT, assigned_to_rep_id TEXT, next_follow_up TEXT, job_value REAL, estimate_amount REAL, estimate_sent_date TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE calendar_events (id TEXT PRIMARY KEY, company_id TEXT, opp_id TEXT, status TEXT, start_at TEXT);
CREATE TABLE estimates (id TEXT PRIMARY KEY, company_id TEXT, opp_id TEXT, status TEXT, sent_at TEXT, updated_at TEXT);
CREATE TABLE sales_processes (id TEXT PRIMARY KEY, company_id TEXT, name TEXT);
CREATE TABLE sales_process_versions (id TEXT PRIMARY KEY, company_id TEXT, process_id TEXT, version_number INTEGER, lifecycle TEXT, validation_json TEXT, published_at TEXT DEFAULT '', published_by TEXT DEFAULT '', updated_at TEXT DEFAULT 'seed');
CREATE TABLE sales_process_stages (id TEXT PRIMARY KEY, company_id TEXT, process_version_id TEXT, stable_key TEXT, display_name TEXT, semantic_type TEXT, display_order INTEGER, state TEXT);
CREATE TABLE sales_stage_outcomes (id TEXT PRIMARY KEY, company_id TEXT, process_version_id TEXT, stage_id TEXT, semantic_type TEXT, active INTEGER);
CREATE TABLE sales_stage_assignments (id TEXT PRIMARY KEY, company_id TEXT, opportunity_id TEXT, process_version_id TEXT, stage_id TEXT, classification TEXT, outcome_type TEXT, assigned_by TEXT, UNIQUE(company_id,opportunity_id,process_version_id));
CREATE TABLE sales_migration_mappings (id TEXT PRIMARY KEY, company_id TEXT, opportunity_id TEXT, migration_batch_id TEXT, previous_stage_id TEXT, previous_label TEXT, proposed_stage_id TEXT, final_stage_id TEXT, proposed_outcome_type TEXT, final_outcome_type TEXT, mapping_method TEXT, mapping_confidence REAL, suggestion_reason TEXT, review_state TEXT, reviewer_id TEXT, reviewed_at TEXT, process_version_id TEXT, rollback_value TEXT, opportunity_updated_at TEXT DEFAULT '', assignment_snapshot TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), UNIQUE(company_id,opportunity_id,migration_batch_id));
CREATE TABLE sales_migration_history (id TEXT PRIMARY KEY, company_id TEXT, migration_batch_id TEXT, opportunity_id TEXT, previous_process_version_id TEXT, new_process_version_id TEXT, previous_stage_id TEXT, previous_label TEXT, new_stage_id TEXT, mapping_id TEXT, actor_id TEXT, event_type TEXT, event_json TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE sales_process_publications (id TEXT PRIMARY KEY, company_id TEXT, process_id TEXT, process_version_id TEXT, previous_version_id TEXT, migration_batch_id TEXT, action TEXT, actor_id TEXT, impact_json TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE activity_log (id TEXT PRIMARY KEY, company_id TEXT);
`;

async function run(sql, ...values) { return db.prepare(sql).bind(...values).run(); }
async function request(token, path, init = {}, envDb = db) {
  const headers = new Headers(init.headers);
  headers.set('cookie', `avalon_session=${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return app.request(`http://test.local${path}`, { ...init, headers }, { DB: envDb });
}
async function body(response) {
  const payload = await response.json();
  return payload.ok === true && Object.hasOwn(payload, 'data') ? payload.data : payload;
}
async function rows(table, company = 'company-a') { return (await db.prepare(`SELECT * FROM ${table} WHERE company_id=? ORDER BY id`).bind(company).all()).results; }
async function opportunityState() { return (await db.prepare('SELECT id,status,pipeline_stage,sales_process_stage_id,rep_id,assigned_to_rep_id FROM opportunities ORDER BY company_id,id').all()).results; }

before(async () => {
  app = (await import('../dist/_worker.js')).default;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: { DB: `migration-review-${Date.now()}` } });
  db = await mf.getD1Database('DB');
  await db.exec(schema);
  await db.batch([
    db.prepare("INSERT INTO companies VALUES ('company-a',1,'active',''),('company-b',1,'active','')"),
    db.prepare("INSERT INTO reps VALUES ('admin-a','company-a','admin',0,1),('manager-a','company-a','office_manager',0,1),('rep-a','company-a','representative',0,1),('admin-b','company-b','admin',0,1)"),
    ...Object.entries(tokens).flatMap(([role, token]) => {
      const rep = role === 'admin' ? 'admin-a' : role === 'manager' ? 'manager-a' : role === 'representative' ? 'rep-a' : 'admin-b';
      const company = role === 'foreign' ? 'company-b' : 'company-a';
      return [db.prepare('INSERT INTO settings VALUES (?,?,datetime(\'now\'))').bind(`session_${token}`, rep), db.prepare('INSERT INTO settings VALUES (?,?,datetime(\'now\'))').bind(`session_company_${token}`, company)];
    }),
    db.prepare("INSERT INTO sales_processes VALUES ('process-a','company-a','A'),('process-b','company-b','B')"),
    db.prepare("INSERT INTO sales_process_versions VALUES ('version-a','company-a','process-a',2,'draft','{\"valid\":true}','','','seed'),('published-a','company-a','process-a',1,'published','{\"valid\":true}','','','seed'),('version-b','company-b','process-b',1,'draft','{\"valid\":true}','','','seed')")
  ]);
  const stageDefs = [['new','new_lead','intake'],['qualify','connect_qualify','active_qualification'],['consult','onsite_consultation','consultation'],['estimate','estimate_development','estimate_development'],['present','estimate_presentation','proposal_presentation'],['decision','decision_pending','decision'],['won','closed','won']];
  for (const company of ['a','b']) for (const [id,key,semantic] of stageDefs) await run('INSERT INTO sales_process_stages VALUES (?,?,?,?,?,?,?,?)', `${company}-${id}`, `company-${company}`, `version-${company}`, key, key, semantic, stageDefs.findIndex(x => x[0] === id), 'active');
  await run("INSERT INTO sales_stage_outcomes VALUES ('outcome-a-won','company-a','version-a','a-won','won',1),('outcome-b-won','company-b','version-b','b-won','won',1)");
  const opportunities = [
    ['deterministic','Lead Intake / Rapport','Lead Intake / Rapport'], ['ambiguous','Presentation & SOW Pitch','Presentation & SOW Pitch'],
    ['conflicting','On Hold','New Lead'], ['unknown','Mystery','Mystery'], ['blank','',''],
    ['terminal','Deal Closed / Won','Deal Closed / Won'], ['nonterminal','On Hold','On Hold']
  ];
  for (const [id,status,pipeline] of opportunities) await run('INSERT INTO opportunities VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, 'company-a', id, status, pipeline, 'legacy-stage', 'rep-a', 'rep-a', '', 100, 0, '', '2026-01-01', `revision-${id}`);
  await run("INSERT INTO opportunities VALUES ('foreign-opp','company-b','foreign','New Lead','New Lead','b-new','admin-b','admin-b','',100,0,'','2026-01-01','foreign-revision')");
  await run("INSERT INTO sales_migration_mappings (id,company_id,opportunity_id,migration_batch_id,mapping_method,mapping_confidence,review_state,process_version_id) VALUES ('foreign-map','company-b','foreign-opp','foreign-batch','seed',1,'approved','version-b')");
});

after(async () => { await mf.dispose(); });

test('authentication owns company scope and role policy', async () => {
  for (const token of [tokens.admin, tokens.manager]) {
    const response = await request(token, '/api/sales-process/migration/propose', { method: 'POST', body: JSON.stringify({ process_version_id: 'version-a', company_id: 'company-b' }) });
    assert.equal(response.status, 200);
  }
  for (const [method,path,payload] of [['POST','/api/sales-process/migration/propose',{process_version_id:'version-a'}],['GET','/api/sales-process/migration/anything'],['PUT','/api/sales-process/migration/x/y',{final_stage_id:'a-new'}],['GET','/api/sales-process/versions/version-a/publication-readiness?migration_batch_id=x'],['POST','/api/sales-process/versions/version-a/publish',{confirm:true}]]) {
    assert.equal((await request(tokens.representative, path, { method, body: method === 'GET' ? undefined : JSON.stringify(payload) })).status, 403);
  }
  assert.equal((await request(tokens.admin, '/api/sales-process/migration/propose', { method: 'POST', body: JSON.stringify({ process_version_id: 'version-b', company_id: 'company-b' }) })).status, 404);
  assert.deepEqual(await body(await request(tokens.admin, '/api/sales-process/migration/foreign-batch?company_id=company-b')), []);
  assert.equal((await request(tokens.admin, '/api/sales-process/versions/version-b/publication-readiness?migration_batch_id=foreign-batch')).status, 404);
});

test('proposal classifies mappings and review is metadata-only and tenant isolated', async () => {
  const baseline = await opportunityState();
  const proposed = await body(await request(tokens.admin, '/api/sales-process/migration/propose', { method: 'POST', body: JSON.stringify({ process_version_id: 'version-a', company_id: 'company-b' }) }));
  const mappings = await body(await request(tokens.manager, `/api/sales-process/migration/${proposed.migration_batch_id}`));
  const byId = Object.fromEntries(mappings.map(mapping => [mapping.opportunity_id, mapping]));
  assert.equal(byId.deterministic.review_state, 'approved');
  assert.equal(byId.deterministic.mapping_method, 'approved_legacy_mapping');
  assert.equal(byId.ambiguous.review_state, 'pending');
  assert.equal(byId.conflicting.mapping_method, 'conflicting_legacy_fields');
  assert.equal(byId.unknown.mapping_method, 'unknown_legacy_label');
  assert.equal(byId.blank.mapping_method, 'unknown_legacy_label');
  assert.equal(byId.terminal.final_outcome_type, 'won');
  assert.equal(byId.nonterminal.final_outcome_type, '');
  assert.equal((await request(tokens.manager, `/api/sales-process/migration/${proposed.migration_batch_id}/unknown`, { method: 'PUT', body: JSON.stringify({ final_stage_id: 'b-new' }) })).status, 400);
  assert.equal((await request(tokens.manager, `/api/sales-process/migration/${proposed.migration_batch_id}/foreign-opp`, { method: 'PUT', body: JSON.stringify({ final_stage_id: 'a-new' }) })).status, 404);
  assert.equal((await request(tokens.manager, `/api/sales-process/migration/${proposed.migration_batch_id}/unknown`, { method: 'PUT', body: JSON.stringify({ final_stage_id: 'a-new', final_outcome_type: '' }) })).status, 200);
  assert.deepEqual(await opportunityState(), baseline);
});

test('readiness rejects pending, stale, cross-tenant, terminal, and nonterminal data', async () => {
  const proposed = await body(await request(tokens.admin, '/api/sales-process/migration/propose', { method: 'POST', body: JSON.stringify({ process_version_id: 'version-a' }) }));
  let readiness = await body(await request(tokens.admin, `/api/sales-process/versions/version-a/publication-readiness?migration_batch_id=${proposed.migration_batch_id}&company_id=company-b`));
  assert.equal(readiness.company_id, 'company-a');
  assert.ok(readiness.issues.some(issue => issue.code === 'mapping_not_approved'));
  await run("UPDATE opportunities SET updated_at='changed' WHERE id='deterministic' AND company_id='company-a'");
  await run("UPDATE sales_migration_mappings SET review_state='approved',final_stage_id='b-new' WHERE opportunity_id='unknown' AND migration_batch_id=?", proposed.migration_batch_id);
  await run("UPDATE sales_migration_mappings SET review_state='approved',final_stage_id='a-new',final_outcome_type='won' WHERE opportunity_id='blank' AND migration_batch_id=?", proposed.migration_batch_id);
  await run("UPDATE sales_migration_mappings SET final_stage_id='a-won',final_outcome_type='' WHERE opportunity_id='terminal' AND migration_batch_id=?", proposed.migration_batch_id);
  readiness = await body(await request(tokens.manager, `/api/sales-process/versions/version-a/publication-readiness?migration_batch_id=${proposed.migration_batch_id}`));
  assert.ok(readiness.issues.some(issue => issue.code === 'stale_mapping'));
  assert.ok(readiness.issues.some(issue => issue.code === 'invalid_stage'));
  assert.ok(readiness.issues.filter(issue => issue.code === 'terminal_outcome_mismatch').length >= 2);
  assert.equal(readiness.ready, false);
});

test('a failed publication batch rolls back every lifecycle and data change', async () => {
  await run("UPDATE opportunities SET updated_at='revision-deterministic' WHERE id='deterministic'");
  const proposed = await body(await request(tokens.admin, '/api/sales-process/migration/propose', { method: 'POST', body: JSON.stringify({ process_version_id: 'version-a' }) }));
  const mappings = await body(await request(tokens.admin, `/api/sales-process/migration/${proposed.migration_batch_id}`));
  for (const mapping of mappings) if (mapping.review_state !== 'approved') {
    const terminal = mapping.opportunity_id === 'terminal';
    await request(tokens.admin, `/api/sales-process/migration/${proposed.migration_batch_id}/${mapping.opportunity_id}`, { method: 'PUT', body: JSON.stringify({ final_stage_id: terminal ? 'a-won' : 'a-new', final_outcome_type: terminal ? 'won' : '' }) });
  }
  const before = { versions: await rows('sales_process_versions'), assignments: await rows('sales_stage_assignments'), opportunities: await opportunityState(), history: await rows('sales_migration_history'), publications: await rows('sales_process_publications') };
  const failingDb = new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (sql) => sql.includes('INSERT INTO sales_process_publications') ? target.prepare('INSERT INTO deliberately_missing_publication_table VALUES (?)') : target.prepare(sql);
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const response = await request(tokens.admin, '/api/sales-process/versions/version-a/publish', { method: 'POST', body: JSON.stringify({ confirm: true, migration_batch_id: proposed.migration_batch_id, company_id: 'company-b' }) }, failingDb);
  assert.equal(response.status, 500);
  const afterState = { versions: await rows('sales_process_versions'), assignments: await rows('sales_stage_assignments'), opportunities: await opportunityState(), history: await rows('sales_migration_history'), publications: await rows('sales_process_publications') };
  assert.deepEqual(afterState, before);
});
