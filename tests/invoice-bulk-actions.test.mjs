/* Invoice bulk actions — what a selection actually acts on.
 *
 * The bulk bar can send emails, void invoices, delete them, and charge cards on
 * file. Every one of those loops the SAME per-invoice endpoint the single-invoice
 * UI uses, rather than a bulk route on the server, so the guards cannot drift
 * apart. What is left on the client is the part no server route can check for
 * it: which of the ticked invoices each action is run against.
 *
 * That decision is worth pinning, because getting it wrong is silent. Nothing
 * throws when a bulk charge includes a settled invoice — a customer is simply
 * billed a second time. Nothing throws when a blank form field is sent as '' —
 * nine due dates are simply cleared.
 *
 * Run: TZ=America/New_York node --test tests/invoice-bulk-actions.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../public/js/invoices.js', import.meta.url), 'utf8');

const MARKER = 'BULK ACTIONS';
const start = source.indexOf('/* ', source.indexOf(MARKER) - 200);
assert.ok(start >= 0, 'the BULK ACTIONS block is no longer in public/js/invoices.js');
const block = source.slice(start);

/**
 * The same text with comments removed.
 *
 * Every "this code does not do X" assertion has to run against this, not
 * against `block`. The comment explaining WHY something is avoided contains the
 * very words that prove it is avoided — IB-10 below first failed on the
 * sentence "Sequential, not Promise.all", which is the block promising not to
 * do the thing the test then reported it doing. EH-04 and EH-01 have each been
 * caught by the same shape: a guard that reads prose instead of code.
 *
 * Block comments go first; then whole-line // comments only, so a slash inside
 * a template literal or a route path is left alone.
 */
const code = block
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');

/*
 * Evaluated against the real file, never a copy. A stub of these rules would be
 * a second implementation of the thing under test, which is how the Payments
 * helpers and gwDateParse ended up with two copies of one UTC rule.
 *
 * window and document only need to EXIST at definition time — the block assigns
 * handlers onto window, and touches document only inside functions the pure
 * tests below never call.
 */
function evaluate(invoices, selectedIds) {
  return new Function(
    'window', 'document',
    `const _invAllData = ${JSON.stringify(invoices)};
     const _invSelected = new Set(${JSON.stringify(selectedIds)});
     ${block}
     return { _invPicked, _invChargeable, _invBulkPatch };`,
  )({}, {});
}

const LIST = [
  { id: 'a', invoice_number: 'INV-0001', status: 'sent',  balance_due: 250.00 },
  { id: 'b', invoice_number: 'INV-0002', status: 'paid',  balance_due: 0 },
  { id: 'c', invoice_number: 'INV-0003', status: 'void',  balance_due: 400.00 },
  { id: 'd', invoice_number: 'INV-0004', status: 'draft', balance_due: 75.50 },
];

test('IB-01 the selection is intersected with the list, not trusted on its own', () => {
  // The list is re-fetched on every filter change and every action. An id that
  // survives in the Set but not in the list must not be acted on: it may have
  // been deleted by this very run, or filtered out of view.
  const { _invPicked } = evaluate(LIST, ['a', 'd', 'ghost-id']);
  assert.deepEqual(_invPicked().map(i => i.id), ['a', 'd']);
});

test('IB-02 a settled invoice is never in a bulk charge', () => {
  // Charging a paid invoice is not a no-op. It is a second payment against a
  // real customer card, and no server route can tell it apart from a wanted one.
  const { _invChargeable } = evaluate(LIST, []);
  assert.deepEqual(_invChargeable(LIST).map(i => i.id), ['a', 'd']);
});

test('IB-03 a voided invoice is never in a bulk charge, balance or not', () => {
  // 'c' carries a 400.00 balance AND status void. Filtering on the balance
  // alone would bill it: a void invoice stays on the books but stops being
  // collectable.
  const { _invChargeable } = evaluate(LIST, []);
  assert.equal(_invChargeable(LIST).some(i => i.id === 'c'), false);
});

test('IB-04 missing, null and string balances do not slip into a charge', () => {
  const { _invChargeable } = evaluate(LIST, []);
  const odd = [
    { id: 'n1', status: 'sent' },
    { id: 'n2', status: 'sent', balance_due: null },
    { id: 'n3', status: 'sent', balance_due: '' },
    { id: 'n4', status: 'sent', balance_due: 'abc' },
    { id: 'n5', status: 'sent', balance_due: 0 },
    { id: 'n6', status: 'sent', balance_due: -10 },
    { id: 'n7', status: 'sent', balance_due: '120.00' },
  ];
  // Only the last is a real amount owed. A NaN comparison is false, which is the
  // safe direction here, and this pins that it stays that way.
  assert.deepEqual(_invChargeable(odd).map(i => i.id), ['n7']);
});

test('IB-05 the bar and the run agree on what is chargeable', () => {
  // These were two separate copies of the same filter — one sizing the button,
  // one deciding what to bill. Drift does not throw; the button says 3 and
  // charges 5. One definition, referenced twice.
  const bar = /const chargeable = _invChargeable\(picked\);/;
  const run = /const picked = _invChargeable\(_invPicked\(\)\);/;
  assert.match(code, bar, 'the bulk bar no longer sizes itself with _invChargeable');
  assert.match(code, run, 'the bulk charge no longer selects with _invChargeable');
  assert.equal(
    (code.match(/balance_due \|\| 0\) > 0/g) || []).length, 1,
    'the balance rule is written out more than once again — keep it in _invChargeable alone',
  );
});

test('IB-06 a blank bulk-edit field leaves that field alone', () => {
  // The failure this prevents is not an error, it is nine cleared due dates.
  const { _invBulkPatch } = evaluate(LIST, []);
  assert.deepEqual(_invBulkPatch({ due: '', terms: '', status: '', email: '' }), {});
  assert.deepEqual(_invBulkPatch({}), {});
  assert.deepEqual(_invBulkPatch({ due: '   ', email: '  ' }), {});
});

test('IB-07 only the fields actually filled in are sent', () => {
  const { _invBulkPatch } = evaluate(LIST, []);
  assert.deepEqual(
    _invBulkPatch({ due: '2026-10-01', terms: '', status: 'sent', email: '' }),
    { due_date: '2026-10-01', status: 'sent' },
  );
  assert.deepEqual(
    _invBulkPatch({ email: '  billing@example.com  ' }),
    { client_email: 'billing@example.com' },
  );
});

test('IB-08 bulk actions drive the per-invoice routes, not a bulk endpoint', () => {
  // A bulk route on the server would need its own copy of every guard the
  // single routes already carry — company scoping, the Stripe account check,
  // the autopay cap, the void/paid rules — and the moment those drift, the bulk
  // path is the one that lets something through.
  for (const route of [
    /fetch\(`\/api\/invoices\/\$\{inv\.id\}\/send`/,
    /fetch\(`\/api\/invoices\/\$\{inv\.id\}`, \{ method: 'DELETE'/,
    /fetch\(`\/api\/invoices\/\$\{inv\.id\}\/charge`/,
  ]) assert.match(code, route);
  assert.doesNotMatch(code, /\/api\/invoices\/bulk/, 'a bulk endpoint appeared — see the block comment');
});

test('IB-09 the browser never names which card to charge', () => {
  // The charge body carries an amount and nothing else. Sending a stripe_pm_id
  // from the client would let the page pick any card id it could see; the
  // server resolves the client's own card on file and enforces the consent,
  // cap and Stripe-account checks against it.
  const charge = code.slice(
    code.indexOf('window._invBulkCharge'),
    code.indexOf('window._invBulkEdit'),
  );
  assert.ok(charge.length > 0, '_invBulkCharge is no longer in the block');
  assert.match(charge, /JSON\.stringify\(\{ amount: cents \}\)/);
  assert.doesNotMatch(charge, /stripe_pm_id/);
});

test('IB-10 charges run one at a time, so a failure names its own invoice', () => {
  // Promise.all across fifteen card charges is a way to get rate-limited by
  // Stripe halfway through and be left unsure which ones went out.
  assert.match(code, /for \(const inv of items\) \{/);
  assert.doesNotMatch(code, /Promise\.all/);
});
