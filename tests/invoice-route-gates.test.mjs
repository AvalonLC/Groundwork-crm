/* Every /api/invoices route must carry an authorization check.
 *
 * The matrix in src/api/invoice-access.test.ts proves canInvoice() decides
 * correctly. It cannot prove the routes actually ask it — and the failure mode
 * this whole change exists for is a route that was never gated at all. A new
 * route added under this prefix without a canInvoice call would reintroduce the
 * exact hole while every unit test stayed green.
 *
 * So this asserts the wiring, at the source level, the same way
 * tests/stripe-charge-columns.test.mjs asserts a SQL column list.
 *
 * Run: node --test tests/invoice-route-gates.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const lines = source.split('\n');

/**
 * Deliberately public, both token-scoped with no session at all — the customer
 * viewing and paying their own invoice. Same design as the three
 * /api/estimates/portal routes. A role gate here would be meaningless: the
 * caller is a customer, who has no rep role.
 *
 * These carry their own defences instead of a role check: an unguessable
 * portal_token, and on /pay the amount is read from the database rather than
 * taken from the request. RG-04 pins the "no session" property so neither can
 * quietly acquire one, and this list should not grow without an argument in
 * review.
 */
const INTENTIONALLY_UNGATED = [
  '/api/invoices/portal/:token',
  '/api/invoices/portal/:token/pay',
];

function invoiceRoutes() {
  const found = [];
  lines.forEach((line, i) => {
    const m = line.match(/app\.(get|post|put|delete|patch)\(\s*['"`](\/api\/invoices[^'"`]*)['"`]/);
    if (m) found.push({ method: m[1], path: m[2], line: i });
  });
  return found;
}

/** The handler body: from the registration to the next top-level app.<verb>( . */
function handlerBody(startIdx) {
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^app\.(get|post|put|delete|patch)\(/.test(lines[i])) {
      return lines.slice(startIdx, i).join('\n');
    }
  }
  return lines.slice(startIdx).join('\n');
}

test('RG-01 the expected invoice routes are all still present', () => {
  const paths = invoiceRoutes().map(r => `${r.method.toUpperCase()} ${r.path}`);
  for (const expected of [
    'GET /api/invoices',
    'GET /api/invoices/:id',
    'GET /api/invoices/portal/:token',
    'POST /api/invoices',
    'PUT /api/invoices/:id',
    'DELETE /api/invoices/:id',
    'POST /api/invoices/:id/send',
    'POST /api/invoices/:id/record-payment',
    'POST /api/invoices/from-estimate/:estimateId',
    'POST /api/invoices/:id/charge',
  ]) {
    assert.ok(paths.includes(expected), `route disappeared or was renamed: ${expected}`);
  }
});

test('RG-02 every invoice route calls canInvoice, or is on the public allowlist', () => {
  for (const route of invoiceRoutes()) {
    if (INTENTIONALLY_UNGATED.includes(route.path)) continue;
    const body = handlerBody(route.line);
    assert.match(
      body, /canInvoice\(/,
      `${route.method.toUpperCase()} ${route.path} (line ${route.line + 1}) has no canInvoice ` +
      `check — it is reachable by any authenticated rep of any role`,
    );
  }
});

test('RG-03 the gate runs before any database work in the handler', () => {
  // A check placed after a write is not a gate. Ordering matters most on the
  // list/get routes, which mint a portal_token with an UPDATE on the first line.
  for (const route of invoiceRoutes()) {
    if (INTENTIONALLY_UNGATED.includes(route.path)) continue;
    const body = handlerBody(route.line);
    const gateAt = body.indexOf('canInvoice(');
    const dbAt = body.search(/db\.prepare\(|c\.env\.DB\.prepare\(/);
    if (dbAt === -1) continue;
    assert.ok(
      gateAt !== -1 && gateAt < dbAt,
      `${route.method.toUpperCase()} ${route.path} touches the database before ` +
      `checking canInvoice — the authorization decision must come first`,
    );
  }
});

test('RG-04 the portal routes stay ungated and stay public', () => {
  for (const path of INTENTIONALLY_UNGATED) {
    const portal = invoiceRoutes().find(r => r.path === path);
    assert.ok(portal, `the public portal route is missing: ${path}`);
    assert.doesNotMatch(
      lines[portal.line], /requireAuth/,
      `${path} must not require a session — the caller is a customer, who has none`,
    );
  }
});

test('RG-05 the public pay route still takes its amount from the database', () => {
  // The one defence that matters on an unauthenticated payment endpoint: a
  // client-supplied amount here would let anyone with a portal link choose what
  // to pay. Pinned because it is invisible in the route signature.
  const pay = invoiceRoutes().find(r => r.path === '/api/invoices/portal/:token/pay');
  assert.ok(pay);
  const body = handlerBody(pay.line);
  assert.match(body, /FROM invoices WHERE portal_token=\?/, 'the invoice must be looked up by token');
  assert.match(body, /inv\.total_cents/, 'the amount owed must be derived from the stored invoice');
});
