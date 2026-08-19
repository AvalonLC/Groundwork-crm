/**
 * What a Stripe event means for an invoice.
 *
 * The webhook handled two event types: checkout.session.completed and
 * account.updated. Money only ever moved one way. A refund left the invoice
 * reading "paid", a chargeback did nothing at all, and a failed payment was
 * silent — while Stripe, which is the actual system of record for the money,
 * had moved on.
 *
 * The decision of what an event means is kept here, away from the handler, so
 * it can be tested without a database. The handler does the writing.
 */

/** Invoice statuses this app uses. 'sent' is the unpaid-but-issued state. */
export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid';

export interface RefundEffect {
  kind: 'refund';
  /** Positive cents that came back out. */
  amount_cents: number;
  /** Stripe's id for the refund, for a deterministic payment row. */
  refund_id: string;
  payment_intent_id: string;
}

export interface DisputeEffect {
  kind: 'dispute';
  /** 'created' opens it; 'closed' records how it went. */
  phase: 'created' | 'closed';
  amount_cents: number;
  dispute_id: string;
  payment_intent_id: string;
  /** Stripe's dispute status, e.g. 'warning_needs_response', 'lost', 'won'. */
  status: string;
}

export interface PaymentFailedEffect {
  kind: 'payment_failed';
  payment_intent_id: string;
  /** Stripe's own message, shown to whoever has to chase it. */
  reason: string;
}

export type EventEffect = RefundEffect | DisputeEffect | PaymentFailedEffect | { kind: 'ignored'; type: string };

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/**
 * Read an event into the effect it should have.
 *
 * Returns `ignored` rather than throwing for anything unrecognised: Stripe sends
 * event types nobody subscribed to, and a webhook that 500s on an unfamiliar one
 * gets retried for three days and then disabled.
 */
export function classifyStripeEvent(event: any): EventEffect {
  const type = String(event?.type || '');
  const obj = event?.data?.object ?? {};

  switch (type) {
    case 'charge.refunded': {
      // Stripe sends the CHARGE, with amount_refunded as a running total. The
      // event fires again on a second partial refund with a larger total, so the
      // handler must not treat this as a delta.
      const refunded = int(obj.amount_refunded);
      if (refunded <= 0) return { kind: 'ignored', type };
      const latest = obj.refunds?.data?.[0];
      return {
        kind: 'refund',
        amount_cents: refunded,
        refund_id: String(latest?.id || obj.id || ''),
        payment_intent_id: String(obj.payment_intent || ''),
      };
    }

    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      return {
        kind: 'dispute',
        phase: type.endsWith('created') ? 'created' : 'closed',
        amount_cents: int(obj.amount),
        dispute_id: String(obj.id || ''),
        payment_intent_id: String(obj.payment_intent || ''),
        status: String(obj.status || ''),
      };
    }

    case 'payment_intent.payment_failed': {
      return {
        kind: 'payment_failed',
        payment_intent_id: String(obj.id || ''),
        reason: String(obj.last_payment_error?.message || 'The payment did not go through.'),
      };
    }

    default:
      return { kind: 'ignored', type };
  }
}

/**
 * What an invoice's status should be, given what has actually been paid.
 *
 * Derived from the totals rather than nudged from the previous status, because
 * a refund has to be able to move an invoice BACKWARDS — and the existing code
 * only ever incremented amount_paid, so "paid" was a one-way door.
 *
 * A fully refunded invoice returns to 'sent', not 'draft': it was issued, and
 * pretending otherwise loses the fact that a customer was asked for money.
 */
export function invoiceStatusFor(totalCents: number, paidCents: number): InvoiceStatus {
  const total = Math.max(0, int(totalCents));
  const paid = int(paidCents);
  if (paid <= 0) return 'sent';
  if (total > 0 && paid >= total) return 'paid';
  return 'partial';
}

/**
 * How much of this refund has not been written to the ledger yet.
 *
 * Stripe sends charge.refunded with a RUNNING TOTAL, and redelivers old events
 * after new ones. So neither "subtract the event amount" nor "trust the event's
 * total" is safe: the first double-counts a second partial refund, and the
 * second lets a replayed older event undo a newer one.
 *
 * The ledger is the authority. This returns what is missing from it, which is
 * zero for a replay and self-corrects if an event was ever missed.
 */
export function refundDelta(capturedCents: number, refundedTotalCents: number, alreadyLedgeredCents: number): number {
  const captured = Math.max(0, int(capturedCents));
  const target = Math.min(captured, Math.max(0, int(refundedTotalCents)));
  return Math.max(0, target - Math.max(0, int(alreadyLedgeredCents)));
}
