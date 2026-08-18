import { test, expect, type APIRequestContext } from '@playwright/test';
import { computeSignature } from '../src/api/stripe_signature';

/**
 * The Stripe webhook, against a real server.
 *
 * This endpoint had two defects that hid each other. The payments INSERT named
 * `method` and `paid_at`, neither of which is a column (they are
 * `payment_method`, and there is no paid_at), so it threw on every completed
 * checkout and the handler returned 400. Stripe retries a 400 — and the invoice
 * UPDATE ran BEFORE the throw, so each retry credited the invoice again.
 *
 * Measured on the pre-fix code with three deliveries of one $500 payment:
 * amount_paid_cents = 150000, payments rows = 0. The money was wrong in the
 * customer's favour on the payments table and wrong in ours on the invoice.
 *
 * These tests go through HTTP rather than calling a function, because the bug
 * was in what the database would accept — a unit test with a mocked D1 would
 * have passed against the broken column names.
 */

const REP_LOGIN = { repId: 'tyler', pin: '1111', companyId: 'avalon' };
const TAG = 'E2E-STRIPE';

/** Must match the --binding in playwright.spa.config.ts's webServer command. */
const WEBHOOK_SECRET = 'whsec_e2e_test_secret';

/**
 * POST an event the way Stripe does: raw body, signed, with the header.
 *
 * `data` is deliberately not used — Playwright would re-serialise the object and
 * the bytes signed would not be the bytes sent, which is exactly the failure
 * mode SIG-15 pins in the unit tests.
 */
async function postEvent(request: APIRequestContext, event: unknown, opts: { sign?: boolean } = {}) {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign !== false) {
    const ts = Math.floor(Date.now() / 1000);
    headers['stripe-signature'] = `t=${ts},v1=${await computeSignature(WEBHOOK_SECRET, ts, body)}`;
  }
  return request.post('/api/stripe/webhook', { headers, data: body });
}

async function login(request: APIRequestContext) {
  const res = await request.post('/api/auth/login', { data: REP_LOGIN });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** A real invoice to pay, created through the API so the schema stays honest. */
async function makeInvoice(request: APIRequestContext, totalCents: number) {
  const res = await request.post('/api/invoices', {
    data: { client_name: `${TAG} Client`, title: TAG, total: totalCents / 100, status: 'sent' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  return (body.id || body.data?.id) as string;
}

async function invoiceOf(request: APIRequestContext, id: string) {
  const r = await request.get(`/api/invoices/${id}`);
  expect(r.ok(), await r.text()).toBeTruthy();
  const b = await r.json();
  return (b.data || b.invoice || b) as any;
}

function checkoutEvent(invoiceId: string, intentId: string, amountCents: number) {
  return {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${intentId}`,
        payment_intent: intentId,
        amount_total: amountCents,
        metadata: { invoice_id: invoiceId, company_id: 'avalon' },
      },
    },
  };
}

/**
 * Remove everything this file created.
 *
 * The first version of this spec had no cleanup and left 31 invoices and 25
 * payments behind after a few runs — which is also what made SW-04 fail inside
 * the group while passing alone. The schedule-board suite has always cleaned up
 * after itself; this one should have from the start.
 *
 * Invoices only. The payments rows these tests create cannot be removed through
 * the API — there is no DELETE for them and invoice deletion does not cascade —
 * so a handful of `py_pi_E2E-STRIPE_*` rows accumulate in a local database.
 * Harmless and tagged, but stated here rather than quietly left.
 */
async function cleanup(request: APIRequestContext) {
  const res = await request.get('/api/invoices?limit=500');
  if (!res.ok()) return;
  const body = await res.json();
  // GET /api/invoices returns a BARE ARRAY, not {data:[...]}. The first version
  // of this helper assumed the wrapper every other endpoint here uses, found
  // nothing, and silently cleaned up nothing — which is how 31 invoices piled up.
  const list: any[] = Array.isArray(body) ? body : (body.data || body.invoices || []);
  for (const inv of list) {
    if (String(inv.title || '') !== TAG) continue;
    // DELETE /api/invoices/:id only removes rows with status='draft', and
    // returns {ok:true} either way — so deleting a paid invoice silently does
    // nothing and reports success. These are 'sent' and then 'paid', so they
    // have to be put back to draft first.
    await request.put(`/api/invoices/${inv.id}`, { data: { status: 'draft' } });
    await request.delete(`/api/invoices/${inv.id}`);
  }
}

test.describe('stripe webhook', () => {
  test.beforeAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    await login(request);
    await cleanup(request);
    await request.dispose();
  });

  test.afterAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    await login(request);
    await cleanup(request);
    await request.dispose();
  });

  test.beforeEach(async ({ request }) => { await login(request); });

  test('SW-01 a completed checkout is accepted and recorded once', async ({ request }) => {
    const invoiceId = await makeInvoice(request, 50_000);
    const res = await postEvent(request, checkoutEvent(invoiceId, `pi_${TAG}_01_${Date.now()}`, 50_000));
    // Pre-fix this was 400 "table payments has no column named method".
    expect(res.status(), await res.text()).toBe(200);

    const inv = await invoiceOf(request, invoiceId);
    expect(Number(inv.amount_paid_cents)).toBe(50_000);
    expect(inv.status).toBe('paid');
  });

  test('SW-02 Stripe retrying does not credit the invoice twice', async ({ request }) => {
    // The regression guard. Stripe retries a delivery it did not get a 2xx for,
    // and it also redelivers on its own schedule. Either way the same intent can
    // arrive more than once, and it must land once.
    const invoiceId = await makeInvoice(request, 50_000);
    const evt = checkoutEvent(invoiceId, `pi_${TAG}_02_${Date.now()}`, 50_000);

    for (let i = 0; i < 3; i++) {
      const res = await postEvent(request, evt);
      expect(res.status(), `delivery ${i + 1}`).toBe(200);
    }

    const inv = await invoiceOf(request, invoiceId);
    // Pre-fix: 150000. One payment, credited once, however many times it arrives.
    expect(Number(inv.amount_paid_cents), 'invoice was credited more than once').toBe(50_000);
  });

  test('SW-03 two different payments on one invoice both count', async ({ request }) => {
    // The other half of idempotency: deduplicating by payment intent must not
    // collapse two genuine part-payments into one.
    const invoiceId = await makeInvoice(request, 50_000);
    const stamp = Date.now();
    await postEvent(request, checkoutEvent(invoiceId, `pi_${TAG}_03a_${stamp}`, 20_000));
    await postEvent(request, checkoutEvent(invoiceId, `pi_${TAG}_03b_${stamp}`, 30_000));

    const inv = await invoiceOf(request, invoiceId);
    expect(Number(inv.amount_paid_cents)).toBe(50_000);
    expect(inv.status).toBe('paid');
  });

  test('SW-04 a part payment leaves the invoice partial, not paid', async ({ request }) => {
    const invoiceId = await makeInvoice(request, 50_000);
    await postEvent(request, checkoutEvent(invoiceId, `pi_${TAG}_04_${Date.now()}`, 20_000));

    const inv = await invoiceOf(request, invoiceId);
    expect(Number(inv.amount_paid_cents)).toBe(20_000);
    expect(inv.status).toBe('partial');
  });

  test('SW-05 an unsigned event is refused', async ({ request }) => {
    // The hole this closes. Before verification existed, this POST marked the
    // invoice paid — and an invoice id and company id both appear in URLs the
    // customer already has.
    const invoiceId = await makeInvoice(request, 50_000);
    const res = await postEvent(request, checkoutEvent(invoiceId, `pi_${TAG}_05_${Date.now()}`, 50_000), { sign: false });
    expect(res.status()).toBe(400);

    const inv = await invoiceOf(request, invoiceId);
    expect(Number(inv.amount_paid_cents), 'an unsigned event moved money').toBe(0);
    expect(inv.status).not.toBe('paid');
  });

  test('SW-06 an event signed with the wrong secret is refused', async ({ request }) => {
    const invoiceId = await makeInvoice(request, 50_000);
    const body = JSON.stringify(checkoutEvent(invoiceId, `pi_${TAG}_06_${Date.now()}`, 50_000));
    const ts = Math.floor(Date.now() / 1000);
    const res = await request.post('/api/stripe/webhook', {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${ts},v1=${await computeSignature('whsec_not_the_real_one', ts, body)}`,
      },
      data: body,
    });
    expect(res.status()).toBe(400);
    expect(Number((await invoiceOf(request, invoiceId)).amount_paid_cents)).toBe(0);
  });

  test('SW-07 a valid signature over a tampered body is refused', async ({ request }) => {
    // Capture a real webhook, point it at a different invoice, keep the header.
    const mine = await makeInvoice(request, 50_000);
    const victim = await makeInvoice(request, 50_000);
    const original = JSON.stringify(checkoutEvent(mine, `pi_${TAG}_07_${Date.now()}`, 50_000));
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${await computeSignature(WEBHOOK_SECRET, ts, original)}`;

    const res = await request.post('/api/stripe/webhook', {
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      data: original.replace(mine, victim),
    });
    expect(res.status()).toBe(400);
    expect(Number((await invoiceOf(request, victim)).amount_paid_cents)).toBe(0);
  });
});
