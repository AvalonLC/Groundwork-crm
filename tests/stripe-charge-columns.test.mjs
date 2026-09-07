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

test('SF-04 one definition of the client autopay cap, shared by both charge paths', () => {
  // The previous version of this test scanned src/index.tsx line by line for
  // `max_amount` and skipped any line matching SELECT|FROM. Both of the only two
  // matching lines were skipped — one by that guard, one by the comment guard —
  // so it executed ZERO assertions and was green because it never ran. It read
  // as coverage for a rule nothing checked.
  //
  // The rule that actually matters now: the cap is computed in exactly one
  // place. autopayCapCents prefers max_amount_cents (authoritative since 0058)
  // and falls back to the legacy REAL dollars, so neither caller can drift onto
  // the float and reintroduce the rounding 0058 removed.
  const helper = readFileSync(new URL('../src/api/stripe_customers.ts', import.meta.url), 'utf8');
  assert.match(helper, /export function autopayCapCents/, 'the shared cap helper is gone');

  for (const route of [
    "app.post('/api/invoices/:id/send'",
    "app.post('/api/invoices/:id/charge'",
  ]) {
    const body = routeBody(route);
    if (!/client_autopay|autopayCapCents|cardOnFileDecision/.test(body)) continue;
    assert.doesNotMatch(
      body, /Number\(\s*ap\??\.?\??\.max_amount_cents/,
      `${route} computes the autopay cap inline instead of calling autopayCapCents`,
    );
  }
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
  // lastIndexOf, not indexOf: starting at the FIRST SELECT in the route body
  // spanned the invoices and companies SELECTs plus the `if (!stripe_pm_id)`
  // line, so dropping stripe_pm_id or stripe_account_id from the client_autopay
  // column list still matched elsewhere and went uncaught — the two whose
  // absence matters most, since an undefined stripe_account_id makes
  // paymentMethodUsable compare '' against the target and wave the card through.
  const fromAt = charge.indexOf('FROM client_autopay');
  const select = charge.slice(charge.lastIndexOf('SELECT', fromAt), fromAt);
  for (const column of ['enabled', 'stripe_pm_id', 'stripe_account_id', 'max_amount_cents', 'max_amount']) {
    assert.match(
      select, new RegExp(`\\b${column}\\b`),
      `the client_autopay SELECT omits ${column}, which cardOnFileDecision reads`,
    );
  }
});

test('SF-06 a charge is bounded by what the invoice still owes', () => {
  // This route was the only money path in the file that trusted a client-supplied
  // amount. /send's autopay branch derives owedCents itself and the portal pay
  // route reads its amount from the database (RG-05); here `amount` came off the
  // request body with only a $0.50 floor.
  //
  // A bulk run makes that reachable without anyone doing anything wrong: the
  // browser posts a balance from a list it fetched earlier, and if the client
  // pays through the portal in between, the card is charged the FULL balance on
  // top of what was already collected. The write-back then clamps balance to 0,
  // so the overcharge exists only in Stripe.
  const charge = routeBody("app.post('/api/invoices/:id/charge'");
  assert.match(
    charge, /const owedNowCents = Math\.max\(0, Number\(inv\.total_cents \|\| 0\) - Number\(inv\.amount_paid_cents \|\| 0\)\)/,
    'the charge route no longer recomputes what is owed from the stored row',
  );
  assert.match(charge, /if \(amount > owedNowCents\)/, 'the charge amount is unbounded again');
  // Recomputed from the row, never from the request body.
  const bound = charge.slice(charge.indexOf('owedNowCents'));
  assert.doesNotMatch(
    bound.slice(0, bound.indexOf('cardOnFileDecision')),
    /body\.(amount|balance)/,
    'the bound is taken from the request instead of the database',
  );
});

test('SF-07 deleting an invoice reports whether anything was deleted', () => {
  // The statement result used to be discarded and {ok:true} returned
  // unconditionally, so deleting a sent or paid invoice reported success and did
  // nothing — a bulk run printed a column of green ticks for rows that then
  // reappeared on the next refresh. Eight other routes in this file already
  // check meta.changes.
  const del = routeBody("app.delete('/api/invoices/:id'");
  assert.match(del, /meta\.changes/, 'the DELETE result is discarded again');
  assert.doesNotMatch(
    del, /\.run\(\)\s*\n\s*return c\.json\(\{ ok: true \}\)/,
    'the DELETE returns ok:true without checking what happened',
  );
});
