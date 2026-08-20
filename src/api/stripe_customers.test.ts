import { describe, it, expect } from 'vitest';
import {
  decideCustomer, paymentMethodUsable, targetAccountFor, applicationFeeCents,
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
