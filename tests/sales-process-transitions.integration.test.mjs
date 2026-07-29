import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

let app;
let mf;
let db;
const tokens = { rep: 'transition-rep', manager: 'transition-manager', foreign: 'transition-foreign' };

const schema = `
CREATE TABLE companies (id TEXT PRIMARY KEY, active INTEGER, subscription_status TEXT, trial_expires_at TEXT);
CREATE TABLE reps (id TEXT PRIMARY KEY, company_id TEXT, role TEXT, is_super_admin INTEGER, active INTEGER);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE opportunities (id TEXT PRIMARY KEY, company_id TEXT, client TEXT, status TEXT, pipeline_stage TEXT, sales_process_stage_id TEXT, rep_id TEXT, assigned_to_rep_id TEXT, project TEXT, email TEXT, phone TEXT, address TEXT, next_action TEXT, next_action_date TEXT, next_follow_up TEXT, lost_reason TEXT, job_value REAL, updated_at TEXT);
CREATE TABLE sales_processes (id TEXT PRIMARY KEY, company_id TEXT, name TEXT);
CREATE TABLE sales_process_versions (id TEXT PRIMARY KEY, company_id TEXT, process_id TEXT, version_number INTEGER, lifecycle TEXT);
CREATE TABLE sales_process_stages (id TEXT PRIMARY KEY, company_id TEXT, process_version_id TEXT, stable_key TEXT, display_name TEXT, board_label TEXT, description TEXT, customer_milestone TEXT, semantic_type TEXT, display_order INTEGER, state TEXT, expected_duration_days INTEGER, entry_guidance TEXT, exit_guidance TEXT, manager_override_policy TEXT);
CREATE TABLE sales_stage_outcomes (id TEXT PRIMARY KEY, company_id TEXT, process_version_id TEXT, stage_id TEXT, stable_key TEXT, display_name TEXT, semantic_type TEXT, active INTEGER, config_json TEXT);
CREATE TABLE sales_stage_assignments (id TEXT PRIMARY KEY, company_id TEXT, opportunity_id TEXT, process_version_id TEXT, stage_id TEXT, classification TEXT, outcome_type TEXT, internal_status_id TEXT, assigned_at TEXT, assigned_by TEXT, UNIQUE(company_id,opportunity_id,process_version_id));
CREATE TABLE sales_stage_transition_paths (id TEXT PRIMARY KEY, company_id TEXT, process_version_id TEXT, from_stage_id TEXT, to_stage_id TEXT, outcome_type TEXT, display_label TEXT, guidance TEXT, active INTEGER, display_order INTEGER, requires_override INTEGER, override_policy TEXT, created_by TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE sales_stage_transitions (id TEXT PRIMARY KEY, company_id TEXT, process_version_id TEXT, from_stage_id TEXT, to_stage_id TEXT, requires_override INTEGER, active INTEGER);
CREATE TABLE sales_stage_transition_events (id TEXT PRIMARY KEY, company_id TEXT, opportunity_id TEXT, process_version_id TEXT, from_stage_id TEXT, to_stage_id TEXT, outcome_type TEXT, actor_id TEXT, override_reason TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE sales_stage_requirements (id TEXT PRIMARY KEY, company_id TEXT, process_version_id TEXT, stage_id TEXT, requirement_type TEXT, stable_key TEXT, label TEXT, description TEXT, required_level TEXT, display_order INTEGER, config_json TEXT);
CREATE TABLE sales_stage_checklist_evidence (id TEXT PRIMARY KEY, company_id TEXT, opportunity_id TEXT, process_version_id TEXT, stage_id TEXT, requirement_id TEXT, completed INTEGER, evidence_json TEXT);
CREATE TABLE estimates (id TEXT PRIMARY KEY, company_id TEXT, opp_id TEXT, status TEXT, total REAL, amount REAL, updated_at TEXT);
CREATE TABLE calendar_events (id TEXT PRIMARY KEY, company_id TEXT, opp_id TEXT, status TEXT, start_at TEXT);
CREATE TABLE tasks (id TEXT PRIMARY KEY, company_id TEXT, linked_record_type TEXT, linked_record_id TEXT, title TEXT, due_date TEXT);
CREATE TABLE activity_log (id TEXT PRIMARY KEY, company_id TEXT, actor_id TEXT, actor_name TEXT, entity_type TEXT, entity_id TEXT, entity_label TEXT, action TEXT, before_json TEXT, after_json TEXT, created_at TEXT DEFAULT (datetime('now')));
`;

async function run(sql, ...values) { return db.prepare(sql).bind(...values).run(); }
async function request(token, opportunityId, payload) {
  return app.request(`http://test.local/api/opportunities/${opportunityId}/stage-transition`, {
    method: 'POST', headers: { cookie: `avalon_session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload)
  }, { DB: db });
}
async function data(response) {
  const value = await response.json();
  return value.ok === true && Object.hasOwn(value, 'data') ? value.data : value;
}
async function assignment(company = 'company-a', opportunity = 'opp-a') {
  return db.prepare('SELECT * FROM sales_stage_assignments WHERE company_id=? AND opportunity_id=?').bind(company, opportunity).first();
}
async function reset(stage = 'a-intake') {
  await run("UPDATE sales_stage_assignments SET stage_id=?,outcome_type='',classification='mapped' WHERE company_id='company-a' AND opportunity_id='opp-a'", stage);
  await run("UPDATE opportunities SET sales_process_stage_id=?,status='Legacy',pipeline_stage='Legacy',project='',email='',phone='',address='',next_action='',next_action_date='',lost_reason='',job_value=0 WHERE id='opp-a' AND company_id='company-a'", stage);
  await run("DELETE FROM sales_stage_checklist_evidence WHERE company_id='company-a'");
  await run("DELETE FROM sales_stage_transition_events WHERE company_id='company-a'");
  await run("DELETE FROM activity_log WHERE company_id='company-a'");
  await run("DELETE FROM estimates WHERE company_id='company-a'");
  await run("DELETE FROM calendar_events WHERE company_id='company-a'");
  await run("DELETE FROM tasks WHERE company_id='company-a'");
}

before(async () => {
  app = (await import('../dist/_worker.js')).default;
  mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', d1Databases: { DB: `transition-${Date.now()}` } });
  db = await mf.getD1Database('DB');
  await db.exec(schema);
  await db.batch([
    db.prepare("INSERT INTO companies VALUES ('company-a',1,'active',''),('company-b',1,'active','')"),
    db.prepare("INSERT INTO reps VALUES ('rep-a','company-a','rep',0,1),('manager-a','company-a','office_manager',0,1),('manager-b','company-b','admin',0,1)"),
    db.prepare("INSERT INTO settings VALUES ('session_transition-rep','rep-a',datetime('now')),('session_company_transition-rep','company-a',datetime('now')),('session_transition-manager','manager-a',datetime('now')),('session_company_transition-manager','company-a',datetime('now')),('session_transition-foreign','manager-b',datetime('now')),('session_company_transition-foreign','company-b',datetime('now'))"),
    db.prepare("INSERT INTO sales_processes VALUES ('process-a','company-a','Process A'),('process-b','company-b','Process B')"),
    db.prepare("INSERT INTO sales_process_versions VALUES ('version-a','company-a','process-a',1,'published'),('version-b','company-b','process-b',1,'published')")
  ]);
  const stages = [
    ['a-intake','company-a','version-a','intake','New Lead','intake',1,'allowed_with_reason'],
    ['a-qualify','company-a','version-a','qualify','Connect and Qualify','active_qualification',2,'allowed_with_reason'],
    ['a-consult','company-a','version-a','consult','Consultation','consultation',3,'allowed_with_reason'],
    ['a-present','company-a','version-a','present','Presentation','proposal_presentation',4,'allowed_with_reason'],
    ['a-closed','company-a','version-a','closed','Closed','terminal',5,'allowed_with_reason'],
    ['a-nurture','company-a','version-a','nurture','Long-Term Nurture','nurture',6,'allowed_with_reason'],
    ['a-disqualified','company-a','version-a','disqualified','Disqualified','disqualified',7,'allowed_with_reason'],
    ['b-intake','company-b','version-b','intake','Foreign Intake','intake',1,'allowed_with_reason']
  ];
  for (const [id,company,version,key,name,semantic,order,policy] of stages) await run("INSERT INTO sales_process_stages VALUES (?,?,?,?,?,'', '', '',?,?, 'active',0,'','',?)", id, company, version, key, name, semantic, order, policy);
  await run("INSERT INTO opportunities VALUES ('opp-a','company-a','A','Legacy','Legacy','a-intake','rep-a','rep-a','','','','','','','','',0,'seed'),('opp-b','company-b','B','Legacy','Legacy','b-intake','manager-b','manager-b','','','','','','','','',0,'seed')");
  await run("INSERT INTO sales_stage_assignments VALUES ('assignment-a','company-a','opp-a','version-a','a-intake','mapped','','',datetime('now'),'rep-a'),('assignment-b','company-b','opp-b','version-b','b-intake','mapped','','',datetime('now'),'manager-b')");
  const paths = [
    ['forward','a-intake','a-qualify','',0,'allowed_with_reason'], ['reverse','a-qualify','a-intake','',0,'allowed_with_reason'],
    ['branch','a-qualify','a-consult','',0,'allowed_with_reason'], ['revision','a-present','a-qualify','',0,'allowed_with_reason'],
    ['won','a-present','a-closed','won',0,'allowed_with_reason'], ['lost','a-present','a-closed','lost',0,'allowed_with_reason'],
    ['nurture','a-qualify','a-nurture','nurture',1,'manager_required'], ['disqualified','a-qualify','a-disqualified','disqualified',0,'allowed_with_reason']
  ];
  for (const [id,from,to,outcome,override,policy] of paths) await run("INSERT INTO sales_stage_transition_paths VALUES (?, 'company-a','version-a',?,?,?,?, '',1,1,?,?, 'seed','seed',datetime('now'),datetime('now'))", `path-${id}`, from, to, outcome, id, override, policy);
  await run("INSERT INTO sales_stage_outcomes VALUES ('won','company-a','version-a','a-closed','won','Won','won',1,'{\"required\":[\"final_value\"]}'),('lost','company-a','version-a','a-closed','lost','Lost','lost',1,'{\"required\":[\"lost_reason\"]}'),('nurture','company-a','version-a','a-nurture','nurture','Nurture','nurture',1,'{}'),('disqualified','company-a','version-a','a-disqualified','disqualified','Disqualified','disqualified',1,'{}')");
  await run("INSERT INTO sales_stage_requirements VALUES ('req-service','company-a','version-a','a-intake','field','service_requested','Service requested','','required',1,'{\"phase\":\"exit\"}'),('req-contact','company-a','version-a','a-consult','checklist','contact_confirmed','Contact confirmed','','required',1,'{\"phase\":\"entry\"}'),('req-estimate','company-a','version-a','a-consult','evidence','estimate_ready','Estimate ready','','required',2,'{\"phase\":\"entry\"}'),('req-walk','company-a','version-a','a-consult','evidence','completed_walkthrough','Walkthrough complete','','required',3,'{\"phase\":\"entry\"}'),('req-next','company-a','version-a','a-consult','field','next_action','Next action','','required',4,'{\"phase\":\"entry\"}'),('req-next-date','company-a','version-a','a-consult','field','next_action_date','Next action date','','required',5,'{\"phase\":\"entry\"}'),('req-coaching','company-a','version-a','a-consult','coaching','consultation_coaching','Consultation coaching','','optional',6,'{\"phase\":\"general\"}')");
});
after(async () => { await mf.dispose(); });
beforeEach(async () => { await reset(); });

test('requires confirmation, current stable assignment, and company-owned destinations', async () => {
  assert.equal((await request(tokens.rep, 'opp-a', { stage_id: 'a-qualify', expected_stage_id: 'a-intake' })).status, 400);
  assert.equal((await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-qualify', expected_stage_id:'stale' })).status, 409);
  assert.equal((await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'b-intake', expected_stage_id:'a-intake' })).status, 400);
  assert.equal((await request(tokens.foreign, 'opp-a', { confirm:true, stage_id:'a-qualify', expected_stage_id:'a-intake' })).status, 409);
});

test('evaluates exit and entry evidence and returns structured missing requirements', async () => {
  let response = await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-qualify', expected_stage_id:'a-intake' });
  assert.equal(response.status, 403);
  let payload = await data(response);
  assert.equal(payload.missing.required[0].stable_key, 'service_requested');
  await run("UPDATE opportunities SET project='Landscape renovation' WHERE id='opp-a' AND company_id='company-a'");
  assert.equal((await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-qualify', expected_stage_id:'a-intake' })).status, 200);
  response = await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-consult', expected_stage_id:'a-qualify' });
  assert.equal(response.status, 403);
  payload = await data(response);
  assert.equal(payload.missing.required[0].stable_key, 'contact_confirmed');
  assert.deepEqual(new Set(payload.missing.required.map(item => item.stable_key)), new Set(['contact_confirmed','estimate_ready','completed_walkthrough','next_action','next_action_date']));
  await run("INSERT INTO sales_stage_checklist_evidence VALUES ('evidence-contact','company-a','opp-a','version-a','a-consult','req-contact',1,'{}')");
  await run("INSERT INTO estimates VALUES ('estimate-a','company-a','opp-a','ready',12000,12000,datetime('now'))");
  await run("INSERT INTO calendar_events VALUES ('visit-a','company-a','opp-a','completed','2026-07-01')");
  await run("INSERT INTO tasks VALUES ('task-a','company-a','lead','opp-a','Confirm consultation','2026-07-30')");
  const completed = await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-consult', expected_stage_id:'a-qualify' });
  assert.equal(completed.status, 200);
});

test('supports reverse, branching, revision, Disqualified, and Nurture paths without assuming sequence', async () => {
  await reset('a-qualify');
  assert.equal((await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-intake', expected_stage_id:'a-qualify' })).status, 200);
  await reset('a-qualify');
  assert.equal((await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-disqualified', expected_stage_id:'a-qualify', outcome_type:'disqualified' })).status, 200);
  await reset('a-present');
  assert.equal((await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-qualify', expected_stage_id:'a-present' })).status, 200);
  await reset('a-qualify');
  let response = await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-nurture', expected_stage_id:'a-qualify', outcome_type:'nurture', override_reason:'Approved long-term delay' });
  assert.equal(response.status, 403);
  assert.equal((await data(response)).override.manager_required, true);
  response = await request(tokens.manager, 'opp-a', { confirm:true, stage_id:'a-nurture', expected_stage_id:'a-qualify', outcome_type:'nurture' });
  assert.equal(response.status, 400);
  assert.equal((await request(tokens.manager, 'opp-a', { confirm:true, stage_id:'a-nurture', expected_stage_id:'a-qualify', outcome_type:'nurture', override_reason:'Manager approved nurture plan' })).status, 200);
});

test('enforces configured terminal outcome evidence and preserves compatibility semantics', async () => {
  await reset('a-present');
  let response = await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-closed', expected_stage_id:'a-present', outcome_type:'won' });
  assert.equal(response.status, 403);
  assert.equal((await data(response)).missing.required[0].stable_key, 'final_value');
  response = await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-closed', expected_stage_id:'a-present', outcome_type:'won', evidence:{ final_value:12500 } });
  assert.equal(response.status, 200);
  let opportunity = await db.prepare("SELECT * FROM opportunities WHERE id='opp-a'").first();
  assert.equal(opportunity.status, 'Won');
  assert.equal(opportunity.pipeline_stage, 'Won');
  assert.equal((await assignment()).outcome_type, 'won');
  await reset('a-present');
  assert.equal((await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-closed', expected_stage_id:'a-present', outcome_type:'lost', evidence:{ lost_reason:'Price' } })).status, 200);
  opportunity = await db.prepare("SELECT * FROM opportunities WHERE id='opp-a'").first();
  assert.equal(opportunity.status, 'Lost');
});

test('writes one append-only transition event and one activity audit per successful transition', async () => {
  await run("UPDATE opportunities SET project='Maintenance' WHERE id='opp-a'");
  const response = await request(tokens.rep, 'opp-a', { confirm:true, stage_id:'a-qualify', expected_stage_id:'a-intake' });
  assert.equal(response.status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sales_stage_transition_events WHERE company_id='company-a' AND opportunity_id='opp-a'").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE company_id='company-a' AND entity_id='opp-a' AND action='sales_stage_transitioned'").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sales_stage_transition_events WHERE company_id='company-b'").first()).n, 0);
});
