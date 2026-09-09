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
  { id: 'a', invoice_number: 'INV-0001', status: 'sent',    balance_due: 250.00 },
  { id: 'b', invoice_number: 'INV-0002', status: 'paid',    balance_due: 0 },
  { id: 'c', invoice_number: 'INV-0003', status: 'void',    balance_due: 400.00 },
  { id: 'd', invoice_number: 'INV-0004', status: 'draft',   balance_due: 75.50 },
  { id: 'e', invoice_number: 'INV-0005', status: 'overdue', balance_due: 120.00 },
  // status='paid' WITH a live balance is the normal production shape, not a
  // corner case: bulk edit's "Mark paid" PUTs {status:'paid'} alone, and PUT
  // only dual-writes a *_cents twin for keys present in the body, so the
  // balance is left untouched. The previous 'paid' fixture had balance_due 0,
  // so the cents floor excluded it before the status rule was consulted and
  // adding 'paid' to INV_PAYABLE_STATUSES would have left IB-02 green.
  { id: 'f', invoice_number: 'INV-0006', status: 'paid',    balance_due: 2400.00 },
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
  assert.deepEqual(_invChargeable(LIST).map(i => i.id), ['a', 'e']);
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

test('IB-04b a draft is never charged — the client has not been sent it', () => {
  // `!== 'void'` admitted draft and written_off. Select-all on an unfiltered
  // list includes next month's drafts, and the server is no backstop: /charge
  // never reads inv.status. The portal hides drafts entirely, so the client
  // could not even look up what they were billed for.
  const { _invChargeable } = evaluate(LIST, []);
  const ids = _invChargeable(LIST).map(i => i.id);
  assert.equal(ids.includes('d'), false, 'a draft invoice was chargeable');
  assert.deepEqual(
    _invChargeable([{ id: 'w', status: 'written_off', balance_due: 500 }]), [],
    'a written-off invoice was chargeable',
  );
});

test('IB-04c the button counts in cents, so a sub-minimum residual is excluded', () => {
  // The bar counted with `balance_due > 0` while the run refuses under 50 cents,
  // so a 25-cent residual from a partial payment was included in the total the
  // operator approved and then failed mid-run.
  const { _invChargeable } = evaluate(LIST, []);
  assert.deepEqual(_invChargeable([{ id: 'r', status: 'partial', balance_due: 0.25 }]), []);
  assert.equal(_invChargeable([{ id: 'r', status: 'partial', balance_due: 0.50 }]).length, 1);
});

test('IB-04d balance_due_cents is preferred over the legacy float', () => {
  const { _invChargeable } = evaluate(LIST, []);
  // The float is deliberately wrong, so anything reading it fails.
  const rows = [{ id: 'x', status: 'sent', balance_due: 999999, balance_due_cents: 0 }];
  assert.deepEqual(_invChargeable(rows), []);
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
    (code.match(/INV_PAYABLE_STATUSES\.includes/g) || []).length, 2,
    'the payable-status rule should appear exactly twice: _invChargeable and _invBulkSend',
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

test('IB-11 bulk Send says it can charge cards, because it can', () => {
  // POST /:id/send carries the autopay branch, so this button takes money off
  // saved cards. src/api/invoice-access.ts: "As privileged as charging, and easy
  // to misread as 'just email'." The dialog used to say only "Email N invoices
  // to their clients?" — the exact misreading that comment warns about.
  const send = code.slice(code.indexOf('window._invBulkSend'), code.indexOf('window._invBulkDelete'));
  assert.match(send, /CHARGED/, 'the send confirmation does not mention charging');
  assert.match(send, /cannot be undone/i);
  assert.doesNotMatch(send, /confirm\(`Email \$\{picked\.length\}/, 'the email-only wording is back');
});

test('IB-12 bulk Send reports the autopay outcome, not a bare "sent"', () => {
  // The 200 body carries {autopay:{attempted,paid,reason}}. Checking only res.ok
  // rendered a decline and a successful charge identically as a green tick.
  const send = code.slice(code.indexOf('window._invBulkSend'), code.indexOf('window._invBulkDelete'));
  assert.match(send, /ap\.attempted && ap\.paid/);
  assert.match(send, /ap\.attempted && !ap\.paid/);
});

test('IB-13 bulk Send never re-sends a settled invoice', () => {
  // /send sets status='sent' and overwrites sent_at unconditionally, so a paid
  // invoice caught in a select-all was regressed out of the Paid KPI and its
  // real send date destroyed.
  const send = code.slice(code.indexOf('window._invBulkSend'), code.indexOf('window._invBulkDelete'));
  assert.match(send, /INV_PAYABLE_STATUSES\.includes/);
  assert.doesNotMatch(send, /filter\(i => i\.status !== 'void'\)/);
});

test('IB-14 the run overlay cannot be dismissed while it is charging', () => {
  // _invCreateOverlay wires backdrop-click-to-dismiss. There is no Close button
  // until the run finishes, so the backdrop was the only clickable-looking
  // thing — and clicking it detached the modal while the loop kept charging,
  // leaving the bar live for a second concurrent run over the same selection.
  const run = code.slice(code.indexOf('async function _invBulkRun'), code.indexOf('async function _invErr'));
  assert.doesNotMatch(run, /_invCreateOverlay/, 'the run overlay is dismissable again');
  assert.match(run, /createElement\('div'\)/);
});
