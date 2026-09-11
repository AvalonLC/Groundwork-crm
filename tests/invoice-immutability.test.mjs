/* An invoice that has touched money is a record, not a document.
 *
 * PUT /api/invoices/:id writes `status` verbatim from its allowlist, and
 * DELETE /api/invoices/:id only ever matched `status='draft'`. Together that
 * was a two-step hard delete of a settled invoice — Edit -> Status: Draft ->
 * Delete — reachable from the bulk toolbar, with the "has payments recorded"
 * warning shown on the first (no-op) attempt and not on the second
 * (destructive) one.
 *
 * `payments.invoice_id` carries no foreign key, so the payment rows survived
 * as orphans: still counted by the payments page and by revenue reporting,
 * joinable to nothing.
 *
 * These pin the route wiring and the migration's shape. The decision logic
 * itself is unit-tested in src/api/invoice-lifecycle.test.ts (IL-01..IL-16).
 *
 * Run: node --test tests/invoice-immutability.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const client = readFileSync(new URL('../public/js/invoices.js', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../migrations/0088_invoice_lifecycle_audit.sql', import.meta.url), 'utf8');
const script = readFileSync(
  new URL('../scripts/reconcile-orphan-payments.mjs', import.meta.url), 'utf8');

/**
 * Comment-stripped views, for every "this text does not appear" assertion.
 *
 * Both of these files EXPLAIN in prose what they deliberately do not do — the
 * migration says it adds no foreign key, the script says it has no UPDATE or
 * DELETE — so a raw search finds the promise and reports it as the violation.
 * That is the third time in this repo a guard has read prose instead of code;
 * EH-04, XS-06 and IJ-08 each needed the same correction.
 */
const migrationCode = migration.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
const scriptCode = script
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');

function routeBody(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `route ${signature} is gone from src/index.tsx`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\napp\.(get|post|put|delete|patch)\(/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

test('IM-01 returning an invoice to draft goes through the lifecycle rule', () => {
  // The first half of the chain. Without this, PUT writes status='draft' on a
  // paid invoice and DELETE then matches it.
  const put = routeBody("app.put('/api/invoices/:id'");
  assert.match(put, /String\(b\?\.status \|\| ''\) === 'draft'/, 'PUT no longer notices a draft transition');
  assert.match(put, /canReturnToDraft\(/, 'PUT no longer consults the lifecycle rule');
  // The behaviour, not the statement shape: a refusal is a 409 carrying the
  // reason and the machine-readable code. It is a block now because it also
  // writes an audit row first.
  assert.match(put, /c\.json\(\{ error: verdict\.reason, code: verdict\.code \}, 409\)/);
});

test('IM-02 deleting an invoice goes through the lifecycle rule, not a status string', () => {
  // `AND status='draft'` in the WHERE was the entire rule, and it cannot see
  // payments at all.
  const del = routeBody("app.delete('/api/invoices/:id'");
  assert.match(del, /canHardDelete\(/, 'DELETE no longer consults the lifecycle rule');
  assert.match(del, /invoiceFootprint\(db, companyId, id\)/, 'DELETE no longer counts payments');
  assert.match(del, /c\.json\(\{ error: verdict\.reason, code: verdict\.code \}, 409\)/);
});

test('IM-03 the refusal is a 409 with a reason, never a silent ok', () => {
  for (const sig of ["app.put('/api/invoices/:id'", "app.delete('/api/invoices/:id'"]) {
    const body = routeBody(sig);
    assert.doesNotMatch(
      body, /\.run\(\)\s*\n\s*return c\.json\(\{ ok: true \}\)/,
      `${sig} returns ok:true without checking what happened`,
    );
  }
  assert.match(routeBody("app.delete('/api/invoices/:id'"), /meta\.changes/);
});

test('IM-04 the footprint query is company-scoped', () => {
  // Tenant isolation: an orphan count that ignored company_id would let one
  // tenant's payments block another tenant's delete, and vice versa.
  const helper = source.slice(source.indexOf('async function invoiceFootprint'), source.indexOf("app.put('/api/invoices/:id'"));
  assert.ok(helper.length > 0, 'invoiceFootprint is gone');
  assert.match(helper, /WHERE invoice_id=\? AND company_id=\?/, 'the footprint query is not company-scoped');
  assert.match(helper, /stripe_payment_intent_id/, 'processor references are no longer counted');
});

test('IM-05 the migration is additive and adds no foreign key', () => {
  // A RESTRICT constraint on payments.invoice_id cannot be applied while
  // dangling references exist, and they do — see the reconciliation script.
  // Report first, resolve, then constrain.
  assert.doesNotMatch(migrationCode, /\bREFERENCES\b/i, 'the migration adds a foreign key');
  assert.doesNotMatch(migrationCode, /\b(DROP|TRUNCATE|RENAME)\b/i, 'the migration is not additive');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS invoice_lifecycle_events/);
  // Added columns must be nullable, or applying to a populated table fails.
  for (const col of ['void_reason', 'archived_at']) {
    assert.match(migration, new RegExp(`ADD COLUMN ${col} TEXT;`), `${col} is not a plain nullable column`);
    assert.doesNotMatch(migration, new RegExp(`ADD COLUMN ${col}[^;]*NOT NULL`), `${col} is NOT NULL`);
  }
  assert.match(migration, /company_id/, 'the audit table is not tenant-scoped');
});

test('IM-06 the audit table records who, what and why', () => {
  for (const col of ['invoice_id', 'event', 'reason', 'refusal_code', 'actor_id', 'created_at']) {
    assert.match(migration, new RegExp(`\\b${col}\\b`), `the audit table has no ${col}`);
  }
  // datetime('now') is UTC and space-separated, like every other timestamp here.
  assert.match(migration, /DEFAULT \(datetime\('now'\)\)/);
});

test('IM-07 the reconciliation script cannot write, and refuses production', () => {
  // It reads a live financial table. Reading production is a human's call, and
  // repairing live financial rows is not automatable at all.
  assert.doesNotMatch(scriptCode, /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO|ALTER|DROP)\b/i,
    'the reconciliation script contains a write statement');
  assert.match(script, /--remote/, 'the script no longer mentions the remote flag');
  assert.match(script, /Refusing --remote/, 'the script no longer refuses --remote');
  assert.match(script, /GROUP BY p\.company_id/, 'the report is no longer grouped per tenant');
});

test('IM-08 every migration file is still uniquely numbered and sequential', () => {
  const files = readdirSync(new URL('../migrations/', import.meta.url))
    .filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
  const nums = files.map(f => Number(f.slice(0, 4)));
  const dupes = nums.filter((v, i) => nums.indexOf(v) !== i);
  assert.deepEqual(dupes, [], `duplicate migration numbers: ${dupes.join(', ')}`);
  assert.equal(nums[nums.length - 1], 88, 'the new migration is not the highest-numbered one');
});

test('IM-09 voiding requires a reason and records it', () => {
  // Voiding used to be a plain PUT setting status='void' — indistinguishable in
  // the record from any other edit and carrying no explanation. Now that a
  // financially active invoice cannot be deleted, voiding is the primary way a
  // bad invoice leaves circulation, so "why" has to survive with it.
  const route = routeBody("app.post('/api/invoices/:id/void'");
  assert.match(route, /if \(!reason\) return c\.json\(\{ error: 'A reason is required/);
  assert.match(route, /void_reason=\?/, 'the reason is no longer stored on the invoice');
  assert.match(route, /logInvoiceLifecycle\(db, \{[\s\S]*?event: 'void'/, 'the void is no longer audited');
  assert.match(route, /canInvoice\(c\.var\.role as string, 'manage'/, 'the void route lost its role gate');
  assert.match(route, /AND company_id=\?/, 'the void route is not company-scoped');
});

test('IM-10 a refused delete or draft transition is recorded, not just rejected', () => {
  // A pattern of blocked attempts is worth being able to query — it is the
  // signal that someone is trying to destroy records they should not.
  for (const [sig, event] of [
    ["app.delete('/api/invoices/:id'", 'delete_refused'],
    ["app.put('/api/invoices/:id'", 'draft_refused'],
  ]) {
    assert.match(
      routeBody(sig), new RegExp(`event: '${event}'`),
      `${sig} no longer records its refusals`,
    );
  }
});

test('IM-11 the audit write can never fail the operation it describes', () => {
  // A void that half-succeeded because its audit row failed would be worse
  // than a void with no audit row.
  const fn = source.slice(source.indexOf('async function logInvoiceLifecycle'), source.indexOf('async function invoiceFootprint'));
  assert.ok(fn.length > 0, 'logInvoiceLifecycle is gone');
  assert.match(fn, /catch \(_\) \{/, 'the audit write is no longer best-effort');
  assert.match(fn, /company_id/, 'audit rows are not tenant-scoped');
});

test('IM-12 the UI reports a refusal instead of toasting success', () => {
  // Both handlers discarded the response and toasted success unconditionally.
  // With the 409s this PR's predecessor added, a refused delete would have read
  // as "Invoice deleted" and the row simply reappeared on the next refresh.
  for (const fn of ['_invVoid', '_invDelete']) {
    const body = client.slice(client.indexOf(`window.${fn} =`), client.indexOf('window.', client.indexOf(`window.${fn} =`) + 10));
    assert.match(body, /if \(!res\.ok\) return showToast\(await _invErr\(/, `${fn} still ignores the response`);
  }
});

test('IM-13 voiding goes through the void route, not a bare status PUT', () => {
  const body = client.slice(client.indexOf('window._invVoid ='), client.indexOf('window._invDelete ='));
  assert.match(body, /\/void`/, '_invVoid no longer calls the void route');
  assert.doesNotMatch(body, /JSON\.stringify\(\{ status:'void' \}\)/, '_invVoid is back to a bare status PUT');
  assert.match(body, /A reason is required/, '_invVoid no longer requires a reason');
});
