-- 0060_marketing_campaign.sql — Marketing OS, part 2 of 3.
--
-- The campaign itself, the frozen recipient snapshot, delivery events and the
-- click-tracked links. Additive only; safe to replay.

-- ── Campaign ─────────────────────────────────────────────────────────────────
-- content_json is the EDITABLE SOURCE OF TRUTH: an ordered list of typed blocks
-- (see src/marketing/blocks.ts). rendered_html is only a snapshot of what was
-- actually sent, produced by the one server-side renderer at approve time.
-- Never edit rendered_html; re-render from content_json instead.
--
-- content_revision gives optimistic concurrency for the editor and the AI
-- copilot writing to the same draft, mirroring the sales-process platform.
CREATE TABLE IF NOT EXISTS marketing_campaign (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL,
  name                TEXT NOT NULL,
  campaign_type       TEXT NOT NULL DEFAULT 'custom'
                        CHECK (campaign_type IN ('promote_service','reengage','seasonal','upsell','newsletter','custom')),
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','ready','scheduled','sending','sent','paused','cancelled','failed')),
  goal                TEXT NOT NULL DEFAULT '',
  subject             TEXT NOT NULL DEFAULT '',
  preheader           TEXT NOT NULL DEFAULT '',
  from_name           TEXT NOT NULL DEFAULT '',
  from_email          TEXT NOT NULL DEFAULT '',
  reply_to            TEXT NOT NULL DEFAULT '',
  sender_identity_id  TEXT,
  audience_id         TEXT,
  service_profile_id  TEXT,
  theme               TEXT NOT NULL DEFAULT 'brand_dark',
  content_json        TEXT NOT NULL DEFAULT '{"version":1,"blocks":[]}',
  rendered_html       TEXT NOT NULL DEFAULT '',
  rendered_text       TEXT NOT NULL DEFAULT '',
  rendered_at         TEXT,
  content_revision    INTEGER NOT NULL DEFAULT 1,
  scheduled_at        TEXT,
  send_started_at     TEXT,
  sent_at             TEXT,
  recipient_count     INTEGER NOT NULL DEFAULT 0,
  suppressed_count    INTEGER NOT NULL DEFAULT 0,
  test_sent_at        TEXT,
  created_by          TEXT NOT NULL DEFAULT '',
  approved_by         TEXT,
  approved_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_campaign_company ON marketing_campaign(company_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_mkt_campaign_sched   ON marketing_campaign(status, scheduled_at);

-- ── Recipient snapshot ───────────────────────────────────────────────────────
-- Frozen at send time. The audience query is NEVER re-run while a campaign is
-- sending: who was in the list at approve is who gets the email.
--
-- UNIQUE(campaign_id, email) is the dedupe guarantee. A commercial client with
-- six contacts on the same address gets exactly one copy.
--
-- unsub_token and track_token are per-recipient secrets that travel in the
-- email via SendGrid substitutions, so a click or an unsubscribe identifies the
-- exact human without exposing an internal id.
CREATE TABLE IF NOT EXISTS marketing_campaign_recipient (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL,
  campaign_id         TEXT NOT NULL,
  contact_id          TEXT,
  client_id           TEXT,
  opportunity_id      TEXT,
  email               TEXT NOT NULL,
  first_name          TEXT NOT NULL DEFAULT '',
  last_name           TEXT NOT NULL DEFAULT '',
  merge_json          TEXT NOT NULL DEFAULT '{}',
  unsub_token         TEXT NOT NULL,
  track_token         TEXT NOT NULL,
  batch_no            INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sending','sent','delivered','bounced','dropped','deferred','suppressed','failed')),
  provider_message_id TEXT NOT NULL DEFAULT '',
  error               TEXT NOT NULL DEFAULT '',
  queued_at           TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at          TEXT,
  sent_at             TEXT,
  delivered_at        TEXT,
  first_opened_at     TEXT,
  first_clicked_at    TEXT,
  bounced_at          TEXT,
  unsubscribed_at     TEXT,
  complained_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_rcpt_unique ON marketing_campaign_recipient(campaign_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_rcpt_unsub  ON marketing_campaign_recipient(unsub_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_rcpt_track  ON marketing_campaign_recipient(track_token);
-- The drain query: next queued batch for a campaign.
CREATE INDEX IF NOT EXISTS idx_mkt_rcpt_drain   ON marketing_campaign_recipient(campaign_id, status, batch_no);
-- The reaper query: rows stuck in 'sending' past their claim.
CREATE INDEX IF NOT EXISTS idx_mkt_rcpt_claimed ON marketing_campaign_recipient(status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_mkt_rcpt_client  ON marketing_campaign_recipient(company_id, client_id);

-- ── Delivery and engagement events ───────────────────────────────────────────
-- One row per provider event. UNIQUE(provider_event_id) makes the webhook
-- idempotent: SendGrid retries and duplicates are absorbed silently.
CREATE TABLE IF NOT EXISTS marketing_email_event (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  campaign_id       TEXT NOT NULL,
  recipient_id      TEXT NOT NULL,
  event_type        TEXT NOT NULL
                      CHECK (event_type IN ('processed','delivered','open','click','bounce','dropped','deferred','spamreport','unsubscribe','group_unsubscribe')),
  url               TEXT NOT NULL DEFAULT '',
  reason            TEXT NOT NULL DEFAULT '',
  user_agent        TEXT NOT NULL DEFAULT '',
  ip_hash           TEXT NOT NULL DEFAULT '',
  provider_event_id TEXT NOT NULL DEFAULT '',
  occurred_at       TEXT NOT NULL DEFAULT (datetime('now')),
  received_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_event_provider ON marketing_email_event(provider_event_id)
  WHERE provider_event_id <> '';
CREATE INDEX IF NOT EXISTS idx_mkt_event_campaign  ON marketing_email_event(campaign_id, event_type);
CREATE INDEX IF NOT EXISTS idx_mkt_event_recipient ON marketing_email_event(recipient_id, occurred_at);

-- ── Click-tracked links ──────────────────────────────────────────────────────
-- Extracted from content_json at render time. The email never contains the raw
-- target; it contains /c/{track_token}/{link_id}, which records the click and
-- then 302s. We do our own click tracking rather than SendGrid's because our
-- redirect is what carries recipient identity into the inquiry form.
CREATE TABLE IF NOT EXISTS marketing_link (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  block_id    TEXT NOT NULL DEFAULT '',
  label       TEXT NOT NULL DEFAULT '',
  target_url  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_link_campaign ON marketing_link(campaign_id);
