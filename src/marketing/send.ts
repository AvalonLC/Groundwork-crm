/**
 * Send pipeline: snapshot, drain, reap.
 *
 * Shaped by three facts about the runtime. Cloudflare Pages has no native cron
 * triggers, this project has no Queues binding, and a request gets roughly 30
 * seconds of CPU. So a campaign is not "sent" by one long-running call — it is
 * frozen into rows and then drained a batch at a time by whoever calls next:
 * the approving request via waitUntil, then a scheduled POST to
 * /internal/cron/marketing-drain.
 *
 * The ordering rule that makes this safe to run concurrently is that the drain
 * is the ONLY writer of status='sent'. A batch is claimed with a conditional
 * UPDATE before anything is handed to the provider, so two overlapping drains
 * cannot both claim the same rows.
 *
 * SUPPRESSION IS CHECKED THREE TIMES: when the audience is counted, when it is
 * snapshotted, and immediately before each batch leaves. Only the last is
 * authoritative — a large send drains over many minutes and someone can
 * unsubscribe in the middle of it.
 */

import { compileAudience, compileSuppressedCount, splitName } from './audience';
import type { EmailProvider, OutboundMessage, SendBatchInput } from './providers/types';

export const DEFAULT_BATCH_SIZE = 250;
/** Provider ceiling; SendGrid accepts 1000 personalizations per call. */
const MAX_SAFE_BATCH = 1000;
/** A batch reclaimed this many times is failed rather than cycled forever. */
export const MAX_ATTEMPTS = 3;
/** A row claimed longer ago than this had its worker die mid-batch. */
export const STALE_CLAIM_MINUTES = 10;

export type SuppressionReason = 'unsubscribe' | 'hard_bounce' | 'complaint' | 'manual' | 'invalid';

// ── tokens ───────────────────────────────────────────────────────────────────

/**
 * Per-recipient secrets that appear in a URL. 16 bytes of CSPRNG output, hex
 * encoded: enough that an unsubscribe or click token cannot be guessed for
 * someone else, which is the whole reason they are not row ids.
 */
export function randomToken(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function newId(prefix: string): string {
  return `${prefix}_${randomToken(10)}`;
}

const nowIso = () => new Date().toISOString();

// ── suppression ──────────────────────────────────────────────────────────────

/**
 * Add an address to the suppression list. Idempotent: the UNIQUE index on
 * (company_id, email) means a repeat is a no-op rather than an error, which
 * matters because webhook events arrive more than once by design.
 */
export async function addSuppression(
  db: D1Database,
  companyId: string,
  email: string,
  reason: SuppressionReason,
  opts: { campaignId?: string; contactId?: string; clientId?: string; note?: string } = {},
): Promise<void> {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) return;
  await db
    .prepare(
      `INSERT INTO marketing_suppression
         (id, company_id, email, contact_id, client_id, reason, source_campaign_id, note)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(company_id, email) DO NOTHING`,
    )
    .bind(
      newId('sup'), companyId, normalized,
      opts.contactId ?? null, opts.clientId ?? null,
      reason, opts.campaignId ?? null, opts.note ?? '',
    )
    .run();
}

export async function isSuppressed(db: D1Database, companyId: string, email: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM marketing_suppression WHERE company_id = ? AND email = ? LIMIT 1`)
    .bind(companyId, String(email ?? '').trim().toLowerCase())
    .first<{ x: number }>();
  return !!row;
}

// ── snapshot ─────────────────────────────────────────────────────────────────

export interface SnapshotResult {
  recipients: number;
  suppressed: number;
  batches: number;
  warnings: string[];
}

interface AudienceRow {
  email: string;
  full_name: string | null;
  contact_id: string | null;
  client_id: string | null;
  opportunity_id: string | null;
}

/**
 * Freeze the audience into marketing_campaign_recipient.
 *
 * After this runs the audience query is never consulted again for this
 * campaign: who was in the list at approve time is who receives the email,
 * even if a client is edited or deleted while the send drains. Recomputing
 * mid-send is how people get a second copy.
 *
 * Replaces any previous snapshot for the campaign, so an operator who backs
 * out of review and edits the audience does not accumulate ghosts. Refuses to
 * do that once anything has actually been sent.
 */
export async function snapshotAudience(
  db: D1Database,
  args: { companyId: string; campaignId: string; filter: unknown; batchSize?: number },
): Promise<SnapshotResult> {
  const { companyId, campaignId } = args;
  const batchSize = Math.max(1, Math.min(MAX_SAFE_BATCH, args.batchSize ?? DEFAULT_BATCH_SIZE));

  const already = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM marketing_campaign_recipient
       WHERE campaign_id = ? AND status NOT IN ('queued','suppressed')`,
    )
    .bind(campaignId)
    .first<{ n: number }>();
  if (Number(already?.n ?? 0) > 0) {
    throw new Error('campaign has already started sending — refusing to re-snapshot the audience');
  }

  await db.prepare(`DELETE FROM marketing_campaign_recipient WHERE campaign_id = ?`).bind(campaignId).run();

  const compiled = compileAudience(companyId, args.filter);
  const res = await db.prepare(compiled.sql).bind(...compiled.binds).all<AudienceRow>();
  const rows = res.results ?? [];

  const suppressedCompiled = compileSuppressedCount(companyId, args.filter);
  const suppressedRow = await db
    .prepare(suppressedCompiled.sql)
    .bind(...suppressedCompiled.binds)
    .first<{ n: number }>();

  const statements: D1PreparedStatement[] = [];
  rows.forEach((row, index) => {
    const { first, last } = splitName(row.full_name ?? '');
    statements.push(
      db
        .prepare(
          `INSERT INTO marketing_campaign_recipient
             (id, company_id, campaign_id, contact_id, client_id, opportunity_id,
              email, first_name, last_name, unsub_token, track_token, batch_no, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued')
           ON CONFLICT(campaign_id, email) DO NOTHING`,
        )
        .bind(
          newId('rcpt'), companyId, campaignId,
          row.contact_id, row.client_id, row.opportunity_id,
          row.email, first, last,
          randomToken(16), randomToken(16),
          Math.floor(index / batchSize),
        ),
    );
  });

  // D1 caps how much one batch() can carry; 100 statements per call is safe.
  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100));
  }

  const recipients = rows.length;
  const suppressed = Number(suppressedRow?.n ?? 0);
  const batches = Math.ceil(recipients / batchSize);

  await db
    .prepare(
      `UPDATE marketing_campaign
         SET recipient_count = ?, suppressed_count = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(recipients, suppressed, nowIso(), campaignId, companyId)
    .run();

  return { recipients, suppressed, batches, warnings: compiled.warnings };
}

// ── reaper ───────────────────────────────────────────────────────────────────

/**
 * Return rows whose claim went stale to the queue. A worker that is evicted
 * after claiming a batch but before recording the result leaves rows in
 * 'sending' forever; without this the campaign stalls short of its last batch
 * and nobody finds out until someone asks why the report is short.
 */
export async function reapStalled(
  db: D1Database,
  campaignId: string,
  staleMinutes = STALE_CLAIM_MINUTES,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const res = await db
    .prepare(
      `UPDATE marketing_campaign_recipient
         SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
             error = CASE WHEN attempts >= ? THEN 'abandoned after repeated stalled claims' ELSE error END,
             claimed_at = NULL
       WHERE campaign_id = ? AND status = 'sending'
         AND coalesce(claimed_at, '') <> '' AND claimed_at < ?`,
    )
    .bind(MAX_ATTEMPTS, MAX_ATTEMPTS, campaignId, cutoff)
    .run();
  return res.meta?.changes ?? 0;
}

// ── drain ────────────────────────────────────────────────────────────────────

export interface DrainOptions {
  companyId: string;
  campaignId: string;
  /** Absolute origin for unsubscribe and click URLs, no trailing slash. */
  origin: string;
  /** Batches to attempt in this invocation. Bounded by the CPU budget. */
  maxBatches?: number;
}

export interface DrainResult {
  sent: number;
  failed: number;
  suppressed: number;
  batchesProcessed: number;
  remaining: number;
  complete: boolean;
  errors: string[];
}

interface CampaignRow {
  id: string;
  company_id: string;
  status: string;
  subject: string;
  from_email: string;
  from_name: string;
  reply_to: string;
  rendered_html: string;
  rendered_text: string;
}

interface RecipientRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  unsub_token: string;
  track_token: string;
  attempts: number;
}

/**
 * Send the next queued batches for a campaign.
 *
 * Safe to call concurrently and safe to call again after a crash: batches are
 * claimed with a conditional UPDATE, and a claim that goes stale is reaped
 * back to the queue rather than lost.
 */
export async function drainCampaign(
  db: D1Database,
  provider: EmailProvider,
  opts: DrainOptions,
): Promise<DrainResult> {
  const { companyId, campaignId, origin } = opts;
  const maxBatches = Math.max(1, Math.min(20, opts.maxBatches ?? 4));
  const result: DrainResult = {
    sent: 0, failed: 0, suppressed: 0, batchesProcessed: 0,
    remaining: 0, complete: false, errors: [],
  };

  const campaign = await db
    .prepare(`SELECT * FROM marketing_campaign WHERE id = ? AND company_id = ? LIMIT 1`)
    .bind(campaignId, companyId)
    .first<CampaignRow>();
  if (!campaign) {
    result.errors.push('campaign not found');
    return result;
  }
  if (!['scheduled', 'sending'].includes(campaign.status)) {
    result.errors.push(`campaign status is "${campaign.status}" — nothing to drain`);
    return result;
  }
  if (!campaign.rendered_html) {
    result.errors.push('campaign has no rendered html — approve it first');
    return result;
  }

  await db
    .prepare(
      `UPDATE marketing_campaign
         SET status = 'sending', send_started_at = coalesce(send_started_at, ?), updated_at = ?
       WHERE id = ?`,
    )
    .bind(nowIso(), nowIso(), campaignId)
    .run();

  await reapStalled(db, campaignId);

  for (let n = 0; n < maxBatches; n += 1) {
    const next = await db
      .prepare(
        `SELECT batch_no FROM marketing_campaign_recipient
         WHERE campaign_id = ? AND status = 'queued'
         ORDER BY batch_no LIMIT 1`,
      )
      .bind(campaignId)
      .first<{ batch_no: number }>();
    if (!next) break;

    const batchNo = Number(next.batch_no);
    const claimedAt = nowIso();
    const claim = await db
      .prepare(
        `UPDATE marketing_campaign_recipient
           SET status = 'sending', claimed_at = ?, attempts = attempts + 1
         WHERE campaign_id = ? AND status = 'queued' AND batch_no = ?`,
      )
      .bind(claimedAt, campaignId, batchNo)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) continue; // another drain took it

    const rowsRes = await db
      .prepare(
        `SELECT id, email, first_name, last_name, unsub_token, track_token, attempts
         FROM marketing_campaign_recipient
         WHERE campaign_id = ? AND batch_no = ? AND status = 'sending' AND claimed_at = ?`,
      )
      .bind(campaignId, batchNo, claimedAt)
      .all<RecipientRow>();
    const claimed = rowsRes.results ?? [];
    if (!claimed.length) continue;

    // Authoritative suppression check. The snapshot may be hours old by now.
    const holes = claimed.map(() => '?').join(',');
    const supRes = await db
      .prepare(
        `SELECT email FROM marketing_suppression
         WHERE company_id = ? AND email IN (${holes})`,
      )
      .bind(companyId, ...claimed.map((r) => r.email.toLowerCase()))
      .all<{ email: string }>();
    const blocked = new Set((supRes.results ?? []).map((r) => r.email.toLowerCase()));

    const sendable = claimed.filter((r) => !blocked.has(r.email.toLowerCase()));
    const skipped = claimed.filter((r) => blocked.has(r.email.toLowerCase()));

    if (skipped.length) {
      await db
        .prepare(
          `UPDATE marketing_campaign_recipient
             SET status = 'suppressed', claimed_at = NULL,
                 error = 'on the suppression list at send time'
           WHERE campaign_id = ? AND id IN (${skipped.map(() => '?').join(',')})`,
        )
        .bind(campaignId, ...skipped.map((r) => r.id))
        .run();
      result.suppressed += skipped.length;
    }

    if (!sendable.length) {
      result.batchesProcessed += 1;
      continue;
    }

    const unsubMailbox = campaign.reply_to || campaign.from_email;
    const messages: OutboundMessage[] = sendable.map((r) => {
      const unsubUrl = `${origin}/u/${r.unsub_token}`;
      return {
        to: r.email,
        substitutions: {
          '-firstName-': r.first_name || 'there',
          '-lastName-': r.last_name || '',
          '-unsubUrl-': unsubUrl,
          '-trackBase-': `${origin}/c/${r.track_token}`,
        },
        customArgs: { campaign_id: campaignId, recipient_id: r.id, company_id: companyId },
        headers: {
          // RFC 8058 one-click. Gmail and Yahoo both require a working
          // List-Unsubscribe for bulk senders, and the POST variant is what
          // turns their native "unsubscribe" button on.
          'List-Unsubscribe': `<mailto:${unsubMailbox}?subject=unsubscribe>, <${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      };
    });

    const input: SendBatchInput = {
      from: { email: campaign.from_email, name: campaign.from_name },
      replyTo: campaign.reply_to || undefined,
      subject: campaign.subject,
      html: campaign.rendered_html,
      text: campaign.rendered_text,
      category: campaignId,
      messages,
    };

    const sendResult = await provider.sendBatch(input);
    const ids = sendable.map((r) => r.id);
    const idHoles = ids.map(() => '?').join(',');

    if (sendResult.ok) {
      await db
        .prepare(
          `UPDATE marketing_campaign_recipient
             SET status = 'sent', sent_at = ?, claimed_at = NULL,
                 provider_message_id = ?, error = ''
           WHERE campaign_id = ? AND id IN (${idHoles})`,
        )
        .bind(nowIso(), sendResult.providerMessageId, campaignId, ...ids)
        .run();
      result.sent += sendable.length;
    } else {
      const giveUp = !sendResult.retryable || (sendable[0]?.attempts ?? 0) >= MAX_ATTEMPTS;
      await db
        .prepare(
          `UPDATE marketing_campaign_recipient
             SET status = ?, claimed_at = NULL, error = ?
           WHERE campaign_id = ? AND id IN (${idHoles})`,
        )
        .bind(giveUp ? 'failed' : 'queued', (sendResult.error ?? 'send failed').slice(0, 500), campaignId, ...ids)
        .run();
      if (giveUp) result.failed += sendable.length;
      result.errors.push(`batch ${batchNo}: ${sendResult.error ?? 'send failed'}`);
      result.batchesProcessed += 1;
      // A retryable failure means the provider is unhappy right now. Stop and
      // let the next scheduled drain try, instead of hammering it.
      if (!giveUp) break;
      continue;
    }

    result.batchesProcessed += 1;
  }

  const left = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM marketing_campaign_recipient
       WHERE campaign_id = ? AND status IN ('queued','sending')`,
    )
    .bind(campaignId)
    .first<{ n: number }>();
  result.remaining = Number(left?.n ?? 0);
  result.complete = result.remaining === 0;

  if (result.complete) {
    await db
      .prepare(`UPDATE marketing_campaign SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), nowIso(), campaignId)
      .run();
  }

  return result;
}

/** Campaigns with work outstanding, for the scheduled drain endpoint. */
export async function listDrainableCampaigns(
  db: D1Database,
  limit = 5,
): Promise<Array<{ id: string; company_id: string }>> {
  const res = await db
    .prepare(
      `SELECT c.id, c.company_id
         FROM marketing_campaign c
        WHERE c.status IN ('sending','scheduled')
          AND (c.status = 'sending'
               OR (coalesce(c.scheduled_at,'') <> '' AND c.scheduled_at <= ?))
          AND EXISTS (SELECT 1 FROM marketing_campaign_recipient r
                       WHERE r.campaign_id = c.id AND r.status IN ('queued','sending'))
        ORDER BY c.send_started_at, c.scheduled_at
        LIMIT ?`,
    )
    .bind(nowIso(), Math.max(1, Math.min(25, limit)))
    .all<{ id: string; company_id: string }>();
  return res.results ?? [];
}
