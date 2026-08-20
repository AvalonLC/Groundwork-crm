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

export interface PaymentSucceededEffect {
  kind: 'payment_succeeded';
  payment_intent_id: string;
  amount_cents: number;
  /**
   * From the PaymentIntent's own metadata.
   *
   * This is the field that makes direct charges recordable at all. The checkout
   * routes set `payment_intent_data[metadata][invoice_id]`, which lands on the
   * PaymentIntent and NOT on the Checkout Session — while the session handler
   * reads `session.metadata.invoice_id`, which is undefined. So every portal
   * payment was silently skipped even before the routing problem.
   *
   * payment_intent.succeeded carries that metadata directly, so handling it
   * fixes the existing sessions without depending on the session-level metadata
   * the routes only started setting alongside this change.
   */
  invoice_id: string;
  company_id: string;
}

export type EventEffect =
  | RefundEffect | DisputeEffect | PaymentFailedEffect | PaymentSucceededEffect
  | { kind: 'ignored'; type: string };

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

    case 'payment_intent.succeeded': {
      const amount = int(obj.amount_received ?? obj.amount);
      if (amount <= 0) return { kind: 'ignored', type };
      return {
        kind: 'payment_succeeded',
        payment_intent_id: String(obj.id || ''),
        amount_cents: amount,
        invoice_id: String(obj.metadata?.invoice_id || ''),
        company_id: String(obj.metadata?.company_id || ''),
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

// ── Connected-account routing and readiness ─────────────────────────────────

/**
 * Which Stripe account an event came from.
 *
 * Direct charges execute ON the connected account, so their events arrive with
 * `account` set to that acct_. Platform-context events (account.updated, and
 * anything from a destination charge) have no `account` field.
 *
 * This is the authoritative tenant signal and metadata is not: metadata is
 * whatever the request that created the object happened to set, and an event
 * can arrive for an object nobody in this codebase created.
 */
export function eventAccountId(event: any): string {
  return String(event?.account || '');
}

export type ConnectionStatus = '' | 'pending' | 'active' | 'restricted';

export interface AccountReadiness {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  /** Comma-separated Stripe requirement keys, '' when none are outstanding. */
  requirements_due: string;
  status: ConnectionStatus;
}

/**
 * Read an account.updated payload into the four things the product needs.
 *
 * `status` is derived, not sent by Stripe:
 *
 *   pending      onboarding started, details not submitted yet
 *   active       details in, charges enabled
 *   restricted   details submitted but charges are off, or requirements are
 *                past due — the state an account lands in when Stripe pulls a
 *                capability back
 *
 * The old handler only ever wrote flags when charges_enabled was truthy, so an
 * account that BECAME restricted kept its live flags and the app kept sending
 * customers to a Checkout that Stripe would refuse. Returning the full picture
 * every time, including the false cases, is what makes clearing possible.
 */
export function accountReadiness(acct: any): AccountReadiness {
  const charges = !!acct?.charges_enabled;
  const payouts = !!acct?.payouts_enabled;
  const details = !!acct?.details_submitted;

  const req = acct?.requirements ?? {};
  const due = [
    ...(Array.isArray(req.currently_due) ? req.currently_due : []),
    ...(Array.isArray(req.past_due) ? req.past_due : []),
  ];
  const requirements_due = [...new Set(due.map(String))].join(',');
  const hasPastDue = Array.isArray(req.past_due) && req.past_due.length > 0;

  let status: ConnectionStatus;
  if (!details) status = 'pending';
  else if (charges && !hasPastDue) status = 'active';
  else status = 'restricted';

  return { charges_enabled: charges, payouts_enabled: payouts, details_submitted: details, requirements_due, status };
}
