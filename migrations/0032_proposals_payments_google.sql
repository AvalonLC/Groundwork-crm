-- ── Proposals, Payment Schedules, Persistent Google Auth ────────────────────
-- 1. payment_schedule on estimates: JSON [{label, pct}] — must sum to 100
-- 2. proposals: high-level estimate-like documents (templates + portal)
-- 3. proposal_templates: reusable proposal skeletons with quick-fill
-- 4. google_tokens: per-rep refresh tokens for persistent Google connection

ALTER TABLE estimates ADD COLUMN payment_schedule TEXT DEFAULT '[]';

CREATE TABLE IF NOT EXISTS proposals (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  prop_number       TEXT NOT NULL DEFAULT '',
  title             TEXT NOT NULL DEFAULT '',
  subtitle          TEXT DEFAULT '',
  overview          TEXT DEFAULT '',
  client_id         TEXT DEFAULT '',
  client_name       TEXT NOT NULL DEFAULT '',
  client_email      TEXT DEFAULT '',
  client_phone      TEXT DEFAULT '',
  property_addr     TEXT DEFAULT '',
  opp_id            TEXT DEFAULT '',
  estimate_id       TEXT DEFAULT '',
  rep_id            TEXT DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'draft',
  sections          TEXT DEFAULT '[]',
  payment_schedule  TEXT DEFAULT '[]',
  total             REAL DEFAULT 0,
  terms             TEXT DEFAULT '',
  internal_notes    TEXT DEFAULT '',
  portal_token      TEXT DEFAULT '',
  accepted_at       TEXT DEFAULT '',
  accepted_option   TEXT DEFAULT '',
  declined_at       TEXT DEFAULT '',
  sent_at           TEXT DEFAULT '',
  viewed_at         TEXT DEFAULT '',
  proposal_date     TEXT DEFAULT '',
  valid_through     TEXT DEFAULT '',
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_company ON proposals(company_id);
CREATE INDEX IF NOT EXISTS idx_proposals_opp     ON proposals(opp_id);
CREATE INDEX IF NOT EXISTS idx_proposals_token   ON proposals(portal_token);

CREATE TABLE IF NOT EXISTS proposal_templates (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  description  TEXT DEFAULT '',
  content      TEXT DEFAULT '{}',
  created_by   TEXT DEFAULT '',
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prop_tpl_company ON proposal_templates(company_id);

CREATE TABLE IF NOT EXISTS google_tokens (
  rep_id        TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  email         TEXT DEFAULT '',
  connected_at  TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_google_tokens_company ON google_tokens(company_id);
