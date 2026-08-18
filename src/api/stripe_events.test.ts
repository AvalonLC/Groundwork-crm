import { describe, it, expect } from 'vitest';
import { classifyStripeEvent, invoiceStatusFor, refundDelta } from './stripe_events';

const chargeRefunded = (amountRefunded: number, extra: Record<string, unknown> = {}) => ({
  type: 'charge.refunded',
  data: { object: {
    id: 'ch_1', payment_intent: 'pi_1', amount: 50_000, amount_refunded: amountRefunded,
    refunds: { data: [{ id: 're_1' }] }, ...extra,
  } },
});

describe('classifyStripeEvent', () => {
  it('SE-01 reads a refund, and takes the RUNNING TOTAL not a delta', () => {
    // charge.refunded fires again on a second partial refund, with a larger
    // amount_refunded. Treating it as a delta double-counts the first one.
    const e = classifyStripeEvent(chargeRefunded(20_000));
    expect(e).toMatchObject({ kind: 'refund', amount_cents: 20_000, refund_id: 're_1', payment_intent_id: 'pi_1' });
  });

  it('SE-02 ignores a charge.refunded with nothing actually refunded', () => {
    expect(classifyStripeEvent(chargeRefunded(0)).kind).toBe('ignored');
  });

  it('SE-03 reads a dispute opening and closing', () => {
    const opened = classifyStripeEvent({
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: 'pi_1', amount: 50_000, status: 'warning_needs_response' } },
    });
    expect(opened).toMatchObject({ kind: 'dispute', phase: 'created', amount_cents: 50_000, status: 'warning_needs_response' });

    const closed = classifyStripeEvent({
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', payment_intent: 'pi_1', amount: 50_000, status: 'lost' } },
    });
    expect(closed).toMatchObject({ kind: 'dispute', phase: 'closed', status: 'lost' });
  });

  it('SE-04 reads a failed payment and keeps Stripe’s own reason', () => {
    const e = classifyStripeEvent({
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_9', last_payment_error: { message: 'Your card was declined.' } } },
    });
    expect(e).toMatchObject({ kind: 'payment_failed', payment_intent_id: 'pi_9', reason: 'Your card was declined.' });
  });

  it('SE-05 ignores unknown event types instead of throwing', () => {
    // Stripe sends types nobody subscribed to. A webhook that 500s on one gets
    // retried for three days and then disabled.
    for (const t of ['invoice.created', 'customer.updated', '', undefined]) {
      expect(classifyStripeEvent({ type: t, data: { object: {} } }).kind, String(t)).toBe('ignored');
    }
    expect(classifyStripeEvent(null).kind).toBe('ignored');
    expect(classifyStripeEvent({}).kind).toBe('ignored');
  });
});

describe('invoiceStatusFor', () => {
  it('SE-06 derives status from the totals, in both directions', () => {
    expect(invoiceStatusFor(50_000, 50_000)).toBe('paid');
    expect(invoiceStatusFor(50_000, 60_000)).toBe('paid');   // overpaid is still paid
    expect(invoiceStatusFor(50_000, 20_000)).toBe('partial');
    expect(invoiceStatusFor(50_000, 0)).toBe('sent');
  });

  it('SE-07 a fully refunded invoice returns to sent, not draft', () => {
    // It was issued. Calling it a draft again loses the fact that a customer was
    // asked for money.
    expect(invoiceStatusFor(50_000, 0)).toBe('sent');
  });

  it('SE-08 a zero-total invoice with nothing paid is not silently "paid"', () => {
    expect(invoiceStatusFor(0, 0)).toBe('sent');
  });
});

describe('refundDelta — what is missing from the ledger', () => {
  it('SE-09 a first refund is entirely missing from an empty ledger', () => {
    expect(refundDelta(50_000, 20_000, 0)).toBe(20_000);
  });

  it('SE-10 a second partial refund contributes only its own part', () => {
    // Stripe sends the running total: 20,000 then 35,000. The ledger already
    // holds 20,000, so the second event adds 15,000 — not 35,000, which would
    // over-refund, and not 15,000 computed by subtracting event amounts, which
    // breaks the moment one is missed.
    expect(refundDelta(50_000, 35_000, 20_000)).toBe(15_000);
  });

  it('SE-11 a REPLAY of an older event adds nothing', () => {
    // The bug this shape exists for. Stripe redelivers old events after new
    // ones. Reconciling the invoice against the event's own running total let a
    // replayed "20,000 refunded" move a fully-refunded invoice back to partial.
    // Against the ledger, a replay is simply zero.
    expect(refundDelta(50_000, 20_000, 50_000)).toBe(0);
    expect(refundDelta(50_000, 50_000, 50_000)).toBe(0);
  });

  it('SE-12 a refund larger than the capture is capped at the capture', () => {
    expect(refundDelta(50_000, 90_000, 0)).toBe(50_000);
  });

  it('SE-13 self-corrects when an event was missed entirely', () => {
    // If the 20,000 event never arrived, the 50,000 one still lands the ledger
    // on the right total rather than drifting 20,000 short forever.
    expect(refundDelta(50_000, 50_000, 0)).toBe(50_000);
  });

  it('SE-14 never returns a negative, whatever it is fed', () => {
    expect(refundDelta(50_000, -5, 0)).toBe(0);
    expect(refundDelta(50_000, 10_000, 40_000)).toBe(0);
    expect(refundDelta(-1, 10_000, 0)).toBe(0);
  });
});
