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

/* ── The card on file, when the caller names no card ─────────────────────────
 *
 * A bulk charge has no dropdown to pick a payment method from, so the charge
 * route resolves the client's own saved card. That path is where the guards the
 * dropdown used to imply have to be enforced explicitly, and both of the ones
 * below are the kind that fail silently rather than loudly.
 */

/** The body of the route that starts at `signature`, up to the next app.<verb>. */
function routeBody(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `route ${signature} is no longer in src/index.tsx`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\napp\.(get|post|put|delete|patch)\(/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

test('SF-04 the autopay cap is read in cents, never as the legacy REAL dollars', () => {
  // max_amount is REAL dollars from migration 0044; max_amount_cents is the
  // authoritative INTEGER added by 0058 and dual-written since. Comparing a
  // cents amount against the float — `amount > Math.round(cap * 100)` — puts
  // float rounding back on the path that decides whether a customer is charged
  // more than they consented to. The legacy column may still be READ, but only
  // behind the cents one, for rows written before 0058.
  lines.forEach((line, i) => {
    if (!/\bmax_amount\b/.test(line)) return;          // _cents does not match \bmax_amount\b
    if (/^\s*(\/\/|\*|--)/.test(line.trim())) return;  // prose about the columns
    if (/SELECT|FROM/.test(line)) return;              // naming it in a column list is fine
    const preceding = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    assert.match(
      preceding, /max_amount_cents/,
      `src/index.tsx:${i + 1} reads the legacy REAL max_amount with no ` +
      `max_amount_cents above it:\n  ${line.trim()}`,
    );
  });
});

test('SF-05 a resolved card goes through cardOnFileDecision, not an inline copy', () => {
  // The guards on a saved card — the client authorised it, it is within the
  // per-charge cap they set, and it is attached to the account this charge will
  // run on — live in one tested function (SC-24..SC-33 in
  // src/api/stripe_customers.test.ts). Writing them out again in the route is
  // how the bulk path and the single path drift, and the bulk path is the one
  // that would then let something through.
  const charge = routeBody("app.post('/api/invoices/:id/charge'");
  if (!/client_autopay/.test(charge)) return; // no card-on-file path to guard

  assert.match(
    charge, /cardOnFileDecision\(/,
    'the charge route reads client_autopay but does not run it through ' +
    'cardOnFileDecision — see src/api/stripe_customers.ts',
  );
  assert.match(
    charge, /if \(!decision\.ok\) return/,
    'the charge route ignores a refusal from cardOnFileDecision',
  );
  // The columns the decision reads must be SELECTed, for the same reason SF-01
  // exists: D1 returns only what was asked for, and a missing column reads as
  // undefined rather than failing.
  const select = charge.slice(charge.indexOf('SELECT'), charge.indexOf('FROM client_autopay'));
  for (const column of ['enabled', 'stripe_pm_id', 'stripe_account_id', 'max_amount_cents']) {
    assert.match(
      select, new RegExp(`\\b${column}\\b`),
      `the client_autopay SELECT omits ${column}, which cardOnFileDecision reads`,
    );
  }
});
