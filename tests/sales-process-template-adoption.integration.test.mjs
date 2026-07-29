import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';

let app, mf, db, adoptedVersion;
const templates = ['tpl_groundwork_field_service_v1','tpl_groundwork_field_service_v2','tpl_design_build_v1','tpl_maintenance_v1','tpl_fast_turn_v1','tpl_commercial_bid_v1'];
const copyTables = ['sales_process_stages','sales_stage_outcomes','sales_stage_internal_statuses','sales_stage_requirements','sales_stage_guides','sales_process_resources','sales_process_automations','sales_stage_transition_paths','sales_academy_associations'];
async function query(sql,...args){return (await db.prepare(sql).bind(...args).all()).results;}
async function request(token,path,body){return app.request(`http://test.local${path}`,{method:'POST',headers:{cookie:`avalon_session=${token}`,'content-type':'application/json'},body:JSON.stringify(body)},{DB:db});}
async function mutate(token,method,path,body){return app.request(`http://test.local${path}`,{method,headers:{cookie:`avalon_session=${token}`,'content-type':'application/json'},body:JSON.stringify(body)},{DB:db});}
async function payload(response){const value=await response.json();return value.ok ? value.data : value;}
async function fingerprint(company='__global__'){return JSON.stringify(await Promise.all(copyTables.map(table=>query(`SELECT * FROM ${table} WHERE company_id=? ORDER BY id`,company))));}

before(async()=>{
  app=(await import('../dist/_worker.js')).default;
  mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:`template-adoption-${Date.now()}`}});
  db=await mf.getD1Database('DB');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort()) {
    const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s*\n\s*/g,' ');
    try { await db.exec(sql); } catch(error) { throw new Error(`${name}: ${error.message}`); }
  }
  await db.batch([
    db.prepare("INSERT INTO companies (id,name,slug,active,subscription_status) VALUES ('company-a','A','company-a',1,'active'),('company-b','B','company-b',1,'active')"),
    db.prepare("INSERT INTO reps (id,company_id,name,email,pin,role,is_super_admin,active) VALUES ('admin-a','company-a','Admin A','a@test.local','1111','admin',0,1),('rep-a','company-a','Rep A','rep@test.local','3333','rep',0,1),('admin-b','company-b','Admin B','b@test.local','2222','admin',0,1)"),
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('session_admin-token','admin-a',datetime('now')),('session_company_admin-token','company-a',datetime('now')),('session_rep-token','rep-a',datetime('now')),('session_company_rep-token','company-a',datetime('now')),('session_foreign-token','admin-b',datetime('now')),('session_company_foreign-token','company-b',datetime('now'))")
  ]);
});
after(async()=>mf.dispose());

test('every immutable template is copied with fresh tenant IDs and remapped relationships',async()=>{
  const globalBefore=await fingerprint();
  const foreignBefore=await fingerprint('company-b');
  const signatures=[];
  for(const template of templates){
    const response=await request('admin-token','/api/sales-process/drafts/from-template',{template_version_id:template,name:`Adopt ${template}`});
    assert.equal(response.status,201);
    const adopted=await payload(response);
    assert.equal(adopted.lifecycle,'draft');
    const version=adopted.version_id;
    adoptedVersion ||= version;
    const sourceStages=await query('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? ORDER BY display_order','__global__',template);
    const tenantStages=await query('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? ORDER BY display_order','company-a',version);
    assert.equal(tenantStages.length,sourceStages.length);
    assert.ok(tenantStages.every(row=>row.company_id==='company-a'&&row.process_version_id===version&&!sourceStages.some(source=>source.id===row.id)));
    const tenantStageIds=new Set(tenantStages.map(row=>row.id));
    for(const table of copyTables.slice(1)){
      const source=await query(`SELECT * FROM ${table} WHERE company_id=? AND process_version_id=?`,'__global__',template);
      const tenant=await query(`SELECT * FROM ${table} WHERE company_id=? AND process_version_id=?`,'company-a',version);
      assert.equal(tenant.length,source.length,`${template} did not copy ${table}`);
      assert.ok(tenant.every(row=>row.company_id==='company-a'&&!source.some(original=>original.id===row.id)),`${table} retained a global ID`);
      for(const row of tenant) for(const column of ['stage_id','from_stage_id','to_stage_id']) if(column in row&&row[column]) assert.ok(tenantStageIds.has(row[column]),`${table}.${column} was not remapped`);
    }
    const globalStageIds=new Set(sourceStages.map(row=>row.id));
    for(const table of copyTables.slice(1)) for(const row of await query(`SELECT * FROM ${table} WHERE company_id=? AND process_version_id=?`,'company-a',version)) for(const column of ['stage_id','from_stage_id','to_stage_id']) assert.ok(!globalStageIds.has(row[column]));
    signatures.push(tenantStages.map(row=>`${row.stable_key}:${row.semantic_type}`).join('|'));
  }
  assert.ok(new Set(signatures).size>=5,'template graphs are not meaningfully distinct');
  assert.equal(await fingerprint(),globalBefore,'immutable global catalog changed');
  assert.equal(await fingerprint('company-b'),foreignBefore,'another company changed');
});

test('AI decisions are draft-only optimistic role-scoped and tenant isolated',async()=>{
  assert.equal((await request('rep-token',`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions`,{suggestion_type:'automation',current:{},proposed:{component:'automations',items:[]}})).status,403);
  assert.equal((await request('admin-token',`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions`,{suggestion_type:'publish',current:{},proposed:{}})).status,400);
  const created=await payload(await request('admin-token',`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions`,{suggestion_type:'automation',current:{},proposed:{component:'automations',items:[]},reason:'Simplify reminders'}));
  assert.equal((await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions/${created.id}`,{decision:'accepted',applied_revision:1})).status,409);
  assert.equal((await mutate('foreign-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions/${created.id}`,{decision:'rejected'})).status,404);
  const saved=await payload(await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/components/automations`,{items:[],content_revision:1}));
  assert.equal(saved.content_revision,2);
  assert.equal((await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions/${created.id}`,{decision:'accepted',applied_revision:2})).status,200);
  const suggestion=(await query('SELECT * FROM sales_ai_suggestions WHERE id=? AND company_id=?',created.id,'company-a'))[0];
  assert.equal(suggestion.decision,'accepted');
  assert.equal((await query('SELECT COUNT(*) AS n FROM sales_ai_suggestions WHERE company_id=?','company-b'))[0].n,0);
});

test('guided AI generation covers the recommendation catalog without operational side effects',async()=>{
  const path=`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions/generate`;
  const interview={business_type:'Design-build landscape',average_cycle_days:45,primary_bottleneck:'Proposal review',required_qualification:'Budget authority and timing'};
  assert.equal((await request('rep-token',path,interview)).status,403);
  assert.equal((await request('foreign-token',path,interview)).status,404);
  const assignmentsBefore=JSON.stringify(await query('SELECT * FROM sales_stage_assignments WHERE company_id=? ORDER BY id','company-a'));
  const generated=await payload(await request('admin-token',path,interview));
  assert.equal(generated.generated,18);
  const pending=await query("SELECT * FROM sales_ai_suggestions WHERE company_id=? AND process_version_id=? AND decision='pending'",'company-a',adoptedVersion);
  const types=new Set(pending.map(item=>item.suggestion_type));
  for(const type of ['guided_interview','business_type','simplification','duplicate_stage','name','purpose','milestone','internal_status','condition','checklist','qualification_field','call_guide','email_template','academy_association','automation','stagnation_review','migration_suggestion','impact_explanation']) assert.ok(types.has(type),`missing ${type}`);
  const advisory=pending.find(item=>item.suggestion_type==='impact_explanation');
  assert.equal((await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions/${advisory.id}`,{decision:'accepted',applied_revision:0})).status,409);
  assert.equal((await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions/${advisory.id}`,{decision:'accepted',applied_revision:generated.content_revision})).status,200);
  const actionable=pending.find(item=>item.suggestion_type==='automation');
  assert.equal((await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/ai-suggestions/${actionable.id}`,{decision:'accepted',applied_revision:generated.content_revision})).status,409);
  assert.equal(JSON.stringify(await query('SELECT * FROM sales_stage_assignments WHERE company_id=? ORDER BY id','company-a')),assignmentsBefore);
  assert.equal((await query('SELECT COUNT(*) AS n FROM sales_ai_suggestions WHERE company_id=?','company-b'))[0].n,0);
});

test('Builder enforces roles occupied-stage archival published immutability and stale revisions',async()=>{
  let stages=await query('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? ORDER BY display_order','company-a',adoptedVersion);
  assert.equal((await mutate('rep-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/stages`,{stages,content_revision:2})).status,403);
  await db.prepare("INSERT INTO sales_stage_assignments (id,company_id,opportunity_id,process_version_id,stage_id,classification,outcome_type,assigned_by) VALUES (?,?,?,?,?,'mapped','',?)").bind('occupied-assignment','company-a','occupied-opportunity',adoptedVersion,stages[0].id,'admin-a').run();
  const archived=stages.map((stage,index)=>index===0?{...stage,state:'archived'}:stage);
  assert.equal((await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/stages`,{stages:archived,content_revision:2})).status,409);
  const renamed=stages.map((stage,index)=>index===1?{...stage,display_name:'Renamed without semantic change'}:stage);
  assert.equal((await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/stages`,{stages:renamed,content_revision:2})).status,200);
  assert.equal((await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/stages`,{stages,content_revision:2})).status,409);
  await db.prepare("UPDATE sales_process_versions SET lifecycle='published' WHERE id=? AND company_id=?").bind(adoptedVersion,'company-a').run();
  assert.equal((await mutate('admin-token','PUT',`/api/sales-process/drafts/${adoptedVersion}/stages`,{stages:renamed,content_revision:3})).status,404);
  await db.prepare("UPDATE sales_process_versions SET lifecycle='draft' WHERE id=? AND company_id=?").bind(adoptedVersion,'company-a').run();
});
