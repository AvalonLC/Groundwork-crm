/**
 * Scheduled drain endpoint, mounted at /internal/cron.
 *
 * Cloudflare Pages has no native cron triggers, so an external scheduler
 * (.github/workflows/marketing-cron.yml) POSTs here, exactly as Finance OS
 * does for its nightly rollup (src/api/cron-trigger.ts).
 *
 * Auth is the same shared secret header — no human is logged in when a
 * scheduler calls, so there is no session cookie to check. It fails closed: if
 * CRON_SECRET is not configured, every request is rejected rather than
 * silently allowed through.
 *
 * GitHub Actions cron is best-effort and frequently runs several minutes late.
 * That is tolerable because the approving request already kicked off the first
 * batches through waitUntil; this endpoint is the safety net that finishes a
 * long send and picks up anything a dead worker left behind.
 */

import { Hono } from 'hono';
import { SendGridProvider } from './providers/sendgrid';
import { drainCampaign, listDrainableCampaigns } from './send';

export type MarketingCronBindings = {
  DB: D1Database;
  CRON_SECRET?: string;
  SENDGRID_API_KEY?: string;
};

export const marketingCronRouter = new Hono<{ Bindings: MarketingCronBindings }>();

/**
 * Pre-auth diagnostic, mirroring /internal/cron/rollup/status: lets Tyler
 * confirm the Pages side is configured before the two secret values are known
 * to match. Reveals booleans only, never a secret or any tenant data.
 */
marketingCronRouter.get('/marketing-drain/status', (c) =>
  c.json({
    cron_secret_configured: !!c.env.CRON_SECRET,
    sendgrid_configured: !!c.env.SENDGRID_API_KEY,
  }),
);

marketingCronRouter.post('/marketing-drain', async (c) => {
  const configured = c.env.CRON_SECRET;
  if (!configured) {
    return c.json({ error: 'CRON_SECRET is not configured — refusing all requests until it is' }, 503);
  }
  if (c.req.header('X-Cron-Secret') !== configured) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const apiKey = c.env.SENDGRID_API_KEY;
  if (!apiKey) return c.json({ error: 'SENDGRID_API_KEY is not configured' }, 503);

  const origin = new URL(c.req.url).origin;
  const provider = new SendGridProvider(apiKey);

  // Bounded work per invocation. The CPU budget is ~30s and each batch is a
  // network round trip, so this walks a few campaigns and leaves the rest for
  // the next tick rather than being killed mid-batch.
  const campaigns = await listDrainableCampaigns(c.env.DB, Number(c.req.query('campaigns') ?? 3));
  const results: Array<Record<string, unknown>> = [];

  for (const campaign of campaigns) {
    const result = await drainCampaign(c.env.DB, provider, {
      companyId: campaign.company_id,
      campaignId: campaign.id,
      origin,
      maxBatches: Number(c.req.query('batches') ?? 3),
    });
    results.push({ campaign_id: campaign.id, ...result });
  }

  return c.json({ drained: results.length, results });
});
