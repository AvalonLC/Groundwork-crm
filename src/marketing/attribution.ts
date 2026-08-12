/**
 * Business-outcome attribution.
 *
 * The point of the whole module: connecting "we sent an email" to "we sold a
 * job". Mailchimp can tell you an open rate; it structurally cannot tell you
 * that the Tuesday irrigation campaign produced $18,400 of signed work,
 * because it has never seen the work orders.
 *
 * The inquiry row is written synchronously by the form handler. Everything
 * downstream — estimate, sale, payment — happens days or weeks later in parts
 * of the CRM that know nothing about marketing, so this walks the chain on a
 * schedule instead of trying to instrument every write path.
 *
 * Idempotent by construction: UNIQUE(campaign_id, entity_type, entity_id,
 * event) means re-walking the same jobs every night cannot double count. That
 * is what makes it safe to run on a best-effort scheduler that sometimes fires
 * twice or skips a day.
 *
 * Money stays INTEGER cents end to end — the *_cents columns are the source of
 * truth for every reader since stage 3a.
 */

import { randomToken } from './send';

const newId = (p: string) => `${p}_${randomToken(10)}`;

export interface RollupResult {
  estimates: number;
  sold: number;
  paid: number;
}

/**
 * Attribute downstream outcomes for every opportunity that came from a
 * campaign form submission.
 *
 * The join starts at marketing_form_submission because that row is the only
 * durable record that a given lead arrived through a specific campaign — the
 * opportunity itself carries only a free-text source.
 */
export async function rollupAttribution(
  db: D1Database,
  opts: { companyId?: string; limit?: number } = {},
): Promise<RollupResult> {
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 500));
  const binds: unknown[] = [];
  let scope = '';
  if (opts.companyId) {
    scope = ' AND s.company_id = ?';
    binds.push(opts.companyId);
  }

  const rows = await db
    .prepare(
      `SELECT s.company_id, s.campaign_id, s.recipient_id, s.opportunity_id,
              o.estimate_amount_cents, o.estimate_count, o.sold_date, o.sold_amount_cents,
              o.updated_at
         FROM marketing_form_submission s
         JOIN opportunities o ON o.id = s.opportunity_id AND o.company_id = s.company_id
        WHERE COALESCE(s.campaign_id,'') <> ''
          AND COALESCE(s.opportunity_id,'') <> ''${scope}
        ORDER BY s.created_at DESC
        LIMIT ${limit}`,
    )
    .bind(...binds)
    .all<{
      company_id: string;
      campaign_id: string;
      recipient_id: string | null;
      opportunity_id: string;
      estimate_amount_cents: number | null;
      estimate_count: number | null;
      sold_date: string | null;
      sold_amount_cents: number | null;
      updated_at: string | null;
    }>();

  const result: RollupResult = { estimates: 0, sold: 0, paid: 0 };

  const write = async (
    companyId: string,
    campaignId: string,
    recipientId: string | null,
    entityType: string,
    entityId: string,
    event: string,
    amountCents: number,
    occurredAt: string,
  ): Promise<boolean> => {
    const res = await db
      .prepare(
        `INSERT INTO marketing_attribution
           (id, company_id, campaign_id, recipient_id, entity_type, entity_id, event, amount_cents, occurred_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(campaign_id, entity_type, entity_id, event) DO NOTHING`,
      )
      .bind(
        newId('attr'), companyId, campaignId, recipientId,
        entityType, entityId, event, Math.round(amountCents), occurredAt,
      )
      .run();
    return (res.meta?.changes ?? 0) > 0;
  };

  for (const r of rows.results ?? []) {
    const now = new Date().toISOString();

    const estimateCents = Number(r.estimate_amount_cents ?? 0);
    if (estimateCents > 0 || Number(r.estimate_count ?? 0) > 0) {
      if (
        await write(
          r.company_id, r.campaign_id, r.recipient_id,
          'opportunity', r.opportunity_id, 'estimate_created',
          estimateCents, r.updated_at ?? now,
        )
      ) {
        result.estimates += 1;
      }
    }

    if (r.sold_date) {
      if (
        await write(
          r.company_id, r.campaign_id, r.recipient_id,
          'opportunity', r.opportunity_id, 'job_sold',
          Number(r.sold_amount_cents ?? 0), r.sold_date,
        )
      ) {
        result.sold += 1;
      }
    }

    // Paid invoices, matched through the opportunity's client. Only invoices
    // raised after the inquiry count — an invoice that predates the campaign
    // was not caused by it.
    const invoices = await db
      .prepare(
        `SELECT i.id, i.amount_paid_cents, i.paid_at
           FROM invoices i
           JOIN opportunities o ON o.client_id = i.client_id AND o.company_id = i.company_id
          WHERE o.id = ? AND i.company_id = ?
            AND COALESCE(i.paid_at,'') <> ''
            AND COALESCE(i.amount_paid_cents,0) > 0
          LIMIT 50`,
      )
      .bind(r.opportunity_id, r.company_id)
      .all<{ id: string; amount_paid_cents: number; paid_at: string }>();

    for (const inv of invoices.results ?? []) {
      if (
        await write(
          r.company_id, r.campaign_id, r.recipient_id,
          'invoice', inv.id, 'invoice_paid',
          Number(inv.amount_paid_cents ?? 0), inv.paid_at,
        )
      ) {
        result.paid += 1;
      }
    }
  }

  return result;
}
