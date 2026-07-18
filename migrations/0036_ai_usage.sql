-- AI usage ledger — every AI call is metered here so the platform owner can
-- bill tenants for usage against the platform master OpenAI key.
CREATE TABLE IF NOT EXISTS ai_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        TEXT NOT NULL,
  rep_id            TEXT,
  feature           TEXT NOT NULL,             -- 'proposal' | 'quote' | future: 'email', 'summary'…
  model             TEXT,
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens      INTEGER DEFAULT 0,
  key_source        TEXT DEFAULT 'platform',   -- 'platform' | 'byok' | 'env'
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_company ON ai_usage(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
