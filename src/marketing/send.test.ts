/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  addSuppression,
  drainCampaign,
  isSuppressed,
  listDrainableCampaigns,
  randomToken,
  reapStalled,
  snapshotAudience,
  MAX_ATTEMPTS,
} from './send';
import type { EmailProvider, SendBatchInput, SendBatchResult } from './providers/types';

const db = () => env.DB;
const CO = 'co-send';
const CAMPAIGN = 'camp-send';
const ORIGIN = 'https://groundwork-crm.com';

// ── a provider that records what it was asked to send ────────────────────────

class FakeProvider implements EmailProvider {
  readonly name = 'fake';
  readonly batches: SendBatchInput[] = [];
  next: SendBatchResult[] = [];

  async sendBatch(input: SendBatchInput): Promise<SendBatchResult> {
    this.batches.push(input);
    return this.next.shift() ?? { ok: true, status: 202, providerMessageId: `msg-${this.batches.length}` };
  }
  async verifyWebhook() { return null; }
  async createDomainAuth() { return { ok: true, providerDomainId: '1', records: [] }; }
  async validateDomainAuth() { return { ok: true, verified: true }; }

  get allRecipients(): string[] {
    return this.batches.flatMap((b) => b.messages.map((m) => m.to));
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const seedClient = (n: number) =>
  db()
    .prepare(`INSERT INTO clients (id, company_id, name, email, type, status) VALUES (?,?,?,?,?,?)`)
    .bind(`cl-${n}`, CO, `Client ${n}`, `client${n}@example.com`, 'Residential', 'active')
    .run();

const seedCampaign = async (over: Record<string, string> = {}) => {
  await db()
    .prepare(
      `INSERT INTO marketing_campaign
         (id, company_id, name, status, subject, from_email, from_name, reply_to,
          rendered_html, rendered_text)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      CAMPAIGN, CO, 'Fall cleanup',
      over.status ?? 'scheduled',
      'Book your fall cleanup',
      'hello@avalon-lc.com', 'Avalon', 'office@avalon-lc.com',
      over.rendered_html ?? '<html>-firstName- <a href="-trackBase-/lnk_1">go</a> -unsubUrl-</html>',
      over.rendered_text ?? 'hi -firstName-',
    )
    .run();
};

const statuses = async (): Promise<Record<string, number>> => {
  const res = await db()
    .prepare(`SELECT status, COUNT(*) AS n FROM marketing_campaign_recipient WHERE campaign_id = ? GROUP BY status`)
    .bind(CAMPAIGN)
    .all<{ status: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[r.status] = Number(r.n);
  return out;
};

const campaignStatus = async (): Promise<string> => {
  const r = await db().prepare(`SELECT status FROM marketing_campaign WHERE id = ?`).bind(CAMPAIGN).first<{ status: string }>();
  return r?.status ?? '';
};

const wipe = async () => {
  for (const t of [
    'marketing_campaign_recipient', 'marketing_campaign', 'marketing_suppression',
    'marketing_email_event', 'clients', 'client_contacts',
  ]) {
    await db().prepare(`DELETE FROM ${t}`).run();
  }
};

beforeEach(wipe);

// ── tokens ───────────────────────────────────────────────────────────────────

describe('randomToken', () => {
  it('produces distinct hex of the requested length', () => {
    const a = randomToken(16);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(randomToken(16));
    expect(randomToken(8)).toHaveLength(16);
  });
});

// ── suppression ──────────────────────────────────────────────────────────────

describe('suppression list', () => {
  it('normalizes the address and is idempotent on repeat', async () => {
    await addSuppression(db(), CO, '  Dana@Example.COM ', 'unsubscribe');
    await addSuppression(db(), CO, 'dana@example.com', 'hard_bounce');
    const rows = await db()
      .prepare(`SELECT email, reason FROM marketing_suppression WHERE company_id = ?`)
      .bind(CO)
      .all<{ email: string; reason: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]!.email).toBe('dana@example.com');
    // First reason wins; a duplicate webhook must not rewrite history.
    expect(rows.results![0]!.reason).toBe('unsubscribe');
    expect(await isSuppressed(db(), CO, 'DANA@example.com')).toBe(true);
  });

  it('is scoped per company', async () => {
    await addSuppression(db(), CO, 'dana@example.com', 'unsubscribe');
    expect(await isSuppressed(db(), 'other-co', 'dana@example.com')).toBe(false);
  });

  it('ignores an empty address', async () => {
    await addSuppression(db(), CO, '   ', 'manual');
    const r = await db().prepare(`SELECT COUNT(*) AS n FROM marketing_suppression`).first<{ n: number }>();
    expect(Number(r?.n)).toBe(0);
  });
});

// ── snapshot ─────────────────────────────────────────────────────────────────

describe('snapshotAudience', () => {
  it('freezes the audience and assigns batch numbers', async () => {
    for (let i = 1; i <= 5; i += 1) await seedClient(i);
    await seedCampaign();

    const res = await snapshotAudience(db(), {
      companyId: CO, campaignId: CAMPAIGN, filter: { match: 'all', rules: [] }, batchSize: 2,
    });
    expect(res.recipients).toBe(5);
    expect(res.batches).toBe(3);

    const rows = await db()
      .prepare(`SELECT batch_no, COUNT(*) AS n FROM marketing_campaign_recipient WHERE campaign_id = ? GROUP BY batch_no ORDER BY batch_no`)
      .bind(CAMPAIGN)
      .all<{ batch_no: number; n: number }>();
    expect((rows.results ?? []).map((r) => Number(r.n))).toEqual([2, 2, 1]);
  });

  it('gives every recipient distinct unsubscribe and tracking tokens', async () => {
    for (let i = 1; i <= 4; i += 1) await seedClient(i);
    await seedCampaign();
    await snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter: { match: 'all', rules: [] } });

    const rows = await db()
      .prepare(`SELECT unsub_token, track_token FROM marketing_campaign_recipient WHERE campaign_id = ?`)
      .bind(CAMPAIGN)
      .all<{ unsub_token: string; track_token: string }>();
    const all = (rows.results ?? []).flatMap((r) => [r.unsub_token, r.track_token]);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((t) => /^[0-9a-f]{32}$/.test(t))).toBe(true);
  });

  it('excludes suppressed addresses and records how many', async () => {
    for (let i = 1; i <= 3; i += 1) await seedClient(i);
    await addSuppression(db(), CO, 'client2@example.com', 'unsubscribe');
    await seedCampaign();

    const res = await snapshotAudience(db(), {
      companyId: CO, campaignId: CAMPAIGN, filter: { match: 'all', rules: [] },
    });
    expect(res.recipients).toBe(2);
    expect(res.suppressed).toBe(1);

    const row = await db()
      .prepare(`SELECT recipient_count, suppressed_count FROM marketing_campaign WHERE id = ?`)
      .bind(CAMPAIGN)
      .first<{ recipient_count: number; suppressed_count: number }>();
    expect(Number(row?.recipient_count)).toBe(2);
    expect(Number(row?.suppressed_count)).toBe(1);
  });

  it('replaces a previous snapshot rather than accumulating ghosts', async () => {
    for (let i = 1; i <= 3; i += 1) await seedClient(i);
    await seedCampaign();
    const filter = { match: 'all', rules: [] };
    await snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter });
    const second = await snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter });
    expect(second.recipients).toBe(3);
    const r = await db()
      .prepare(`SELECT COUNT(*) AS n FROM marketing_campaign_recipient WHERE campaign_id = ?`)
      .bind(CAMPAIGN)
      .first<{ n: number }>();
    expect(Number(r?.n)).toBe(3);
  });

  it('refuses to re-snapshot once anything has been sent', async () => {
    for (let i = 1; i <= 2; i += 1) await seedClient(i);
    await seedCampaign();
    const filter = { match: 'all', rules: [] };
    await snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter });
    await db().prepare(`UPDATE marketing_campaign_recipient SET status='sent' WHERE campaign_id = ?`).bind(CAMPAIGN).run();

    await expect(
      snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter }),
    ).rejects.toThrow(/already started sending/);
  });
});

// ── drain ────────────────────────────────────────────────────────────────────

describe('drainCampaign', () => {
  const setup = async (n: number, batchSize = 2) => {
    for (let i = 1; i <= n; i += 1) await seedClient(i);
    await seedCampaign();
    await snapshotAudience(db(), {
      companyId: CO, campaignId: CAMPAIGN, filter: { match: 'all', rules: [] }, batchSize,
    });
  };

  it('sends every recipient exactly once across batches', async () => {
    await setup(5, 2);
    const p = new FakeProvider();
    const res = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN, maxBatches: 10 });

    expect(res.sent).toBe(5);
    expect(res.complete).toBe(true);
    expect(p.batches).toHaveLength(3);
    expect(p.allRecipients).toHaveLength(5);
    expect(new Set(p.allRecipients).size).toBe(5);
    expect(await campaignStatus()).toBe('sent');
    expect(await statuses()).toEqual({ sent: 5 });
  });

  it('resumes where it stopped when the batch budget runs out', async () => {
    await setup(6, 2);
    const p = new FakeProvider();

    const first = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN, maxBatches: 1 });
    expect(first.sent).toBe(2);
    expect(first.complete).toBe(false);
    expect(first.remaining).toBe(4);

    const second = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN, maxBatches: 10 });
    expect(second.sent).toBe(4);
    expect(second.complete).toBe(true);
    // Nobody was sent twice across the two invocations.
    expect(new Set(p.allRecipients).size).toBe(6);
  });

  it('is a no-op once the campaign is complete', async () => {
    await setup(2, 10);
    const p = new FakeProvider();
    await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN });
    const again = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN });
    expect(again.sent).toBe(0);
    expect(again.errors.join(' ')).toContain('nothing to drain');
    expect(p.batches).toHaveLength(1);
  });

  it('skips someone who unsubscribed after the snapshot was taken', async () => {
    await setup(4, 10);
    // The snapshot is already frozen; this is the mid-send unsubscribe.
    await addSuppression(db(), CO, 'client3@example.com', 'unsubscribe');

    const p = new FakeProvider();
    const res = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN });

    expect(res.suppressed).toBe(1);
    expect(res.sent).toBe(3);
    expect(p.allRecipients).not.toContain('client3@example.com');
    expect((await statuses()).suppressed).toBe(1);
  });

  it('never contacts the provider when the whole batch is suppressed', async () => {
    await setup(2, 10);
    await addSuppression(db(), CO, 'client1@example.com', 'unsubscribe');
    await addSuppression(db(), CO, 'client2@example.com', 'hard_bounce');

    const p = new FakeProvider();
    const res = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN });
    expect(p.batches).toHaveLength(0);
    expect(res.sent).toBe(0);
    expect(res.suppressed).toBe(2);
  });

  it('builds per-recipient substitutions and one-click unsubscribe headers', async () => {
    await setup(1, 10);
    const p = new FakeProvider();
    await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN });

    const m = p.batches[0]!.messages[0]!;
    expect(m.substitutions['-firstName-']).toBe('Client');
    expect(m.substitutions['-unsubUrl-']).toMatch(new RegExp(`^${ORIGIN}/u/[0-9a-f]{32}$`));
    expect(m.substitutions['-trackBase-']).toMatch(new RegExp(`^${ORIGIN}/c/[0-9a-f]{32}$`));
    expect(m.customArgs).toEqual({ campaign_id: CAMPAIGN, recipient_id: expect.any(String), company_id: CO });
    expect(m.headers!['List-Unsubscribe']).toContain(m.substitutions['-unsubUrl-']!);
    expect(m.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // The body is rendered once for the batch, not per recipient.
    expect(p.batches[0]!.html).toContain('-firstName-');
  });

  it('re-queues a batch the provider throttled and stops for this pass', async () => {
    await setup(4, 2);
    const p = new FakeProvider();
    p.next = [{ ok: false, status: 429, providerMessageId: '', error: 'too many requests', retryable: true }];

    const res = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN, maxBatches: 10 });
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(0);
    // Backs off instead of hammering the provider with the remaining batches.
    expect(p.batches).toHaveLength(1);
    expect((await statuses()).queued).toBe(4);

    const retry = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN, maxBatches: 10 });
    expect(retry.sent).toBe(4);
    expect(retry.complete).toBe(true);
  });

  it('fails a batch outright when the provider rejects it permanently', async () => {
    await setup(2, 10);
    const p = new FakeProvider();
    p.next = [{ ok: false, status: 400, providerMessageId: '', error: 'bad payload', retryable: false }];

    const res = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN });
    expect(res.failed).toBe(2);
    expect((await statuses()).failed).toBe(2);
    const row = await db()
      .prepare(`SELECT error FROM marketing_campaign_recipient WHERE campaign_id = ? LIMIT 1`)
      .bind(CAMPAIGN)
      .first<{ error: string }>();
    expect(row?.error).toContain('bad payload');
  });

  it('gives up on a batch that keeps failing instead of cycling forever', async () => {
    await setup(2, 10);
    const p = new FakeProvider();
    const throttle = { ok: false, status: 429, providerMessageId: '', error: 'slow down', retryable: true };
    for (let i = 0; i < MAX_ATTEMPTS + 1; i += 1) {
      p.next = [{ ...throttle }];
      await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN });
    }
    expect((await statuses()).failed).toBe(2);
  });

  it('refuses to send a campaign that was never rendered', async () => {
    for (let i = 1; i <= 2; i += 1) await seedClient(i);
    await seedCampaign({ rendered_html: '' });
    await snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter: { match: 'all', rules: [] } });

    const p = new FakeProvider();
    const res = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN });
    expect(res.errors.join(' ')).toContain('no rendered html');
    expect(p.batches).toHaveLength(0);
  });

  it('will not drain another company campaign', async () => {
    await setup(2, 10);
    const p = new FakeProvider();
    const res = await drainCampaign(db(), p, { companyId: 'someone-else', campaignId: CAMPAIGN, origin: ORIGIN });
    expect(res.errors).toContain('campaign not found');
    expect(p.batches).toHaveLength(0);
  });
});

// ── reaper ───────────────────────────────────────────────────────────────────

describe('reapStalled', () => {
  const claimLongAgo = async (minutes: number, attempts = 1) => {
    const when = new Date(Date.now() - minutes * 60_000).toISOString();
    await db()
      .prepare(`UPDATE marketing_campaign_recipient SET status='sending', claimed_at=?, attempts=? WHERE campaign_id=?`)
      .bind(when, attempts, CAMPAIGN)
      .run();
  };

  beforeEach(async () => {
    for (let i = 1; i <= 2; i += 1) await seedClient(i);
    await seedCampaign();
    await snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter: { match: 'all', rules: [] } });
  });

  it('returns rows whose worker died back to the queue', async () => {
    await claimLongAgo(30);
    expect(await reapStalled(db(), CAMPAIGN)).toBe(2);
    expect((await statuses()).queued).toBe(2);
  });

  it('leaves a claim that is still fresh alone', async () => {
    await claimLongAgo(1);
    expect(await reapStalled(db(), CAMPAIGN)).toBe(0);
    expect((await statuses()).sending).toBe(2);
  });

  it('fails rows that have already been reclaimed too many times', async () => {
    await claimLongAgo(30, MAX_ATTEMPTS);
    await reapStalled(db(), CAMPAIGN);
    expect((await statuses()).failed).toBe(2);
  });

  it('lets a drain finish a campaign that had stalled rows', async () => {
    await claimLongAgo(30);
    const p = new FakeProvider();
    const res = await drainCampaign(db(), p, { companyId: CO, campaignId: CAMPAIGN, origin: ORIGIN });
    expect(res.sent).toBe(2);
    expect(res.complete).toBe(true);
  });
});

// ── scheduler support ────────────────────────────────────────────────────────

describe('listDrainableCampaigns', () => {
  it('lists campaigns mid-send and scheduled ones whose time has come', async () => {
    for (let i = 1; i <= 2; i += 1) await seedClient(i);
    await seedCampaign({ status: 'sending' });
    await snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter: { match: 'all', rules: [] } });

    const list = await listDrainableCampaigns(db());
    expect(list.map((c) => c.id)).toContain(CAMPAIGN);
  });

  it('ignores a campaign scheduled for the future', async () => {
    for (let i = 1; i <= 2; i += 1) await seedClient(i);
    await seedCampaign({ status: 'scheduled' });
    await snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter: { match: 'all', rules: [] } });
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await db().prepare(`UPDATE marketing_campaign SET scheduled_at=? WHERE id=?`).bind(later, CAMPAIGN).run();

    expect(await listDrainableCampaigns(db())).toEqual([]);
  });

  it('ignores a campaign with nothing left to send', async () => {
    for (let i = 1; i <= 2; i += 1) await seedClient(i);
    await seedCampaign({ status: 'sending' });
    await snapshotAudience(db(), { companyId: CO, campaignId: CAMPAIGN, filter: { match: 'all', rules: [] } });
    await db().prepare(`UPDATE marketing_campaign_recipient SET status='sent' WHERE campaign_id=?`).bind(CAMPAIGN).run();

    expect(await listDrainableCampaigns(db())).toEqual([]);
  });
});
