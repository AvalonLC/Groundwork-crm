/* The Payments page (#payments) — normalisation and totals.
 *
 * The page used to read localStorage['avalonPayments'] and nothing else: zero
 * network calls, while seven server paths wrote real rows into D1 `payments`
 * and GET /api/payments already served them. It showed none of them.
 *
 * These cover the two things that are easy to get wrong once it reads D1:
 *
 *   Money. `payments` carries BOTH the legacy REAL columns (amount,
 *   fee_amount, net_amount) and the authoritative INTEGER cents columns added
 *   in migrations/0058_money_cents.sql. Every write path dual-writes both. The
 *   float must never reach the UI, and totals must sum as integers.
 *
 *   Dates. created_at is SQLite datetime('now') — UTC, space-separated, no
 *   zone designator. Read as local it lands up to 5h off, which puts an
 *   evening-UTC payment in the wrong calendar month for the "This Month" tile.
 *
 * Runs under node:test at TZ=America/New_York rather than vitest, because the
 * vitest pool is workerd and workerd is pinned to UTC — the month-boundary
 * assertion below passes at UTC whether the code is right or wrong.
 *
 * Run: TZ=America/New_York node --test tests/payments-page.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source block ${startMarker}`);
  return source.slice(start, end);
}

const helpers = sourceBlock('/* ── Payments helpers', '/* ── end Payments helpers');
const { _payNormalize, _payTotals, _payAmountCents } = new Function(
  `${helpers}\nreturn { _payNormalize, _payTotals, _payAmountCents };`,
)();

const EAST_COAST = 'America/New_York';

function inZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { fn(); } finally { process.env.TZ = previous; }
}

test('PP-01 the amount comes from amount_cents, never the legacy float', () => {
  // Same trick UIP-02 uses in src/ui/invoices-payments.e2e.ts: the float is
  // deliberately wrong here, so anything reading it fails loudly.
  assert.equal(_payAmountCents({ amount: 999999, amount_cents: 60000 }), 60000);
});

test('PP-02 a pre-0058 row with no amount_cents falls back without producing NaN', () => {
  assert.equal(_payAmountCents({ amount: 500, amount_cents: null }), 50000);
  assert.equal(_payAmountCents({ amount: null, amount_cents: null }), 0);
  assert.equal(_payAmountCents({}), 0);
  assert.ok(Number.isInteger(_payAmountCents({ amount: 12.345 })));
});

test('PP-03 totals sum as integer cents, not floats', () => {
  const list = _payNormalize([
    { id: 'a', amount_cents: 3333, created_at: '2026-09-05 12:00:00' },
    { id: 'b', amount_cents: 3333, created_at: '2026-09-05 12:00:00' },
    { id: 'c', amount_cents: 3333, created_at: '2026-09-05 12:00:00' },
  ]);
  const totals = _payTotals(list, new Date('2026-09-05T12:00:00Z'));
  assert.equal(totals.totalCents, 9999);
  assert.ok(Number.isInteger(totals.totalCents));
  assert.equal(totals.count, 3);
});

test('PP-04 This Month buckets by the viewer\'s local month, not the UTC string', () => {
  // 01:30 UTC on Sep 1 is 21:30 on Aug 31 east-coast. Slicing the raw string
  // would file it under September for a payment that happened in August.
  inZone(EAST_COAST, () => {
    const list = _payNormalize([
      { id: 'aug', amount_cents: 10000, created_at: '2026-09-01 01:30:00' },
      { id: 'sep', amount_cents: 25000, created_at: '2026-09-05 16:00:00' },
    ]);
    const totals = _payTotals(list, new Date('2026-09-05T16:00:00Z'));
    assert.equal(totals.totalCents, 35000);
    assert.equal(totals.monthCents, 25000, 'the Aug 31 payment must not count toward September');
  });
});

test('PP-05 browser-only legacy rows are never added into the server totals', () => {
  const server = _payNormalize([{ id: 's', amount_cents: 10000, created_at: '2026-09-05 12:00:00' }]);
  const withLegacy = server.concat([
    { id: 'l', amountCents: 999999, createdAt: '2026-09-05 12:00:00', source: 'local' },
  ]);
  const totals = _payTotals(withLegacy, new Date('2026-09-05T12:00:00Z'));
  assert.equal(totals.totalCents, 10000, 'localStorage rows are not company record');
  assert.equal(totals.count, 1);
});

test('PP-06 normalisation marks server rows and survives junk input', () => {
  assert.deepEqual(_payNormalize(null), []);
  assert.deepEqual(_payNormalize(undefined), []);
  const [row] = _payNormalize([{ id: 'x', amount_cents: 100 }]);
  assert.equal(row.source, 'server');
  assert.equal(row.amountCents, 100);
});

test('PP-07 the client name is resolved from the id, since payments has no name column', () => {
  const [row] = _payNormalize(
    [{ id: 'x', client_id: 'c1', amount_cents: 100 }],
    { c1: 'Acme Client' },
  );
  assert.equal(row.clientName, 'Acme Client');
});
