import { describe, it, expect } from 'vitest';
import {
  decideCustomer, paymentMethodUsable, targetAccountFor, applicationFeeCents,
  chargeIdempotencyKey,
} from './stripe_customers';

const ACCT = 'acct_connected';

describe('decideCustomer', () => {
  it('SC-01 reuses a customer already on the target account', () => {
    expect(decideCustomer({ customer_id: 'cus_1', account_id: ACCT }, ACCT))
      .toEqual({ action: 'reuse', customer_id: 'cus_1' });
  });

  it('SC-02 creates one when the client has never had a customer', () => {
    expect(decideCustomer({ customer_id: '', account_id: '' }, ACCT))
      .toEqual({ action: 'create', reason: 'none_stored' });
  });

  it('SC-03 a LEGACY platform customer is a mismatch once the company is connected', () => {
    // The bug this exists for. Rows written before migration 0080 have
    // account_id '' and are platform customers. Charging one on a connected
    // account fails with "No such customer" — so it is treated as absent and a
    // fresh customer is created on the right account.
    expect(decideCustomer({ customer_id: 'cus_legacy', account_id: '' }, ACCT))
      .toEqual({ action: 'create', reason: 'wrong_account' });
  });

  it('SC-04 a legacy customer is CORRECT for a company that never connected', () => {
    // Platform to platform. A tenant that has not connected Stripe must be
    // completely unaffected by any of this.
    expect(decideCustomer({ customer_id: 'cus_legacy', account_id: '' }, ''))
      .toEqual({ action: 'reuse', customer_id: 'cus_legacy' });
  });

  it('SC-05 a customer from a DIFFERENT connected account is never reused', () => {
    // Tenant isolation at the Stripe level: company B's customer id must never
    // be presented to company A's account.
    expect(decideCustomer({ customer_id: 'cus_b', account_id: 'acct_other' }, ACCT))
      .toEqual({ action: 'create', reason: 'wrong_account' });
  });

  it('SC-06 tolerates whitespace and nulls rather than mis-deciding', () => {
    expect(decideCustomer({ customer_id: '  ', account_id: ACCT }, ACCT).action).toBe('create');
    expect(decideCustomer({ customer_id: 'cus_1', account_id: ` ${ACCT} ` }, ACCT).action).toBe('reuse');
    expect(decideCustomer({ customer_id: null as any, account_id: null as any }, '').action).toBe('create');
  });
});

describe('paymentMethodUsable', () => {
  it('SC-07 a card is usable only on the account it was attached to', () => {
    expect(paymentMethodUsable(ACCT, ACCT)).toBe(true);
    expect(paymentMethodUsable('', ACCT)).toBe(false);        // legacy platform card
    expect(paymentMethodUsable('acct_other', ACCT)).toBe(false);
    expect(paymentMethodUsable('', '')).toBe(true);            // platform to platform
  });

  it('SC-08 is separate from decideCustomer on purpose', () => {
    // A customer can be recreated transparently; a card cannot. When this is
    // false the honest response is to ask for the card again, not to attempt a
    // charge Stripe will reject.
    const stored = { customer_id: 'cus_legacy', account_id: '' };
    expect(decideCustomer(stored, ACCT).action).toBe('create'); // recoverable
    expect(paymentMethodUsable('', ACCT)).toBe(false);          // needs the customer
  });
});

describe('targetAccountFor', () => {
  it('SC-09 charges on the connected account only when Stripe says it can', () => {
    expect(targetAccountFor({ stripe_account_id: ACCT, stripe_charges_enabled: 1, stripe_onboarded: 1 })).toBe(ACCT);
  });

  it('SC-10 falls back to the platform when the account is restricted', () => {
    // onboarded alone is not enough — an account can finish onboarding and later
    // have its capability pulled, and Stripe then refuses the charge at the
    // worst possible moment.
    expect(targetAccountFor({ stripe_account_id: ACCT, stripe_charges_enabled: 0, stripe_onboarded: 1 })).toBe('');
  });

  it('SC-11 falls back when onboarding never finished, or there is no account', () => {
    expect(targetAccountFor({ stripe_account_id: ACCT, stripe_charges_enabled: 1, stripe_onboarded: 0 })).toBe('');
    expect(targetAccountFor({ stripe_account_id: '', stripe_charges_enabled: 1, stripe_onboarded: 1 })).toBe('');
    expect(targetAccountFor(null)).toBe('');
    expect(targetAccountFor({})).toBe('');
  });

  it('SC-12 accepts booleans as well as 0/1', () => {
    expect(targetAccountFor({ stripe_account_id: ACCT, stripe_charges_enabled: true, stripe_onboarded: true })).toBe(ACCT);
  });
});

describe('applicationFeeCents', () => {
  it('SC-13 computes the fee from integer basis points', () => {
    // 2.9% of $500.00 = $14.50
    expect(applicationFeeCents(50_000, 290)).toBe(1_450);
    expect(applicationFeeCents(9_999, 290)).toBe(290);
  });

  it('SC-14 matches the float version it replaces, without the float', () => {
    // Math.round(cents * 2.9 / 100) was the old form. Same answers, computed
    // from an integer rate rather than a REAL column.
    for (const cents of [1, 99, 100, 12_345, 50_000, 1_000_000]) {
      expect(applicationFeeCents(cents, 290)).toBe(Math.round((cents * 290) / 10_000));
    }
  });

  it('SC-15 a zero fee is zero, and junk does not become NaN in a money column', () => {
    expect(applicationFeeCents(50_000, 0)).toBe(0);
    expect(applicationFeeCents(0, 290)).toBe(0);
    expect(applicationFeeCents(-5, 290)).toBe(0);
    expect(applicationFeeCents(50_000, NaN as any)).toBe(0);
    expect(applicationFeeCents('abc' as any, 290)).toBe(0);
  });
});

describe('chargeIdempotencyKey', () => {
  // The gap this closes: /api/invoices/:id/charge sent no Idempotency-Key at
  // all, so a double-click, a flaky response, or a timeout retry created a
  // SECOND PaymentIntent and took the money twice from a real customer card.
  const KEY = (over: Partial<Parameters<typeof chargeIdempotencyKey>[0]> = {}) =>
    chargeIdempotencyKey({
      invoiceId: 'inv_1', amountCents: 25000, amountPaidCents: 0, pmId: 'pm_saved', ...over,
    });

  it('SC-16 a repeated attempt produces the SAME key — the double-click case', () => {
    expect(KEY()).toBe(KEY());
  });

  it('SC-17 a genuine second payment gets a NEW key once amount_paid moved', () => {
    // A partial, then the rest. Keying on invoice+amount alone would have
    // blocked this for 24 hours, which is how idempotency becomes its own bug.
    expect(KEY({ amountCents: 10000, amountPaidCents: 0 }))
      .not.toBe(KEY({ amountCents: 15000, amountPaidCents: 10000 }));
  });

  it('SC-18 a retry of a FAILED charge on the SAME card replays instead of charging', () => {
    // The charge failed, so amount_paid_cents never moved and the card is the
    // same one. Same key: Stripe returns the original result.
    expect(KEY({ amountPaidCents: 0 })).toBe(KEY({ amountPaidCents: 0 }));
  });

  it('SC-19 a DIFFERENT card on the same invoice and amount is allowed through', () => {
    // Deliberate widening of the stranded fix. A declined card that the
    // customer then replaces has unchanged invoice/amount/amount_paid, so
    // without pmId in the key Stripe would replay the stored decline for 24
    // hours and the corrected card could never be charged.
    expect(KEY({ pmId: 'pm_declined' })).not.toBe(KEY({ pmId: 'pm_fixed' }));
  });

  it('SC-20 different invoices never collide', () => {
    expect(KEY({ invoiceId: 'inv_1' })).not.toBe(KEY({ invoiceId: 'inv_2' }));
  });

  it('SC-21 the amount enters the key as integer cents, never a float', () => {
    // Money is integer cents everywhere in this repo; a key carrying "250.5"
    // would mean two spellings of one charge, and two PaymentIntents.
    expect(KEY({ amountCents: 250.5 })).toBe(KEY({ amountCents: 250 }));
    expect(KEY()).not.toMatch(/\./);
  });

  it('SC-22 is a valid Stripe idempotency key: ASCII, non-empty, <=255 chars', () => {
    const k = KEY({ invoiceId: 'x'.repeat(400) });
    expect(k.length).toBeGreaterThan(0);
    expect(k.length).toBeLessThanOrEqual(255);
    expect(k).toMatch(/^[\x20-\x7E]+$/);
  });

  it('SC-23 nulls and junk do not silently collapse two charges into one key', () => {
    expect(KEY({ amountPaidCents: null as any })).toBe(KEY({ amountPaidCents: 0 }));
    expect(KEY({ pmId: '' })).not.toBe(KEY({ pmId: 'pm_saved' }));
  });
});
