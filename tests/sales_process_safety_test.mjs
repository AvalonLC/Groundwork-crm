import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const frontend = fs.readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/0049_sales_process_safety_hardening.sql', import.meta.url), 'utf8');

const processStart = server.indexOf('// VERSIONED SALES PROCESS');
const processEnd = server.indexOf('// NAV PERMISSIONS', processStart);
assert.ok(processStart > 0 && processEnd > processStart, 'sales-process API section must exist');
const processApi = server.slice(processStart, processEnd);

assert.ok(!processApi.match(/\bFROM\s+gw_leads\b|\bUPDATE\s+gw_leads\b|\bINTO\s+gw_leads\b/i), 'tenant process APIs must not touch platform gw_leads');
assert.match(processApi, /sales_migration_snapshots/, 'migration must persist a pre-migration snapshot');
assert.match(processApi, /review_state='approved'/, 'publication must require an approved snapshot');
assert.match(processApi, /sales_process_company_state/, 'runtime publication must use a company-scoped active pointer');
assert.match(processApi, /sales_stage_transition_log/, 'stage changes must create stable transition history');
assert.match(processApi, /WHERE id=\? AND company_id=\?/, 'tenant opportunity reads must include company scope');

assert.match(frontend, /grouped\.push\(\{status:'Needs Restaging'/, 'unknown opportunities must use Needs Restaging');
assert.doesNotMatch(frontend, /firstGroup\.items\s*=.*orphanOpps/, 'unknown opportunities must not be inserted into the first stage');
assert.match(frontend, /salesRestagingWorkspace/, 'manual restaging workspace must exist');
assert.match(frontend, /gwOpportunitySemantic/, 'frontend reporting compatibility must expose semantic resolution');

assert.match(migration, /CREATE TABLE IF NOT EXISTS sales_migration_snapshots/, 'snapshot schema must be additive');
assert.match(migration, /CREATE TABLE IF NOT EXISTS sales_stage_transition_log/, 'transition audit schema must exist');
assert.match(migration, /semantic_type = 'terminal'/, 'conceptual Closed stage must not be typed as Won');

console.log('sales process safety checks passed');
