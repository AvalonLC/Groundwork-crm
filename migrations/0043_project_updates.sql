-- Migration 0043: Client portal projects — daily updates and media
-- Projects reuse work_orders as the operational record. Staff publish daily
-- updates (with photos in R2) that become visible in the client portal.

-- ── Project updates — one per published day note ─────────────────────────────
CREATE TABLE IF NOT EXISTS project_updates (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  client_id    TEXT DEFAULT '',
  property_id  TEXT DEFAULT '',
  update_date  TEXT NOT NULL DEFAULT (date('now')),   -- the work day covered
  title        TEXT DEFAULT '',
  body         TEXT DEFAULT '',                        -- client-facing note
  status       TEXT NOT NULL DEFAULT 'published',      -- draft | published
  published_at TEXT DEFAULT '',
  created_by   TEXT DEFAULT '',                        -- rep id
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pupd_wo      ON project_updates(work_order_id);
CREATE INDEX IF NOT EXISTS idx_pupd_client  ON project_updates(client_id);
CREATE INDEX IF NOT EXISTS idx_pupd_company ON project_updates(company_id);

-- ── Media assets — R2-backed photos/files attached to updates or projects ────
CREATE TABLE IF NOT EXISTS project_media (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  work_order_id TEXT DEFAULT '',
  update_id    TEXT DEFAULT '',                        -- project_updates.id (optional)
  client_id    TEXT DEFAULT '',
  r2_key       TEXT NOT NULL,                          -- object key in MEDIA bucket
  file_name    TEXT DEFAULT '',
  content_type TEXT DEFAULT '',
  size_bytes   INTEGER DEFAULT 0,
  kind         TEXT DEFAULT 'photo',                   -- photo | document
  caption      TEXT DEFAULT '',
  visibility   TEXT NOT NULL DEFAULT 'client',         -- client | internal
  created_by   TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pmedia_wo     ON project_media(work_order_id);
CREATE INDEX IF NOT EXISTS idx_pmedia_update ON project_media(update_id);
CREATE INDEX IF NOT EXISTS idx_pmedia_company ON project_media(company_id);

-- ── Work order portal visibility flag ────────────────────────────────────────
ALTER TABLE work_orders ADD COLUMN portal_visible INTEGER DEFAULT 1;
