-- Custom email templates (per-company "My Templates" library)
CREATE TABLE IF NOT EXISTS email_templates (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  category     TEXT DEFAULT 'My Templates',
  subject      TEXT DEFAULT '',
  body         TEXT DEFAULT '',
  created_by   TEXT DEFAULT '',
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_tpl_company ON email_templates(company_id);
