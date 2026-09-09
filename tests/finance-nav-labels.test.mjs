/* The Financial section must not offer two destinations called "Invoices".
 *
 * It did. `#invoices` is the CRM's own operational invoice system — create,
 * edit, delete, send, charge a card on file, record a payment, line items,
 * portal token, bulk actions (public/js/invoices.js, ~1,800 lines). `finInvPay`
 * is /finance/invoices-payments, a READ-ONLY record view: two SELECT-driven
 * tables with status badges and no forms at all (src/ui/invoices-payments.tsx,
 * ~137 lines).
 *
 * Both were labelled some form of "Invoices", so the two sat in the same
 * section with the same name and very different powers — and the newer of the
 * two was the one that could do less, which is the opposite of what a reader
 * would assume.
 *
 * Canonical: #invoices keeps the plain name. finInvPay becomes "Invoice
 * Reporting" and says what it is. Nothing is redirected, neither route is
 * retired, and no financial behaviour moves — the rename is the whole change.
 *
 * Run: node --test tests/finance-nav-labels.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../src/ui/layout.tsx', import.meta.url), 'utf8');

/** Evaluate a named object/array literal straight out of the shipped file. */
function literal(name) {
  const at = app.indexOf(name);
  assert.ok(at >= 0, `${name} is no longer in public/js/app_premium.js`);
  const eq = app.indexOf('=', at);
  const open = app.indexOf(app[eq + 2] === '[' ? '[' : '{', eq);
  const close = app[open] === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === app[open]) depth++;
    else if (app[i] === close) {
      depth--;
      if (depth === 0) return new Function(`return ${app.slice(open, i + 1)};`)();
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const financeOsTabs = literal('const _GW_FIN_NAV_TABS');
const wsTabDefs = literal('const _wsTabDefs');

test('FN-01 the operational invoice screen keeps the plain name', () => {
  const crm = Object.fromEntries(wsTabDefs.Financial.map(t => [t.id, t.label]));
  assert.equal(crm.invoices, 'Invoices');
});

test('FN-02 the Finance OS view is labelled as reporting', () => {
  const os = Object.fromEntries(financeOsTabs.map(t => [t.id, t.label]));
  assert.equal(os.finInvPay, 'Invoice Reporting');
  assert.doesNotMatch(os.finInvPay, /^Invoices$/);
});

test('FN-03 no two Financial tabs share a label at all', () => {
  // The general rule, so a future tab cannot reintroduce the collision by
  // another route.
  const labels = [
    ...wsTabDefs.Financial.map(t => t.label),
    ...financeOsTabs.map(t => t.label),
  ].map(l => String(l).trim().toLowerCase());
  const dupes = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))];
  assert.deepEqual(dupes, [], `two Financial tabs share a label: ${dupes.join(', ')}`);
});

test('FN-04 both nav definitions agree, so arriving from the sidebar is continuous', () => {
  // src/ui/layout.tsx's own comment: the Finance OS strip matches gwFinancial()'s
  // "exactly (same labels, same order, same /finance/* hrefs) so navigating in
  // from the CRM's own sidebar reads as continuing the same tab row rather than
  // leaving into a different app". A rename touching one side and not the other
  // breaks exactly that. src/ui/finance-nav.e2e.ts asserts the rendered list.
  const nav = layout.slice(layout.indexOf('FINANCE_NAV'), layout.indexOf('FINANCE_NAV_CONFIG'));
  assert.ok(nav.length > 0, 'FINANCE_NAV is gone from src/ui/layout.tsx');
  for (const tab of financeOsTabs) {
    if (tab.id === 'finConfig') continue; // lives in FINANCE_NAV_CONFIG, not FINANCE_NAV
    assert.ok(
      nav.includes(`label: "${tab.label}"`),
      `src/ui/layout.tsx has no label "${tab.label}" for ${tab.id} — the two nav ` +
      `definitions have drifted apart`,
    );
  }
});

test('FN-05 the page title matches its nav label', () => {
  // The tab says one thing and the page heading another is the same confusion
  // in a smaller place.
  const page = readFileSync(new URL('../src/ui/invoices-payments.tsx', import.meta.url), 'utf8');
  const titles = [...page.matchAll(/<Page title="([^"]+)"/g)].map(m => m[1]);
  assert.ok(titles.length > 0, 'no <Page title> found in invoices-payments.tsx');
  for (const t of titles) assert.equal(t, 'Invoice Reporting');
});

test('FN-06 neither route was redirected or retired', () => {
  // The decision was explicitly to relabel only: keep finInvPay available as a
  // separate read-only view until parity is proven, and never redirect
  // #invoices at it. This fails if someone "finishes the job" by wiring one to
  // the other.
  assert.ok(
    financeOsTabs.some(t => t.id === 'finInvPay'),
    'finInvPay was removed from the Finance OS nav',
  );
  assert.ok(
    wsTabDefs.Financial.some(t => t.id === 'invoices'),
    'the operational invoices tab was removed',
  );
  assert.match(layout, /href: "\/finance\/invoices-payments"/, 'the reporting route is gone');
});
