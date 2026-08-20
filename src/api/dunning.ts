/**
 * What happens when a payment fails.
 *
 * Previously: nothing. `payment_intent.payment_failed` was acknowledged and
 * logged, and the company found out by noticing an invoice was still unpaid —
 * which is not a signal, it is the absence of one.
 *
 * The policy, decided 2026-08-20 and deliberately narrow:
 *
 *   flag the invoice · email the client a pay-now link · notify the company
 *   NEVER re-charge the card automatically
 *
 * The no-retry part is the important half. Repeatedly re-attempting a declined
 * card racks up issuer decline ratios, can trigger card-network penalties, and
 * reads as harassment to the customer. It also means Groundwork would be making
 * a collections decision on the company's behalf, and the company is the
 * merchant of record now — that call is theirs.
 *
 * Autopay stays ENABLED. A single decline is usually a full card or a temporary
 * hold, and silently switching off a customer's autopay creates a second,
 * quieter failure nobody notices until the next invoice.
 */

export interface FailureContext {
  invoice_id: string;
  company_id: string;
  /** Stripe's own message. Empty when Stripe sent none. */
  reason: string;
  /** How many times this invoice has already failed, before this one. */
  prior_failures: number;
  /** Whether the invoice has a portal token, i.e. whether a pay link exists. */
  has_portal_token: boolean;
  /** Whether we hold an email address for the client. */
  client_email: string;
}

export interface FailureActions {
  /** Always true — the flag is the record that this happened. */
  flag_invoice: true;
  failure_count: number;
  /** A decline message safe to show a customer. */
  display_reason: string;
  notify_company: boolean;
  email_client: boolean;
  /** Why the client was not emailed, when they were not. Empty otherwise. */
  email_skipped_reason: string;
  /** Never true. Present so the decision is visible rather than implied. */
  retry_charge: false;
}

/**
 * Stripe decline messages are customer-facing already, but not always present.
 *
 * A raw code like `card_declined` tells a homeowner nothing, so an empty or
 * code-shaped reason becomes plain language instead. The specific message, when
 * Stripe gives one, is more useful than anything generic — "Your card has
 * insufficient funds" tells someone exactly what to do.
 */
export function displayReason(reason: string | null | undefined): string {
  const r = String(reason || '').trim();
  if (!r) return 'The payment did not go through.';
  // Snake-case with no spaces is an API code, not a sentence.
  if (/^[a-z0-9_]+$/.test(r)) return 'The payment did not go through.';
  return r;
}

/**
 * Decide what a failure triggers.
 *
 * Pure: no email is sent and no row is written here. The handler does that, and
 * this says what it should do — which is what makes "we never retry" testable
 * rather than a property of code nobody reads.
 */
export function decideFailureActions(ctx: FailureContext): FailureActions {
  const email = String(ctx.client_email || '').trim();

  let email_client = true;
  let email_skipped_reason = '';
  if (!email) {
    email_client = false;
    email_skipped_reason = 'no email address on file for this client';
  } else if (!ctx.has_portal_token) {
    // An email saying "your payment failed" with nowhere to pay is worse than
    // no email: it worries the customer and gives them nothing to do.
    email_client = false;
    email_skipped_reason = 'the invoice has no portal link to pay through';
  }

  return {
    flag_invoice: true,
    failure_count: Math.max(0, Math.trunc(Number(ctx.prior_failures) || 0)) + 1,
    display_reason: displayReason(ctx.reason),
    // The company is told every time, even when the client is not. A failure
    // they cannot see is the exact problem this replaces.
    notify_company: true,
    email_client,
    email_skipped_reason,
    retry_charge: false,
  };
}

/** Subject and body for the client email. Plain, short, one action. */
export function clientFailureEmail(args: {
  invoiceNumber: string;
  amountCents: number;
  payUrl: string;
  displayReason: string;
  companyName: string;
}): { subject: string; html: string } {
  const amount = (Math.max(0, Math.trunc(args.amountCents)) / 100).toFixed(2);
  const invoice = args.invoiceNumber || 'your invoice';
  return {
    subject: `Payment for ${invoice} didn't go through`,
    html: `
      <p>Hi,</p>
      <p>We tried to take the $${amount} payment for ${escapeHtml(invoice)} and it didn't go through.</p>
      <p>${escapeHtml(args.displayReason)}</p>
      <p><a href="${escapeHtml(args.payUrl)}">Pay ${escapeHtml(invoice)}</a></p>
      <p>Nothing has been charged. If you've already sorted this out, you can ignore this message.</p>
      <p>— ${escapeHtml(args.companyName || 'Your contractor')}</p>
    `.trim(),
  };
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Saved cards stranded by migration 0080 ──────────────────────────────────

/**
 * Does this client need to re-add their card?
 *
 * A card is attached to one Stripe account and cannot be charged by another.
 * Cards saved before 0080 carry `stripe_account_id = ''` — they live on the
 * platform, while charges now execute on the connected account — so they are
 * refused rather than attempted.
 *
 * Only true when there is something to lose: autopay on, a card stored, and a
 * connected account to move to. A company that never connected Stripe is not
 * asked to do anything.
 */
export function needsCardReCollection(
  autopay: { enabled?: number | boolean | null; stripe_pm_id?: string | null; stripe_account_id?: string | null } | null | undefined,
  targetAccount: string,
): boolean {
  if (!autopay) return false;
  const enabled = Number(autopay.enabled ?? 0) === 1 || autopay.enabled === true;
  const hasCard = !!String(autopay.stripe_pm_id || '').trim();
  const target = String(targetAccount || '').trim();
  if (!enabled || !hasCard || !target) return false;
  return String(autopay.stripe_account_id || '').trim() !== target;
}
