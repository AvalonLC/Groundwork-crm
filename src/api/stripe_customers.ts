/**
 * Which Stripe account a customer and a saved card belong to.
 *
 * Stripe customers and payment methods do not span accounts. A customer created
 * on the platform cannot be charged on a connected account, and a card attached
 * to one is unusable by the other. The codebase did not model that: it created
 * customers on the platform (`/v1/customers` with no Stripe-Account header) and
 * charged them on the connected account, so every saved-card charge failed with
 * "No such customer".
 *
 * The fix is not to rewrite the stored ids. It is to record which account each
 * one belongs to, and to treat a mismatch as "there isn't one" — which makes the
 * repair self-healing rather than a one-off backfill that a later tenant could
 * fall out of.
 *
 * The cost, stated where it is decided: a saved CARD cannot follow its customer
 * to a different account. Cards on legacy platform customers must be
 * re-collected. That is Stripe's model, not a choice made here.
 */

/** What the DB has stored for a client's Stripe customer. */
export interface StoredCustomer {
  /** '' when the client has never had one. */
  customer_id: string;
  /** '' for legacy rows created before migration 0080 — assumed platform. */
  account_id: string;
}

/** The account payments for this company should execute on. '' = not connected. */
export type TargetAccount = string;

export type CustomerDecision =
  | { action: 'reuse'; customer_id: string }
  | { action: 'create'; reason: 'none_stored' | 'wrong_account' };

/**
 * Decide whether a stored customer can be used against the target account.
 *
 * Legacy rows (`account_id === ''`) are treated as platform customers. When the
 * company IS connected, that is a mismatch and a new customer is created on the
 * connected account — the old row is left alone, not overwritten, so nothing is
 * lost if the mapping later turns out to matter.
 *
 * When the company is NOT connected, the target is the platform and a legacy
 * customer is exactly right. A tenant that never connected Stripe is unaffected
 * by any of this.
 */
export function decideCustomer(stored: StoredCustomer, target: TargetAccount): CustomerDecision {
  const customerId = String(stored?.customer_id || '').trim();
  if (!customerId) return { action: 'create', reason: 'none_stored' };

  const storedAccount = String(stored?.account_id || '').trim();
  // '' on both sides means platform-to-platform, which matches.
  if (storedAccount === String(target || '').trim()) return { action: 'reuse', customer_id: customerId };

  return { action: 'create', reason: 'wrong_account' };
}

/**
 * Is a saved payment method usable for a charge on the target account?
 *
 * Same rule, and deliberately a separate function: a customer can be recreated
 * transparently, but a card cannot. When this returns false the honest response
 * is to stop and ask for the card again, not to attempt a charge that Stripe
 * will reject.
 */
export function paymentMethodUsable(storedAccountId: string | null | undefined, target: TargetAccount): boolean {
  return String(storedAccountId || '').trim() === String(target || '').trim();
}

/**
 * Which account a company's payments should execute on.
 *
 * A company is only chargeable on its connected account once Stripe says the
 * account can actually take charges. `details_submitted` alone is not enough —
 * an account can have finished onboarding and still be restricted, in which case
 * Stripe refuses the charge and the customer sees a failure at the worst moment.
 *
 * Returns '' when the company is not connected or not ready, which means the
 * platform account and the existing pre-Connect behaviour.
 */
export function targetAccountFor(company: {
  stripe_account_id?: string | null;
  stripe_charges_enabled?: number | boolean | null;
  stripe_onboarded?: number | boolean | null;
} | null | undefined): TargetAccount {
  const acct = String(company?.stripe_account_id || '').trim();
  if (!acct) return '';
  const chargesEnabled = Number(company?.stripe_charges_enabled ?? 0) === 1 || company?.stripe_charges_enabled === true;
  const onboarded = Number(company?.stripe_onboarded ?? 0) === 1 || company?.stripe_onboarded === true;
  // charges_enabled is the authoritative signal; onboarded alone can be true for
  // an account Stripe has since restricted.
  return chargesEnabled && onboarded ? acct : '';
}

/**
 * The fee, in cents, from integer basis points.
 *
 * Replaces `Math.round(cents * pct / 100)` where pct was a REAL. 2.9 stored as a
 * float and multiplied out is exactly the arithmetic this schema forbids
 * everywhere else; 290 bps divided by 10,000 is exact.
 */
export function applicationFeeCents(amountCents: number, feeBps: number): number {
  const amount = Math.max(0, Math.trunc(Number(amountCents) || 0));
  const bps = Math.max(0, Math.trunc(Number(feeBps) || 0));
  return Math.round((amount * bps) / 10_000);
}
