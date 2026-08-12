-- 0064_marketing_core.sql — Marketing OS, part 1 of 3.
--
-- Brand kit, service marketing knowledge, media library, saved audiences and
-- the suppression list. Additive only; safe to replay.
--
-- Conventions carried from the rest of this database:
--   * tenant column is company_id TEXT NOT NULL (never tenant_id)
--   * money is INTEGER cents
--   * closed enums live in CHECK constraints
--   * JSON-shaped columns are suffixed _json and hold TEXT

-- ── Brand kit ────────────────────────────────────────────────────────────────
-- One active profile per company. physical_address is REQUIRED before any
-- campaign can be approved: CAN-SPAM demands a real postal address in the
-- footer of every commercial email, and the renderer always emits it.
CREATE TABLE IF NOT EXISTS marketing_brand_profile (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL,
  name                 TEXT NOT NULL DEFAULT '',
  colors_json          TEXT NOT NULL DEFAULT '{}',
  logo_light_asset_id  TEXT,
  logo_dark_asset_id   TEXT,
  voice_json           TEXT NOT NULL DEFAULT '[]',
  footer_json          TEXT NOT NULL DEFAULT '{}',
  default_ctas_json    TEXT NOT NULL DEFAULT '[]',
  physical_address     TEXT NOT NULL DEFAULT '',
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_brand_company ON marketing_brand_profile(company_id, active);

-- ── Service marketing knowledge ──────────────────────────────────────────────
-- Deliberately separate from jobs, estimates and the price book: this is what
-- marketing is allowed to SAY about a service, not what it costs to deliver.
CREATE TABLE IF NOT EXISTS marketing_service_profile (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL,
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL DEFAULT '',
  season               TEXT NOT NULL DEFAULT '',
  customer_type        TEXT NOT NULL DEFAULT '',
  benefits_json        TEXT NOT NULL DEFAULT '[]',
  preferred_cta_label  TEXT NOT NULL DEFAULT '',
  form_id              TEXT,
  window_start_month   INTEGER,
  window_end_month     INTEGER,
  approved_copy        TEXT NOT NULL DEFAULT '',
  do_not_claim         TEXT NOT NULL DEFAULT '',
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_service_company ON marketing_service_profile(company_id, active);

-- ── Media library ────────────────────────────────────────────────────────────
-- Distinct from project_media, which is job documentation keyed to a work order
-- with client-portal visibility semantics. Marketing assets need tags, an
-- approval gate, alt text, dimensions and AI provenance, and are reused across
-- campaigns. Both tables point into the same R2 bucket (binding MEDIA); an
-- import from job photos REUSES the existing r2_key rather than copying bytes.
CREATE TABLE IF NOT EXISTS marketing_asset (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL,
  r2_key                 TEXT NOT NULL,
  file_name              TEXT NOT NULL DEFAULT '',
  content_type           TEXT NOT NULL DEFAULT '',
  size_bytes             INTEGER NOT NULL DEFAULT 0,
  width                  INTEGER NOT NULL DEFAULT 0,
  height                 INTEGER NOT NULL DEFAULT 0,
  alt_text               TEXT NOT NULL DEFAULT '',
  tags_json              TEXT NOT NULL DEFAULT '[]',
  service_profile_id     TEXT,
  season                 TEXT NOT NULL DEFAULT '',
  property_type          TEXT NOT NULL DEFAULT '',
  approved_for_marketing INTEGER NOT NULL DEFAULT 0,
  source                 TEXT NOT NULL DEFAULT 'upload'
                           CHECK (source IN ('upload','ai_generated','from_project')),
  ai_prompt              TEXT NOT NULL DEFAULT '',
  created_by             TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_asset_company  ON marketing_asset(company_id, approved_for_marketing, created_at);
CREATE INDEX IF NOT EXISTS idx_mkt_asset_service  ON marketing_asset(company_id, service_profile_id);

-- ── Saved audiences ──────────────────────────────────────────────────────────
-- filter_json is a versioned rule set compiled to parameterized SQL by
-- src/marketing/audience.ts. The definition is saved, never the row ids: a
-- saved audience is a live query until a campaign snapshots it.
CREATE TABLE IF NOT EXISTS marketing_audience (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  filter_json      TEXT NOT NULL DEFAULT '{"version":1,"match":"all","rules":[]}',
  last_count       INTEGER NOT NULL DEFAULT 0,
  last_counted_at  TEXT,
  created_by       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_audience_company ON marketing_audience(company_id, name);

-- ── Suppression list ─────────────────────────────────────────────────────────
-- The single most important table in this module. email is always stored
-- lowercased and trimmed. UNIQUE(company_id, email) IS the safety guarantee:
-- the send path does an anti-join against this table immediately before every
-- batch, so no campaign, no operator and no AI draft can reach a suppressed
-- address. Rows are only ever added, never deleted by automation — a
-- resubscribe is an explicit human action that deletes one row.
CREATE TABLE IF NOT EXISTS marketing_suppression (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL,
  email              TEXT NOT NULL,
  contact_id         TEXT,
  client_id          TEXT,
  reason             TEXT NOT NULL
                       CHECK (reason IN ('unsubscribe','hard_bounce','complaint','manual','invalid')),
  source_campaign_id TEXT,
  note               TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_suppression_email ON marketing_suppression(company_id, email);
