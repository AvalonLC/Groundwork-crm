-- 0061_marketing_forms_attribution.sql — Marketing OS, part 3 of 3.
--
-- Native inquiry forms (replacing the Google Forms CTAs), the SendGrid sender
-- identity, business-outcome attribution and the AI generation log.
-- Additive only; safe to replay.

-- ── Native inquiry forms ─────────────────────────────────────────────────────
-- public_token is the unguessable path segment in /f/:public_token. Forms are
-- rendered server-side, unauthenticated, and post to /api/public/forms/:token
-- with the same honeypot-plus-rate-limit defence as /api/public/demo-request.
CREATE TABLE IF NOT EXISTS marketing_form (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL,
  name                 TEXT NOT NULL,
  public_token         TEXT NOT NULL,
  service_profile_id   TEXT,
  headline             TEXT NOT NULL DEFAULT '',
  intro                TEXT NOT NULL DEFAULT '',
  fields_json          TEXT NOT NULL DEFAULT '[]',
  submit_label         TEXT NOT NULL DEFAULT 'Submit',
  success_message      TEXT NOT NULL DEFAULT 'Thank you. We will be in touch shortly.',
  notify_rep_id        TEXT,
  create_lead          INTEGER NOT NULL DEFAULT 1,
  default_service_line TEXT NOT NULL DEFAULT '',
  active               INTEGER NOT NULL DEFAULT 1,
  created_by           TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_form_token   ON marketing_form(public_token);
CREATE INDEX IF NOT EXISTS        idx_mkt_form_company ON marketing_form(company_id, active);

-- ── Form submissions ─────────────────────────────────────────────────────────
-- campaign_id and recipient_id are populated when the visitor arrived through a
-- tracked campaign link, which is what closes the loop from send to sold job.
-- ip_hash is a salted hash, never a raw address.
CREATE TABLE IF NOT EXISTS marketing_form_submission (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  form_id        TEXT NOT NULL,
  campaign_id    TEXT,
  recipient_id   TEXT,
  opportunity_id TEXT,
  client_id      TEXT,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  name           TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  ip_hash        TEXT NOT NULL DEFAULT '',
  user_agent     TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_sub_form     ON marketing_form_submission(company_id, form_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mkt_sub_campaign ON marketing_form_submission(campaign_id);

-- ── Sender identity ──────────────────────────────────────────────────────────
-- The transactional helper sendEmail() hardcodes noreply@groundwork-crm.com.
-- Campaigns must come from the tenant's own authenticated domain, so each
-- company registers a from address here and verifies the domain through the
-- provider. A campaign cannot be approved against an unverified identity.
CREATE TABLE IF NOT EXISTS marketing_sender_identity (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL,
  from_email         TEXT NOT NULL,
  from_name          TEXT NOT NULL DEFAULT '',
  reply_to           TEXT NOT NULL DEFAULT '',
  domain             TEXT NOT NULL DEFAULT '',
  provider           TEXT NOT NULL DEFAULT 'sendgrid' CHECK (provider IN ('sendgrid')),
  provider_domain_id TEXT NOT NULL DEFAULT '',
  dns_records_json   TEXT NOT NULL DEFAULT '[]',
  verified           INTEGER NOT NULL DEFAULT 0,
  verified_at        TEXT,
  last_checked_at    TEXT,
  is_default         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_sender_company ON marketing_sender_identity(company_id, verified);

-- ── Business-outcome attribution ─────────────────────────────────────────────
-- A side table rather than a column on opportunities: opportunities is the
-- hottest write path in the CRM and this keeps the blast radius off it.
--
-- amount_cents is INTEGER cents (CLAUDE.md; the pre-push hook rejects REAL).
-- UNIQUE(campaign_id, entity_type, entity_id, event) makes the nightly rollup
-- idempotent — it can re-walk the same jobs every night without double counting.
CREATE TABLE IF NOT EXISTS marketing_attribution (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  recipient_id TEXT,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('opportunity','estimate','invoice','work_order')),
  entity_id    TEXT NOT NULL,
  event        TEXT NOT NULL CHECK (event IN ('inquiry','estimate_created','job_sold','invoice_paid')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  occurred_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_attr_unique   ON marketing_attribution(campaign_id, entity_type, entity_id, event);
CREATE INDEX IF NOT EXISTS        idx_mkt_attr_campaign ON marketing_attribution(company_id, campaign_id, event);

-- ── AI generation log ────────────────────────────────────────────────────────
-- Every copilot run is recorded with the tools it called and the draft it
-- produced, so a campaign that reads oddly can be traced back to its prompt.
CREATE TABLE IF NOT EXISTS marketing_ai_generation (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL,
  campaign_id      TEXT,
  rep_id           TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL DEFAULT 'campaign_draft',
  prompt           TEXT NOT NULL DEFAULT '',
  tools_called_json TEXT NOT NULL DEFAULT '[]',
  draft_json       TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT '',
  tokens           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_aigen_company ON marketing_ai_generation(company_id, created_at);
