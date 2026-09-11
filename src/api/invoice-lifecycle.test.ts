import { describe, it, expect } from 'vitest';
import {
  canReturnToDraft, canHardDelete, financialFootprint, amountPaidCents,
} from './invoice-lifecycle';

const draft = { status: 'draft' };
const none = {};

describe('financialFootprint', () => {
  it('IL-01 an untouched draft has no footprint', () => {
    expect(financialFootprint(draft, none)).toBe(null);
  });

  it('IL-02 any payment row counts, whatever its status', () => {
    // A failed payment still means a processor was asked to move money against
    // this invoice, and the row is what would be orphaned by a delete.
    expect(financialFootprint(draft, { paymentCount: 1 })).toBe('has_payments');
    expect(financialFootprint(draft, { livePaymentCount: 1 })).toBe('has_payments');
  });

  it('IL-03 a processor reference counts even with no payment row', () => {
    // The row can be missing while Stripe still holds a charge — that is the
    // exact state a failed write-back leaves behind.
    expect(financialFootprint(draft, { processorRefCount: 1 })).toBe('has_processor_reference');
    expect(financialFootprint({ ...draft, stripe_payment_status: 'succeeded' }, none))
      .toBe('has_processor_reference');
  });

  it('IL-04 posted ledger entries count', () => {
    expect(financialFootprint(draft, { ledgerLineCount: 1 })).toBe('has_posted_ledger');
  });

  it('IL-05 money recorded as paid counts, from either column', () => {
    expect(financialFootprint({ ...draft, amount_paid_cents: 1 }, none)).toBe('amount_paid_recorded');
    // Pre-0058 row: only the legacy REAL dollars column is populated.
    expect(financialFootprint({ ...draft, amount_paid: 24.0, amount_paid_cents: null }, none))
      .toBe('amount_paid_recorded');
    expect(financialFootprint({ ...draft, paid_at: '2026-09-01 10:00:00' }, none))
      .toBe('amount_paid_recorded');
  });

  it('IL-06 zero and negative counts are not a footprint', () => {
    expect(financialFootprint(draft, { paymentCount: 0, processorRefCount: -1 })).toBe(null);
    expect(financialFootprint({ ...draft, amount_paid_cents: 0 }, none)).toBe(null);
  });
});

describe('amountPaidCents', () => {
  it('IL-07 prefers the authoritative cents column over the legacy float', () => {
    // The float is deliberately wrong, so anything reading it fails.
    expect(amountPaidCents({ amount_paid: 999999, amount_paid_cents: 2400 })).toBe(2400);
  });
  it('IL-08 falls back to the legacy column without producing NaN', () => {
    expect(amountPaidCents({ amount_paid: 24, amount_paid_cents: null })).toBe(2400);
    expect(amountPaidCents({})).toBe(0);
    expect(Number.isInteger(amountPaidCents({ amount_paid: 12.345 }))).toBe(true);
  });
});

describe('canReturnToDraft', () => {
  it('IL-09 an untouched sent invoice may go back to draft', () => {
    expect(canReturnToDraft({ status: 'sent' }, none)).toEqual({ ok: true });
  });

  it('IL-10 a financially active invoice may not', () => {
    // This is the first half of the Edit -> Draft -> Delete chain. Closing it
    // here means the chain cannot start.
    const out = canReturnToDraft({ status: 'paid', amount_paid_cents: 240000 }, { paymentCount: 1 });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/Void it instead/);
  });

  it('IL-11 a voided invoice may not be un-voided into a draft', () => {
    const out = canReturnToDraft({ status: 'void' }, none);
    expect(out.ok === false && out.code).toBe('voided');
  });
});

describe('canHardDelete', () => {
  it('IL-12 an untouched draft may be deleted', () => {
    expect(canHardDelete(draft, none)).toEqual({ ok: true });
  });

  it('IL-13 a draft carrying payments may not — the payments would be orphaned', () => {
    // payments.invoice_id has no foreign key, so deleting the invoice leaves
    // rows still counted by the payments page pointing at nothing.
    const out = canHardDelete(draft, { paymentCount: 1 });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.code).toBe('has_payments');
  });

  it('IL-14 a non-draft may not be deleted whatever its footprint', () => {
    const out = canHardDelete({ status: 'sent' }, none);
    expect(out.ok === false && out.code).toBe('not_a_draft');
  });

  it('IL-15 a draft that was actually sent may not be deleted', () => {
    // sent_at is written independently of status, so the label can lie. Check
    // the fact.
    const out = canHardDelete({ status: 'draft', sent_at: '2026-09-01 10:00:00' }, none);
    expect(out.ok === false && out.code).toBe('already_issued');
  });

  it('IL-16 every refusal explains itself and names the alternative', () => {
    for (const [inv, counts] of [
      [draft, { paymentCount: 1 }],
      [draft, { processorRefCount: 1 }],
      [draft, { ledgerLineCount: 1 }],
      [{ status: 'sent' }, {}],
    ] as const) {
      const out = canHardDelete(inv, counts);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toMatch(/Void it instead/);
    }
  });
});
