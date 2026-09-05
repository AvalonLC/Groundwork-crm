/* Columns a Stripe charge reads must actually be SELECTed.
 *
 * D1's .first() returns only the columns the query asked for, so reading
 * `company.stripe_charges_enabled` off a row selected without it yields
 * `undefined` — silently, with no error and no failing test. The value then
 * falls through whatever default the reader supplies, and the charge takes a
 * different path than the configuration says it should.
 *
 * Both charge paths had exactly this. The queries selected
 *
 *   stripe_account_id, stripe_onboarded, stripe_platform_fee_pct
 *
 * while the code downstream read `stripe_charges_enabled` (inside
 * targetAccountFor, whose own comment calls it "the authoritative signal") and
 * `stripe_platform_fee_bps`. Neither was in the row. Consequences:
 *
 *   targetAccountFor returned '' for a properly connected company, so the staff
 *   charge ran on the PLATFORM account with no Stripe-Account header and no
 *   application fee, and autopay-on-send never fired at all.
 *
 *   the platform fee always fell back to 290 bps, ignoring whatever the tenant
 *   was actually configured for.
 *
 * This is a source-level invariant rather than a behavioural test because the
 * defect lives in the SQL column list, not in any function's logic — every unit
 * test of targetAccountFor and applicationFeeCents passed while both bugs were
 * live. Same spirit as tests/no-shadow-assets.test.mjs, which also asserts a
 * fact about the shipped source.
 *
 * Run: node --test tests/stripe-charge-columns.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const lines = source.split('\n');

/**
 * The `SELECT ... FROM companies` that produced the row being read at `idx`.
 * Walks back to the nearest one; the statement may wrap across lines, so it
 * collects from the SELECT keyword through the FROM clause.
 */
function companiesSelectAbove(idx) {
  for (let i = idx; i >= 0 && i > idx - 60; i--) {
    if (!/FROM companies/.test(lines[i])) continue;
    let start = i;
    while (start > 0 && !/SELECT/i.test(lines[start])) start--;
    return { text: lines.slice(start, i + 1).join(' '), line: start + 1 };
  }
  return null;
}

function readsAt(pattern) {
  const hits = [];
  lines.forEach((line, i) => { if (pattern.test(line)) hits.push(i); });
  return hits;
}

test('SF-01 every row passed to targetAccountFor selects stripe_charges_enabled', () => {
  const sites = readsAt(/targetAccountFor\(/);
  assert.ok(sites.length >= 3, `expected the known call sites, found ${sites.length}`);
  for (const idx of sites) {
    const sel = companiesSelectAbove(idx);
    assert.ok(sel, `targetAccountFor at line ${idx + 1} has no companies SELECT above it`);
    assert.match(
      sel.text, /stripe_charges_enabled/,
      `targetAccountFor at line ${idx + 1} reads a row from the SELECT at line ${sel.line}, ` +
      `which does not select stripe_charges_enabled — it will be undefined and the ` +
      `company will be treated as not connected`,
    );
  }
});

test('SF-02 every read of stripe_platform_fee_bps selects that column', () => {
  const sites = readsAt(/stripe_platform_fee_bps/);
  assert.ok(sites.length >= 2, `expected the known fee reads, found ${sites.length}`);
  for (const idx of sites) {
    const sel = companiesSelectAbove(idx);
    assert.ok(sel, `fee read at line ${idx + 1} has no companies SELECT above it`);
    assert.match(
      sel.text, /stripe_platform_fee_bps/,
      `line ${idx + 1} reads stripe_platform_fee_bps from the SELECT at line ${sel.line}, ` +
      `which does not select it — the fee silently falls back to 290 bps`,
    );
  }
});

test('SF-03 the fee is read as basis points, never as the legacy REAL percentage', () => {
  // migration 0078 replaced stripe_platform_fee_pct with an INTEGER bps column
  // precisely so fee arithmetic stops multiplying a float. A charge path that
  // reaches for _pct is doing the arithmetic this schema forbids.
  const feeCalls = readsAt(/applicationFeeCents\(/);
  assert.ok(feeCalls.length >= 2);
  for (const idx of feeCalls) {
    assert.doesNotMatch(
      lines[idx], /stripe_platform_fee_pct/,
      `line ${idx + 1} computes an application fee from the legacy REAL column`,
    );
  }
});
