import { test, expect, type APIRequestContext } from '@playwright/test';

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

test.describe('stripe webhook', () => {
  test.beforeEach(async ({ request }) => { await login(request); });

  test('SW-01 a completed checkout is accepted and recorded once', async ({ request }) => {
    const invoiceId = await makeInvoice(request, 50_000);
    const res = await request.post('/api/stripe/webhook', {
      data: checkoutEvent(invoiceId, `pi_${TAG}_01_${Date.now()}`, 50_000),
    });
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
      const res = await request.post('/api/stripe/webhook', { data: evt });
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
    await request.post('/api/stripe/webhook', { data: checkoutEvent(invoiceId, `pi_${TAG}_03a_${stamp}`, 20_000) });
    await request.post('/api/stripe/webhook', { data: checkoutEvent(invoiceId, `pi_${TAG}_03b_${stamp}`, 30_000) });

    const inv = await invoiceOf(request, invoiceId);
    expect(Number(inv.amount_paid_cents)).toBe(50_000);
    expect(inv.status).toBe('paid');
  });

  test('SW-04 a part payment leaves the invoice partial, not paid', async ({ request }) => {
    const invoiceId = await makeInvoice(request, 50_000);
    await request.post('/api/stripe/webhook', { data: checkoutEvent(invoiceId, `pi_${TAG}_04_${Date.now()}`, 20_000) });

    const inv = await invoiceOf(request, invoiceId);
    expect(Number(inv.amount_paid_cents)).toBe(20_000);
    expect(inv.status).toBe('partial');
  });
});
