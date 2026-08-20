import { describe, it, expect } from 'vitest';
import {
  decideFailureActions, displayReason, clientFailureEmail, needsCardReCollection,
} from './dunning';

const base = {
  invoice_id: 'inv-1', company_id: 'avalon', reason: 'Your card was declined.',
  prior_failures: 0, has_portal_token: true, client_email: 'client@example.com',
};

describe('decideFailureActions', () => {
  it('DN-01 flags, emails the client and notifies the company', () => {
    const a = decideFailureActions(base);
    expect(a).toMatchObject({
      flag_invoice: true, failure_count: 1,
      notify_company: true, email_client: true, retry_charge: false,
    });
  });

  it('DN-02 NEVER retries the charge, under any circumstances', () => {
    // The decision that matters. Re-attempting a declined card raises issuer
    // decline ratios, can trigger card-network penalties, and reads as
    // harassment. It is also a collections decision, and the company is the
    // merchant of record — that call is theirs, not Groundwork's.
    for (const ctx of [
      base,
      { ...base, prior_failures: 5 },
      { ...base, client_email: '' },
      { ...base, has_portal_token: false },
      { ...base, reason: '' },
    ]) {
      expect(decideFailureActions(ctx).retry_charge, JSON.stringify(ctx)).toBe(false);
    }
  });

  it('DN-03 counts failures cumulatively', () => {
    expect(decideFailureActions({ ...base, prior_failures: 2 }).failure_count).toBe(3);
    expect(decideFailureActions({ ...base, prior_failures: -1 as any }).failure_count).toBe(1);
    expect(decideFailureActions({ ...base, prior_failures: NaN as any }).failure_count).toBe(1);
  });

  it('DN-04 the company is told even when the client cannot be', () => {
    // A failure nobody can see is the exact problem this replaces, so the
    // company notification is unconditional.
    const noEmail = decideFailureActions({ ...base, client_email: '' });
    expect(noEmail.notify_company).toBe(true);
    expect(noEmail.email_client).toBe(false);
    expect(noEmail.email_skipped_reason).toMatch(/no email address/);
  });

  it('DN-05 does not email when there is nowhere to pay', () => {
    // "Your payment failed" with no link is worse than silence: it worries the
    // customer and gives them nothing to do about it.
    const noLink = decideFailureActions({ ...base, has_portal_token: false });
    expect(noLink.email_client).toBe(false);
    expect(noLink.email_skipped_reason).toMatch(/no portal link/);
    expect(noLink.notify_company).toBe(true);
  });
});

describe('displayReason', () => {
  it('DN-06 keeps Stripe’s sentence, which is more useful than anything generic', () => {
    expect(displayReason('Your card has insufficient funds.')).toBe('Your card has insufficient funds.');
  });

  it('DN-07 replaces an API code with plain language', () => {
    // "card_declined" tells a homeowner nothing.
    for (const code of ['card_declined', 'insufficient_funds', 'expired_card']) {
      expect(displayReason(code)).toBe('The payment did not go through.');
    }
  });

  it('DN-08 handles an absent reason', () => {
    for (const r of ['', '   ', null, undefined]) {
      expect(displayReason(r as any)).toBe('The payment did not go through.');
    }
  });
});

describe('clientFailureEmail', () => {
  it('DN-09 states the amount, the reason and one action', () => {
    const e = clientFailureEmail({
      invoiceNumber: 'INV-0042', amountCents: 50_000,
      payUrl: 'https://groundwork-crm.com/invoices/portal/tok',
      displayReason: 'Your card was declined.', companyName: 'Avalon Landscape',
    });
    expect(e.subject).toBe("Payment for INV-0042 didn't go through");
    expect(e.html).toContain('$500.00');
    expect(e.html).toContain('Your card was declined.');
    expect(e.html).toContain('https://groundwork-crm.com/invoices/portal/tok');
  });

  it('DN-10 says nothing has been charged', () => {
    // The most common worry on receiving this email is "have I been charged
    // twice". Answering it unprompted saves a phone call.
    const e = clientFailureEmail({
      invoiceNumber: 'INV-1', amountCents: 100, payUrl: 'https://x', displayReason: 'x', companyName: 'Y',
    });
    expect(e.html).toMatch(/Nothing has been charged/);
  });

  it('DN-11 escapes company and invoice values into the HTML', () => {
    const e = clientFailureEmail({
      invoiceNumber: '<script>alert(1)</script>', amountCents: 100,
      payUrl: 'https://x?a=1&b=2', displayReason: 'ok', companyName: 'Bob & Sons',
    });
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;');
    expect(e.html).toContain('Bob &amp; Sons');
    expect(e.html).toContain('a=1&amp;b=2');
  });
});

describe('needsCardReCollection', () => {
  const ACCT = 'acct_connected';

  it('DN-12 a pre-0080 card on the platform needs re-adding', () => {
    // The stranded case: attached to the platform, charged on the connected
    // account, refused rather than attempted.
    expect(needsCardReCollection({ enabled: 1, stripe_pm_id: 'pm_1', stripe_account_id: '' }, ACCT)).toBe(true);
  });

  it('DN-13 a card already on the right account does not', () => {
    expect(needsCardReCollection({ enabled: 1, stripe_pm_id: 'pm_1', stripe_account_id: ACCT }, ACCT)).toBe(false);
  });

  it('DN-14 a card from a DIFFERENT connected account also needs re-adding', () => {
    expect(needsCardReCollection({ enabled: 1, stripe_pm_id: 'pm_1', stripe_account_id: 'acct_other' }, ACCT)).toBe(true);
  });

  it('DN-15 nobody is asked when there is nothing to lose', () => {
    // No autopay, no card, or no connected account to move to — asking a client
    // to re-add a card they never saved is noise that erodes every later prompt.
    expect(needsCardReCollection({ enabled: 0, stripe_pm_id: 'pm_1', stripe_account_id: '' }, ACCT)).toBe(false);
    expect(needsCardReCollection({ enabled: 1, stripe_pm_id: '', stripe_account_id: '' }, ACCT)).toBe(false);
    expect(needsCardReCollection({ enabled: 1, stripe_pm_id: 'pm_1', stripe_account_id: '' }, '')).toBe(false);
    expect(needsCardReCollection(null, ACCT)).toBe(false);
  });

  it('DN-16 accepts booleans as well as 0/1', () => {
    expect(needsCardReCollection({ enabled: true, stripe_pm_id: 'pm_1', stripe_account_id: '' }, ACCT)).toBe(true);
  });
});
