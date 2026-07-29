-- Additive Builder concurrency and company playbook support. Previously
-- published versions and template rows remain unchanged.
ALTER TABLE sales_process_versions ADD COLUMN draft_lock_token TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS sales_academy_company_content (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  process_version_id TEXT NOT NULL,
  stage_id TEXT DEFAULT '',
  internal_status_id TEXT DEFAULT '',
  stable_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'representative',
  display_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, process_version_id, stable_key)
);
CREATE INDEX IF NOT EXISTS idx_sales_academy_content_version
  ON sales_academy_company_content(company_id, process_version_id, stage_id, display_order);
CREATE INDEX IF NOT EXISTS idx_sales_academy_content_status
  ON sales_academy_company_content(company_id, internal_status_id, active);

CREATE TABLE IF NOT EXISTS sales_process_draft_mutations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  process_version_id TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, process_version_id, content_revision)
);
CREATE INDEX IF NOT EXISTS idx_sales_draft_mutations_version
  ON sales_process_draft_mutations(company_id, process_version_id, content_revision);
