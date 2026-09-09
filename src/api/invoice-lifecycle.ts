/**
 * When an invoice may go back to draft, and when it may be destroyed.
 *
 * Both questions have the same answer underneath: an invoice that has touched
 * money is a financial record, not a document. It can be voided, and it can be
 * archived, but it cannot be un-issued and it cannot be deleted.
 *
 * The rule exists because the two routes together made a hole. PUT /:id lists
 * `status` in its allowlist and writes it verbatim, and DELETE /:id only ever
 * matched `status='draft'` — so Edit -> Status: Draft -> Delete hard-deleted a
 * settled invoice in two clicks, from a bulk toolbar, with the confirmation
 * warning shown on the first (no-op) attempt and not on the second
 * (destructive) one. `payments.invoice_id` carries no foreign key, so the
 * payment rows survived as un-joinable orphans, still counted by the payments
 * page and by revenue reporting, pointing at nothing.
 *
 * Pure on purpose: the caller does the counting, this decides. That keeps the
 * rule testable without a database and identical for every route that asks.
 */

/** What an invoice has already done with money. Counts come from the caller. */
export interface InvoiceFootprint {
  /** Rows in `payments` referencing this invoice, any status. */
  paymentCount?: number | null;
  /** Payments that succeeded or are still in flight — not failed/cancelled. */
  livePaymentCount?: number | null;
  /** Any Stripe PaymentIntent / charge id recorded against it. */
  processorRefCount?: number | null;
  /** Rows posted to the job cost ledger from this invoice, if any. */
  ledgerLineCount?: number | null;
}

/** The invoice columns this decision reads. */
export interface InvoiceRecord {
  status?: string | null;
  amount_paid_cents?: number | null;
  amount_paid?: number | null;
  paid_at?: string | null;
  sent_at?: string | null;
  voided_at?: string | null;
  stripe_payment_status?: string | null;
}

export type LifecycleDecision =
  | { ok: true }
  | { ok: false; reason: string; code: LifecycleRefusal };

export type LifecycleRefusal =
  | 'has_payments'
  | 'has_processor_reference'
  | 'has_posted_ledger'
  | 'amount_paid_recorded'
  | 'not_a_draft'
  | 'already_issued'
  | 'voided';

function n(v: unknown): number {
  const x = Math.trunc(Number(v) || 0);
  return x > 0 ? x : 0;
}

/**
 * Money already recorded against the invoice, in cents.
 *
 * amount_paid_cents is authoritative (migration 0058); amount_paid is the
 * legacy REAL dollars column, still the only value on rows written before it.
 * Read in that order — taking the float first reintroduces the rounding 0058
 * exists to remove, on a decision about whether a record may be destroyed.
 */
export function amountPaidCents(inv: InvoiceRecord | null | undefined): number {
  if (inv?.amount_paid_cents !== null && inv?.amount_paid_cents !== undefined) {
    return n(inv.amount_paid_cents);
  }
  return Math.round((Number(inv?.amount_paid) || 0) * 100);
}

/**
 * Has this invoice touched money in any way we can see?
 *
 * Deliberately generous: ANY signal counts. A false negative here deletes a
 * financial record; a false positive only means someone must void instead of
 * delete, which is the outcome we want in the ambiguous case anyway.
 */
export function financialFootprint(
  inv: InvoiceRecord | null | undefined,
  counts: InvoiceFootprint | null | undefined,
): LifecycleRefusal | null {
  if (n(counts?.livePaymentCount) > 0 || n(counts?.paymentCount) > 0) return 'has_payments';
  if (n(counts?.processorRefCount) > 0) return 'has_processor_reference';
  if (n(counts?.ledgerLineCount) > 0) return 'has_posted_ledger';
  if (amountPaidCents(inv) > 0) return 'amount_paid_recorded';
  if (inv?.paid_at) return 'amount_paid_recorded';
  // A Stripe status of any kind means a processor saw this invoice.
  if (String(inv?.stripe_payment_status || '').trim()) return 'has_processor_reference';
  return null;
}

const WHY: Record<LifecycleRefusal, string> = {
  has_payments: 'it has payments recorded against it',
  has_processor_reference: 'it has a payment-processor reference',
  has_posted_ledger: 'it has posted entries in the cost ledger',
  amount_paid_recorded: 'it has money recorded as paid',
  not_a_draft: 'it is not a draft',
  already_issued: 'it has already been issued',
  voided: 'it is voided',
};

/**
 * May this invoice be returned to `draft`?
 *
 * No, once it is financially active. Un-issuing a settled invoice is not an
 * edit — it is the first half of destroying it, and it also silently removes
 * the invoice from every collections and reporting view that filters on status.
 */
export function canReturnToDraft(
  inv: InvoiceRecord | null | undefined,
  counts: InvoiceFootprint | null | undefined,
): LifecycleDecision {
  const found = financialFootprint(inv, counts);
  if (found) {
    return {
      ok: false,
      code: found,
      reason: `This invoice cannot be returned to draft because ${WHY[found]}. Void it instead.`,
    };
  }
  if (String(inv?.status || '') === 'void' || inv?.voided_at) {
    return { ok: false, code: 'voided', reason: 'A voided invoice cannot be returned to draft.' };
  }
  return { ok: true };
}

/**
 * May this invoice be hard-deleted?
 *
 * Only an untouched draft. Everything else is voided or archived, with a
 * reason, so the record and its history survive.
 */
export function canHardDelete(
  inv: InvoiceRecord | null | undefined,
  counts: InvoiceFootprint | null | undefined,
): LifecycleDecision {
  const found = financialFootprint(inv, counts);
  if (found) {
    return {
      ok: false,
      code: found,
      reason: `This invoice cannot be deleted because ${WHY[found]}. Void it instead — the record and its history stay.`,
    };
  }
  if (String(inv?.status || '') !== 'draft') {
    return {
      ok: false,
      code: 'not_a_draft',
      reason: 'Only a draft invoice can be deleted. Void it instead.',
    };
  }
  // An issued draft is a contradiction, but sent_at is written independently of
  // status, so check the fact rather than trusting the label.
  if (inv?.sent_at) {
    return {
      ok: false,
      code: 'already_issued',
      reason: 'This invoice has been sent to the client and cannot be deleted. Void it instead.',
    };
  }
  return { ok: true };
}
